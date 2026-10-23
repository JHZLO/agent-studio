import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { initialState } from "../packages/contracts/defaults.js";
import { flowSchema, settingsSchema, type Run, type Step } from "../packages/contracts/index.ts";
import { Studio } from "../packages/engine/studio.ts";
import { Store } from "../packages/engine/store.ts";

const rules = [
  { after: "planner", review: "always", lockOutputs: true, returnTo: "planner" },
  { after: "reviewer", review: "auto", lockOutputs: false, loop: { target: "coder", maxCycles: 2, onLimit: "review" } },
];
function output(step: Step, decision = "pass", status = "completed") {
  const names = step.agent.role === "planner" ? ["implementation-plan.md", "qa-sheet.md"] : [`${step.agent.role}.md`];
  return JSON.stringify({ summary: `${step.agent.name}: ${decision}`, status, decision, artifacts: names.map(name => ({ name, type: "Report", content: `${name} attempt ${step.attempt || 1}` })) });
}
async function fixture(t: test.TestContext, customRules: unknown[] = rules) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "studio-flow-"))), cwd = join(root, "project");
  await mkdir(cwd); await writeFile(join(cwd, "README.md"), "Original");
  const store = new Store(join(root, "state.sqlite"));
  let studio = new Studio(store, root, join(root, "sockets"));
  const state = settingsSchema.parse({ ...initialState(), skillRoots: [], approvalRequired: false });
  state.agents = state.agents.slice(0, 3).map(a => ({ ...a, provider: "codex", tools: ["read"] }));
  state.flows = [flowSchema.parse({ id: "flow", name: "Fixture", workflow: state.agents.map(a => a.id), rules: customRules })];
  state.activeFlowId = "flow";
  state.projects = [{ id: "project", name: "Fixture", path: cwd, execution: { mode: "local", branchName: "" } }];
  store.set("settings", state);
  const calls: { step: Step; prompt: string }[] = [];
  let result = (step: Step) => output(step);
  const install = () => {
    studio.connections.assertAgent = async () => {};
    studio.catalog.scan = async () => ({ skills: [], sources: [], errors: [] }) as any;
    t.mock.method(studio as any, "codexTurn", async (_run: Run, step: Step, prompt: string) => { calls.push({ step: structuredClone(step), prompt }); return result(step); });
  };
  install();
  t.after(async () => { await studio.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return {
    root, cwd, store, calls, get studio() { return studio; }, result(fn: typeof result) { result = fn; },
    async start() { return await studio.dispatch("run.start", { projectId: "project", flowId: "flow", brief: "Test flow rules", commandId: "start" }) as Run; },
    async restart() { await studio.close(); studio = new Studio(store, root, join(root, "sockets")); install(); },
    async wait(id: string, status: string) {
      for (let i = 0; i < 600; i++) {
        const run = store.run(id)!;
        if (run.status === status) { await delay(15); return store.run(id)!; }
        if (run.status === "failed" && status !== "failed") assert.fail(run.note);
        await delay(10);
      }
      assert.fail(`Expected ${status}; got ${store.run(id)?.status}: ${store.run(id)?.note}`);
    },
    async review(run: Run, action = "approve-review", feedback = "") {
      return await studio.dispatch("run.control", { id: run.id, action, reviewId: run.review!.id, fingerprint: run.review!.fingerprint, feedback }) as Run;
    },
  };
}

test("Flow rules reject invalid targets, overlapping loops and unreviewed locks", () => {
  const base = { id: "flow", name: "Flow", workflow: ["a", "b", "c", "d"] };
  assert.deepEqual(flowSchema.parse(base).rules, []);
  for (const rules of [
    [{ after: "missing", review: "always" }],
    [{ after: "a", returnTo: "b" }],
    [{ after: "b", loop: { target: "b", maxCycles: 3, onLimit: "review" } }],
    [{ after: "b", loop: { target: "a", maxCycles: 0, onLimit: "review" } }],
    [{ after: "b", lockOutputs: true }],
    [{ after: "a" }, { after: "a" }],
    [{ after: "c", loop: { target: "a", maxCycles: 3, onLimit: "review" } }, { after: "d", loop: { target: "b", maxCycles: 3, onLimit: "review" } }],
  ]) assert.equal(flowSchema.safeParse({ ...base, rules }).success, false);
});

test("Plan review survives restart, freezes flow rules, and can lock without starting coding", async t => {
  const f = await fixture(t), started = await f.start();
  const waiting = await f.wait(started.id, "waiting_review");
  assert.deepEqual(f.calls.map(call => call.step.agent.id), ["planner"]);
  const edited = f.studio.settings(); edited.flows[0].rules = [];
  await f.studio.dispatch("settings.save", { state: edited, revision: 0 });
  assert.equal(f.studio.settings().flows[0].revision, 2);
  assert.equal(f.store.run(started.id)!.flow.revision, 1);
  assert.equal(f.store.run(started.id)!.flow.rules.length, 2);
  await f.restart();
  const restored = f.store.run(started.id)!;
  assert.equal(restored.status, "waiting_review"); assert.equal(restored.review!.id, waiting.review!.id);
  await assert.rejects(f.studio.dispatch("run.control", { id: started.id, action: "resume" }), /Only a paused/);
  await f.review(restored, "approve-review-only");
  assert.equal(f.store.run(started.id)!.status, "paused"); assert.equal(f.calls.length, 1);
  assert.equal(f.store.run(started.id)!.lockedPlan?.artifactIds.length, 2);
  await f.restart(); assert.equal(f.store.run(started.id)!.status, "paused");
  await f.studio.dispatch("run.control", { id: started.id, action: "resume" });
  const done = await f.wait(started.id, "succeeded");
  assert.equal(done.lockedPlan?.version, 1);
  assert.match(f.calls[1].prompt, /Approved plan version: 1/);
});

test("Revision requests retain draft evidence and reject stale or duplicate approvals", async t => {
  const f = await fixture(t), started = await f.start(), waiting = await f.wait(started.id, "waiting_review");
  await assert.rejects(f.review(waiting, "request-revision", " "));
  await f.review(waiting, "request-revision", "Add duplicate input checks");
  const revised = await f.wait(started.id, "waiting_review");
  assert.notEqual(revised.review!.id, waiting.review!.id);
  assert.equal(revised.steps[0].attempt, 2); assert.equal(revised.stepHistory?.length, 1);
  assert.equal(revised.artifacts.filter(a => a.superseded).length, 2);
  assert.match(f.calls[1].prompt, /Add duplicate input checks/);
  assert.match(f.calls[1].prompt, /previous attempt, revision feedback/);
  await assert.rejects(f.review(waiting), /changed or was already resolved/);
  const resolutions = await Promise.allSettled([f.review(revised), f.review(revised)]);
  assert.equal(resolutions.filter(r => r.status === "fulfilled").length, 1);
  await f.wait(started.id, "succeeded");
  assert.equal(f.calls.filter(c => c.step.agent.id === "coder").length, 1);
});

test("Loops rerun the full interval in fresh sessions and stop at their saved bound", async t => {
  const f = await fixture(t);
  f.result(step => output(step, step.agent.role === "reviewer" ? "revise" : "pass"));
  const started = await f.start(); await f.review(await f.wait(started.id, "waiting_review"));
  const limit = await f.wait(started.id, "waiting_review");
  assert.equal(limit.review?.kind, "loop_limit"); assert.equal(limit.loopCounts?.reviewer, 2);
  assert.equal(f.calls.filter(c => c.step.agent.role === "coder").length, 3);
  assert.equal(new Set(f.calls.map(c => c.step.sessionId)).size, f.calls.length);
  assert.equal(limit.stepHistory?.length, 4); assert.equal(limit.lockedPlan?.version, 1);
  await assert.rejects(f.review(limit), /cannot advance/);
  f.result(step => output(step));
  await f.review(limit, "request-revision", "Fix the remaining edge case");
  const done = await f.wait(started.id, "succeeded");
  assert.equal(done.loopCounts?.reviewer, 2);
  assert.equal(f.calls.filter(c => c.step.agent.role === "reviewer").length, 4);
  const latestCoder = f.calls.filter(c => c.step.agent.role === "coder").at(-1)!;
  assert.match(latestCoder.prompt, /Fix the remaining edge case/);
});

test("A configured stop at the loop limit never completes the task", async t => {
  const f = await fixture(t, [{ after: "reviewer", loop: { target: "coder", maxCycles: 1, onLimit: "stop" } }]);
  f.result(step => output(step, step.agent.role === "reviewer" ? "revise" : "pass"));
  const started = await f.start(), failed = await f.wait(started.id, "failed");
  assert.match(failed.note, /limit reached/); assert.equal(failed.loopCounts?.reviewer, 1);
  assert.equal(f.calls.length, 5);
});

test("Execution errors and missing decisions never trigger an automatic revision", async t => {
  for (const missingDecision of [false, true]) {
    const f = await fixture(t, [{ after: "reviewer", loop: { target: "coder", maxCycles: 2, onLimit: "review" } }]);
    f.result(step => {
      const result = JSON.parse(output(step, "pass", step.agent.role === "reviewer" && !missingDecision ? "blocked" : "completed"));
      if (missingDecision) delete result.decision;
      return JSON.stringify(result);
    });
    const started = await f.start(), failed = await f.wait(started.id, "failed");
    assert.equal(failed.loopCounts?.reviewer, undefined); assert.equal(f.calls.length, 3);
    assert.equal(failed.steps[2].status, "failed");
  }
});

test("Scope changes return to planning and invalidate downstream evidence", async t => {
  const f = await fixture(t);
  f.result(step => output(step, step.agent.role === "coder" ? "scope_change" : "pass"));
  const started = await f.start(); await f.review(await f.wait(started.id, "waiting_review"));
  const change = await f.wait(started.id, "waiting_review");
  assert.equal(change.review?.kind, "scope_change"); assert.equal(change.review?.returnTo, "planner");
  await assert.rejects(f.review(change), /cannot advance/);
  f.result(step => output(step));
  await f.review(change, "request-revision", "Revise the scope and acceptance criteria");
  const planning = await f.wait(started.id, "waiting_review");
  assert.equal(planning.steps[0].attempt, 2); assert.equal(planning.lockedPlan, undefined);
  assert.equal(planning.steps[1].status, "queued"); assert.equal(planning.review?.version, 2);
  await f.review(planning); const done = await f.wait(started.id, "succeeded");
  assert.equal(done.lockedPlan?.version, 2);
});

test("Approving an outdated project fingerprint requires a fresh revision", async t => {
  const f = await fixture(t), started = await f.start(), waiting = await f.wait(started.id, "waiting_review");
  await writeFile(join(f.cwd, "README.md"), "Externally changed");
  await assert.rejects(f.review(waiting), /Project files changed/);
  assert.equal(f.store.run(started.id)!.status, "waiting_review"); assert.equal(f.calls.length, 1);
  await f.review(waiting, "request-revision", "Recheck the changed files");
  const revised = await f.wait(started.id, "waiting_review");
  await f.review(revised); await f.wait(started.id, "succeeded");
});

test("Conditional reviews allow passing checks and hold revisions for a human", async t => {
  const f = await fixture(t, [{ after: "reviewer", review: "on_issue", returnTo: "coder" }]);
  f.result(step => output(step, step.agent.role === "reviewer" ? "revise" : "pass"));
  const started = await f.start(), waiting = await f.wait(started.id, "waiting_review");
  assert.equal(waiting.review?.kind, "issue");
  f.result(step => output(step));
  await f.review(waiting, "request-revision", "Fix the review finding");
  await f.wait(started.id, "succeeded");
});

test("Recovery cannot bypass a saved checkpoint at either a handoff or the final step", async t => {
  for (const after of ["planner", "reviewer"]) {
    const f = await fixture(t, [{ after, review: "always" }]);
    const started = await f.start(), waiting = await f.wait(started.id, "waiting_review");
    const active = (f.studio as any).active as Run, calls = f.calls.length;
    active.status = "needs_reconciliation"; f.store.saveRun(active, "provider.disconnected");
    const restored = await f.studio.dispatch("run.reconcile", { id: started.id }) as Run;
    assert.equal(restored.status, "waiting_review");
    assert.equal(restored.review?.id, waiting.review?.id);
    assert.equal(f.calls.length, calls);
    active.status = "paused";
    await assert.rejects(f.studio.dispatch("run.control", { id: started.id, action: "resume" }), /pending review/);
    active.status = "waiting_review";
    await f.review(restored); await f.wait(started.id, "succeeded");
  }
});

test("Human approval leaves tool permissions intact and cancellation rejects later review actions", async t => {
  const f = await fixture(t), settings = f.studio.settings();
  settings.approvalRequired = true; settings.agents[1].tools = ["read", "write"];
  f.store.set("settings", settings);
  const started = await f.start(), review = await f.wait(started.id, "waiting_review");
  assert.equal(review.approved, false);
  await f.review(review);
  const writeApproval = await f.wait(started.id, "waiting_approval");
  assert.equal(writeApproval.approval?.kind, "write");
  assert.equal(f.calls.length, 1);
  await f.studio.dispatch("run.control", { id: started.id, action: "cancel" });
  await assert.rejects(f.review(review), /no longer active/);
  assert.equal(f.store.run(started.id)!.status, "cancelled");
});
