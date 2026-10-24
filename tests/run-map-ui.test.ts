import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { chromium, expect } from "@playwright/test";
import { initialState } from "../packages/contracts/defaults.js";
import { settingsSchema, type Run } from "../packages/contracts/index.ts";

test("Agent views follow live status and open sessions without changing the run", { timeout: 30000 }, async t => {
  const settings = settingsSchema.parse({ ...initialState(), language: "ko", skillRoots: [] });
  settings.projects = [{ id: "map-project", name: "Map project", path: "/fixture", execution: { mode: "local", branchName: "" } }];
  settings.activeProjectId = "map-project";
  const agents = settings.agents.slice(0, 4).map((agent, index) => ({ ...agent, name: ["Planner", "Coder", "Reviewer", "Tester"][index] }));
  const start = new Date(Date.now() - 60000).toISOString(), end = new Date(Date.now() - 30000).toISOString();
  const planReview = { id: "review-1", stepId: "step-0", kind: "checkpoint" as const, artifactIds: [], fingerprint: "fingerprint", version: 1, returnTo: agents[0].id, lockOutputs: true, summary: "Review this plan", createdAt: end, codeReference: "fixture-code" };
  const run: Run = {
    id: "map-run", brief: "Inspect the agent workflow", createdAt: start,
    project: settings.projects[0], flow: { ...settings.flows[0], name: "Saved execution flow", revision: 4, workflow: agents.map(agent => agent.id), rules: [
      { after: agents[0].id, review: "always", lockOutputs: true, returnTo: agents[0].id },
      { after: agents[2].id, review: "auto", lockOutputs: false, loop: { target: agents[1].id, maxCycles: 3, onLimit: "review" } },
    ] }, cwd: "/fixture", baseHead: null, status: "running", index: 1,
    steps: agents.map((agent, index) => ({ id: `step-${index}`, agent, sessionId: `session-${index}`, status: index === 0 ? "succeeded" : index === 1 ? "running" : "queued", attempt: index === 0 ? 2 : 1, receivedArtifacts: [], messages: index < 2 ? [{ id: `message-${index}`, type: "system", text: "Fresh session", time: start }] : [], completedAt: index === 0 ? end : undefined })),
    artifacts: [], note: "", approvalRequired: true, approved: false, pauseRequested: false, controlMode: "studio", eventSeq: 1, commandId: "fixture",
    lockedPlan: { version: 1, stepId: "step-0", artifactIds: [] }, reviewHistory: [{ ...planReview, action: "approved", resolvedAt: end }], loopCounts: {},
  };
  // Preset edits must not change the order or rules of this execution.
  settings.flows[0].workflow = [agents[3].id]; settings.flows[0].rules = [];
  const state = { ...settings, connections: [], revision: 1, eventSeq: 1, run, activeRuns: [run], history: [], importedSessions: [] };
  const streams = new Set<ServerResponse>(), unexpected: string[] = [];
  let settingsWrites = 0;
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url!, "http://localhost").pathname;
      if (path === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": connected\n\n");
        streams.add(res); req.on("close", () => streams.delete(res)); return;
      }
      if (path.startsWith("/api/")) {
        if (path === "/api/settings") settingsWrites++;
        const data = path === "/api/bootstrap" ? { csrf: "fixture", state }
          : path === "/api/status" ? { service: "agent-studio", roots: [] }
          : path === "/api/catalog" ? { skills: [], sources: [], errors: [] }
          : path === "/api/settings" ? { revision: 1 }
          : path === "/api/runs/read" ? run : undefined;
        if (data === undefined) { unexpected.push(path); throw new Error(`Unexpected request: ${path}`); }
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); return;
      }
      const file = path === "/" ? "index.html" : path.slice(1); assert(!file.includes(".."));
      const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
      res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
      res.end(await readFile(join(process.cwd(), "dist/web", file)));
    } catch (error) { res.writeHead(400); res.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(5000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.locator('.project-tree [data-action="open-run"][data-id="map-run"]').click();
  await expect(page.locator(".run-grid")).toBeVisible();
  await expect.poll(() => settingsWrites).toBe(1);
  const map = page.locator('[data-action="run-layout"][data-layout="map"]');
  const details = page.locator('[data-action="run-layout"][data-layout="details"]');
  const character = (index: number) => page.locator(`.run-map-character[data-index="${index}"]`);
  const publish = () => {
    state.eventSeq = ++run.eventSeq;
    for (const stream of streams) stream.write(`id: ${run.eventSeq}\nevent: run\ndata: ${JSON.stringify(run)}\n\n`);
  };
  await map.click(); await expect(map).toHaveAttribute("aria-pressed", "true"); await expect(map).toBeFocused();
  await expect(page.locator(".run-grid")).toHaveCount(0);
  await expect(page.locator(".run-map .character-name")).toHaveText(["Planner", "Coder", "Reviewer", "Tester"]);
  await expect(character(0)).toHaveAttribute("data-status", "succeeded");
  await expect(character(1)).toHaveAttribute("data-status", "running");
  await expect(character(1).locator(".agent-icon")).toHaveClass(/is-running/);
  await expect(character(2)).toHaveAttribute("data-status", "queued");
  await expect(character(0)).toHaveAttribute("title", /계획 확정/);
  await expect(page.locator(".run-map .node, .run-map .connections-svg, .run-map .zoom-controls")).toHaveCount(0);
  await expect(character(0)).toHaveText("Planner완료");
  assert(await character(0).locator(".agent-icon").evaluate(icon => icon.getBoundingClientRect().width >= 96));
  await character(2).press("Enter");
  await expect(page.locator(".session-head h2")).toHaveText("Reviewer");
  await expect(page.locator(".session-head h2")).toBeFocused();
  await expect(details).toHaveAttribute("aria-pressed", "true");
  await map.click();
  run.status = "waiting_approval"; run.steps[1].status = "waiting_approval";
  run.approval = { id: "approval", stepId: "step-1", kind: "shell", description: "Run checks", details: "Sample command" }; publish();
  await expect(character(1)).toHaveAttribute("data-status", "waiting_approval");
  await expect(map).toHaveAttribute("aria-pressed", "true");
  run.approval = undefined; run.status = "failed"; run.steps[1].status = "failed"; publish();
  await expect(character(1)).toHaveAttribute("data-status", "failed");
  run.status = "paused"; run.steps[1].status = "queued"; publish();
  await expect(character(1)).toHaveAttribute("data-status", "paused");
  run.steps[0].id = "planner-3"; run.steps[0].attempt = 3; run.steps[1].status = "queued";
  run.status = "waiting_review"; run.review = { ...planReview, id: "review-3", stepId: "planner-3", version: 3 }; publish();
  await expect(character(0)).toHaveAttribute("data-status", "waiting_review");
  await expect(character(0).locator(".character-status")).toHaveText("검토 필요");
  await expect(character(0)).not.toHaveAttribute("title", /계획 확정/);
  await character(0).click();
  await expect(page.locator("#review-feedback")).toBeVisible();
  await page.locator("#review-feedback").fill("Preserve this draft while inspecting progress.");
  await map.click(); await details.click();
  await expect(page.locator("#review-feedback")).toHaveValue("Preserve this draft while inspecting progress.");
  await map.click();
  run.review = undefined; run.status = "running"; run.steps[1].status = "running"; run.steps[1].attempt = 2;
  run.loopCounts = { [agents[2].id]: 1 }; publish();
  await expect(character(1)).toHaveAttribute("data-status", "running");
  await character(1).click();
  await expect(page.locator('.run-step[data-index="1"]')).toContainText("Attempt 2");
  await map.click();
  await page.setViewportSize({ width: 390, height: 844 });
  const positions = await page.locator(".run-map-character").evaluateAll(characters => characters.map(character => {
    const box = character.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right };
  }));
  assert(positions.every(pos => pos.x >= 0 && pos.right <= 390));
  assert(positions[0].y === positions[1].y && positions[2].y > positions[0].y);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await character(1).locator(".agent-icon").evaluate(icon => getComputedStyle(icon).animationName), "none");
  run.status = "succeeded"; run.index = run.steps.length;
  for (const step of run.steps) { step.status = "succeeded"; step.completedAt = new Date().toISOString(); }
  publish(); await expect(page.locator('.run-map-character[data-status="succeeded"]')).toHaveCount(4);
  assert.equal(settingsWrites, 1); assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
});
