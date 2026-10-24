import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import { initialState } from "../packages/contracts/defaults.js";
import { flowSchema, settingsSchema } from "../packages/contracts/index.ts";
import { Store } from "../packages/engine/store.ts";

test("Agent deletion confirms affected links, persists, handles conflicts, and supports an empty library", { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "studio-agent-delete-ui-"));
  const store = new Store(join(root, "studio.sqlite")), settings = settingsSchema.parse(initialState());
  settings.skillRoots = []; settings.language = "ko";
  settings.agents = settings.agents.filter(agent => ["coder", "reviewer", "documenter"].includes(agent.id));
  settings.agents[1].delegation = { enabled: true, maxChildren: 2, allowedAgentIds: ["coder"] };
  settings.flows = [
    flowSchema.parse({ id: "main", name: "Delivery", workflow: ["coder", "reviewer", "documenter"], rules: [{ after: "coder", review: "always", returnTo: "coder" }, { after: "reviewer", review: "on_issue", returnTo: "coder", loop: { target: "coder", maxCycles: 2, onLimit: "review" } }] }),
    flowSchema.parse({ id: "archive", name: "Old flow", workflow: ["coder"], archived: true }),
  ];
  settings.activeFlowId = "main";
  store.set("settings", settings); store.close();
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
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin + "/api/bootstrap")).ok) { ready = true; break; } } catch {} await delay(100); }
  assert(ready, "The fixture API must start");
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }); page.setDefaultTimeout(5000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  const openLibrary = async () => {
    if (page.viewportSize()!.width <= 600) await page.locator('[data-action="open-navigation"]').click();
    await page.locator('[data-action="navigate"][data-view="agents"]').click();
  };
  const saved = async () => (await (await page.request.get(origin + "/api/state")).json());
  const remove = (id: string) => page.locator(`.agent-card [data-action="remove-agent"][data-id="${id}"]`);
  await openLibrary();
  await expect(page.locator(".agent-card")).toHaveCount(3);
  await expect(remove("coder")).toHaveAccessibleName("Coder 삭제");
  await remove("coder").click();
  await expect(page.locator("#modal")).toContainText("라이브러리에서 Coder 에이전트를 삭제할까요?");
  await expect(page.locator("#modal")).toContainText("Delivery");
  await expect(page.locator("#modal")).toContainText("Old flow");
  await expect(page.locator("#modal")).toContainText("규칙 2개 삭제 또는 변경");
  await expect(page.locator("#modal")).toContainText("Reviewer");
  await expect(page.locator("#modal")).toContainText("이전 대화, 설정 스냅샷, 결과물은 그대로 보존합니다");
  await page.getByRole("button", { name: "유지", exact: true }).click();
  assert.equal((await saved()).agents.length, 3);
  await page.locator('[data-action="edit-agent"][data-id="coder"]').click();
  await page.locator('#modal [data-action="remove-agent"]').click();
  await page.locator('[data-action="confirm-remove-agent"]').click();
  await expect(page.locator(".agent-card")).toHaveCount(2);
  const after = await saved();
  assert.deepEqual(after.flows[0].workflow, ["reviewer", "documenter"]);
  assert.deepEqual(after.flows[0].rules, [{ after: "reviewer", review: "on_issue", lockOutputs: false }]);
  assert.deepEqual(after.flows[1].workflow, []);
  assert.equal(after.agents.find((agent: { id: string }) => agent.id === "reviewer").delegation.enabled, false);
  await page.reload(); await openLibrary();
  await expect(page.locator(".agent-card")).toHaveCount(2);

  await remove("reviewer").click();
  const bootstrap = await (await page.request.get(origin + "/api/bootstrap")).json();
  const concurrent = await page.request.post(origin + "/api/settings", { headers: { origin, "x-studio-csrf": bootstrap.csrf }, data: { state: { ...bootstrap.state, brief: "A change from another window" }, revision: bootstrap.state.revision } });
  assert(concurrent.ok());
  await page.locator('[data-action="confirm-remove-agent"]').click();
  await expect(page.locator("#agent-remove-error")).toBeVisible();
  await expect(page.locator("#agent-remove-error")).not.toBeEmpty();
  assert.equal((await saved()).agents.length, 2);
  await expect(page.locator(".agent-card")).toHaveCount(2);
  await page.getByRole("button", { name: "유지", exact: true }).click();
  await page.reload(); await openLibrary();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(remove("reviewer")).toBeVisible();
  await expect.poll(async () => {
    const box = await remove("reviewer").boundingBox();
    return !!box && box.x >= 0 && box.x + box.width <= 390;
  }).toBe(true);
  await remove("reviewer").click();
  const modal = await page.locator("#modal").boundingBox();
  assert(modal && modal.x >= 0 && modal.x + modal.width <= 390);
  await page.locator('[data-action="confirm-remove-agent"]').click();
  await expect(page.locator(".agent-card")).toHaveCount(1);
  await remove("documenter").click();
  await page.locator('[data-action="confirm-remove-agent"]').click();
  await expect(page.locator(".agent-card")).toHaveCount(0);
  await expect(page.getByText("새 에이전트를 만들어 플로우에 추가하세요.")).toBeVisible();
  await page.reload(); await openLibrary();
  assert.deepEqual((await saved()).agents, []);
  await page.locator('[data-action="new-agent"]').first().click();
  await page.locator("#new-agent-name").fill("Replacement agent");
  await page.locator('[type="submit"][form="new-agent-form"]').click();
  await expect.poll(async () => (await saved()).agents.length).toBe(1);
  assert.equal((await saved()).agents[0].name, "Replacement agent");
  assert.deepEqual(errors, []);
});
