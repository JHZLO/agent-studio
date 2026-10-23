import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { CodexHost, claudeBinary, codexBinary, runtimeEnvironment } from "./codex.ts";
import { now, type Agent, type Connection } from "../contracts/index.ts";
import { Store } from "./store.ts";
const exec = promisify(execFile);
const inputSchema = z.object({ provider: z.enum(["codex", "claude"]), auth: z.enum(["subscription", "api"]), apiKey: z.string().min(10).max(512).optional() });

export class Connections {
  private keys = new Map<string, string>();
  private hosts = new Map<string, CodexHost>();
  private logins = new Map<string, ChildProcess>();
  constructor(readonly store: Store, readonly socketDir: string) {
    const saved = this.list().map(c => ({ ...c, connected: false, error: c.auth === "api" ? "Enter your API key again after a runner restart." : "Check the local runtime to reconnect." }));
    this.store.set("connections", saved);
  }
  list(): Connection[] { return this.store.get<Connection[]>("connections") ?? []; }
  private save(connection: Connection) {
    const list = this.list().filter(c => c.id !== connection.id); list.push(connection);
    this.store.set("connections", list); return connection;
  }
  key(id: string) {
    const value = this.keys.get(id);
    if (!value) throw new Error("This API connection needs a key. Enter it in Connections.");
    return value;
  }
  redact(text: string) {
    for (const value of this.keys.values()) text = text.replaceAll(value, "[redacted]");
    return text.replace(/\b(?:sk-[\w-]{12,}|Bearer\s+[^\s"']+)/g, "[redacted]");
  }
  async host(id: string) {
    const cached = this.hosts.get(id);
    if (cached && cached.process.exitCode === null && cached.client.socket.readyState === 1) return cached;
    if (cached) await cached.stop();
    const host = await CodexHost.start(join(this.socketDir, `${id}-${randomUUID().slice(0, 8)}.sock`), { ephemeralAuth: id.endsWith("-api") });
    this.hosts.set(id, host);
    if (id.endsWith("-api")) await host.client.call("account/login/start", { type: "apiKey", apiKey: this.key(id) });
    return host;
  }
  async check(raw: unknown) {
    const input = inputSchema.parse(raw), id = `${input.provider}-${input.auth}`;
    const connection: Connection = { id, provider: input.provider, auth: input.auth, connected: false, models: [], checkedAt: now(), billingMode: input.auth === "api" ? "API usage" : "Subscription", credentialStorage: input.auth === "api" ? "Runner memory (enter again after restart)" : "Official CLI credential store" };
    if (input.apiKey) {
      if (input.auth !== "api") throw new Error("Subscription connections do not accept API keys.");
      this.keys.set(id, input.apiKey);
      const old = this.hosts.get(id); if (old) { await old.stop(); this.hosts.delete(id); }
    }
    try {
      connection.version = (await exec(input.provider === "codex" ? codexBinary : claudeBinary, ["--version"], { env: runtimeEnvironment(), timeout: 10000 })).stdout.trim();
      if (input.auth === "api") {
        const key = this.key(id);
        const response = await fetch(input.provider === "codex" ? "https://api.openai.com/v1/models" : "https://api.anthropic.com/v1/models", {
          headers: input.provider === "codex" ? { Authorization: `Bearer ${key}` } : { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(20000), redirect: "error",
        });
        if (!response.ok) throw new Error(`The provider rejected the connection check (${response.status}). Check the key and account access.`);
        const result = await response.json() as { data: { id: string }[] };
        connection.models = result.data.map(m => m.id).filter(id => input.provider === "claude" || /^gpt-|^codex-/.test(id));
      }
      if (input.provider === "codex") {
        const host = await this.host(id);
        const { account } = await host.client.call("account/read", { refreshToken: false });
        if (account?.type !== (input.auth === "api" ? "apiKey" : "chatgpt")) throw new Error("The official Codex login does not match this billing mode. Sign in with the selected account type.");
        const { data } = await host.client.call("model/list", {});
        const available = data.map((model: { id: string; model?: string }) => model.model || model.id);
        connection.models = input.auth === "subscription" ? available : available.filter((model: string) => connection.models.includes(model));
      } else if (input.auth === "subscription") {
        const result = await exec(claudeBinary, ["auth", "status"], { env: runtimeEnvironment(), timeout: 15000 });
        const status = JSON.parse(result.stdout);
        if (!status.loggedIn || status.authMethod !== "claude.ai") throw new Error("Sign in to Claude Code with your subscription first.");
        connection.models = ["sonnet", "opus", "haiku"];
      }
      connection.connected = true;
    } catch (error) { connection.error = this.redact((error as Error).message); }
    return this.save(connection);
  }
  async login(provider: "codex" | "claude") {
    if (provider === "codex") {
      const host = await this.host("codex-subscription");
      return host.client.call("account/login/start", { type: "chatgpt" });
    }
    if (this.logins.has(provider)) return { pending: true, message: "Complete sign-in in the browser, then check the connection." };
    const child = spawn(claudeBinary, ["auth", "login"], { env: runtimeEnvironment(), stdio: "ignore" });
    this.logins.set(provider, child);
    child.on("error", () => this.logins.delete(provider));
    child.on("exit", () => this.logins.delete(provider));
    const timer = setTimeout(() => child.kill("SIGTERM"), 300000);
    child.once("exit", () => clearTimeout(timer));
    return { pending: true, message: "Complete official Claude Code sign-in in your browser, then check the connection." };
  }
  async disconnect(id: string) {
    const connection = this.list().find(c => c.id === id);
    if (!connection) throw new Error("Connection not found.");
    this.keys.delete(id);
    const host = this.hosts.get(id); if (host) { await host.stop(); this.hosts.delete(id); }
    return this.save({ ...connection, connected: false, error: undefined });
  }
  async assertAgent(agent: Agent) {
    const connection = this.list().find(c => c.id === `${agent.provider}-${agent.auth}`);
    if (!connection?.connected) throw new Error(`${agent.name} needs a connected ${agent.provider} / ${agent.auth} account.`);
    if (agent.model !== "default" && !connection.models.includes(agent.model)) throw new Error(`${agent.model} is not in the available model catalog. Update ${agent.name}.`);
    if (agent.auth === "api") this.key(connection.id);
    if (agent.provider === "codex" && agent.auth === "subscription") {
      const { account } = await (await this.host(connection.id)).client.call("account/read", { refreshToken: false });
      if (account?.type !== "chatgpt") throw new Error("Codex billing mode changed. Reconnect your subscription before running.");
    }
  }
  async close() { for (const host of this.hosts.values()) await host.stop(); this.hosts.clear(); for (const child of this.logins.values()) child.kill("SIGTERM"); this.logins.clear(); this.keys.clear(); }
}
