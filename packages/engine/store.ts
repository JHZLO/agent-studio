import Database from "better-sqlite3";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { activeStatuses, type Run, type Settings, type Connection, type ImportedSession } from "../contracts/index.ts";

export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export class Store extends EventEmitter {
  readonly db: Database.Database;
  constructor(path: string) {
    super();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.pragma("journal_mode = WAL"); this.db.pragma("foreign_keys = ON"); this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, kind TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, method TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS imported_sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
  }
  get<T>(id: string): T | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE id = ?").get(id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  set(id: string, value: unknown) { this.db.prepare("INSERT INTO settings VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value").run(id, JSON.stringify(value)); }
  importedSessions() {
    return (this.db.prepare("SELECT json_remove(value, '$.messages') AS value, json_array_length(value, '$.messages') AS messageCount FROM imported_sessions ORDER BY json_extract(value, '$.updatedAt') DESC").all() as { value: string; messageCount: number }[]).map(row => ({ ...JSON.parse(row.value), messageCount: row.messageCount }));
  }
  importedSession(id: string): ImportedSession | null {
    const row = this.db.prepare("SELECT value FROM imported_sessions WHERE id = ?").get(id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  saveImportedSession(session: ImportedSession) { this.db.prepare("INSERT OR IGNORE INTO imported_sessions VALUES (?, ?)").run(session.key, JSON.stringify(session)); }
  run(id: string): Run | null {
    const row = this.db.prepare("SELECT value FROM runs WHERE id = ?").get(id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  runs(): Run[] { return (this.db.prepare("SELECT value FROM runs ORDER BY created_at DESC, rowid DESC").all() as { value: string }[]).map(row => JSON.parse(row.value)); }
  activeRuns(): Run[] {
    return (this.db.prepare(`SELECT value FROM runs WHERE json_extract(value, '$.status') IN (${activeStatuses.map(() => "?").join(",")}) ORDER BY created_at DESC, rowid DESC`).all(...activeStatuses) as { value: string }[]).map(row => JSON.parse(row.value));
  }
  history() {
    return (this.db.prepare("SELECT id, json_extract(value, '$.brief') AS brief, json_extract(value, '$.status') AS status, json_extract(value, '$.project') AS project, json_extract(value, '$.flow') AS flow, json_array_length(value, '$.artifacts') AS artifactCount FROM runs ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 1").all() as { id: string; brief: string; status: Run["status"]; project: string; flow: string; artifactCount: number }[]).map(row => ({ ...row, project: JSON.parse(row.project), flow: JSON.parse(row.flow), artifacts: [], summary: true }));
  }
  receipts(runId: string, stepId: string) {
    return (this.db.prepare("SELECT value FROM events WHERE run_id = ? AND kind = 'tool.completed' AND json_extract(value, '$.stepId') = ? ORDER BY seq").all(runId, stepId) as { value: string }[]).map(row => JSON.parse(row.value));
  }
  saveRun(run: Run, kind: string, detail: unknown = {}) {
    const event = this.db.transaction(() => {
      const result = this.db.prepare("INSERT INTO events(run_id, kind, value, created_at) VALUES (?, ?, ?, ?)").run(run.id, kind, JSON.stringify(detail), new Date().toISOString());
      run.eventSeq = Number(result.lastInsertRowid);
      this.db.prepare("INSERT INTO runs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value").run(run.id, run.createdAt, JSON.stringify(run));
      return { seq: run.eventSeq, runId: run.id, kind, detail };
    })();
    this.emit("event", event);
  }
  events(after: number, limit = 500) { return this.db.prepare("SELECT seq, run_id AS runId, kind, created_at AS time FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(after, limit); }
  seq() { return (this.db.prepare("SELECT coalesce(max(seq), 0) AS seq FROM events").get() as { seq: number }).seq; }
  async command(id: string, method: string, input: unknown, execute: () => Promise<unknown>) {
    const digest = hash(JSON.stringify(input));
    const existing = this.db.prepare("SELECT * FROM commands WHERE id = ?").get(id) as { method: string; digest: string; status: string; result: string; error: string } | undefined;
    if (existing) {
      if (existing.method !== method || existing.digest !== digest) throw new Error("Command ID was reused with different input.");
      if (existing.status === "pending") throw new Error("Command outcome is uncertain. Read the current run before retrying.");
      if (existing.error) throw new Error(existing.error);
      return JSON.parse(existing.result);
    }
    this.db.prepare("INSERT INTO commands(id, method, digest, status) VALUES (?, ?, ?, 'pending')").run(id, method, digest);
    try {
      const result = await execute();
      this.db.prepare("UPDATE commands SET status = 'done', result = ? WHERE id = ?").run(JSON.stringify(result ?? null), id);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command failed.";
      this.db.prepare("UPDATE commands SET status = 'done', error = ? WHERE id = ?").run(message, id);
      throw error;
    }
  }
  state() {
    const latest = this.db.prepare("SELECT value FROM runs ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { value: string } | undefined;
    return { ...this.get<Settings>("settings"), connections: this.get<Connection[]>("connections") ?? [], run: latest ? JSON.parse(latest.value) : null, history: this.history(), activeRuns: this.activeRuns(), importedSessions: this.importedSessions(), revision: this.get<number>("revision") ?? 0, eventSeq: this.seq() };
  }
  close() { this.db.close(); }
}
