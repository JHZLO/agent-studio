import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { runtimeLoader, root, claudeBinary } from "../packages/engine/codex.ts";
import { Studio } from "../packages/engine/studio.ts";
import { Store } from "../packages/engine/store.ts";
import { initialState } from "../packages/contracts/defaults.js";
import { settingsSchema, type Run } from "../packages/contracts/index.ts";

test("Claude's MCP bridge starts outside Studio and cannot load project-owned tooling", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "studio-mcp-project-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const invoke = () => spawnSync(process.execPath, ["--import", runtimeLoader, join(root, "apps/runner/mcp.ts")], { cwd, input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n", encoding: "utf8", timeout: 10000 });
  const empty = invoke();
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).result.serverInfo.name, "agent-studio");
  await mkdir(join(cwd, "node_modules/tsx"), { recursive: true });
  await writeFile(join(cwd, "node_modules/tsx/package.json"), JSON.stringify({ type: "module", main: "index.js" }));
  await writeFile(join(cwd, "node_modules/tsx/index.js"), "import {writeFileSync} from 'node:fs'; writeFileSync('unexpected-loader.txt','loaded'); throw Error('Project loader executed');");
  const shadowed = invoke();
  assert.equal(shadowed.status, 0, shadowed.stderr);
  assert.equal(JSON.parse(shadowed.stdout).id, 1);
  await assert.rejects(readFile(join(cwd, "unexpected-loader.txt")), { code: "ENOENT" });
});

test("A successful Claude report cannot hide a missing Studio tool connection", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "studio-mcp-failed-"));
  const store = new Store(join(cwd, "state.sqlite")), studio = new Studio(store, cwd, cwd);
  const original = childProcess.spawn;
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await studio.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const agent = { ...settingsSchema.parse(initialState()).agents[0], provider: "claude" as const };
  const run = { id: "fixture", cwd, createdAt: new Date().toISOString(), status: "running", steps: [{ id: "planner", agent, messages: [] }] } as unknown as Run;
  for (const server of [[], [{ name: "studio", status: "failed" }], [{ name: "different-server", status: "connected" }]]) {
    const events = [
      { type: "system", subtype: "init", model: "fixture", mcp_servers: server },
      { type: "result", structured_output: { summary: "Plan ready", status: "completed", decision: "pass", artifacts: [] } },
    ];
    t.mock.method(childProcess, "spawn", ((file: string, args: string[], options: any) => file === claudeBinary ? original(process.execPath, ["-e", `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(events.map(event => JSON.stringify(event)).join("\n") + "\n")}); });`], options) : original(file, args, options)) as typeof childProcess.spawn);
    syncBuiltinESMExports();
    await assert.rejects((studio as any).claudeTurn(run, run.steps[0], "Prepare the plan", {}), /Studio tool connection/);
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});
