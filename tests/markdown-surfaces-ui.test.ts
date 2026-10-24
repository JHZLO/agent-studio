import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { chromium, expect, type Locator } from "@playwright/test";
import { initialState } from "../packages/contracts/defaults.js";
import { settingsSchema, type Run, type Message } from "../packages/contracts/index.ts";

test("Markdown renders across review history, conversations, handoffs and skills without changing source data", { timeout: 60000 }, async t => {
  const settings = settingsSchema.parse({ ...initialState(), skillRoots: [] });
  settings.projects = [{ id: "sample", name: "Markdown fixture", path: "/fixture", execution: { mode: "local", branchName: "" } }];
  settings.activeProjectId = "sample";
  const at = new Date().toISOString();
  const rich = (title: string) => [
    `## ${title}`, "", "**사람이 결정할 항목**과 `memberId`를 확인합니다.", "",
    "- 첫 번째 선택", "- 두 번째 선택", "", "| Decision | Recommendation |", "| --- | --- |", "| D1 | Keep the transaction |", "",
    "```kotlin", `val key = "${"long-value".repeat(24)}"`, "```", "",
    "```mermaid", "flowchart LR", "A[Draft] --> B[Human review]", "```", "",
    "[Documentation](https://example.com/docs)", "[Unsafe](javascript:alert(1))", "",
    '<script>window.markdownAttack = true</script>', '<img src="https://example.com/track" onerror="window.markdownAttack = true">',
    '<button data-action="review-approve">Injected control</button>',
    '<a href="/api/reset" data-action="cancel">Injected action</a>',
  ].join("\n");
  const log = '## literal log\n**not markdown**\n<script>window.markdownAttack = true</script>';
  const result = JSON.stringify({ status: "completed", summary: rich("Structured summary"), artifacts: [] });
  const messages: Message[] = [
    { id: "assistant", type: "assistant", text: rich("Agent answer"), time: at },
    { id: "user", type: "user", text: rich("User feedback"), time: at },
    { id: "result", type: "assistant", text: result, time: at },
    { id: "tool", type: "tool", text: log, time: at },
    { id: "system", type: "system", text: log, time: at },
  ];
  const binding = { id: "skill", name: "Markdown skill", version: "a".repeat(64), fileCount: 1 };
  const skillContent = `---\nname: markdown-skill\ndescription: Fixture instructions\n---\n\n${rich("Skill instructions")}`;
  const skill = { ...binding, path: "/fixture/SKILL.md", description: "Fixture instructions", sources: ["Fixture"], requirements: [], files: [{ path: "SKILL.md", content: skillContent }] };
  const agent = { ...settings.agents[0], prompt: rich("Frozen instructions"), skillSnapshots: [binding] };
  const step = { id: "planner-step", agent, sessionId: "session", status: "succeeded" as const, receivedArtifacts: [], completedAt: at, attempt: 2, messages, finalText: result };
  const review = { id: "review", stepId: step.id, kind: "checkpoint" as const, artifactIds: ["plan"], fingerprint: "original", version: 2, returnTo: "planner", lockOutputs: true, summary: rich("Human decisions"), createdAt: at, codeReference: "fixture" };
  const run: Run = {
    id: "markdown-run", brief: "## Task goal\n\n- Preserve **atomicity**", createdAt: at, completedAt: at,
    project: settings.projects[0], flow: { ...settings.flows[0], workflow: [agent.id] }, cwd: "/fixture", baseHead: null,
    status: "succeeded", index: 1, steps: [step],
    stepHistory: [{ ...step, id: "earlier-step", attempt: 1, feedback: rich("Revision feedback") }],
    reviewHistory: [
      { ...review, id: "earlier-review", version: 1, action: "revision_requested", feedback: rich("Requested changes"), resolvedAt: at },
      { ...review, action: "approved", resolvedAt: at },
    ],
    revisionHistory: [{ id: "revision", sourceStepId: "earlier-step", sourceAgentId: agent.id, targetAgentId: agent.id, summary: rich("Revision cause"), artifactIds: [], automatic: true, createdAt: at, cycle: 1, maxCycles: 2,
      findings: [{ id: "finding", title: "Atomicity", severity: "high", location: "service.kt:12", reproduction: rich("Reproduction steps"), expected: rich("Expected behavior"), actual: rich("Observed behavior"), evidence: [] }] }],
    artifacts: [
      { id: "plan", name: "implementation-plan.md", type: "Plan", agent: agent.name, stepId: step.id, content: rich("Current draft") },
      { id: "old-plan", name: "implementation-plan.md", type: "Plan", agent: agent.name, stepId: "earlier-step", content: rich("Previous draft"), superseded: true },
    ],
    note: "Complete", approvalRequired: true, approved: true, pauseRequested: false, controlMode: "studio", eventSeq: 1, commandId: "fixture",
  };
  const imported = { key: "imported", title: "Imported markdown", provider: "codex", cwd: "/fixture", project: settings.projects[0], updatedAt: at, importedAt: at, messages, messageCount: messages.length, total: messages.length, nextOffset: null };
  const state = { ...settings, connections: [], revision: 1, eventSeq: 1, run, activeRuns: [], history: [], importedSessions: [imported] };
  const original = structuredClone(run);
  const streams = new Set<ServerResponse>(), unexpected: string[] = [], errors: string[] = [], external: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url!, "http://localhost").pathname;
      if (path === "/api/events") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": connected\n\n"); streams.add(res); req.on("close", () => streams.delete(res)); return; }
      if (path.startsWith("/api/")) {
        const data = path === "/api/bootstrap" ? { csrf: "fixture", state } : path === "/api/status" ? { service: "agent-studio", roots: [] }
          : path === "/api/catalog" ? { skills: [skill], sources: [], errors: [] } : path === "/api/settings" ? { revision: 1 }
          : path === "/api/runs/read" ? run : path === "/api/local/read" ? imported : ["/api/skill", "/api/snapshot"].includes(path) ? skill : undefined;
        if (data === undefined) { unexpected.push(path); throw new Error(`Unexpected API request: ${path}`); }
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
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/, route => { external.push(route.request().url()); return route.abort(); });
  const checkRich = async (container: Locator, title: string) => {
    await expect(container.locator("h2")).toHaveText(title);
    await expect(container.locator("strong")).toHaveText("사람이 결정할 항목");
    await expect(container.locator("ul > li")).toHaveCount(2);
    await expect(container.locator("table")).toContainText("Keep the transaction");
    await expect(container.locator(".mermaid-output img")).toHaveCount(1);
    await expect(container.locator('script, iframe, button, [data-action], [onclick], [onerror], img[src^="http"]')).toHaveCount(0);
    await expect(container.getByText("Unsafe", { exact: true })).not.toHaveAttribute("href");
    await expect(container.getByText("Injected action", { exact: true })).not.toHaveAttribute("href");
    await expect(container.getByRole("link", { name: "Documentation" })).toHaveAttribute("rel", "noopener noreferrer");
  };
  const tab = (name: string) => page.locator(`[data-action="session-tab"][data-tab="${name}"]`).first().click();
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.locator('.recent-task[data-id="markdown-run"]').click(); await tab("review");
  await checkRich(page.locator(".revision-banner .revision-summary"), "Revision cause");
  await checkRich(page.locator(".revision-evidence .revision-summary"), "Revision cause");
  await page.locator(".review-history > summary").click();
  await checkRich(page.locator(".review-history-body").first(), "Requested changes");
  await checkRich(page.locator(".review-history-body").last(), "Human decisions");
  await page.locator(".review-compare > summary").click();
  await checkRich(page.locator(".review-diff section").first(), "Previous draft");
  await checkRich(page.locator(".review-diff section").last(), "Current draft");
  for (const stream of streams) stream.write(`id: 2\nevent: run\ndata: ${JSON.stringify({ ...run, eventSeq: 2, reviewHistory: [run.reviewHistory![0]] })}\n\n`);
  await checkRich(page.locator(".review-feedback-summary"), "Requested changes");
  for (const stream of streams) stream.write(`id: 3\nevent: run\ndata: ${JSON.stringify({ ...run, eventSeq: 3 })}\n\n`);
  await expect(page.locator(".review-feedback-summary")).toHaveCount(0);
  await page.locator(".review-history > summary").click();
  await page.locator(".review-compare > summary").click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.locator("body").evaluate(el => el.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Full screen", exact: true }).click();
  await tab("review");
  await page.locator(".review-history > summary").click();
  await checkRich(page.locator(".review-history-body").last(), "Human decisions");
  await tab("conversation");
  await checkRich(page.locator(".session-content .message.assistant").first(), "Agent answer");
  await checkRich(page.locator(".session-content .message.user"), "User feedback");
  await checkRich(page.locator(".session-content .message.assistant").last(), "Structured summary");
  await expect(page.locator(".markdown-body .markdown-body")).toHaveCount(0);
  assert.equal(await page.locator(".message.system .message-text").textContent(), log);
  await tab("tools"); assert.equal(await page.locator(".message.tool .message-text").textContent(), log);
  await expect(page.locator(".message.tool .markdown-body")).toHaveCount(0);
  await tab("revisions");
  await checkRich(page.locator(".revision-record .revision-summary"), "Revision cause");
  await checkRich(page.locator(".revision-finding dd").nth(0), "Reproduction steps");
  await checkRich(page.locator(".revision-finding dd").nth(1), "Expected behavior");
  await checkRich(page.locator(".revision-finding dd").nth(2), "Observed behavior");
  await tab("attempts"); await page.locator(".attempts-list > details > summary").first().click();
  const earlier = page.locator(".attempts-list > details").first();
  await checkRich(earlier.locator(".handoff-card"), "Revision feedback");
  await checkRich(earlier.locator(".message.assistant").first(), "Agent answer");
  await checkRich(earlier.locator(".message.user"), "User feedback");
  await checkRich(earlier.locator(".message.assistant").last(), "Structured summary");
  assert.equal(await earlier.locator("pre.artifact-preview").textContent(), result);
  await tab("handoff");
  await expect(page.locator(".handoff-card > .markdown-body").first().locator("h2")).toHaveText("Task goal");
  await checkRich(page.locator(".handoff-card > .markdown-body").last(), "Frozen instructions");
  await page.locator('[data-action="skill-snapshot"]').click();
  await checkRich(page.locator(".skill-document"), "Skill instructions");
  await expect(page.locator(".skill-document")).not.toContainText("description: Fixture instructions");
  await page.locator(".skill-raw-source > summary").click(); assert.equal(await page.locator(".skill-source").textContent(), skillContent);
  await page.keyboard.press("Escape"); await page.getByRole("button", { name: "Exit full screen", exact: true }).click();
  await page.locator('.sidebar [data-view="skills"]').click(); await page.locator('[data-action="skill-detail"]').click();
  await checkRich(page.locator(".skill-document"), "Skill instructions");
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.locator(".modal-body").evaluate(el => el.scrollWidth <= el.clientWidth));
  await page.keyboard.press("Escape"); await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.sidebar [data-view="imported"]').click(); await page.getByRole("button", { name: "Read session", exact: true }).click();
  await checkRich(page.locator(".import-conversation .message.assistant").first(), "Agent answer");
  await checkRich(page.locator(".import-conversation .message.user"), "User feedback");
  await checkRich(page.locator(".import-conversation .message.assistant").last(), "Structured summary");
  assert.equal(await page.locator(".import-conversation .message.tool .import-message").textContent(), log);
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.locator(".import-conversation").evaluate(el => el.scrollWidth <= el.clientWidth));
  assert.equal(await page.evaluate(() => (window as any).markdownAttack), undefined);
  assert.deepEqual(run, original); assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(external, []);
});
