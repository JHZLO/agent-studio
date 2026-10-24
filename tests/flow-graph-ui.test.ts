import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import { initialState } from "../packages/contracts/defaults.js";
import { settingsSchema, type Run, type Step } from "../packages/contracts/index.ts";
import { Studio } from "../packages/engine/studio.ts";
import { Store } from "../packages/engine/store.ts";

test("Flow connections save branches, expose their live queues and show merge discussions", { timeout: 60000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "studio-flow-ui-"))), cwd = join(root, "project");
  await mkdir(cwd); await writeFile(join(cwd, "README.md"), "Fixture project");
  const store = new Store(join(root, "state.sqlite"));
  const studio = new Studio(store, root, join(root, "sockets"));
  const settings = settingsSchema.parse(initialState());
  settings.agents = settings.agents.filter(agent => ["planner", "coder", "reviewer", "documenter"].includes(agent.id)).map(agent => ({ ...agent, provider: "codex", tools: ["read"] }));
  settings.flows = ["main", "other"].map(id => ({ id, name: id === "main" ? "Delivery" : "Other flow", workflow: settings.agents.map(agent => agent.id), rules: [], revision: 1, archived: false }));
  settings.activeFlowId = "main"; settings.skillRoots = []; settings.approvalRequired = false;
  settings.projects = [{ id: "fixture", name: "Fixture", path: cwd, execution: { mode: "local", branchName: "" } }]; settings.activeProjectId = "fixture";
  store.set("settings", settings);
  store.set("connections", [{ id: "codex-subscription", provider: "codex", auth: "subscription", models: ["default"], connected: true, billingMode: "subscription" }]);
  studio.connections.assertAgent = async () => {};
  studio.catalog.scan = async () => ({ skills: [], sources: [], errors: [] }) as any;
  const calls: Step[] = [];
  const releases: (() => void)[] = [];
  const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); releases.push(release); return { promise, release }; };
  const left = gate(), right = gate(), merge = gate();
  t.mock.method(studio as any, "codexTurn", async (run: Run, step: Step, _prompt: string, toolbox: any) => {
    step.providerThreadId ??= `thread-${step.id}`;
    if (step.purpose === "merge") { await toolbox.call("studio_read", { path: "README.md" }); await merge.promise; }
    else { calls.push(structuredClone(step)); if (step.agent.id === "coder") await left.promise; if (step.agent.id === "reviewer") await right.promise; }
    const names = step.agent.role === "planner" ? ["implementation-plan.md", "qa-sheet.md"] : [`${step.agent.role}.md`];
    return JSON.stringify({ status: "completed", decision: "pass", summary: "Checked the actual files", artifacts: names.map(name => ({ name, type: "Report", content: name })) });
  });
  const streams = new Set<ServerResponse>();
  const methods: Record<string, string> = { settings: "settings.save", catalog: "catalog", snapshots: "snapshots", project: "project", "runs/start": "run.start", "runs/control": "run.control", "runs/read": "run.read", "runs/message": "run.message" };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url!, "http://localhost").pathname;
      if (path === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }); res.write(": connected\n\n");
        streams.add(res); req.on("close", () => streams.delete(res)); return;
      }
      if (path.startsWith("/api/")) {
        let data;
        if (path === "/api/bootstrap") data = { csrf: "fixture", state: store.state() };
        else if (path === "/api/status") data = { service: "agent-studio", roots: [] };
        else {
          let body = ""; for await (const part of req) body += part;
          const method = methods[path.slice(5)]; assert(method, `Unexpected test request: ${path}`);
          data = await studio.dispatch(method, JSON.parse(body || "{}"));
          if (path === "/api/runs/control") await delay(60);
        }
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); return;
      }
      const file = path === "/" ? "index.html" : path.slice(1);
      assert(!file.includes(".."));
      const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
      res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" }); res.end(await readFile(join(process.cwd(), "dist/web", file)));
    } catch (error) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: (error as Error).message })); }
  });
  store.on("event", event => { for (const stream of streams) stream.write(`id: ${event.seq}\nevent: run\ndata: ${JSON.stringify(store.state().run)}\n\n`); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  t.after(async () => { for (const release of releases) release(); await browser.close(); for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await studio.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  page.setDefaultTimeout(5000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await expect(page.locator(".sidebar-status")).toContainText("Local skills connected");
  const choose = async (name: string, value: string) => {
    await page.getByRole("combobox", { name, exact: true }).click();
    await page.getByRole("option", { name: value, exact: true }).click();
  };
  const flow = () => studio.settings().flows.find(item => item.id === "main")!;
  const openStep = async (name: string) => page.getByRole("button", { name: `Step settings for ${name}`, exact: true }).click();
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await openStep("Coder");
  await page.locator('[data-flow-from="coder"][data-flow-to="reviewer"]').uncheck();
  await expect.poll(() => flow().edges?.length).toBe(2);
  const connect = async (from: string, to: string) => {
    await page.locator(`[data-action="connect-from"][data-id="${from}"]`).click();
    await page.locator(`[data-action="connect-to"][data-id="${to}"]`).click();
  };
  await connect("planner", "reviewer"); await connect("coder", "documenter");
  await expect.poll(() => flow().edges?.length).toBe(4);
  await connect("documenter", "planner"); await expect(page.locator("#toast")).toContainText("cycle");
  await page.keyboard.press("Escape"); assert.equal(flow().edges?.length, 4);
  await openStep("Documenter"); await expect(page.locator(".step-connections")).toContainText("Wait for all: Coder, Reviewer");
  await choose("Parallel agents", "2"); await expect.poll(() => flow().maxParallel).toBe(2);
  const downloadPromise = page.waitForEvent("download"); await page.getByRole("button", { name: "Export", exact: true }).click();
  const downloaded = await downloadPromise, exported = JSON.parse(await readFile((await downloaded.path())!, "utf8"));
  assert.deepEqual(exported.edges, flow().edges); assert.equal(exported.maxParallel, 2);
  if (process.env.STUDIO_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.STUDIO_SCREENSHOT_DIR, "flow-builder.png"), fullPage: true });
  await page.getByRole("button", { name: "Use this flow", exact: true }).click();
  await page.getByLabel("Task brief", { exact: true }).fill("Check branches and agree on the merge");
  await page.getByRole("button", { name: "Run task", exact: true }).click();
  await expect.poll(() => store.state().run?.steps.filter((step: Step) => step.status === "running").length).toBe(2);
  await expect(page.getByRole("heading", { name: "2 agents are working", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View Coder session", exact: true }).click();
  await page.getByLabel("Message Coder", { exact: true }).fill("Check idempotency"); await page.getByRole("button", { name: "Add to queue", exact: true }).click();
  await expect(page.getByRole("region", { name: "Queued instructions", exact: true })).toContainText("Check idempotency");
  await page.getByRole("button", { name: "View Reviewer session", exact: true }).click();
  await expect(page.getByRole("region", { name: "Queued instructions", exact: true })).toHaveCount(0);
  left.release(); right.release();
  await expect(page.getByRole("heading", { name: "Agents are agreeing on the merge", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /View .+ merge session/ }).first()).toBeVisible();
  await page.getByRole("button", { name: /View .+ merge session/ }).first().click();
  await page.getByRole("button", { name: "Full screen", exact: true }).click();
  await expect(page.locator(".expanded-workspace")).toBeVisible();
  if (process.env.STUDIO_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.STUDIO_SCREENSHOT_DIR, "merge-workspace.png"), fullPage: true });
  merge.release(); await expect.poll(() => store.state().run?.status).toBe("succeeded");
  assert.equal(store.state().run!.merge!.status, "agreed"); assert.equal(store.state().run!.merge!.votes.length, 2);
  assert.equal(calls.filter(step => step.agent.id === "coder").length, 2);
  await page.keyboard.press("Escape"); await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator("body").evaluate(element => element.scrollWidth <= innerWidth)).toBe(true);
  assert.deepEqual(errors, []);
});
