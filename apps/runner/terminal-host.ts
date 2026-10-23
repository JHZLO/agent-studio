import Fastify from "fastify";
import { readFile, chmod, unlink } from "node:fs/promises";
import { spawn } from "node-pty";
import { z } from "zod";
import { codexBinary, runtimeEnvironment } from "../../packages/engine/codex.ts";

process.umask(0o077);
const config = z.object({ id: z.string().uuid(), socketPath: z.string(), runtimeSocket: z.string(), threadId: z.string(), cwd: z.string() }).parse(JSON.parse(await readFile(process.argv[2], "utf8")));
const terminal = spawn(codexBinary, ["resume", "--remote", `unix://${config.runtimeSocket}`, config.threadId, "--no-alt-screen"], { cwd: config.cwd, env: { ...runtimeEnvironment(), TERM: "xterm-256color" }, name: "xterm-256color", cols: 110, rows: 32 });
let buffer = "", offset = 0, exited = false, exitCode: number | undefined;
terminal.onData(data => { buffer += data; if (buffer.length > 1024 * 1024) { const drop = buffer.length - 1024 * 1024; offset += drop; buffer = buffer.slice(drop); } });
terminal.onExit(event => { exited = true; exitCode = event.exitCode; });
const app = Fastify({ logger: false, bodyLimit: 64000 });
app.post("/rpc", async (request, reply) => {
  try {
    const { method, input } = z.object({ method: z.string(), input: z.record(z.string(), z.unknown()) }).parse(request.body);
    if (method === "terminal.read") {
      const after = z.number().int().min(0).parse(input.after ?? 0);
      return { id: config.id, threadId: config.threadId, exited, exitCode, offset: offset + buffer.length, reset: after < offset, data: buffer.slice(Math.max(0, after - offset)) };
    }
    if (method === "terminal.input") { if (exited) throw new Error("Terminal has exited."); terminal.write(z.string().max(4096).parse(input.text)); return { ok: true }; }
    if (method === "terminal.resize") { terminal.resize(z.number().int().min(20).max(400).parse(input.cols), z.number().int().min(5).max(200).parse(input.rows)); return { ok: true }; }
    if (method === "terminal.close") { if (!exited) terminal.kill("SIGTERM"); return { ok: true }; }
    if (method === "terminal.dispose") { if (!exited) terminal.kill("SIGKILL"); setTimeout(() => process.exit(0), 50); return { ok: true }; }
    throw new Error("Unknown terminal operation.");
  } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
});
await app.listen({ path: config.socketPath }); await chmod(config.socketPath, 0o600);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { if (!exited) terminal.kill(); void app.close().then(() => process.exit(0)); });
process.once("exit", () => { void unlink(config.socketPath).catch(() => {}); });
