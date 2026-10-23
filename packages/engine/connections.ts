import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { CodexHost, claudeBinary, codexBinary, runtimeEnvironment, supportsFastMode, type Wire } from "./codex.ts";
import { now, type Agent, type Connection, type SubscriptionUsage } from "../contracts/index.ts";
import { Store } from "./store.ts";
const exec = promisify(execFile);
const inputSchema = z.object({ provider: z.enum(["codex", "claude"]), auth: z.enum(["subscription", "api"]), apiKey: z.string().min(10).max(512).optional() });
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;

export function subscriptionUsage(provider: "codex" | "claude", input: unknown): SubscriptionUsage {
  const data = record(input), windows: SubscriptionUsage["windows"] = [];
  const add = (name: string, used: unknown, reset: unknown) => {
    if (typeof used !== "number" || !Number.isFinite(used)) return;
    const time = typeof reset === "number" ? reset * 1000 : typeof reset === "string" ? Date.parse(reset) : NaN;
    const date = new Date(time);
    windows.push({ label: name, remainingPercent: Math.max(0, Math.min(100, 100 - used)), ...(Number.isFinite(date.getTime()) ? { resetsAt: date.toISOString() } : {}) });
  };
  if (provider === "codex") {
    const buckets = Object.entries(record(data.rateLimitsByLimitId));
    for (const [id, value] of buckets.length ? buckets : [["codex", data.rateLimits]]) {
      const bucket = record(value), name = label(bucket.limitName) || label(bucket.limitId) || String(id);
      for (const key of ["primary", "secondary"]) {
        const window = record(bucket[key]), minutes = window.windowDurationMins;
        let duration = key === "primary" ? "Primary window" : "Secondary window";
        if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) {
          duration = minutes % 1440 === 0 ? `${minutes / 1440}-day window` : minutes % 60 === 0 ? `${minutes / 60}-hour window` : `${minutes}-minute window`;
        }
        add(`${name} / ${duration}`, window.usedPercent, window.resetsAt);
      }
    }
  } else if (data.rate_limits_available === true) {
    const limits = record(data.rate_limits);
    for (const [key, name] of Object.entries({ five_hour: "5-hour window", seven_day: "Weekly / all models", seven_day_opus: "Weekly / Opus", seven_day_sonnet: "Weekly / Sonnet", seven_day_oauth_apps: "Weekly / OAuth apps" })) {
      const window = record(limits[key]); add(name, window.utilization, window.resets_at);
    }
    for (const value of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
      const window = record(value), name = label(window.display_name);
      if (name && !windows.some(item => item.label === `Weekly / ${name}`)) add(`Weekly / ${name}`, window.utilization, window.resets_at);
    }
  }
  return { status: windows.length ? "available" : "unavailable", checkedAt: now(), windows, ...(windows.length ? {} : { message: "The runtime did not provide usage limits. Refresh to try again." }) };
}

export class Connections {
  private keys = new Map<string, string>();
  private hosts = new Map<string, CodexHost>();
  private logins = new Map<string, ChildProcess>();
  constructor(readonly store: Store, readonly socketDir: string) {
    const saved = this.list().map(c => ({ ...c, connected: false, account: undefined, usage: undefined, error: c.auth === "api" ? "Enter your API key again after a runner restart." : "Check the local runtime to reconnect." }));
    this.store.set("connections", saved);
  }
  list(): Connection[] { return this.store.get<Connection[]>("connections") ?? []; }
  private save(connection: Connection) {
    const list = this.list(), index = list.findIndex(c => c.id === connection.id);
    if (index < 0) list.push(connection); else list[index] = connection;
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
        connection.modelDetails = data.filter((model: Wire) => connection.models.includes(model.model || model.id)).map((model: Wire) => ({ value: model.model || model.id, displayName: model.displayName || model.model || model.id, supportsFastMode: supportsFastMode(model) }));
        if (input.auth === "subscription") {
          connection.account = { email: label(account.email), plan: label(account.planType) };
          try { connection.usage = subscriptionUsage("codex", await host.client.call("account/rateLimits/read", {}, 15000)); }
          catch { connection.usage = subscriptionUsage("codex", null); }
        }
      } else if (input.auth === "subscription") {
        const result = await exec(claudeBinary, ["auth", "status"], { env: runtimeEnvironment(), timeout: 15000 });
        const status = JSON.parse(result.stdout);
        if (!status.loggedIn || status.authMethod !== "claude.ai") throw new Error("Sign in to Claude Code with your subscription first.");
        connection.account = { email: label(status.email), plan: label(status.subscriptionType), organization: label(status.orgName) };
        const details = await this.claudeDetails();
        connection.modelDetails = details.models;
        connection.models = connection.modelDetails.map(model => model.value);
        connection.usage = details.usage;
      }
      connection.connected = true;
    } catch (error) { connection.error = this.redact((error as Error).message); }
    return this.save(connection);
  }
  private async claudeDetails() {
    const requestId = randomUUID(), usageId = randomUUID();
    const execution = exec(claudeBinary, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--settings", '{"disableAllHooks":true}'], { cwd: this.socketDir, env: runtimeEnvironment(), timeout: 20000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    // These control requests submit no inference prompt and skip the transcript scan.
    execution.child.stdin!.end([
      { type: "control_request", request_id: requestId, request: { subtype: "initialize" } },
      { type: "control_request", request_id: usageId, request: { subtype: "get_usage", skip_behaviors: true } },
    ].map(request => JSON.stringify(request)).join("\n") + "\n");
    let stdout: string;
    try { ({ stdout } = await execution); }
    catch (error) {
      const partial = (error as { stdout?: string }).stdout;
      if (!partial) throw error;
      stdout = partial;
    }
    const events = stdout.split("\n").filter(line => line.trim()).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const response = events.find(event => event.type === "control_response" && event.response?.request_id === requestId)?.response;
    if (response?.subtype !== "success") throw new Error("Claude Code could not report its model catalog. Check the connection again.");
    const models = z.array(z.object({ value: z.string().min(1).max(100), displayName: z.string().min(1).max(200), resolvedModel: z.string().max(100).optional() })).min(1).max(200).parse(response.response?.models);
    const usage = events.find(event => event.type === "control_response" && event.response?.request_id === usageId)?.response;
    return { models, usage: subscriptionUsage("claude", usage?.subtype === "success" ? usage.response : null) };
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
    return this.save({ ...connection, connected: false, account: undefined, usage: undefined, error: undefined });
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
