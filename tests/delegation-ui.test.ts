import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { chromium, expect } from "@playwright/test";
import { initialState } from "../packages/contracts/defaults.js";
import { settingsSchema, type Run } from "../packages/contracts/index.ts";

test("Delegation settings and child commands keep the selected target in both layouts", { timeout: 45000 }, async t => {
  const settings = settingsSchema.parse({ ...initialState(), language: "ko", skillRoots: [] });
  settings.projects = [{ id: "project", name: "Parallel fixture", path: "/fixture", execution: { mode: "local", branchName: "" } }]; settings.activeProjectId = "project";
  const at = new Date().toISOString(), agent = settings.agents[1];
  const run: Run = { id: "parent", brief: "병렬 작업과 결과 취합", createdAt: at, project: settings.projects[0], flow: { ...settings.flows[0], workflow: [agent.id] }, cwd: "/fixture", baseHead: null, status: "running", index: 0,
    steps: [{ id: "parent-step", agent, sessionId: "parent-session", providerThreadId: "parent-thread", status: "running", receivedArtifacts: [], messages: [{ id: "parent-message", type: "assistant", time: at, text: "하위 결과를 기다리고 있습니다." }] }],
    artifacts: [], note: "Delegating", approvalRequired: true, approved: true, pauseRequested: false, controlMode: "studio", eventSeq: 1, commandId: "fixture", acceptingMessages: true };
  run.children = ["Reader", "Writer"].map((name, index) => ({ ...structuredClone(run), id: `child-${index}`, cwd: `/isolated/${name}`, parent: { runId: run.id, stepId: run.steps[0].id, task: `${name}의 독립 작업`, write: index === 1, sourceReference: "snapshot", resolution: "pending" },
    steps: [{ ...structuredClone(run.steps[0]), id: `child-step-${index}`, agent: { ...agent, name }, messages: [{ id: name, type: "assistant", text: `${name} 결과를 확인합니다.`, time: at }] }],
    artifacts: [{ id: `report-${index}`, name: "child-report.md", type: "Report", agent: name, stepId: `child-step-${index}`, content: `# ${name} 결과\n\n독립 검증 자료입니다.` }] }));
  run.children[1].status = "waiting_approval"; run.children[1].approval = { id: "child-approval", stepId: "child-step-1", kind: "shell", description: "Run child tests?", details: "Isolated tests only" };
  const state = { ...settings, run, activeRuns: [run], history: [], connections: [], importedSessions: [], revision: 1, eventSeq: 1 };
  const streams = new Set<ServerResponse>(), commands: any[] = [], errors: string[] = [];
  const emit = () => { run.eventSeq++; for (const stream of streams) stream.write(`id: ${run.eventSeq}\nevent: run\ndata: ${JSON.stringify(run)}\n\n`); };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url!, "http://localhost").pathname;
      if (path === "/api/events") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": connected\n\n"); streams.add(res); req.on("close", () => streams.delete(res)); return; }
      let input: any; if (req.method === "POST") { let body = ""; for await (const chunk of req) body += chunk; input = JSON.parse(body); }
      let data: unknown;
      if (path === "/api/bootstrap") data = { csrf: "fixture", state };
      else if (path === "/api/status") data = { service: "agent-studio", roots: [] };
      else if (path === "/api/catalog") data = { skills: [], sources: [], errors: [] };
      else if (path === "/api/settings") { Object.assign(state, input.state); state.revision++; commands.push({ path, ...input }); data = { revision: state.revision }; }
      else if (path === "/api/runs/read") data = run;
      else if (path === "/api/runs/message" || path === "/api/runs/control") {
        commands.push({ path, ...input }); const child = run.children!.find(item => item.id === input.id); assert(child, "Command must target the selected child");
        if (path.endsWith("message")) (child.pendingMessages ??= []).push({ id: "queued", stepId: input.stepId, message: input.message, mode: input.mode, createdAt: at });
        else if (input.action === "approve") { assert.equal(input.approvalId, "child-approval"); delete child.approval; child.status = "running"; }
        else if (input.action === "remove-message") child.pendingMessages = [];
        data = child; emit();
      }
      else if (path === "/api/runs/files") { commands.push({ path, ...input }); data = { path: ".", parent: null, entries: [{ path: "source.ts", name: "source.ts", directory: false }] }; }
      else if (path === "/api/runs/file") { commands.push({ path, ...input }); data = { path: "source.ts", content: "export const child = true;", modifiedAt: at }; }
      if (data !== undefined) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); return; }
      assert(!path.startsWith("/api/"), `Unexpected API: ${path}`);
      const file = path === "/" ? "index.html" : path.slice(1); assert(!file.includes(".."));
      const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
      res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" }); res.end(await readFile(join(process.cwd(), "dist/web", file)));
    } catch (error) { res.writeHead(400); res.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const browser = await chromium.launch();
  t.after(async () => { await browser.close(); for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); page.setDefaultTimeout(5000); page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.locator('[data-action="navigate"][data-view="agents"]').click(); await page.locator('[data-action="edit-agent"][data-id="coder"]').click();
  await page.getByLabel("하위 에이전트 허용", { exact: true }).check();
  await page.getByRole("combobox", { name: "최대 동시 하위 에이전트" }).click(); await page.getByRole("option", { name: "2", exact: true }).click();
  await page.locator('[name="allowedAgentIds"][value="reviewer"]').check(); assert.deepEqual(await page.locator("#agent-preset-form").evaluate(form => [...(form as HTMLFormElement).elements].filter(el => "validity" in el && !(el as HTMLInputElement).validity.valid).map(el => ({ id: el.id, reason: (el as HTMLInputElement).validationMessage }))), []);
  await page.locator('button[form="agent-preset-form"]').click();
  assert.deepEqual(errors, []);
  await expect.poll(() => commands.findLast(item => item.path === "/api/settings")?.state.agents.find((item: any) => item.id === "coder").delegation).toEqual({ enabled: true, maxChildren: 2, allowedAgentIds: ["coder", "reviewer"] });
  await page.locator('[data-action="navigate"][data-view="runs"]').first().click(); await page.locator('.history-table [data-action="open-run"][data-id="parent"]').click(); await expect(page.locator(".child-step")).toHaveCount(2);
  await page.locator('[data-action="child-session"][data-id="child-0"]').click(); await expect(page.locator(".session-head h2")).toHaveText("Reader");
  const input = page.locator("#session-message"); await input.fill("Reader만 확인할 명령"); await input.press("Control+Enter");
  await expect.poll(() => commands.find(item => item.path === "/api/runs/message")?.id).toBe("child-0"); assert.equal(commands.at(-1).stepId, "child-step-0");
  await expect(page.getByRole("region", { name: "대기 중인 명령" })).toContainText("Reader만 확인할 명령"); await page.getByRole("button", { name: "대기 명령 취소", exact: true }).click();
  await expect(page.getByRole("region", { name: "대기 중인 명령" })).toHaveCount(0); await input.fill("Reader 초안 유지");
  await page.locator('[data-action="child-session"][data-id="child-1"]').click(); await expect(input).toHaveValue(""); await page.locator('[data-action="child-approve"]').click();
  await expect.poll(() => commands.at(-1)?.approvalId).toBe("child-approval"); await page.locator('[data-action="child-session"][data-id="child-0"]').click(); await expect(input).toHaveValue("Reader 초안 유지");
  await page.getByRole("button", { name: "전체화면", exact: true }).click(); await page.locator('.artifact-row[data-id="report-0"]').click(); await expect(page.locator("#focus-document h1")).toHaveText("Reader 결과");
  await page.locator('[data-action="project-files"]').first().click(); await page.locator('[data-action="project-file"][data-path="source.ts"]').click();
  await expect(page.locator("#focus-document")).toContainText("export const child = true;"); assert.equal(commands.at(-1).id, "child-0");
  await page.getByRole("group", { name: "명령 처리 방식" }).getByRole("button", { name: "현재 작업 조정", exact: true }).click(); await input.fill("Reader 작업 조정"); await input.press("Control+Enter");
  await expect.poll(() => commands.at(-1)?.mode).toBe("interrupt"); assert.equal(commands.at(-1).id, "child-0");
  await page.setViewportSize({ width: 390, height: 844 }); await expect.poll(() => page.locator("body").evaluate(el => el.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1100 }); await page.screenshot({ path: join(process.cwd(), ".local/delegation-ui.png"), fullPage: true }); assert.deepEqual(errors, []);
});
