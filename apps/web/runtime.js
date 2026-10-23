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
  panel.textContent = "The local service is unavailable. Start Agent Studio, then retry. ";
  const retry = document.createElement("button"); retry.textContent = "Retry"; retry.addEventListener("click", () => location.reload()); panel.append(retry);
  throw error;
});
revision = initial.state.revision;

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
  const { version, agents, flows, activeFlowId, projects, activeProjectId, skillRoots, approvalRequired, brief, navigationCollapsed } = state;
  return structuredClone({ version, agents, flows, activeFlowId, projects, activeProjectId, skillRoots, approvalRequired, brief, navigationCollapsed });
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

export class StudioEngine {
  constructor(onChange, run = null) { this.onChange = onChange; this.run = run; this.closed = false; this.seq = initial.state.eventSeq; this.connect(); }
  isActive() { return this.run && ["queued", "running", "paused", "waiting_approval", "cancelling", "needs_reconciliation"].includes(this.run.status); }
  update(run) { this.run = run; this.onChange(structuredClone(run)); }
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
        try { const { state } = await bootstrap(); this.seq = state.eventSeq; this.update(state.run); } catch {}
        this.connect();
      }, 1500);
    };
  }
  async start({ brief, project, flow }) {
    await flush();
    const run = await request("/api/runs/start", { brief, projectId: project.id, flowId: flow.id }); this.update(run); return run;
  }
  async control(action) {
    try { const run = await request("/api/runs/control", { id: this.run.id, action, approvalId: this.run.approval?.id }); this.update(run); }
    catch (error) { window.dispatchEvent(new CustomEvent("studio-error", { detail: error.message })); }
  }
  pause() { return this.control("pause"); }
  resume() { return this.control("resume"); }
  cancel() { return this.control("cancel"); }
  approve() { return this.control("approve"); }
  async reconcile() { try { this.update(await request("/api/runs/reconcile", { id: this.run.id })); } catch (error) { window.dispatchEvent(new CustomEvent("studio-error", { detail: error.message })); } }
  dispose() { this.closed = true; this.events?.close(); clearTimeout(this.reconnect); }
}
