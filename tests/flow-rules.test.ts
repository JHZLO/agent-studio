import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { initialState } from "../packages/contracts/defaults.js";
import { flowSchema, revisionGroups, settingsSchema, type Run, type Step } from "../packages/contracts/index.ts";
import { Studio } from "../packages/engine/studio.ts";
import type { Toolbox } from "../packages/engine/tools.ts";
import { Store } from "../packages/engine/store.ts";

const rules = [
  { after: "planner", review: "always", lockOutputs: true, returnTo: "planner" },
  { after: "reviewer", review: "auto", lockOutputs: false, loop: { target: "coder", maxCycles: 2, onLimit: "review" } },
];
function output(step: Step, decision = "pass", status = "completed") {
  const names = step.agent.role === "planner" ? ["implementation-plan.md", "qa-sheet.md"] : [`${step.agent.role}.md`];
  return JSON.stringify({ summary: `${step.agent.name}: ${decision}`, status, decision, artifacts: names.map(name => ({ name, type: "Report", content: `${name} attempt ${step.attempt || 1}` })) });
}
async function fixture(t: test.TestContext, customRules: unknown[] = rules, withTester = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "studio-flow-"))), cwd = join(root, "project");
  await mkdir(cwd); await writeFile(join(cwd, "README.md"), "Original");
  const store = new Store(join(root, "state.sqlite"));
  let studio = new Studio(store, root, join(root, "sockets"));
  const state = settingsSchema.parse({ ...initialState(), skillRoots: [], approvalRequired: false });
  state.agents = state.agents.slice(0, 3).map(a => ({ ...a, provider: "codex", tools: ["read"] }));
  if (withTester) state.agents.push({ ...state.agents[2], id: "tester", name: "Tester", role: "backend", tools: ["read", "shell"] });
  state.flows = [flowSchema.parse({ id: "flow", name: "Fixture", workflow: state.agents.map(a => a.id), rules: customRules })];
  state.activeFlowId = "flow";
  state.projects = [{ id: "project", name: "Fixture", path: cwd, execution: { mode: "local", branchName: "" } }];
  store.set("settings", state);
  const calls: { step: Step; prompt: string }[] = [];
  let result: (step: Step) => string | Promise<string> = step => output(step);
  const server = createServer((_req, res) => { res.end("Fixture test evidence"); });
  if (withTester) await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const install = () => {
    studio.connections.assertAgent = async () => {};
    studio.catalog.scan = async () => ({ skills: [], sources: [], errors: [] }) as any;
    t.mock.method(studio as any, "codexTurn", async (_run: Run, step: Step, prompt: string, tools: Toolbox) => {
      step.providerThreadId ??= `provider-${step.id}`;
      calls.push({ step: structuredClone(step), prompt });
      if (step.agent.role === "backend") await tools.call("studio_http", { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, method: "GET", body: "", headers: {} });
      return result(step);
    });
  };
  install();
  t.after(async () => { if (withTester) await new Promise<void>(resolve => server.close(() => resolve())); await studio.close(); store.close(); await rm(root, { recursive: true, force: true }); });
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
    async message(run: Run, message: string) {
      await studio.dispatch("run.message", { id: run.id, stepId: run.steps[0].id, message });
      for (let i = 0; i < 600; i++) {
        if (!(studio as any).driving.has(run.id)) return store.run(run.id)!;
        await delay(10);
      }
      assert.fail("Planner follow-up did not finish");
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

test("Planner chat revisions replace the pending lock and hand off only the latest plan", async t => {
  const f = await fixture(t), started = await f.start(), first = await f.wait(started.id, "waiting_review");
  const originalIds = first.review!.artifactIds;
  const revision = (label: string) => JSON.stringify({ summary: label, status: "completed", decision: "pass", artifacts: ["implementation-plan.md", "qa-sheet.md"].map(name => ({ name, type: "Report", content: `${name}: ${label}` })) });
  f.result(() => revision("Redis draft"));
  const second = await f.message(first, "Replace synchronous database locking with Redis and update the QA sheet.");
  assert.equal(second.status, "waiting_review"); assert.equal(second.lockedPlan, undefined);
  assert.equal(second.steps[1].status, "queued"); assert.equal(second.index, first.index);
  assert.notEqual(second.review!.id, first.review!.id); assert.notEqual(second.review!.fingerprint, first.review!.fingerprint);
  assert.equal(second.review!.version, 2); assert.equal(second.review!.summary, "Redis draft");
  assert.equal(second.note, "Redis draft"); assert.equal(second.steps[0].finalText, revision("Redis draft"));
  assert.ok(originalIds.every(id => second.artifacts.find(a => a.id === id)?.superseded));
  assert.ok(second.review!.artifactIds.every(id => !originalIds.includes(id)));
  await assert.rejects(f.review(first), /changed or was already resolved/);

  f.result(() => JSON.stringify({ summary: "Choose the infrastructure before approval.", status: "completed", decision: "pass", artifacts: [] }));
  const explained = await f.message(second, "Explain the remaining decisions.");
  assert.deepEqual(explained.review, second.review); assert.equal(explained.steps[0].finalText, second.steps[0].finalText);
  f.result(() => revision("Final Redis draft"));
  const third = await f.message(explained, "Include the agreed API contract in both documents.");
  assert.equal(third.review!.version, 3); assert.equal(third.review!.summary, "Final Redis draft");
  await assert.rejects(f.review(second), /changed or was already resolved/);
  assert.ok(f.calls.every(call => call.step.agent.role === "planner"));

  await f.restart();
  const restored = f.store.run(started.id)!;
  assert.deepEqual(restored.review, third.review);
  await f.review(restored, "approve-review-only");
  assert.deepEqual(f.store.run(started.id)!.lockedPlan, { version: 3, stepId: third.steps[0].id, artifactIds: third.review!.artifactIds });
  f.result(step => output(step));
  await f.studio.dispatch("run.control", { id: started.id, action: "resume" });
  const done = await f.wait(started.id, "succeeded"), coder = f.calls.find(call => call.step.agent.role === "coder")!;
  assert.deepEqual(coder.step.receivedArtifacts.map(a => a.id), third.review!.artifactIds);
  assert.match(coder.prompt, /Approved plan version: 3/); assert.match(coder.prompt, /Final Redis draft/);
  assert.doesNotMatch(coder.prompt, /implementation-plan\.md attempt 1/);
  assert.equal(done.lockedPlan?.version, 3);
});

test("Incomplete or blocked Planner revisions cannot replace a complete review", async t => {
  for (const [status, names] of [["completed", ["implementation-plan.md"]], ["blocked", ["implementation-plan.md", "qa-sheet.md"]]] as const) {
    const f = await fixture(t), started = await f.start(), waiting = await f.wait(started.id, "waiting_review");
    f.result(() => JSON.stringify({ summary: "Unfinished revision", status, decision: "pass", artifacts: names.map(name => ({ name, type: "Report", content: "Incomplete" })) }));
    const done = await f.message(waiting, "Revise the plan and QA sheet.");
    assert.deepEqual(done.review, waiting.review); assert.deepEqual(done.artifacts, waiting.artifacts);
    assert.equal(done.status, "waiting_review"); assert.equal(done.lockedPlan, undefined);
    assert.match(done.steps[0].messages.at(-1)!.text, /completed implementation plan and QA sheet/);
    assert.ok(f.calls.every(call => call.step.agent.role === "planner"));
  }
});

test("Planner follow-ups refresh a queued review without replacing the current review", async t => {
  const f = await fixture(t), started = await f.start(), waiting = await f.wait(started.id, "waiting_review");
  const run = (f.studio as any).getRun(started.id) as Run;
  run.pendingReviews = [run.review!];
  run.review = { ...run.review!, id: "other-review", stepId: run.steps[2].id, lockOutputs: false, summary: "Another handoff" };
  const current = structuredClone(run.review);
  f.result(() => JSON.stringify({ summary: "Updated queued plan", status: "completed", decision: "pass", artifacts: ["implementation-plan.md", "qa-sheet.md"].map(name => ({ name, type: "Report", content: "Updated" })) }));
  const done = await f.message(waiting, "Revise the pending plan.");
  assert.deepEqual(done.review, current); assert.equal(done.note, current.summary);
  assert.notEqual(done.pendingReviews![0].id, waiting.review!.id);
  assert.equal(done.pendingReviews![0].summary, "Updated queued plan");
  assert.equal(done.pendingReviews![0].version, 2); assert.equal(done.lockedPlan, undefined);
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
  const f = await fixture(t, [...rules, { after: "coder", review: "on_issue" }]);
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

test("Automatic steps send locked-plan changes to Planner without a Coder checkpoint", async t => {
  const f = await fixture(t);
  f.result(step => output(step, step.agent.role === "coder" && !step.attempt ? "scope_change" : "pass"));
  const started = await f.start(), original = await f.wait(started.id, "waiting_review");
  await f.review(original);
  const planning = await f.wait(started.id, "waiting_review");
  assert.deepEqual(f.calls.map(call => call.step.agent.role), ["planner", "coder", "planner"]);
  assert.equal(planning.review!.stepId, planning.steps[0].id);
  assert.equal(planning.review!.kind, "checkpoint"); assert.equal(planning.review!.lockOutputs, true);
  assert.equal(planning.review!.version, 2); assert.equal(planning.lockedPlan, undefined);
  assert.equal(planning.steps[1].status, "queued"); assert.equal(planning.steps[1].attempt, 2);
  assert.equal(planning.revisionHistory!.at(-1)!.automatic, true);
  assert.equal(planning.revisionHistory!.at(-1)!.targetAgentId, "planner");
  const planner = f.calls.at(-1)!;
  assert.match(planner.prompt, /Coder: scope_change/);
  assert.ok(original.review!.artifactIds.every(id => planner.step.receivedArtifacts.some(artifact => artifact.id === id)));
  assert.ok(planner.step.receivedArtifacts.some(artifact => artifact.name === "coder.md"));
  assert.equal(planning.reviewHistory!.length, 1);
  await assert.rejects(f.review(original), /changed or was already resolved/);
  await f.review(planning); const done = await f.wait(started.id, "succeeded");
  assert.equal(done.lockedPlan?.version, 2);
  assert.equal(f.calls.filter(call => call.step.agent.role === "coder").length, 2);
});

test("Explicit Coder checkpoints still hold plan changes before returning to Planner", async t => {
  const f = await fixture(t, [...rules, { after: "coder", review: "always" }]);
  f.result(step => output(step, step.agent.role === "coder" ? "scope_change" : "pass"));
  const started = await f.start(); await f.review(await f.wait(started.id, "waiting_review"));
  const change = await f.wait(started.id, "waiting_review");
  assert.equal(change.review!.kind, "scope_change"); assert.equal(change.review!.stepId, change.steps[1].id);
  assert.deepEqual(f.calls.map(call => call.step.agent.role), ["planner", "coder"]);
  assert.equal(change.lockedPlan?.version, 1);
  await assert.rejects(f.review(change), /cannot advance/);
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
    const active = (f.studio as any).getRun(started.id) as Run, calls = f.calls.length;
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

const sharedRules = [rules[0], ...["reviewer", "tester"].map(after => ({ after, loop: { target: "coder", maxCycles: 2, onLimit: "review" } }))];
const finding = { title: "Duplicate reward", severity: "high", location: "RewardService.kt:42", reproduction: "Send concurrent requests with the same key", expected: "One reward", actual: "Two rewards", evidence: [] };

test("Shared revision groups accept one target and require one budget and limit action", () => {
  const base = { id: "flow", name: "Flow", workflow: ["planner", "coder", "reviewer", "tester"], rules: sharedRules };
  assert.deepEqual(revisionGroups(flowSchema.parse(base)), [{ target: "coder", members: ["reviewer", "tester"], maxCycles: 2, onLimit: "review", key: "shared:coder" }]);
  for (const patch of [{ maxCycles: 3 }, { onLimit: "stop" }]) {
    const changed = structuredClone(base);
    Object.assign(changed.rules[2].loop!, patch);
    assert.equal(flowSchema.safeParse(changed).success, false);
  }
  assert.equal(revisionGroups(flowSchema.parse({ ...base, rules }))[0].key, "reviewer");
});

test("Reviewer and tester share one persisted revision budget and carry evidence through rechecks", async t => {
  const f = await fixture(t, sharedRules, true);
  f.result(async step => {
    if (step.agent.role === "coder") await writeFile(join(f.cwd, "code.txt"), `Implementation ${step.attempt || 1}`);
    const revise = step.agent.id === "tester" || (step.agent.id === "reviewer" && !step.attempt);
    const result = JSON.parse(output(step, revise ? "revise" : "pass"));
    result.findings = revise ? [finding] : [];
    return JSON.stringify(result);
  });
  const started = await f.start(); await f.review(await f.wait(started.id, "waiting_review"));
  const limit = await f.wait(started.id, "waiting_review");
  assert.equal(limit.review?.kind, "loop_limit");
  assert.deepEqual(f.calls.map(c => c.step.agent.id), ["planner", "coder", "reviewer", "coder", "reviewer", "tester", "coder", "reviewer", "tester"]);
  assert.equal(limit.loopCounts?.["shared:coder"], 2);
  assert.deepEqual(limit.revisionHistory?.map(r => [r.sourceAgentId, r.targetAgentId, r.cycle]), [["reviewer", "coder", 1], ["tester", "coder", 2]]);
  assert.equal(new Set(f.calls.map(c => c.step.sessionId)).size, f.calls.length);
  assert.equal(limit.cwd, f.cwd); assert.equal(limit.lockedPlan?.version, 1);
  assert.equal(limit.revisionHistory?.[0].findings[0].title, finding.title);
  assert.notEqual(limit.revisionHistory?.[0].codeReference, limit.revisionHistory?.[1].codeReference);
  for (const call of f.calls.slice(6)) {
    assert.ok(limit.revisionHistory!.every(r => r.artifactIds.every(id => call.step.feedbackArtifactIds?.includes(id))));
    assert.match(call.prompt, /prior pass is not proof/);
  }
  assert.ok(limit.revisionHistory!.every(r => r.artifactIds.every(id => limit.artifacts.find(a => a.id === id)?.superseded)));
  await f.restart();
  assert.deepEqual(f.store.run(started.id)!.revisionHistory, limit.revisionHistory);
  f.result(step => output(step));
  await f.review(limit, "request-revision", "Fix the last duplicate case and recheck all findings");
  const done = await f.wait(started.id, "succeeded");
  assert.equal(done.loopCounts?.["shared:coder"], 2);
  assert.equal(done.revisionHistory?.at(-1)?.automatic, false);
  assert.deepEqual(f.calls.slice(-3).map(c => c.step.agent.id), ["coder", "reviewer", "tester"]);
  assert.ok(done.artifacts.some(a => a.name === "backend-evidence.json" && a.verified && !a.superseded));
});

test("Revisiting the plan clears the old lock and requires a new approval", async t => {
  const f = await fixture(t, sharedRules, true);
  f.result(step => output(step, step.agent.id === "tester" ? "revise" : "pass"));
  const started = await f.start(); await f.review(await f.wait(started.id, "waiting_review"));
  const limit = await f.wait(started.id, "waiting_review");
  f.result(step => output(step));
  await f.review(limit, "replan-review", "Decide on the transaction boundary together");
  const plan = await f.wait(started.id, "waiting_review");
  assert.equal(plan.lockedPlan, undefined); assert.equal(plan.review?.lockOutputs, true);
  assert.equal(plan.steps[1].status, "queued"); assert.equal(plan.steps[0].attempt, 2);
  assert.equal(plan.revisionHistory?.at(-1)?.targetAgentId, "planner");
  await f.review(plan); const done = await f.wait(started.id, "succeeded");
  assert.equal(done.lockedPlan?.version, 2); assert.equal(done.loopCounts?.["shared:coder"], 2);
});


test("Revision instructions stay with their target while downstream agents retain evidence", async t => {
  const f = await fixture(t), started = await f.start(), first = await f.wait(started.id, "waiting_review");
  const instruction = "Planner only: revise the plan; do not implement in this step.";
  await f.review(first, "request-revision", instruction);
  const revised = await f.wait(started.id, "waiting_review");
  assert.ok(f.calls.at(-1)!.prompt.includes(instruction));
  await f.review(revised); await f.wait(started.id, "succeeded");
  for (const call of f.calls.filter(call => call.step.agent.role !== "planner")) {
    assert.equal(call.step.feedback, undefined);
    assert.equal(call.prompt.includes(instruction), false);
    assert.ok(first.review!.artifactIds.every(id => call.step.feedbackArtifactIds?.includes(id)));
    assert.match(call.prompt, /output IDs as evidence/);
  }
});

for (const checkpoint of [false, true]) test(`Blocked plan changes reach Planner without an execution failure (checkpoint=${checkpoint})`, async t => {
  const f = await fixture(t, checkpoint ? [...rules, { after: "coder", review: "always" }] : rules);
  f.result(step => output(step, step.agent.role === "coder" && !step.attempt ? "scope_change" : "pass", step.agent.role === "coder" && !step.attempt ? "blocked" : "completed"));
  const started = await f.start(); await f.review(await f.wait(started.id, "waiting_review"));
  let review = await f.wait(started.id, "waiting_review");
  if (checkpoint) {
    assert.equal(review.review!.kind, "scope_change");
    assert.equal(review.steps[1].status, "waiting_review");
    await assert.rejects(f.review(review), /cannot advance/);
    await f.review(review, "request-revision", "Resolve the conflict in the plan.");
    review = await f.wait(started.id, "waiting_review");
  }
  assert.equal(review.review!.stepId, review.steps[0].id);
  assert.equal(review.steps[1].status, "queued");
  assert.equal(review.stepHistory!.find(step => step.agent.role === "coder")!.status, "waiting_review");
  assert.equal(review.lockedPlan, undefined);
  await f.review(review);
  if (checkpoint) await f.review(await f.wait(started.id, "waiting_review"));
  await f.wait(started.id, "succeeded");
});
