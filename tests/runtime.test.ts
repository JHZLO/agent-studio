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
