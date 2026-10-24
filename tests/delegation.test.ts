import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { initialState } from "../packages/contracts/defaults.js";
import { settingsSchema, type Run, type Step } from "../packages/contracts/index.ts";
import { Studio } from "../packages/engine/studio.ts";
import { Store } from "../packages/engine/store.ts";
import { Toolbox, toolSpecs } from "../packages/engine/tools.ts";
const answer = (summary = "Done") => JSON.stringify({ summary, status: "completed", decision: "pass", artifacts: [] });
const until = async (check: () => boolean, message = "Condition did not become true") => { for (let i = 0; i < 1200; i++) { if (check()) return; await delay(10); } assert.fail(message); };
async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "studio-delegation-"))), cwd = join(root, "project"); await mkdir(cwd);
  await writeFile(join(cwd, "README.md"), "original\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Initial");
  const store = new Store(join(root, "state.sqlite")), studio = new Studio(store, root, join(root, "sockets"));
  const settings = settingsSchema.parse({ ...initialState(), skillRoots: [], approvalRequired: false });
  const parent = { ...settings.agents[1], permissionLevel: "bypass" as const, tools: ["read", "write", "shell"] as ("read" | "write" | "shell")[], skillBindings: [], delegation: { enabled: true, maxChildren: 3, allowedAgentIds: ["worker"] } };
  const worker = { ...parent, id: "worker", name: "Worker", delegation: undefined };
  settings.agents = [parent, worker]; settings.flows = [{ id: "flow", name: "Test", workflow: [parent.id], archived: false, revision: 1, rules: [] }]; settings.activeFlowId = "flow";
  settings.projects = [{ id: "project", name: "Fixture", path: cwd, execution: { mode: "local", branchName: "" } }]; settings.activeProjectId = "project";
  store.set("settings", settings); studio.connections.assertAgent = async () => {};
  t.after(async () => { await studio.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const start = () => studio.dispatch("run.start", { flowId: "flow", projectId: "project", brief: "Test delegation", commandId: "start" }) as Promise<Run>;
  const finish = async (id: string) => { await until(() => ["succeeded", "failed"].includes(store.run(id)?.status || "")); return store.run(id)!; };
  return { root, cwd, git, store, studio, settings, start, finish };
}

test("Three children run concurrently with frozen presets, bounded permissions and one parent task", async t => {
  const f = await fixture(t), entered: Run[] = []; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  t.mock.method(f.studio as any, "codexTurn", async (run: Run, step: Step, _prompt: string, tools: Toolbox) => {
    if (run.parent) {
      entered.push(run); assert.equal(step.agent.permissionLevel, "read-only"); assert.deepEqual(step.agent.tools, ["read"]);
      assert.ok(!toolSpecs(step).some(tool => tool.name === "studio_delegate")); await gate; return answer("Checked snapshot");
    }
    for (let i = 0; i < 3; i++) assert.equal((await tools.call("studio_delegate", { agentId: "worker", task: `Inspect ${i}`, mode: "read" })).success, true);
    await until(() => entered.length === 3);
    assert.equal(f.store.state().activeRuns.length, 1); assert.equal(f.store.state().run!.id, run.id); assert.equal(f.store.state().history.length, 0);
    assert.equal((await tools.call("studio_delegate", { agentId: "worker", task: "Fourth", mode: "read" })).success, false);
    assert.equal((await tools.call("studio_delegate", { agentId: "unknown", task: "No access", mode: "read" })).success, false);
    release(); await tools.call("studio_delegations", { wait: true });
    for (const child of entered) assert.equal((await tools.call("studio_collect", { id: child.id, action: "accept", reason: "Checked the report" })).success, true);
    return answer();
  });
  const run = await f.start(); f.settings.agents[1].prompt = "Changed later"; f.store.set("settings", f.settings);
  const done = await f.finish(run.id); assert.equal(done.status, "succeeded", done.note);
  assert.equal(new Set(entered.map(child => child.cwd)).size, 3); assert.ok(entered.every(child => child.steps[0].agent.prompt !== "Changed later"));
  assert.equal(f.store.children(run.id).length, 3); assert.equal(f.store.state().run!.children!.length, 3);
});

test("Write collection requires parent verification and never starts the next role early", async t => {
  const f = await fixture(t); let parentCalls = 0;
  t.mock.method(f.studio as any, "codexTurn", async (run: Run, step: Step, prompt: string, tools: Toolbox) => {
    if (run.parent) { assert.equal(step.agent.permissionLevel, "project"); assert.equal((await tools.call("studio_write", { path: "result.txt", content: "child" })).success, true); return answer(); }
    parentCalls++;
    if (parentCalls === 1) {
      const spawned = await tools.call("studio_delegate", { agentId: "worker", task: "Write result.txt", mode: "write" }); assert.equal(spawned.success, true);
      await tools.call("studio_delegations", { wait: true });
      const id = (spawned.result as any).id;
      assert.equal((await tools.call("studio_collect", { id, action: "accept", reason: "Diff reviewed" })).success, true);
      return answer("Premature handoff");
    }
    assert.equal(run.delegationContinuation, true); assert.match(prompt, /run combined tests|Run the combined tests/);
    assert.equal((await tools.call("studio_shell", { command: "test \"$(cat result.txt)\" = child", timeoutSeconds: 5, background: false })).success, true);
    return answer("Integrated and verified");
  });
  const run = await f.start(), done = await f.finish(run.id); assert.equal(done.status, "succeeded", done.note); assert.equal(parentCalls, 2);
  assert.equal(await readFile(join(f.cwd, "result.txt"), "utf8"), "child");
});

test("Parent interruption cancels all children before the new instruction runs", async t => {
  const f = await fixture(t); let parentReady = false; const children: Run[] = [];
  t.mock.method(f.studio as any, "codexTurn", async (run: Run, _step: Step, _prompt: string, tools: Toolbox) => {
    if (run.parent) { children.push(run); await until(() => ["cancelling", "cancelled"].includes(run.status)); return answer(); }
    if (run.activeMessage) { assert.ok(children.every(child => child.status === "cancelled")); return answer("Adjusted"); }
    await tools.call("studio_delegate", { agentId: "worker", task: "Inspect", mode: "read" }); parentReady = true;
    await until(() => !!run.interruptRequested); return answer();
  });
  const run = await f.start(); await until(() => parentReady && children.length === 1);
  await f.studio.dispatch("run.message", { id: run.id, stepId: run.steps[0].id, message: "Stop the old work and adjust", mode: "interrupt" });
  const done = await f.finish(run.id); assert.equal(done.status, "succeeded", done.note);
  assert.equal(f.store.children(run.id)[0].parent!.resolution, "discarded");
});

test("Settings reject unknown presets and child limits outside one to three", async () => {
  const state = settingsSchema.parse(initialState());
  for (const maxChildren of [0, 4]) { state.agents[0].delegation = { enabled: true, maxChildren, allowedAgentIds: [] }; assert.equal(settingsSchema.safeParse(state).success, false); }
  state.agents[0].delegation = { enabled: true, maxChildren: 3, allowedAgentIds: ["missing"] }; assert.equal(settingsSchema.safeParse(state).success, false);
});

test("Commands to one child drain priority then queue without interrupting siblings", async t => {
  const f = await fixture(t), entered: Run[] = [], order: string[] = []; let releaseSibling = false;
  t.mock.method(f.studio as any, "codexTurn", async (run: Run, _step: Step, _prompt: string, tools: Toolbox) => {
    if (run.parent) {
      if (run.activeMessage) { order.push(run.activeMessage.message); return answer(); }
      entered.push(run);
      if (run.parent.task === "first") await until(() => !!run.interruptRequested);
      else await until(() => releaseSibling || run.status === "cancelling");
      return answer();
    }
    for (const task of ["first", "second"]) assert.equal((await tools.call("studio_delegate", { agentId: "worker", task, mode: "read" })).success, true);
    await tools.call("studio_delegations", { wait: true });
    for (const child of entered) assert.equal((await tools.call("studio_collect", { id: child.id, action: "accept", reason: "Reviewed" })).success, true);
    return answer();
  });
  const parent = await f.start(); await until(() => entered.length === 2);
  const child = entered.find(item => item.parent!.task === "first")!, sibling = entered.find(item => item !== child)!;
  await f.studio.dispatch("run.message", { id: child.id, stepId: child.steps[0].id, message: "queued", mode: "queue" });
  await f.studio.dispatch("run.message", { id: child.id, stepId: child.steps[0].id, message: "priority", mode: "interrupt" });
  await until(() => f.store.run(child.id)?.status === "succeeded");
  assert.deepEqual(order, ["priority", "queued"]); assert.equal(sibling.status, "running"); assert.equal(f.store.run(parent.id)?.interruptRequested, undefined);
  releaseSibling = true; const done = await f.finish(parent.id); assert.equal(done.status, "succeeded", done.note);
});

test("Child approvals belong to separate sessions and cannot approve another child", async t => {
  const f = await fixture(t); f.settings.agents[1].permissionLevel = "ask"; f.store.set("settings", f.settings);
  t.mock.method(f.studio as any, "codexTurn", async (run: Run, _step: Step, _prompt: string, tools: Toolbox) => {
    if (run.parent) { await tools.call("studio_shell", { command: "true", timeoutSeconds: 5, background: false }); return answer(); }
    for (const task of ["first", "second"]) await tools.call("studio_delegate", { agentId: "worker", task, mode: "write" });
    await tools.call("studio_delegations", { wait: true });
    for (const child of f.store.children(run.id)) await tools.call("studio_collect", { id: child.id, action: child.status === "succeeded" ? "accept" : "discard", reason: "Reviewed execution outcome" });
    return answer();
  });
  const parent = await f.start(); await until(() => f.store.children(parent.id).filter(child => child.approval).length === 2);
  const [a, b] = f.store.children(parent.id);
  await assert.rejects(f.studio.dispatch("run.control", { id: b.id, action: "approve", approvalId: a.approval!.id }), /no longer pending/);
  await f.studio.dispatch("run.control", { id: a.id, action: "cancel" });
  assert.equal(f.store.run(b.id)!.approval!.id, b.approval!.id);
  await f.studio.dispatch("run.control", { id: b.id, action: "approve", approvalId: b.approval!.id });
  const done = await f.finish(parent.id); assert.equal(done.status, "succeeded", done.note);
});

test("Restart preserves child history and blocks unknown integration instead of replaying", async t => {
  const f = await fixture(t);
  t.mock.method(f.studio as any, "codexTurn", async (run: Run, _step: Step, _prompt: string, tools: Toolbox) => {
    if (run.parent) return answer();
    await tools.call("studio_delegate", { agentId: "worker", task: "Inspect", mode: "read" });
    await tools.call("studio_delegations", { wait: true });
    for (const child of f.store.children(run.id)) await tools.call("studio_collect", { id: child.id, action: "accept", reason: "Reviewed" });
    return answer();
  });
  const started = await f.start(); await f.finish(started.id); await f.studio.close();
  const parent = f.store.run(started.id)!, child = f.store.children(started.id)[0];
  parent.status = "running"; parent.index = 0; parent.steps[0].status = "running"; child.status = "running"; child.steps[0].status = "running"; child.parent!.resolution = "pending";
  f.store.saveRun(parent, "interrupted"); f.store.saveRun(child, "interrupted");
  const restarted = new Studio(f.store, f.root, f.root); t.after(() => restarted.close());
  assert.equal(f.store.state().activeRuns.length, 1); assert.equal(f.store.state().run!.children![0].status, "needs_reconciliation");
  await restarted.dispatch("run.reconcile", { id: parent.id }); assert.equal(f.store.run(parent.id)!.status, "needs_reconciliation");
  assert.match(f.store.run(parent.id)!.note, /No child or integration was replayed/);
  await restarted.dispatch("run.control", { id: parent.id, action: "cancel" }); assert.equal(f.store.run(child.id)!.status, "cancelled");
  await restarted.close();
});

test("Test-only children retain shell and HTTP tools and contribute accepted QA evidence", async t => {
  const { createServer } = await import("node:http");
  const server = createServer((_request, response) => response.end("healthy"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const f = await fixture(t);
  for (const agent of f.settings.agents) { agent.role = "backend"; agent.tools = ["read", "shell"]; }
  f.store.set("settings", f.settings);
  t.mock.method(f.studio as any, "codexTurn", async (run: Run, _step: Step, _prompt: string, tools: Toolbox) => {
    if (run.parent) {
      assert.equal((await tools.call("studio_http", { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, method: "GET", body: "", headers: {} })).success, true);
      return JSON.stringify({ summary: "API passed", status: "completed", decision: "pass", artifacts: [{ name: "api-report.json", type: "Report", content: "HTTP 200, healthy" }] });
    }
    assert.equal((await tools.call("studio_delegate", { agentId: "worker", task: "Check the API", mode: "write" })).success, true);
    await tools.call("studio_delegations", { wait: true });
    const child = f.store.children(run.id)[0], report = child.artifacts.find(item => item.name === "api-report.json")!;
    const read = await tools.call("studio_artifact", { id: report.id, offset: 0 }); assert.equal(read.success, true); assert.equal((read.result as any).content, "HTTP 200, healthy");
    assert.equal((await tools.call("studio_collect", { id: child.id, action: "accept", reason: "Verified HTTP receipt" })).success, true);
    return answer("Collected the QA evidence");
  });
  const run = await f.start(), done = await f.finish(run.id); assert.equal(done.status, "succeeded", done.note);
  assert.equal(f.store.children(run.id)[0].parent!.integratedReference, undefined);
});
