import { readFile, readdir, realpath, stat, lstat, readlink, mkdir, open, writeFile } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { chromium, type Browser, type Page } from "@playwright/test";
import { z } from "zod";
import { contained, git, secretPath } from "./projects.ts";
import { hash } from "./store.ts";
import { codexBinary, runtimeEnvironment, root, type Wire } from "./codex.ts";
import type { Run, Step, Artifact } from "../contracts/index.ts";

type Context = { artifact?: (id: string) => Artifact | undefined; delegate?: (name: string, input: Wire, signal: AbortSignal) => Promise<unknown>; run: Run; step: Step; save: (kind: string, detail?: unknown) => void; approval: (kind: "shell" | "network" | "write", description: string, details: string) => Promise<boolean>; redact: (text: string) => string };
export type Receipt = { id: string; tool: string; input: unknown; output: unknown; at: string; codeReference: string; success: boolean };
const object = (properties: Wire, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string" };
const delegationSpecs = [
  { name: "studio_delegate", description: "Start an independent child task using an allowed frozen agent preset. Returns immediately. Use read for analysis or write for isolated implementation or test execution with the enabled tools. Never delegate dependent work before its inputs exist. Depth is limited to one.", inputSchema: object({ agentId: string, task: string, mode: { type: "string", enum: ["read", "write"] } }, ["agentId", "task", "mode"]) },
  { name: "studio_delegations", description: "Read child status, bounded summaries and evidence references. Set wait=true to wait up to 30 seconds for active children. Read artifacts for full evidence. A child result is not integrated until collected.", inputSchema: object({ wait: { type: "boolean" } }, ["wait"]) },
  { name: "studio_collect", description: "Accept a completed child result or discard it with a reason. Accept integrates an isolated write diff only if affected parent files have not changed. After accepting writes, run combined tests in the parent. Every child must be accepted or discarded before handoff.", inputSchema: object({ id: string, action: { type: "string", enum: ["accept", "discard"] }, reason: string }, ["id", "action", "reason"]) },
];
const specs = [
  { name: "studio_list", permission: "read", description: "List files allowed by the agent's permission level. Generated files and symlinks are omitted.", inputSchema: object({ path: string, depth: { type: "integer", minimum: 1, maximum: 3 } }, ["path", "depth"]) },
  { name: "studio_read", permission: "read", description: "Read a UTF-8 file allowed by the agent's permission level. Relative paths start at the project. Content is limited to 256 KB.", inputSchema: object({ path: string }, ["path"]) },
  { name: "studio_artifact", permission: "read", description: "Read a previous role's full handoff or recorded evidence by artifact ID. Use offset to read long reports in 16000 character pages.", inputSchema: object({ id: string, offset: { type: "integer", minimum: 0 } }, ["id", "offset"]) },
  { name: "studio_write", permission: "write", description: "Create or replace a file with its full contents. File access and approval follow the agent's permission level.", inputSchema: object({ path: string, content: string }, ["path", "content"]) },
  { name: "studio_shell", permission: "shell", description: "Run a shell command with the agent's approval and sandbox settings. Set background=true only for a local test server. Do not deploy, push, or target production unless the task authorizes it. Foreground timeout is at most 120 seconds.", inputSchema: object({ command: string, timeoutSeconds: { type: "integer", minimum: 1, maximum: 120 }, background: { type: "boolean" } }, ["command", "timeoutSeconds", "background"]) },
  { name: "studio_http", permission: "shell", description: "Call an HTTP test API and record actual status and response. Redirects are not followed. External target approval follows the agent's permission level.", inputSchema: object({ url: string, method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }, body: string, headers: { type: "object", additionalProperties: { type: "string" } } }, ["url", "method", "body", "headers"]) },
  { name: "studio_browser", permission: "browser", description: "Use an isolated Playwright Chromium browser for QA. Actions: goto (URL), inspect (text, controls, recent HTTP statuses and errors), fill (selector,value), click (selector), press (selector,value), assertText (wait for value), screenshot. Reuse the same page between calls. Inspect after visible feedback to verify its network status.", inputSchema: object({ action: { type: "string", enum: ["goto", "inspect", "fill", "click", "press", "assertText", "screenshot"] }, selector: string, value: string }, ["action", "selector", "value"]) },
  { name: "studio_load_test", permission: "shell", description: "Run a bounded k6 GET load test against a loopback HTTP endpoint. Maximum 5 virtual users and 10 seconds. Requires the locally installed k6 executable.", inputSchema: object({ url: string, vus: { type: "integer", minimum: 1, maximum: 5 }, seconds: { type: "integer", minimum: 1, maximum: 10 } }, ["url", "vus", "seconds"]) },
] as const;
export const enabledTools = (step: Step) => step.agent.tools.filter(tool => step.agent.permissionLevel !== "read-only" || tool === "read");
export const toolSpecs = (step: Step) => [...specs.filter(spec => enabledTools(step).includes(spec.permission)).map(({ permission, ...spec }) => spec), ...(step.agent.delegation?.enabled ? delegationSpecs : [])].map(spec => ({ type: "function", ...spec }));

export async function codeReference(cwd: string, snapshot = false) {
  const head = await git(cwd, ["rev-parse", "--verify", "HEAD"]);
  const changed = await git(cwd, ["diff", "--relative", "--name-only", "-z", ...(head ? ["HEAD"] : [])]);
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const tracked = head && !snapshot ? "" : await git(cwd, ["ls-files", "-z"]);
  const files = new Set([changed, untracked, tracked].filter(Boolean).flatMap(value => value!.split("\0")).filter(Boolean));
  if (changed === null) {
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || ["node_modules", "target", "dist", "build", "coverage"].includes(entry.name)) continue;
        const path = join(directory, entry.name);
        if (secretPath(path)) continue;
        if (entry.isDirectory()) await walk(path); else files.add(relative(cwd, path));
        if (files.size > 20000) throw new Error("This non-Git project is too large to fingerprint. Use a Git project with ignored build files.");
      }
    };
    await walk(cwd);
  }
  const content: string[] = [];
  for (const path of [...files].sort()) {
    if (secretPath(path)) continue;
    try {
      const file = resolve(cwd, path), info = await lstat(file);
      if (info.isSymbolicLink()) { content.push(`${path}:link:${await readlink(file)}`); continue; }
      if (!info.isFile() || !contained(cwd, await realpath(file))) continue;
      const digest = createHash("sha256"); for await (const chunk of createReadStream(file)) digest.update(chunk);
      content.push(`${path}:${info.mode}:${digest.digest("hex")}`);
    } catch { content.push(`${path}:unavailable`); }
  }
  return hash(JSON.stringify({ head: snapshot ? null : head, content }));
}

export class Toolbox {
  readonly receipts: Receipt[] = [];
  private processes = new Set<ChildProcess>();
  private foreground = new Set<ChildProcess>();
  private calls = new Set<Promise<unknown>>();
  private serial: Promise<unknown> = Promise.resolve();
  private abort = new AbortController();
  private browser?: Browser;
  private page?: Page;
  private network: { url: string; method: string; status: number }[] = [];
  private browserErrors: string[] = [];
  private disposed = false;
  private evidenceBytes = 0;
  readonly frozenFiles = new Map<string, string>();
  constructor(readonly context: Context, readonly artifactDir: string) {}
  private get cwd() { return this.context.step.workspace ?? this.context.run.cwd; }
  get bypassPermissions() { return this.context.step.agent.permissionLevel === "bypass"; }
  get canWrite() { return enabledTools(this.context.step).includes("write") && (this.bypassPermissions || this.context.step.agent.permissionLevel === "project" || this.context.run.approved); }
  private async file(raw: string, create = false) {
    if (raw.length > 4096) throw new Error("This path exceeds the file access limit.");
    const target = resolve(this.cwd, raw);
    if (this.bypassPermissions) return target;
    if (secretPath(raw)) throw new Error("This path is excluded from agent file access.");
    if (!contained(this.cwd, target)) throw new Error("Files must stay inside the selected project.");
    let ancestor = target;
    while (!await stat(ancestor).then(() => true, () => false)) {
      if (!create || ancestor === dirname(ancestor)) throw new Error("File not found.");
      ancestor = dirname(ancestor);
    }
    if (!contained(this.cwd, await realpath(ancestor))) throw new Error("Symlink escapes the project.");
    return target;
  }
  private async target(raw: string, allowExternal = true) {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP URL without embedded credentials.");
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (local && url.port === (process.env.AGENT_STUDIO_PORT || "4183")) throw new Error("QA tools cannot target the Studio control service.");
    if (!local && (!allowExternal || (!this.bypassPermissions && !await this.context.approval("network", "Allow this test target?", `${url.origin}\nNo production target is permitted.`)))) throw new Error("The test target was not approved.");
    return url;
  }
  call(name: string, raw: unknown) {
    const pending = this.serial.catch(() => {}).then(() => this.recordCall(name, raw)).finally(() => this.calls.delete(pending));
    this.serial = pending;
    this.calls.add(pending);
    return pending;
  }
  private async recordCall(name: string, raw: unknown) {
    const spec = specs.find(spec => spec.name === name);
    if ((!spec || !enabledTools(this.context.step).includes(spec.permission)) && !(this.context.delegate && this.context.step.agent.delegation?.enabled && delegationSpecs.some(item => item.name === name))) throw new Error("This tool is not enabled for the agent.");
    if (this.disposed) throw new Error("The run is no longer accepting tool calls.");
    this.abort.signal.throwIfAborted();
    if (this.receipts.length >= 100 || this.evidenceBytes > 1024 * 1024) throw new Error("This step reached its tool evidence budget. Return a handoff with any remaining work; do not repeat this call.");
    const input = z.record(z.string(), z.unknown()).parse(raw);
    const id = randomUUID(), at = new Date().toISOString();
    let output: unknown, success = true;
    try {
      output = await this.execute(name, input);
      if (output && typeof output === "object" && "exitCode" in output && output.exitCode !== 0) success = false;
    } catch (error) { success = false; output = { error: this.context.redact((error as Error).message) }; }
    const receipt = { id, tool: name, input: JSON.parse(this.context.redact(JSON.stringify(input))), output, success, at, codeReference: await codeReference(this.cwd, !!this.context.step.workspace) };
    this.evidenceBytes += Buffer.byteLength(JSON.stringify(receipt));
    this.receipts.push(receipt);
    const text = this.context.redact(JSON.stringify({ receiptId: id, tool: name, ...input, result: output }, null, 2));
    this.context.step.messages.push({ id, type: "tool", text: text.slice(0, 24000), time: at });
    this.context.save("tool.completed", receipt);
    return { receiptId: id, success, result: output };
  }
  private async execute(name: string, input: Wire): Promise<unknown> {
    if (delegationSpecs.some(spec => spec.name === name)) return this.context.delegate!(name, input, this.abort.signal);
    if (name === "studio_artifact") {
      const { id, offset } = z.object({ id: z.string(), offset: z.number().int().min(0) }).parse(input);
      const artifact = this.context.run.artifacts.find(item => item.id === id) ?? this.context.artifact?.(id);
      if (!artifact) throw new Error("Artifact not found in this run.");
      return { name: artifact.name, codeReference: artifact.codeReference, content: artifact.content.slice(offset, offset + 16000), nextOffset: offset + 16000 < artifact.content.length ? offset + 16000 : null };
    }
    if (name === "studio_list") {
      const { path, depth } = z.object({ path: z.string(), depth: z.number().int().min(1).max(3) }).parse(input);
      const target = await this.file(path), files: string[] = [];
      const walk = async (dir: string, level: number) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if ((!this.bypassPermissions && (entry.name.startsWith(".") || secretPath(entry.name))) || ["node_modules", "target", "dist", "build"].includes(entry.name) || entry.isSymbolicLink()) continue;
          const path = join(dir, entry.name); files.push(relative(this.cwd, path) + (entry.isDirectory() ? "/" : ""));
          if (files.length > 1000) return;
          if (entry.isDirectory() && level > 1) await walk(path, level - 1);
        }
      };
      await walk(target, depth); return files.slice(0, 1000);
    }
    if (name === "studio_read") {
      const { path } = z.object({ path: z.string() }).parse(input);
      const snapshot = this.frozenFiles.get(resolve(this.cwd, path));
      if (snapshot !== undefined) return snapshot;
      const target = await this.file(path);
      if ((await stat(target)).size > 256 * 1024) throw new Error("Read a smaller file (maximum 256 KB).");
      return this.context.redact(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(target)));
    }
    if (name === "studio_write") {
      const { path, content } = z.object({ path: z.string(), content: z.string().max(256 * 1024) }).parse(input);
      if (!this.canWrite) throw new Error("File writes have not been approved.");
      const target = await this.file(path, true);
      await mkdir(dirname(target), { recursive: true });
      if (!this.bypassPermissions && !contained(this.cwd, await realpath(dirname(target)))) throw new Error("Symlink escapes the project.");
      this.abort.signal.throwIfAborted();
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
      try { await handle.writeFile(content); } finally { await handle.close(); }
      return { path, bytes: Buffer.byteLength(content), hash: hash(content) };
    }
    if (name === "studio_shell") {
      const data = z.object({ command: z.string().min(1).max(10000), timeoutSeconds: z.number().int().min(1).max(120), background: z.boolean() }).parse(input);
      if (this.bypassPermissions) return this.command("/bin/sh", ["-c", data.command], data.timeoutSeconds * 1000, data.background);
      if (this.context.step.agent.permissionLevel !== "project" && !await this.context.approval("shell", "Run this project command?", data.command)) throw new Error("Command was rejected.");
      const writable = this.canWrite;
      const args = ["sandbox", "-P", "agent-studio-command", "-C", this.cwd, "-c", `permissions.agent-studio-command.extends=":${writable ? "workspace" : "read-only"}"`, "-c", "permissions.agent-studio-command.network.enabled=true", "--", "/bin/sh", "-c", data.command];
      return this.command(codexBinary, args, data.timeoutSeconds * 1000, data.background);
    }
    if (name === "studio_http") {
      const data = z.object({ url: z.string(), method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]), body: z.string().max(64000), headers: z.record(z.string(), z.string()).refine(headers => !Object.keys(headers).some(key => /^(authorization|cookie|host|proxy-)/i.test(key)), "Credential and routing headers are not accepted by this test tool.") }).parse(input);
      const url = await this.target(data.url);
      const response = await fetch(url, { method: data.method, headers: data.headers, body: data.body && data.method !== "GET" ? data.body : undefined, redirect: "manual", signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]) });
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0, truncated = false;
      if (reader) try { while (true) { const next = await reader.read(); if (next.done) break; chunks.push(next.value.subarray(0, Math.max(0, 64000 - size))); size += next.value.byteLength; if (size > 64000) { truncated = true; break; } } } finally { await reader.cancel(); }
      const body = Buffer.concat(chunks).toString("utf8");
      return { url: url.toString(), status: response.status, headers: Object.fromEntries([...response.headers].filter(([key]) => !/cookie|authorization/i.test(key))), body: this.context.redact(body), truncated };
    }
    if (name === "studio_browser") return this.browserAction(input);
    if (name === "studio_load_test") {
      const data = z.object({ url: z.string(), vus: z.number().int().min(1).max(5), seconds: z.number().int().min(1).max(10) }).parse(input);
      const url = await this.target(data.url, false);
      await mkdir(this.artifactDir, { recursive: true, mode: 0o700 });
      const script = join(this.artifactDir, `k6-${randomUUID()}.js`);
      await writeFile(script, `import http from 'k6/http'; import {check,sleep} from 'k6'; export const options={vus:${data.vus},duration:'${data.seconds}s',maxRedirects:0,thresholds:{http_req_failed:['rate<0.01'],checks:['rate==1']}}; export default function(){const r=http.get(${JSON.stringify(url.toString())});check(r,{'status below 400':r=>r.status<400});sleep(0.2);}`, { mode: 0o600 });
      return this.command(process.env.AGENT_STUDIO_K6 || join(root, ".local/tools/k6"), ["run", "--no-usage-report", "--summary-mode=full", script], 20000, false);
    }
    throw new Error("Unknown tool.");
  }
  private async command(binary: string, args: string[], timeout: number, background: boolean) {
    this.abort.signal.throwIfAborted();
    const process = spawn(binary, args, { cwd: this.cwd, env: runtimeEnvironment(), stdio: ["ignore", "pipe", "pipe"], detached: true });
    this.processes.add(process);
    this.foreground.add(process);
    let text = "";
    process.stdout?.on("data", chunk => { text = (text + chunk).slice(-64000); });
    process.stderr?.on("data", chunk => { text = (text + chunk).slice(-64000); });
    const stop = () => { if (process.pid) { try { globalThis.process.kill(-process.pid, "SIGTERM"); } catch {} setTimeout(() => { if (process.exitCode === null) try { globalThis.process.kill(-process.pid!, "SIGKILL"); } catch {} }, 2000).unref(); } };
    return new Promise((resolve, reject) => {
      let returned = false;
      const timer = setTimeout(stop, background ? 600000 : timeout);
      process.once("error", error => { clearTimeout(timer); this.processes.delete(process); this.foreground.delete(process); reject(error); });
      process.once("exit", (code, signal) => { clearTimeout(timer); this.processes.delete(process); this.foreground.delete(process); if (!returned) resolve({ exitCode: code, signal, output: this.context.redact(text) }); });
      if (background) setTimeout(() => { if (process.exitCode === null && process.signalCode === null && process.pid) { returned = true; this.foreground.delete(process); resolve({ pid: process.pid, background: true, output: this.context.redact(text), lifetimeSeconds: 600 }); } }, 800);
    });
  }
  private async browserAction(raw: Wire) {
    this.abort.signal.throwIfAborted();
    const { action, selector, value } = z.object({ action: z.enum(["goto", "inspect", "fill", "click", "press", "assertText", "screenshot"]), selector: z.string().max(2000), value: z.string().max(10000) }).parse(raw);
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
      if (this.abort.signal.aborted) { await this.browser.close(); this.browser = undefined; throw this.abort.signal.reason; }
      const context = await this.browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: false, serviceWorkers: "block" });
      await context.route("**/*", async route => {
        try { await this.target(route.request().url(), this.bypassPermissions); await route.continue(); } catch { await route.abort(); }
      });
      this.page = await context.newPage(); this.page.setDefaultTimeout(10000);
      this.page.on("response", response => { this.network.push({ url: response.url(), method: response.request().method(), status: response.status() }); this.network = this.network.slice(-40); });
      this.page.on("pageerror", error => { this.browserErrors.push(this.context.redact(error.message)); this.browserErrors = this.browserErrors.slice(-20); });
    }
    this.abort.signal.throwIfAborted();
    const page = this.page!;
    if (action === "goto") { const url = await this.target(value, this.bypassPermissions); await page.goto(url.toString(), { waitUntil: "domcontentloaded" }); }
    if (action === "fill") await page.locator(selector).fill(value);
    if (action === "click") await page.locator(selector).click();
    if (action === "press") await page.locator(selector || "body").press(value);
    if (action === "assertText") await page.getByText(value, { exact: false }).first().waitFor({ state: "visible" });
    if (action === "screenshot") {
      await mkdir(this.artifactDir, { recursive: true, mode: 0o700 });
      const id = randomUUID(), mediaPath = join(this.artifactDir, `${id}.png`);
      await page.screenshot({ path: mediaPath, fullPage: true });
      const artifact: Artifact = { id, name: `browser-${id.slice(0, 8)}.png`, type: "Screenshot", content: `Captured from ${page.url()}`, agent: this.context.step.agent.name, stepId: this.context.step.id, mediaPath, mime: "image/png", codeReference: await codeReference(this.cwd, !!this.context.step.workspace), verified: true };
      this.context.run.artifacts.push(artifact); this.context.save("artifact.created", { id });
      return { artifactId: id, url: page.url() };
    }
    return { url: page.url(), title: await page.title(), text: (await page.locator("body").innerText()).slice(0, 16000), network: this.network, errors: this.browserErrors, controls: await page.locator("input,button,a,select,textarea,[role=status]").evaluateAll(elements => elements.slice(0, 100).map(element => ({ tag: element.tagName, id: element.id, name: element.getAttribute("name"), text: element.textContent?.slice(0, 100), label: element.getAttribute("aria-label"), labels: "labels" in element ? Array.from((element as HTMLInputElement).labels ?? []).map(label => label.textContent) : [], describedBy: element.getAttribute("aria-describedby"), invalid: element.getAttribute("aria-invalid"), role: element.getAttribute("role"), focused: element === document.activeElement, type: element.getAttribute("type") }))) };
  }
  async interrupt() {
    this.abort.abort(new Error("Tool interrupted by a new instruction."));
    for (const child of this.foreground) if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    await this.browser?.close(); this.browser = undefined; this.page = undefined;
    await Promise.allSettled([...this.calls]);
  }
  resume() {
    if (this.disposed || this.calls.size) throw new Error("Previous tool calls have not stopped.");
    this.abort = new AbortController();
  }
  async close() {
    this.disposed = true;
    for (const child of this.processes) if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    await this.interrupt();
  }
}
