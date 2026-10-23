import { mkdir, writeFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";

const origin = process.env.STUDIO_TEST_ORIGIN || "http://127.0.0.1:4184";
const root = resolve(import.meta.dirname, "..");
const fixture = join(root, ".local", `sample-${Date.now()}`);
await mkdir(fixture, { recursive: true });
const files = {
  "package.json": JSON.stringify({ name: "studio-smoke-fixture", private: true, type: "module", scripts: { test: "node --test", start: "node server.mjs" } }),
  "server.mjs": `import {createServer} from 'node:http';\nimport {readFile} from 'node:fs/promises';\nimport {pathToFileURL} from 'node:url';\nexport function createApp(){return createServer(async(req,res)=>{if(req.method==='GET'&&req.url==='/'){res.setHeader('content-type','text/html');res.end(await readFile(new URL('./index.html',import.meta.url)));return;}res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({error:'Not implemented'}));});}\nif(import.meta.url===pathToFileURL(process.argv[1]).href)createApp().listen(Number(process.env.PORT||4196),'127.0.0.1',()=>console.log('Fixture ready on 4196'));\n`,
  "index.html": `<!doctype html><html lang="en"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Newsletter test app</title><h1>Newsletter</h1><form id="signup" novalidate><label for="email">Email</label><input id="email" name="email" type="email"><button type="submit">Subscribe</button><p id="feedback" role="status"></p></form><script>document.querySelector('#signup').addEventListener('submit',event=>{event.preventDefault();document.querySelector('#feedback').textContent='Not implemented';});</script></html>`,
  "server.test.mjs": `import test from 'node:test';import assert from 'node:assert/strict';import {createApp} from './server.mjs';\ntest('Newsletter API validates and preserves duplicates',async()=>{const app=createApp();await new Promise(r=>app.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+app.address().port+'/api/subscribe';try{for(const [email,status] of [['',422],['wrong',422],['reader@example.test',201],['reader@example.test',200]]){const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});assert.equal(response.status,status,email);const body=await response.json();assert.ok(body.message||body.error);}}finally{await new Promise(r=>app.close(r));}});\n`,
  "README.md": "# Newsletter fixture\n\nRun with `node server.mjs` on 127.0.0.1:4196. Run tests with `node --test`. API and UI are not implemented yet.\n",
};
for (const [name, value] of Object.entries(files)) await writeFile(join(fixture, name), value);
execFileSync("git", ["init", "-q", fixture]);
execFileSync("git", ["-C", fixture, "add", "package.json", "server.mjs", "index.html", "server.test.mjs", "README.md"]);
execFileSync("git", ["-C", fixture, "-c", "user.name=Studio Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Initialize test fixture"]);
let cookie = "", csrf = "";
async function bootstrap() {
  const response = await fetch(`${origin}/api/bootstrap`, { headers: cookie ? { Cookie: cookie } : {} });
  cookie = response.headers.getSetCookie()[0]?.split(";")[0] || cookie;
  const data = await response.json(); csrf = data.csrf; return data.state;
}
async function call(path: string, body: object) {
  const response = await fetch(`${origin}/api/${path}`, { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "X-Studio-CSRF": csrf }, body: JSON.stringify({ ...body, commandId: randomUUID() }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
}
let state = await bootstrap();
if (state.run && ["running", "paused", "waiting_approval", "needs_reconciliation"].includes(state.run.status)) throw new Error("The isolated test instance already has an active run.");
const connection = await call("connections/check", { provider: "codex", auth: "subscription" });
assert(connection.connected, connection.error);
const metadata = await call("project", { path: await realpath(fixture) });
const project = { ...metadata, id: randomUUID(), name: "Newsletter QA fixture", execution: { mode: "worktree", baseRef: "HEAD", branchName: "" } };
state.projects.push(project); state.activeProjectId = project.id; state.skillRoots = ["~/.codex/skills"];
const catalog = await call("catalog", { roots: state.skillRoots });
const requiredSkill = catalog.skills.find((skill: any) => skill.name === "karpathy-guidelines");
assert(requiredSkill, "Attach the local coding guidelines required by this test account.");
const skillBindings = [{ id: requiredSkill.id, name: requiredSkill.name, version: requiredSkill.version }];
state.agents = state.agents.map((agent: any) => ({ ...agent, provider: "codex", auth: "subscription", model: "default", skillBindings }));
state.brief = "Implement this newsletter fixture end to end. POST /api/subscribe must return 201 for a new valid email, 200 for an existing email, and 422 for empty or invalid email. Return a JSON message or error. Implement the existing HTML form with accessible inline feedback for valid, empty, invalid, and duplicate submissions. Preserve and pass server.test.mjs. Prepare the plan and QA sheet first, review the diff, execute API cases, use a real browser for all four cases and a screenshot, and update README. Use only local 127.0.0.1:4196 for QA. Start the server once with studio_shell command 'node server.mjs' and background=true in the backend step; reuse it for frontend QA. The only other shell command needed is 'node --test'. Do not commit or push.";
await call("settings", { state, revision: state.revision });
const started = await call("runs/start", { brief: state.brief, projectId: project.id, flowId: state.activeFlowId });
console.log(JSON.stringify({ runId: started.id, fixture, cwd: started.cwd }));
await writeFile(join(root, ".local/smoke-run.json"), JSON.stringify({ runId: started.id, fixture, cwd: started.cwd, origin }, null, 2));
let previous = "";
for (let i = 0; i < 1800; i++) {
  let run;
  try { run = await call("runs/read", { id: started.id }); } catch { await delay(1000); await bootstrap(); continue; }
  const progress = `${run.index}:${run.status}:${run.approval?.id || ""}`;
  if (progress !== previous) { previous = progress; console.log(JSON.stringify({ step: run.index + 1, status: run.status, note: run.note, tools: run.steps[run.index]?.messages.filter((m: any) => m.type === "tool").length })); }
  if (run.approval) {
    const safe = run.approval.kind === "write" || (run.approval.kind === "shell" && /^(node --test|node server\.mjs)(\s*)$/.test(run.approval.details));
    if (!safe) throw new Error(`The fixture requested a command outside its test allowlist: ${run.approval.details}`);
    await call("runs/control", { id: run.id, action: "approve", approvalId: run.approval.id });
  }
  if (["succeeded", "failed", "cancelled", "needs_reconciliation"].includes(run.status)) {
    await writeFile(join(root, ".local/smoke-result.json"), JSON.stringify(run, null, 2), { mode: 0o600 });
    assert.equal(run.status, "succeeded", run.note);
    assert.equal(new Set(run.steps.map((s: any) => s.providerThreadId)).size, 6);
    assert(run.artifacts.some((a: any) => a.type === "Screenshot"));
    console.log(JSON.stringify({ passed: true, sessions: run.steps.length, artifacts: run.artifacts.length })); break;
  }
  await delay(1000);
  if (i === 1799) throw new Error("Fixture run timed out.");
}
