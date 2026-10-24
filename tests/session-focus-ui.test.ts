import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { chromium, expect } from "@playwright/test";
import { initialState } from "../packages/contracts/defaults.js";
import { settingsSchema, type Run } from "../packages/contracts/index.ts";

test("Fullscreen sessions keep conversations, review drafts and documents together without changing the run", { timeout: 40000 }, async t => {
  const settings = settingsSchema.parse({ ...initialState(), language: "ko", skillRoots: [] });
  settings.projects = [{ id: "sample", name: "Focus fixture", path: "/fixture", execution: { mode: "local", branchName: "" } }];
  settings.activeProjectId = "sample";
  const plan = "# 구현 계획\n\n## 사람의 결정\n\n| ID | 질문 | 추천 |\n| --- | --- | --- |\n| D1 | 중복 요청 처리 | 기존 결과 반환 |\n\n```mermaid\nflowchart LR\n A[요청] --> B{D1 결정}\n B --> C[기존 결과 반환]\n```\n\n" + Array.from({ length: 20 }, (_, i) => `## 작업 ${i + 1}\n\n기존 인터페이스와 트랜잭션 경계를 확인합니다.\n`).join("\n");
  const diff = 'diff --git a/src/subscribe.ts b/src/subscribe.ts\n--- a/src/subscribe.ts\n+++ b/src/subscribe.ts\n@@ -10,3 +10,3 @@\n export function subscribe(email) {\n-  return { status: 409 };\n+  return { status: 200 };\n }';
  const artifacts = [
    { id: "plan", name: "implementation-plan.md", content: plan, type: "Report", agent: "Planner", stepId: "planner-step" },
    { id: "diff", name: "changes.diff", content: diff, type: "Code diff", agent: "Coder", stepId: "coder-step" },
    { id: "json", name: "evidence.json", content: '{"unsafe":"<script>window.focusAttack=true</script>"}', type: "Tool evidence", agent: "Planner", stepId: "planner-step" },
  ];
  const run: Run = {
    id: "focus-run", brief: "중복 요청 처리 계획을 함께 검토하기", createdAt: new Date().toISOString(),
    project: settings.projects[0], flow: { ...settings.flows[0], workflow: ["planner", "coder"] }, cwd: "/fixture", baseHead: null,
    status: "waiting_review", index: 1, steps: [
      { id: "planner-step", agent: settings.agents[0], sessionId: "planner-session", status: "succeeded", receivedArtifacts: [], messages: Array.from({ length: 18 }, (_, i) => ({ id: `message-${i}`, type: "assistant", time: new Date().toISOString(), text: `검토 내용 ${i + 1}: 결정할 항목을 계획서에 정리했습니다. 오른쪽의 흐름도와 함께 확인해 주세요.` })) },
      { id: "coder-step", agent: settings.agents[1], sessionId: "coder-session", status: "queued", receivedArtifacts: [], messages: [] },
    ], artifacts, note: "", approvalRequired: true, approved: false, pauseRequested: false, controlMode: "studio", eventSeq: 1, commandId: "fixture",
    review: { id: "review", stepId: "planner-step", kind: "checkpoint", artifactIds: ["plan"], fingerprint: "focus-fingerprint", version: 1, returnTo: "planner", lockOutputs: true, summary: "중복 요청의 응답 정책을 결정해 주세요. Mermaid 흐름도와 계획서를 함께 준비했습니다.", createdAt: new Date().toISOString(), codeReference: "fixture-code" },
  };
  const state = { ...settings, connections: [], revision: 1, eventSeq: 1, run, activeRuns: [run], history: [], importedSessions: [] };
  const streams = new Set<ServerResponse>(), commands: Record<string, unknown>[] = [], errors: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url!, "http://localhost").pathname;
      if (path === "/api/events") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": connected\n\n"); streams.add(res); req.on("close", () => streams.delete(res)); return; }
      if (path === "/api/runs/control") {
        let body = ""; for await (const chunk of req) body += chunk;
        const command = JSON.parse(body); commands.push(command);
        assert.equal(command.action, "request-revision");
        run.status = "running"; delete run.review; run.index = 0; run.steps[0].status = "running"; run.eventSeq = 3;
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(run)); return;
      }
      if (path.startsWith("/api/")) {
        const data = path === "/api/bootstrap" ? { csrf: "fixture", state }
          : path === "/api/status" ? { service: "agent-studio", roots: [] }
          : path === "/api/catalog" ? { skills: [], sources: [], errors: [] }
          : path === "/api/settings" ? { revision: 1 }
          : path === "/api/runs/read" ? run : undefined;
        assert(data, `Unexpected API request: ${path}`);
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); return;
      }
      const file = path === "/" ? "index.html" : path.slice(1); assert(!file.includes(".."));
      const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
      res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" }); res.end(await readFile(join(process.cwd(), "dist/web", file)));
    } catch (error) { res.writeHead(400); res.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(5000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.locator('.recent-task[data-id="focus-run"]').click();
  const feedback = page.locator("#review-feedback");
  await feedback.fill("D1은 기존 결과를 반환하는 방식으로 수정해 주세요.");
  await page.getByRole("button", { name: "전체화면", exact: true }).click();
  await expect(page.locator("body")).toHaveClass(/session-expanded/);
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.locator('.session-tabs [data-tab="conversation"]')).toHaveAttribute("aria-pressed", "true");
  await expect(feedback).toHaveValue("D1은 기존 결과를 반환하는 방식으로 수정해 주세요.");
  await expect(page.locator("#focus-document .mermaid-output img")).toHaveCount(1);
  const bounds = async () => ({ left: (await page.locator(".session").boundingBox())!, right: (await page.locator(".focused-evidence").boundingBox())! });
  await expect.poll(async () => { const { left, right } = await bounds(); return left.x + left.width <= right.x && right.x + right.width <= 1440; }).toBe(true);
  await page.locator(".session-content").evaluate(el => { el.scrollTop = 120; });
  await page.locator("#focus-document").evaluate(el => { el.scrollTop = 200; });
  const documentNode = await page.locator("#focus-document").elementHandle();
  const inputNode = await feedback.elementHandle(); await feedback.focus(); await page.keyboard.press("ArrowLeft");
  const selection = await feedback.evaluate(el => (el as HTMLTextAreaElement).selectionStart);
  run.steps[0].messages.push({ id: "live-message", type: "assistant", time: new Date().toISOString(), text: "실시간 갱신 후에도 검토를 계속할 수 있습니다." });
  for (const stream of streams) stream.write(`id: 2\nevent: run\ndata: ${JSON.stringify({ ...run, eventSeq: 2 })}\n\n`);
  await expect(page.getByText("실시간 갱신 후에도 검토를 계속할 수 있습니다.", { exact: true })).toHaveCount(1);
  await expect.poll(async () => (await page.locator("#focus-document").evaluate(el => el.scrollTop))).toBe(200);
  assert(await documentNode!.evaluate(el => el.isConnected)); assert(await inputNode!.evaluate(el => el.isConnected));
  assert.equal(await feedback.evaluate(el => (el as HTMLTextAreaElement).selectionStart), selection);
  const divider = page.getByRole("separator", { name: "대화와 자료 영역 너비 조절" });
  await divider.focus(); await page.keyboard.press("ArrowRight"); await expect(divider).toHaveAttribute("aria-valuenow", "46");
  const handle = (await divider.boundingBox())!;
  await page.mouse.move(handle.x + 4, handle.y + 50); await page.mouse.down(); await page.mouse.move(760, handle.y + 50); await page.mouse.up();
  await expect.poll(async () => Number(await divider.getAttribute("aria-valuenow"))).toBeGreaterThan(50);
  await expect.poll(async () => { const { left, right } = await bounds(); return left.x + left.width <= right.x; }).toBe(true);
  await page.getByRole("button", { name: "원문", exact: true }).click();
  await expect(page.locator("#focus-document .source-line code").first()).toHaveText("# 구현 계획");
  await page.getByRole("button", { name: "미리보기", exact: true }).click();
  await page.getByRole("button", { name: "산출물", exact: true }).click();
  await page.locator('.focused-evidence [data-action="artifact"][data-id="diff"]').click();
  await expect(page.getByRole("tab", { name: "changes.diff", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".source-line.diff-add code")).toHaveText("+  return { status: 200 };");
  await expect(page.locator(".source-line.diff-add .source-number").last()).toHaveText("11");
  await expect(page.locator(".source-line.diff-remove .source-number").first()).toHaveText("11");
  assert.equal(await page.locator(".session-content").evaluate(el => el.scrollTop), 120);
  await page.getByRole("tab", { name: "changes.diff", exact: true }).focus(); await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "implementation-plan.md", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "changes.diff 닫기", exact: true }).click();
  await expect(page.getByRole("tab", { name: "changes.diff", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Coder 세션 보기", exact: true }).click();
  await expect(page.locator(".session-head h2")).toHaveText("Coder"); await expect(feedback).toHaveCount(0);
  await page.getByRole("button", { name: "Planner 세션 보기", exact: true }).click();
  await expect(feedback).toHaveValue("D1은 기존 결과를 반환하는 방식으로 수정해 주세요.");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "자료", exact: true }).click();
  await expect(page.locator(".session")).toBeHidden(); await expect(page.locator(".focused-evidence")).toBeVisible();
  assert(await page.locator("body").evaluate(el => el.scrollWidth <= innerWidth));
  await page.getByRole("button", { name: "대화", exact: true }).click();
  await expect(feedback).toHaveValue("D1은 기존 결과를 반환하는 방식으로 수정해 주세요.");
  await page.keyboard.press("Escape"); await expect(page.locator("body")).not.toHaveClass(/session-expanded/);
  await expect(page.getByRole("button", { name: "전체화면", exact: true })).toBeFocused();
  await expect(feedback).toHaveValue("D1은 기존 결과를 반환하는 방식으로 수정해 주세요.");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "전체화면", exact: true }).click();
  await page.getByRole("button", { name: "산출물", exact: true }).click();
  await page.locator('.focused-evidence [data-action="artifact"][data-id="json"]').click();
  await expect(page.locator("#focus-document script")).toHaveCount(0);
  await expect(page.locator("#focus-document code")).toHaveText(artifacts[2].content);
  assert.equal(await page.evaluate(() => (window as any).focusAttack), undefined);
  assert.equal(commands.length, 0); assert.equal(run.status, "waiting_review"); assert.equal(run.steps[1].status, "queued");
  await page.getByRole("button", { name: "수정 요청", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  assert.equal(commands[0].id, run.id); assert.equal(commands[0].reviewId, "review"); assert.equal(commands[0].fingerprint, "focus-fingerprint");
  assert.equal(commands[0].feedback, "D1은 기존 결과를 반환하는 방식으로 수정해 주세요.");
  await expect(page.locator("body")).toHaveClass(/session-expanded/);
  await expect(feedback).toHaveCount(0); assert.deepEqual(errors, []);
});
