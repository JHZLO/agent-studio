import { mkdir, writeFile, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { rpc } from "./ipc.ts";
import { root } from "./codex.ts";
import type { Run, Step } from "../contracts/index.ts";

export async function openTerminal(run: Run, step: Step, dataDir: string, socketDir: string) {
  if (!step.providerThreadId || !step.socketPath) throw new Error("This Codex session has not started.");
  const id = randomUUID(), socketPath = join(socketDir, `pty-${id.slice(0, 12)}.sock`);
  const directory = join(dataDir, "runs", run.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const configPath = join(directory, `terminal-${id}.json`);
  const config = { id, socketPath, runtimeSocket: step.socketPath, threadId: step.providerThreadId, cwd: step.workspace ?? run.cwd };
  await writeFile(configPath, JSON.stringify(config), { flag: "wx", mode: 0o600 });
  const log = await open(join(directory, `terminal-${id}.log`), "a", 0o600);
  const child = spawn(process.execPath, ["--import", "tsx", join(root, "apps/runner/terminal-host.ts"), configPath], { cwd: root, env: process.env, detached: true, stdio: ["ignore", log.fd, log.fd] }); child.unref(); await log.close();
  for (let i = 0; i < 100; i++) {
    try {
      const state = await rpc("terminal.read", { after: 0 }, randomUUID(), socketPath);
      if (state.id !== id || state.threadId !== step.providerThreadId) throw new Error("Terminal identity mismatch.");
      return { id, stepId: step.id, connected: !state.exited, socketPath, pid: child.pid };
    } catch { await delay(100); }
  }
  if (child.pid) child.kill("SIGTERM");
  throw new Error("The Codex terminal did not start. Inspect its private run log.");
}
export async function terminalCall(run: Run, method: string, input: unknown) {
  if (!run.terminal?.socketPath) throw new Error("No terminal is attached to this run.");
  return rpc(method, input, randomUUID(), run.terminal.socketPath);
}
