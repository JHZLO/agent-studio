import { EventEmitter } from "node:events";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, chmod, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

export type Wire = Record<string, any>;
export const root = resolve(import.meta.dirname, "../..");
export const codexBinary = resolve(root, "node_modules/.bin/codex");
export const claudeBinary = resolve(root, "node_modules/.bin/claude");
export const accountFingerprint = (account: Wire, apiKey?: string) => createHash("sha256").update(JSON.stringify({ type: account.type, identity: apiKey ?? account.email ?? account.id ?? "unknown" })).digest("hex");

export function runtimeEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_.*|TERM|COLORTERM|SSH_AUTH_SOCK|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|SYSTEMROOT|COMSPEC)$/.test(key)));
  return env;
}

export class RpcError extends Error {
  constructor(message: string, readonly code: number, readonly uncertain = false) { super(message); }
}

export class CodexClient extends EventEmitter {
  readonly generation = randomUUID();
  private sequence = 0;
  private pending = new Map<string, { resolve: (value: Wire) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private constructor(readonly socket: WebSocket) {
    super();
    socket.on("message", raw => {
      let message: Wire;
      try { message = JSON.parse(raw.toString()); } catch { this.emit("fault", new Error("Invalid Codex JSON.")); return; }
      if (message.method) this.emit(message.id === undefined ? "notification" : "request", message);
      else {
        const request = this.pending.get(String(message.id));
        if (!request) return;
        clearTimeout(request.timer); this.pending.delete(String(message.id));
        if (message.error) request.reject(new RpcError(message.error.message, message.error.code));
        else request.resolve(message.result ?? {});
      }
    });
    socket.on("error", error => this.emit("fault", error));
    socket.on("close", () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new RpcError("Codex disconnected. Reconcile before retrying a mutation.", -1, true));
      }
      this.pending.clear(); this.emit("disconnected");
    });
  }
  static async connect(socketPath: string) {
    const socket = new WebSocket(`ws+unix://${socketPath}:/`, { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 5000 });
    const client = new CodexClient(socket);
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    await client.call("initialize", { clientInfo: { name: "agent_studio", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: "initialized" }));
    return client;
  }
  call(method: string, params: Wire = {}, timeout = 30000): Promise<Wire> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new RpcError("Codex is disconnected.", -1, true));
    const id = `${this.generation}:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcError(`Codex ${method} timed out.`, -1, true)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  respond(id: string | number, result: Wire) {
    if (this.socket.readyState !== WebSocket.OPEN) throw new RpcError("Approval connection expired.", -1, true);
    this.socket.send(JSON.stringify({ id, result }));
  }
  reject(id: string | number, message: string) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ id, error: { code: -32601, message } }));
  }
  close() { this.socket.close(); }
}

export class CodexHost {
  private constructor(readonly process: ChildProcess, readonly socketPath: string, readonly client: CodexClient) {}
  static async start(socketPath: string, options: { cwd?: string; ephemeralAuth?: boolean } = {}) {
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(socketPath), 0o700);
    const args = ["app-server", "--listen", `unix://${socketPath}`,
      "-c", "features.daemon_auto_start=false", "-c", "features.hooks=false",
      "-c", "features.codex_hooks=false", "-c", "features.plugins=false",
      "-c", "features.apps=false", "-c", "features.connectors=false",
      "-c", "features.multi_agent=false", "-c", "features.memories=false",
      "-c", "features.skip_host_skill_discovery=true", "-c", 'web_search="disabled"'];
    if (options.ephemeralAuth) args.push("-c", 'cli_auth_credentials_store="ephemeral"');
    const child = spawn(codexBinary, args, { cwd: options.cwd ?? root, env: runtimeEnvironment(), stdio: ["ignore", "ignore", "pipe"] });
    let error: Error | undefined;
    let stderr = "";
    child.on("error", value => { error = value; });
    child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    try {
      for (let i = 0; i < 100; i++) {
        if (error) throw error;
        if (child.exitCode !== null) throw new Error(`Codex exited (${child.exitCode}): ${stderr}`);
        if (await stat(socketPath).then(s => s.isSocket(), () => false)) {
          const client = await CodexClient.connect(socketPath);
          await chmod(socketPath, 0o600);
          return new CodexHost(child, socketPath, client);
        }
        await delay(100);
      }
      throw new Error("Codex socket did not become ready.");
    } catch (error) { child.kill("SIGTERM"); throw error; }
  }
  static async attach(socketPath: string, pid: number) {
    if (!await CodexHost.ownsProcess(pid, socketPath)) throw new Error("The saved Codex process no longer owns this socket.");
    const client = await CodexClient.connect(socketPath);
    const process = { pid, exitCode: null } as ChildProcess;
    const host = new CodexHost(process, socketPath, client);
    host.adopted = true;
    return host;
  }
  private adopted = false;
  private static async ownsProcess(pid: number, socketPath: string) {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    const info = await promisify(execFile)("ps", ["-p", String(pid), "-o", "uid=", "-o", "args="], { timeout: 3000 }).catch(() => null);
    if (!info) return false;
    const [uid, ...args] = info.stdout.trim().split(/\s+/);
    return Number(uid) === process.getuid?.() && args.includes("app-server") && args.includes(`unix://${socketPath}`);
  }
  async stop() {
    this.client.close();
    if (this.adopted) {
      const pid = this.process.pid!;
      if (!await CodexHost.ownsProcess(pid, this.socketPath)) return;
      try { process.kill(pid, "SIGTERM"); } catch { return; }
      for (let i = 0; i < 30; i++) { if (!await CodexHost.ownsProcess(pid, this.socketPath)) return; await delay(100); }
      if (await CodexHost.ownsProcess(pid, this.socketPath)) try { process.kill(pid, "SIGKILL"); } catch {}
      return;
    }
    if (this.process.exitCode !== null) return;
    const exited = new Promise<void>(resolve => this.process.once("exit", () => resolve()));
    this.process.kill("SIGTERM");
    const timer = setTimeout(() => this.process.kill("SIGKILL"), 3000);
    await exited; clearTimeout(timer);
  }
}
