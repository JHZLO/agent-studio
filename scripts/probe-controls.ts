import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { Run } from "../packages/contracts/index.ts";
const target = JSON.parse(await readFile(new URL("../.local/smoke-run.json", import.meta.url), "utf8"));
const origin = target.origin;
const bootstrap = await fetch(`${origin}/api/bootstrap`), cookie = bootstrap.headers.getSetCookie()[0].split(";")[0], { csrf } = await bootstrap.json();
async function call(path: string, input: object) {
  const response = await fetch(`${origin}/api/${path}`, { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "X-Studio-CSRF": csrf }, body: JSON.stringify({ ...input, commandId: randomUUID() }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
}
await call("runs/control", { id: target.runId, action: "pause" });
let run: Run = await call("runs/read", { id: target.runId });
for (let i = 0; i < 600; i++) {
  run = await call("runs/read", { id: target.runId });
  if (run.status === "paused") break;
  if (["failed", "cancelled", "succeeded"].includes(run.status)) throw new Error(`No safe pause boundary: ${run.status}`);
  await delay(500);
}
assert.equal(run.status, "paused");
const step = run.steps[run.index - 1];
const attached = await call("terminal/open", { id: run.id, stepId: step.id });
assert.equal(attached.controlMode, "terminal");
async function observe() {
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/terminal/${run.id}`, { headers: { Cookie: cookie, Origin: origin } });
  let text = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error("No native terminal output.")); }, 20000);
    socket.on("error", reject);
    socket.on("open", () => socket.send(JSON.stringify({ type: "resize", cols: 110, rows: 32 })));
    socket.on("message", raw => { const event = JSON.parse(raw.toString()); if (event.error) { clearTimeout(timeout); reject(new Error(event.error)); socket.close(); } text += event.data ?? ""; if (/Codex|implementation-plan|qa-sheet|review.md/.test(text)) { clearTimeout(timeout); resolve(); socket.close(); } });
  });
  return text.length;
}
const first = await observe(); await delay(300); const second = await observe();
const current = await call("runs/read", { id: run.id }); assert.equal(current.terminal.id, attached.terminal.id); assert.equal(current.terminal.pid, attached.terminal.pid);
await call("terminal/close", { id: run.id });
const restored = await call("runs/read", { id: run.id }); assert.equal(restored.controlMode, "studio"); assert.equal(restored.status, "paused");
assert.equal(restored.steps[run.index - 1].providerThreadId, step.providerThreadId);
await call("runs/control", { id: run.id, action: "resume" });
const proof = { runId: run.id, stepId: step.id, threadId: step.providerThreadId, terminalId: attached.terminal.id, samePtyAfterViewReconnect: true, firstBytes: first, secondBytes: second, returnedControl: true };
await writeFile(new URL("../.local/controls-proof.json", import.meta.url), JSON.stringify(proof, null, 2)); console.log(proof);
