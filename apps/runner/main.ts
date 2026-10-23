import Fastify from "fastify";
import { open, readFile, unlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "../../packages/engine/store.ts";
import { Studio } from "../../packages/engine/studio.ts";
import { dataDir, socketDir, runnerSocket, privateDirectories } from "../../packages/engine/paths.ts";

process.umask(0o077);
await privateDirectories();
const lockPath = join(dataDir, "runner.lock");
try { const lock = await open(lockPath, "wx", 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid, instance: randomUUID() })); await lock.close(); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  const previous = JSON.parse(await readFile(lockPath, "utf8"));
  try { process.kill(previous.pid, 0); throw new Error("A runner already owns this data directory."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  await unlink(lockPath);
  const lock = await open(lockPath, "wx", 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid, instance: randomUUID() })); await lock.close();
}
await unlink(runnerSocket).catch(error => { if (error.code !== "ENOENT") throw error; });
const store = new Store(join(dataDir, "studio.sqlite"));
const studio = new Studio(store, dataDir, socketDir);
const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
const readMethods = new Set(["ping", "state", "events", "catalog", "skill", "snapshot", "snapshots", "folders", "project", "run.read", "artifact"]);
app.post("/rpc", async (request, reply) => {
  try {
    const command = z.object({ method: z.string(), input: z.record(z.string(), z.unknown()), commandId: z.string().uuid() }).parse(request.body);
    const input = { ...command.input, commandId: command.commandId };
    const execute = () => studio.dispatch(command.method, input);
    return readMethods.has(command.method) ? await execute() : await store.command(command.commandId, command.method, command.input, execute);
  } catch (error) { return reply.code(400).send({ error: studio.connections.redact((error as Error).message) }); }
});
await app.listen({ path: runnerSocket }); await chmod(runnerSocket, 0o600);
console.log(`Agent Studio runner ready (PID ${process.pid}).`);
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, async () => {
  if (closing) return; closing = true;
  await studio.close(); await app.close(); store.close(); await unlink(lockPath).catch(() => {}); process.exit(0);
});
