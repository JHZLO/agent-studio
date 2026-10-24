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

test("Project toggles retain completed tasks and update without disrupting the current page", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "studio-project-nav-"));
  const store = new Store(join(root, "studio.sqlite"));
  const settings = settingsSchema.parse({ ...initialState(), language: "ko", maxConcurrentRuns: 3, skillRoots: [] });
  settings.projects = [];
  for (const id of ["a", "b", "empty"]) {
    const path = join(root, id); await mkdir(path);
    settings.projects.push({ id, name: `Project ${id}`, path, execution: { mode: "worktree", branchName: "" } });
  }
  const runs: Run[] = [];
  for (const [index, id] of ["a1", "a2", "b1"].entries()) {
    const cwd = join(root, id); await mkdir(cwd); await writeFile(join(cwd, "README.md"), id);
    const project = settings.projects.find(project => project.id === id[0])!;
    const artifact = { id: `plan-${id}`, name: "implementation-plan.md", type: "Report", content: `Plan ${id}`, agent: "Planner", stepId: `step-${id}` }, reference = await codeReference(cwd);
    const run: Run = { id, brief: `Task ${id}`, createdAt: `2026-01-01T00:00:0${index}.000Z`, project, flow: { ...settings.flows[0], workflow: ["planner"] }, cwd, baseHead: null, status: "waiting_review", index: 1, steps: [{ id: artifact.stepId, agent: settings.agents[0], sessionId: `session-${id}`, status: "succeeded", receivedArtifacts: [], messages: [], codeReference: reference }], artifacts: [artifact], note: "", approvalRequired: true, approved: false, pauseRequested: false, controlMode: "studio", eventSeq: 0, commandId: id, review: { id: `review-${id}`, stepId: artifact.stepId, kind: "checkpoint", artifactIds: [artifact.id], fingerprint: hash(JSON.stringify([[artifact.id, artifact.content]])), version: 1, returnTo: "planner", lockOutputs: true, summary: `Review ${id}`, createdAt: new Date().toISOString(), codeReference: reference } };
    store.saveRun(run, "review.requested"); runs.push(run);
  }
  store.saveRun({ ...runs[0], id: "finished", brief: "Finished task", status: "succeeded", review: undefined, createdAt: "2025-01-01T00:00:00.000Z" }, "run.completed");
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
  const branch = (id: string) => page.locator(`.project-branch[data-project-id="${id}"]`);
  const toggle = (id: string) => branch(id).locator('[data-action="toggle-project"]');
  const task = (id: string) => page.locator(`.project-tree [data-action="open-run"][data-id="${id}"]`);
  const current = async () => (await (await page.request.get(origin + "/api/state")).json());
  const control = async (id: string, action: string) => {
    const boot = await (await page.request.get(origin + "/api/bootstrap")).json(), run = runs.find(run => run.id === id)!;
    const response = await page.request.post(origin + "/api/runs/control", { headers: { Origin: origin, "X-Studio-CSRF": boot.csrf }, data: { id, action, reviewId: run.review!.id, fingerprint: run.review!.fingerprint } });
    assert.equal(response.status(), 200, await response.text());
  };
  await expect(toggle("a")).toHaveAttribute("aria-expanded", "true");
  await expect(branch("a").locator(".project-task-title")).toHaveText(["Task a2", "Task a1", "Finished task"]);
  await expect(branch("a").locator(".nav-count")).toHaveText("3");
  await expect(task("finished").locator(".badge")).toHaveText("완료");
  await task("finished").click();
  await expect(page.locator(".run-heading h1")).toHaveText("Finished task");
  await expect(page.locator('.artifact-row[data-id="plan-a1"]')).toBeVisible();
  await toggle("a").press("Enter"); await expect(task("a1")).toBeHidden();
  await toggle("a").press("Space"); await expect(task("a1")).toBeVisible();
  await toggle("b").click(); await expect(branch("b").locator(".project-task-title")).toHaveText("Task b1");
  await expect(toggle("b")).toBeFocused();
  await toggle("b").click();
  await toggle("empty").click(); await expect(branch("empty").locator(".project-tasks-empty")).toHaveText("아직 작업이 없습니다");
  await branch("empty").getByRole("button", { name: "Project empty에서 새 작업", exact: true }).click();
  await expect.poll(async () => (await current()).activeProjectId).toBe("empty");
  assert.equal((await current()).activeRuns.length, 3);
  await task("a1").click();
  await expect(page.locator(".run-heading h1")).toHaveText("Task a1");
  await expect(task("a1")).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "플로우", exact: true }).click();
  await page.getByRole("button", { name: "Planner 이후 동작 설정", exact: true }).click();
  await page.getByRole("combobox", { name: "사람 검토 시점", exact: true }).click();
  await page.getByRole("option", { name: "문제가 남으면 검토", exact: true }).click();
  await control("a1", "approve-review-only");
  await expect(task("a1").locator(".badge")).toHaveText("일시정지");
  await expect(page.locator('#flow-rule-form [name="review"]')).toHaveValue("on_issue");
  await expect(toggle("b")).toHaveAttribute("aria-expanded", "false");
  await task("a1").focus(); await control("a1", "cancel");
  await expect(task("a1").locator(".badge")).toHaveText("취소됨");
  await expect(task("a1")).toBeFocused();
  await expect(branch("a").locator(".nav-count")).toHaveText("3");
  await control("b1", "approve-review");
  await expect(branch("b").locator(".nav-count")).toHaveText("1");
  await toggle("b").click(); await expect(task("b1").locator(".badge")).toHaveText("완료");
  await expect(branch("b").locator(".project-tasks-empty")).toHaveCount(0);
  await expect(page.locator('#flow-rule-form [name="review"]')).toHaveValue("on_issue");
  assert.deepEqual((await current()).flows, settings.flows);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-action="open-navigation"]').click(); await task("a2").click();
  await expect(page.locator(".run-heading h1")).toHaveText("Task a2");
  await expect(page.locator(".navigation-backdrop")).toBeHidden();
  await expect(page.locator(".main")).toBeFocused();
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(task("a2")).toBeVisible(); await expect(task("a2").locator(".project-task-copy")).toBeHidden();
  await expect(task("a2")).toHaveAttribute("title", "Task a2 - 검토 필요");
  await expect.poll(async () => {
    const bounds = await task("a2").boundingBox(), nav = await page.locator(".sidebar").boundingBox();
    return !!bounds && !!nav && bounds.x >= nav.x && bounds.x + bounds.width <= nav.x + nav.width;
  }).toBe(true);
  await page.reload();
  await toggle("a").click();
  await expect(branch("a").locator(".project-task-title")).toHaveText(["Task a2", "Task a1", "Finished task"]);
  await task("finished").click(); await expect(page.locator(".run-heading h1")).toHaveText("Finished task");
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.deepEqual(errors, []);
});
