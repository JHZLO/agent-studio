import { rpc } from "../packages/engine/ipc.ts";
import { setTimeout as delay } from "node:timers/promises";
const runId = process.argv[2];
if (!runId) throw new Error("Usage: ./studio terminal RUN_ID");
let run = await rpc("run.read", { id: runId });
if (!run.terminal) {
  const step = [...run.steps].reverse().find((step: { providerThreadId?: string }) => step.providerThreadId);
  if (!step) throw new Error("No provider session is available yet.");
  run = await rpc("terminal.open", { id: runId, stepId: step.id });
}
let offset = 0, closed = false;
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdin.on("data", data => { void rpc("terminal.input", { id: runId, text: data.toString() }).catch(() => { closed = true; }); });
const resize = () => rpc("terminal.resize", { id: runId, cols: process.stdout.columns || 110, rows: process.stdout.rows || 32 });
process.stdout.on("resize", () => { void resize(); });
await resize();
try {
  while (!closed) {
    const state = await rpc("terminal.read", { id: runId, after: offset });
    if (state.reset) process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(state.data); offset = state.offset;
    if (state.exited) break;
    await delay(100);
  }
} finally { process.stdin.setRawMode?.(false); process.stdin.pause(); }
console.log("\nTerminal view closed. Return control to Studio from the task page.");
