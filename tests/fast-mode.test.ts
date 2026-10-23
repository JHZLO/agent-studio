import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialState } from "../packages/contracts/defaults.js";
import { agentSchema, type Agent, type Run, type Step } from "../packages/contracts/index.ts";
import { supportsFastMode, type Wire } from "../packages/engine/codex.ts";
import { Toolbox } from "../packages/engine/tools.ts";
import { Store } from "../packages/engine/store.ts";
import { Studio } from "../packages/engine/studio.ts";

test("Fast mode defaults preserve existing agents and use runtime capabilities", () => {
  const legacy = { ...initialState().agents[1] } as Partial<Agent>; delete legacy.codexFastMode;
  assert.equal(agentSchema.parse(legacy).codexFastMode, "default");
  assert.equal(agentSchema.safeParse({ ...legacy, codexFastMode: "ultrafast" }).success, false);
  assert.equal(supportsFastMode({ serviceTiers: [{ id: "priority" }] }), true);
  assert.equal(supportsFastMode({ additionalSpeedTiers: ["fast"] }), true);
  assert.equal(supportsFastMode({ serviceTiers: [{ id: "ultrafast" }] }), false);
  assert.equal(supportsFastMode(), false);
});

async function session(t: test.TestContext, mode: Agent["codexFastMode"], tier: string | null, supported = true) {
  const path = await mkdtemp(join(tmpdir(), "studio-fast-"));
  const store = new Store(join(path, "state.sqlite")), studio = new Studio(store, path, path);
  t.after(async () => { await studio.close(); store.close(); await rm(path, { recursive: true, force: true }); });
  const settings = studio.settings();
  const step: Step = { id: "step", agent: agentSchema.parse({ ...settings.agents[1], codexFastMode: mode }), status: "running", sessionId: "session", messages: [], receivedArtifacts: [] };
  const run: Run = { id: "run", brief: "Test configuration", project: { id: "project", name: "Fixture", path, execution: { mode: "local", branchName: "" } }, flow: settings.flows[0], status: "running", createdAt: new Date().toISOString(), index: 0, steps: [step], artifacts: [], note: "", cwd: path, baseHead: null, approvalRequired: true, approved: false, pauseRequested: false, controlMode: "studio", eventSeq: 0, commandId: "test" };
  const requests: { method: string; params: Wire }[] = [];
  const host = { client: { call: async (method: string, params: Wire) => {
    requests.push({ method, params });
    if (method === "config/read") return { config: { mcp_servers: {} } };
    if (method === "thread/start") return { thread: { id: "thread" }, model: "resolved-model", serviceTier: tier };
    if (method === "model/list") return { data: [{ model: "resolved-model", serviceTiers: supported ? [{ id: "priority" }] : [] }] };
    assert.equal(method, "turn/start");
    assert.deepEqual([...params.outputSchema.required].sort(), Object.keys(params.outputSchema.properties).sort());
    queueMicrotask(() => {
      const event = (method: string, params: Wire) => (studio as any).codexEvent(run, { method, params: { threadId: "thread", ...params } });
      event("turn/started", { turn: { id: "turn" } });
      event("item/completed", { item: { id: "message", type: "agentMessage", phase: "final_answer", text: "Test result" } });
      event("turn/completed", { turn: { id: "turn", status: "completed" } });
    });
    return { turn: { id: "turn" } };
  } } };
  t.mock.method(studio as any, "codexHost", async () => host);
  const tools = new Toolbox({ run, step, save: () => {}, approval: async () => false, redact: text => text }, path);
  t.after(() => tools.close());
  return { requests, step, execute: () => (studio as any).codexTurn(run, step, "Test prompt", tools) };
}

for (const [mode, returnedTier, requestedTier] of [["default", "priority", undefined], ["on", "priority", "fast"], ["off", "default", "default"]] as const) {
  test(`Codex ${mode} mode selects the expected session tier and keeps Studio permissions`, async t => {
    const { requests, step, execute } = await session(t, mode, returnedTier);
    assert.equal(await execute(), "Test result");
    const start = requests.find(request => request.method === "thread/start")!.params;
    assert.equal(start.serviceTier, requestedTier);
    assert.equal(Object.hasOwn(start, "serviceTier"), mode !== "default");
    assert.equal(start.sandbox, "read-only"); assert.equal(start.approvalPolicy, "untrusted");
    assert.equal(start.config["features.fast_mode"], mode === "on" ? true : undefined);
    assert.equal(step.actualServiceTier, returnedTier);
    assert.equal(requests.filter(request => request.method === "turn/start").length, 1);
  });
}

test("Fast mode refuses unsupported resolved default models before sending a turn", async t => {
  const { requests, execute } = await session(t, "on", "priority", false);
  await assert.rejects(execute(), /does not report Fast mode support/);
  assert.equal(requests.some(request => request.method === "turn/start"), false);
});

test("Codex must acknowledge the requested speed before any inference starts", async t => {
  for (const [mode, returnedTier] of [["on", "default"], ["off", "priority"]] as const) {
    const { requests, execute } = await session(t, mode, returnedTier);
    await assert.rejects(execute(), /Codex did not/);
    assert.equal(requests.some(request => request.method === "turn/start"), false);
  }
});
