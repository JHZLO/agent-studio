import { t, html } from "./i18n.js";
const activities = new Map();
const interactions = new Map();
let sequence = 0;
let ticker;
let dock;
const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const elapsed = start => {
  const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
  return seconds < 60 ? t`${seconds}s elapsed` : t`${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`;
};

export const activitySnapshot = () => [...activities.values()].map(item => ({ ...item }));
export function beginActivity(label) {
  const id = ++sequence;
  activities.set(id, { id, label, startedAt: Date.now() });
  refreshFeedback();
  return {
    update(next) { const item = activities.get(id); if (item) { item.label = next; refreshFeedback(); } },
    finish() { activities.delete(id); refreshFeedback(); },
  };
}
export async function trackActivity(label, operation) {
  const activity = beginActivity(label);
  try { return await operation(activity.update); }
  finally { activity.finish(); }
}

export function loadingView(label, detail = "", { compact = false, clock = true } = {}) {
  return html`<section class="wait-state${compact ? " compact" : ""}" aria-busy="true"><div class="wait-crew" aria-hidden="true"><i></i><i></i><i></i></div><div class="wait-copy"><strong role="status">${escape(t(label))}</strong>${detail ? html`<p>${escape(t(detail))}</p>` : ""}${clock ? html`<span class="wait-elapsed" data-wait-start="${Date.now()}" aria-live="off">0s elapsed</span>` : ""}</div><div class="wait-track" aria-hidden="true"><span></span></div></section>`;
}

export function beginInteraction(key, target) {
  if (interactions.has(key)) return null;
  const attributes = ["data-action", "data-id", "data-path", "form"].filter(name => target?.hasAttribute(name)).map(name => [name, target.getAttribute(name)]);
  const form = target?.form;
  const interaction = { target, elements: new Map(), matches: element => element === target || (attributes.length ? attributes.every(([name, value]) => element.getAttribute(name) === value) : form && element.form?.dataset.form === form.dataset.form && element.form?.dataset.id === form.dataset.id && element.type === "submit") };
  interactions.set(key, interaction);
  refreshFeedback();
  return () => {
    interactions.delete(key);
    for (const [element, previous] of interaction.elements) {
      element.classList.toggle("is-busy", previous.classBusy); element.disabled = previous.disabled;
      if (previous.busy === null) element.removeAttribute("aria-busy"); else element.setAttribute("aria-busy", previous.busy);
    }
    refreshFeedback();
  };
}

function clockElements() {
  return [...document.querySelectorAll("[data-wait-start]")].filter(element => !element.closest("dialog:not([open])") && !element.closest("[hidden]"));
}
function tick() {
  for (const element of clockElements()) {
    if (!Number(element.dataset.waitStart)) element.dataset.waitStart = Date.now();
    element.textContent = elapsed(Number(element.dataset.waitStart));
  }
  if (!activities.size && !clockElements().length) { clearInterval(ticker); ticker = undefined; }
}
export function refreshFeedback() {
  if (typeof document === "undefined" || !document.body) return;
  for (const interaction of interactions.values()) {
    for (const element of document.querySelectorAll("button")) if (interaction.matches(element)) {
      if (!interaction.elements.has(element)) interaction.elements.set(element, { disabled: element.disabled, busy: element.getAttribute("aria-busy"), classBusy: element.classList.contains("is-busy") });
      element.classList.add("is-busy"); element.disabled = true; element.setAttribute("aria-busy", "true");
    }
    for (const element of interaction.elements.keys()) if (!element.isConnected && element !== interaction.target) interaction.elements.delete(element);
  }
  const openModal = document.querySelector("dialog[open]");
  if (activities.size) {
    if (!dock) {
      dock = document.createElement("aside"); dock.className = "activity-dock"; dock.setAttribute("aria-label", t("Current activity"));
      dock.innerHTML = '<span class="activity-spinner" aria-hidden="true"></span><div><strong role="status"></strong><span class="wait-elapsed" aria-live="off"></span></div>';
    }
    const current = [...activities.values()].at(-1);
    const label = `${t(current.label)}${activities.size > 1 ? t` / ${activities.size} operations` : ""}`;
    if (dock.querySelector("strong").textContent !== label) dock.querySelector("strong").textContent = label;
    dock.querySelector(".wait-elapsed").dataset.waitStart = current.startedAt;
    dock.hidden = !!(openModal?.querySelector('.wait-state[aria-busy="true"]') || document.querySelector('.studio-opening .wait-state'));
    dock.classList.toggle("in-dialog", !!openModal);
    if (openModal) {
      if (dock.parentElement !== openModal) openModal.insertBefore(dock, openModal.querySelector(".modal-body"));
    } else if (dock.parentElement !== document.body) document.body.append(dock);
  } else if (dock) { dock.remove(); dock = undefined; }
  tick();
  if (!ticker && (activities.size || clockElements().length)) ticker = setInterval(tick, 1000);
}
