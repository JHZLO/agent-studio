import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import { initialState } from "../packages/contracts/defaults.js";
import { settingsSchema, type Run, type Step } from "../packages/contracts/index.ts";
import { Store } from "../packages/engine/store.ts";

test("Session clocks tick without rerendering, survive reloads and stop at each attempt's completion", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "studio-session-time-")), cwd = join(root, "project"); await mkdir(cwd);
  const store = new Store(join(root, "studio.sqlite"));
  const settings = settingsSchema.parse({ ...initialState(), language: "ko", skillRoots: [] });
  settings.projects = [{ id: "timing-project", name: "Timing project", path: cwd, execution: { mode: "local", branchName: "" } }]; settings.activeProjectId = "timing-project";
  store.set("settings", settings);
  const reserve = createServer(); await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const api = spawn(process.execPath, ["--import", "tsx", "apps/server/main.ts"], { cwd: process.cwd(), env: { ...process.env, AGENT_STUDIO_DATA_DIR: root, AGENT_STUDIO_PORT: String(port), CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude") }, stdio: "ignore" });
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close(); api.kill("SIGTERM");
    try { process.kill(JSON.parse(await readFile(join(root, "runner.lock"), "utf8")).pid, "SIGTERM"); } catch {}
    for (let i = 0; i < 50; i++) { try { await readFile(join(root, "runner.lock")); await delay(100); } catch { break; } }
    store.close(); await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin + "/api/bootstrap")).ok) break; } catch {} await delay(100); }
  const now = Date.parse("2026-10-24T03:30:00.000Z"), iso = (offset: number) => new Date(now + offset).toISOString();
  const planner: Step = { id: "planner-2", agent: settings.agents[0], sessionId: "planner-session-2", status: "running", attempt: 2, receivedArtifacts: [], messages: [{ id: "fresh-2", type: "system", text: "Fresh planner session", time: iso(-150000) }] };
  const coder: Step = { id: "coder-1", agent: settings.agents[1], sessionId: "coder-session", status: "queued", receivedArtifacts: [], messages: [] };
  const previous: Step = { ...planner, id: "planner-1", sessionId: "planner-session-1", status: "succeeded", attempt: 1, completedAt: iso(-480000), messages: [{ id: "fresh-1", type: "system", text: "First planner attempt", time: iso(-600000) }] };
  const run: Run = { id: "timing-run", brief: "Measure each agent session", createdAt: iso(-600000), project: settings.projects[0], flow: { ...settings.flows[0], workflow: ["planner", "coder"] }, cwd, baseHead: null, status: "running", index: 0, steps: [planner, coder], stepHistory: [previous], artifacts: [], note: "", approvalRequired: true, approved: false, pauseRequested: false, controlMode: "studio", eventSeq: 0, commandId: "timing-fixture" };
  // Seed after runner startup so its recovery checks do not reinterpret the running fixture.
  store.saveRun(run, "message");
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(5000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({ time: new Date(now) }); await page.clock.pauseAt(new Date(now));
  await page.goto(origin);
  const open = () => page.locator('.project-tree [data-action="open-run"][data-id="timing-run"]').click();
  const clock = () => page.locator(".session-head [data-session-clock]");
  const plannerClock = () => page.locator('.run-step[data-index="0"] [data-session-clock]');
  await open();
  await expect(clock()).toHaveText("02:30"); await expect(plannerClock()).toHaveText("02:30");
  await expect(page.locator('.run-step[data-index="1"] [data-session-clock]')).toHaveCount(0);
  const conversation = await page.locator(".session-content").elementHandle();
  await page.clock.fastForward(3500);
  await expect(clock()).toHaveText("02:33"); await expect(clock()).toHaveAttribute("datetime", "PT153S");
  assert.equal(await conversation!.evaluate(element => element.isConnected), true, "Clock ticks must not replace the conversation");
  await page.getByRole("button", { name: "Coder 세션 보기", exact: true }).click();
  await expect(page.locator(".session-head .session-duration")).toHaveText("시작 전");
  await page.reload(); await open(); await expect(clock()).toHaveText("02:33");
  planner.status = "succeeded"; planner.completedAt = iso(3500); run.index = 1; run.status = "paused";
  store.saveRun(run, "step.completed");
  await expect(clock()).toHaveAttribute("data-live", "false");
  await expect(page.locator(".session-head .session-duration")).toHaveText("소요 02:33");
  await page.clock.fastForward(120000); await expect(clock()).toHaveText("02:33");
  await page.getByRole("button", { name: "시도 이력", exact: true }).click();
  await expect(page.locator(".attempts-list summary [data-session-clock]")).toHaveText(["02:00", "02:33"]);
  const next: Step = { ...planner, id: "planner-3", sessionId: "planner-session-3", attempt: 3, status: "running", completedAt: undefined, messages: [{ id: "fresh-3", type: "system", text: "Revised planner session", time: iso(123500) }] };
  run.stepHistory!.push(structuredClone(planner)); run.steps[0] = next; run.index = 0; run.status = "running";
  store.saveRun(run, "message");
  await expect(clock()).toHaveText("00:00"); await page.clock.fastForward(2500); await expect(clock()).toHaveText("00:02");
  await expect(page.locator(".attempts-list summary [data-session-clock]")).toHaveText(["02:00", "02:33", "00:02"]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => {
    const bounds = await clock().boundingBox();
    return !!bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390;
  }).toBe(true);
  await page.getByRole("button", { name: "전체 작업", exact: true }).click();
  await page.clock.fastForward(60000); await expect(page.locator("[data-session-clock]")).toHaveCount(0);
  assert.deepEqual(errors, []);
});
