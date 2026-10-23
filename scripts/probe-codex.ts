import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node-pty";
import { CodexHost, CodexClient, codexBinary, runtimeEnvironment } from "../packages/engine/codex.ts";

const directory = await realpath(await mkdtemp(join(tmpdir(), "as-probe-")));
const host = await CodexHost.start(join(directory, "codex.sock"), { cwd: directory });
let observer: CodexClient | undefined;
try {
  const { account } = await host.client.call("account/read", { refreshToken: false });
  assert.equal(account?.type, "chatgpt", "This probe requires the selected ChatGPT subscription.");
  const catalog = await host.client.call("model/list", {});
  const model = catalog.data.find((item: { isDefault: boolean }) => item.isDefault) ?? catalog.data[0];
  console.log(JSON.stringify({ auth: account.type, plan: account.planType, model: model.id }));
  const started = await host.client.call("thread/start", { cwd: directory, model: model.id, sandbox: "read-only", approvalPolicy: "untrusted", ephemeral: false, config: { "features.shell_tool": false, "features.unified_exec": false, "features.code_mode": false } });
  const threadId = started.thread.id;
  const completed = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Probe turn timed out.")), 120000);
    host.client.on("notification", message => {
      if (message.method === "turn/completed" && message.params.threadId === threadId) { clearTimeout(timer); resolve(message.params.turn); }
    });
    host.client.on("request", message => host.client.reject(message.id, "Tools are not required for this probe."));
  });
  await host.client.call("turn/start", { threadId, effort: "low", input: [{ type: "text", text: "Reply with exactly AGENT_STUDIO_READY. Do not use any tools." }] });
  const turn = await completed;
  assert.equal(turn.status, "completed");
  observer = await CodexClient.connect(host.socketPath);
  const read = await observer.call("thread/read", { threadId, includeTurns: true });
  assert.equal(read.thread.id, threadId);
  assert.equal(read.thread.cwd, directory);
  assert(read.thread.turns.some((item: { id: string }) => item.id === turn.id));
  const resumed = await observer.call("thread/resume", { threadId });
  assert.equal(resumed.thread.id, threadId);
  const terminal = spawn(codexBinary, ["resume", "--remote", `unix://${host.socketPath}`, threadId, "--no-alt-screen"], { cwd: directory, env: { ...runtimeEnvironment(), TERM: "xterm-256color" }, cols: 120, rows: 40 });
  let screen = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { terminal.kill(); reject(new Error("Native TUI did not display the shared conversation.")); }, 30000);
    terminal.onData(data => {
      screen += data;
      if (data.includes("\x1b[6n")) terminal.write("\x1b[1;1R");
      if (data.includes("\x1b]11;?")) terminal.write("\x1b]11;rgb:0000/0000/0000\x07");
      if (screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").includes("AGENT_STUDIO_READY")) { clearTimeout(timer); resolve(); }
    });
    terminal.onExit(event => { clearTimeout(timer); if (!screen.includes("AGENT_STUDIO_READY")) reject(new Error(`Native TUI exited (${event.exitCode}).`)); });
  });
  terminal.kill("SIGTERM");
  const apiHost = await CodexHost.start(join(directory, "api.sock"), { cwd: directory, ephemeralAuth: true });
  try {
    await apiHost.client.call("account/login/start", { type: "apiKey", apiKey: "sk-studio-invalid-isolation-probe-not-a-real-key" });
    assert.equal((await apiHost.client.call("account/read", { refreshToken: false })).account.type, "apiKey");
    assert.equal((await host.client.call("account/read", { refreshToken: false })).account.type, "chatgpt");
  } finally { await apiHost.stop(); }
  const receipt = { at: new Date().toISOString(), provider: "codex", auth: "subscription", threadId, turnId: turn.id, status: turn.status, sameServerSecondClient: true, nativeTuiSharedHistory: true, apiAuthIsolated: true, cwdMatched: true };
  await writeFile(new URL("../.local/codex-probe.json", import.meta.url), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(receipt));
} finally {
  observer?.close(); await host.stop(); await rm(directory, { recursive: true, force: true });
}
