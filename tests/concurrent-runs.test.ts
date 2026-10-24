import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { initialState } from "../packages/contracts/defaults.js";
import { settingsSchema, type Run, type Step } from "../packages/contracts/index.ts";
import { Studio } from "../packages/engine/studio.ts";
import { Store } from "../packages/engine/store.ts";
import type { Toolbox } from "../packages/engine/tools.ts";

const output = (step: Step) => JSON.stringify({ summary: step.agent.name, status: "completed", decision: "pass", artifacts: (step.agent.role === "planner" ? ["implementation-plan.md", "qa-sheet.md"] : ["implementation.md"]).map(name => ({ name, type: "Report", content: `${step.id}: ${name}` })) });
async function fixture(t: test.TestContext, coder = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "studio-concurrent-")));
  const store = new Store(join(root, "state.sqlite"));
  let studio = new Studio(store, root, root);
  const state = settingsSchema.parse({ ...initialState(), maxConcurrentRuns: 2, skillRoots: [] });
  state.agents = [state.agents[coder ? 1 : 0]]; state.agents[0].provider = "codex";
  state.agents[0].tools = coder ? ["read", "write"] : ["read"];
  state.flows = [{ id: "flow", name: "Review", workflow: [state.agents[0].id], archived: false, revision: 1, rules: coder ? [] : [{ after: "planner", review: "always", lockOutputs: true }] }]; state.activeFlowId = "flow";
  state.projects = [];
  for (const id of ["a", "b", "c"]) { const path = join(root, id); await mkdir(path); await writeFile(join(path, "README.md"), id); state.projects.push({ id, name: id, path, execution: { mode: "local", branchName: "" } }); }
  state.activeProjectId = "a"; store.set("settings", state);
  const calls: string[] = [];
  const install = () => {
    studio.connections.assertAgent = async () => {};
    t.mock.method(studio as any, "codexTurn", async (run: Run, step: Step, _prompt: string, tools: Toolbox) => {
      calls.push(run.id);
      if (coder) assert.equal((await tools.call("studio_write", { path: "result.txt", content: run.brief })).success, true);
      return output(step);
    });
  };
  install();
  t.after(async () => { await studio.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return {
    root, state, store, calls, get studio() { return studio; },
    start(projectId: string) { return studio.dispatch("run.start", { projectId, flowId: "flow", brief: `Task ${projectId}`, commandId: `start-${projectId}` }) as Promise<Run>; },
    control(run: Run, action: string) { return studio.dispatch("run.control", { id: run.id, action, approvalId: run.approval?.id, reviewId: run.review?.id, fingerprint: run.review?.fingerprint }) as Promise<Run>; },
    async wait(id: string, status: string) { for (let i = 0; i < 500; i++) { const run = store.run(id); if (run?.status === status) return run; if (run?.status === "failed") assert.fail(run.note); await delay(10); } assert.fail(`Expected ${status}, got ${store.run(id)?.status}`); },
    async restart() { await studio.close(); studio = new Studio(store, root, root); install(); },
  };
}

test("Concurrency defaults preserve older workspaces and reject invalid limits", () => {
  const old = initialState() as any; delete old.maxConcurrentRuns;
  assert.equal(settingsSchema.parse(old).maxConcurrentRuns, 1);
  for (const count of [0, -1, 9, 1.5, "2"]) assert.equal(settingsSchema.safeParse({ ...old, maxConcurrentRuns: count }).success, false);
  assert.equal(settingsSchema.parse({ ...old, maxConcurrentRuns: 8 }).maxConcurrentRuns, 8);
});

test("Simultaneous starts reserve capacity before account checks and release it after cancellation", async t => {
  const f = await fixture(t);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.studio.connections.assertAgent = async () => gate;
  const first = f.start("a"), second = f.start("b");
  await assert.rejects(f.start("c"), /concurrent task limit/);
  release();
  const [a, b] = await Promise.all([first, second]);
  await f.wait(a.id, "waiting_review"); await f.wait(b.id, "waiting_review");
  assert.equal(f.store.state().activeRuns.length, 2);
  await assert.rejects(f.studio.dispatch("project.remove", { id: "a", revision: 0 }), /active task/);
  await assert.rejects(f.studio.dispatch("connection.disconnect", { id: "codex-subscription" }), /active run/);
  await f.control(a, "cancel");
  const c = await f.start("c"); await f.wait(c.id, "waiting_review");
  assert.equal(f.store.run(b.id)!.status, "waiting_review");
  assert.equal(new Set(f.calls).size, 3);
});

test("Cancelling one approval cannot approve, reject or clean up another task", async t => {
  const f = await fixture(t, true);
  const started = await Promise.all([f.start("a"), f.start("b")]);
  const a = await f.wait(started[0].id, "waiting_approval"), b = await f.wait(started[1].id, "waiting_approval");
  await assert.rejects(f.studio.dispatch("run.control", { id: b.id, action: "approve", approvalId: a.approval!.id }), /no longer pending/);
  await f.control(a, "cancel");
  assert.equal(f.store.run(b.id)!.approval!.id, b.approval!.id);
  assert.equal(f.store.run(b.id)!.status, "waiting_approval");
  assert.equal(f.calls.length, 0);
  await f.control(b, "approve"); await f.wait(b.id, "succeeded");
  assert.deepEqual(f.calls, [b.id]);
  assert.equal(await readFile(join(f.root, "b/result.txt"), "utf8"), "Task b");
  await assert.rejects(readFile(join(f.root, "a/result.txt")), { code: "ENOENT" });
});

test("Two provider turns overlap and either task can finish first", async t => {
  const f = await fixture(t), pending = new Map<string, () => void>();
  t.mock.method(f.studio as any, "codexTurn", async (run: Run, step: Step) => {
    await new Promise<void>(resolve => pending.set(run.project.id, resolve)); return output(step);
  });
  t.after(() => { for (const release of pending.values()) release(); });
  const [a, b] = await Promise.all([f.start("a"), f.start("b")]);
  for (let i = 0; i < 500 && pending.size < 2; i++) await delay(10);
  assert.equal(pending.size, 2, "Both turns must enter before either is released");
  pending.get("b")!(); await f.wait(b.id, "waiting_review");
  assert.equal(f.store.run(a.id)!.status, "running");
  pending.get("a")!(); await f.wait(a.id, "waiting_review");
});

test("Runner shutdown waits for every pending start without launching a turn", async t => {
  const f = await fixture(t); let entered = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.studio.connections.assertAgent = async () => { entered++; await gate; };
  const first = assert.rejects(f.start("a"), /shutting down/), second = assert.rejects(f.start("b"), /shutting down/);
  for (let i = 0; i < 500 && entered < 2; i++) await delay(10);
  assert.equal(entered, 2);
  let closed = false; const closing = f.studio.close().then(() => { closed = true; });
  await delay(20); assert.equal(closed, false);
  release(); await Promise.all([first, second, closing]);
  assert.equal(f.store.activeRuns().length, 0); assert.equal(f.calls.length, 0);
});

test("Canonical and nested local folders cannot run together, and failed starts release their reservations", async t => {
  const f = await fixture(t);
  await symlink(join(f.root, "a"), join(f.root, "alias")); await mkdir(join(f.root, "a/child"));
  f.state.projects.push({ ...f.state.projects[0], id: "alias", path: join(f.root, "alias") }, { ...f.state.projects[0], id: "nested", path: join(f.root, "a/child") }); f.store.set("settings", f.state);
  const a = await f.start("a"); await f.wait(a.id, "waiting_review");
  for (const id of ["alias", "nested"]) await assert.rejects(f.start(id), /overlapping folder/);
  const b = await f.start("b"); await f.wait(b.id, "waiting_review");
  await f.control(a, "cancel");
  const alias = await f.start("alias"); await f.wait(alias.id, "waiting_review");
  assert.equal(f.store.run(alias.id)!.cwd, join(f.root, "a"));
});

test("Two runs of the same project use distinct real Git worktrees", async t => {
  const f = await fixture(t), path = f.state.projects[0].path;
  execFileSync("git", ["init", "-q", path]); execFileSync("git", ["-C", path, "add", "README.md"]);
  execFileSync("git", ["-C", path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Initial fixture"]);
  f.state.projects[0].execution = { mode: "worktree", baseRef: "HEAD", branchName: "" }; f.store.set("settings", f.state);
  const [a, b] = await Promise.all([f.start("a"), f.start("a")]);
  await f.wait(a.id, "waiting_review"); await f.wait(b.id, "waiting_review");
  assert.notEqual(a.cwd, b.cwd); assert.notEqual(a.project.execution.branchName, b.project.execution.branchName);
  assert.equal(await readFile(join(a.cwd, "README.md"), "utf8"), "a");
  await writeFile(join(a.cwd, "README.md"), "Only A");
  assert.equal(await readFile(join(b.cwd, "README.md"), "utf8"), "a");
  assert.equal(await readFile(join(path, "README.md"), "utf8"), "a");
});

test("Every pending review survives restart and a lower limit never stops existing tasks", async t => {
  const f = await fixture(t), [a, b] = await Promise.all([f.start("a"), f.start("b")]);
  const original = await Promise.all([f.wait(a.id, "waiting_review"), f.wait(b.id, "waiting_review")]);
  await f.studio.dispatch("settings.save", { state: { ...f.studio.settings(), maxConcurrentRuns: 1 }, revision: 0 });
  await f.restart();
  for (const run of original) assert.equal(f.store.run(run.id)!.review!.id, run.review!.id);
  await assert.rejects(f.start("c"), /Only one run/);
  await f.control(original[0], "approve-review-only");
  assert.equal(f.store.run(a.id)!.status, "paused"); assert.equal(f.store.run(b.id)!.status, "waiting_review");
  await f.control(original[1], "approve-review-only");
  await f.control(original[0], "resume"); await f.control(original[1], "resume");
  await f.wait(a.id, "succeeded"); await f.wait(b.id, "succeeded");
});

test("Restart marks every interrupted task for separate reconciliation", async t => {
  const f = await fixture(t), started = await Promise.all([f.start("a"), f.start("b")]);
  for (const initial of started) {
    const run = await f.wait(initial.id, "waiting_review");
    run.status = "running"; delete run.review; run.index = 0; run.steps[0].status = "running";
    run.steps[0].providerThreadId = `thread-${run.id}`; run.steps[0].activeTurnId = `turn-${run.id}`;
    f.store.saveRun(run, "test.interrupted");
  }
  await f.restart();
  assert.equal(f.store.activeRuns().length, 2);
  for (const run of started) {
    assert.equal(f.store.run(run.id)!.status, "needs_reconciliation");
    assert.equal(f.store.run(run.id)!.steps[0].activeTurnId, `turn-${run.id}`);
  }
  await f.control(started[0], "cancel");
  assert.equal(f.store.run(started[1].id)!.status, "needs_reconciliation");
});

test("Interleaved provider deltas and process cleanup stay with their own run", async t => {
  const f = await fixture(t), started = await Promise.all([f.start("a"), f.start("b")]);
  await Promise.all(started.map(run => f.wait(run.id, "waiting_review")));
  const runs = await Promise.all(started.map(run => f.studio.dispatch("run.read", { id: run.id }) as Promise<Run>));
  const children = runs.map(() => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }));
  t.after(() => children.forEach(child => child.kill("SIGKILL")));
  for (let index = 0; index < 2; index++) {
    const run = runs[index]; run.steps[0].providerThreadId = `thread-${index}`;
    (f.studio as any).claudeProcesses.set(run.id, children[index]);
    (f.studio as any).codexEvent(run, { method: "item/agentMessage/delta", params: { threadId: `thread-${index}`, itemId: `message-${index}`, delta: `Output ${index}` } });
  }
  for (let attempt = 0; attempt < 100 && !runs.every(run => f.store.run(run.id)!.steps[0].messages.some(message => message.type === "assistant")); attempt++) await delay(10);
  for (let index = 0; index < 2; index++) assert.deepEqual(f.store.run(runs[index].id)!.steps[0].messages.filter(message => message.type === "assistant").map(message => message.text), [`Output ${index}`]);
  await f.control(runs[0], "cancel");
  assert.notEqual(children[0].signalCode, null); assert.equal(children[1].signalCode, null); process.kill(children[1].pid!, 0);
  assert.equal(f.store.run(runs[1].id)!.status, "waiting_review");
});
