import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import { initialState } from "../packages/contracts/defaults.js";
import { settingsSchema, type Run } from "../packages/contracts/index.ts";
import { Store, hash } from "../packages/engine/store.ts";
import { codeReference } from "../packages/engine/tools.ts";

test("Concurrency settings persist and real API events keep two task controls isolated", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "studio-concurrent-ui-"));
  const store = new Store(join(root, "studio.sqlite")), settings = settingsSchema.parse({ ...initialState(), language: "ko", maxConcurrentRuns: 2, skillRoots: [] });
  settings.projects = [];
  const runs: Run[] = [];
  for (const [index, id] of ["a", "b"].entries()) {
    const cwd = join(root, id); await mkdir(cwd); await writeFile(join(cwd, "README.md"), id);
    const project = { id, name: id, path: cwd, execution: { mode: "local" as const, branchName: "" } }; settings.projects.push(project);
    const artifact = { id: `plan-${id}`, name: "implementation-plan.md", type: "Report", content: `Plan ${id}`, agent: "Planner", stepId: `step-${id}` }, reference = await codeReference(cwd);
    const run: Run = { id, brief: `Task ${id}`, createdAt: `2026-01-01T00:00:0${index}.000Z`, project, flow: { ...settings.flows[0], workflow: ["planner"] }, cwd, baseHead: null, status: "waiting_review", index: 1, steps: [{ id: artifact.stepId, agent: settings.agents[0], sessionId: `session-${id}`, status: "succeeded", receivedArtifacts: [], messages: [], codeReference: reference }], artifacts: [artifact], note: "", approvalRequired: true, approved: false, pauseRequested: false, controlMode: "studio", eventSeq: 0, commandId: id, review: { id: `review-${id}`, stepId: artifact.stepId, kind: "checkpoint", artifactIds: [artifact.id], fingerprint: hash(JSON.stringify([[artifact.id, artifact.content]])), version: 1, returnTo: "planner", lockOutputs: true, summary: `Review ${id}`, createdAt: new Date().toISOString(), codeReference: reference } };
    store.saveRun(run, "review.requested"); runs.push(run);
  }
  settings.activeProjectId = "a"; store.set("settings", settings); store.close();
  const reserve = createServer(); await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const api = spawn(process.execPath, ["--import", "tsx", "apps/server/main.ts"], { cwd: process.cwd(), env: { ...process.env, AGENT_STUDIO_DATA_DIR: root, AGENT_STUDIO_PORT: String(port), CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude") }, stdio: "ignore" });
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close(); api.kill("SIGTERM");
    try { process.kill(JSON.parse(await readFile(join(root, "runner.lock"), "utf8")).pid, "SIGTERM"); } catch {}
    for (let i = 0; i < 50; i++) { try { await readFile(join(root, "runner.lock")); await delay(100); } catch { break; } }
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin + "/api/bootstrap")).ok) break; } catch {} await delay(100); }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(5000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  const current = async () => (await (await page.request.get(origin + "/api/state")).json());
  const chooseLimit = async (value: number) => {
    await page.getByRole("button", { name: "기본 설정", exact: true }).click();
    await page.getByRole("combobox", { name: "최대 동시 실행 작업 수", exact: true }).click();
    await page.getByRole("option", { name: `${value}개`, exact: true }).click();
    await expect.poll(async () => (await current()).maxConcurrentRuns).toBe(value);
  };
  await expect(page.getByRole("button", { name: "진행 중인 작업 보기", exact: true })).toBeVisible();
  await chooseLimit(3); await page.reload();
  assert.equal((await current()).maxConcurrentRuns, 3);
  await expect(page.locator('[data-active-count]')).toHaveText("진행 중 2개 / 최대 3개");
  await expect(page.locator('[data-action="run"]')).toHaveText("작업 실행");
  const open = async (target: typeof page, id: string) => {
    await target.getByRole("button", { name: "작업", exact: true }).click();
    await target.locator(`.history-table [data-action="open-run"][data-id="${id}"]`).click();
  };
  await open(page, "a");
  const observer = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); observer.setDefaultTimeout(5000); observer.on("pageerror", error => errors.push(error.message));
  await observer.goto(origin); await open(observer, "a");
  await page.getByRole("button", { name: "확정만 하기", exact: true }).click();
  await expect(observer.getByRole("button", { name: "재개", exact: true })).toBeVisible();
  await expect(observer.getByRole("heading", { name: "Task a", exact: true }).first()).toBeVisible();
  assert.equal((await current()).activeRuns.find((run: Run) => run.id === "b").status, "waiting_review");
  const boot = await (await page.request.get(origin + "/api/bootstrap")).json();
  const response = await page.request.post(origin + "/api/runs/control", { headers: { Origin: origin, "X-Studio-CSRF": boot.csrf }, data: { id: "b", action: "approve-review-only", reviewId: runs[1].review!.id, fingerprint: runs[1].review!.fingerprint } });
  assert.equal(response.status(), 200);
  await expect.poll(async () => (await current()).activeRuns.every((run: Run) => run.status === "paused")).toBe(true);
  await expect(observer.locator(".review-document .markdown-body")).toHaveText("Plan a");
  await page.reload();
  await chooseLimit(1); assert.equal((await current()).activeRuns.length, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  const select = page.getByRole("combobox", { name: "최대 동시 실행 작업 수", exact: true });
  await expect(async () => { await select.scrollIntoViewIfNeeded(); }).toPass({ timeout: 5000 });
  await expect.poll(async () => { const bounds = await select.boundingBox(); return !!bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390; }).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.reload(); await open(page, "a");
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await expect.poll(async () => (await current()).activeRuns.length).toBe(1);
  assert.equal((await current()).activeRuns[0].id, "b"); assert.equal((await current()).activeRuns[0].status, "paused");
  await expect(observer.getByRole("heading", { name: "작업을 취소했습니다. 산출물은 유지됩니다.", exact: true })).toBeVisible();
  await open(page, "b"); await page.getByRole("button", { name: "재개", exact: true }).click();
  await expect.poll(async () => (await current()).activeRuns.length).toBe(0);
  assert.equal((await current()).run.status, "succeeded");
  assert.deepEqual((await current()).agents, settings.agents); assert.deepEqual(errors, []);
});
