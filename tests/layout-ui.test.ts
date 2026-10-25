import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { chromium, expect } from "@playwright/test";
import { initialState } from "../packages/contracts/defaults.js";
import { settingsSchema, type Run } from "../packages/contracts/index.ts";

test("Studio layouts keep controls readable and separate across languages and viewport sizes", { timeout: 180000 }, async t => {
  const settings = settingsSchema.parse({ ...initialState(), skillRoots: [] });
  settings.projects = [{ id: "layout-project", name: "Agent Studio - concurrency regression workspace", path: "/Users/fixture/projects/agent-studio/concurrency-regression-workspace", execution: { mode: "local", branchName: "" } }];
  settings.activeProjectId = settings.projects[0].id;
  settings.projects.push({ ...settings.projects[0], id: "unused-project", name: "Archived test workspace", path: "/Users/fixture/projects/archived-workspace" });
  settings.flows[0].name = "Feature delivery - concurrency review and load testing";
  settings.agents[1].name = "Concurrency and load testing engineer";
  settings.agents[1].model = "gpt-6.1-sol-with-a-long-runtime-model-name";
  const binding = { id: "layout-skill", name: "architecture-guidelines-for-kotlin-spring", version: "a".repeat(64), fileCount: 1 };
  const content = "# Architecture guidelines\n\nInspect the project before implementing the approved plan.";
  const skill = { ...binding, path: "/Users/fixture/.agents/skills/architecture-guidelines-for-kotlin-spring/SKILL.md", description: "Architecture and verification instructions for an existing Kotlin and Spring application.", sources: ["tripstore/backend/architecture-guidelines"], requirements: [], files: [{ path: "SKILL.md", content }] };
  settings.agents[1].skillBindings = [binding];
  const connections = initialState().connections.map(connection => ({ ...connection, connected: true, models: ["default", settings.agents[1].model] }));
  const at = new Date().toISOString();
  const run: Run = {
    id: "layout-run", brief: "Plan and verify the concurrency boundaries without changing the existing project architecture.", createdAt: at,
    project: settings.projects[0], flow: structuredClone(settings.flows[0]), cwd: settings.projects[0].path, baseHead: null, status: "running", index: 1,
    steps: settings.agents.map((agent, index) => ({ id: agent.id, agent, sessionId: `${agent.id}-session`, providerThreadId: `${agent.id}-thread`, status: index === 0 ? "succeeded" : index === 1 ? "running" : "queued", receivedArtifacts: [], messages: [{ id: `message-${agent.id}`, type: "assistant", time: at, text: "## Current progress\n\nInspect the existing implementation and verify the transaction boundaries." }] })),
    artifacts: [{ id: "plan", name: "implementation-plan-with-concurrency-acceptance-criteria.md", content: "# Implementation plan\n\nConfirm the transaction boundary with the user.\n\n```kotlin\nval plan = \"approved\"\n```", type: "Plan", agent: "Planner", stepId: "planner" }],
    revisionHistory: [{ id: "revision", sourceStepId: "reviewer", sourceAgentId: "reviewer", targetAgentId: "coder", summary: "The plan has changed. Implement only the approved plan after the user locks this draft. Preserve the existing architecture and verify the final persisted invariants.", artifactIds: [], findings: [], automatic: false, createdAt: at, cycle: 1, maxCycles: 3 }],
    note: "Inspect the latest revision", approvalRequired: true, approved: true, pauseRequested: false, controlMode: "studio", acceptingMessages: true, eventSeq: 1, commandId: "fixture",
  };
  const state = { ...settings, connections, revision: 1, eventSeq: 1, run, activeRuns: [run], history: [], importedSessions: [{ key: "imported", provider: "codex", title: run.brief, project: settings.projects[0], updatedAt: at, messageCount: 12, truncated: false }] };
  const streams = new Set<ServerResponse>(), errors: string[] = [], failures: string[] = [], coverage: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url!, "http://localhost").pathname;
      if (path === "/api/events") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": connected\n\n"); streams.add(res); req.on("close", () => streams.delete(res)); return; }
      if (path.startsWith("/api/")) {
        const data = path === "/api/bootstrap" ? { csrf: "fixture", state }
          : path === "/api/status" ? { service: "agent-studio", roots: [] }
          : path === "/api/catalog" ? { skills: [skill], sources: [{ label: "/Users/fixture/.agents/skills", status: "available", count: 1 }], errors: [] }
          : path === "/api/skill" ? skill
          : path === "/api/settings" ? { revision: 1 }
          : path === "/api/runs/read" ? run
          : path === "/api/project" ? { ...settings.projects[0], head: "a".repeat(40), currentBranch: "feature/concurrency-and-persisted-invariant-verification", defaultRef: "refs/heads/main", branches: [{ name: "main", ref: "refs/heads/main" }] }
          : path === "/api/folders" ? { path: "/Users/fixture/projects", parent: "/Users/fixture", folders: [{ name: settings.projects[0].name, path: settings.projects[0].path }] }
          : path === "/api/local/scan" ? { projects: [], warnings: [] }
          : path === "/api/project/files" ? { path: "", entries: [], truncated: false } : undefined;
        assert(data !== undefined, `Unexpected fixture request: ${path}`);
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); return;
      }
      const file = path === "/" ? "index.html" : path.slice(1); assert(!file.includes(".."));
      const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
      res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" }); res.end(await readFile(join(process.cwd(), "dist/web", file)));
    } catch (error) { errors.push(String(error)); res.writeHead(400); res.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" }); page.setDefaultTimeout(5000);
  page.on("pageerror", error => errors.push(error.message));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let prefix = "";
  const report = process.env.STUDIO_LAYOUT_REPORT_DIR;
  if (report) await mkdir(report, { recursive: true });
  async function inspect(name: string) {
    await page.evaluate(() => document.fonts.ready);
    coverage.push(`${prefix}/${name}`);
    const issues = await page.evaluate(() => {
      const issues: string[] = [], root = document.querySelector<HTMLDialogElement>("dialog[open]") || document.querySelector("main.page")!;
      if (document.documentElement.scrollWidth > innerWidth + 1) {
        const widest = [...document.querySelectorAll("body *")].map(el => ({ name: `${el.tagName}.${el.className}`, right: Math.round(el.getBoundingClientRect().right) })).sort((a, b) => b.right - a.right).slice(0, 3);
        issues.push(`Page overflows by ${document.documentElement.scrollWidth - innerWidth}px: ${JSON.stringify(widest)}`);
      }
      for (const el of root.querySelectorAll("button, input:not([type=hidden]), textarea, [role=combobox], .panel, .setting-row, .card-top, .card-footer")) {
        const bounds = el.getBoundingClientRect(), css = getComputedStyle(el);
        if (!bounds.width || !bounds.height || css.visibility === "hidden" || css.display === "none") continue;
        const description = `${el.tagName.toLowerCase()}.${el.className} ${(el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 65)}`;
        let scrollable = false;
        for (let ancestor = el.parentElement; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
          const css = getComputedStyle(ancestor);
          if (["auto", "scroll"].includes(css.overflowX) && ancestor.scrollWidth > ancestor.clientWidth + 1) { scrollable = true; break; }
        }
        if (!scrollable && (bounds.left < -2 || bounds.right > innerWidth + 2)) issues.push(`Outside viewport: ${description}`);
        const container = el.closest(".session, .panel, .modal-body, .card-footer");
        if (!scrollable && container && container !== el) {
          const area = container.getBoundingClientRect();
          if (bounds.left < area.left - 2 || bounds.right > area.right + 2) issues.push(`Outside container: ${description}`);
        }
        if (el.matches("button")) {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), range = document.createRange();
          let node: Node | null;
          while ((node = walker.nextNode())) {
            const parent = node.parentElement!;
            if (!node.textContent?.trim() || parent.closest(".agent-icon, .sr-only") || getComputedStyle(parent).textOverflow === "ellipsis") continue;
            range.selectNodeContents(node);
            if ([...range.getClientRects()].some(rect => rect.width && (rect.left < bounds.left - 2 || rect.right > bounds.right + 2))) { issues.push(`Button text overflows: ${description}`); break; }
          }
        }
      }
      const groups = [root, ...root.querySelectorAll(".page-heading, .panel-heading, .card-top, .card-footer, .setting-row, .modal-head, .modal-footer, .composer-context, .composer-footer, .composer-actions, .session-head, .revision-banner, .focus-header, .focus-files-bar, .focus-document-toolbar, .skill-row, .step-controls, .flow-meta")];
      for (const parent of groups) {
        const items = [...parent.children].filter(el => { const rect = el.getBoundingClientRect(), css = getComputedStyle(el); return rect.width > 0 && rect.height > 0 && css.visibility !== "hidden" && css.display !== "none" && !el.matches("svg, .activity-dock"); });
        for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
          const a = items[i].getBoundingClientRect(), b = items[j].getBoundingClientRect();
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) issues.push(`Overlap: ${items[i].tagName}.${items[i].className} / ${items[j].tagName}.${items[j].className}`);
        }
      }
      return [...new Set(issues)];
    });
    failures.push(...issues.map(issue => `${prefix}/${name}: ${issue}`));
    if (["agent-editor", "defaults", "step-settings", "environment-ready"].includes(name)) {
      const controls = page.locator((await page.locator("dialog[open]").count() ? "#modal" : "main.page") + " .select-trigger:visible:not(:disabled)");
      for (const control of await controls.all()) {
        await control.click();
        const menu = page.locator('.select-menu:popover-open'), bounds = await menu.boundingBox();
        if (!bounds || bounds.width < 200 || bounds.x < 0 || bounds.x + bounds.width > page.viewportSize()!.width || bounds.y < 0 || bounds.y + bounds.height > page.viewportSize()!.height) failures.push(`${prefix}/${name}: Dropdown is clipped or too narrow`);
        await control.press("Escape");
      }
    }
    if (report) await writeFile(join(report, "report.json"), JSON.stringify({ coverage, failures, errors }, null, 2));
    if (report && (issues.length || prefix === "ko/390" || prefix === "en/1440")) await page.screenshot({ path: join(report, `${prefix.replaceAll("/", "-")}-${name}.png`) });
  }
  async function navigate(view: string) {
    for (let i = 0; i < 3 && await page.locator("dialog[open]").count(); i++) await page.locator('#modal [data-action="close-modal"]').first().click();
    if (await page.locator("body.session-expanded").count()) await page.locator('.focus-header [data-action="session-fullscreen"]').click();
    if ((page.viewportSize()?.width || 0) <= 600) await page.locator('[data-action="open-navigation"]').click();
    await page.locator(`.sidebar [data-action="navigate"][data-view="${view}"]`).click();
    await expect(page.locator(`.page-${view}`)).toBeVisible();
  }
  async function dialog(name: string, action: string, within = "#main-content") {
    await page.locator(`${within} [data-action="${action}"]`).first().click();
    await expect(page.locator("#modal[open] .modal-body")).toBeVisible(); await inspect(name);
  }
  const publish = () => { run.eventSeq++; for (const stream of streams) stream.write(`id: ${run.eventSeq}\nevent: run\ndata: ${JSON.stringify(run)}\n\n`); };
  for (const language of ["en", "ko"] as const) for (const width of [320, 390, 768, 1024, 1440]) {
    state.language = language; delete run.review; run.status = "running"; run.index = 1;
    prefix = `${language}/${width}`;
    await page.setViewportSize({ width, height: 1000 }); await page.goto(origin); await expect(page.locator(".page-home")).toBeVisible();
    await inspect("home");
    await dialog("projects", "project-picker");
    await page.locator('#modal [data-action="remove-project"][data-id="unused-project"]').click(); await inspect("remove-project");
    await page.locator('#modal [data-action="close-modal"]').first().click(); await dialog("projects-again", "project-picker");
    await dialog("create-project", "new-project", "#modal");
    await dialog("folders", "browse-folders", "#modal");
    await page.locator('#modal [data-action="close-modal"]').first().click();
    await dialog("environment", "project-settings"); await expect(page.locator("#project-settings-form")).toBeVisible(); await inspect("environment-ready");
    await navigate("team"); await inspect("flows");
    await page.locator('.node [data-action="select-agent"]').first().click(); await inspect("step-settings");
    await dialog("recommended-rules", "flow-recommended"); await page.locator('#modal [data-action="close-modal"]').first().click();
    await dialog("flow-library", "flow-picker"); await dialog("create-flow", "new-flow", "#modal");
    await navigate("agents"); await inspect("agents");
    await dialog("create-agent", "new-agent"); await page.locator('#modal [data-action="close-modal"]').first().click();
    await page.locator('[data-action="edit-agent"][data-id="coder"]').click(); await inspect("agent-editor");
    await dialog("skill-picker", "choose-skills", "#modal");
    await navigate("skills"); await inspect("skills");
    await dialog("skill-content", "skill-detail");
    await page.locator('#modal [data-action="close-modal"]').first().click(); await dialog("skill-sources", "skill-sources");
    await navigate("connections"); await inspect("connections"); await dialog("connection", "connect");
    await navigate("runs"); await inspect("tasks");
    await page.locator('.history-table [data-action="open-run"][data-id="layout-run"]').first().click(); await inspect("task-details");
    const revisions = run.revisionHistory; delete run.revisionHistory; publish(); await expect(page.locator(".revision-banner")).toHaveCount(0); await inspect("task-without-revisions");
    run.revisionHistory = revisions; publish(); await expect(page.locator(".revision-banner")).toBeVisible();
    await page.locator('[data-action="run-layout"][data-layout="map"]').click(); await inspect("task-agents");
    await page.locator('[data-action="run-layout"][data-layout="details"]').click();
    for (const tab of ["tools", "handoff", "attempts", "revisions", "terminal", "conversation"]) { await page.locator(`[data-action="session-tab"][data-tab="${tab}"]`).first().click(); await inspect(`session-${tab}`); }
    await page.locator('[data-action="session-fullscreen"]').click(); await inspect("fullscreen-conversation");
    if (width <= 720) await page.locator('[data-action="focus-pane"][data-pane="document"]').click();
    await page.locator('.focused-evidence [data-action="artifact"][data-id="plan"]').first().click();
    await inspect("fullscreen-document");
    await page.locator('[data-action="focus-format"][data-format="source"]').click(); await inspect("fullscreen-source");
    await page.locator('.focus-header [data-action="session-fullscreen"]').click();
    run.review = { id: "review", stepId: "planner", kind: "checkpoint", artifactIds: ["plan"], fingerprint: "fixture", version: 1, returnTo: "planner", lockOutputs: true, summary: "Review the plan and confirm the concurrency strategy before implementation.", createdAt: at, codeReference: "fixture" };
    run.status = "waiting_review"; publish(); await expect(page.locator(".review-workspace")).toBeVisible(); await inspect("plan-review");
    await dialog("document-reader", "open-document");
    await navigate("imported"); await inspect("imported"); await dialog("import-projects", "import-local");
    await navigate("defaults"); await inspect("defaults"); await dialog("help", "help");
    await page.locator('#modal [data-action="close-modal"]').first().click(); await dialog("reset", "reset");
    await page.locator('#modal [data-action="close-modal"]').first().click();
    t.diagnostic(`${prefix}: ${coverage.filter(name => name.startsWith(prefix + "/")).length} surfaces checked`);
  }
  if (report) await writeFile(join(report, "report.json"), JSON.stringify({ coverage, failures, errors }, null, 2));
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
});
