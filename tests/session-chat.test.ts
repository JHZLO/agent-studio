import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { initialState } from "../packages/contracts/defaults.js";
import { settingsSchema, type Run, type Step } from "../packages/contracts/index.ts";
import { Studio } from "../packages/engine/studio.ts";
import { Store } from "../packages/engine/store.ts";
import { Toolbox, codeReference } from "../packages/engine/tools.ts";
import { RpcError, type Wire } from "../packages/engine/codex.ts";

const answer = (summary = "The existing transaction protects both writes.") => JSON.stringify({ summary, status: "completed", decision: "pass", artifacts: [] });
async function fixture(t: test.TestContext, status: Run["status"] = "succeeded") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "studio-chat-"))), cwd = join(root, "project");
  await mkdir(cwd); await writeFile(join(cwd, "README.md"), "Original");
  const store = new Store(join(root, "state.sqlite"));
  const state = settingsSchema.parse({ ...initialState(), skillRoots: [], maxConcurrentRuns: 2 });
  state.agents = state.agents.slice(0, 3).map(agent => ({ ...agent, provider: "codex", tools: ["read", "write"], permissionLevel: "project", skillBindings: [] }));
  state.projects = [{ id: "project", name: "Fixture", path: cwd, execution: { mode: "local", branchName: "" } }];
  state.flows = [{ ...state.flows[0], workflow: state.agents.map(agent => agent.id), rules: [] }];
  store.set("settings", state);
  const reference = await codeReference(cwd), at = new Date().toISOString();
  const run: Run = { id: "task", project: state.projects[0], flow: state.flows[0], brief: "Implement the plan", cwd, baseHead: null, projectRules: [], createdAt: at, completedAt: at, status, index: 3, note: "Original outcome", controlMode: "studio", approvalRequired: true, approved: true, pauseRequested: false, eventSeq: 0, commandId: "initial",
    steps: state.agents.map(agent => ({ id: agent.id, agent, status: "succeeded", sessionId: `studio-${agent.id}`, providerThreadId: `provider-${agent.id}`, receivedArtifacts: [], messages: [{ id: `original-${agent.id}`, type: "assistant", text: "Original response", time: at }], completedAt: at, finalText: "Original structured result", codeReference: reference })),
    artifacts: [{ id: "plan", name: "implementation-plan.md", type: "Plan", content: "Locked plan", agent: "Planner", stepId: "planner", verified: true, codeReference: reference }], lockedPlan: { version: 1, stepId: "planner", artifactIds: ["plan"] } };
  if (status === "waiting_review") { run.index = 1; run.steps[1].status = "queued"; delete run.steps[1].providerThreadId; run.review = { id: "review", stepId: "planner", kind: "checkpoint", artifactIds: ["plan"], fingerprint: "fingerprint", version: 1, returnTo: "planner", lockOutputs: true, summary: "Review plan", createdAt: at, codeReference: reference }; }
  store.saveRun(run, "fixture");
  const studio = new Studio(store, root, join(root, "sockets"));
  studio.connections.assertAgent = async () => {};
  t.after(async () => { await studio.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const send = (stepId = "coder", message = "Explain this transaction.") => studio.dispatch("run.message", { id: run.id, stepId, message }) as Promise<Run>;
  async function idle() {
    for (let i = 0; i < 400; i++) {
      if (!(studio as any).driving.has(run.id)) return store.run(run.id)!;
      await delay(5);
    }
    assert.fail("Follow-up did not finish");
  }
  return { root, cwd, store, studio, run, send, idle };
}

test("Follow-ups reuse the selected session and preserve workflow results without running later agents", async t => {
  const f = await fixture(t), calls: string[] = [];
  t.mock.method(f.studio as any, "codexTurn", async (run: Run, step: Step, prompt: string) => {
    calls.push(step.id); assert.equal(step.providerThreadId, "provider-coder");
    assert.match(prompt, /Follow-up from the user: Explain this transaction/);
    assert.match(prompt, /Perform only the work explicitly requested/);
    assert.match(prompt, /Approved plan version: 1/);
    assert.equal(run.index, 3); assert.equal(step.messages.at(-1)?.type, "user");
    return answer();
  });
  const accepted = await f.send(); assert.equal(accepted.followup?.stepId, "coder");
  const done = await f.idle();
  assert.equal(done.status, "succeeded"); assert.equal(done.followup, undefined); assert.equal(done.index, 3);
  assert.deepEqual(done.lockedPlan, f.run.lockedPlan); assert.deepEqual(done.artifacts, f.run.artifacts);
  assert.equal(done.completedAt, f.run.completedAt); assert.equal(done.steps[1].completedAt, f.run.steps[1].completedAt);
  assert.equal(done.steps[1].finalText, f.run.steps[1].finalText);
  assert.equal(done.steps[1].messages.length, 3); assert.deepEqual(done.steps[0].messages, f.run.steps[0].messages);
  await f.send("coder", "Explain the retry path too."); await f.idle(); assert.deepEqual(calls, ["coder", "coder"]);
});

test("Questions at a plan checkpoint keep the exact review and do not approve or start coding", async t => {
  const f = await fixture(t, "waiting_review"), before = f.store.run(f.run.id)!;
  t.mock.method(f.studio as any, "codexTurn", async (_run: Run, step: Step) => { assert.equal(step.id, "planner"); return answer(); });
  await f.send("planner", "Which decisions do I need to make?"); const done = await f.idle();
  assert.equal(done.status, "waiting_review"); assert.deepEqual(done.review, before.review);
  assert.equal(done.index, 1); assert.equal(done.steps[1].status, "queued");
  await assert.rejects(f.send("coder"), /has not started/);
});

test("Follow-up tools use frozen permissions and mark old evidence stale after a write", async t => {
  const f = await fixture(t);
  const settings = f.studio.settings(); settings.agents[1].permissionLevel = "read-only"; f.store.set("settings", settings);
  t.mock.method(f.studio as any, "codexTurn", async (_run: Run, step: Step, _prompt: string, tools: Toolbox) => {
    assert.equal(step.agent.permissionLevel, "project");
    const write = await tools.call("studio_write", { path: "README.md", content: "Updated by the requested follow-up" }); assert.equal(write.success, true);
    return answer("Updated the requested file. Rerun the checks.");
  });
  await f.send("coder", "Update README.md."); const done = await f.idle();
  assert.equal(await readFile(join(f.cwd, "README.md"), "utf8"), "Updated by the requested follow-up");
  assert.equal(done.artifacts[0].stale, true); assert.match(done.note, /Earlier outputs may be stale/);
  assert.equal(done.artifacts.at(-1)?.type, "Tool evidence"); assert.equal(done.artifacts.at(-1)?.stale, undefined);
  assert.equal(done.status, "succeeded"); assert.equal(done.index, 3);
});

test("Concurrent sends reserve the task and folder before the account check completes", async t => {
  const f = await fixture(t); let release!: () => void, checking = false;
  f.studio.connections.assertAgent = async () => { checking = true; await new Promise<void>(resolve => { release = resolve; }); };
  t.mock.method(f.studio as any, "codexTurn", async () => answer());
  const first = f.send();
  while (!checking) await delay(5);
  await assert.rejects(f.send(), /current reply/);
  const other = { ...structuredClone(f.run), id: "other" }; f.store.saveRun(other, "fixture");
  await assert.rejects(f.studio.dispatch("run.message", { id: "other", stepId: "coder", message: "Conflicting edit" }), /project folder/);
  release(); await first; await f.idle();
});

test("A follow-up cannot attach to a running turn, terminal-controlled task or unknown step", async t => {
  const f = await fixture(t); let calls = 0;
  t.mock.method(f.studio as any, "codexTurn", async () => { calls++; return answer(); });
  await assert.rejects(f.send("missing"), /has not started/);
  for (const patch of [{ status: "running" }, { controlMode: "terminal" }, { status: "needs_reconciliation" }]) {
    f.store.saveRun({ ...structuredClone(f.run), ...patch } as Run, "fixture");
    await assert.rejects(f.send(), /current turn/);
  }
  const busy = structuredClone(f.run); busy.steps[0].activeTurnId = "busy-turn"; f.store.saveRun(busy, "fixture");
  await assert.rejects(f.send(), /current turn/); assert.equal(calls, 0);
});

test("Stopping a reply at a permission prompt preserves the task and never starts inference", async t => {
  const f = await fixture(t), original = structuredClone(f.run); original.approved = false; original.steps[1].agent.permissionLevel = "ask"; f.store.saveRun(original, "fixture");
  let calls = 0; t.mock.method(f.studio as any, "codexTurn", async () => { calls++; return answer(); });
  const pending = await f.send(); assert.equal(pending.status, "waiting_approval");
  await f.studio.dispatch("run.control", { id: f.run.id, action: "stop-message" });
  const done = await f.idle(); assert.equal(done.status, "succeeded"); assert.equal(done.approval, undefined); assert.equal(done.approved, false); assert.equal(calls, 0);
  assert.match(done.steps[1].messages.at(-1)!.text, /Reply stopped/);
});

test("Uncertain replies reconcile the exact selected session and turn without replaying or advancing", async t => {
  const f = await fixture(t); let calls = 0;
  t.mock.method(f.studio as any, "codexTurn", async (run: Run) => { calls++; run.followup!.turnId = "follow-up-turn"; throw new RpcError("Acknowledgement lost", -1, true); });
  await f.send("planner"); const interrupted = await f.idle(); assert.equal(interrupted.status, "needs_reconciliation");
  await assert.rejects(f.send("planner"), /current reply/);
  const read = { id: "provider-planner", cwd: f.cwd, turns: [{ id: "follow-up-turn", status: "completed", items: [{ type: "agentMessage", text: answer("Recovered answer") }] }] };
  t.mock.method(f.studio as any, "codexHost", async () => ({ client: { call: async (method: string, params: Wire) => { assert.equal(method, "thread/read"); assert.equal(params.threadId, "provider-planner"); return { thread: read }; } } }));
  const done = await f.studio.dispatch("run.reconcile", { id: f.run.id }) as Run;
  assert.equal(done.status, "succeeded"); assert.equal(done.index, 3); assert.equal(calls, 1);
  assert.match(done.steps[0].messages.at(-1)!.text, /Recovered answer/);
  assert.equal(done.steps[1].messages.length, 1);
});

test("Codex resumes the exact idle thread with Studio restrictions and no duplicate task prompt", async t => {
  const f = await fixture(t), calls: { method: string; params: Wire }[] = [];
  let wrongThread = false;
  t.mock.method(f.studio as any, "codexHost", async (run: Run, step: Step) => ({ client: { call: async (method: string, params: Wire) => {
    calls.push({ method, params });
    if (method === "config/read") return { config: { mcp_servers: { unexpected: {} } } };
    if (method === "thread/read" || method === "thread/resume") return { thread: { id: wrongThread ? "other" : step.providerThreadId, cwd: f.cwd, turns: [] }, model: "fixture" };
    assert.equal(method, "turn/start");
    queueMicrotask(() => {
      for (const [method, params] of [["turn/started", { turn: { id: "reply-turn" } }], ["item/completed", { item: { id: `reply-${calls.length}`, type: "agentMessage", phase: "final_answer", text: answer() } }], ["turn/completed", { turn: { id: "reply-turn", status: "completed" } }]] as const) (f.studio as any).codexEvent(run, { method, params: { threadId: step.providerThreadId, ...params } });
    });
    return { turn: { id: "reply-turn" } };
  } } }));
  await f.send(); const done = await f.idle();
  assert.deepEqual(calls.map(call => call.method), ["config/read", "thread/read", "thread/resume", "turn/start"]);
  const resume = calls[2].params; assert.equal(resume.threadId, "provider-coder"); assert.equal(resume.dynamicTools, undefined);
  assert.equal(resume.sandbox, "read-only"); assert.equal(resume.config["features.shell_tool"], false); assert.equal(resume.config.mcp_servers.unexpected.enabled, false);
  assert.deepEqual(done.steps[1].messages.filter(message => message.type === "user").map(message => message.text), ["Explain this transaction."]);
  wrongThread = true; calls.length = 0; await f.send(); const refused = await f.idle();
  assert.equal(calls.some(call => call.method === "turn/start"), false); assert.match(refused.steps[1].messages.at(-1)!.text, /saved session is missing/);
});

test("Stopping an active Codex reply interrupts only its selected turn and preserves completed steps", async t => {
  const f = await fixture(t), interrupted: Wire[] = [];
  let activeRun: Run, activeStep: Step;
  const host = { stop: async () => {}, client: { call: async (method: string, params: Wire) => {
    if (method === "config/read") return { config: {} };
    if (method === "thread/read" || method === "thread/resume") return { thread: { id: "provider-planner", cwd: f.cwd, turns: [] }, model: "fixture" };
    if (method === "turn/start") {
      queueMicrotask(() => (f.studio as any).codexEvent(activeRun, { method: "turn/started", params: { threadId: activeStep.providerThreadId, turn: { id: "reply-to-stop" } } }));
      return { turn: { id: "reply-to-stop" } };
    }
    assert.equal(method, "turn/interrupt"); interrupted.push(params);
    queueMicrotask(() => (f.studio as any).codexEvent(activeRun, { method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } }));
    return {};
  } } };
  t.mock.method(f.studio as any, "codexHost", async (run: Run, step: Step) => { activeRun = run; activeStep = step; (f.studio as any).hosts.set(`${run.id}-${step.agent.auth}`, host); return host; });
  await f.send("planner");
  for (let i = 0; i < 200 && !f.store.run(f.run.id)!.steps[0].activeTurnId; i++) await delay(5);
  assert.equal(f.store.run(f.run.id)!.steps[0].activeTurnId, "reply-to-stop");
  await f.studio.dispatch("run.control", { id: f.run.id, action: "stop-message" });
  const done = await f.idle();
  assert.deepEqual(interrupted, [{ threadId: "provider-planner", turnId: "reply-to-stop" }]);
  assert.equal(done.status, "succeeded"); assert.equal(done.steps[0].activeTurnId, undefined); assert.equal(done.index, 3);
  assert.deepEqual(done.steps[1], f.run.steps[1]); assert.match(done.steps[0].messages.at(-1)!.text, /Reply stopped/);
});

async function until(check: () => unknown) {
  for (let i = 0; i < 400; i++) { if (check()) return; await delay(5); }
  assert.fail("The expected session state did not arrive");
}

test("Active follow-up commands drain FIFO in the same session and keep the original review", async t => {
  const f = await fixture(t, "waiting_review"), calls: string[] = []; let release!: () => void;
  t.mock.method(f.studio as any, "codexTurn", async (run: Run, step: Step, prompt: string) => {
    assert.equal(step.id, "planner"); assert.equal(step.providerThreadId, "provider-planner");
    calls.push(run.activeMessage?.message ?? run.followup!.message);
    if (calls.length === 1) await new Promise<void>(resolve => { release = resolve; });
    else assert(prompt.includes(`Follow-up from the user: ${calls.at(-1)}`));
    return answer(calls.at(-1));
  });
  await f.send("planner", "First question"); await until(() => release);
  const queue = (message: string, stepId = "planner") => f.studio.dispatch("run.message", { id: f.run.id, stepId, message, mode: "queue" }) as Promise<Run>;
  await queue("Second question"); const accepted = await queue("Third question");
  assert.deepEqual(accepted.pendingMessages?.map(item => item.message), ["Second question", "Third question"]);
  assert.deepEqual(f.store.run(f.run.id)!.pendingMessages, accepted.pendingMessages);
  await assert.rejects(queue("Wrong agent", "coder"), /Only the agent currently working/);
  assert.deepEqual(calls, ["First question"]); release(); const done = await f.idle();
  assert.deepEqual(calls, ["First question", "Second question", "Third question"]);
  assert.equal(done.status, "waiting_review"); assert.deepEqual(done.review, f.run.review);
  assert.equal(done.index, 1); assert.equal(done.steps[1].status, "queued"); assert.deepEqual(done.pendingMessages, []);
  assert.equal(done.activeMessage, undefined); assert.equal(done.acceptingMessages, false);
});

test("Workflow instructions finish before the handoff and cannot bypass a human plan checkpoint", async t => {
  const f = await fixture(t); const run = structuredClone(f.run); run.status = "running"; run.index = 0; run.artifacts = []; delete run.lockedPlan;
  run.steps.forEach(step => { step.status = "queued"; step.messages = []; delete step.providerThreadId; delete step.finalText; }); run.steps[0].reviewRequired = true;
  (f.studio as any).runs.set(run.id, run); const calls: string[] = []; let release!: () => void;
  t.mock.method(f.studio as any, "codexTurn", async (current: Run, step: Step, prompt: string) => {
    assert.equal(current.index, 0); assert.equal(step.id, "planner"); step.providerThreadId = "same-thread";
    const text = current.activeMessage?.message || "Initial plan"; calls.push(text);
    if (calls.length === 1) await new Promise<void>(resolve => { release = resolve; });
    else assert.match(prompt, /Return the complete updated role outputs/);
    return JSON.stringify({ summary: text, status: "completed", decision: "pass", artifacts: [{ name: "implementation-plan.md", type: "Plan", content: text }, { name: "qa-sheet.md", type: "QA", content: "Verify the agreed scope" }] });
  });
  const running = (f.studio as any).drive(run); await until(() => release);
  await f.studio.dispatch("run.message", { id: run.id, stepId: "planner", message: "Include concurrent requests", mode: "queue" });
  release(); await running; const done = f.store.run(run.id)!;
  assert.deepEqual(calls, ["Initial plan", "Include concurrent requests"]);
  assert.equal(done.status, "waiting_review"); assert.equal(done.index, 1); assert.equal(done.steps[1].status, "queued");
  assert.equal(done.artifacts.find(item => item.name === "implementation-plan.md")!.content, "Include concurrent requests");
});

test("Adjusting work interrupts the exact turn and drains foreground tools before the priority instruction", async t => {
  const f = await fixture(t), original = structuredClone(f.run); original.steps[1].agent.permissionLevel = "bypass"; original.steps[1].agent.tools.push("shell"); f.store.saveRun(original, "fixture");
  const calls: string[] = [], interrupts: Wire[] = []; let active: Run, tool: Promise<unknown>;
  const host = { stop: async () => {}, client: { call: async (method: string, params: Wire) => {
    assert.equal(method, "turn/interrupt"); interrupts.push(params);
    (f.studio as any).codexEvent(active, { method: "turn/completed", params: { threadId: "provider-coder", turn: { id: params.turnId, status: "interrupted" } } }); return {};
  } } };
  t.mock.method(f.studio as any, "codexTurn", async (run: Run, step: Step, _prompt: string, tools: Toolbox) => {
    active = run; calls.push(run.activeMessage?.message || "Initial work");
    if (calls.length === 1) {
      (f.studio as any).hosts.set(`${run.id}-${step.agent.auth}`, host); step.activeTurnId = "original-turn";
      const stopped = new Promise<Wire>((resolve, reject) => (f.studio as any).turns.set(step.providerThreadId, { resolve, reject }));
      tool = tools.call("studio_shell", { command: "printf started > started.txt; sleep 30; printf obsolete > unwanted.txt", timeoutSeconds: 40, background: false });
      await stopped; throw new Error("Codex turn interrupted.");
    }
    assert.equal((await tool as any).success, false);
    assert.equal(await readFile(join(f.cwd, "unwanted.txt"), "utf8").catch(() => undefined), undefined);
    assert.equal(step.providerThreadId, "provider-coder");
    return answer(calls.at(-1));
  });
  await f.send(); await until(() => f.store.receipts(f.run.id, "coder").length === 0 && active?.steps[1].activeTurnId);
  for (let i = 0; i < 200 && !await readFile(join(f.cwd, "started.txt"), "utf8").catch(() => undefined); i++) await delay(5);
  assert.equal(await readFile(join(f.cwd, "started.txt"), "utf8"), "started");
  await f.studio.dispatch("run.message", { id: f.run.id, stepId: "coder", message: "Later request", mode: "queue" });
  await f.studio.dispatch("run.message", { id: f.run.id, stepId: "coder", message: "New priority", mode: "interrupt" });
  const done = await f.idle();
  assert.deepEqual(interrupts, [{ threadId: "provider-coder", turnId: "original-turn" }]);
  assert.deepEqual(calls, ["Initial work", "New priority", "Later request"]);
  assert.equal(done.status, "succeeded"); assert.equal(done.index, 3); assert.equal(done.interruptRequested, undefined);
});

test("Queued instructions can be removed and stopping a reply cancels the remaining queue", async t => {
  const f = await fixture(t); let active: Run, release!: () => void; const calls: string[] = [];
  t.mock.method(f.studio as any, "codexTurn", async (run: Run) => { active = run; calls.push("turn"); await new Promise<void>(resolve => { release = resolve; }); return answer(); });
  await f.send(); await until(() => release);
  const queued = await f.studio.dispatch("run.message", { id: f.run.id, stepId: "coder", message: "Do not execute this", mode: "queue" }) as Run;
  await f.studio.dispatch("run.control", { id: f.run.id, action: "remove-message", messageId: queued.pendingMessages![0].id });
  assert.equal(active!.pendingMessages!.length, 0);
  await f.studio.dispatch("run.message", { id: f.run.id, stepId: "coder", message: "Cancel on stop", mode: "queue" });
  await f.studio.dispatch("run.control", { id: f.run.id, action: "stop-message" }); release(); const done = await f.idle();
  assert.equal(calls.length, 1); assert.deepEqual(done.pendingMessages, []);
  assert(done.steps[1].messages.some(item => /queued instruction\(s\) were cancelled/.test(item.text)));
});

test("Unacknowledged interruptions retain pending instructions and never start another turn", async t => {
  const f = await fixture(t); let active: Run, calls = 0;
  const host = { stop: async () => {}, client: { call: async () => { throw new Error("Disconnected"); } } };
  t.mock.method(f.studio as any, "codexTurn", async (run: Run, step: Step) => {
    calls++; active = run; step.activeTurnId = "unconfirmed"; (f.studio as any).hosts.set(`${run.id}-${step.agent.auth}`, host);
    return new Promise<string>((resolve, reject) => (f.studio as any).turns.set(step.providerThreadId, { resolve, reject }));
  });
  await f.send(); await until(() => active);
  await f.studio.dispatch("run.message", { id: f.run.id, stepId: "coder", message: "Never replay automatically", mode: "interrupt" });
  const done = await f.idle(); assert.equal(done.status, "needs_reconciliation"); assert.equal(done.pendingMessages?.length, 1); assert.equal(calls, 1);
  const recovered = await f.studio.dispatch("run.reconcile", { id: f.run.id }) as Run;
  assert.equal(recovered.status, "needs_reconciliation"); assert.match(recovered.note, /No queued instruction was replayed/);
});

test("Adjusting at a tool approval rejects the old command without granting permission", async t => {
  const f = await fixture(t), original = structuredClone(f.run); original.steps[1].agent.permissionLevel = "ask"; original.steps[1].agent.tools.push("shell"); f.store.saveRun(original, "fixture");
  let calls = 0;
  t.mock.method(f.studio as any, "codexTurn", async (_run: Run, _step: Step, _prompt: string, tools: Toolbox) => {
    if (++calls === 1) {
      const result = await tools.call("studio_shell", { command: "printf forbidden > unapproved.txt", timeoutSeconds: 1, background: false });
      assert.equal(result.success, false); throw new Error("Original command rejected");
    }
    assert.equal((await tools.call("studio_read", { path: "README.md" })).success, true); return answer("Read the current state without executing the command");
  });
  await f.send(); await until(() => f.store.run(f.run.id)!.approval?.kind === "shell");
  const approvalId = f.store.run(f.run.id)!.approval!.id;
  await f.studio.dispatch("run.message", { id: f.run.id, stepId: "coder", message: "Read instead", mode: "interrupt" });
  const done = await f.idle(); assert.equal(calls, 2); assert.equal(done.approval, undefined);
  assert.equal(await readFile(join(f.cwd, "unapproved.txt"), "utf8").catch(() => undefined), undefined);
  const events = f.store.db.prepare("SELECT value FROM events WHERE kind = 'approval.resolved'").all() as { value: string }[];
  assert(events.some(row => { const event = JSON.parse(row.value); return event.id === approvalId && !event.accepted; }));
});

test("Restarted queues remain visible without replaying or recovering the previous turn as the new answer", async t => {
  const f = await fixture(t), run = structuredClone(f.run); run.status = "running"; run.acceptingMessages = true;
  run.steps[1].status = "running"; run.steps[1].lastTurnId = "previous-completed-turn";
  run.activeMessage = { id: "submission-unknown", stepId: "coder", message: "Check the new change", mode: "queue", createdAt: new Date().toISOString() };
  f.store.saveRun(run, "fixture.interrupted");
  const restarted = new Studio(f.store, f.root, join(f.root, "restart-sockets"));
  try {
    assert.equal(f.store.run(run.id)!.acceptingMessages, false);
    const recovered = await restarted.dispatch("run.reconcile", { id: run.id }) as Run;
    assert.equal(recovered.status, "needs_reconciliation"); assert.deepEqual(recovered.activeMessage, run.activeMessage);
    assert.match(recovered.note, /No queued instruction was replayed/);
  } finally { await restarted.close(); }
});

test("Late tool requests from an interrupted Codex turn cannot execute in its replacement turn", async t => {
  const f = await fixture(t), run = structuredClone(f.run); run.status = "running"; run.index = 1; run.steps[1].status = "running"; run.steps[1].activeTurnId = "new-turn";
  let rejected = false;
  const host = { client: { reject: (_id: string, message: string) => { rejected = true; assert.match(message, /inactive turn/); } } };
  await (f.studio as any).codexRequest(run, host, { id: "late-call", method: "item/tool/call", params: { threadId: "provider-coder", turnId: "old-turn", tool: "studio_write", arguments: { path: "README.md", content: "Obsolete" } } });
  assert(rejected); assert.equal(await readFile(join(f.cwd, "README.md"), "utf8"), "Original");
});
