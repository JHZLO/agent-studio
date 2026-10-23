import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalHistory } from "../packages/engine/local-history.ts";
import { git } from "../packages/engine/projects.ts";
import { Store } from "../packages/engine/store.ts";
import { Studio } from "../packages/engine/studio.ts";

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "studio-import-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project"), other = join(root, "other"), worktree = join(root, "worktree");
  const roots = { codex: join(root, ".codex"), claude: join(root, ".claude"), claudeDesktop: join(root, "desktop") };
  for (const path of [project, other, worktree, join(roots.codex, "sessions"), join(roots.claude, "projects", "encoded-project")]) await mkdir(path, { recursive: true });
  const codexId = randomUUID(), claudeId = randomUUID(), otherId = randomUUID();
  const codexFile = join(roots.codex, "sessions", `rollout-${codexId}.jsonl`);
  const claudeFile = join(roots.claude, "projects", "encoded-project", `${claudeId}.jsonl`);
  const writeLines = (path: string, values: unknown[]) => writeFile(path, values.map(value => JSON.stringify(value)).join("\n") + "\n");
  await writeLines(codexFile, [
    { type: "session_meta", payload: { id: codexId, cwd: worktree } },
    { type: "response_item", timestamp: "2026-10-23T00:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Build the selected feature" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", channel: "analysis", content: [{ type: "text", text: "Private reasoning" }] } },
    { type: "response_item", payload: { type: "function_call", name: "shell", arguments: "Internal tool details" } },
    { type: "response_item", payload: { type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "The feature is ready." }] } },
  ]);
  await writeLines(claudeFile, [
    { type: "user", uuid: "message-1", sessionId: claudeId, cwd: project, message: { role: "user", content: "Review the feature" } },
    { type: "assistant", uuid: "message-2", sessionId: claudeId, cwd: project, message: { role: "assistant", content: [{ type: "thinking", thinking: "Private reasoning" }, { type: "text", text: "Review complete." }] } },
    { type: "user", uuid: "message-3", sessionId: claudeId, message: { role: "user", content: [{ type: "tool_result", content: "Internal tool details" }] } },
    { type: "custom-title", customTitle: "Claude review" },
  ]);
  const database = join(roots.codex, "state_5.sqlite"), db = new Database(database);
  db.exec("CREATE TABLE projects(id TEXT, name TEXT); CREATE TABLE project_roots(project_id TEXT, position INTEGER, path TEXT); CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT, rollout_path TEXT, updated_at INTEGER, source TEXT, name TEXT, project_id TEXT)");
  db.prepare("INSERT INTO projects VALUES (?, ?)").run("source-project", "Shared project");
  db.prepare("INSERT INTO project_roots VALUES (?, ?, ?)").run("source-project", 0, project);
  const add = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  add.run(codexId, "Codex feature", worktree, codexFile, 100, "vscode", null, "source-project");
  add.run(otherId, "Unselected session", other, join(roots.codex, "sessions", "missing.jsonl"), 99, "cli", null, null);
  add.run(randomUUID(), "Subagent", project, codexFile, 98, '{"subagent":{"other":"guardian"}}', null, null);
  db.close();
  const history = new LocalHistory(roots), store = new Store(join(root, "studio.sqlite"));
  const studio = new Studio(store, root, join(root, "socket"), history);
  t.after(async () => { await studio.close(); store.close(); });
  return { root, project, other, worktree, roots, codexId, claudeId, otherId, codexFile, claudeFile, database, writeLines, history, store, studio };
}

test("Local discovery groups worktree sessions under their Codex project and merges Claude folders", async t => {
  const f = await fixture(t), before = await readFile(f.database), catalog = await f.history.scan();
  assert.deepEqual(catalog.warnings, []);
  assert.equal(catalog.sessions.length, 3);
  const project = catalog.projects.find(project => project.path === f.project)!;
  assert.equal(project.name, "Shared project");
  assert.deepEqual(project.providers.sort(), ["claude", "codex"]);
  assert.equal(catalog.projects.length, 2);
  assert.equal(catalog.sessions.find(session => session.sourceId === f.codexId)?.projectKey, project.key);
  assert.equal(catalog.sessions.find(session => session.sourceId === f.claudeId)?.title, "Claude review");
  assert.equal(catalog.sessions.some(session => "file" in session), false);
  assert.deepEqual(await readFile(f.database), before);
  assert.equal(f.store.state().importedSessions.length, 0);
});

test("Worktrees without project membership import as one original project across providers", async t => {
  const f = await fixture(t), second = join(f.root, "second worktree"), secondId = randomUUID();
  await git(f.project, ["init", "-b", "main"], true);
  await git(f.project, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Initial fixture"], true);
  await git(f.project, ["worktree", "add", "--detach", f.worktree], true);
  await git(f.project, ["worktree", "add", "--detach", second], true);
  await mkdir(join(second, "src"));
  const db = new Database(f.database);
  db.exec("DELETE FROM project_roots; DELETE FROM projects; UPDATE threads SET project_id = NULL");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(secondId, "Another worktree", join(second, "src"), f.codexFile, 101, "cli", null, null);
  db.close();
  const claudeSource = (await readFile(f.claudeFile, "utf8")).replaceAll(f.project, second);
  await writeFile(f.claudeFile, claudeSource);

  const catalog = await f.history.scan();
  assert.deepEqual(catalog.warnings, []);
  assert.equal(catalog.projects.length, 2);
  const project = catalog.projects.find(item => item.path === f.project)!;
  assert.ok(project);
  assert.deepEqual(project.providers.sort(), ["claude", "codex"]);
  assert.equal(catalog.projects.some(item => item.path === f.worktree || item.path.startsWith(second)), false);
  for (const id of [f.codexId, secondId, f.claudeId]) assert.equal(catalog.sessions.find(item => item.sourceId === id)?.projectKey, project.key);
  assert.equal(catalog.sessions.find(item => item.sourceId === f.codexId)?.cwd, f.worktree);
  assert.equal(catalog.sessions.find(item => item.sourceId === f.claudeId)?.cwd, second);
  const imported = await f.studio.dispatch("local.import", { projects: [project.key], sessions: [], revision: 0 });
  assert.equal(imported.addedProjects, 1);
  assert.equal(imported.projects[0].path, f.project);
  assert.equal(imported.addedSessions, 0);
  assert.equal(await readFile(f.claudeFile, "utf8"), claudeSource);
});

test("Separate repositories with the same name and explicit subfolder projects stay distinct", async t => {
  const f = await fixture(t), first = join(f.root, "first", "same-name"), second = join(f.root, "second", "same-name"), subfolder = join(first, "apps", "web");
  await mkdir(subfolder, { recursive: true }); await mkdir(second, { recursive: true });
  for (const path of [first, second]) await git(path, ["init", "-b", "main"], true);
  await writeFile(join(f.roots.codex, ".codex-global-state.json"), JSON.stringify({ "electron-saved-workspace-roots": [first, second, subfolder] }));
  const catalog = await f.history.scan();
  assert.deepEqual(catalog.warnings, []);
  assert.equal(catalog.projects.filter(item => item.name === "same-name").length, 2);
  for (const path of [first, second, subfolder]) assert.ok(catalog.projects.find(item => item.path === path));
});

test("Claude desktop launch roots do not replace the transcript project folder", async t => {
  const f = await fixture(t), directory = join(f.roots.claudeDesktop, "account", "organization");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "local-session.json"), JSON.stringify({ cliSessionId: f.claudeId, originCwd: "/", cwd: f.project, title: "Desktop review" }));
  const catalog = await f.history.scan();
  const session = catalog.sessions.find(item => item.sourceId === f.claudeId)!;
  assert.equal(catalog.projects.find(item => item.key === session.projectKey)?.path, f.project);
  assert.equal(catalog.projects.some(item => item.path === "/"), false);
});

test("Selected imports persist text snapshots without changing source sessions or creating runs", async t => {
  const f = await fixture(t), source = await readFile(f.codexFile), sourceClaude = await readFile(f.claudeFile);
  const catalog = await f.studio.dispatch("local.scan", {}), project = catalog.projects.find((item: { path: string }) => item.path === f.project);
  const first = await f.studio.dispatch("local.import", { projects: [project.key], sessions: [`codex:${f.codexId}`, `claude:${f.claudeId}`], revision: 0 });
  assert.equal(first.addedProjects, 1); assert.equal(first.addedSessions, 2);
  assert.equal(f.store.state().run, null); assert.deepEqual(f.store.state().history, []);
  assert.equal(f.studio.settings().projects.length, 1);
  assert.equal(first.importedSessions.some((item: { messages?: unknown }) => item.messages), false);
  const loaded = await f.studio.dispatch("local.read", { key: `codex:${f.codexId}` });
  assert.deepEqual(loaded.messages.map((message: { text: string }) => message.text), ["Build the selected feature", "The feature is ready."]);
  assert.equal(loaded.total, 2); assert.equal(loaded.cwd, f.worktree); assert.equal(loaded.project.path, f.project);
  const claude = await f.studio.dispatch("local.read", { key: `claude:${f.claudeId}` });
  assert.deepEqual(claude.messages.map((message: { text: string }) => message.text), ["Review the feature", "Review complete."]);
  const repeated = await f.studio.dispatch("local.import", { projects: [project.key], sessions: [`codex:${f.codexId}`], revision: first.revision });
  assert.equal(repeated.addedProjects, 0); assert.equal(repeated.addedSessions, 0);
  await f.studio.dispatch("project.remove", { id: first.projects[0].id, revision: repeated.revision });
  assert.equal((await f.studio.dispatch("local.read", { key: `codex:${f.codexId}` })).messages.length, 2);
  const reopened = new Store(join(f.root, "studio.sqlite"));
  assert.equal(reopened.importedSessions().length, 2); reopened.close();
  assert.deepEqual(await readFile(f.codexFile), source); assert.deepEqual(await readFile(f.claudeFile), sourceClaude);
});

test("Project-only imports reuse existing execution settings and stale saves write no partial imports", async t => {
  const f = await fixture(t), catalog = await f.history.scan(), project = catalog.projects.find(item => item.path === f.project)!;
  const existing = { id: "existing", path: f.project, name: "My project", execution: { mode: "worktree", branchName: "custom-branch", baseRef: "HEAD" } };
  await f.studio.dispatch("settings.save", { state: { ...f.studio.settings(), projects: [existing], activeProjectId: existing.id }, revision: 0 });
  const result = await f.studio.dispatch("local.import", { projects: [project.key], sessions: [], revision: 1 });
  assert.deepEqual(result.projects, [existing]); assert.equal(result.addedSessions, 0);
  await assert.rejects(f.studio.dispatch("local.import", { projects: [], sessions: [`claude:${f.claudeId}`], revision: 1 }), /another window/);
  assert.equal(f.store.importedSessions().length, 0);
  assert.deepEqual(f.studio.settings().projects, [existing]);
});

test("Missing or swapped transcripts reject the batch without registering any project", async t => {
  const f = await fixture(t); await f.history.scan();
  await assert.rejects(f.studio.dispatch("local.import", { projects: [], sessions: [`codex:${f.codexId}`, `codex:${f.otherId}`], revision: 0 }), /ENOENT/);
  assert.equal(f.studio.settings().projects.length, 0); assert.equal(f.store.importedSessions().length, 0);
  await f.writeLines(f.codexFile, [{ type: "session_meta", payload: { id: randomUUID() } }]);
  await assert.rejects(f.history.read(`codex:${f.codexId}`), /no longer matches/);
  await assert.rejects(f.history.read("../../secrets"), /discovery expired/);
});

test("Session import rejects a transcript symlink that leaves the provider history folder", async t => {
  const f = await fixture(t); await f.history.scan();
  await writeFile(join(f.root, "outside.jsonl"), await readFile(f.codexFile));
  await rm(f.codexFile); await symlink(join(f.root, "outside.jsonl"), f.codexFile);
  await assert.rejects(f.history.read(`codex:${f.codexId}`), /inside its local history folder/);
});

test("Repeated message records use their latest text and incomplete records fail without partial saves", async t => {
  const f = await fixture(t); await f.history.scan();
  await appendFile(f.claudeFile, JSON.stringify({ type: "assistant", uuid: "message-2", sessionId: f.claudeId, message: { role: "assistant", content: [{ type: "text", text: "Review complete. Tests also passed." }] } }) + "\n");
  const session = await f.history.read(`claude:${f.claudeId}`);
  assert.equal(session.messages.length, 2); assert.equal(session.messages[1].text, "Review complete. Tests also passed.");
  assert.equal(session.messages[1].time, "");
  await appendFile(f.claudeFile, '{"type":"assistant"');
  await assert.rejects(f.studio.dispatch("local.import", { projects: [], sessions: [`claude:${f.claudeId}`], revision: 0 }), /incomplete record/);
  assert.equal(f.studio.settings().projects.length, 0); assert.equal(f.store.importedSessions().length, 0);
});

test("Conversation reads paginate and mark bounded snapshots explicitly", async t => {
  const f = await fixture(t);
  await f.writeLines(f.codexFile, [
    { type: "session_meta", payload: { id: f.codexId } },
    ...Array.from({ length: 5001 }, (_, i) => ({ type: "response_item", payload: { type: "message", role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `Message ${i}` }] } })),
  ]);
  await f.history.scan();
  await f.studio.dispatch("local.import", { projects: [], sessions: [`codex:${f.codexId}`], revision: 0 });
  const first = await f.studio.dispatch("local.read", { key: `codex:${f.codexId}` });
  assert.equal(first.truncated, true); assert.equal(first.total, 5000); assert.equal(first.messages.length, 100); assert.equal(first.nextOffset, 100);
  const second = await f.studio.dispatch("local.read", { key: `codex:${f.codexId}`, offset: 100 });
  assert.equal(second.messages[0].text, "Message 100");
});
