import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store, hash } from "../packages/engine/store.ts";
import { SkillCatalog } from "../packages/engine/skills.ts";
import { inspectProject, prepareProject, projectInstructions } from "../packages/engine/projects.ts";
import { settingsSchema, type Run } from "../packages/contracts/index.ts";
import { initialState } from "../packages/contracts/defaults.js";
import { Toolbox } from "../packages/engine/tools.ts";

async function directory(t: test.TestContext) { const path = await realpath(await mkdtemp(join(tmpdir(), "studio-test-"))); t.after(() => rm(path, { recursive: true, force: true })); return path; }
function initGit(path: string) {
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "Initial commit"]);
}
test("Command replay returns the saved result without repeating side effects", async t => {
  const path = await directory(t); const store = new Store(join(path, "state.sqlite")); t.after(() => store.close());
  let writes = 0;
  const execute = async () => ({ writes: ++writes });
  assert.deepEqual(await store.command("id", "write", { path: "a" }, execute), { writes: 1 });
  assert.deepEqual(await store.command("id", "write", { path: "a" }, execute), { writes: 1 });
  await assert.rejects(store.command("id", "write", { path: "b" }, execute), /different input/);
  assert.equal(writes, 1);
});
test("A command interrupted before its acknowledgement is never replayed automatically", async t => {
  const path = await directory(t); const store = new Store(join(path, "state.sqlite")); t.after(() => store.close());
  store.db.prepare("INSERT INTO commands VALUES (?, ?, ?, 'pending', NULL, NULL)").run("pending", "write", hash("{}"));
  await assert.rejects(store.command("pending", "write", {}, async () => assert.fail("Must not execute")), /uncertain/);
});
test("Settings reject invalid flow references and archiving every flow", () => {
  const settings = settingsSchema.parse(initialState());
  settings.flows[0].workflow.push("missing"); assert.equal(settingsSchema.safeParse(settings).success, false);
  const archived = settingsSchema.parse(initialState()); archived.flows[0].archived = true;
  assert.equal(settingsSchema.safeParse(archived).success, false);
});
test("Skill identity follows its real path and supporting content changes its version", async t => {
  const path = await directory(t), root = join(path, "skills");
  await mkdir(join(root, "first", "references"), { recursive: true });
  await writeFile(join(root, "first", "SKILL.md"), "---\nname: Shared\ndescription: >\n  A useful\n  skill.\n---\n# Instructions");
  await writeFile(join(root, "first", "references", "guide.md"), "one");
  await symlink(join(root, "first"), join(root, "alias"));
  const catalog = new SkillCatalog(join(path, "snapshots")); const found = await catalog.scan([root]);
  assert.equal(found.skills.length, 1); assert.equal(found.skills[0].description, "A useful skill.");
  const binding = found.skills[0]; await catalog.snapshot([binding]);
  await writeFile(join(root, "first", "references", "guide.md"), "two");
  await assert.rejects(catalog.snapshot([binding]), /changed/);
  const frozen = await catalog.readSnapshot(binding.version);
  assert.equal(frozen.files.find(f => f.path.endsWith("guide.md"))?.content, "one");
  assert.notEqual((await catalog.detail(binding.id)).version, binding.version);
});
test("Skill snapshots exclude secrets and symlinks outside their source", async t => {
  const path = await directory(t), root = join(path, "skills");
  await mkdir(join(root, "safe", "references"), { recursive: true });
  await writeFile(join(root, "safe", "SKILL.md"), "# Safe");
  await writeFile(join(path, "outside.md"), "outside");
  await symlink(join(path, "outside.md"), join(root, "safe", "references", "escape.md"));
  await writeFile(join(root, "safe", "references", "credentials.json"), "secret");
  const catalog = new SkillCatalog(join(path, "snapshots")); const found = await catalog.scan([root]);
  const detail = await catalog.detail(found.skills[0].id);
  assert.deepEqual(detail.files.map(f => f.path), ["SKILL.md"]); assert.equal(detail.omitted, 1);
  await assert.rejects(catalog.readSnapshot("../outside.md"));
});
test("Local projects allow non-Git folders and worktrees require a commit", async t => {
  const path = await directory(t);
  assert.equal((await inspectProject(path, { mode: "local" })).isGit, false);
  await assert.rejects(inspectProject(path, { mode: "worktree", baseRef: "HEAD" }), /at least one commit/);
  execFileSync("git", ["init", "-q", path]);
  assert.equal((await inspectProject(path)).head, null);
});
test("Worktrees preserve source changes and reject stale or existing branch names", async t => {
  const path = await directory(t), source = join(path, "source"); await mkdir(source); initGit(source);
  await writeFile(join(source, "uncommitted.txt"), "keep me");
  await assert.rejects(inspectProject(source, { mode: "worktree", baseRef: "missing" }), /no longer available/);
  await assert.rejects(inspectProject(source, { mode: "worktree", baseRef: "HEAD", branchName: "--bad" }), /valid new branch/);
  const prepared = await prepareProject({ id: "p", name: "Test", path: source, execution: { mode: "worktree", baseRef: "HEAD", branchName: "test/run" } }, "run", path);
  assert.notEqual(prepared.cwd, source); assert.equal(await readFile(join(source, "uncommitted.txt"), "utf8"), "keep me");
  await assert.rejects(inspectProject(source, { mode: "worktree", baseRef: "HEAD", branchName: "test/run" }), /already exists/);
});
test("File tools enforce write approval and block escaping paths", async t => {
  const path = await directory(t), project = join(path, "project"); await mkdir(project);
  const state = initialState();
  const step = { id: "step", agent: { ...state.agents[1], provider: "codex", auth: "subscription" }, status: "running", sessionId: "s", messages: [], receivedArtifacts: [] } as Run["steps"][number];
  const run = { cwd: project, approved: false, artifacts: [], steps: [step] } as unknown as Run;
  const tools = new Toolbox({ run, step, save: () => {}, approval: async () => false, redact: text => text }, join(path, "artifacts"));
  assert.equal((await tools.call("studio_write", { path: "a.txt", content: "no" })).success, false);
  run.approved = true;
  assert.equal((await tools.call("studio_write", { path: "a.txt", content: "yes" })).success, true);
  assert.equal(await readFile(join(project, "a.txt"), "utf8"), "yes");
  assert.equal((await tools.call("studio_write", { path: "../escape.txt", content: "no" })).success, false);
  await symlink(path, join(project, "escape"));
  assert.equal((await tools.call("studio_write", { path: "escape/file.txt", content: "no" })).success, false);
  assert.equal((await tools.call("studio_read", { path: ".env" })).success, false);
  await tools.close();
});

test("Concurrent starts cannot prepare two workflows while account validation is pending", async t => {
  const { Studio } = await import("../packages/engine/studio.ts");
  const path = await directory(t), store = new Store(join(path, "state.sqlite")), studio = new Studio(store, path, path);
  t.after(async () => { await studio.close(); store.close(); });
  const settings = studio.settings(); settings.projects = [{ id: "project", name: "Fixture", path, execution: { mode: "local", branchName: "" } }]; settings.skillRoots = []; store.set("settings", settings);
  let release!: (error: Error) => void;
  const gate = new Promise<void>((_resolve, reject) => { release = reject; }); studio.connections.assertAgent = async () => gate;
  const input = { projectId: "project", flowId: settings.activeFlowId, brief: "Read only", commandId: "first" };
  const first = studio.dispatch("run.start", input);
  await assert.rejects(studio.dispatch("run.start", { ...input, commandId: "second" }), /Only one run/);
  await assert.rejects(studio.dispatch("project.remove", { id: "project", revision: 0 }), /finish starting/);
  release(new Error("Account check stopped for this test.")); await assert.rejects(first, /Account check stopped/);
  assert.equal(store.runs().length, 0);
});

test("History lists remain small while complete conversations stay retrievable", async t => {
  const path = await directory(t), store = new Store(join(path, "state.sqlite")); t.after(() => store.close());
  const settings = settingsSchema.parse(initialState()); store.set("settings", settings);
  const old = { id: "old", createdAt: "2026-01-01", brief: "Previous task", project: { name: "Project" }, flow: { name: "Flow" }, status: "succeeded", artifacts: [{ name: "report.md", content: "e".repeat(100000) }], steps: [{ messages: [{ text: "m".repeat(100000) }] }] } as unknown as Run;
  store.saveRun(old, "run.completed"); store.saveRun({ ...old, id: "new", createdAt: "2026-01-02", artifacts: [], steps: [] }, "run.completed");
  const state = store.state(); assert.equal(state.history.length, 1); assert.equal(state.history[0].artifactCount, 1);
  assert(JSON.stringify(state.history).length < 1000); assert.equal(store.run("old")!.steps[0].messages[0].text.length, 100000);
});

test("Boundary recovery refuses files changed after the saved handoff", async t => {
  const { Studio } = await import("../packages/engine/studio.ts");
  const { codeReference } = await import("../packages/engine/tools.ts");
  const path = await directory(t), project = join(path, "project"); await mkdir(project);
  await writeFile(join(project, "README.md"), "Original");
  const store = new Store(join(path, "state.sqlite"));
  const run = { id: "boundary", createdAt: "2026-01-01", status: "running", cwd: project, index: 1, controlMode: "studio", steps: [{ status: "succeeded", codeReference: await codeReference(project) }, { status: "queued" }] } as unknown as Run;
  store.saveRun(run, "step.completed");
  const studio = new Studio(store, path, path); t.after(async () => { await studio.close(); store.close(); });
  await writeFile(join(project, "README.md"), "Changed outside the runner");
  await assert.rejects(studio.dispatch("run.reconcile", { id: run.id }), /changed after the saved step boundary/);
  assert.equal(store.run(run.id)!.status, "needs_reconciliation");
  await writeFile(join(project, "README.md"), "Original");
  assert.equal((await studio.dispatch("run.reconcile", { id: run.id }) as Run).status, "paused");
});

test("Workspace reset preserves registered projects, skill sources and project files", async t => {
  const { Studio } = await import("../packages/engine/studio.ts");
  const path = await directory(t), project = join(path, "project"); await mkdir(project);
  await writeFile(join(project, "README.md"), "Keep this project");
  const store = new Store(join(path, "state.sqlite")), studio = new Studio(store, path, path);
  t.after(async () => { await studio.close(); store.close(); });
  const settings = studio.settings(); settings.projects = [{ id: "project", name: "Fixture", path: project, execution: { mode: "local", branchName: "" } }]; settings.activeProjectId = "project"; settings.skillRoots = [join(path, "skills")]; settings.brief = "Discard this draft"; store.set("settings", settings);
  const result = await studio.dispatch("reset", { commandId: "reset-test" }) as ReturnType<Store["state"]>;
  assert.deepEqual(result.projects, settings.projects); assert.deepEqual(result.skillRoots, settings.skillRoots);
  assert.equal(result.brief, ""); assert.equal(result.run, null); assert.deepEqual(result.connections, []);
  assert.equal(await readFile(join(project, "README.md"), "utf8"), "Keep this project");
});

test("Worktrees retain ignored source instructions without reading outside project files", async t => {
  const path = await directory(t), source = join(path, "source"); await mkdir(source); initGit(source);
  await writeFile(join(source, "AGENTS.md"), "Use the selected project conventions.");
  const prepared = await prepareProject({ id: "p", name: "Fixture", path: source, execution: { mode: "worktree", baseRef: "HEAD", branchName: "test/instructions" } }, "instructions", path);
  const snapshot = await projectInstructions(prepared.cwd, source);
  assert.deepEqual(snapshot, ["AGENTS.md:\nUse the selected project conventions."]);
  await writeFile(join(source, "AGENTS.md"), "New source instructions");
  assert.match(snapshot[0], /selected project conventions/);
  await writeFile(join(prepared.cwd, "AGENTS.md"), "Rules from the chosen worktree revision");
  assert.deepEqual(await projectInstructions(prepared.cwd, source), ["AGENTS.md:\nRules from the chosen worktree revision"]);
  await writeFile(join(path, "outside.md"), "Outside instructions");
  await symlink(join(path, "outside.md"), join(source, "CLAUDE.md"));
  await assert.rejects(projectInstructions(prepared.cwd, source), /inside the selected project/);
});

test("Removing projects updates selection but retains folders, worktrees and history", async t => {
  const { Studio } = await import("../packages/engine/studio.ts");
  const path = await directory(t), source = join(path, "project"), worktree = join(path, "worktree");
  await mkdir(source); await mkdir(worktree);
  await writeFile(join(source, "README.md"), "Keep source files"); await writeFile(join(worktree, "result.md"), "Keep worktree files");
  const store = new Store(join(path, "state.sqlite")), studio = new Studio(store, path, path);
  t.after(async () => { await studio.close(); store.close(); });
  const state = studio.settings();
  state.projects = [{ id: "first", name: "First", path: source, execution: { mode: "local", branchName: "" } }, { id: "second", name: "Second", path: worktree, execution: { mode: "local", branchName: "" } }];
  state.activeProjectId = "first"; store.set("settings", state);
  const past = { id: "past", status: "succeeded", createdAt: "2026-01-01", brief: "Saved task", flow: state.flows[0], project: state.projects[0], cwd: worktree, artifacts: [{ id: "report", content: "Verified evidence" }], steps: [{ messages: [{ text: "Saved conversation" }] }] } as unknown as Run;
  store.saveRun(past, "run.completed");
  await assert.rejects(studio.dispatch("project.remove", { id: "missing", revision: 0 }), /not found/);
  await assert.rejects(studio.dispatch("project.remove", { id: "first", revision: 99 }), /another window/);
  await studio.dispatch("project.remove", { id: "first", revision: 0 });
  assert.equal(studio.settings().activeProjectId, "second"); assert.equal(studio.settings().projects.length, 1);
  await studio.dispatch("project.remove", { id: "second", revision: 1 });
  assert.equal(studio.settings().activeProjectId, null); assert.deepEqual(studio.settings().projects, []);
  assert.deepEqual(store.run("past"), past);
  assert.equal(await readFile(join(source, "README.md"), "utf8"), "Keep source files");
  assert.equal(await readFile(join(worktree, "result.md"), "utf8"), "Keep worktree files");
  const persisted = new Store(join(path, "state.sqlite"));
  try { assert.deepEqual(persisted.get("settings"), studio.settings()); assert.equal(persisted.get("revision"), 2); } finally { persisted.close(); }
});

test("Active projects cannot be removed through either project removal or settings", async t => {
  const { Studio } = await import("../packages/engine/studio.ts");
  const path = await directory(t), store = new Store(join(path, "state.sqlite"));
  const state = settingsSchema.parse(initialState());
  state.projects = [{ id: "active", name: "Active", path, execution: { mode: "local", branchName: "" } }, { id: "other", name: "Other", path: join(path, "other"), execution: { mode: "local", branchName: "" } }];
  state.activeProjectId = "active"; store.set("settings", state);
  store.saveRun({ id: "active-run", createdAt: "2026-01-01", status: "running", project: state.projects[0], steps: [], artifacts: [] } as unknown as Run, "run.created");
  const studio = new Studio(store, path, path); t.after(async () => { await studio.close(); store.close(); });
  await assert.rejects(studio.dispatch("project.remove", { id: "active", revision: 0 }), /active task/);
  await assert.rejects(studio.dispatch("settings.save", { state: { ...state, projects: [], activeProjectId: null }, revision: 0 }), /active task/);
  assert.deepEqual(studio.settings(), state);
  await studio.dispatch("project.remove", { id: "other", revision: 0 });
  assert.equal(studio.settings().activeProjectId, "active"); assert.equal(studio.settings().projects.length, 1);
});

test("Project settings reject duplicate identities and a removed active selection", () => {
  const state = settingsSchema.parse(initialState());
  state.activeProjectId = "removed";
  assert.equal(settingsSchema.safeParse(state).success, false);
  state.activeProjectId = null;
  state.projects = ["/first", "/second"].map(path => ({ id: "duplicate", name: "Project", path, execution: { mode: "local", branchName: "" } }));
  assert.equal(settingsSchema.safeParse(state).success, false);
});
