import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { initialState } from "../packages/contracts/defaults.js";
import { agentSchema, settingsSchema, type Agent, type Run, type Step } from "../packages/contracts/index.ts";
import { Toolbox, toolSpecs } from "../packages/engine/tools.ts";
import { Store } from "../packages/engine/store.ts";
import { Studio } from "../packages/engine/studio.ts";

async function fixture(t: test.TestContext, permissionLevel: Agent["permissionLevel"] = "ask", approved = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "studio-permission-"))), cwd = join(root, "project");
  await mkdir(cwd); await writeFile(join(cwd, "README.md"), "Original");
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = agentSchema.parse({ ...initialState().agents[1], permissionLevel, tools: ["read", "write", "shell", "browser"] });
  const step: Step = { id: "step", agent, status: "running", sessionId: "session", messages: [], receivedArtifacts: [] };
  const run = { id: "run", cwd, approved, artifacts: [], steps: [step] } as unknown as Run;
  const requests: string[] = [];
  const tools = new Toolbox({ run, step, save: () => {}, redact: text => text, approval: async kind => { requests.push(kind); return false; } }, join(root, "evidence"));
  t.after(() => tools.close());
  return { root, run, step, tools, requests };
}

test("Legacy agents retain approval behavior and unknown permission levels are rejected", () => {
  const legacy = initialState();
  for (const agent of legacy.agents) delete (agent as Partial<Agent>).permissionLevel;
  assert(settingsSchema.parse(legacy).agents.every(agent => agent.permissionLevel === "ask"));
  assert.equal(agentSchema.safeParse({ ...legacy.agents[0], permissionLevel: "unrestricted" }).success, false);
});

test("Read-only agents expose only read tools even when the run has write approval", async t => {
  const { tools, step } = await fixture(t, "read-only", true);
  assert.deepEqual(toolSpecs(step).map(tool => tool.name), ["studio_list", "studio_read", "studio_artifact"]);
  assert.equal(tools.canWrite, false);
  assert.equal((await tools.call("studio_read", { path: "README.md" })).result, "Original");
  for (const name of ["studio_write", "studio_shell", "studio_http", "studio_browser", "studio_load_test"]) {
    await assert.rejects(tools.call(name, {}), /not enabled/);
  }
});

test("Project automation writes and runs sandboxed commands without granting approval to other agents", async t => {
  const { root, run, step, tools, requests } = await fixture(t, "project");
  assert.equal((await tools.call("studio_write", { path: "new.txt", content: "Created" })).success, true);
  assert.equal(await readFile(join(run.cwd, "new.txt"), "utf8"), "Created");
  const commands: string[][] = [];
  t.mock.method(tools as any, "command", async (_binary: string, args: string[]) => { commands.push(args); return { exitCode: 0 }; });
  assert.equal((await tools.call("studio_shell", { command: "echo ok", timeoutSeconds: 1, background: false })).success, true);
  assert(commands[0].includes('permissions.agent-studio-command.extends=":workspace"'));
  assert.deepEqual(requests, []); assert.equal(run.approved, false);
  assert.equal((await tools.call("studio_write", { path: "../outside.txt", content: "Denied" })).success, false);
  await symlink(root, join(run.cwd, "escape"));
  assert.equal((await tools.call("studio_write", { path: "escape/outside.txt", content: "Denied" })).success, false);
  assert.equal((await tools.call("studio_write", { path: ".env", content: "Denied" })).success, false);
  step.agent.permissionLevel = "ask";
  assert.equal((await tools.call("studio_write", { path: "new.txt", content: "Denied" })).success, false);
  assert.equal((await tools.call("studio_shell", { command: "echo no", timeoutSeconds: 1, background: false })).success, false);
  assert.equal(commands.length, 1); assert.deepEqual(requests, ["shell"]);
});

test("Project automation keeps disabled tools and external HTTP approvals enforced", async t => {
  const { tools, step, requests } = await fixture(t, "project");
  assert.equal((await tools.call("studio_http", { url: "https://example.test/api", method: "GET", headers: {}, body: "" })).success, false);
  assert.deepEqual(requests, ["network"]);
  step.agent.tools = ["read", "shell"];
  assert.equal(tools.canWrite, false);
  await assert.rejects(tools.call("studio_write", { path: "new.txt", content: "Denied" }), /not enabled/);
  t.mock.method(tools as any, "command", async (_binary: string, args: string[]) => {
    assert(args.includes('permissions.agent-studio-command.extends=":read-only"'));
    return { exitCode: 0 };
  });
  assert.equal((await tools.call("studio_shell", { command: "echo ok", timeoutSeconds: 1, background: false })).success, true);
});

test("Manual permissions still require command approval after file writes are approved", async t => {
  const { tools, requests } = await fixture(t, "ask", true);
  assert.equal((await tools.call("studio_write", { path: "approved.txt", content: "Allowed" })).success, true);
  assert.equal((await tools.call("studio_shell", { command: "echo no", timeoutSeconds: 1, background: false })).success, false);
  assert.deepEqual(requests, ["shell"]);
});

test("A run freezes agent permissions and automation does not skip the next agent's approval", async t => {
  const { root, run: base } = await fixture(t);
  const store = new Store(join(root, "state.sqlite")), studio = new Studio(store, root, join(root, "sockets"));
  t.after(async () => { await studio.close(); store.close(); });
  const settings = studio.settings();
  settings.agents = ["project", "ask"].map((level, index) => agentSchema.parse({ ...settings.agents[1], id: `agent-${index}`, permissionLevel: level }));
  settings.flows[0].workflow = settings.agents.map(agent => agent.id);
  settings.projects = [{ id: "project", name: "Fixture", path: base.cwd, execution: { mode: "local", branchName: "" } }];
  settings.skillRoots = []; store.set("settings", settings);
  studio.connections.assertAgent = async () => {};
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(studio as any, "codexTurn", async (_run: Run, step: Step, _prompt: string, tools: Toolbox) => {
    assert.equal(tools.canWrite, true);
    if (step.agent.permissionLevel === "project") await gate;
    return JSON.stringify({ summary: "Test handoff", status: "completed", artifacts: [] });
  });
  const started = await studio.dispatch("run.start", { projectId: "project", flowId: settings.activeFlowId, brief: "Test permissions", commandId: "start" }) as Run;
  const edited = studio.settings(); edited.agents[0].permissionLevel = "read-only";
  await studio.dispatch("settings.save", { state: edited, revision: 0 });
  assert.equal(store.run(started.id)!.steps[0].agent.permissionLevel, "project");
  release();
  let current: Run | null | undefined;
  for (let i = 0; i < 200; i++) { current = store.run(started.id); if (current?.status === "waiting_approval" || current?.status === "failed") break; await delay(10); }
  assert.equal(current?.status, "waiting_approval", current?.note);
  assert.equal(current.approved, false); assert.equal(current.approval?.stepId, current.steps[1].id);
  await studio.dispatch("run.control", { id: current.id, action: "approve", approvalId: current.approval!.id });
  for (let i = 0; i < 200; i++) { current = store.run(started.id); if (current?.status === "succeeded" || current?.status === "failed") break; await delay(10); }
  assert.equal(current?.status, "succeeded", current?.note);
  assert.equal(studio.settings().agents[0].permissionLevel, "read-only");
});
