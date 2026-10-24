import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { initialState } from "../packages/contracts/defaults.js";
import { flowSchema, removeAgentPreset, settingsSchema, type Run, type Step } from "../packages/contracts/index.ts";
import { flowEdges } from "../packages/contracts/flow.ts";
import { Studio } from "../packages/engine/studio.ts";
import { Store } from "../packages/engine/store.ts";

function settings() { return settingsSchema.parse({ ...initialState(), skillRoots: [] }); }

test("Deleting a preset cleans every flow and delegation list without changing other settings", () => {
  const state = settings();
  state.flows[0].rules = flowSchema.parse({ ...state.flows[0], rules: [
    { after: "planner", review: "always", lockOutputs: true, returnTo: "planner" },
    { after: "coder", review: "always", returnTo: "coder" },
    { after: "reviewer", review: "always", returnTo: "coder", loop: { target: "coder", maxCycles: 2, onLimit: "review" } },
    { after: "backend", review: "on_issue", loop: { target: "coder", maxCycles: 2, onLimit: "review" } },
  ] }).rules;
  state.flows.push(flowSchema.parse({ id: "archive", name: "Archived flow", archived: true, workflow: ["coder"] }));
  state.flows.push(flowSchema.parse({ id: "other", name: "Unchanged", workflow: ["planner", "reviewer"] }));
  state.agents[0].delegation = { enabled: true, maxChildren: 2, allowedAgentIds: ["coder"] };
  state.agents[2].delegation = { enabled: true, maxChildren: 3, allowedAgentIds: ["coder", "documenter"] };
  const before = structuredClone(state), next = removeAgentPreset(state, "coder");
  assert.deepEqual(state, before);
  assert(!next.agents.some(agent => agent.id === "coder"));
  assert.deepEqual(flowEdges(next.flows[0])[0], { from: "planner", to: "reviewer" });
  assert.equal(next.flows[0].edges, undefined);
  assert.deepEqual(next.flows[0].rules, [before.flows[0].rules[0], { after: "reviewer", review: "always", lockOutputs: false }, { after: "backend", review: "on_issue", lockOutputs: false }]);
  assert.deepEqual(next.flows[1].workflow, []);
  assert.deepEqual(next.flows[2], before.flows[2]);
  assert.deepEqual(next.agents[0].delegation, { enabled: false, maxChildren: 2, allowedAgentIds: [] });
  assert.deepEqual(next.agents[1].delegation, { enabled: true, maxChildren: 3, allowedAgentIds: ["documenter"] });
  assert.deepEqual(next.projects, before.projects);
  assert.equal(next.activeFlowId, before.activeFlowId);
});

test("Deleting a graph junction preserves all predecessor dependencies and deduplicates bypass edges", () => {
  const state = settings();
  state.flows[0] = flowSchema.parse({ ...state.flows[0], workflow: ["planner", "reviewer", "coder", "backend", "documenter"], edges: [
    { from: "planner", to: "coder" }, { from: "reviewer", to: "coder" },
    { from: "coder", to: "backend" }, { from: "coder", to: "documenter" },
    { from: "planner", to: "backend" },
  ] });
  const next = removeAgentPreset(state, "coder");
  assert.deepEqual(next.flows[0].edges, [
    { from: "planner", to: "backend" }, { from: "planner", to: "documenter" },
    { from: "reviewer", to: "backend" }, { from: "reviewer", to: "documenter" },
  ]);
  assert.doesNotThrow(() => settingsSchema.parse(next));
});

test("Deleting unused, first, and last presets supports an empty library without restoring defaults", () => {
  let state = settings();
  state.flows[0].workflow = ["planner", "coder"];
  state.flows[0].edges = [{ from: "planner", to: "coder" }];
  const original = structuredClone(state.flows);
  state = removeAgentPreset(state, "reviewer");
  assert.deepEqual(state.flows, original);
  state = removeAgentPreset(state, "planner");
  assert.deepEqual(state.flows[0].edges, []);
  for (const id of state.agents.map(agent => agent.id)) state = removeAgentPreset(state, id);
  assert.deepEqual(state.agents, []); assert.deepEqual(state.flows[0].workflow, []);
  assert.doesNotThrow(() => settingsSchema.parse(state));
  assert.throws(() => removeAgentPreset(state, "missing"), /Agent not found/);
});

test("Preset deletion is revision guarded and leaves live and completed task snapshots intact", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "studio-agent-delete-"))), cwd = join(root, "project");
  await mkdir(cwd);
  const store = new Store(join(root, "state.sqlite"));
  let studio = new Studio(store, root, join(root, "sockets"));
  const state = settings();
  state.approvalRequired = false;
  state.agents = state.agents.filter(agent => ["coder", "documenter"].includes(agent.id)).map(agent => ({ ...agent, provider: "codex", tools: ["read"] }));
  state.agents[0].delegation = { enabled: true, maxChildren: 1, allowedAgentIds: ["documenter"] };
  state.flows = [flowSchema.parse({ id: "flow", name: "Fixture", workflow: ["coder", "documenter"] }), flowSchema.parse({ id: "other", name: "Unchanged", workflow: ["coder"] })];
  state.activeFlowId = "flow";
  state.projects = [{ id: "project", name: "Fixture", path: cwd, execution: { mode: "local", branchName: "" } }];
  store.set("settings", state);
  studio.connections.assertAgent = async () => {};
  studio.catalog.scan = async () => ({ skills: [], sources: [], errors: [] }) as any;
  let release!: () => void, holding = false, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  t.mock.method(studio as any, "codexTurn", async (_run: Run, step: Step) => {
    calls.push(step.agent.id); entered = true;
    if (holding) await gate;
    return JSON.stringify({ status: "completed", decision: "pass", summary: "Fixture completed", artifacts: [{ name: "report.md", type: "Report", content: step.agent.name }] });
  });
  t.after(async () => { release(); await studio.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const until = async (condition: () => boolean) => { for (let i = 0; i < 500; i++) { if (condition()) return; await delay(10); } assert.fail("Fixture did not reach the expected state"); };
  const start = async () => await studio.dispatch("run.start", { projectId: "project", flowId: "flow", brief: "Keep my task snapshots", commandId: crypto.randomUUID() }) as Run;
  const completed = await start(); await until(() => store.run(completed.id)?.status === "succeeded");
  await delay(20);
  const history = store.run(completed.id);
  holding = true; entered = false;
  const active = await start(); await until(() => entered);
  const live = store.run(active.id), seq = store.seq();
  await assert.rejects(studio.dispatch("agent.remove", { id: "documenter", revision: 99 }), /Settings changed in another window/);
  assert.deepEqual(studio.settings(), state);
  assert.equal(store.get("revision"), null);
  const result = await studio.dispatch("agent.remove", { id: "documenter", revision: 0 });
  assert.equal(result.revision, 1);
  assert.deepEqual(result.agents.map((agent: { id: string }) => agent.id), ["coder"]);
  assert.equal(result.flows[0].revision, 2); assert.equal(result.flows[1].revision, 1);
  assert.deepEqual(store.run(active.id), live); assert.deepEqual(store.run(completed.id), history); assert.equal(store.seq(), seq);
  assert(live!.delegatePresets?.some(agent => agent.id === "documenter"));
  release(); await until(() => store.run(active.id)?.status === "succeeded");
  assert.deepEqual(calls, ["coder", "documenter", "coder", "documenter"]);
  assert.equal(store.run(active.id)!.steps[1].agent.id, "documenter");
  await assert.rejects(studio.dispatch("agent.remove", { id: "missing", revision: 1 }), /Agent not found/);
  assert.equal(store.get("revision"), 1);

  const next = studio.settings();
  next.flows[0].rules = [{ after: "coder", review: "always", lockOutputs: false }];
  await studio.dispatch("settings.save", { state: next, revision: 1 });
  const reviewed = await start(); await until(() => store.run(reviewed.id)?.status === "waiting_review");
  const waiting = store.run(reviewed.id)!;
  await studio.dispatch("agent.remove", { id: "coder", revision: 2 });
  await studio.close(); studio = new Studio(store, root, join(root, "sockets"));
  assert.deepEqual(studio.settings().agents, []);
  const restored = store.run(reviewed.id)!;
  assert.equal(restored.status, "waiting_review"); assert.deepEqual(restored.review, waiting.review);
  assert.deepEqual(restored.artifacts, waiting.artifacts);
  assert.deepEqual(restored.steps[0].agent, waiting.steps[0].agent);
  assert.deepEqual(restored.steps[0].messages, waiting.steps[0].messages);
  await studio.dispatch("run.control", { id: restored.id, action: "approve-review", reviewId: restored.review!.id, fingerprint: restored.review!.fingerprint });
  await until(() => store.run(restored.id)?.status === "succeeded");
  assert.deepEqual(store.run(completed.id), history);
});
