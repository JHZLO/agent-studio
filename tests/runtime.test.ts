import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Toolbox, codeReference } from "../packages/engine/tools.ts";
import { initialState } from "../packages/contracts/defaults.js";
import type { Run } from "../packages/contracts/index.ts";
import { CodexHost } from "../packages/engine/codex.ts";

async function directory(t: test.TestContext) { const path = await realpath(await mkdtemp(join(tmpdir(), "studio-runtime-"))); t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function listen(server: Server) { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return (server.address() as { port: number }).port; }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
function toolbox(path: string) {
  const step = { id: "qa", agent: { ...initialState().agents[4], tools: ["read", "shell", "browser"] }, status: "running", sessionId: "s", messages: [], receivedArtifacts: [] } as Run["steps"][number];
  const run = { id: "test", cwd: join(path, "project"), approved: false, artifacts: [], steps: [step] } as unknown as Run;
  return new Toolbox({ run, step, save: () => {}, approval: async () => false, redact: value => value }, join(path, "evidence"));
}
test("Non-Git fingerprints detect edits and binary replacements", async t => {
  const path = await directory(t); await writeFile(join(path, "file.bin"), Buffer.from([0, 1, 2]));
  const before = await codeReference(path); await writeFile(join(path, "file.bin"), Buffer.from([0, 2, 2]));
  assert.notEqual(await codeReference(path), before);
});
test("Real browser and HTTP tools retain network, accessibility and screenshot evidence", async t => {
  const path = await directory(t); await mkdir(join(path, "project"));
  const app = createServer((request, response) => {
    if (request.url === "/api") { response.writeHead(201, { "content-type": "application/json" }); response.end('{"message":"Saved"}'); return; }
    if (request.url === "/large") { response.end("a".repeat(100000)); return; }
    response.setHeader("content-type", "text/html"); response.end('<!doctype html><title>Tool fixture</title><label for="name">Name</label><input id="name" aria-describedby="result"><button id="save">Save</button><p id="result" role="status"></p><script>save.onclick=async()=>{const r=await fetch("/api",{method:"POST"});document.querySelector("#result").textContent=(await r.json()).message}</script>');
  });
  const port = await listen(app); t.after(() => close(app));
  const tools = toolbox(path); t.after(() => tools.close());
  const call = async (action: string, selector = "", value = "") => { const receipt = await tools.call("studio_browser", { action, selector, value }); assert.equal(receipt.success, true, JSON.stringify(receipt.result)); return receipt.result as any; };
  await call("goto", "", `http://127.0.0.1:${port}`); await call("fill", "#name", "Reader"); await call("click", "#save");
  const result = await call("assertText", "", "Saved");
  assert(result.network.some((entry: any) => entry.method === "POST" && entry.status === 201));
  assert.deepEqual(result.controls.find((entry: any) => entry.id === "name").labels, ["Name"]);
  await call("screenshot"); assert.equal(tools.context.run.artifacts[0].mime, "image/png");
  assert((await readFile(tools.context.run.artifacts[0].mediaPath!)).byteLength > 1000);
  const large = await tools.call("studio_http", { url: `http://127.0.0.1:${port}/large`, method: "GET", headers: {}, body: "" });
  assert.equal((large.result as any).body.length, 64000); assert.equal((large.result as any).truncated, true);
  assert.equal((await tools.call("studio_http", { url: "http://127.0.0.1:4183/api/bootstrap", method: "GET", headers: {}, body: "" })).success, false);
  assert.equal((await tools.call("studio_http", { url: "https://example.test", method: "GET", headers: {}, body: "" })).success, false);
});
test("k6 runs a bounded local test and refuses an excessive workload", async t => {
  const path = await directory(t); await mkdir(join(path, "project"));
  const app = createServer((_request, response) => response.end("OK")), port = await listen(app); t.after(() => close(app));
  const tools = toolbox(path); t.after(() => tools.close());
  const result = await tools.call("studio_load_test", { url: `http://127.0.0.1:${port}`, vus: 1, seconds: 1 });
  assert.equal(result.success, true, JSON.stringify(result.result)); assert.equal((result.result as any).exitCode, 0);
  assert.match((result.result as any).output, /http_reqs/);
  assert.equal((await tools.call("studio_load_test", { url: `http://127.0.0.1:${port}`, vus: 100, seconds: 60 })).success, false);
});
test("A recovered Codex host retains identity and stops its owned process", { timeout: 15000 }, async t => {
  const path = await mkdtemp("/tmp/studio-host-");
  const host = await CodexHost.start(join(path, "codex.sock"));
  t.after(async () => { await host.stop(); await rm(path, { recursive: true, force: true }); });
  await assert.rejects(CodexHost.attach(host.socketPath, process.pid), /no longer owns/);
  const recovered = await CodexHost.attach(host.socketPath, host.process.pid!);
  assert.equal(recovered.process.pid, host.process.pid);
  const exited = new Promise(resolve => host.process.once("exit", resolve));
  await recovered.stop(); await exited;
  assert.notEqual(host.process.exitCode, undefined);
});
test("Local API enforces Host, Origin, cookie and CSRF and keeps the runner after API exit", { timeout: 30000 }, async t => {
  const path = await directory(t), reserve = createServer(); const port = await listen(reserve); await close(reserve);
  const env = { ...process.env, AGENT_STUDIO_DATA_DIR: path, AGENT_STUDIO_PORT: String(port) };
  const api = spawn(process.execPath, ["--import", "tsx", "apps/server/main.ts"], { cwd: process.cwd(), env, stdio: "ignore" });
  let runnerPid: number | undefined;
  t.after(async () => {
    api.kill("SIGTERM"); if (runnerPid) try { process.kill(runnerPid, "SIGTERM"); } catch {}
    for (let i = 0; i < 50; i++) { try { await readFile(join(path, "runner.lock")); await delay(100); } catch { break; } }
  });
  const origin = `http://127.0.0.1:${port}`;
  let response: Response | undefined;
  for (let i = 0; i < 100; i++) { try { response = await fetch(origin + "/api/bootstrap"); if (response.ok) break; } catch {} await delay(100); }
  assert(response?.ok, "API must start");
  runnerPid = JSON.parse(await readFile(join(path, "runner.lock"), "utf8")).pid;
  const cookie = response.headers.getSetCookie()[0].split(";")[0]; const bootstrap = await response.json();
  assert.equal((await fetch(origin + "/api/state")).status, 401);
  const wrongHost = await new Promise(resolve => { const request = httpRequest(origin + "/api/bootstrap", { headers: { Host: "attacker.test" } }, response => { response.resume(); resolve(response.statusCode); }); request.on("error", error => { throw error; }); request.end(); });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(origin + "/api/bootstrap", { headers: { Origin: "https://attacker.test" } })).status, 403);
  const body = JSON.stringify({ state: bootstrap.state, revision: bootstrap.state.revision, commandId: randomUUID() });
  const headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json" };
  assert.equal((await fetch(origin + "/api/settings", { method: "POST", headers, body })).status, 403);
  assert.equal((await fetch(origin + "/api/settings", { method: "POST", headers: { ...headers, "X-Studio-CSRF": bootstrap.csrf }, body })).status, 200);
  const again = await fetch(origin + "/api/settings", { method: "POST", headers: { ...headers, "X-Studio-CSRF": bootstrap.csrf }, body });
  assert.deepEqual(await again.json(), { revision: 1 });
  const sse = await fetch(origin + "/api/events", { headers: { Cookie: cookie } }); const reader = sse.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /connected/);
  const exited = new Promise(resolve => api.once("exit", resolve)); api.kill("SIGTERM"); await exited; await reader.cancel();
  process.kill(runnerPid!, 0);
  assert.equal(JSON.parse(await readFile(join(path, "runner.lock"), "utf8")).pid, runnerPid);
});
