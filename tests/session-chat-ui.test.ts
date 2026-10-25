import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { chromium, expect } from "@playwright/test";
import { initialState } from "../packages/contracts/defaults.js";
import { settingsSchema, type Run } from "../packages/contracts/index.ts";

test("Agent conversations support separate drafts, safe rendered replies, stop and checkpoint questions in both layouts", { timeout: 40000 }, async t => {
  const settings = settingsSchema.parse({ ...initialState(), language: "ko", skillRoots: [] });
  settings.projects = [{ id: "sample", name: "Conversation fixture", path: "/fixture", execution: { mode: "local", branchName: "" } }]; settings.activeProjectId = "sample";
  const at = new Date().toISOString();
  const run: Run = { id: "chat-run", brief: "동시성 구현 결과 확인", createdAt: at, completedAt: at, project: settings.projects[0], flow: { ...settings.flows[0], workflow: ["planner", "coder", "reviewer"] }, cwd: "/fixture", baseHead: null, status: "succeeded", index: 3,
    steps: settings.agents.slice(0, 3).map(agent => ({ id: agent.id, agent, sessionId: `${agent.id}-session`, providerThreadId: `${agent.id}-thread`, status: "succeeded", receivedArtifacts: [], completedAt: at, messages: [{ id: `message-${agent.id}`, type: "assistant", time: at, text: JSON.stringify({ summary: "## 확인 결과\n\n- 트랜잭션 경계를 확인했습니다.\n- 추가 질문을 보내주세요.\n<script>window.chatAttack=true</script>", status: "completed", artifacts: [] }) }] })),
    artifacts: [{ id: "plan", name: "implementation-plan.md", content: "# 구현 계획\n\n트랜잭션 경계와 동시성 테스트", type: "Plan", agent: "Planner", stepId: "planner" }], note: "Complete", approvalRequired: true, approved: true, pauseRequested: false, controlMode: "studio", eventSeq: 1, commandId: "fixture" };
  const state = { ...settings, connections: [], revision: 1, eventSeq: 1, run, activeRuns: [], history: [], importedSessions: [] };
  const streams = new Set<ServerResponse>(), commands: any[] = [], errors: string[] = []; let rejectMessage = false;
  function emit() { run.eventSeq++; for (const stream of streams) stream.write(`id: ${run.eventSeq}\nevent: run\ndata: ${JSON.stringify(run)}\n\n`); }
  function finish() { const followup = run.followup!; run.status = followup.previousStatus; run.steps.find(step => step.id === followup.stepId)!.status = followup.previousStepStatus; delete run.followup; emit(); }
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url!, "http://localhost").pathname;
      if (path === "/api/events") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": connected\n\n"); streams.add(res); req.on("close", () => streams.delete(res)); return; }
      if (path === "/api/runs/message" || path === "/api/runs/control") {
        let body = ""; for await (const chunk of req) body += chunk; const input = JSON.parse(body); commands.push({ path, ...input }); assert.equal(input.id, run.id);
        if (path.endsWith("/message") && input.mode) {
          const queued = { id: `queued-${commands.length}`, stepId: input.stepId, message: input.message, mode: input.mode, createdAt: at };
          const queue = run.pendingMessages ??= []; if (input.mode === "interrupt") { queue.unshift(queued); run.interruptRequested = true; } else queue.push(queued);
          emit(); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(run)); return;
        }
        if (input.action === "remove-message") {
          run.pendingMessages = run.pendingMessages?.filter(item => item.id !== input.messageId); emit();
          res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(run)); return;
        }
        if (path.endsWith("/message")) {
          if (rejectMessage) { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "The concurrent task limit is reached. Finish a task before sending a message." })); return; }
          const step = run.steps.find(item => item.id === input.stepId)!;
          run.followup = { id: `reply-${commands.length}`, stepId: step.id, message: input.message, startedAt: new Date().toISOString(), previousStatus: run.status, previousStepStatus: step.status, previousNote: run.note, codeReference: "fixture" };
          run.status = "running"; step.status = "running"; step.messages.push({ id: `user-${commands.length}`, type: "user", text: input.message, time: new Date().toISOString() }); emit();
        } else { assert.equal(input.action, "stop-message"); finish(); }
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(run)); return;
      }
      if (path.startsWith("/api/")) {
        const data = path === "/api/bootstrap" ? { csrf: "fixture", state } : path === "/api/status" ? { service: "agent-studio", roots: [] } : path === "/api/catalog" ? { skills: [], sources: [], errors: [] } : path === "/api/settings" ? { revision: 1 } : path === "/api/runs/read" ? run : undefined;
        assert(data, `Unexpected API request: ${path}`); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); return;
      }
      const file = path === "/" ? "index.html" : path.slice(1); assert(!file.includes(".."));
      const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }; res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" }); res.end(await readFile(join(process.cwd(), "dist/web", file)));
    } catch (error) { res.writeHead(400); res.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(5000); page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`); await page.locator('.recent-task[data-id="chat-run"]').click();
  const composer = page.locator("#session-message"), send = page.getByRole("button", { name: "메시지 보내기", exact: true });
  const timing = page.getByRole("group", { name: "명령 처리 방식", exact: true });
  const queue = timing.getByRole("button", { name: "큐에 추가", exact: true }), interrupt = timing.getByRole("button", { name: "현재 작업 조정", exact: true });
  async function checkTimingLayout(name: string) {
    await expect(queue).toBeVisible(); await expect(interrupt).toBeVisible();
    const layout = await page.locator(".session-composer").evaluate(form => {
      const group = form.querySelector(".message-mode-switch")!.getBoundingClientRect(), input = form.querySelector("textarea")!.getBoundingClientRect(), submit = form.querySelector('[type="submit"]')!.getBoundingClientRect();
      return { fits: group.left >= 0 && group.right <= innerWidth && submit.right <= innerWidth, clearsInput: group.top >= input.bottom, separate: submit.left >= group.right || submit.top >= group.bottom, labels: [...form.querySelectorAll(".message-mode-switch span")].every(label => label.getBoundingClientRect().height < 25 && label.scrollWidth <= label.clientWidth) };
    });
    assert.deepEqual(layout, { fits: true, clearsInput: true, separate: true, labels: true });
    if (process.env.STUDIO_SCREENSHOT_DIR) { await expect(page.locator("#toast")).not.toHaveClass(/show/); await mkdir(process.env.STUDIO_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.STUDIO_SCREENSHOT_DIR, `composer-${name}.png`), fullPage: true }); }
  }
  await expect(composer).toBeVisible(); await expect(page.locator(".session-content h2")).toHaveText("확인 결과"); assert.equal(await page.evaluate(() => (window as any).chatAttack), undefined);
  await composer.fill("계획 관련 질문 초안");
  await page.getByRole("button", { name: "Coder 세션 보기", exact: true }).click(); await expect(composer).toHaveValue("");
  await composer.fill("코더 질문"); await composer.press("Enter"); await composer.press("a"); await expect(composer).toHaveValue("코더 질문\na");
  await page.getByRole("button", { name: "Planner 세션 보기", exact: true }).click(); await expect(composer).toHaveValue("계획 관련 질문 초안");
  await page.getByRole("button", { name: "Coder 세션 보기", exact: true }).click();
  await page.getByRole("button", { name: "전체화면", exact: true }).click(); await expect(composer).toHaveValue("코더 질문\na");
  await expect(page.locator("#focus-document h1")).toHaveText("구현 계획");
  const inputNode = await composer.elementHandle(), documentNode = await page.locator("#focus-document").elementHandle();
  await composer.focus(); await composer.press("ArrowLeft"); const selection = await composer.evaluate(el => (el as HTMLTextAreaElement).selectionStart);
  emit(); await expect.poll(() => inputNode!.evaluate(el => el.isConnected)).toBe(true);
  await expect.poll(() => composer.evaluate(el => (el as HTMLTextAreaElement).selectionStart)).toBe(selection);
  await composer.press("Control+Enter"); await expect.poll(() => commands.length).toBe(1);
  assert.equal(commands[0].stepId, "coder"); assert.equal(commands[0].message, "코더 질문\na");
  await expect(composer).toHaveValue(""); await expect(page.locator(".next-action h2")).toHaveText("Coder이 답변하고 있습니다");
  await expect(page.locator(".session-head h2")).toHaveText("Coder"); assert.equal(run.index, 3);
  await composer.fill("다음 질문 초안"); await composer.press("Control+Enter"); assert.equal(commands.length, 1);
  run.steps[1].messages.push({ id: "streamed", type: "assistant", text: "동시성 테스트의 실제 결과를 확인하고 있습니다.", time: at }); emit();
  await expect(page.getByText("동시성 테스트의 실제 결과를 확인하고 있습니다.", { exact: true })).toHaveCount(1);
  assert(await inputNode!.evaluate(el => el.isConnected)); assert(await documentNode!.evaluate(el => el.isConnected));
  await expect(composer).toHaveValue("다음 질문 초안");
  await page.locator('.session-composer [data-action="stop-message"]').click(); await expect(send).toBeEnabled(); assert.equal(commands[1].action, "stop-message"); assert.equal(run.status, "succeeded");
  rejectMessage = true; await send.click(); await expect(page.getByText("동시 실행 제한에 도달했습니다. 진행 중인 작업이 끝난 뒤 메시지를 보내세요.", { exact: true })).toBeVisible(); await expect(composer).toHaveValue("다음 질문 초안");
  rejectMessage = false; await send.click(); await expect.poll(() => commands.filter(item => item.path.endsWith("/message")).length).toBe(3); finish(); await expect(send).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 }); await expect(composer).toBeVisible(); assert(await page.locator("body").evaluate(el => el.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 1000 });
  run.status = "waiting_review"; run.index = 1;
  run.review = { id: "review", stepId: "planner", kind: "checkpoint", artifactIds: ["plan"], fingerprint: "fingerprint", version: 1, returnTo: "planner", lockOutputs: true, summary: "사람이 결정할 항목", createdAt: at, codeReference: "fixture" }; emit();
  const feedback = page.locator("#review-feedback"); await expect(feedback).toBeVisible(); await feedback.fill("D1의 장단점을 설명해 주세요.");
  await page.getByRole("button", { name: "질문 보내기", exact: true }).click(); await expect.poll(() => commands.at(-1)?.stepId).toBe("planner");
  assert.equal(run.review?.id, "review"); assert.equal(commands.at(-1).path, "/api/runs/message"); finish();
  await expect(page.getByRole("button", { name: "확정 후 계속", exact: true })).toBeVisible();
  delete run.review; run.status = "running"; run.index = 1; run.steps[1].status = "running"; run.acceptingMessages = true; emit();
  await page.getByRole("button", { name: "Coder 세션 보기", exact: true }).click();
  await expect(queue).toHaveAttribute("aria-pressed", "true"); await expect(interrupt).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("combobox", { name: "명령 처리 방식" })).toHaveCount(0);
  await checkTimingLayout("fullscreen");
  await composer.fill("턴이 끝나면 회귀 테스트도 확인"); await send.click();
  await expect.poll(() => commands.at(-1)?.mode).toBe("queue"); await expect(composer).toHaveValue("");
  await expect(page.getByRole("region", { name: "대기 중인 명령" })).toContainText("턴이 끝나면 회귀 테스트도 확인");
  await composer.fill("아직 보내지 않은 초안"); emit(); await expect(composer).toHaveValue("아직 보내지 않은 초안");
  await page.getByRole("button", { name: "대기 명령 취소", exact: true }).click();
  await expect(page.getByRole("region", { name: "대기 중인 명령" })).toHaveCount(0); assert.equal(commands.at(-1).action, "remove-message");
  const beforeModeChange = commands.length;
  await interrupt.focus(); await interrupt.press("Enter");
  await expect(interrupt).toHaveAttribute("aria-pressed", "true"); await expect(queue).toHaveAttribute("aria-pressed", "false");
  await expect(interrupt).toBeFocused(); await expect(composer).toHaveValue("아직 보내지 않은 초안");
  emit(); await expect(interrupt).toBeFocused(); assert.equal(commands.length, beforeModeChange);
  await expect(page.locator("#session-message-hint")).toHaveText("현재 턴을 중단한 뒤 새 명령을 처리합니다. 이미 수정한 파일은 유지됩니다.");
  await composer.fill("현재 접근을 멈추고 락 순서부터 확인"); await composer.press("Control+Enter");
  await expect.poll(() => commands.at(-1)?.mode).toBe("interrupt");
  await expect(send).toBeDisabled();
  await expect(page.getByRole("region", { name: "대기 중인 명령" })).toContainText("현재 접근을 멈추고 락 순서부터 확인");
  await queue.click(); await expect(queue).toHaveAttribute("aria-pressed", "true"); await expect(send).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 }); await checkTimingLayout("fullscreen-mobile");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "전체화면 종료", exact: true }).click(); await expect(queue).toBeVisible();
  await checkTimingLayout("desktop");
  await page.setViewportSize({ width: 390, height: 844 }); await expect(composer).toBeVisible();
  await checkTimingLayout("mobile");
  await expect.poll(() => page.locator("body").evaluate(el => el.scrollWidth <= innerWidth)).toBe(true);
  assert.deepEqual(errors, []);
});
