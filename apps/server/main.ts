import Fastify from "fastify";
import serveStatic from "@fastify/static";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { openSync, closeSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { WebSocketServer } from "ws";
import type { ServerResponse } from "node:http";
import { rpc } from "../../packages/engine/ipc.ts";
import { root } from "../../packages/engine/codex.ts";
import { privateDirectories, dataDir } from "../../packages/engine/paths.ts";

await privateDirectories();
try { await rpc("ping"); }
catch {
  const log = openSync(join(dataDir, "runner.log"), "a", 0o600);
  const child = spawn(process.execPath, ["--import", "tsx", join(root, "apps/runner/main.ts")], { cwd: root, env: process.env, stdio: ["ignore", log, log], detached: true }); child.unref();
  closeSync(log);
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await rpc("ping"); ready = true; break; } catch { await delay(100); } }
  if (!ready) throw new Error("Runner did not start. Inspect the private runner log.");
}
const port = z.coerce.number().int().min(1024).max(65535).parse(process.env.AGENT_STUDIO_PORT ?? 4183);
const origin = `http://127.0.0.1:${port}`;
const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
const sessions = new Map<string, string>();
const eventClients = new Set<ServerResponse>();
const cookie = (header: string | undefined) => header?.split(";").map(part => part.trim()).find(part => part.startsWith("studio="))?.slice(7);
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
app.addHook("onRequest", async (request, reply) => {
  reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").header("X-Frame-Options", "DENY").header("Referrer-Policy", "no-referrer");
  const site = request.headers["sec-fetch-site"];
  if (request.headers.host !== `127.0.0.1:${port}` || (request.headers.origin && request.headers.origin !== origin) || (site && site !== "same-origin" && site !== "none")) return reply.code(403).send({ error: "Open Agent Studio on its loopback address." });
  if (request.method !== "GET" && request.method !== "HEAD") {
    const session = cookie(request.headers.cookie), csrf = request.headers["x-studio-csrf"];
    if (request.headers.origin !== origin || !request.headers["content-type"]?.startsWith("application/json") || !session || !sessions.has(session) || typeof csrf !== "string" || !equal(sessions.get(session)!, csrf)) return reply.code(403).send({ error: "Same-origin authenticated JSON requests are required." });
  }
  if (request.url.startsWith("/api/") && !request.url.startsWith("/api/bootstrap") && !sessions.has(cookie(request.headers.cookie) ?? "")) return reply.code(401).send({ error: "Reconnect to Agent Studio." });
});
app.setErrorHandler((error: Error, _request, reply) => reply.code(400).send({ error: error.message }));
app.get("/api/bootstrap", async (request, reply) => {
  let session = cookie(request.headers.cookie);
  if (!session || !sessions.has(session)) {
    session = randomUUID(); sessions.set(session, randomUUID());
    if (sessions.size > 100) sessions.delete(sessions.keys().next().value!);
    reply.header("Set-Cookie", `studio=${session}; Path=/; HttpOnly; SameSite=Strict`);
  }
  return { csrf: sessions.get(session), state: await rpc("state"), service: "agent-studio", origin };
});
app.get("/api/status", async () => ({ service: "agent-studio", roots: (await rpc("state")).skillRoots }));
app.get("/api/state", async () => rpc("state"));
const operations: Record<string, string> = { catalog: "catalog", skill: "skill", snapshots: "snapshots", snapshot: "snapshot", folders: "folders", project: "project", "projects/remove": "project.remove", "local/scan": "local.scan", "local/import": "local.import", "local/read": "local.read", settings: "settings.save", "connections/check": "connection.check", "connections/login": "connection.login", "connections/disconnect": "connection.disconnect", "runs/start": "run.start", "runs/read": "run.read", "runs/control": "run.control", "runs/reconcile": "run.reconcile", reset: "reset" };
for (const [path, method] of Object.entries(operations)) app.post(`/api/${path}`, async request => {
  const { commandId = randomUUID(), ...input } = z.record(z.string(), z.unknown()).parse(request.body);
  return rpc(method, input, z.string().uuid().parse(commandId));
});
for (const action of ["open", "close"]) app.post(`/api/terminal/${action}`, async request => {
  const { commandId = randomUUID(), ...input } = z.record(z.string(), z.unknown()).parse(request.body);
  return rpc(`terminal.${action}`, input, z.string().uuid().parse(commandId));
});
app.get<{ Params: { runId: string; id: string } }>("/api/artifacts/:runId/:id", async (request, reply) => {
  const artifact = await rpc("artifact", request.params);
  if (artifact.mediaPath) return reply.type(artifact.mime).send(await readFile(artifact.mediaPath));
  return reply.type("text/plain; charset=utf-8").send(artifact.content);
});
app.get<{ Querystring: { after?: string } }>("/api/events", async (request, reply) => {
  let sequence = Number(request.headers["last-event-id"] || request.query.after || 0);
  if (!Number.isSafeInteger(sequence) || sequence < 0) return reply.code(400).send({ error: "Invalid event cursor." });
  reply.hijack();
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
  eventClients.add(reply.raw);
  let closed = false; reply.raw.on("close", () => { closed = true; eventClients.delete(reply.raw); });
  reply.raw.write(": connected\n\n");
  while (!closed) {
    try {
      const { events } = await rpc("events", { after: sequence });
      if (events.length) {
        const changed = new Map<string, number>();
        for (const event of events) if (event.runId) changed.set(event.runId, event.seq);
        for (const [id, seq] of [...changed].sort((a, b) => a[1] - b[1])) {
          const run = await rpc("run.read", { id });
          reply.raw.write(`id: ${seq}\nevent: run\ndata: ${JSON.stringify(run)}\n\n`);
        }
        sequence = events.at(-1).seq;
      } else reply.raw.write(": heartbeat\n\n");
    } catch { reply.raw.write("event: reconnect\ndata: {}\n\n"); }
    await delay(500);
  }
});
const web = join(root, "dist/web");
if (!existsSync(join(web, "index.html"))) throw new Error("Build the web UI first with ./studio build.");
await app.register(serveStatic, { root: web, dotfiles: "deny", index: ["index.html"], cacheControl: false });
const sockets = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
app.server.on("upgrade", (request, socket, head) => {
  const match = request.url?.match(/^\/api\/terminal\/([a-f0-9-]{36})$/);
  if (!match || request.headers.host !== `127.0.0.1:${port}` || request.headers.origin !== origin || !sessions.has(cookie(request.headers.cookie) ?? "")) { socket.destroy(); return; }
  sockets.handleUpgrade(request, socket, head, client => {
    let offset = 0, closed = false;
    client.on("close", () => { closed = true; });
    client.on("error", () => { closed = true; });
    client.on("message", async raw => {
      try {
        const input = JSON.parse(raw.toString());
        if (input.type === "input") await rpc("terminal.input", { id: match[1], text: z.string().max(4096).parse(input.text) });
        else if (input.type === "resize") await rpc("terminal.resize", { id: match[1], cols: input.cols, rows: input.rows });
        else throw new Error("Invalid terminal message.");
      } catch (error) { if (!closed) client.send(JSON.stringify({ error: (error as Error).message })); }
    });
    void (async () => {
      while (!closed) {
        try {
          const state = await rpc("terminal.read", { id: match[1], after: offset });
          offset = state.offset;
          if (!closed && (state.data || state.exited)) client.send(JSON.stringify(state));
          if (state.exited) { client.close(); break; }
        } catch (error) { if (!closed) client.send(JSON.stringify({ error: (error as Error).message })); client.close(); break; }
        await delay(100);
      }
    })();
  });
});
await app.listen({ port, host: "127.0.0.1" });
console.log(`Agent Studio: ${origin}`);
console.log("The independent runner keeps tasks alive when this API process closes.");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  for (const response of eventClients) response.end();
  for (const client of sockets.clients) client.close();
  void app.close().then(() => process.exit(0));
});
