import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { chromium, expect } from "@playwright/test";
import { initialState } from "../packages/contracts/defaults.js";
import { settingsSchema, type Run } from "../packages/contracts/index.ts";

test("Plan documents render safely and open in a responsive reader without approving the run", { timeout: 30000 }, async t => {
  const settings = settingsSchema.parse(initialState());
  settings.language = "ko";
  settings.skillRoots = [];
  settings.projects = [{ id: "project", name: "Reader fixture", path: "/fixture", execution: { mode: "local", branchName: "" } }];
  settings.activeProjectId = "project";
  const content = [
    "# 구현 계획 - New task", "", "## Acceptance criteria", "",
    "Preserve **atomic updates** and `memberId`. Keep New task in English.", "",
    "- [x] Inspect the project", "- [ ] Review the plan together", "",
    "1. Lock the plan", "2. Start the coder", "",
    "| Case | Expected |", "| --- | --- |", "| Duplicate request | Rejected |", "",
    "```kotlin", "fun grant(memberId: Long) = \"<untrusted>\"", "```", "",
    "> Verify concurrency before approval.", "",
    "[Official documentation](https://example.com/docs)", "[Unsafe link](javascript:alert(1))", "",
    '<img src="https://example.com/track" onerror="window.documentAttack = true">',
    '<script>window.documentAttack = true</script>',
    '<button data-action="cancel">Injected control</button>',
    '<a href="/api/reset" data-action="review-approve" onclick="window.documentAttack = true">Injected link</a>',
    '<input name="command" value="cancel"><iframe src="https://example.com/"></iframe>', "",
    ...Array.from({ length: 30 }, (_, index) => `## Step ${index + 1}\n\nCheck the current project and preserve its existing boundaries.\n`),
  ].join("\n");
  const artifacts = [
    { id: "plan", name: "implementation-plan.md", content, type: "Report", agent: "Planner", stepId: "planner-step" },
    { id: "qa", name: "qa-sheet.md", content: "# QA sheet\n\n| Check | Expected |\n| --- | --- |\n| Atomic update | No partial state |", type: "Report", agent: "Planner", stepId: "planner-step" },
    { id: "diff", name: "changes.diff", content: "-old value\n+new value\n<script>plain diff</script>", type: "Code diff", agent: "Planner", stepId: "planner-step" },
  ];
  const run: Run = {
    id: "reader-run", brief: "Review the implementation plan", createdAt: new Date().toISOString(),
    project: settings.projects[0], flow: settings.flows[0], cwd: "/fixture", baseHead: null,
    status: "waiting_review", index: 1, steps: [
      { id: "planner-step", agent: settings.agents[0], sessionId: "planner-session", status: "succeeded", receivedArtifacts: [], messages: [] },
      { id: "coder-step", agent: settings.agents[1], sessionId: "coder-session", status: "queued", receivedArtifacts: [], messages: [] },
    ],
    artifacts, note: "", approvalRequired: true, approved: false, pauseRequested: false, controlMode: "studio", eventSeq: 1, commandId: "fixture",
    review: { id: "review", stepId: "planner-step", kind: "checkpoint", artifactIds: artifacts.map(artifact => artifact.id), fingerprint: "original-fingerprint", version: 1, returnTo: "planner", lockOutputs: true, summary: "## Draft notes\n\n**Review** this draft", createdAt: new Date().toISOString(), codeReference: "fixture-code" },
  };
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
      const file = path === "/" ? "index.html" : path.slice(1);
      assert(!file.includes(".."));
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
  await page.locator('.sidebar [data-action="navigate"][data-view="runs"]').click();
  await page.locator('.history-table [data-action="open-run"][data-id="reader-run"]').click();
  const preview = page.locator(".review-document .markdown-body").first();
  await expect(page.locator(".review-summary h2")).toHaveText("Draft notes");
  await expect(preview.getByRole("heading", { name: "구현 계획 - New task", exact: true })).toBeVisible();
  await expect(preview.locator("strong")).toHaveText("atomic updates");
  await expect(preview.locator("table")).toContainText("Duplicate request");
  await expect(preview.locator("pre code")).toHaveText('fun grant(memberId: Long) = "<untrusted>"\n');
  await expect(preview.locator('input[type="checkbox"]').first()).toBeChecked();
  await expect(preview.locator('input[type="checkbox"]').last()).toBeDisabled();
  await expect(preview.locator("script, img, iframe, button, [data-action], [onclick], [onerror]")).toHaveCount(0);
  await expect(preview.getByText("Unsafe link", { exact: true })).not.toHaveAttribute("href");
  await expect(preview.getByText("Injected link", { exact: true })).not.toHaveAttribute("href");
  await expect(preview.getByRole("link", { name: "Official documentation" })).toHaveAttribute("rel", "noopener noreferrer");
  const feedback = page.locator("#review-feedback");
  await feedback.fill("Keep the atomic transaction boundary.");
  const open = page.locator('.review-document [data-action="open-document"][data-id="plan"]');
  await open.click();
  const dialog = page.getByRole("dialog", { name: "implementation-plan.md", exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(async () => (await dialog.boundingBox())!.width).toBeGreaterThanOrEqual(1000);
  await expect(dialog.locator(".markdown-body h1")).toHaveText("구현 계획 - New task");
  await dialog.getByRole("button", { name: "원문", exact: true }).click();
  await expect(dialog.locator(".document-preview")).toBeHidden();
  assert.equal(await dialog.locator(".document-source").textContent(), content);
  const downloaded = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "다운로드", exact: true }).click();
  const download = await downloaded;
  assert.equal(download.suggestedFilename(), "implementation-plan.md");
  assert.equal(await readFile((await download.path())!, "utf8"), content);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden(); await expect(open).toBeFocused();
  await expect(feedback).toHaveValue("Keep the atomic transaction boundary.");
  await open.click();
  await dialog.locator(".document-content").evaluate(element => { element.scrollTop = 400; });
  for (const stream of streams) stream.write(`id: 2\nevent: run\ndata: ${JSON.stringify({ ...run, eventSeq: 2 })}\n\n`);
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.locator(".document-content").evaluate(element => element.scrollTop)).toBe(400);
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    // Browser chrome can receive focus after the last native dialog control.
    assert(await dialog.evaluate(element => document.activeElement === document.body || element.contains(document.activeElement)));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = (await dialog.boundingBox())!;
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0 && bounds.y + bounds.height <= 844);
  assert(await dialog.locator(".document-content").evaluate(element => element.scrollWidth <= element.clientWidth));
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(feedback).toHaveValue("Keep the atomic transaction boundary.");
  await expect(open).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.evidence-panel [data-action="artifact"][data-id="qa"]').click();
  await expect(page.locator(".evidence-body .markdown-body h1")).toHaveText("QA sheet");
  await page.locator('.evidence-panel [data-action="open-document"]').click();
  await expect(page.getByRole("dialog", { name: "qa-sheet.md", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator('[data-action="all-outputs"]').click();
  await page.locator('.evidence-panel [data-action="artifact"][data-id="diff"]').click();
  await expect(page.locator(".evidence-body pre")).toHaveText(artifacts[2].content);
  await expect(page.locator(".evidence-body .markdown-body")).toHaveCount(0);
  assert.equal(await page.evaluate(() => (window as any).documentAttack), undefined);
  assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
  assert.equal(settingsWrites, 1, "Only the existing startup settings save is allowed");
  assert.equal(run.status, "waiting_review"); assert.equal(run.steps[1].status, "queued");
  assert.equal(run.review!.fingerprint, "original-fingerprint"); assert.equal(run.artifacts[0].content, content);
});
