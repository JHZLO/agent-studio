import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { git } from "../packages/engine/projects.ts";
import { setTimeout as delay } from "node:timers/promises";
import { initialState } from "../packages/contracts/defaults.js";
import { flowSchema, settingsSchema, type Run, type Step } from "../packages/contracts/index.ts";
import { flowEdges, flowLayers } from "../packages/contracts/flow.ts";
import { Studio } from "../packages/engine/studio.ts";
import { Store } from "../packages/engine/store.ts";

const edges = [{ from: "planner", to: "coder" }, { from: "planner", to: "reviewer" }, { from: "coder", to: "documenter" }, { from: "reviewer", to: "documenter" }];
const releases = new Set<() => void>();
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); releases.add(resolve); return { promise, resolve }; };
const output = (step: Step, decision = "pass") => JSON.stringify({ status: "completed", decision, summary: `${step.agent.name} checked`, artifacts: (step.agent.role === "planner" ? ["implementation-plan.md", "qa-sheet.md"] : [`${step.agent.role}.md`]).map(name => ({ name, type: "Report", content: step.agent.id })) });
async function until(predicate: () => boolean, description = "condition") {
  for (let i = 0; i < 1200; i++) { if (predicate()) return; await delay(10); }
  assert.fail(`Timed out waiting for ${description}`);
}
async function fixture(t: test.TestContext, extra = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "studio-graph-"))), cwd = join(root, "project");
  await mkdir(cwd); await writeFile(join(cwd, "README.md"), "Fixture");
  const store = new Store(join(root, "state.sqlite")), studio = new Studio(store, root, join(root, "sockets"));
  const settings = settingsSchema.parse({ ...initialState(), skillRoots: [], approvalRequired: false });
  settings.agents = settings.agents.filter(agent => ["planner", "coder", "reviewer", "documenter"].includes(agent.id)).map(agent => ({ ...agent, provider: "codex", tools: ["read"] }));
  settings.flows = [flowSchema.parse({ id: "flow", name: "Branches", workflow: settings.agents.map(agent => agent.id), edges, ...extra })];
  settings.activeFlowId = "flow"; settings.projects = [{ id: "project", name: "Fixture", path: cwd, execution: { mode: "local", branchName: "" } }]; store.set("settings", settings);
  studio.connections.assertAgent = async () => {}; studio.catalog.scan = async () => ({ skills: [], sources: [], errors: [] }) as any;
  const mergeCalls: Step[] = [];
  let mergeResult = async (_run: Run, step: Step, toolbox: any) => { await toolbox.call("studio_read", { path: "README.md" }); return output(step); };
  const calls: { id: string; prompt: string; step: Step }[] = [];
  let result = async (_run: Run, step: Step, _tools: any) => output(step);
  t.mock.method(studio as any, "codexTurn", async (run: Run, step: Step, prompt: string, toolbox: any) => { if (step.purpose === "merge") { mergeCalls.push(step); return mergeResult(run, step, toolbox); } calls.push({ id: step.agent.id, prompt, step }); step.providerThreadId ??= `thread-${step.id}`; return result(run, step, toolbox); });
  t.after(async () => { for (const release of releases) release(); await studio.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { store, studio, calls, cwd, mergeCalls, mergeResult(fn: typeof mergeResult) { mergeResult = fn; }, result(fn: typeof result) { result = fn; },
    async start() { return await studio.dispatch("run.start", { projectId: "project", flowId: "flow", brief: "Check the branches", commandId: "start" }) as Run; },
    async wait(id: string, status: string) { await until(() => store.run(id)?.status === status, `${status}: ${store.run(id)?.note}`); await delay(10); return store.run(id)!; },
    async review(run: Run, action = "approve-review") { return await studio.dispatch("run.control", { id: run.id, action, reviewId: run.review!.id, fingerprint: run.review!.fingerprint, feedback: "Recheck this branch" }) as Run; },
  };
}

test("Flow connections validate cycles, references and upstream revision targets", () => {
  const base = { id: "flow", name: "Flow", workflow: ["planner", "coder", "reviewer", "documenter"], edges };
  assert.deepEqual(flowLayers(base), [["planner"], ["coder", "reviewer"], ["documenter"]]);
  assert.deepEqual(flowEdges({ workflow: ["a", "b", "c"] }), [{ from: "a", to: "b" }, { from: "b", to: "c" }]);
  assert.equal(flowSchema.parse({ ...base, edges: undefined }).edges, undefined);
  for (const invalid of [ [...edges, edges[0]], [...edges, { from: "coder", to: "planner" }], [{ from: "missing", to: "coder" }], [{ from: "coder", to: "coder" }] ]) assert.throws(() => flowSchema.parse({ ...base, edges: invalid }));
  assert.throws(() => flowSchema.parse({ ...base, rules: [{ after: "reviewer", returnTo: "coder" }] }));
  assert.doesNotThrow(() => flowSchema.parse({ ...base, workflow: [...base.workflow].reverse(), rules: [{ after: "documenter", loop: { target: "planner", maxCycles: 2, onLimit: "review" } }] }));
});

test("Fan-out runs independent readers concurrently and the join waits for both", async t => {
  const f = await fixture(t), coder = gate(), reviewer = gate();
  f.result(async (_run, step) => { if (step.agent.id === "coder") await coder.promise; if (step.agent.id === "reviewer") await reviewer.promise; return output(step); });
  const run = await f.start(); await until(() => f.calls.length === 3);
  assert.equal(f.calls[0].id, "planner"); assert.deepEqual(f.calls.slice(1).map(call => call.id).sort(), ["coder", "reviewer"]);
  coder.resolve(); await until(() => f.store.run(run.id)!.steps[1].status === "succeeded");
  assert.equal(f.calls.length, 3); reviewer.resolve();
  const done = await f.wait(run.id, "succeeded"); assert(done.steps[3].receivedArtifacts.some(item => item.name === "reviewer.md")); assert(done.steps[3].receivedArtifacts.some(item => item.name === "coder.md")); assert.equal(done.merge?.status, "agreed");
  assert.equal(done.steps[1].receivedArtifacts.length, 2); assert.equal(done.steps[2].receivedArtifacts.length, 2);
  const rightPrompt = f.calls.find(call => call.id === "reviewer")!.prompt;
  assert(!rightPrompt.includes("coder.md")); assert(f.calls[3].prompt.includes("coder.md")); assert(f.calls[3].prompt.includes("reviewer.md"));
});

test("Parallel limits hold while writable branches use independent folders", async t => {
  for (const writes of [false, true]) {
    const f = await fixture(t, { maxParallel: writes ? 4 : 1 }), hold = gate();
    if (writes) { const settings = f.studio.settings(); for (const agent of settings.agents.slice(1, 3)) { agent.tools.push("write"); agent.permissionLevel = "project"; } f.store.set("settings", settings); }
    f.result(async (_run, step) => {
      if (writes && ["coder", "reviewer"].includes(step.agent.id)) await writeFile(join(step.workspace!, `${step.agent.id}.txt`), step.agent.id);
      if (step.agent.id === "coder") await hold.promise;
      return output(step);
    });
    const run = await f.start(); await until(() => f.calls.some(call => call.id === "coder")); await delay(50);
    if (writes) { await until(() => f.calls.length === 3); assert.notEqual(f.calls[1].step.workspace, f.calls[2].step.workspace); }
    else assert.deepEqual(f.calls.map(call => call.id), ["planner", "coder"]);
    hold.resolve(); await f.wait(run.id, "succeeded");
    if (writes) { assert.equal(await readFile(join(f.cwd, "coder.txt"), "utf8"), "coder"); assert.equal(await readFile(join(f.cwd, "reviewer.txt"), "utf8"), "reviewer"); }
  }
});

test("Plan locking holds both branches and parallel checkpoints queue without being lost", async t => {
  const f = await fixture(t, { rules: [{ after: "planner", review: "always", lockOutputs: true }, { after: "coder", review: "always" }, { after: "reviewer", review: "always" }] });
  const run = await f.start(), plan = await f.wait(run.id, "waiting_review"); assert.equal(f.calls.length, 1);
  await f.review(plan); let checkpoint = await f.wait(run.id, "waiting_review");
  assert.equal(f.calls.length, 3); assert.equal(checkpoint.pendingReviews?.length, 1); assert.equal(checkpoint.lockedPlan?.version, 1);
  await f.review(checkpoint); checkpoint = await f.wait(run.id, "waiting_review"); assert.equal(f.calls.length, 3);
  await f.review(checkpoint); await f.wait(run.id, "succeeded"); assert.equal(f.calls.length, 4);
});

test("A branch revision reruns its descendants and preserves the independent sibling", async t => {
  const f = await fixture(t, { rules: [{ after: "coder", review: "always", returnTo: "coder" }] });
  const run = await f.start(), check = await f.wait(run.id, "waiting_review"), siblingId = check.steps[2].id;
  await f.review(check, "request-revision"); const revised = await f.wait(run.id, "waiting_review");
  assert.equal(revised.steps[1].attempt, 2); assert.equal(revised.steps[2].id, siblingId);
  assert.equal(f.calls.filter(call => call.id === "reviewer").length, 1);
  assert(revised.artifacts.some(artifact => artifact.name === "coder.md" && artifact.superseded));
  await f.review(revised); await f.wait(run.id, "succeeded");
});

test("Live instructions and interrupts belong only to their selected branch", async t => {
  const f = await fixture(t), left = gate(), right = gate();
  const interrupted: string[] = [];
  t.mock.method(f.studio as any, "interruptProvider", async (_run: Run, step: Step) => { interrupted.push(step.agent.id); left.resolve(); });
  f.result(async (_run, step) => { if (step.agent.id === "coder" && !step.activeMessage) await left.promise; if (step.agent.id === "reviewer") await right.promise; return output(step); });
  const run = await f.start(); await until(() => f.calls.length === 3);
  const active = f.store.run(run.id)!;
  await f.studio.dispatch("run.message", { id: run.id, stepId: active.steps[2].id, message: "Check the index", mode: "queue" });
  await f.studio.dispatch("run.message", { id: run.id, stepId: active.steps[1].id, message: "Prioritize duplicates", mode: "interrupt" });
  await until(() => f.calls.filter(call => call.id === "coder").length === 2);
  assert.deepEqual(interrupted, ["coder"]); assert.equal(f.calls.filter(call => call.id === "reviewer").length, 1);
  assert.equal(f.store.run(run.id)!.pendingMessages?.length, 1);
  right.resolve(); const done = await f.wait(run.id, "succeeded");
  assert(f.calls.filter(call => call.id === "coder").at(-1)!.prompt.includes("Prioritize duplicates"));
  assert(f.calls.filter(call => call.id === "reviewer").at(-1)!.prompt.includes("Check the index"));
  assert.equal(done.pendingMessages?.length, 0); assert.equal(done.steps[1].activeMessage, undefined);
});

test("Parallel permission requests retain exact approval identities", async t => {
  const f = await fixture(t); let runtime!: Run;
  f.result(async (run, step) => {
    runtime = run;
    if (["coder", "reviewer"].includes(step.agent.id)) assert(await (f.studio as any).awaitApproval(run, step, "network", step.agent.name, "fixture"));
    return output(step);
  });
  const run = await f.start(); await until(() => f.store.run(run.id)!.approvals?.length === 2);
  const approvals = f.store.run(run.id)!.approvals!;
  await f.studio.dispatch("run.control", { id: run.id, action: "approve", approvalId: approvals[1].id });
  await until(() => runtime.approvals?.length === 1); assert.equal(runtime.approval?.id, approvals[0].id);
  assert.equal(f.calls.length, 3);
  await f.studio.dispatch("run.control", { id: run.id, action: "approve", approvalId: approvals[0].id }); await f.wait(run.id, "succeeded");
});

test("A failed branch cannot release a join or start another branch", async t => {
  const f = await fixture(t);
  f.result(async (_run, step) => { if (step.agent.id === "coder") throw new Error("Fixture failure"); return output(step); });
  const run = await f.start(), failed = await f.wait(run.id, "failed");
  assert.equal(failed.steps[1].status, "failed"); assert.equal(failed.note, "Fixture failure"); assert(!f.calls.some(call => call.id === "documenter"));
});

test("Conflicting edits are resolved and every contributor agrees on the same merged files", async t => {
  const f = await fixture(t), settings = f.studio.settings();
  for (const agent of settings.agents.slice(1, 3)) { agent.tools.push("write"); agent.permissionLevel = "project"; }
  f.store.set("settings", settings);
  f.result(async (_run, step) => { if (["coder", "reviewer"].includes(step.agent.id)) await writeFile(join(step.workspace!, "README.md"), step.agent.id + "\n"); return output(step); });
  let resolutions = 0;
  f.mergeResult(async (run, step, toolbox) => {
    await toolbox.call("studio_read", { path: "README.md" });
    assert.equal(await readFile(join(f.cwd, "README.md"), "utf8"), "Fixture");
    if (run.merge?.status === "resolving") { resolutions++; assert((await toolbox.call("studio_write", { path: "README.md", content: "coder and reviewer\n" })).success); }
    return output(step);
  });
  const run = await f.start(), done = await f.wait(run.id, "succeeded");
  assert.equal(resolutions, 1); assert.equal(done.merge?.votes.length, 2); assert(done.merge?.votes.every(vote => vote.decision === "pass"));
  assert.equal(await readFile(join(f.cwd, "README.md"), "utf8"), "coder and reviewer\n");
  assert.equal(done.merge?.sessions.length, 3);
});

test("Disagreement returns to the resolver and never publishes without unanimous approval", async t => {
  const f = await fixture(t), settings = f.studio.settings(); settings.agents[1].tools.push("write"); settings.agents[1].permissionLevel = "project"; f.store.set("settings", settings);
  let resolutions = 0;
  f.mergeResult(async (run, step, toolbox) => { await toolbox.call("studio_read", { path: "README.md" }); if (run.merge?.status === "resolving") resolutions++; return output(step, "revise"); });
  const run = await f.start(), waiting = await f.wait(run.id, "waiting_review");
  assert.equal(waiting.merge?.status, "blocked"); assert.equal(waiting.merge?.round, 3); assert.equal(resolutions, 2);
  assert.equal(waiting.steps[3].status, "queued"); assert.equal(waiting.review?.returnTo, "coder"); assert.equal(await readFile(join(f.cwd, "README.md"), "utf8"), "Fixture");
  assert(!f.calls.some(call => call.id === "documenter"));
});

test("External edits to the original project prevent publication of branch results", async t => {
  const f = await fixture(t);
  f.result(async (_run, step) => { if (step.agent.id === "documenter") await writeFile(join(f.cwd, "README.md"), "External edit"); return output(step); });
  const run = await f.start(), held = await f.wait(run.id, "needs_reconciliation");
  assert.match(held.note, /original project changed/); assert.equal(await readFile(join(f.cwd, "README.md"), "utf8"), "External edit");
});

test("A three-way join resolves each conflicting predecessor before collecting all votes", async t => {
  const f = await fixture(t), settings = f.studio.settings(), extra = { ...settings.agents[1], id: "second-coder", name: "Second coder" };
  settings.agents.push(extra); settings.flows[0].workflow.push(extra.id);
  settings.flows[0].edges!.push({ from: "planner", to: extra.id }, { from: extra.id, to: "documenter" });
  for (const agent of settings.agents) if (["coder", "reviewer", extra.id].includes(agent.id)) { agent.tools = ["read", "write"]; agent.permissionLevel = "project"; }
  f.store.set("settings", settings);
  f.result(async (_run, step) => { if (["coder", "reviewer", extra.id].includes(step.agent.id)) await writeFile(join(step.workspace!, "README.md"), step.agent.id + "\n"); return output(step); });
  f.mergeResult(async (run, step, toolbox) => {
    await toolbox.call("studio_read", { path: "README.md" });
    if (run.merge?.status === "resolving") assert((await toolbox.call("studio_write", { path: "README.md", content: "All three changes\n" })).success);
    return output(step);
  });
  const run = await f.start(), done = await f.wait(run.id, "succeeded");
  assert.equal(done.merge?.votes.length, 3); assert.equal(await readFile(join(f.cwd, "README.md"), "utf8"), "All three changes\n");
});

test("Unconnected terminal branches still require a final merge agreement", async t => {
  const f = await fixture(t, { edges: [{ from: "planner", to: "coder" }, { from: "planner", to: "reviewer" }, { from: "planner", to: "documenter" }] });
  const run = await f.start(), done = await f.wait(run.id, "succeeded"); assert.equal(done.merge?.votes.length, 3); assert.equal(done.merge?.status, "agreed");
});

test("Parallel revision findings share one return and all reach the next implementation", async t => {
  const f = await fixture(t, { edges: [{ from: "planner", to: "coder" }, { from: "coder", to: "reviewer" }, { from: "coder", to: "documenter" }], rules: ["reviewer", "documenter"].map(after => ({ after, loop: { target: "coder", maxCycles: 1, onLimit: "review" } })) });
  f.result(async (_run, step) => output(step, ["reviewer", "documenter"].includes(step.agent.id) && !step.attempt ? "revise" : "pass"));
  const run = await f.start(), done = await f.wait(run.id, "succeeded");
  assert.equal(done.loopCounts?.["shared:coder"], 1); assert.equal(f.calls.filter(call => call.id === "coder").length, 2);
  const prompt = f.calls.filter(call => call.id === "coder").at(-1)!.prompt; assert(prompt.includes("Reviewer checked")); assert(prompt.includes("Documenter checked"));
});

test("A parallel scope change takes precedence over an automatic implementation revision", async t => {
  const f = await fixture(t, { edges: [{ from: "planner", to: "coder" }, { from: "coder", to: "reviewer" }, { from: "coder", to: "documenter" }], rules: [{ after: "reviewer", loop: { target: "coder", maxCycles: 2, onLimit: "review" } }] });
  f.result(async (_run, step) => output(step, step.agent.id === "documenter" ? "scope_change" : step.agent.id === "reviewer" ? "revise" : "pass"));
  const run = await f.start(), waiting = await f.wait(run.id, "waiting_review");
  assert.equal(waiting.review?.kind, "scope_change"); assert.equal(waiting.review?.returnTo, "planner"); assert.equal(f.calls.filter(call => call.id === "coder").length, 1);
  assert.equal(waiting.loopCounts?.reviewer, undefined);
});

test("Delegated changes stay in their graph branch and require combined verification before joining", async t => {
  const f = await fixture(t), settings = f.studio.settings(), coder = settings.agents[1];
  coder.tools = ["read", "write", "shell"]; coder.permissionLevel = "bypass"; coder.delegation = { enabled: true, maxChildren: 1, allowedAgentIds: ["worker"] };
  settings.agents.push({ ...coder, id: "worker", name: "Worker", delegation: undefined }); f.store.set("settings", settings);
  let parentCalls = 0;
  f.result(async (run, step, toolbox) => {
    if (run.parent) { assert((await toolbox.call("studio_write", { path: "delegated.txt", content: "Verified child\n" })).success); return output(step); }
    if (step.agent.id === "coder") {
      parentCalls++;
      if (parentCalls === 1) {
        const child = await toolbox.call("studio_delegate", { agentId: "worker", task: "Write delegated.txt", mode: "write" }); assert(child.success);
        await toolbox.call("studio_delegations", { wait: true });
        const collected = await toolbox.call("studio_collect", { id: child.result.id, action: "accept", reason: "Inspect the child diff" }); assert(collected.success, JSON.stringify(collected));
        assert.equal(await readFile(join(f.cwd, "delegated.txt"), "utf8").catch(() => "absent"), "absent");
      } else assert((await toolbox.call("studio_shell", { command: "test -f delegated.txt", timeoutSeconds: 5, background: false })).success);
    }
    return output(step);
  });
  const run = await f.start(), done = await f.wait(run.id, "succeeded");
  assert.equal(parentCalls, 2); assert.equal(done.merge?.status, "agreed"); assert.equal(await readFile(join(f.cwd, "delegated.txt"), "utf8"), "Verified child\n");
});

test("Git project roots and selected subfolders preserve dirty files, index state and patch whitespace", async t => {
  for (const nested of [false, true]) {
    const f = await fixture(t), repository = nested ? f.studio.dataDir : f.cwd;
    await git(repository, ["init", "--quiet"], true);
    await git(repository, ["add", "--", relative(repository, join(f.cwd, "README.md"))], true);
    await git(repository, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "Fixture"], true);
    const head = await git(repository, ["rev-parse", "HEAD"]);
    await writeFile(join(f.cwd, "README.md"), "Existing user edit\n"); await writeFile(join(f.cwd, "keep.txt"), "Untracked user file\n");
    f.result(async (_run, step) => { if (step.agent.id === "coder") await writeFile(join(step.workspace!, "output.txt"), "line\n    \n"); return output(step); });
    const run = await f.start(); await f.wait(run.id, "succeeded");
    assert.equal(await readFile(join(f.cwd, "README.md"), "utf8"), "Existing user edit\n");
    assert.equal(await readFile(join(f.cwd, "keep.txt"), "utf8"), "Untracked user file\n");
    assert.equal(await readFile(join(f.cwd, "output.txt"), "utf8"), "line\n    \n");
    assert.equal(await git(repository, ["rev-parse", "HEAD"]), head); assert.equal(await git(repository, ["diff", "--cached", "--name-only"]), "");
  }
});
