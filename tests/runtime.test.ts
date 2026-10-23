import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { initialState } from "../packages/contracts/defaults.js";
import type { Run } from "../packages/contracts/index.ts";
import { CodexHost } from "../packages/engine/codex.ts";

async function directory(t: test.TestContext) { const path = await realpath(await mkdtemp(join(tmpdir(), "studio-runtime-"))); t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function listen(server: Server) { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return (server.address() as { port: number }).port; }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
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
