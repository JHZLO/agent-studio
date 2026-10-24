import { activeStatuses } from "../../packages/contracts/index.ts";
import { t, setLanguage } from "./i18n.js";
let csrf;
let revision = 0;
let pendingState;
let saving = Promise.resolve();
let saveError;
let timer;
let queuedWrites = 0;
export const saveStatus = () => saveError ? "Save needs attention" : pendingState || queuedWrites ? "Saving..." : "Saved in local SQLite";
const announceSave = () => window.dispatchEvent(new CustomEvent("studio-save", { detail: saveStatus() }));
window.addEventListener("beforeunload", event => { if (pendingState || queuedWrites) { event.preventDefault(); event.returnValue = ""; } });
export const bootstrap = async () => {
  const response = await fetch("/api/bootstrap", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not connect to the local runner.");
  const data = await response.json(); csrf = data.csrf;
  return data;
};
export const initial = await bootstrap().catch(error => {
  const panel = document.getElementById("app");
  panel.textContent = t("The local service is unavailable. Start Agent Studio, then retry. ");
  const retry = document.createElement("button"); retry.className = "btn"; retry.textContent = t("Retry"); retry.addEventListener("click", () => location.reload()); panel.append(retry);
  throw error;
});
revision = initial.state.revision;
setLanguage(initial.state.language);

export async function request(path, body) {
  const payload = body ? JSON.stringify({ ...body, commandId: body.commandId || crypto.randomUUID() }) : undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(path, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json", "X-Studio-CSRF": csrf } : {}, body: payload, signal: AbortSignal.timeout(125000) });
      if (response.status === 401 || response.status === 403) {
        if (!attempt) { await bootstrap(); continue; }
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The local service rejected the request.");
      return data;
    } catch (error) {
      if (error instanceof TypeError && !attempt) { await new Promise(resolve => setTimeout(resolve, 500)); continue; }
      throw error;
    }
  }
  throw new Error("The local API could not be reached.");
}
const settingsOnly = state => {
  const { version, agents, flows, activeFlowId, projects, activeProjectId, skillRoots, approvalRequired, brief, navigationCollapsed, language, maxConcurrentRuns } = state;
  return structuredClone({ version, agents, flows, activeFlowId, projects, activeProjectId, skillRoots, approvalRequired, brief, navigationCollapsed, language, maxConcurrentRuns });
};
export function queueSettings(state) {
  pendingState = settingsOnly(state); announceSave();
  clearTimeout(timer); timer = setTimeout(() => { void flush().catch(error => window.dispatchEvent(new CustomEvent("studio-error", { detail: error.message }))); }, 300);
}
export async function flush() {
  clearTimeout(timer);
  if (saveError) throw saveError;
  if (pendingState) {
    const state = pendingState; pendingState = undefined;
    queuedWrites++;
    saving = saving.then(async () => { const result = await request("/api/settings", { state, revision }); revision = result.revision; }).catch(error => { saveError = error; throw error; }).finally(() => { queuedWrites--; announceSave(); });
  }
  await saving;
  if (pendingState) return flush();
}
export async function reset() {
  await flush(); const state = await request("/api/reset", {}); revision = state.revision; return state;
}
export async function removeProject(id) {
  await flush(); const result = await request("/api/projects/remove", { id, revision }); revision = result.revision; return result;
}
export async function importLocal(selection) {
  await flush(); const result = await request("/api/local/import", { ...selection, revision }); revision = result.revision; return result;
}

export class StudioEngine {
  constructor(onChange, run = null, activeRuns = [], seq = initial.state.eventSeq) {
    this.onChange = onChange; this.run = run; this.closed = false; this.seq = seq;
    this.activeRuns = new Map(activeRuns.filter(item => this.isActive(item)).map(item => [item.id, item]));
    if (this.isActive(run)) this.activeRuns.set(run.id, run);
    this.versions = new Map([...activeRuns, ...(run ? [run] : [])].map(item => [item.id, item.eventSeq]));
    this.connect();
  }
  isActive(run = this.run) { return !!run && activeStatuses.includes(run.status); }
  atCapacity(limit) { return this.activeRuns.size >= limit; }
  usesProject(id) { return [...this.activeRuns.values()].some(run => run.project.id === id); }
  update(run, latest = false) {
    if (!run || run.eventSeq < (this.versions.get(run.id) ?? -1)) return;
    this.versions.set(run.id, run.eventSeq);
    if (this.isActive(run)) this.activeRuns.set(run.id, run); else this.activeRuns.delete(run.id);
    if (latest || !this.run || this.run.id === run.id || run.createdAt > this.run.createdAt) this.run = run;
    this.onChange(structuredClone(run));
  }
  connect() {
    if (this.closed) return;
    this.events?.close();
    const events = new EventSource(`/api/events?after=${this.seq}`); this.events = events;
    events.addEventListener("run", event => {
      const seq = Number(event.lastEventId);
      if (seq <= this.seq) return;
      this.seq = seq; this.update(JSON.parse(event.data));
    });
    events.onerror = () => {
      events.close();
      if (this.closed) return;
      this.reconnect = setTimeout(async () => {
        try {
          const previous = [...this.activeRuns.keys()];
          const { state } = await bootstrap(); this.seq = state.eventSeq;
          const current = new Map([...(state.activeRuns || []), ...(state.run ? [state.run] : [])].map(run => [run.id, run]));
          for (const id of previous) if (!current.has(id)) { try { current.set(id, await request("/api/runs/read", { id })); } catch {} }
          this.activeRuns.clear();
          for (const run of current.values()) this.update(run, run.id === state.run?.id);
        } catch {}
        this.connect();
      }, 1500);
    };
  }
  async start({ brief, project, flow }) {
    await flush();
    const run = await request("/api/runs/start", { brief, projectId: project.id, flowId: flow.id }); this.update(run, true); return run;
  }
  async control(action, target = this.run) {
    try { const run = await request("/api/runs/control", { id: target.id, action, approvalId: target.approval?.id }); this.update(run); }
    catch (error) { window.dispatchEvent(new CustomEvent("studio-error", { detail: error.message })); }
  }
  async review(action, feedback = "", target = this.run) {
    const review = target.review;
    if (!review) return;
    try { this.update(await request("/api/runs/control", { id: target.id, action, reviewId: review.id, fingerprint: review.fingerprint, feedback })); }
    catch (error) { window.dispatchEvent(new CustomEvent("studio-error", { detail: error.message })); }
  }
  pause(run = this.run) { return this.control("pause", run); }
  resume(run = this.run) { return this.control("resume", run); }
  cancel(run = this.run) { return this.control("cancel", run); }
  approve(run = this.run) { return this.control("approve", run); }
  async reconcile(run = this.run) { try { this.update(await request("/api/runs/reconcile", { id: run.id })); } catch (error) { window.dispatchEvent(new CustomEvent("studio-error", { detail: error.message })); } }
  dispose() { this.closed = true; this.events?.close(); clearTimeout(this.reconnect); }
}
