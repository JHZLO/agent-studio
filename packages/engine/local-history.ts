import Database from "better-sqlite3";
import { createReadStream } from "node:fs";
import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { hash } from "./store.ts";
import { contained, git } from "./projects.ts";
import type { LocalProject, LocalSession, Message } from "../contracts/index.ts";

type RecordValue = Record<string, any>;
type Source = LocalSession & { file: string; root: string };
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const parse = (text: string): RecordValue | null => { try { const value = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; } };
const textContent = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.filter(item => ["text", "input_text", "output_text"].includes(item?.type) && typeof item.text === "string").map(item => item.text).join("\n") : "";
const date = (value: unknown) => { const time = new Date(typeof value === "number" || typeof value === "string" ? value : NaN); return Number.isFinite(time.getTime()) ? time.toISOString() : ""; };
async function entries(path: string) { return readdir(path, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; }); }
async function json(path: string) {
  const info = await stat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error("Local metadata exceeds the 16 MB read limit.");
  return parse(await readFile(path, "utf8"));
}
async function sample(path: string) {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    const parts: string[] = [];
    for (const [start, length] of [[0, Math.min(info.size, 256 * 1024)], [Math.max(0, info.size - 64 * 1024), Math.min(info.size, 64 * 1024)]]) {
      const buffer = Buffer.alloc(length); const { bytesRead } = await file.read(buffer, 0, length, start);
      let lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (start) lines = lines.slice(1);
      parts.push(...lines);
    }
    return { info, records: parts.map(parse).filter((item): item is RecordValue => !!item) };
  } finally { await file.close(); }
}

export class LocalHistory {
  private sources = new Map<string, Source>();
  private projects = new Map<string, LocalProject>();
  constructor(readonly roots = {
    codex: resolve(process.env.CODEX_HOME || join(homedir(), ".codex")),
    claude: resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")),
    claudeDesktop: join(homedir(), "Library/Application Support/Claude/claude-code-sessions"),
  }) {}

  async scan() {
    const projects = new Map<string, LocalProject>(), sources = new Map<string, Source>(), warnings: string[] = [];
    const paths = new Map<string, Promise<LocalProject | null>>();
    const mainWorktrees = new Map<string, Promise<string | null>>();
    const addProject = (raw: unknown, provider: "codex" | "claude", name?: string) => {
      if (typeof raw !== "string" || !isAbsolute(raw)) return Promise.resolve(null);
      const cacheKey = `${provider}:${raw}`;
      if (!paths.has(cacheKey)) paths.set(cacheKey, (async () => {
        let path = await realpath(raw).catch(() => resolve(raw));
        const directories = (await git(path, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]))?.split("\n");
        if (directories?.length === 2 && directories[0] !== directories[1]) {
          const common = directories[1], worktree = path;
          if (!mainWorktrees.has(common)) mainWorktrees.set(common, (async () => {
            const primary = (await git(worktree, ["worktree", "list", "--porcelain", "-z"]))?.split("\0\0")[0].split("\0");
            if (!primary || primary.includes("bare")) return null;
            const original = primary.find(field => field.startsWith("worktree "))?.slice(9);
            return original && isAbsolute(original) ? realpath(original).catch(() => resolve(original)) : null;
          })());
          path = await mainWorktrees.get(common) ?? path;
        }
        const key = `project-${hash(path).slice(0, 32)}`;
        let project = projects.get(key);
        if (!project) {
          const available = await stat(path).then(info => info.isDirectory(), () => false);
          project = { key, name: (name?.trim() || basename(path) || path).slice(0, 100), path, providers: [], available };
          projects.set(key, project);
        }
        if (!project.providers.includes(provider)) project.providers.push(provider);
        return project;
      })());
      return paths.get(cacheKey)!;
    };
    try {
      const databases = (await entries(this.roots.codex)).filter(file => /^state_\d+\.sqlite$/.test(file.name) && file.isFile()).sort((a, b) => Number(b.name.match(/\d+/)![0]) - Number(a.name.match(/\d+/)![0]));
      const saved = await json(join(this.roots.codex, ".codex-global-state.json"));
      for (const item of Object.values(saved?.["local-projects"] ?? {}) as RecordValue[]) for (const path of item.rootPaths ?? []) await addProject(path, "codex", item.name);
      for (const path of saved?.["electron-saved-workspace-roots"] ?? []) await addProject(path, "codex");
      if (databases.length) {
        const db = new Database(join(this.roots.codex, databases[0].name), { readonly: true, fileMustExist: true });
        try {
          const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name));
          const membership = new Map<string, LocalProject>();
          if (tables.has("projects") && tables.has("project_roots")) {
            for (const row of db.prepare("SELECT p.id, p.name, r.path FROM projects p JOIN project_roots r ON r.project_id = p.id ORDER BY r.position").all() as RecordValue[]) {
              const project = await addProject(row.path, "codex", row.name);
              if (project && !membership.has(row.id)) membership.set(row.id, project);
            }
          }
          const columns = new Set((db.prepare("PRAGMA table_info(threads)").all() as { name: string }[]).map(row => row.name));
          const optional = (column: string) => columns.has(column) ? column : `NULL AS ${column}`;
          const rows = db.prepare(`SELECT id, title, cwd, rollout_path, updated_at, source, ${optional("name")}, ${optional("project_id")} FROM threads WHERE source NOT LIKE '%subagent%' ORDER BY updated_at DESC LIMIT 10001`).all() as RecordValue[];
          if (rows.length > 10000) warnings.push("Codex discovery is limited to the 10,000 most recent sessions.");
          for (const row of rows.slice(0, 10000)) {
            if (!uuid.test(row.id)) continue;
            const project = membership.get(row.project_id) ?? await addProject(row.cwd, "codex");
            if (!project) continue;
            const key = `codex:${row.id}`;
            sources.set(key, { key, provider: "codex", sourceId: row.id, title: String(row.name || row.title || "Untitled Codex session").slice(0, 300), projectKey: project.key, cwd: row.cwd, updatedAt: date(row.updated_at * 1000), file: row.rollout_path, root: this.roots.codex });
          }
        } finally { db.close(); }
      } else if (saved) warnings.push("Codex projects were found, but its local session database is unavailable.");
    } catch { warnings.push("Could not read the Codex catalog. Its local storage format or permissions may have changed."); }

    try {
      const desktop = new Map<string, RecordValue>();
      for (const account of await entries(this.roots.claudeDesktop)) if (account.isDirectory()) {
        for (const org of await entries(join(this.roots.claudeDesktop, account.name))) if (org.isDirectory()) {
          for (const file of await entries(join(this.roots.claudeDesktop, account.name, org.name))) if (file.isFile() && file.name.endsWith(".json")) {
            const item = await json(join(this.roots.claudeDesktop, account.name, org.name, file.name));
            if (item && uuid.test(item.cliSessionId)) desktop.set(item.cliSessionId, { title: item.title, path: item.originCwd || item.cwd });
          }
        }
      }
      const config = await json(`${this.roots.claude}.json`);
      const knownPaths = new Map<string, string>();
      for (const path of Object.keys(config?.projects ?? {})) { knownPaths.set(path.replace(/[^a-zA-Z0-9]/g, "-"), path); await addProject(path, "claude"); }
      const root = join(this.roots.claude, "projects");
      for (const directory of await entries(root)) if (directory.isDirectory()) {
        const directoryPath = join(root, directory.name);
        const index = await json(join(directoryPath, "sessions-index.json"));
        const indexed = new Map<string, RecordValue>((index?.entries ?? []).map((item: RecordValue) => [item.sessionId, item]));
        await addProject(index?.originalPath || knownPaths.get(directory.name), "claude");
        for (const file of await entries(directoryPath)) {
          const id = file.name.replace(/\.jsonl$/, "");
          if (!file.isFile() || !file.name.endsWith(".jsonl") || !uuid.test(id)) continue;
          try {
            const path = join(directoryPath, file.name), { records, info } = await sample(path), cached = indexed.get(id), app = desktop.get(id);
            const record = records.find(item => item.sessionId === id && item.cwd);
            if (cached?.isSidechain || record?.isSidechain) continue;
            const cwd = record?.cwd || cached?.projectPath || index?.originalPath || knownPaths.get(directory.name);
            const appPath = typeof app?.path === "string" && isAbsolute(app.path) && app.path !== dirname(app.path) ? app.path : null;
            const project = await addProject(appPath || cwd, "claude");
            if (!project) continue;
            const title = [...records].reverse().find(item => item.type === "custom-title")?.customTitle || app?.title || cached?.summary || cached?.firstPrompt || textContent(records.find(item => item.type === "user")?.message?.content) || "Untitled Claude Code session";
            const key = `claude:${id}`;
            sources.set(key, { key, provider: "claude", sourceId: id, title: String(title).trim().slice(0, 300), projectKey: project.key, cwd: cwd || project.path, updatedAt: date(info.mtimeMs), file: path, root });
          } catch { warnings.push("A Claude Code session could not be read. Refresh to retry."); }
        }
      }
    } catch { warnings.push("Could not read the Claude Code catalog. Check local storage access."); }
    this.sources = sources; this.projects = projects;
    return { projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)), sessions: [...sources.values()].map(({ file, root, ...item }) => item).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), warnings: [...new Set(warnings)] };
  }

  project(key: string) { const project = this.projects.get(key); if (!project) throw new Error("Project discovery expired. Refresh the local catalog."); return project; }
  session(key: string) { const source = this.sources.get(key); if (!source) throw new Error("Session discovery expired. Refresh the local catalog."); return source; }

  async read(key: string) {
    const source = this.session(key);
    const root = await realpath(source.root), file = await realpath(source.file);
    const allowed = source.provider === "claude" ? contained(root, file) : ["sessions", "archived_sessions"].some(name => contained(join(root, name), file));
    if (!allowed || !file.endsWith(".jsonl")) throw new Error("Session transcript must stay inside its local history folder.");
    const info = await stat(file);
    if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error("This session exceeds the 128 MB transcript read limit.");
    const stream = createReadStream(file, { end: Math.max(0, info.size - 1) });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const messages: Message[] = [], positions = new Map<string, number>();
    let identified = false, truncated = false, bytes = 0;
    try {
      for await (const line of lines) {
        const record = parse(line);
        if (!record) { if (line.trim()) throw new Error("The transcript contains an incomplete record. Wait for the source app to finish saving and retry."); continue; }
        if (source.provider === "codex" && record.type === "session_meta") {
          if ((record.payload?.id || record.payload?.session_id) !== source.sourceId) throw new Error("The transcript no longer matches the selected session.");
          identified = true;
        }
        if (source.provider === "claude" && record.sessionId === source.sourceId) identified = true;
        let message: RecordValue | undefined;
        if (source.provider === "codex" && record.type === "response_item" && record.payload?.type === "message") message = record.payload;
        if (source.provider === "claude" && ["user", "assistant"].includes(record.type) && record.sessionId === source.sourceId && !record.isSidechain) message = record.message;
        if (!message || !["user", "assistant"].includes(message.role) || (message.role === "assistant" && message.channel === "analysis")) continue;
        const text = textContent(message.content).trim();
        if (!text) continue;
        const id = record.uuid || message.id || `${source.key}:${messages.length}`;
        const position = positions.get(id), previous = position === undefined ? null : messages[position];
        const addedBytes = Buffer.byteLength(text) - (previous ? Buffer.byteLength(previous.text) : 0);
        if ((position === undefined && messages.length >= 5000) || bytes + addedBytes > 2 * 1024 * 1024) { truncated = true; break; }
        bytes += addedBytes;
        const item = { id, type: message.role, text, time: date(record.timestamp) };
        if (position === undefined) { positions.set(id, messages.length); messages.push(item); } else messages[position] = item;
      }
    } finally { lines.close(); stream.destroy(); }
    if (!identified) throw new Error("Could not verify the session identity. Refresh the local catalog.");
    if (!messages.length) throw new Error("This session has no readable user or assistant messages.");
    const { file: _file, root: _root, ...session } = source;
    return { ...session, messages, truncated };
  }
}
