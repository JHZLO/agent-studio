import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
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

test("Bypass permissions allow file access and real shell writes outside the project without approval", async t => {
  const { root, run, tools, requests } = await fixture(t, "bypass");
  assert.equal((await tools.call("studio_write", { path: "../outside.txt", content: "Outside the project" })).success, true);
  assert.equal((await tools.call("studio_read", { path: join(root, "outside.txt") })).result, "Outside the project");
  assert.equal((await tools.call("studio_write", { path: ".env", content: "STUDIO_TEST_FIXTURE=1" })).success, true);
  assert.equal((await tools.call("studio_read", { path: ".env" })).result, "STUDIO_TEST_FIXTURE=1");
  const listing = await tools.call("studio_list", { path: ".", depth: 1 });
  assert((listing.result as string[]).includes(".env"));
  await symlink(root, join(run.cwd, "outside"));
  assert.equal((await tools.call("studio_write", { path: "outside/nested/file.txt", content: "Through a directory link" })).success, true);
  assert.equal(await readFile(join(root, "nested/file.txt"), "utf8"), "Through a directory link");
  const shell = await tools.call("studio_shell", { command: "cat ../outside.txt > ../shell.txt", timeoutSeconds: 5, background: false });
  assert.equal(shell.success, true, JSON.stringify(shell.result));
  assert.equal(await readFile(join(root, "shell.txt"), "utf8"), "Outside the project");
  assert.deepEqual(requests, []); assert.equal(run.approved, false);
});

test("Bypass skips external HTTP approval while tool selection and QA limits remain enforced", async t => {
  const { tools, step, requests } = await fixture(t, "bypass");
  const fetches: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL) => { fetches.push(url.toString()); return new Response("Fixture response", { status: 200 }); });
  const response = await tools.call("studio_http", { url: "https://fixture.test/api", method: "GET", headers: {}, body: "" });
  assert.equal(response.success, true); assert.equal((response.result as { body: string }).body, "Fixture response");
  assert.deepEqual(fetches, ["https://fixture.test/api"]); assert.deepEqual(requests, []);
  assert.equal((await tools.call("studio_http", { url: `http://127.0.0.1:${process.env.AGENT_STUDIO_PORT || "4183"}/api/state`, method: "GET", headers: {}, body: "" })).success, false);
  assert.equal((await tools.call("studio_load_test", { url: "https://fixture.test", vus: 1, seconds: 1 })).success, false);
  assert.equal(fetches.length, 1);
  step.agent.tools = ["read"];
  assert.equal(tools.canWrite, false);
  for (const name of ["studio_write", "studio_shell", "studio_http", "studio_browser"]) await assert.rejects(tools.call(name, {}), /not enabled/);
});

test("Bypass browser QA allows external hostnames and resources without approval", async t => {
  const { tools, step, requests } = await fixture(t, "project");
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(request.url === "/" ? '<h1>External QA fixture</h1><iframe src="http://assets.localhost:PORT/resource"></iframe>'.replace("PORT", String((server.address() as { port: number }).port)) : "External resource");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const input = { action: "goto", selector: "", value: `http://qa.localhost:${(server.address() as { port: number }).port}` };
  assert.equal((await tools.call("studio_browser", input)).success, false);
  step.agent.permissionLevel = "bypass";
  const result = await tools.call("studio_browser", input);
  assert.equal(result.success, true, JSON.stringify(result.result));
  assert.match((result.result as { text: string }).text, /External QA fixture/);
  let resourceLoaded = false;
  for (let i = 0; i < 50; i++) {
    const inspection = await tools.call("studio_browser", { action: "inspect", selector: "", value: "" });
    resourceLoaded = (inspection.result as { network: { url: string; status: number }[] }).network.some(item => item.url.includes("assets.localhost") && item.status === 200);
    if (resourceLoaded) break;
    await delay(20);
  }
  assert(resourceLoaded, "External subresources must use the same bypass policy");
  assert.deepEqual(requests, []);
});

for (const automationLevel of ["project", "bypass"] as const) {
test(`A run freezes ${automationLevel} permissions without skipping the next agent's approval`, async t => {
  const { root, run: base } = await fixture(t);
  const store = new Store(join(root, "state.sqlite")), studio = new Studio(store, root, join(root, "sockets"));
  t.after(async () => { await studio.close(); store.close(); });
  const settings = studio.settings();
  settings.agents = [automationLevel, "ask"].map((level, index) => agentSchema.parse({ ...settings.agents[1], id: `agent-${index}`, permissionLevel: level }));
  settings.flows[0].workflow = settings.agents.map(agent => agent.id);
  settings.projects = [{ id: "project", name: "Fixture", path: base.cwd, execution: { mode: "local", branchName: "" } }];
  settings.skillRoots = []; store.set("settings", settings);
  studio.connections.assertAgent = async () => {};
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(studio as any, "codexTurn", async (_run: Run, step: Step, _prompt: string, tools: Toolbox) => {
    assert.equal(tools.canWrite, true);
    if (step.agent.permissionLevel === automationLevel) {
      if (automationLevel === "bypass") assert.match(_prompt, /Approval prompts are disabled for this agent/);
      await gate;
    }
    return JSON.stringify({ summary: "Test handoff", status: "completed", artifacts: [] });
  });
  const started = await studio.dispatch("run.start", { projectId: "project", flowId: settings.activeFlowId, brief: "Test permissions", commandId: "start" }) as Run;
  const edited = studio.settings(); edited.agents[0].permissionLevel = "read-only";
  await studio.dispatch("settings.save", { state: edited, revision: 0 });
  assert.equal(store.run(started.id)!.steps[0].agent.permissionLevel, automationLevel);
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
}
