import { readFile, readdir, realpath, stat, lstat, readlink, mkdir, open, writeFile } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { contained, git } from "./projects.ts";
import { hash } from "./store.ts";
import { codexBinary, runtimeEnvironment, root, type Wire } from "./codex.ts";
import type { Run, Step, Artifact } from "../contracts/index.ts";

type Context = { run: Run; step: Step; save: (kind: string, detail?: unknown) => void; approval: (kind: "shell" | "network" | "write", description: string, details: string) => Promise<boolean>; redact: (text: string) => string };
export type Receipt = { id: string; tool: string; input: unknown; output: unknown; at: string; codeReference: string; success: boolean };
const object = (properties: Wire, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string" };
const specs = [
  { name: "studio_list", permission: "read", description: "List project files. Hidden and secret files are excluded.", inputSchema: object({ path: string, depth: { type: "integer", minimum: 1, maximum: 3 } }, ["path", "depth"]) },
  { name: "studio_read", permission: "read", description: "Read a UTF-8 project file. Use relative paths. Content is limited to 256 KB.", inputSchema: object({ path: string }, ["path"]) },
  { name: "studio_artifact", permission: "read", description: "Read a previous role's full handoff or recorded evidence by artifact ID. Use offset to read long reports in 16000 character pages.", inputSchema: object({ id: string, offset: { type: "integer", minimum: 0 } }, ["id", "offset"]) },
  { name: "studio_write", permission: "write", description: "Create or replace a project file with its full contents. Requires run write approval. Never writes secrets or Git internals.", inputSchema: object({ path: string, content: string }, ["path", "content"]) },
  { name: "studio_shell", permission: "shell", description: "Run a shell command in the project sandbox. Set background=true only for a local test server. Do not deploy, push, or target production. Foreground timeout is at most 120 seconds.", inputSchema: object({ command: string, timeoutSeconds: { type: "integer", minimum: 1, maximum: 120 }, background: { type: "boolean" } }, ["command", "timeoutSeconds", "background"]) },
] as const;
export const toolSpecs = (step: Step) => specs.filter(spec => step.agent.tools.includes(spec.permission)).map(({ permission, ...spec }) => ({ type: "function", ...spec }));
const secretPath = (path: string) => path.split(/[\\/]/).some(part => /^\.(git|env|ssh|aws|gnupg|codex|claude|local)$/.test(part) || /^\.env[.]/.test(part) || /(?:credentials|private[._-]?key|\.pem$|\.key$)/i.test(part));

export async function codeReference(cwd: string) {
  const head = await git(cwd, ["rev-parse", "--verify", "HEAD"]);
  const changed = await git(cwd, ["diff", "--name-only", "-z", ...(head ? ["HEAD"] : [])]);
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const tracked = head ? "" : await git(cwd, ["ls-files", "-z"]);
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
  return hash(JSON.stringify({ head, content }));
}

export class Toolbox {
  readonly receipts: Receipt[] = [];
  private processes = new Set<ChildProcess>();
  private disposed = false;
  private evidenceBytes = 0;
  readonly frozenFiles = new Map<string, string>();
  constructor(readonly context: Context, readonly artifactDir: string) {}
  private async file(raw: string, create = false) {
    if (raw.length > 4096 || secretPath(raw)) throw new Error("This path is excluded from agent file access.");
    const target = resolve(this.context.run.cwd, raw);
    if (!contained(this.context.run.cwd, target)) throw new Error("Files must stay inside the selected project.");
    let ancestor = target;
    while (!await stat(ancestor).then(() => true, () => false)) {
      if (!create || ancestor === dirname(ancestor)) throw new Error("File not found.");
      ancestor = dirname(ancestor);
    }
    if (!contained(this.context.run.cwd, await realpath(ancestor))) throw new Error("Symlink escapes the project.");
    return target;
  }
  async call(name: string, raw: unknown) {
    const spec = specs.find(spec => spec.name === name);
    if (!spec || !this.context.step.agent.tools.includes(spec.permission)) throw new Error("This tool is not enabled for the agent.");
    if (this.disposed) throw new Error("The run is no longer accepting tool calls.");
    if (this.receipts.length >= 100 || this.evidenceBytes > 1024 * 1024) throw new Error("This step reached its tool evidence budget. Return a handoff with any remaining work; do not repeat this call.");
    const input = z.record(z.string(), z.unknown()).parse(raw);
    const id = randomUUID(), at = new Date().toISOString();
    let output: unknown, success = true;
    try {
      output = await this.execute(name, input);
      if (output && typeof output === "object" && "exitCode" in output && output.exitCode !== 0) success = false;
    } catch (error) { success = false; output = { error: this.context.redact((error as Error).message) }; }
    const receipt = { id, tool: name, input: JSON.parse(this.context.redact(JSON.stringify(input))), output, success, at, codeReference: await codeReference(this.context.run.cwd) };
    this.evidenceBytes += Buffer.byteLength(JSON.stringify(receipt));
    this.receipts.push(receipt);
    const text = this.context.redact(JSON.stringify({ receiptId: id, tool: name, ...input, result: output }, null, 2));
    this.context.step.messages.push({ id, type: "tool", text: text.slice(0, 24000), time: at });
    this.context.save("tool.completed", receipt);
    return { receiptId: id, success, result: output };
  }
  private async execute(name: string, input: Wire): Promise<unknown> {
    if (name === "studio_artifact") {
      const { id, offset } = z.object({ id: z.string(), offset: z.number().int().min(0) }).parse(input);
      const artifact = this.context.run.artifacts.find(item => item.id === id);
      if (!artifact) throw new Error("Artifact not found in this run.");
      return { name: artifact.name, codeReference: artifact.codeReference, content: artifact.content.slice(offset, offset + 16000), nextOffset: offset + 16000 < artifact.content.length ? offset + 16000 : null };
    }
    if (name === "studio_list") {
      const { path, depth } = z.object({ path: z.string(), depth: z.number().int().min(1).max(3) }).parse(input);
      const target = await this.file(path), files: string[] = [];
      const walk = async (dir: string, level: number) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || ["node_modules", "target", "dist", "build"].includes(entry.name) || secretPath(entry.name) || entry.isSymbolicLink()) continue;
          const path = join(dir, entry.name); files.push(relative(this.context.run.cwd, path) + (entry.isDirectory() ? "/" : ""));
          if (files.length > 1000) return;
          if (entry.isDirectory() && level > 1) await walk(path, level - 1);
        }
      };
      await walk(target, depth); return files.slice(0, 1000);
    }
    if (name === "studio_read") {
      const { path } = z.object({ path: z.string() }).parse(input);
      const snapshot = this.frozenFiles.get(resolve(this.context.run.cwd, path));
      if (snapshot !== undefined) return snapshot;
      const target = await this.file(path);
      if ((await stat(target)).size > 256 * 1024) throw new Error("Read a smaller file (maximum 256 KB).");
      return this.context.redact(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(target)));
    }
    if (name === "studio_write") {
      const { path, content } = z.object({ path: z.string(), content: z.string().max(256 * 1024) }).parse(input);
      if (!this.context.run.approved) throw new Error("File writes have not been approved.");
      const target = await this.file(path, true);
      await mkdir(dirname(target), { recursive: true });
      if (!contained(this.context.run.cwd, await realpath(dirname(target)))) throw new Error("Symlink escapes the project.");
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
      try { await handle.writeFile(content); } finally { await handle.close(); }
      return { path, bytes: Buffer.byteLength(content), hash: hash(content) };
    }
    if (name === "studio_shell") {
      const data = z.object({ command: z.string().min(1).max(10000), timeoutSeconds: z.number().int().min(1).max(120), background: z.boolean() }).parse(input);
      if (!await this.context.approval("shell", "Run this project command?", data.command)) throw new Error("Command was rejected.");
      const writable = this.context.step.agent.tools.includes("write") && this.context.run.approved;
      const args = ["sandbox", "-P", "agent-studio-command", "-C", this.context.run.cwd, "-c", `permissions.agent-studio-command.extends=":${writable ? "workspace" : "read-only"}"`, "-c", "permissions.agent-studio-command.network.enabled=true", "--", "/bin/sh", "-c", data.command];
      return this.command(codexBinary, args, data.timeoutSeconds * 1000, data.background);
    }
    throw new Error("Unknown tool.");
  }
  private async command(binary: string, args: string[], timeout: number, background: boolean) {
    const process = spawn(binary, args, { cwd: this.context.run.cwd, env: runtimeEnvironment(), stdio: ["ignore", "pipe", "pipe"], detached: true });
    this.processes.add(process);
    let text = "";
    process.stdout?.on("data", chunk => { text = (text + chunk).slice(-64000); });
    process.stderr?.on("data", chunk => { text = (text + chunk).slice(-64000); });
    const stop = () => { if (process.pid) { try { globalThis.process.kill(-process.pid, "SIGTERM"); } catch {} setTimeout(() => { if (process.exitCode === null) try { globalThis.process.kill(-process.pid!, "SIGKILL"); } catch {} }, 2000).unref(); } };
    return new Promise((resolve, reject) => {
      let returned = false;
      const timer = setTimeout(stop, background ? 600000 : timeout);
      process.once("error", error => { clearTimeout(timer); this.processes.delete(process); reject(error); });
      process.once("exit", (code, signal) => { clearTimeout(timer); this.processes.delete(process); if (!returned) resolve({ exitCode: code, signal, output: this.context.redact(text) }); });
      if (background) setTimeout(() => { if (process.exitCode === null && process.pid) { returned = true; resolve({ pid: process.pid, background: true, output: this.context.redact(text), lifetimeSeconds: 600 }); } }, 800);
    });
  }
  async close() {
    this.disposed = true;
    for (const child of this.processes) if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  }
}
