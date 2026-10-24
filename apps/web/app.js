import { t, html, attrs, locale, setLanguage } from "./i18n.js";
import { flowSchema } from "../../packages/contracts/index.ts";
import { roles, models, prompts, initialState, initializeFlows } from "../../packages/contracts/defaults.js";
import { initial, StudioEngine, request, queueSettings, flush, reset, removeProject, importLocal, saveStatus } from "./runtime.js";
import "./skills.js";
import { retainTerminal, mountTerminal, closeTerminalView } from "./terminal.js";
import { enhanceSelects, closeSelects } from "./selects.js";
(() => {
  "use strict";

  const app = document.getElementById("app");
  const modal = document.getElementById("modal");
  let persistent = true;
  let state = initial.state;
  setLanguage(state.language);
  state.maxConcurrentRuns ??= 1;
  document.querySelector(".skip-link").textContent = t("Skip to content");
  for (const agent of state.agents) agent.skillBindings ??= [];
  initializeFlows(state);
  state.projects ??= [];
  state.importedSessions ??= [];
  state.activeProjectId ??= state.projects[0]?.id || null;
  const catalog = new window.SkillCatalog();

  const ui = {
    view: "home", selected: null, artifactId: null, pendingOrder: null,
    sessionTab: "conversation", reviewDraft: "", reviewId: null, step: 0, followRun: true, historyId: null,
    linkFrom: null, zoom: null, connectProvider: "codex", connectAuth: "subscription",
    skillQuery: "", pickerDraft: null, pickerTarget: null, pickerQuery: "", editingAgentId: null, starting: false,
    navigationOpen: false, navigationActions: false, expandedProjects: new Set([state.activeProjectId].filter(Boolean)),
    projectDraft: null, folderRequest: null, folderListing: null,
    importCatalog: null, importRequest: null, importProjects: new Set(), importedSession: null,
  };
  let toastTimer;
  let connectionTimer;
  let resizeObserver;
  let lastFocused;
  let renderedView = null;
  let seenMessages = {};
  const mobileNavigation = matchMedia("(max-width: 600px)");

  const iconPaths = {
    folder: html`<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 2h18"/>`,
    computer: html`<rect x="4" y="3" width="16" height="13" rx="2"/><path d="M2 20h20M9 16v4m6-4v4"/>`,
    copy: html`<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>`,
    archive: html`<path d="M4 8v12h16V8M3 3h18v5H3zM9 12h6"/>`,
    sidebar: html`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m6-11-3 3 3 3"/>`,
    menu: html`<path d="M4 6h16M4 12h16M4 18h16"/>`,
    more: html`<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>`,
    search: html`<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>`,
    grid: html`<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>`,
    flow: html`<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M6 9v9h9M9 6h9v9"/>`,
    agents: html`<circle cx="9" cy="8" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2"/>`,
    plug: html`<path d="m8 3 2 4m6-4-2 4M6 7h12v3a6 6 0 0 1-12 0V7Zm6 9v5"/>`,
    clock: html`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
    sliders: html`<path d="M4 7h8m4 0h4M4 17h3m4 0h9"/><circle cx="14" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>`,
    leaf: html`<path d="M20 3C10 2 3 6 4 14c1 7 12 7 14-1 1-4 0-7 2-10Z"/><path d="m4 21 11-12"/>`,
    help: html`<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .7-1.5 1-1.5 3M12 17h.01"/>`,
    reset: html`<path d="M3 11a9 9 0 1 1 2 7M3 5v6h6"/>`,
    play: html`<path d="m8 4 12 8-12 8V4Z"/>`,
    pause: html`<path d="M8 5v14M16 5v14"/>`,
    stop: html`<rect x="5" y="5" width="14" height="14" rx="2"/>`,
    plus: html`<path d="M12 5v14M5 12h14"/>`,
    minus: html`<path d="M5 12h14"/>`,
    check: html`<path d="m5 12 4 4L19 6"/>`,
    chevron: html`<path d="m9 5 7 7-7 7"/>`,
    arrow: html`<path d="M4 12h16m-6-6 6 6-6 6"/>`,
    up: html`<path d="M12 20V4m-6 6 6-6 6 6"/>`,
    down: html`<path d="M12 4v16m-6-6 6 6 6-6"/>`,
    file: html`<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6M8 13h8m-8 4h5"/>`,
    compass: html`<circle cx="12" cy="12" r="9"/><path d="m16 8-2.5 5.5L8 16l2.5-5.5L16 8Z"/>`,
    code: html`<path d="m7 7-5 5 5 5m10-10 5 5-5 5m-3-14-4 18"/>`,
    shield: html`<path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6l8-3Z"/><path d="m8 12 3 3 5-6"/>`,
    terminal: html`<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 8 4 4-4 4m7 0h5"/>`,
    browser: html`<rect x="2" y="3" width="20" height="18" rx="2"/><path d="M2 8h20M6 5.5h.01M10 5.5h.01M8 13l3 3 5-5"/>`,
    branch: html`<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m12-10c0 7-12 2-12 8"/>`,
    message: html`<path d="M21 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v9Z"/><path d="M7 8h10M7 12h7"/>`,
    cursor: html`<path d="m4 3 6 18 3-8 8-3L4 3Z"/>`,
    fit: html`<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>`,
    edit: html`<path d="m16 3 5 5L8 21H3v-5L16 3Zm-2 2 5 5"/>`,
    trash: html`<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>`,
    download: html`<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>`,
    close: html`<path d="m6 6 12 12M18 6 6 18"/>`,
    lock: html`<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>`,
    spark: html`<path d="m12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8L12 2Z"/>`,
    activity: html`<path d="M2 12h4l3-8 5 16 3-8h5"/>`,
    alert: html`<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3h.01"/>`,
    loader: html`<path d="M12 3a9 9 0 1 1-9 9"/>`,
  };
  const icon = (name, className = "") => html`<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.file}</svg>`;
  const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const selected = (actual, expected) => actual === expected ? " selected" : "";
  const providerName = provider => provider === "codex" ? "Codex" : "Claude Code";
  const authName = auth => t(auth === "api" ? "API key" : "Subscription");
  const agentStyle = agent => `--agent-color:${roles[agent.role].color};--agent-bg:${roles[agent.role].background}`;
  const agentIcon = (agent, large = false, mood = "") => html`<span class="agent-icon${large ? " large" : ""}${mood ? ` is-${mood}` : ""}" data-role="${agent.role}" style="${agentStyle(agent)}"><span class="agent-eyes"><i></i><i></i></span>${icon(roles[agent.role].icon, "agent-badge")}</span>`;
  const brandMark = html`<svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="12.5" cy="13.5" r="8.5" fill="#dccfff" stroke="#2b2238" stroke-width="1.6"/><circle cx="23.5" cy="13.5" r="8.5" fill="#c4efd9" stroke="#2b2238" stroke-width="1.6"/><circle cx="18" cy="23" r="9" fill="#ffd0e1" stroke="#2b2238" stroke-width="1.6"/><ellipse cx="15.2" cy="22.5" rx="1.3" ry="1.8" fill="#2b2238"/><ellipse cx="20.8" cy="22.5" rx="1.3" ry="1.8" fill="#2b2238"/></svg>`;
  const tints = ["lavender", "sky", "mint", "butter", "rose", "peach"];
  const tintOf = text => tints[[...String(text)].reduce((sum, character) => sum + character.charCodeAt(0), 0) % tints.length];
  const briefIdeas = [
    "Add a newsletter signup with duplicate-safe validation",
    "Write QA cases for the password reset flow",
    "Review the checkout form for accessibility gaps",
  ];
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const button = (action, label, iconName, className = "", data = "", disabled = false) => html`<button type="button" class="btn ${className}" data-action="${action}" ${data}${disabled ? " disabled" : ""}>${iconName ? icon(iconName) : ""}${t(label)}</button>`;
  const statusNames = { needs_reconciliation: "Check recovery", cancelling: "Cancelling", running: "Running", paused: "Paused", waiting_approval: "Needs approval", waiting_review: "Needs review", succeeded: "Completed", failed: "Blocked", cancelled: "Cancelled", queued: "Queued" };
  const statusBadge = status => html`<span class="badge ${["paused", "waiting_approval", "waiting_review"].includes(status) ? "amber" : status === "failed" ? "red" : status === "cancelled" ? "gray" : ""}">${status === "running" ? icon("loader", "spinning") : ""}${t(statusNames[status] || "Ready")}</span>`;
  const roleOutputs = { planner: "Plan + QA sheet", coder: "Code changes", reviewer: "Review findings", backend: "API test results", frontend: "Browser QA", documenter: "Final handoff" };

  function persist() {
    queueSettings(state);
  }

  function onRunChange(run) {
    const viewed = currentRun(), previous = viewed?.status;
    const all = new Map([state.run, ...state.history, run].filter(Boolean).map(item => [item.id, item]));
    state.run = engine.run;
    all.delete(state.run?.id);
    state.history = [...all.values()].sort((a, b) => b.createdAt?.localeCompare(a.createdAt || "") || 0);
    if (ui.view === "run" && !ui.starting && !ui.historyId && viewed && viewed.id !== state.run?.id) ui.historyId = viewed.id;
    if (currentRun()?.id === run.id) {
      if (ui.followRun) ui.step = run.review ? run.steps.findIndex(step => step.id === run.review.stepId) : Math.min(run.index, run.steps.length - 1);
      if (!run.review && previous === "waiting_review" && run.status === "running" && ui.sessionTab === "review") ui.sessionTab = "conversation";
      if (run.review && run.review.id !== ui.reviewId) {
        ui.reviewId = run.review.id; ui.reviewDraft = ""; ui.sessionTab = "review";
        ui.step = run.steps.findIndex(step => step.id === run.review.stepId);
      }
      if (run.status === "succeeded" && previous && previous !== "succeeded") celebrate();
    }
    if (["home", "runs"].includes(ui.view) || (ui.view === "run" && currentRun()?.id === run.id)) render(true);
    else {
      for (const element of document.querySelectorAll("[data-active-count]")) element.textContent = t`${engine.activeRuns.size} active / limit ${state.maxConcurrentRuns}`;
      refreshProjectNavigation();
    }
  }

  function stamp(text) {
    if (reducedMotion.matches) return;
    const element = document.createElement("div");
    element.className = "stamp";
    element.setAttribute("aria-hidden", "true");
    element.textContent = t(text);
    document.body.append(element);
    setTimeout(() => element.remove(), 1400);
  }

  function celebrate() {
    if (reducedMotion.matches) return;
    const colors = ["--lavender-2", "--sky-2", "--mint-2", "--butter-2", "--rose-2", "--peach-2"];
    const burst = document.createElement("div");
    burst.className = "confetti";
    burst.setAttribute("aria-hidden", "true");
    burst.innerHTML = Array.from({ length: 36 }, (_, index) => {
      const angle = Math.random() * Math.PI * 2, distance = 160 + Math.random() * 260;
      return html`<i style="--x:${Math.round(Math.cos(angle) * distance)}px;--y:${Math.round(Math.sin(angle) * distance + 120)}px;--r:${Math.round(Math.random() * 720 - 360)}deg;--c:var(${colors[index % colors.length]});--d:${(Math.random() * .15).toFixed(2)}s"></i>`;
    }).join("");
    document.body.append(burst);
    setTimeout(() => burst.remove(), 1900);
  }

  let engine = new StudioEngine(onRunChange, state.run, state.activeRuns);
  state.run = engine.run;
  for (const run of engine.activeRuns.values()) if (run.id !== state.run?.id) {
    state.history = [run, ...state.history.filter(item => item.id !== run.id)];
  }
  persist();

  function toast(message) {
    clearTimeout(toastTimer);
    const element = document.getElementById("toast");
    element.textContent = t(message);
    element.classList.add("show");
    toastTimer = setTimeout(() => element.classList.remove("show"), 4200);
  }

  function currentRun() {
    return ui.historyId ? state.history.find(run => run.id === ui.historyId) : state.run;
  }

  function currentFlow() {
    return state.flows.find(flow => flow.id === state.activeFlowId);
  }

  function navItem(view, name, iconName, count = null) {
    name = t(name);
    const active = ui.view === view || (view === "runs" && ui.view === "run");
    return html`<button type="button" class="nav-item ${active ? "active" : ""}" data-action="navigate" data-view="${view}" aria-label="${name}" title="${name}" ${active ? 'aria-current="page"' : ""}>${icon(iconName)}<span class="nav-item-label">${name}</span>${count !== null ? html`<span class="nav-count">${count}</span>` : ""}</button>`;
  }

  function projectNavigation() {
    const selectedRun = ui.view === "run" ? currentRun() : null;
    return state.projects.map(project => {
      const runs = [...engine.activeRuns.values()].filter(run => run.project.id === project.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const expanded = ui.expandedProjects.has(project.id), listId = `project-tasks-${encodeURIComponent(project.id)}`;
      const current = selectedRun?.project.id === project.id || (ui.view === "home" && project.id === state.activeProjectId);
      return html`<div class="project-branch" data-project-id="${escape(project.id)}"><button type="button" class="nav-item project-item ${current ? "project-current" : ""}" data-action="toggle-project" data-id="${escape(project.id)}" aria-label="Active tasks in ${escape(project.name)} (${runs.length})" title="${escape(project.path)}" aria-expanded="${expanded}" aria-controls="${listId}">${icon("folder")}<span class="nav-item-label">${escape(project.name)}</span><span class="nav-count">${runs.length}</span><span class="project-chevron">${icon("chevron")}</span></button><div id="${listId}" class="project-task-list" ${expanded ? "" : "hidden"}>
        ${runs.map(run => html`<button type="button" class="project-task ${selectedRun?.id === run.id ? "active" : ""}" data-action="open-run" data-id="${escape(run.id)}" aria-label="Open task: ${escape(run.brief)}" title="${escape(run.brief)} - ${t(statusNames[run.status])}" ${selectedRun?.id === run.id ? 'aria-current="page"' : ""}>${icon("message")}<span class="project-task-copy"><span class="project-task-title">${escape(run.brief)}</span>${statusBadge(run.status)}</span></button>`).join("") || html`<p class="project-tasks-empty">No active tasks</p>`}
        <button type="button" class="project-new-task" data-action="select-project" data-id="${escape(project.id)}" aria-label="New task in ${escape(project.name)}" title="New task in ${escape(project.name)}">${icon("plus")}<span>New task</span></button></div></div>`;
    }).join("") || html`<button class="nav-item" data-action="new-project" aria-label="Add project" title="Add project">${icon("folder")}<span class="nav-item-label">Add project</span></button>`;
  }

  function refreshProjectNavigation() {
    const tree = app.querySelector(".project-tree");
    if (!tree) return;
    const focused = tree.contains(document.activeElement) ? document.activeElement : null;
    const projectId = focused?.closest(".project-branch")?.dataset.projectId;
    const nav = tree.closest(".nav"), scrollTop = nav.scrollTop;
    tree.innerHTML = projectNavigation();
    if (focused) {
      const controls = [...tree.querySelectorAll("button")];
      const next = controls.find(button => button.dataset.action === focused.dataset.action && button.dataset.id === focused.dataset.id)
        || controls.find(button => button.dataset.action === "toggle-project" && button.dataset.id === projectId);
      next?.focus({ preventScroll: true });
    }
    nav.scrollTop = scrollTop;
  }

  function sidebar() {
    const collapsed = Boolean(state.navigationCollapsed);
    return html`<div class="mobile-menu-bar"><span class="mobile-brand">${brandMark}Agent Studio</span><button class="nav-control" data-action="open-navigation" aria-label="Open navigation" aria-controls="studio-navigation" aria-expanded="${ui.navigationOpen}">${icon("menu")}</button></div><button class="navigation-backdrop" data-action="close-navigation" aria-label="Close navigation overlay" tabindex="-1" ${ui.navigationOpen ? "" : "hidden"}></button>
      <aside id="studio-navigation" class="sidebar" aria-label="Workspace navigation"><div class="sidebar-header"><div class="brand"><span class="brand-mark">${brandMark}</span><span class="brand-name">Agent <em>Studio</em></span></div><button class="nav-control nav-collapse" data-action="toggle-sidebar" aria-label="${collapsed ? t("Expand sidebar") : t("Collapse sidebar")}" title="${collapsed ? t("Expand sidebar") : t("Collapse sidebar")}">${icon("sidebar")}</button><button class="nav-control mobile-nav-close" data-action="close-navigation" aria-label="Close navigation">${icon("close")}</button></div>
      <div class="workspace-label"><span class="workspace-dot"></span>Personal workspace<span class="workspace-tag">LOCAL</span></div>
      <nav class="nav" aria-label="Main navigation">
        ${navItem("home", "New task", "plus")}
        <div class="nav-group" role="group" aria-label="Work"><div class="nav-label">Work</div>${navItem("runs", "Tasks", "clock", state.history.length + (state.run ? 1 : 0))}${state.importedSessions.length ? navItem("imported", "Imported sessions", "message", state.importedSessions.length) : ""}</div>
        <div class="nav-group project-nav" role="group" aria-label="Projects"><div class="project-nav-heading"><span class="nav-label">Projects</span><div class="project-nav-actions"><button class="nav-control" data-action="import-local" aria-label="Import local projects" title="Import local projects">${icon("download")}</button><button class="nav-control" data-action="new-project" aria-label="Create project" title="Create project">${icon("plus")}</button></div></div><div class="project-tree">${projectNavigation()}</div></div>
        <div class="nav-group" role="group" aria-label="Build"><div class="nav-label">Build</div>${navItem("team", "Flows", "flow")}${navItem("agents", "Agent library", "agents")}${navItem("skills", "Skill library", "grid")}</div>
        <div class="nav-group" role="group" aria-label="Settings"><div class="nav-label">Settings</div>${navItem("connections", "Connections", "plug")}${navItem("defaults", "Defaults", "sliders")}</div>
      </nav><div class="sidebar-bottom"><div class="sidebar-actions"><button class="nav-utility" data-action="help" aria-label="How Agent Studio works" title="Quick guide">${icon("help")}<span>Quick guide</span></button><button class="nav-control" data-action="navigation-actions" aria-label="Workspace actions" title="Workspace actions" aria-expanded="${ui.navigationActions}" aria-controls="navigation-actions">${icon("more")}</button><div id="navigation-actions" class="navigation-actions" ${ui.navigationActions ? "" : "hidden"}><span class="nav-label">Workspace controls</span><button class="nav-reset" data-action="reset" aria-label="Reset workspace">${icon("reset")}<span>Reset workspace<small>Clear presets and run history</small></span></button></div></div>
      <div class="sidebar-status" title="${catalog.mode === "local" ? t("Local skills connected") : t("Local workspace")}"><span class="dot"></span><span>${catalog.mode === "local" ? t("Local skills connected") : t("Local workspace")}</span><span class="sidebar-version">v0.1</span></div></div></aside>`;
  }

  function heading(title, subtitle, actions, eyebrow = "") {
    subtitle = t(subtitle); eyebrow = t(eyebrow);
    return html`<div class="page-heading"><div>${eyebrow ? html`<div class="eyebrow">${eyebrow}</div>` : ""}<h1>${title}</h1>${subtitle ? html`<p class="subtitle">${subtitle}</p>` : ""}</div><div class="actions">${actions}</div></div>`;
  }

  function syncNavigation() {
    const open = mobileNavigation.matches && ui.navigationOpen;
    const sidebar = app.querySelector(".sidebar");
    sidebar.inert = mobileNavigation.matches && !open;
    app.querySelector(".main").inert = open;
    app.querySelector(".mobile-menu-bar").inert = open;
    document.body.classList.toggle("navigation-locked", open);
    if (open) { sidebar.setAttribute("role", "dialog"); sidebar.setAttribute("aria-modal", "true"); }
    else { sidebar.removeAttribute("role"); sidebar.removeAttribute("aria-modal"); }
  }

  function closeNavigation() {
    ui.navigationOpen = false; ui.navigationActions = false;
    render(true);
    app.querySelector('[data-action="open-navigation"]')?.focus();
  }

  function closeNavigationActions() {
    ui.navigationActions = false;
    const popup = document.getElementById("navigation-actions");
    if (popup) popup.hidden = true;
    app.querySelector('[data-action="navigation-actions"]')?.setAttribute("aria-expanded", "false");
  }

  function render(live = false) {
    closeSelects(app);
    const retainedTerminal = ui.view === "run" && ui.sessionTab === "terminal" ? retainTerminal() : null;
    const focused = document.activeElement;
    const focusAttributes = focused && app.contains(focused) ? ["id", "data-action", "data-view", "data-id", "data-tab", "data-index", "aria-label"].filter(name => focused.hasAttribute(name)).map(name => [name, focused.getAttribute(name)]) : [];
    const preserved = live ? [document.getElementById("task-brief"), document.getElementById("flow-rule-form")] : [];
    const scrollPositions = live ? [...document.querySelectorAll(".session-content, .evidence-body, .run-steps, .canvas-viewport, .sidebar, .nav")].map(element => [element.className, element.scrollTop, element.scrollLeft]) : [];
    const viewNames = { home: "New task", team: "Flows", run: "Task details", agents: "Agent library", skills: "Skill library", connections: "AI connections", runs: "Tasks", imported: "Imported sessions", defaults: "Workspace defaults" };
    const entering = renderedView !== ui.view;
    app.innerHTML = html`<div class="shell ${state.navigationCollapsed ? "sidebar-collapsed" : ""} ${ui.navigationOpen ? "navigation-open" : ""}">${sidebar()}<div class="main" tabindex="-1"><header class="topbar"><div class="crumbs">Workspace ${icon("chevron")}<strong>${t(viewNames[ui.view])}</strong></div><span class="prototype-pill">${icon("terminal")}Local workspace<span class="topbar-avatar">J</span></span></header><main id="main-content" class="page page-${ui.view}${entering ? " page-enter" : ""}">${ui.view === "home" ? homeView() : ui.view === "team" ? teamView() : ui.view === "run" ? runView() : ui.view === "agents" ? agentsView() : ui.view === "skills" ? skillsView() : ui.view === "connections" ? connectionsView() : ui.view === "runs" ? runsView() : ui.view === "imported" ? importedSessionsView() : defaultsView()}</main></div></div>`;
    const terminalElement = document.getElementById("studio-terminal");
    if (terminalElement && retainedTerminal?.dataset.session === terminalElement.dataset.session) terminalElement.replaceWith(retainedTerminal);
    if (terminalElement) mountTerminal(currentRun().id, document.getElementById("studio-terminal")); else closeTerminalView();
    syncNavigation();
    for (const panel of preserved) {
      if (!panel) continue;
      const next = app.querySelector(`#${panel.id}`);
      if (next && next.dataset.id === panel.dataset.id) next.replaceWith(panel);
    }
    enhanceSelects(app);
    for (const [className, scrollTop, scrollLeft] of scrollPositions) {
      const element = document.getElementsByClassName(className)[0];
      if (element) { element.scrollTop = scrollTop; element.scrollLeft = scrollLeft; }
    }
    const conversation = live && ui.followRun ? document.querySelector(".session-content") : null;
    if (conversation?.querySelector(".fresh")) conversation.scrollTop = conversation.scrollHeight;
    if (live && focusAttributes.length) {
      const replacement = focused.isConnected ? focused : [...app.querySelectorAll("button, input, textarea, select")].find(element => focusAttributes.every(([name, value]) => element.getAttribute(name) === value));
      replacement?.focus({ preventScroll: true });
    }
    if (renderedView !== ui.view) { window.scrollTo(0, 0); renderedView = ui.view; }
    resizeObserver?.disconnect();
    const viewport = document.querySelector(".canvas-viewport");
    if (viewport) {
      resizeObserver = new ResizeObserver(() => sizeCanvas());
      resizeObserver.observe(viewport);
      sizeCanvas();
    }
  }

  function homeView() {
    const project = activeProject();
    const execution = project?.execution;
    const recent = [state.run, ...state.history].filter(run => run && (run.project?.id || null) === (project?.id || null)).slice(0, 3);
    const crew = currentFlow().workflow.map(id => state.agents.find(agent => agent.id === id));
    const today = new Date().toLocaleDateString(locale(), { weekday: "long", month: "long", day: "numeric" });
    const crewStack = crew.length ? html`<span class="crew-stack">${crew.slice(0, 5).map(agent => agentIcon(agent)).join("")}${crew.length > 5 ? html`<span class="crew-more">+${crew.length - 5}</span>` : ""}</span>` : "";
    const lineup = html`<aside class="lineup" aria-label="Relay order"><div class="lineup-head"><span class="eyebrow">Relay order</span>${button("navigate", "Edit", "edit", "text small", attrs`data-view="team" aria-label="Edit flow"`)}</div>${crew.length ? html`<ol>${crew.map((agent, index) => html`<li style="${agentStyle(agent)}">${agentIcon(agent)}<span><strong>${escape(agent.name)}</strong><small>${t(roleOutputs[agent.role])}</small></span><span class="lineup-num">${String(index + 1).padStart(2, "0")}</span></li>`).join("")}</ol>` : html`<p class="lineup-empty">No agents in this flow yet.</p>`}<p class="lineup-note">${icon("leaf")}Each step opens a fresh session and passes a short handoff.</p></aside>`;
    return html`<div class="task-start"><header class="hello"><span class="eyebrow">${today}</span><h1>${t`What should your ${html`<em>team</em>`} take on today?`}</h1></header><div class="home-grid"><div class="home-main"><section class="task-composer" aria-label="Start a task"><div class="composer-context"><div class="composer-location">${button("project-picker", html`<span>${escape(project?.name || t("Select project"))}</span>`, "folder", "composer-project", attrs`aria-label="Select project" title="${escape(project?.path || t("Select a local project"))}"`)}<span class="computer-label">${icon("computer")}This computer</span></div>${button("project-settings", execution?.mode === "worktree" ? "New worktree" : "Local", execution?.mode === "worktree" ? "branch" : "sliders", "execution-button", attrs`aria-label="Local environment settings"`, !project)}</div><label class="sr-only" for="task-brief">Task brief</label><textarea id="task-brief" maxlength="2000" rows="4" placeholder="Describe the task...">${escape(state.brief)}</textarea><div class="composer-footer"><button type="button" class="crew-picker" data-action="flow-picker" aria-label="Select flow">${crewStack}<span><small>Flow</small><strong>${escape(currentFlow().name)}</strong></span>${icon("chevron")}</button>${button("run", ui.starting ? "Preparing..." : engine.atCapacity(state.maxConcurrentRuns) ? "View active tasks" : "Run task", "arrow", "primary start-task", "", ui.starting)}</div></section><p class="concurrency-note"><span data-active-count>${engine.activeRuns.size} active / limit ${state.maxConcurrentRuns}</span> ${button("navigate", "Concurrency settings", "sliders", "text small", 'data-view="defaults"')}</p><div class="brief-ideas" role="group" aria-label="Example tasks"><span>Try</span>${briefIdeas.map((idea, index) => html`<button type="button" class="idea-chip" data-action="use-idea" data-index="${index}">${icon("spark")}${escape(t(idea))}</button>`).join("")}</div>${recent.length ? html`<section class="recent-work"><div class="section-title"><h2>Recent tasks</h2>${button("navigate", "All tasks", "arrow", "text", 'data-view="runs"')}</div>${recent.map(run => html`<button class="recent-task" data-action="open-run" data-id="${escape(run.id)}">${icon("clock")}<span><strong>${escape(run.brief)}</strong></span>${statusBadge(run.status)}${icon("chevron")}</button>`).join("")}</section>` : ""}</div>${lineup}</div></div>`;
  }

  function teamView() {
    return heading(escape(currentFlow().name), "", button("flow-picker", "Manage flows", "flow") + button("export", "Export", "download") + button("navigate", "Use this flow", "arrow", "primary", 'data-view="home"')) + html`<div class="flow-tabs" role="group" aria-label="Saved flows">${state.flows.filter(flow => !flow.archived).map(flow => html`<button data-action="select-flow" data-id="${escape(flow.id)}" class="flow-tab ${flow.id === state.activeFlowId ? "active" : ""}" aria-pressed="${flow.id === state.activeFlowId}">${icon("flow")}<span>${escape(flow.name)}</span><span class="flow-size">${flow.workflow.length}</span></button>`).join("")}${button("new-flow", "New flow", "plus", "text")}</div>` + builderView();
  }

  function runView() {
    const run = currentRun();
    return html`<div class="run-heading">${button("navigate", "All tasks", "arrow", "text back-button", 'data-view="runs"')}<h1>${run ? escape(run.brief) : t("Task")}</h1><p class="subtitle">${icon("folder")}${escape(run?.project?.name || t("Project"))} / ${escape(run?.flow?.name || t("Feature delivery"))}${run?.project ? button("run-project", run.project.execution.mode === "worktree" ? "Worktree settings" : "Local settings", "sliders", "text small", attrs`aria-label="View task environment"`) : ""}<span class="badge gray">${run?.project?.execution.mode === "worktree" ? t("Worktree execution") : t("Local execution")}</span></p></div>${sessionView(run)}`;
  }

  function builderView() {
    const agent = state.agents.find(item => item.id === ui.selected);
    return html`<div class="builder-grid ${agent ? "with-inspector" : ""}"><section class="panel canvas-panel"><div class="panel-heading"><div class="flow-meta"><h2>${currentFlow().workflow.length} agents</h2><span class="divider"></span><span class="meta">Reviews and bounded loops</span></div>${button("flow-recommended", "Suggested rules", "spark", "small") + button("library", "Add agent", "plus", "small")}</div><div class="canvas-viewport" aria-label="Agent workflow canvas"><div class="canvas-wrap"><div class="canvas-stage">${canvas()}</div></div></div><div class="canvas-footer"><span class="canvas-tip">${icon("cursor")}${ui.linkFrom ? t("Choose a later input to preview the new order. Esc cancels.") : t("Select a step to set reviews, revisions, and execution order.")}</span><div class="zoom-controls">${button("zoom-out", "", "minus", "text icon-only", attrs`aria-label="Zoom out"`)}<span class="zoom-value">Fit</span>${button("zoom-in", "", "plus", "text icon-only", attrs`aria-label="Zoom in"`)}${button("fit", "", "fit", "text icon-only", attrs`aria-label="Fit workflow"`)}</div></div></section>
      ${agent ? html`<aside class="panel inspector" style="${agentStyle(agent)}" aria-label="Flow step settings"><div class="inspector-header">${agentIcon(agent)}<div><h2>${escape(agent.name)}</h2><p>Step settings</p></div>${button("close-inspector", "", "close", "text icon-only", attrs`aria-label="Close step settings"`)}</div>${stepSettings(agent)}</aside>` : ""}</div><div class="team-footer"><span>${icon("check")}<span id="save-status" role="status">${escape(t(saveStatus()))}</span></span></div>`;
  }

  function position(index) {
    const row = Math.floor(index / 3);
    const column = row % 2 === 0 ? index % 3 : 2 - index % 3;
    return { x: 43 + column * 261, y: 65 + row * 230, row, forward: row % 2 === 0 };
  }

  function canvas() {
    const height = Math.ceil(Math.max(currentFlow().workflow.length, 1) / 3) * 230 + 20;
    let lines = "";
    let nodes = "";
    currentFlow().workflow.forEach((id, index) => {
      const agent = state.agents.find(item => item.id === id);
      const pos = position(index);
      const inputSide = index % 3 === 0 && index > 0 ? "top" : pos.forward ? "left" : "right";
      const outputSide = index % 3 === 2 ? "bottom" : pos.forward ? "right" : "left";
      if (index < currentFlow().workflow.length - 1) {
        const next = position(index + 1);
        const path = pos.row === next.row ? `M ${pos.forward ? pos.x + 208 : pos.x} ${pos.y + 67} H ${pos.forward ? next.x : next.x + 208}` : `M ${pos.x + 104} ${pos.y + 135} V ${next.y}`;
        lines += html`<path class="flow-line" d="${path}" marker-end="url(#arrowhead)"/>`;
      }
      const rule = currentFlow().rules?.find(item => item.after === id);
      nodes += html`<div class="node ${ui.selected === id ? "selected" : ""}" style="${agentStyle(agent)};left:${pos.x}px;top:${pos.y}px"><button class="node-body" data-action="select-agent" data-id="${escape(id)}" aria-label="Step settings for ${escape(agent.name)}" aria-pressed="${ui.selected === id}"><span class="node-top">${agentIcon(agent)}<span class="node-name">${escape(agent.name)}</span></span><span class="node-output">${t(roleOutputs[agent.role])}</span><span class="node-bottom"><span class="node-status">${providerName(agent.provider)}</span><span class="node-number">${String(index + 1).padStart(2, "0")}</span></span></button><button class="port ${inputSide}" data-action="connect-to" data-id="${escape(id)}" aria-label="Connect to ${escape(agent.name)}" ></button><button class="port ${outputSide} ${ui.linkFrom === id ? "linking" : ""}" data-action="connect-from" data-id="${escape(id)}" aria-label="Connect from ${escape(agent.name)}" ></button></div>`;
      nodes += html`<button class="flow-rule-chip ${rule?.review && rule.review !== "auto" ? "has-review" : ""}" style="left:${pos.x}px;top:${pos.y + 148}px" data-action="select-agent" data-id="${escape(id)}" aria-label="Configure transition after ${escape(agent.name)}">${icon(rule?.review && rule.review !== "auto" ? "agents" : "arrow")}${rule?.review === "always" ? (rule.lockOutputs ? t("Review + lock") : t("Human review")) : rule?.review === "on_issue" ? t("Review on issues") : t("Automatic")}</button>`;
      if (rule?.loop) nodes += html`<button class="flow-loop-chip" style="left:${pos.x}px;top:${pos.y + 182}px" data-action="select-agent" data-id="${escape(id)}">${icon("reset")}Back to ${escape(state.agents.find(a => a.id === rule.loop.target)?.name)} / max ${rule.loop.maxCycles}</button>`;
    });
    return html`<svg class="connections-svg" viewBox="0 0 820 ${height}" style="height:${height}px" aria-hidden="true"><defs><marker id="arrowhead" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0 0L5 2.5L0 5" fill="none" stroke="#2b2238" stroke-width="1"/></marker></defs>${lines}</svg><div class="flow-caption" style="top:27px">${icon("message")} YOUR BRIEF</div>${nodes}${!currentFlow().workflow.length ? html`<div style="padding:100px 70px"><h2>No agents yet</h2><p style="margin-top:15px">Add an agent to create the first step.</p></div>` : ""}`;
  }

  function sizeCanvas() {
    const viewport = document.querySelector(".canvas-viewport");
    if (!viewport) return;
    const height = Math.ceil(Math.max(currentFlow().workflow.length, 1) / 3) * 230 + 20;
    const fit = Math.max(.95, Math.min((viewport.clientWidth - 12) / 820, (viewport.clientHeight - 10) / height, 1.12));
    const scale = ui.zoom ?? fit;
    const stage = viewport.querySelector(".canvas-stage");
    stage.style.transform = `scale(${scale})`;
    stage.style.height = `${height}px`;
    const wrap = viewport.querySelector(".canvas-wrap");
    wrap.style.width = `${820 * scale}px`;
    wrap.style.height = `${height * scale}px`;
    wrap.style.minHeight = "0";
    document.querySelector(".zoom-value").textContent = `${Math.round(scale * 100)}%`;
  }

  function stepSettings(agent) {
    const index = currentFlow().workflow.indexOf(agent.id);
    return html`<div class="step-settings">${flowRuleForm(agent)}<div class="step-order"><span class="field-label">Step order</span><strong>${index + 1} of ${currentFlow().workflow.length}</strong></div><div class="step-controls">${button("move-up", "Earlier", "up", "small", attrs`aria-label="Move step earlier"`, index === 0)}${button("move-down", "Later", "down", "small", attrs`aria-label="Move step later"`, index === currentFlow().workflow.length - 1)}</div><dl class="definition-list"><dt>Connection</dt><dd>${providerName(agent.provider)} / ${authName(agent.auth)}</dd><dt>Model</dt><dd>${escape(agent.model)}</dd><dt>Permissions</dt><dd>${t(permissionLevels[agent.permissionLevel || "ask"].label)}</dd>${agent.provider === "codex" ? html`<dt>Fast mode</dt><dd>${t({ default: "Follow Codex", on: "On", off: "Off" }[agent.codexFastMode || "default"])}</dd>` : ""}<dt>Skills</dt><dd>${agent.skillBindings.length} attached</dd></dl><p class="meta">Edit this agent's instructions, model, skills, and tools in the Agent library.</p>${button("edit-agent", "Edit in Agent library", "edit", "full", `data-id="${escape(agent.id)}"`)}<div class="step-remove">${button("remove-step", "Remove from flow", "trash", "text small")}<p class="meta">The agent stays in your library.</p></div></div>`;
  }

  function flowRuleForm(agent) {
    const flow = currentFlow(), rule = flow.rules?.find(item => item.after === agent.id) || { review: "auto" };
    const index = flow.workflow.indexOf(agent.id);
    const choices = flow.workflow.slice(0, index + 1).map(id => state.agents.find(a => a.id === id));
    const options = (items, value) => items.map(item => html`<option value="${escape(item.id)}"${selected(value, item.id)}>${escape(item.name)}</option>`).join("");
    return html`<form id="flow-rule-form" class="flow-rule-form" data-form="flow-rule" data-id="${escape(agent.id)}"><h3>After this step</h3><p class="meta">Rules belong to this flow. Active tasks keep their saved version.</p>
      <div class="field"><label for="flow-review">Human checkpoint</label><select id="flow-review" name="review">${[["auto", "Continue automatically"], ["always", "Review before continuing"], ["on_issue", "Review if issues remain"]].map(([value, label]) => html`<option value="${value}"${selected(rule.review, value)}>${t(label)}</option>`).join("")}</select></div>
      <label class="flow-lock"><input type="checkbox" name="lockOutputs" ${rule.lockOutputs ? "checked" : ""} ${rule.review !== "always" ? "disabled" : ""}>Lock reviewed outputs</label>
      <div class="field"><label for="flow-return">Human revision returns to</label><select id="flow-return" name="returnTo"><option value="">Loop start or this step</option>${options(choices, rule.returnTo)}</select></div>
      <h3>Automatic revisions</h3><div class="field"><label for="flow-loop">If the result needs changes</label><select id="flow-loop" name="loopTarget"><option value="">Ask for human review</option>${options(choices.slice(0, -1), rule.loop?.target)}</select></div>
      <div class="field"><label for="flow-cycles">Maximum automatic revisions</label><input id="flow-cycles" type="number" name="maxCycles" min="1" max="10" value="${rule.loop?.maxCycles || 3}" required ${rule.loop ? "" : "disabled"}></div>
      <div class="field"><label for="flow-limit">When the limit is reached</label><select id="flow-limit" name="onLimit" ${rule.loop ? "" : "disabled"}><option value="review"${selected(rule.loop?.onLimit, "review")}>Ask for human review</option><option value="stop"${selected(rule.loop?.onLimit, "stop")}>Stop the task</option></select></div>
      <p class="meta">Pass continues forward. Revisions run before the checkpoint. Scope changes always need review. Execution errors stop the task.</p><p class="form-error" role="alert" hidden></p><button type="submit" class="btn primary full">Save flow rules</button></form>`;
  }

  async function saveFlowRule(form) {
    const values = new FormData(form), flow = currentFlow();
    const rule = { after: form.dataset.id, review: values.get("review"), lockOutputs: values.has("lockOutputs"), ...(values.get("returnTo") ? { returnTo: values.get("returnTo") } : {}), ...(values.get("loopTarget") ? { loop: { target: values.get("loopTarget"), maxCycles: Number(values.get("maxCycles")), onLimit: values.get("onLimit") } } : {}) };
    const result = flowSchema.safeParse({ ...flow, rules: [...(flow.rules || []).filter(item => item.after !== rule.after), rule] });
    if (!result.success) { const error = form.querySelector(".form-error"); error.textContent = t(result.error.issues[0].message); error.hidden = false; return; }
    flow.rules = result.data.rules; persist(); await flush(); render(); toast("Flow rules saved for new tasks.");
  }

  function changeFlowOrder(workflow, rules = currentFlow().rules || []) {
    const result = flowSchema.safeParse({ ...currentFlow(), workflow, rules });
    if (!result.success) { toast(t`${result.error.issues[0].message} Update the affected rules first.`); return false; }
    currentFlow().workflow = workflow; currentFlow().rules = rules; return true;
  }

  function editAgent(id, form = null) {
    const agent = state.agents.find(item => item.id === id);
    if (!agent) return;
    ui.editingAgentId = id;
    ui.selected = null;
    if (ui.view !== "agents") { ui.view = "agents"; render(); }
    const flowCount = state.flows.filter(flow => flow.workflow.includes(id)).length;
    showModal(escape(agent.name), html`<p class="agent-reuse-note">${flowCount ? t`Used in ${flowCount} ${t(flowCount === 1 ? "flow" : "flows")}. Changes apply everywhere this agent is used.` : t("Configure this agent, then add it to a flow.")} Active tasks keep their current settings.</p>${form ? html`<div id="agent-editor-fields"></div>` : agentForm(agent)}`, button("close-modal", "Cancel", "") + html`<button type="submit" form="agent-preset-form" class="btn primary">Save agent</button>`, true, "Agent library / Edit agent");
    modal.classList.add("agent-editor");
    if (!form) updatePermissionFields(modal.querySelector("#agent-preset-form"));
    if (form) {
      modal.querySelector("#agent-editor-fields").replaceWith(form);
      form.querySelector('[data-action="choose-skills"]').focus();
    } else modal.querySelector("#agent-name").focus();
    updateFastModeFields(modal.querySelector("#agent-preset-form"));
  }

  const permissionLevels = {
    ask: { label: "Ask for approval", description: "Uses the workspace file-write approval setting. Each shell command and external HTTP target asks for approval." },
    "read-only": { label: "Read only", description: "Read project files and previous outputs. File writes, shell, HTTP, and browser actions are disabled." },
    project: { label: "Project automation", description: "Selected tools can edit project files and run sandboxed commands with network access without prompts. External HTTP tool targets still ask for approval." },
    bypass: { label: "Bypass permissions", description: "Skip approval prompts. Enabled tools can access files and network outside the project. Shell commands run without a sandbox using your OS account." },
  };
  function updatePermissionFields(form) {
    const level = form.elements.permissionLevel.value;
    form.querySelector("#permission-description").textContent = t(permissionLevels[level].description);
    for (const input of form.querySelectorAll('[name="tools"]')) input.disabled = level === "read-only" && input.value !== "read";
  }
  function updateFastModeFields(form) {
    const [provider, auth] = form.elements.connection.value.split("|");
    const field = form.querySelector(".agent-fast-field"), select = form.elements.codexFastMode;
    field.hidden = provider !== "codex"; select.disabled = field.hidden;
    const connection = state.connections.find(item => item.id === `${provider}-${auth}`);
    const model = connection?.modelDetails?.find(item => item.value === form.elements.model.value);
    const unsupported = provider === "codex" && model?.supportsFastMode === false;
    select.querySelector('[value="on"]').disabled = unsupported && select.value !== "on";
    select.setCustomValidity(unsupported && select.value === "on" ? t("This model does not support Fast mode. Select Off or Default.") : "");
    form.querySelector("#fast-description").textContent = unsupported ? t("This model does not report Fast mode support. Select Off or Default.") : select.value === "off" ? t("Use standard speed, even if your local Codex default is Fast.") : select.value === "default" ? t("Follow the local Codex settings for this project.") : t`${t(auth === "subscription" ? "Uses more of your subscription limit." : "Uses higher API pricing.")} Availability is checked when the task starts.`;
    enhanceSelects(form);
  }
  function agentForm(agent) {
    return html`<form id="agent-preset-form" class="agent-form" data-form="agent" data-id="${escape(agent.id)}"><div class="field agent-name-field"><label for="agent-name">Name</label><input id="agent-name" name="name" value="${escape(agent.name)}" maxlength="40" required></div>
      <div class="field prompt-field"><label for="agent-prompt">Instructions</label><textarea id="agent-prompt" name="prompt" rows="4" maxlength="2500" required>${escape(agent.prompt)}</textarea></div>
      <div class="field"><div class="agent-field-heading"><label for="agent-connection">AI connection</label></div><select id="agent-connection" name="connection">${["codex", "claude"].flatMap(provider => ["subscription", "api"].map(auth => html`<option value="${provider}|${auth}"${selected(`${agent.provider}|${agent.auth}`, `${provider}|${auth}`)}>${providerName(provider)} / ${authName(auth)}</option>`)).join("")}</select></div>
      <div class="field"><div class="agent-field-heading"><label for="agent-model">Model</label>${button("refresh-models", "Refresh models", "reset", "small")}</div><select id="agent-model" name="model">${modelOptions(agent.provider, agent.auth, agent.model)}</select><small>Models come from your connection. Aliases follow runtime updates; Default uses the runtime selection.</small></div>
      <div class="field agent-fast-field"${agent.provider === "codex" ? "" : " hidden"}><label for="agent-fast-mode">Fast mode</label><select id="agent-fast-mode" name="codexFastMode" aria-describedby="fast-description">${[["default", "Default - follow Codex"], ["on", "On - faster responses"], ["off", "Off - standard speed"]].map(([value, label]) => html`<option value="${value}"${selected(agent.codexFastMode || "default", value)}>${t(label)}</option>`).join("")}</select><small id="fast-description"></small></div>
      <div class="field"><label for="agent-permission">Permission level</label><select id="agent-permission" name="permissionLevel" aria-describedby="permission-description">${Object.entries(permissionLevels).map(([value, level]) => html`<option value="${value}"${selected(agent.permissionLevel || "ask", value)}>${t(level.label)}</option>`).join("")}</select><small id="permission-description">${t(permissionLevels[agent.permissionLevel || "ask"].description)}</small></div>
      <div class="field skill-binding-field">${bindingField(agent.skillBindings || [])}</div>
      <div class="field agent-tools-field"><span class="field-label">Allowed tools</span><div class="checks">${[["read", "Read files"], ["write", "Write files"], ["shell", "Shell"], ["browser", "Browser"]].map(([value, label]) => html`<label class="check"><input type="checkbox" name="tools" value="${value}"${agent.tools.includes(value) ? " checked" : ""}>${t(label)}</label>`).join("")}</div></div>
      <div class="context-chip">${icon("leaf")}New session per step. Only the brief, decisions, and artifact references carry forward.</div></form>`;
  }

  function agentsView() {
    return heading(html`Your <em>agents</em>`, "Give each role a purpose, a model, and a set of boundaries.", button("new-agent", "New agent", "plus", "primary"), "Reusable presets") +
      html`<div class="content-grid">${state.agents.map(agent => html`<section class="panel agent-card tilt" style="${agentStyle(agent)}"><div class="card-top">${agentIcon(agent, true)}<div><h2>${escape(agent.name)}</h2><p>${providerName(agent.provider)} / ${escape(agent.model)}</p></div></div><p>${escape(t(roles[agent.role].description))}</p><dl class="agent-card-settings"><div><dt>Permissions</dt><dd><span class="badge ${agent.permissionLevel === "bypass" ? "red" : agent.permissionLevel === "project" ? "amber" : "gray"}" title="${escape(t(permissionLevels[agent.permissionLevel || "ask"].description))}">${t(permissionLevels[agent.permissionLevel || "ask"].label)}</span></dd></div>${agent.provider === "codex" ? html`<div><dt>Fast mode</dt><dd><span class="badge ${agent.codexFastMode === "on" ? "" : "gray"}">${t({ default: "Follow Codex", on: "On", off: "Off" }[agent.codexFastMode || "default"])}</span></dd></div>` : ""}</dl><div class="skill-list">${agent.skillBindings.length ? agent.skillBindings.map(skill => html`<span class="skill-chip" aria-pressed="true">${icon("file")}${escape(skill.name)}</span>`).join("") : html`<span class="meta">No skills attached</span>`}</div><div class="card-footer">${currentFlow().workflow.includes(agent.id) ? html`<span class="badge">In workflow</span>` : button("add-existing", "Add to workflow", "plus", "small", `data-id="${escape(agent.id)}"`)}${button("edit-agent", "Edit agent", "edit", "text small", `data-id="${escape(agent.id)}"`)}</div></section>`).join("")}</div>`;
  }

  function bindingField(bindings) {
    return html`<div class="binding-heading"><span class="field-label">Attached skills <span class="count-label">${bindings.length}</span></span>${button("choose-skills", "Choose skills", "plus", "small")}</div><input type="hidden" name="skillBindings" value="${escape(JSON.stringify(bindings))}"><div class="bound-skills">${bindings.map(binding => {
      const source = catalog.skills.find(item => item.id === binding.id);
      return html`<div class="bound-skill">${icon("file")}<div><strong>${escape(binding.name)}</strong><small>${source ? (source.version === binding.version ? (source.requirements.length ? t("Review tool setup") : t("Available")) : t("Source changed - update binding")) : catalog.mode === "loading" ? t("Checking source...") : t("Source unavailable")}</small>${source && source.version !== binding.version ? button("update-skill", "Use latest version", "reset", "text small", `data-id="${escape(binding.id)}"`) : ""}</div>${button("remove-skill", "", "close", "text icon-only", attrs`data-id="${escape(binding.id)}" aria-label="Remove ${escape(binding.name)} skill"`)}</div>`;
    }).join("") || html`<div class="binding-empty">Add instructions from your skill library.</div>`}</div><small>Saved with this preset. Each run keeps its own version.</small>`;
  }

  function filteredSkills(query) {
    const term = query.trim().toLowerCase();
    return catalog.skills.filter(skill => [skill.name, skill.description, ...skill.sources].join(" ").toLowerCase().includes(term));
  }

  function skillRows(query, picker = false) {
    const skills = filteredSkills(query);
    return skills.length ? skills.map(skill => {
      const bound = ui.pickerDraft?.find(item => item.id === skill.id);
      const uses = state.agents.filter(agent => agent.skillBindings.some(item => item.id === skill.id));
      return html`<article class="skill-row"><span class="skill-file-icon" data-tint="${tintOf(skill.name)}">${icon("file")}</span><div class="skill-row-copy"><div class="skill-row-title"><h3>${escape(skill.name)}</h3><span class="badge ${skill.requirements.length ? "amber" : "gray"}">${skill.requirements.length ? t("Review setup") : t("Available")}</span></div><p>${escape(skill.description)}</p><div class="skill-row-meta"><span>${escape(skill.sources.join(" / "))}</span>${uses.length ? html`<span class="skill-use">${uses.length} ${uses.length === 1 ? t("agent") : t("agents")}</span>` : ""}</div></div><div class="skill-row-actions">${button("skill-detail", "Details", "", "text small", `data-id="${skill.id}"`)}${picker ? html`<label class="skill-select"><input type="checkbox" data-skill-select="${skill.id}" aria-label="Attach ${escape(skill.name)}" ${bound ? "checked" : ""}></label>` : button("assign-skill", "Attach", "plus", "small", `data-id="${skill.id}"`)}</div></article>`;
    }).join("") : html`<div class="empty skill-empty"><h3>${catalog.mode === "loading" ? t("Reading your skill folders...") : t("No matching skills")}</h3><p>${catalog.mode === "loading" ? t("Only skill folders are scanned.") : t("Try another search or add a skill folder.")}</p></div>`;
  }

  function skillsView() {
    const local = catalog.mode === "local";
    const attached = new Set(state.agents.flatMap(agent => agent.skillBindings.map(skill => skill.id))).size;
    return heading(html`Your <em>skills</em>`, "", button("refresh-skills", "Refresh", "reset", "", "", !local) + button("skill-sources", "Manage sources", "plus", "primary", "", !local), "Skill library") +
      html`<div class="skill-overview"><div><strong>${catalog.skills.length}</strong><span>skills discovered</span></div><div><strong>${catalog.sources.length}</strong><span>skill sources</span></div><div><strong>${attached}</strong><span>skills attached</span></div><span class="catalog-mode"><span class="dot"></span>${local ? t("Reading local files") : catalog.mode === "loading" ? t("Connecting") : catalog.mode === "error" ? t("Local service unavailable") : t("Not connected")}</span></div>
      <div class="skills-layout"><section class="panel skill-catalog"><div class="skill-toolbar"><label class="search-box">${icon("search")}<input type="search" id="skill-search" placeholder="Search skills, descriptions, or sources" aria-label="Search skills" value="${escape(ui.skillQuery)}"></label><span class="meta">SKILL.md</span></div><div id="skill-rows">${skillRows(ui.skillQuery)}</div></section><aside class="skill-guide"><span class="guide-icon">${icon("flow")}</span><h2>One library.<br>Different specialists.</h2><p>Attach the same skill to multiple agents. Each agent keeps its own instructions, model, and tool permissions.</p><ol><li><span>01</span><div><strong>Discover</strong><p>Read your skill folders and local plugin packages.</p></div></li><li><span>02</span><div><strong>Attach</strong><p>Choose the skills each agent needs.</p></div></li><li><span>03</span><div><strong>Keep the version</strong><p>Inspect exactly what a run received.</p></div></li></ol><div class="guide-note">${icon("shield")}<p>Tool hints come from the instructions. They are not a runtime compatibility check. The selected agent permissions are enforced by the runner.</p></div>${!local && catalog.mode !== "loading" ? html`<div class="guide-note"><p>For local discovery, run <code>./studio start</code> and open <code>http://127.0.0.1:4183</code>.</p></div>` : ""}</aside></div>${catalog.errors.length ? html`<details class="catalog-errors"><summary>${catalog.errors.length} source ${catalog.errors.length === 1 ? t("warning") : t("warnings")}</summary>${catalog.errors.map(error => html`<p>${escape(error.name || error.source || t("Local service"))}: ${escape(t(error.message))}</p>`).join("")}</details>` : ""}`;
  }

  function skillPicker(form, query = "") {
    if (form) {
      ui.pickerTarget = form;
      ui.pickerDraft = JSON.parse(form.elements.skillBindings.value);
      ui.pickerQuery = query;
    }
    showModal(t("Choose this agent's skills"), html`<p>Select instructions to attach. Attached instructions and supporting files are frozen when a task starts.</p><label class="search-box picker-search"><input id="picker-search" type="search" aria-label="Search skills to attach" placeholder="Search your skill library" value="${escape(ui.pickerQuery)}"></label><div id="picker-rows" class="picker-rows">${skillRows(ui.pickerQuery, true)}</div>`, html`<span id="selection-count" class="meta">${ui.pickerDraft.length} selected</span>${button("close-modal", "Cancel", "")}${button("apply-skills", "Use selected skills", "check", "primary")}`, true, catalog.mode === "local" ? "Local skill library" : "Skill library");
  }

  async function skillDetail(id) {
    const pickerTarget = ui.pickerTarget;
    try {
      const skill = await catalog.detail(id);
      if (pickerTarget && (ui.pickerTarget !== pickerTarget || !modal.open)) return;
      showSkillFiles(skill.name, skill, ui.pickerDraft ? button("back-skills", "Back to selection", "arrow", "back-button") : "");
    } catch (error) { toast(error.message); }
  }

  function showSkillFiles(name, skill, footer = "") {
    showModal(escape(name), html`<div class="skill-detail-meta"><span class="badge gray">Read-only skill content</span><code>${escape(skill.version.slice(0, 12))}</code></div>${skill.path ? html`<p class="source-path">${escape(skill.path)}</p>` : ""}${skill.requirements ? html`<p class="skill-requirements"><strong>Tool hints:</strong> ${escape(skill.requirements.join(", ") || t("No known tool hints detected"))}<br><small>Review the instructions. Other tools or services may be required.</small></p>` : ""}<details class="file-manifest"><summary>${skill.files.length} included ${skill.files.length === 1 ? t("file") : t("files")}</summary>${skill.files.map(file => html`<div>${icon("file")}<code>${escape(file.path)}</code></div>`).join("")}</details><p class="meta">Text references, scripts, and assets stay with the snapshot. Environment files, binaries, and links outside the skill folder are excluded. Previewing a skill does not execute its scripts.</p><pre class="skill-source">${escape(skill.files.find(file => file.path === "SKILL.md")?.content || t("No SKILL.md in this snapshot."))}</pre>`, footer, true, "Skill instructions");
  }

  function sourcesModal() {
    ui.pickerDraft = null;
    showModal(t("Local skill sources"), html`<p>Use one folder per line. A folder can contain SKILL.md directly, or contain one folder per skill. Links to the same skill are merged.</p><p>Codex plugin caches and installed Claude Code plugins are discovered automatically. Plugin skills show their package name and version. Refresh the library after updating a plugin.</p><form data-form="skill-sources"><label class="field-label" for="skill-roots">Folder paths</label><textarea id="skill-roots" name="roots" rows="5" spellcheck="false">${escape(catalog.roots.join("\n"))}</textarea><div class="source-list">${catalog.sources.map(source => html`<div><code>${escape(source.label)}</code><span class="badge ${source.status === "available" ? "gray" : "amber"}">${source.status === "available" ? t`${source.count} found` : t("Unavailable")}</span></div>`).join("")}</div><p class="meta">Folders stay on this computer. This scans instructions and supporting text files. Attaching a skill does not enable its plugin hooks, connectors, or servers.</p><button type="submit" class="btn primary full">Scan folders</button></form>`, "", true, "Skill sources");
  }

  function modelOptions(provider, auth, current = "default") {
    const connection = state.connections.find(item => item.provider === provider && item.auth === auth);
    const available = [...new Set(["default", ...(connection?.models || models[provider])])];
    const values = [...new Set([...available, current])];
    return values.map(value => {
      const details = connection?.modelDetails?.find(model => model.value === value);
      let label = details?.displayName || value;
      if (value === "default" && details?.resolvedModel) label += ` - ${connection.modelDetails.find(model => model.value !== "default" && model.resolvedModel === details.resolvedModel)?.displayName || details.resolvedModel}`;
      if (!available.includes(value)) label += " " + t("(saved selection; refresh to check availability)");
      return html`<option value="${escape(value)}"${selected(current, value)}>${escape(t(label))}</option>`;
    }).join("");
  }

  async function checkConnection(provider, auth, apiKey) {
    const connection = await request("/api/connections/check", { provider, auth, ...(apiKey ? { apiKey } : {}) });
    const index = state.connections.findIndex(item => item.id === connection.id);
    if (index < 0) state.connections.push(connection); else state.connections[index] = connection;
    return connection;
  }

  function subscriptionView(connection) {
    if (connection.auth !== "subscription") return "";
    if (!connection.connected) return html`<p class="meta">Connect to check the signed-in account and remaining usage.</p>`;
    const account = connection.account || {}, usage = connection.usage;
    const dateLabel = value => {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toLocaleString(locale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "Not reported";
    };
    return html`<dl class="definition-list subscription-account"><dt>Account</dt><dd>${escape(account.email || t("Not reported by the runtime"))}</dd><dt>Plan</dt><dd>${escape(account.plan || t("Not reported"))}</dd>${account.organization ? html`<dt>Organization</dt><dd>${escape(account.organization)}</dd>` : ""}</dl>
      <section class="subscription-usage" aria-label="Subscription usage"><h3>Remaining usage</h3>${usage?.status === "available" ? usage.windows.map(window => {
        const remaining = Math.max(0, Math.min(100, window.remainingPercent));
        return html`<div class="quota-window"><div><span>${escape(window.label)}</span><strong>${remaining.toLocaleString(locale(), { maximumFractionDigits: 1 })}% left</strong></div><meter min="0" max="100" low="15" high="40" optimum="100" value="${remaining}" aria-label="${escape(window.label)} remaining usage"></meter><small>${window.resetsAt ? t`Resets ${escape(dateLabel(window.resetsAt))}` : t("Reset time not reported")}</small></div>`;
      }).join("") : html`<p class="meta">${escape(usage?.message || t("Refresh to check your remaining usage."))}</p>`}<p class="meta usage-checked">${usage?.checkedAt ? `Checked ${escape(dateLabel(usage.checkedAt))}. ` : ""}Account-wide limits, shared with other sessions.</p></section>`;
  }

  function connectionsView() {
    return heading(html`<em>AI</em> connection setup`, "Use an API key or your own subscription through an official local runtime.", button("connect", "Add connection", "plus", "primary"), "Bring your own account") +
      html`<div class="info-banner">${icon("shield")}<span>Subscription sign-in stays with the official CLI. API keys stay in runner memory and must be entered again after a runner restart. Billing modes never switch automatically.</span></div><div class="connection-grid">${state.connections.map(connection => html`<section class="panel connection-card"><div class="card-top"><div class="actions"><div class="provider-logo ${connection.provider}">${connection.provider === "codex" ? t("&lt;/&gt;") : "✳"}</div><div><h2>${providerName(connection.provider)}</h2><p>${providerName(connection.provider)} / ${authName(connection.auth)}</p></div></div><span class="badge ${connection.connected ? "" : "gray"}">${connection.connected ? t("Connected") : t("Disconnected")}</span></div>${subscriptionView(connection)}<dl class="definition-list"><dt>Runtime</dt><dd>${escape(connection.version || t("Not checked"))}</dd><dt>Billing mode</dt><dd>${escape(connection.billingMode)}</dd><dt>Automatic API fallback</dt><dd>Off</dd><dt>Available models</dt><dd>${connection.models?.length || 0}</dd></dl>${connection.error ? html`<p class="form-error">${escape(connection.error)}</p>` : ""}<div class="card-footer">${button("test-connection", connection.auth === "subscription" ? "Refresh account & usage" : "Check connection", "activity", "small", `data-id="${connection.id}"`)}${button("toggle-connection", connection.connected ? "Disconnect" : "Reconnect", connection.connected ? "plug" : "plus", "text small", `data-id="${connection.id}"`)}</div></section>`).join("") || html`<p class="meta">Add your first connection to run an agent.</p>`}</div>`;
  }

  function runsView() {
    const runs = [state.run, ...state.history].filter(Boolean);
    return heading(html`Your <em>tasks</em>`,"Pick up where you left off. Every conversation and output stays with the task.", button("navigate", "New task", "plus", "primary", 'data-view="home"'), "Your workspace") +
      (runs.length ? html`<section class="panel"><table class="history-table"><thead><tr><th>TASK</th><th>STATUS</th><th>OUTPUTS</th><th></th></tr></thead><tbody>${runs.map(run => html`<tr><td><strong>${escape(run.brief)}</strong><small>${escape(run.id)} / ${escape(run.flow?.name || t("Feature delivery"))}</small></td><td>${statusBadge(run.status)}</td><td>${run.artifactCount ?? run.artifacts.length} files</td><td>${button("open-run", "Open task", "arrow", "text small", `data-id="${run.id}"`)}</td></tr>`).join("")}</tbody></table></section>` : emptyState("clock", "Your first task starts here", "Describe a task and choose your team. Follow its progress, approvals, and outputs here.", button("navigate", "New task", "plus", "primary", 'data-view="home"')));
  }

  function importedSessionsView() {
    return heading(html`Imported <em>sessions</em>`, "Conversation snapshots from your local Codex and Claude Code history.", button("import-local", "Import local projects", "download", "primary")) +
      (state.importedSessions.length ? html`<section class="panel"><table class="history-table"><thead><tr><th>SESSION / PROJECT</th><th>SOURCE</th><th>MESSAGES</th><th></th></tr></thead><tbody>${state.importedSessions.map(session => html`<tr><td><strong>${escape(session.title)}</strong><small>${escape(session.project.name)} / ${escape(session.updatedAt.slice(0, 10))}</small></td><td>${providerName(session.provider)}</td><td>${session.messageCount}${session.truncated ? "+" : ""}</td><td>${button("open-imported-session", "Read session", "arrow", "text small", `data-id="${escape(session.key)}"`)}</td></tr>`).join("")}</tbody></table></section>` : emptyState("message", "No saved snapshots", "New imports add project folders to your workspace.", button("import-local", "Import local projects", "download")));
  }

  async function localImportModal() {
    const pending = Symbol(); ui.importRequest = pending;
    ui.importProjects = new Set(); ui.importCatalog = null;
    showModal(t("Import local projects"), html`<p id="local-import-loading" role="status">Finding local projects...</p>`, button("close-modal", "Cancel", ""), true, "");
    try {
      const found = await request("/api/local/scan", {});
      if (ui.importRequest !== pending || !modal.open || !document.getElementById("local-import-loading")) return;
      ui.importCatalog = found;
      showModal(t("Import local projects"), html`<p>Select folders to add to Projects. Conversation history stays in Codex or Claude Code.</p><div class="import-filters"><div class="field"><label for="local-import-query">Search projects</label><input id="local-import-query" type="search" placeholder="Project name or folder path"></div><div class="field"><label for="local-import-provider">Source</label><select id="local-import-provider"><option value="all">All sources</option><option value="codex">Codex</option><option value="claude">Claude Code</option></select></div></div>${found.warnings.map(warning => html`<p class="form-error">${escape(warning)}</p>`).join("")}<div id="local-import-list" class="import-list"></div><p id="local-import-error" class="form-error" role="alert" hidden></p>`, html`<span id="local-import-count" class="meta" role="status"></span>` + button("close-modal", "Cancel", "") + button("confirm-local-import", "Import projects", "download", "primary", "", true), true, "");
      modal.classList.add("import-dialog");
      renderLocalImportList(); document.getElementById("local-import-query").focus({ preventScroll: true });
    } catch (error) {
      const loading = document.getElementById("local-import-loading");
      if (ui.importRequest === pending && loading) { loading.textContent = t(error.message); loading.setAttribute("role", "alert"); }
    }
  }

  function renderLocalImportList() {
    const panel = document.getElementById("local-import-list");
    if (!panel || !ui.importCatalog) return;
    const focus = document.activeElement, scrollTop = panel.scrollTop, modalScrollTop = modal.scrollTop;
    const focusedProject = focus && panel.contains(focus) ? focus.dataset.importProject : null;
    const query = document.getElementById("local-import-query").value.trim().toLowerCase(), provider = document.getElementById("local-import-provider").value;
    const groups = ui.importCatalog.projects.flatMap(project => {
      if (!project.available || (provider !== "all" && !project.providers.includes(provider))) return [];
      if (!`${project.name} ${project.path}`.toLowerCase().includes(query)) return [];
      const registered = state.projects.some(item => item.path === project.path);
      return [html`<label class="import-project"><input type="checkbox" data-import-project="${escape(project.key)}" aria-label="Import project ${escape(project.name)}" ${ui.importProjects.has(project.key) ? "checked" : ""} ${registered ? "disabled" : ""}><span><strong>${escape(project.name)}</strong><small>${escape(project.path)}</small><small>${project.providers.map(providerName).join(" / ")}${registered ? t(" / Already in Studio") : ""}</small></span></label>`];
    });
    panel.innerHTML = groups.join("") || html`<p class="project-empty">No matching local projects with an available folder.</p>`;
    const count = ui.importProjects.size;
    document.getElementById("local-import-count").textContent = t`${count} ${t(count === 1 ? "project" : "projects")} selected${count > 100 ? t(" - select at most 100 projects") : ""}`;
    modal.querySelector('[data-action="confirm-local-import"]').disabled = !count || count > 100;
    if (focusedProject) [...panel.querySelectorAll("input")].find(input => input.dataset.importProject === focusedProject)?.focus({ preventScroll: true });
    panel.scrollTop = scrollTop; modal.scrollTop = modalScrollTop;
  }

  function importedSessionModal(session) {
    ui.importedSession = session;
    showModal(escape(session.title), html`<p>${providerName(session.provider)} / ${escape(session.project.name)}<br><span class="project-path">${escape(session.cwd)}</span></p><p class="meta">Snapshot imported ${escape(session.importedAt.slice(0, 10))}. The original session remains in its source app.${session.truncated ? t(" This snapshot reached the 5,000 message or 2 MB text limit and contains only the beginning of the conversation.") : ""}</p><div class="import-conversation">${session.messages.map(message => html`<article class="message ${message.type}"><div class="message-meta">${escape(t(message.type))} / ${escape(message.time ? message.time.slice(0, 16).replace("T", " ") : t("Time unavailable"))}</div><pre class="import-message">${escape(message.text)}</pre></article>`).join("")}</div><p class="meta">${session.messages.length} of ${session.total} messages</p>`, button("close-modal", "Close", "") + (session.nextOffset !== null ? button("more-imported-messages", "Load more messages", "down") : ""), true, "Imported conversation");
  }

  function emptyState(iconName, title, description, action = "") {
    title = t(title); description = t(description);
    return html`<section class="panel empty"><div class="empty-icon">${icon(iconName)}</div><h2>${title}</h2><p>${description}</p>${action}</section>`;
  }

  function sessionView(run) {
    if (!run) return emptyState("message", "Watch your team work", "Start a task. Each agent opens a fresh session, completes a step, and hands its outputs to the next agent.", button("run", "Run task", "play", "primary"));
    ui.step = Math.min(Math.max(ui.step, 0), run.steps.length - 1);
    const step = run.steps[ui.step];
    const isCurrent = engine.isActive(run) || run.id === state.run?.id;
    const controls = isCurrent ? (run.status === "running" ? button("pause", run.pauseRequested ? "Pause requested" : "Pause", "pause", "", "", run.pauseRequested) : run.status === "paused" && run.controlMode === "studio" ? button("resume", "Resume", "play", "primary") : "") + (["queued", "running", "paused", "waiting_approval", "waiting_review", "needs_reconciliation", "cancelling"].includes(run.status) ? button("cancel", "Cancel", "stop", "danger") : button("run", "Run again", "play", "primary")) : button("live-session", "Latest run", "arrow");
    const activeStep = run.steps[Math.min(run.index, run.steps.length - 1)];
    const completed = run.steps.filter(item => item.status === "succeeded").length;
    const nextAction = run.status === "waiting_review" ? (run.review.kind === "loop_limit" ? "Automatic revision limit reached" : run.review.kind === "scope_change" ? "A plan change needs your review" : "Your review is needed") : run.status === "waiting_approval" ? t`${escape(activeStep.agent.name)} is waiting for you` : run.status === "running" ? t`${escape(activeStep.agent.name)} is working` : run.status === "succeeded" ? "Your team has finished. Review the outputs." : run.status === "paused" ? "Task paused. Resume when you are ready." : run.status === "failed" ? "This task needs attention" : run.status === "needs_reconciliation" ? "Review the interrupted session" : "Task cancelled. Your outputs are still here.";
    const detail = run.status === "waiting_review" ? t("Review the outputs below. The next agent has not started.") : run.status === "waiting_approval" ? escape(run.approval?.description || t("Review the pending permission request.")) : run.status === "running" && !run.pauseRequested ? t`Step ${Math.min(run.index + 1, run.steps.length)} of ${run.steps.length} / ${t(roleOutputs[activeStep.agent.role])}` : run.status === "succeeded" ? t`${run.artifacts.length} outputs, with the conversations that produced them.` : escape(run.note);
    const approvalActions = isCurrent && run.status === "waiting_review" ? button("review-open", "Review outputs", "file", "primary") + controls : isCurrent && run.status === "needs_reconciliation" ? button("reconcile", "Check provider state", "activity", "primary") + controls : isCurrent && run.status === "waiting_approval" ? button("approve", "Approve request", "check", "primary") + button("cancel", "Reject & cancel", "close", "text") : controls;
    const followControl = isCurrent && engine.isActive(run) ? (ui.followRun ? html`<span class="badge">Following live</span>` : button("follow-run", "Follow live", "activity", "small")) : html`<span class="badge gray">Session ${ui.step + 1}</span>`;
    const mood = item => item.status === "running" ? "running" : item.status === "waiting_approval" ? "waiting" : "";
    const actionMark = ["running", "waiting_approval", "paused"].includes(run.status) ? agentIcon(activeStep.agent, true, mood(activeStep)) : icon(run.status === "succeeded" ? "check" : run.status === "failed" ? "alert" : "activity");
    return html`<section class="next-action ${["waiting_approval", "waiting_review"].includes(run.status) ? "needs-action" : run.status === "succeeded" ? "is-done" : ""}" style="${agentStyle(activeStep.agent)}" aria-label="Task status"><span class="next-action-icon">${actionMark}</span><div class="next-action-copy"><h2>${t(nextAction)}</h2><p>${detail}</p>${run.approval ? html`<pre class="approval-details">${escape(run.approval.details)}</pre>` : ""}</div><div class="actions">${approvalActions}</div></section>
      <div class="progress-label"><span>${statusBadge(run.status)} ${completed} of ${run.steps.length} steps complete</span><span>Flow v${run.flow.revision || 1}${run.lockedPlan ? t` / Approved plan v${run.lockedPlan.version}` : ""}${Object.entries(run.loopCounts || {}).map(([id, count]) => t` / ${escape(run.steps.find(s => s.agent.id === id)?.agent.name)} revisions ${count}/${run.flow.rules?.find(r => r.after === id)?.loop?.maxCycles}`).join("")}</span></div><div class="run-progress" aria-label="${completed} of ${run.steps.length} steps complete">${run.steps.map(item => html`<span class="${item.status === "succeeded" ? "done" : item.status}" style="${agentStyle(item.agent)}"></span>`).join("")}</div>
      <section class="panel run-grid"><aside class="run-steps" aria-label="Run sessions"><div class="eyebrow">Your team</div>${run.steps.map((item, index) => html`<button class="run-step ${index === ui.step ? "active" : ""}" data-action="run-step" data-index="${index}" data-status="${item.status}" style="${agentStyle(item.agent)}" aria-label="View ${escape(item.agent.name)} session" aria-pressed="${index === ui.step}">${agentIcon(item.agent, false, mood(item))}<span><strong>${escape(item.agent.name)}</strong><small>${t(statusNames[item.status])}${item.attempt > 1 ? t` / Attempt ${item.attempt}` : ""}</small></span>${item.status === "succeeded" ? icon("check", "step-check") : ""}</button>`).join("")}<div class="session-legend">${icon("leaf")}A fresh session for each step.</div></aside><div class="session" style="${agentStyle(step.agent)}"><div class="session-head"><div class="session-identity">${agentIcon(step.agent, false, mood(step))}<div><h2>${escape(step.agent.name)}</h2><p>${escape(step.actualModel || step.agent.model)} / ${authName(step.agent.auth)}</p></div></div>${followControl}</div><nav class="session-tabs" aria-label="Session content">${[...(run.review || run.reviewHistory?.length ? [["review", "Review"]] : []), ["conversation", "Conversation"], ["tools", "Tool activity"], ["handoff", "Handoff"], ["attempts", "Attempts"], ["terminal", "Terminal"]].map(([id, label]) => html`<button class="tab ${ui.sessionTab === id ? "active" : ""}" aria-pressed="${ui.sessionTab === id}" data-action="session-tab" data-tab="${id}">${t(label)}</button>`).join("")}</nav><div class="session-content">${ui.sessionTab === "review" ? reviewView(run) : ui.sessionTab === "attempts" ? attemptsView(step, run) : ui.sessionTab === "terminal" ? terminalView(step, run) : ui.sessionTab === "handoff" ? handoffView(step, run) : messagesView(step)}</div><div class="session-foot"><span class="usage-label">${escape(usageLabel(step))}</span>${icon("leaf")}This session received ${step.receivedArtifacts.length} ${step.receivedArtifacts.length === 1 ? t("artifact") : t("artifacts")}. ${button("session-tab", "View handoff", "arrow", "text small", 'data-tab="handoff"')}</div></div>${evidenceView(run)}</section>`;
  }

  function usageLabel(step) {
    const usage = step.usage?.total || step.usage;
    if (!usage) return t("Token usage not reported.");
    const input = usage.inputTokens ?? usage.input_tokens;
    const cached = usage.cachedInputTokens ?? usage.cache_read_input_tokens;
    const output = usage.outputTokens ?? usage.output_tokens;
    return [["Input", input], ["Cached", cached], ["Output", output]].filter(([, value]) => Number.isFinite(value)).map(([label, value]) => `${t(label)}: ${value.toLocaleString(locale())}`).join(" / ") || t("Token usage not reported.");
  }

  function reviewView(run) {
    const review = run.review || run.reviewHistory?.at(-1);
    if (!review) return html`<p>No human review is pending.</p>`;
    const step = [...run.steps, ...(run.stepHistory || [])].find(s => s.id === review.stepId);
    const previous = (run.stepHistory || []).filter(s => s.agent.id === step?.agent.id).at(-1);
    const pending = engine.isActive(run) && run.status === "waiting_review" && !!run.review;
    const canApprove = pending && !["scope_change", "loop_limit"].includes(review.kind);
    const outputs = review.artifactIds.map(id => run.artifacts.find(a => a.id === id)).filter(Boolean);
    const target = run.steps.find(s => s.agent.id === review.returnTo);
    const planning = step?.agent.role === "planner" && review.lockOutputs;
    return html`<div class="review-workspace"><div class="review-heading"><h3>${review.kind === "scope_change" ? t("Review the requested scope change") : review.kind === "loop_limit" ? t("Choose the next revision") : planning ? t("Review the plan together") : t("Review this handoff")}</h3><span class="badge ${pending ? "amber" : "gray"}">${pending ? t`Draft ${step?.attempt || 1}` : review.action === "approved" ? t("Approved") : t("Revision requested")}</span></div><p>${escape(review.summary)}</p>${pending && planning ? html`<p class="guide-note">Ask questions or request changes below. Planner will return a new draft. Coder stays queued until you lock the plan and continue.</p>` : ""}
      ${outputs.map(artifact => {
        const before = previous && run.artifacts.find(a => a.stepId === previous.id && a.name === artifact.name);
        return html`<article class="review-document"><h3>${icon("file")}${escape(artifact.name)}</h3><pre>${escape(artifact.content)}</pre>${before && before.id !== artifact.id ? html`<details class="review-compare"><summary>Compare with previous draft</summary><div class="review-diff"><section><h4>Previous draft</h4><pre>${escape(before.content)}</pre></section><section><h4>Current draft</h4><pre>${escape(artifact.content)}</pre></section></div></details>` : ""}</article>`;
      }).join("") || html`<p class="meta">This step returned no text artifacts. Inspect Conversation and Tool activity before deciding.</p>`}
      ${pending ? html`<form data-form="review-feedback" data-id="${review.id}" class="review-feedback"><label for="review-feedback">${planning ? t("Questions or changes for the plan") : t`What should ${escape(target?.agent.name || t("the agent"))} change?`}</label><textarea id="review-feedback" name="feedback" maxlength="8000" rows="3" placeholder="Describe the changes or the next approach to try..." required>${escape(ui.reviewDraft)}</textarea><p class="meta">A revision returns to ${escape(target?.agent.name)} and reruns later checks. Previous sessions remain in Attempts.</p><button type="submit" class="btn">${icon("reset")}Request revision</button></form><div class="review-actions">${canApprove ? button("review-lock", review.lockOutputs ? "Lock only" : "Approve only", "lock") + button("review-approve", review.lockOutputs ? "Lock and continue" : "Approve and continue", "check", "primary") : html`<p class="meta">Send a revision request to continue, or cancel this task. No further automatic retries will run without your action.</p>`}</div><p class="meta">${review.lockOutputs ? t("Approval locks these exact output versions. ") : ""}Human review does not grant tool permissions.</p>` : html`<p class="meta">${review.action === "approved" ? t`Approved ${new Date(review.resolvedAt).toLocaleString(locale())}.` : escape(review.feedback || "")}</p>`}
      ${run.reviewHistory?.length ? html`<details class="review-history"><summary>Review history (${run.reviewHistory.length})</summary>${run.reviewHistory.map(item => html`<div><strong>${item.action === "approved" ? t("Approved") : t("Revision requested")}</strong><p>${escape(item.feedback || item.summary)}</p><small>${new Date(item.resolvedAt).toLocaleString(locale())}</small></div>`).join("")}</details>` : ""}</div>`;
  }

  function attemptsView(step, run) {
    const attempts = [...(run.stepHistory || []).filter(item => item.agent.id === step.agent.id), step];
    return html`<div class="attempts-list"><p class="meta">Each revision uses a fresh session. Earlier conversations and outputs remain available.</p>${attempts.map(item => html`<details ${item.id === step.id ? "open" : ""}><summary>Attempt ${item.attempt || 1} / ${t(statusNames[item.status])}</summary>${item.feedback ? html`<p class="handoff-card">${escape(item.feedback)}</p>` : ""}${item.messages.map(message => html`<div class="message ${message.type}"><div class="message-label">${escape(t(message.type))}</div><div class="message-text">${escape(message.text)}</div></div>`).join("")}${item.finalText ? html`<details><summary>Structured result</summary><pre class="artifact-preview">${escape(item.finalText)}</pre></details>` : ""}<div class="artifact-list">${run.artifacts.filter(a => a.stepId === item.id).map(artifactRow).join("")}</div></details>`).join("")}</div>`;
  }

  function terminalView(step, run) {
    if (step.agent.provider !== "codex") return html`<div class="empty"><h2>Claude Code session</h2><p>Follow this session in Conversation and Tool activity. Shared terminal control is available for Codex sessions.</p></div>`;
    const attached = run.terminal?.connected && run.terminal.stepId === step.id;
    const ready = engine.isActive(run) && run.status === "paused" && run.controlMode === "studio" && step.providerThreadId;
    return html`<div class="terminal-panel"><p class="meta">${attached ? t("This native Codex terminal uses the same server and provider thread. Closing the view keeps the process alive.") : t("Pause the workflow at a step boundary, then open this session in the native Codex terminal.")}</p><div class="actions">${attached ? button("terminal-close", "Return control to Studio", "arrow") + button("terminal-command", "External terminal command", "terminal", "small") : button("terminal-open", "Open Codex terminal", "terminal", "primary", `data-id="${step.id}"`, !ready)}</div>${attached ? html`<div id="studio-terminal" class="terminal-screen" data-session="${run.terminal.id}" aria-label="Native Codex terminal"></div>` : ""}</div>`;
  }

  function messagesView(step) {
    const messages = step.messages.filter(message => ui.sessionTab === "conversation" ? message.type !== "tool" : message.type === "tool");
    if (!messages.length) return html`<div class="empty" style="padding:45px 15px"><h2 style="font-size:15px">${step.status === "queued" ? t("This session has not started yet") : t("Waiting for the next event")}</h2><p>${ui.sessionTab === "tools" ? t("Recorded tool calls will appear here when this step uses a tool.") : t("The agent will receive a fresh session and references to the previous outputs.")}</p></div>`;
    const seen = seenMessages.stepId === step.id ? seenMessages.count : step.messages.length;
    seenMessages = { stepId: step.id, count: step.messages.length };
    const typing = ui.sessionTab === "conversation" && step.status === "running" ? html`<div class="message typing" aria-hidden="true"><span></span><span></span><span></span></div>` : "";
    return messages.map(message => html`<div class="message ${message.type}${step.messages.indexOf(message) >= seen ? " fresh" : ""}"><div class="message-label"><span>${message.type === "assistant" ? escape(step.agent.name) : message.type === "tool" ? t("Tool call") : t("Session event")}</span><span>${new Date(message.time).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span></div><div class="message-text">${escape(message.text)}</div></div>`).join("") + typing;
  }

  function handoffView(step, run) {
    const outputs = run.artifacts.filter(artifact => artifact.stepId === step.id);
    return html`<div class="handoff-card"><h3>A small handoff, with the full evidence nearby.</h3><p><strong>Goal:</strong> ${escape(run.brief)}<br><strong>Context:</strong> a new session, not the previous conversation.<br><strong>Inputs:</strong> ${step.receivedArtifacts.length ? step.receivedArtifacts.map(item => escape(item.name)).join(", ") : t("The task brief and project rules.")}<br><strong>Code reference:</strong> ${escape(step.codeReference || t("Pending"))}<br><strong>Studio session:</strong> ${escape(step.sessionId)}<br><strong>Provider thread:</strong> ${escape(step.providerThreadId || t("Not started"))}<br><strong>Permissions:</strong> ${t(permissionLevels[step.agent.permissionLevel || "ask"].label)}<br>${step.agent.provider === "codex" ? html`<strong>Fast mode:</strong> ${t({ default: "Follow Codex", on: "On", off: "Off" }[step.agent.codexFastMode || "default"])}${step.actualServiceTier ? t` (runtime tier: ${escape(step.actualServiceTier)})` : ""}<br>` : ""}<strong>Instructions snapshot:</strong> ${escape(step.agent.prompt)}</p></div><div class="snapshot-list"><h3>Skill versions for this run</h3>${(step.agent.skillSnapshots || []).map(binding => html`<button class="snapshot-row" data-action="skill-snapshot" data-id="${escape(binding.id)}">${icon("file")}<span><strong>${escape(binding.name)}</strong><small>${escape(binding.version.slice(0, 12))} / ${binding.fileCount} ${binding.fileCount === 1 ? t("file") : t("files")}</small></span>${icon("chevron")}</button>`).join("") || html`<p class="meta">No skills attached when this run started.</p>`}</div><div style="margin-top:20px"><p class="eyebrow" style="margin-bottom:12px">Outputs from this step</p>${outputs.length ? html`<div class="artifact-list">${outputs.map(artifactRow).join("")}</div>` : html`<p class="meta">Artifacts appear after this step completes.</p>`}</div>`;
  }

  function artifactRow(artifact) {
    return html`<button class="artifact-row" data-action="artifact" data-id="${escape(artifact.id)}" data-tint="${tintOf(artifact.type)}">${icon(artifact.type === "Code diff" ? "code" : "file")}<span><strong>${escape(artifact.name)}</strong><small>${escape(artifact.agent)} / ${artifact.superseded ? t("Previous attempt") : artifact.stale ? t("Earlier code version") : currentRun()?.reviewHistory?.some(review => review.action === "approved" && review.lockOutputs && review.artifactIds.includes(artifact.id)) ? t("Locked output") : artifact.verified ? t("Recorded evidence") : t("Agent report")}</small></span><span class="badge gray">${escape(t(artifact.type))}</span>${icon("chevron")}</button>`;
  }

  function evidenceView(run) {
    const artifact = run.artifacts.find(item => item.id === ui.artifactId);
    return html`<aside class="evidence-panel" aria-label="Task outputs"><div class="panel-heading"><h2>${icon("file")}Outputs <span class="badge gray">${run.artifacts.length}</span></h2></div><div class="evidence-body">${artifact ? html`<div class="evidence-navigation">${button("all-outputs", "All outputs", "arrow", "text small back-button")}${button("download-artifact", "", "download", "text icon-only", attrs`data-id="${escape(artifact.id)}" aria-label="Download ${escape(artifact.name)}"`)}</div><h3>${escape(artifact.name)}</h3><p class="meta">${escape(artifact.agent)} / ${escape(t(artifact.type))}</p>${artifact.mime === "image/png" ? html`<img class="artifact-image" src="/api/artifacts/${run.id}/${artifact.id}" alt="${escape(artifact.name)}">` : ""}<pre class="artifact-preview">${artifact.content.split("\n").map(line => html`<span class="${line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : ""}">${escape(line)}</span>`).join("\n")}</pre>` : html`<div class="evidence-intro"><h3>See the work behind the status.</h3><p>Plans, changes, and QA evidence appear here as each agent finishes.</p></div>${run.artifacts.length ? html`<div class="artifact-list">${run.artifacts.map(artifactRow).join("")}</div>` : html`<div class="expected-output">${icon("file")}<span>Waiting for the first output<small>${escape(run.steps[0].agent.name)} will hand over ${t(roleOutputs[run.steps[0].agent.role]).toLowerCase()}.</small></span></div>`}`}</div></aside>`;
  }

  function defaultsView() {
    return heading(html`<em>Defaults</em>`, "", button("help", "About Agent Studio", "help"), "Workspace defaults") +
      html`<section class="panel settings-panel"><div class="setting-row"><div><h2>Display language</h2><p>Choose the language for menus, settings, and task controls.</p></div><div class="field language-field"><label class="sr-only" for="ui-language">Display language</label><select id="ui-language" name="language"><option value="en"${selected(state.language || "en", "en")}>English</option><option value="ko"${selected(state.language, "ko")}>한국어</option></select></div></div><div class="setting-row"><div><h2>Fresh session at each handoff</h2><p>Pass the goal, decisions, and artifact references. Keep the original conversation available for inspection.</p></div><span class="badge">Always on</span></div><div class="setting-row"><div><h2>Approval before file changes</h2><p>Ask before the first write-enabled agent using Ask for approval. Project automation agents use their own permission level. Applies to the next run.</p></div><button class="toggle" role="switch" aria-label="Approval before file changes" aria-checked="${state.approvalRequired}" data-action="toggle-approval"></button></div><div class="setting-row"><div><h2>No automatic paid fallback</h2><p>A subscription limit should pause the task. Switching to API billing is a separate, explicit choice.</p></div><span class="badge">Always on</span></div><div class="setting-row"><div><h2>Keep the evidence</h2><p>Plans, QA cases, diffs, and test results stay attached to the run and its code reference.</p></div><span class="badge">Always on</span></div><div class="setting-row"><div><h2>Concurrent tasks</h2><p>Run tasks in separate projects or worktrees. Paused tasks and tasks waiting for approval or review also count toward this limit. Lowering it does not stop existing tasks.</p><p class="meta"><span data-active-count>${engine.activeRuns.size} active / limit ${state.maxConcurrentRuns}</span></p></div><div class="field language-field"><label class="sr-only" for="max-concurrent-runs">Maximum concurrent tasks</label><select id="max-concurrent-runs" name="maxConcurrentRuns">${Array.from({ length: 8 }, (_, index) => index + 1).map(count => html`<option value="${count}"${selected(state.maxConcurrentRuns, count)}>${count} tasks</option>`).join("")}</select></div></div><div class="setting-row"><div><h2>Local storage</h2><p>Presets and runs are saved in local SQLite. API keys stay in runner memory. Reset preserves your projects, skill sources, and project files.</p></div>${button("reset", "Reset workspace", "reset", "small")}</div></section>`;
  }

  function showModal(title, body, footer = "", wide = false, eyebrow = "Agent Studio") {
    eyebrow = t(eyebrow);
    const focusedId = modal.open && modal.contains(document.activeElement) ? document.activeElement.id : null;
    closeSelects();
    clearTimeout(connectionTimer);
    if (!modal.open) lastFocused = document.activeElement;
    modal.className = wide ? "wide" : "";
    modal.innerHTML = html`<div class="modal-head"><div>${eyebrow ? html`<div class="eyebrow">${eyebrow}</div>` : ""}<h2 id="modal-title">${title}</h2></div>${button("close-modal", "", "close", "text icon-only", attrs`aria-label="Close dialog"`)}</div><div class="modal-body">${body}</div>${footer ? html`<div class="modal-footer">${footer}</div>` : ""}`;
    enhanceSelects(modal);
    if (!modal.open) modal.showModal();
    if (focusedId) modal.querySelector(`#${CSS.escape(focusedId)}`)?.focus({ preventScroll: true });
    if (!modal.contains(document.activeElement)) modal.querySelector("button, input, select, textarea")?.focus();
  }

  function closeModal() {
    closeSelects(modal);
    clearTimeout(connectionTimer);
    if (ui.editingAgentId && ui.pickerTarget) {
      const form = ui.pickerTarget;
      ui.pickerDraft = null; ui.pickerTarget = null;
      editAgent(ui.editingAgentId, form);
      return;
    }
    ui.editingAgentId = null;
    ui.folderRequest = null;
    modal.close();
    ui.importRequest = null;
    ui.pickerDraft = null; ui.pickerTarget = null;
    if (lastFocused?.isConnected) lastFocused.focus();
  }

  function activeProject() {
    return state.projects.find(project => project.id === state.activeProjectId);
  }

  function selectFlow(id, view = "team") {
    if (!state.flows.some(flow => flow.id === id && !flow.archived)) return;
    state.activeFlowId = id; ui.view = view; ui.selected = null; ui.linkFrom = null; ui.pendingOrder = null; ui.zoom = null;
    persist(); if (modal.open) closeModal(); render(); app.querySelector(".main").focus({ preventScroll: true });
  }

  function flowPicker() {
    const flows = state.flows.filter(flow => !flow.archived);
    const archived = state.flows.filter(flow => flow.archived);
    showModal(t("Flows"), html`<div class="flow-list">${flows.map(flow => html`<article class="flow-list-item"><button class="flow-choice" data-action="select-flow" data-id="${escape(flow.id)}" data-view="${ui.view === "home" ? "home" : "team"}">${icon("flow")}<span><strong>${escape(flow.name)}</strong><span>${flow.workflow.length} agents</span></span>${flow.id === state.activeFlowId ? icon("check") : ""}</button><div class="flow-item-actions">${button("rename-flow", "", "edit", "text icon-only", attrs`data-id="${escape(flow.id)}" aria-label="Rename ${escape(flow.name)}" title="Rename flow"`)}${button("duplicate-flow", "", "copy", "text icon-only", attrs`data-id="${escape(flow.id)}" aria-label="Duplicate ${escape(flow.name)}" title="Duplicate flow"`)}${button("archive-flow", "", "archive", "text icon-only", attrs`data-id="${escape(flow.id)}" aria-label="Archive ${escape(flow.name)}" title="Archive flow"`, flows.length === 1)}</div></article>`).join("")}</div>${archived.length ? html`<details class="archived-flows"><summary>Archived (${archived.length})</summary>${archived.map(flow => html`<div><span>${escape(flow.name)}</span>${button("restore-flow", "Restore", "reset", "text", `data-id="${escape(flow.id)}"`)}</div>`).join("")}</details>` : ""}<p class="flow-sharing-note">Flows save their own order. Agent presets are shared.</p>`, button("navigate", "Edit selected flow", "edit", "", 'data-view="team"') + button("new-flow", "New flow", "plus", "primary"), false, "");
  }

  function flowForm(mode = "create", id = "") {
    const source = state.flows.find(flow => flow.id === id);
    const name = mode === "duplicate" ? t`${source.name} copy` : source?.name || "";
    const title = mode === "rename" ? "Rename flow" : mode === "duplicate" ? "Duplicate flow" : "New flow";
    showModal(t(title), html`<form id="flow-form" data-form="flow" data-mode="${mode}" data-id="${escape(id)}"><div class="field"><label for="flow-name">Flow name</label><input id="flow-name" name="name" value="${escape(name)}" placeholder="e.g. Backend delivery" maxlength="60" required></div><p class="form-error" role="alert" hidden></p></form>`, button("flow-picker", "Back", "") + html`<button type="submit" form="flow-form" class="btn primary">${mode === "rename" ? t("Save name") : t("Create flow")}</button>`, false, "");
    document.getElementById("flow-name").focus();
  }

  function saveFlow(form) {
    const name = new FormData(form).get("name").trim();
    const { mode, id } = form.dataset;
    const source = state.flows.find(flow => flow.id === id);
    const errorBox = form.querySelector(".form-error");
    if (!name || state.flows.some(flow => flow.name.toLowerCase() === name.toLowerCase() && (mode !== "rename" || flow.id !== id))) {
      errorBox.textContent = name ? t("A flow with this name already exists.") : t("Enter a flow name."); errorBox.hidden = false; return;
    }
    let flow;
    if (mode === "rename") { source.name = name; flow = source; }
    else { flow = { id: crypto.randomUUID(), name, workflow: mode === "duplicate" ? [...source.workflow] : [], rules: mode === "duplicate" ? structuredClone(source.rules || []) : [], revision: 1, archived: false }; state.flows.push(flow); }
    selectFlow(flow.id);
  }

  function projectPicker() {
    showModal(t("Projects"), html`<div class="project-list">${state.projects.map(project => html`<div class="project-row"><button class="project-choice" data-action="select-project" data-id="${escape(project.id)}">${icon("folder")}<span><strong>${escape(project.name)}</strong><span>${escape(project.path)}</span></span>${project.id === state.activeProjectId ? icon("check") : ""}</button>${button("remove-project", "", "trash", "small icon-only danger", attrs`data-id="${escape(project.id)}" aria-label="Remove ${escape(project.name)}" title="${engine.usesProject(project.id) ? t("Finish or cancel the active task first") : t("Remove project from Studio")}"`, engine.usesProject(project.id))}</div>`).join("") || html`<p class="project-empty">No projects yet.</p>`}</div><p class="meta">Removing a project preserves its files, worktrees and task history.</p>`, button("import-local", "Import local projects", "download") + button("new-project", "Create project", "plus", "primary"), false, "");
  }

  function projectModal() {
    ui.folderRequest = null;
    if (catalog.mode !== "local") {
      showModal(t("Local service required"), html`<p>Run the local server to select folders and read Git branches.</p><pre class="project-command">./studio start</pre>`, button("close-modal", "Close", ""), false, "");
      return;
    }
    const draft = ui.projectDraft;
    showModal(t("Create project"), html`<form id="project-form" data-form="project"><div class="field"><label for="project-name">Project name</label><input id="project-name" name="name" value="${escape(draft.name)}" maxlength="60" placeholder="Project name" required></div><div class="field"><label for="project-path">Source folder</label><div class="source-folder"><div class="folder-input-row">${icon("folder")}<input id="project-path" name="path" value="${escape(draft.path)}" placeholder="/path/to/project" required></div>${button("browse-folders", draft.path ? "Change folder" : "Choose folder", "plus", "")}</div></div><p id="project-error" class="form-error" role="alert" hidden></p></form>`, button("import-local", "Import local projects", "download") + button("close-modal", "Cancel", "") + html`<button type="submit" form="project-form" class="btn primary">Create project</button>`, false, "");
    document.getElementById("project-name").focus();
  }

  async function browseFolders(path) {
    const request = Symbol();
    ui.folderRequest = request; ui.folderListing = null;
    showModal(t("Choose source folder"), html`<div class="folder-browser"><form class="folder-path-form" data-form="folder-path"><label class="sr-only" for="folder-path">Folder path</label><input id="folder-path" name="path" value="${escape(path || "~")}" required><button class="btn" type="submit">Open</button></form><div id="folder-list" class="folder-list" aria-live="polite"><p>Loading folders...</p></div></div>`, button("back-project", "Back", "") + button("choose-folder", "Use this folder", "check", "primary", "", true), false, "");
    try {
      const listing = await catalog.request("/api/folders", { path: path || "~" });
      if (ui.folderRequest !== request || !modal.open) return;
      ui.folderListing = listing;
      document.getElementById("folder-path").value = listing.path;
      document.getElementById("folder-list").innerHTML = `${listing.parent ? html`<button class="folder-row parent-folder" data-action="open-folder" data-path="${escape(listing.parent)}">${icon("up")}<span>Parent folder</span></button>` : ""}${listing.folders.map(folder => html`<button class="folder-row" data-action="open-folder" data-path="${escape(folder.path)}">${icon("folder")}<span>${escape(folder.name)}</span>${icon("chevron")}</button>`).join("") || html`<p>No subfolders.</p>`}`;
      modal.querySelector('[data-action="choose-folder"]').disabled = false;
    } catch (error) {
      if (ui.folderRequest === request && modal.open) document.getElementById("folder-list").innerHTML = html`<p class="form-error" role="alert">${escape(t(error.message))}</p>`;
    }
  }

  async function saveProject(form) {
    const values = new FormData(form);
    const name = values.get("name").trim(), path = values.get("path").trim();
    const errorBox = form.querySelector(".form-error");
    const submit = modal.querySelector('[type="submit"][form="project-form"]');
    if (!name) { errorBox.textContent = t("Enter a project name."); errorBox.hidden = false; return; }
    submit.disabled = true; errorBox.hidden = true;
    try {
      const details = await catalog.request("/api/project", { path });
      if (!form.isConnected || !modal.open) return;
      if (state.projects.some(project => project.path === details.path)) throw new Error("This folder is already registered. Select it from Projects.");
      const project = { ...details, id: crypto.randomUUID(), name, execution: { mode: "local", baseRef: details.defaultRef, branchName: "" } };
      state.projects.push(project); state.activeProjectId = project.id;
      ui.view = "home"; persist(); closeModal(); render();
      document.getElementById("task-brief").focus();
    } catch (error) {
      if (form.isConnected) { errorBox.textContent = t(error.message); errorBox.hidden = false; submit.disabled = false; }
    }
  }

  async function projectSettings() {
    const project = activeProject();
    if (!project) return projectPicker();
    if (catalog.mode !== "local") return toast("Open the local Agent Studio server to inspect this project.");
    showModal(t("Local environment"), html`<div id="project-settings-loading" class="project-empty">Reading project...</div>`, "", false, "");
    const loading = document.getElementById("project-settings-loading");
    try {
      const details = await catalog.request("/api/project", { path: project.path });
      if (!loading.isConnected || !modal.open) return;
      Object.assign(project, details); persist();
      const execution = project.execution;
      const worktree = execution.mode === "worktree" && !!details.head;
      const ref = execution.baseRef || details.defaultRef;
      const stale = worktree && !details.branches.some(branch => branch.ref === ref);
      showModal(t("Local environment"), html`<form id="project-settings-form" data-form="project-settings" data-id="${escape(project.id)}"><div class="environment-project">${icon("folder")}<strong>${escape(project.name)}</strong><span>${escape(project.path)}</span></div><label class="worktree-option" for="new-worktree"><span>${icon("branch")}New worktree</span><input type="checkbox" id="new-worktree" name="worktree" ${worktree ? "checked" : ""} ${details.head ? "" : "disabled"}></label>${!details.head ? html`<p class="environment-note">Worktrees require a Git repository with at least one commit.</p>` : ""}<div id="worktree-fields" ${worktree ? "" : "hidden"}><div class="field"><label for="base-branch">Base branch</label><select id="base-branch" name="baseRef">${stale ? html`<option value="">Choose a branch</option>` : ""}${details.branches.map(branch => html`<option value="${escape(branch.ref)}"${selected(ref, branch.ref)}>${escape(branch.name)}</option>`).join("")}</select></div><div class="field"><label for="worktree-branch">New branch name</label><input id="worktree-branch" name="branchName" maxlength="200" value="${escape(execution.branchName || "")}" placeholder="Automatic"></div></div><div id="local-branch" class="environment-current" ${worktree ? "hidden" : ""}>${icon("branch")}<span>${escape(details.currentBranch || (details.head ? t("Detached HEAD") : t("No Git branch")))}</span></div><p class="environment-note">A worktree is created when the task starts. Local mode uses this folder.</p><p class="form-error" role="alert" hidden></p></form>`, button("close-modal", "Cancel", "") + html`<button type="submit" form="project-settings-form" class="btn primary">Save settings</button>`, false, "");
    } catch (error) {
      if (loading.isConnected && modal.open) { loading.className = "form-error"; loading.setAttribute("role", "alert"); loading.textContent = t(error.message); }
    }
  }

  async function saveProjectSettings(form) {
    const project = state.projects.find(item => item.id === form.dataset.id);
    const values = new FormData(form);
    const execution = { mode: values.has("worktree") ? "worktree" : "local", baseRef: values.get("baseRef"), branchName: values.get("branchName").trim() };
    const errorBox = form.querySelector(".form-error");
    const submit = modal.querySelector('[type="submit"][form="project-settings-form"]');
    submit.disabled = true; errorBox.hidden = true;
    try {
      const details = await catalog.request("/api/project", { path: project.path, execution });
      if (!form.isConnected || !modal.open) return;
      Object.assign(project, details, { execution }); persist(); closeModal(); render(true);
    } catch (error) {
      if (form.isConnected) { errorBox.textContent = t(error.message); errorBox.hidden = false; submit.disabled = false; }
    }
  }

  function runProjectDetails() {
    const project = currentRun()?.project;
    if (!project) return;
    const execution = project.execution;
    showModal(t("Task environment"), html`<dl class="environment-summary"><dt>Project</dt><dd>${escape(project.name)}</dd><dt>Source folder</dt><dd>${escape(project.path)}</dd><dt>Mode</dt><dd>${execution.mode === "worktree" ? t("New worktree") : t("Local")}</dd><dt>${execution.mode === "worktree" ? t("Base branch") : t("Branch")}</dt><dd>${escape(execution.mode === "worktree" ? project.branches.find(branch => branch.ref === execution.baseRef)?.name || execution.baseRef : project.currentBranch || t("None"))}</dd>${execution.mode === "worktree" ? html`<dt>New branch</dt><dd>${escape(execution.branchName || t("Automatic"))}</dd>` : ""}</dl><p class="environment-note">Settings captured at task start. Working folder: ${escape(currentRun().cwd || project.path)}</p>`, button("close-modal", "Close", ""), false, "");
  }

  function connectionModal() {
    showModal(t("Add an AI connection"), html`<p>Choose the provider and billing mode for this connection.</p><div class="field"><label for="connection-provider">Provider</label><select id="connection-provider"><option value="codex"${selected(ui.connectProvider, "codex")}>Codex / OpenAI</option><option value="claude"${selected(ui.connectProvider, "claude")}>Claude Code / Anthropic</option></select></div><div class="field"><span class="field-label">Authentication</span><div class="segment">${[["subscription", "My subscription"], ["api", "API key"]].map(([auth, name]) => html`<button data-action="auth-mode" data-auth="${auth}" class="${ui.connectAuth === auth ? "active" : ""}" aria-pressed="${ui.connectAuth === auth}">${name}</button>`).join("")}</div></div>${ui.connectAuth === "api" ? html`<div class="field"><label for="api-key">API key</label><input id="api-key" type="password" autocomplete="off" spellcheck="false" placeholder="Enter your provider API key"><small>Sent only to your local runner and the selected provider. Kept in runner memory, outside browser storage.</small></div>` : ""}<div class="connect-preview"><h3>${ui.connectAuth === "subscription" ? t("Use your existing subscription") : t("Pay through your API account")}</h3><p>${ui.connectAuth === "subscription" ? t("Check the existing CLI login or open the official sign-in flow. Agent Studio does not collect subscription tokens.") : t("The connection check lists available models without generating a paid response. Running an agent uses API billing.")}</p><div id="connection-result" role="status"></div></div>`, button("close-modal", "Cancel", "") + (ui.connectAuth === "subscription" ? button("official-login", "Sign in", "plug") : "") + button("connect-account", "Check and connect", "check", "primary"), false, "Official local runtime");
  }

  function libraryModal() {
    const available = state.agents.filter(agent => !currentFlow().workflow.includes(agent.id));
    showModal(t("Add a step"), html`<p>Choose a preset. New steps are added to the end of your sequential workflow.</p><div class="library-list">${available.map(agent => html`<button class="library-item" data-action="add-existing" data-id="${escape(agent.id)}">${agentIcon(agent)}<span><strong>${escape(agent.name)}</strong><small>${providerName(agent.provider)} / ${escape(agent.model)}</small></span>${icon("plus")}</button>`).join("")}${!available.length ? html`<p class="meta" style="padding:15px 0">All your current presets are already in this workflow.</p>` : ""}</div>`, button("new-agent", "Create a new agent", "plus", "primary"));
  }

  function newAgentModal() {
    showModal(t("Create agent"), html`<p>Create an agent, then edit its instructions, model, skills, and permissions in the Agent library.</p><form id="new-agent-form" data-form="new-agent"><div class="field"><label for="new-agent-name">Agent name</label><input id="new-agent-name" name="name" maxlength="40" placeholder="e.g. Data architect" required></div><div class="field"><label for="new-agent-role">Start from a role</label><select id="new-agent-role" name="role">${Object.entries(roles).map(([key, role]) => html`<option value="${key}">${role.label}</option>`).join("")}</select></div></form>`, button("close-modal", "Cancel", "") + html`<button type="submit" form="new-agent-form" class="btn primary">Create agent</button>`);
  }

  function helpModal() {
    const steps = [
      ["Start with the outcome", "Select your project and flow, then describe the task in New task."],
      ["Make the team yours", "Open Flows to add agents and edit their prompts, models, skills, and tools. Connect ports to preview a new step order."],
      ["Follow the work", "Start the task. The next action stays at the top, conversations in the middle, and outputs on the right."],
      ["Review before continuing", "Open the plan and QA sheet, approve the requested operations, then inspect the diff and test reports alongside each session."],
    ];
    showModal(t("How it works"), html`<p>A local workspace for your agents. The independent runner manages real CLI sessions, tool permissions, and durable evidence.</p><div class="tour-list">${steps.map(([title, description], index) => html`<div class="tour-step"><span>0${index + 1}</span><div><strong>${title}</strong><p>${description}</p></div></div>`).join("")}</div>`, button("close-modal", "Explore the studio", "arrow", "primary"));
  }

  async function startRun() {
    if (ui.starting) return;
    if (engine.atCapacity(state.maxConcurrentRuns)) { ui.view = "runs"; render(); return; }
    if (!currentFlow().workflow.length) return toast("Add at least one agent to the workflow first.");
    if (!state.brief.trim()) return toast("Enter a task first.");
    const brief = state.brief;
    const flow = { id: currentFlow().id, name: currentFlow().name, workflow: [...currentFlow().workflow] };
    const project = activeProject() ? structuredClone(activeProject()) : null;
    if (!project && catalog.mode === "local") { projectPicker(); return; }
    if (project && catalog.mode !== "local") return toast("Open the local Agent Studio server to use this project.");
    const agents = structuredClone(currentFlow().workflow.map(id => state.agents.find(agent => agent.id === id)));
    const missing = agents.find(agent => !state.connections.some(connection => connection.provider === agent.provider && connection.auth === agent.auth && connection.connected));
    if (missing) {
      ui.view = "connections"; render();
      toast(t`${missing.name} needs a ${providerName(missing.provider)} / ${authName(missing.auth)} connection.`);
      return;
    }
    ui.starting = true;
    const startingState = state;
    render(true);
    try {
      if (project) Object.assign(project, await catalog.request("/api/project", { path: project.path, execution: project.execution }));
      const snapshots = await catalog.snapshot(agents.flatMap(agent => agent.skillBindings));
      for (const agent of agents) agent.skillSnapshots = agent.skillBindings.map(binding => snapshots.find(item => item.id === binding.id));
    } catch (error) {
      toast(error.message); ui.starting = false; render(true); return;
    }
    ui.starting = false;
    if (startingState !== state) return;
    if (state.run) state.history = [structuredClone(state.run), ...state.history.filter(item => item.id !== state.run.id)];
    ui.view = "run"; ui.historyId = null; ui.step = 0; ui.followRun = true; ui.sessionTab = "conversation"; ui.artifactId = null;
    ui.starting = true;
    try { await engine.start({ brief, agents, project, flow, approvalRequired: state.approvalRequired }); }
    catch (error) { toast(error.message); ui.view = "home"; }
    finally { ui.starting = false; render(true); }
  }

  function download(name, content, type = "text/plain;charset=utf-8") {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a");
    link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function findArtifact(id) {
    return [state.run, ...state.history].filter(Boolean).flatMap(run => run.artifacts).find(artifact => artifact.id === id);
  }

  document.addEventListener("click", async event => {
    if (ui.navigationActions && !event.target.closest(".sidebar-actions")) closeNavigationActions();
    const target = event.target.closest("[data-action]");
    if (!target || target.disabled) return;
    const action = target.dataset.action;
    const id = target.dataset.id;
    if (action === "navigate") {
      const fromDrawer = mobileNavigation.matches && ui.navigationOpen;
      if (modal.open) closeModal();
      ui.view = target.dataset.view; ui.historyId = null; ui.linkFrom = null; ui.navigationOpen = false; ui.navigationActions = false;
      render(); if (fromDrawer) app.querySelector(".main").focus({ preventScroll: true });
    }
    else if (action === "toggle-sidebar") { state.navigationCollapsed = !state.navigationCollapsed; persist(); render(true); app.querySelector('[data-action="toggle-sidebar"]').focus({ preventScroll: true }); }
    else if (action === "open-navigation") { ui.navigationOpen = true; render(true); app.querySelector(".mobile-nav-close").focus(); }
    else if (action === "close-navigation") closeNavigation();
    else if (action === "navigation-actions") { ui.navigationActions = !ui.navigationActions; render(true); }
    else if (action === "toggle-project") {
      if (ui.expandedProjects.has(id)) ui.expandedProjects.delete(id); else ui.expandedProjects.add(id);
      refreshProjectNavigation();
    }
    else if (action === "project-picker") projectPicker();
    else if (action === "import-local") await localImportModal();
    else if (action === "confirm-local-import") {
      target.disabled = true;
      const errorBox = document.getElementById("local-import-error"); errorBox.hidden = true;
      try {
        const result = await importLocal({ projects: [...ui.importProjects], sessions: [] });
        state.projects = result.projects; state.activeProjectId = result.activeProjectId; state.importedSessions = result.importedSessions;
        if (errorBox.isConnected) closeModal(); ui.view = "home"; ui.historyId = null; render();
        toast(`Imported ${result.addedProjects} ${result.addedProjects === 1 ? "project" : "projects"}.`);
      } catch (error) { if (errorBox.isConnected) { errorBox.textContent = t(error.message); errorBox.hidden = false; target.disabled = false; } else toast(error.message); }
    }
    else if (action === "open-imported-session" || action === "more-imported-messages") {
      target.disabled = true;
      try {
        const previous = action === "more-imported-messages" ? ui.importedSession : null;
        const session = await request("/api/local/read", { key: previous?.key || id, offset: previous?.nextOffset || 0 });
        if (previous) session.messages = [...previous.messages, ...session.messages];
        importedSessionModal(session);
      } catch (error) { toast(error.message); target.disabled = false; }
    }
    else if (action === "remove-project") {
      const project = state.projects.find(item => item.id === id);
      if (!project) return;
      showModal(t("Remove project?"), html`<p>Remove <strong>${escape(project.name)}</strong> from this workspace?</p><p class="project-path">${escape(project.path)}</p><p>Your folder, worktrees and past tasks will remain. You can add this folder again later.</p><p class="form-error" id="project-remove-error" role="alert" hidden></p>`, button("project-picker", "Keep project", "") + button("confirm-remove-project", "Remove project", "trash", "danger", `data-id="${escape(id)}"`), false, "");
    }
    else if (action === "confirm-remove-project") {
      target.disabled = true;
      try {
        const result = await removeProject(id);
        state.projects = result.projects; state.activeProjectId = result.activeProjectId;
        closeModal(); render(); toast("Project removed from Studio. Files and task history are preserved.");
      } catch (error) {
        const box = document.getElementById("project-remove-error");
        if (box) { box.textContent = t(error.message); box.hidden = false; } else toast(error.message);
        target.disabled = false;
      }
    }
    else if (action === "flow-picker") flowPicker();
    else if (action === "new-flow") flowForm();
    else if (action === "rename-flow") flowForm("rename", id);
    else if (action === "duplicate-flow") flowForm("duplicate", id);
    else if (action === "select-flow") selectFlow(id, target.dataset.view || "team");
    else if (action === "archive-flow") {
      if (state.flows.filter(flow => !flow.archived).length === 1) return;
      state.flows.find(flow => flow.id === id).archived = true;
      if (state.activeFlowId === id) { state.activeFlowId = state.flows.find(flow => !flow.archived).id; ui.selected = null; ui.linkFrom = null; ui.pendingOrder = null; ui.zoom = null; }
      persist(); render(true); flowPicker();
    }
    else if (action === "restore-flow") { state.flows.find(flow => flow.id === id).archived = false; persist(); render(true); flowPicker(); }
    else if (action === "new-project") { if (ui.navigationOpen) closeNavigation(); ui.projectDraft = { name: "", path: "" }; projectModal(); }
    else if (action === "back-project") projectModal();
    else if (action === "browse-folders") await browseFolders(ui.projectDraft.path);
    else if (action === "open-folder") await browseFolders(target.dataset.path);
    else if (action === "choose-folder") {
      if (!ui.folderListing) return;
      ui.projectDraft.path = ui.folderListing.path;
      ui.projectDraft.name ||= ui.folderListing.name;
      projectModal();
    }
    else if (action === "select-project") {
      state.activeProjectId = id; ui.view = "home"; ui.navigationOpen = false; ui.navigationActions = false;
      persist(); if (modal.open) closeModal(); render(); document.getElementById("task-brief").focus();
    }
    else if (action === "project-settings") await projectSettings();
    else if (action === "run-project") runProjectDetails();
    else if (action === "configure-agent") editAgent(id);
    else if (action === "select-agent") { ui.selected = id; render(); if (matchMedia("(max-width: 880px)").matches) document.querySelector(".inspector")?.scrollIntoView({ block: "nearest" }); }
    else if (action === "close-inspector") { ui.selected = null; render(); }
    else if (action === "all-outputs") { ui.artifactId = null; render(); }
    else if (action === "follow-run") { ui.followRun = true; ui.step = Math.min(currentRun().index, currentRun().steps.length - 1); render(); }
    else if (action === "help") { if (ui.navigationOpen) closeNavigation(); helpModal(); }
    else if (action === "close-modal") closeModal();
    else if (action === "run") startRun();
    else if (action === "pause") engine.pause(currentRun());
    else if (action === "resume") engine.resume(currentRun());
    else if (action === "approve") { await engine.approve(currentRun()); if (currentRun()?.status !== "waiting_approval") stamp("Approved"); }
    else if (action === "use-idea") {
      const brief = document.getElementById("task-brief");
      state.brief = t(briefIdeas[Number(target.dataset.index)]); persist();
      brief.value = state.brief; brief.focus();
      const composer = brief.closest(".task-composer");
      composer.classList.remove("idea-flash"); void composer.offsetWidth; composer.classList.add("idea-flash");
    }
    else if (action === "cancel") engine.cancel(currentRun());
    else if (action === "live-session") { ui.view = "run"; ui.historyId = null; ui.artifactId = null; ui.followRun = true; ui.step = Math.min(state.run?.index || 0, (state.run?.steps.length || 1) - 1); render(); }
    else if (action === "review-approve" || action === "review-lock") await engine.review(action === "review-lock" ? "approve-review-only" : "approve-review", "", currentRun());
    else if (action === "review-open") { ui.sessionTab = "review"; ui.step = currentRun().steps.findIndex(s => s.id === currentRun().review.stepId); render(); }
    else if (action === "flow-recommended") {
      const flow = currentFlow(), crew = flow.workflow.map(id => state.agents.find(a => a.id === id));
      const planner = crew.find(a => a.role === "planner"), coder = crew.find(a => a.role === "coder"), reviewer = crew.find(a => a.role === "reviewer"), final = crew.at(-1);
      const rules = [];
      if (planner) rules.push({ after: planner.id, review: "always", lockOutputs: true, returnTo: planner.id });
      if (coder && reviewer && flow.workflow.indexOf(coder.id) < flow.workflow.indexOf(reviewer.id)) rules.push({ after: reviewer.id, review: "auto", lockOutputs: false, loop: { target: coder.id, maxCycles: 3, onLimit: "review" } });
      if (final) {
        const finalRule = rules.find(rule => rule.after === final.id);
        if (finalRule) finalRule.review = "always";
        else rules.push({ after: final.id, review: "always", lockOutputs: false, returnTo: final.id });
      }
      showModal(t("Use suggested flow rules?"), html`<p>Review and lock the plan, allow up to three Coder / Reviewer revisions, and review the final output. These replace this flow's current rules. Active tasks keep their saved rules.</p>`, button("close-modal", "Keep current rules", "") + button("flow-apply-suggested", "Apply rules", "check", "primary"));
      ui.suggestedRules = { flowId: flow.id, rules };
    }
    else if (action === "flow-apply-suggested") {
      if (currentFlow().id !== ui.suggestedRules?.flowId) return;
      const flow = flowSchema.parse({ ...currentFlow(), rules: ui.suggestedRules.rules });
      currentFlow().rules = flow.rules; persist(); await flush(); closeModal(); render();
    }
    else if (action === "run-step") { ui.step = Number(target.dataset.index); ui.followRun = false; render(); }
    else if (action === "session-tab") { ui.sessionTab = target.dataset.tab; render(); }
    else if (action === "choose-skills") skillPicker(target.closest("form"));
    else if (action === "back-skills") skillPicker();
    else if (action === "apply-skills") {
      const field = ui.pickerTarget?.querySelector(".skill-binding-field");
      if (field) field.innerHTML = bindingField(ui.pickerDraft);
      closeModal(); toast("Skills selected. Save the preset to keep these bindings.");
    }
    else if (action === "update-skill") {
      const form = target.closest("form");
      const source = catalog.skills.find(item => item.id === id);
      const bindings = JSON.parse(form.elements.skillBindings.value).map(item => item.id === id ? { ...item, name: source.name, version: source.version } : item);
      form.querySelector(".skill-binding-field").innerHTML = bindingField(bindings);
      toast("Latest version selected. Save the preset to keep it.");
    }
    else if (action === "remove-skill") {
      const form = target.closest("form");
      const bindings = JSON.parse(form.elements.skillBindings.value).filter(item => item.id !== id);
      form.querySelector(".skill-binding-field").innerHTML = bindingField(bindings);
    }
    else if (action === "skill-detail") skillDetail(id);
    else if (action === "assign-skill") {
      ui.pickerDraft = null;
      const skill = catalog.skills.find(item => item.id === id);
      showModal(`Attach ${escape(skill.name)}`, html`<p>Choose an agent. Review and save its skills in the Agent library editor.</p><div class="assign-list">${state.agents.map(agent => html`<button class="assign-agent" data-action="assign-to-agent" data-id="${escape(agent.id)}" data-skill="${id}">${agentIcon(agent)}<strong>${escape(agent.name)}</strong>${icon("chevron")}</button>`).join("")}</div>`);
    }
    else if (action === "assign-to-agent") {
      const skill = catalog.skills.find(item => item.id === target.dataset.skill);
      closeModal(); editAgent(id);
      const form = modal.querySelector(".agent-form");
      const bindings = JSON.parse(form.elements.skillBindings.value).filter(item => item.id !== skill.id);
      bindings.push({ id: skill.id, name: skill.name, version: skill.version, sample: !!skill.sample });
      form.querySelector(".skill-binding-field").innerHTML = bindingField(bindings);
      form.querySelector(".skill-binding-field").scrollIntoView({ block: "nearest" });
      toast("Skill selected. Save this preset to attach it.");
    }
    else if (action === "skill-sources") sourcesModal();
    else if (action === "refresh-skills") {
      target.disabled = true;
      try { await catalog.refresh(); render(true); toast("Local skills refreshed. Existing bindings keep their versions."); }
      catch (error) { target.disabled = false; toast(error.message); }
    }
    else if (action === "skill-snapshot") {
      const binding = currentRun().steps[ui.step].agent.skillSnapshots.find(item => item.id === id);
      try { ui.pickerDraft = null; showSkillFiles(binding.name, await catalog.readSnapshot(binding)); }
      catch (error) { toast(t`Snapshot unavailable: ${error.message}`); }
    }
    else if (["zoom-in", "zoom-out", "fit"].includes(action)) {
      const scale = Number.parseInt(document.querySelector(".zoom-value").textContent, 10) / 100;
      ui.zoom = action === "fit" ? null : Math.max(.3, Math.min(1.5, scale + (action === "zoom-in" ? .1 : -.1)));
      sizeCanvas();
    }
    else if (["move-up", "move-down"].includes(action)) {
      const index = currentFlow().workflow.indexOf(ui.selected);
      const destination = index + (action === "move-up" ? -1 : 1);
      if (destination < 0 || destination >= currentFlow().workflow.length) return;
      const order = [...currentFlow().workflow];
      [order[index], order[destination]] = [order[destination], order[index]];
      if (!changeFlowOrder(order)) return;
      persist(); render(); toast("Step order saved. Handoffs now follow the new sequence.");
    }
    else if (action === "remove-step") {
      if (!changeFlowOrder(currentFlow().workflow.filter(item => item !== ui.selected), (currentFlow().rules || []).filter(rule => rule.after !== ui.selected))) return;
      ui.selected = null;
      ui.linkFrom = null; persist(); render(); toast("Step removed. Its preset is still in your agent library.");
    }
    else if (action === "connect-from") { ui.linkFrom = id; render(); toast("Choose a later input port to preview the new order."); }
    else if (action === "connect-to") {
      if (!ui.linkFrom) return toast("Select an output port first.");
      const from = currentFlow().workflow.indexOf(ui.linkFrom);
      const to = currentFlow().workflow.indexOf(id);
      if (to <= from) { toast("Use Automatic revisions in step settings to create a bounded loop."); return; }
      if (to === from + 1) { ui.linkFrom = null; render(); return toast("These agents are already connected in this order."); }
      ui.pendingOrder = [...currentFlow().workflow];
      ui.pendingOrder.splice(to, 1); ui.pendingOrder.splice(from + 1, 0, id);
      ui.linkFrom = null;
      render();
      showModal(t("Review the new order"), html`<p>This places <strong>${escape(state.agents.find(agent => agent.id === id).name)}</strong> directly after <strong>${escape(state.agents.find(agent => agent.id === currentFlow().workflow[from]).name)}</strong>. Other agents keep their relative order.</p><ol class="order-preview">${ui.pendingOrder.map((agentId, index) => { const agent = state.agents.find(item => item.id === agentId); return html`<li class="${currentFlow().workflow[index] !== agentId ? "changed" : ""}"><span>${index + 1}</span>${agentIcon(agent)}<strong>${escape(agent.name)}</strong>${currentFlow().workflow[index] !== agentId ? html`<small>Moved</small>` : ""}</li>`; }).join("")}</ol>`, button("close-modal", "Keep current order", "") + button("apply-order", "Apply new order", "check", "primary"));
    }
    else if (action === "apply-order") {
      if (!ui.pendingOrder || !changeFlowOrder(ui.pendingOrder)) return;
      ui.pendingOrder = null;
      persist(); closeModal(); render(); toast("New order saved.");
    }
    else if (action === "library") libraryModal();
    else if (action === "new-agent") newAgentModal();
    else if (action === "edit-agent") editAgent(id);
    else if (action === "add-existing") {
      if (currentFlow().workflow.length >= 12) return toast("A sequential flow supports up to 12 steps.");
      if (!currentFlow().workflow.includes(id)) currentFlow().workflow.push(id);
      ui.selected = id; ui.zoom = null; ui.view = "team";
      closeModal(); persist(); render(); toast("Agent added to the workflow.");
    }
    else if (action === "refresh-models") {
      const form = target.closest("form"), [provider, auth] = form.elements.connection.value.split("|");
      target.disabled = true;
      try {
        const connection = await checkConnection(provider, auth);
        if (!connection.connected) throw new Error(connection.error || "Connect this account in Connections first.");
        if (form.isConnected && form.elements.connection.value === `${provider}|${auth}`) {
          form.elements.model.innerHTML = modelOptions(provider, auth, form.elements.model.value);
          updateFastModeFields(form);
          enhanceSelects(form);
        }
        toast(t`${connection.models.length} models reported by your runtime.`);
      } catch (error) { toast(error.message); }
      finally { target.disabled = false; }
    }
    else if (action === "connect") connectionModal();
    else if (action === "auth-mode") { ui.connectAuth = target.dataset.auth; connectionModal(); }
    else if (action === "connect-account") {
      target.disabled = true;
      try {
        const connection = await checkConnection(ui.connectProvider, ui.connectAuth, document.getElementById("api-key")?.value);
        if (!connection.connected) throw new Error(connection.error || "Connection check failed.");
        if (modal.open) closeModal(); render(); toast("Connection ready. Your selected billing mode is preserved.");
      } catch (error) {
        const result = document.getElementById("connection-result"); if (result) result.textContent = t(error.message); else toast(error.message);
      } finally { target.disabled = false; }
    }
    else if (action === "official-login") {
      target.disabled = true;
      try {
        const result = await request("/api/connections/login", { provider: ui.connectProvider });
        const box = document.getElementById("connection-result");
        if (box && result.authUrl) {
          const url = new URL(result.authUrl);
          if (url.protocol !== "https:") throw new Error("The runtime returned an invalid sign-in URL.");
          box.innerHTML = html`<a class="btn" href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">Open official sign-in</a><p>After sign-in, choose Check and connect.</p>`;
        } else if (box) box.textContent = result.message || t("Complete sign-in in your browser, then check the connection.");
      } catch (error) { toast(error.message); }
      finally { target.disabled = false; }
    }
    else if (action === "toggle-connection") {
      const connection = state.connections.find(item => item.id === id);
      if (!connection.connected) { ui.connectProvider = connection.provider; ui.connectAuth = connection.auth; connectionModal(); }
      else try { await request("/api/connections/disconnect", { id }); connection.connected = false; render(); toast("Disconnected from Studio. Your official CLI login is preserved."); } catch (error) { toast(error.message); }
    }
    else if (action === "test-connection") {
      const connection = state.connections.find(item => item.id === id); target.disabled = true;
      try { const checked = await checkConnection(connection.provider, connection.auth); render(); toast(checked.connected ? (checked.auth === "subscription" ? (checked.usage?.status === "available" ? "Account and usage refreshed." : "Account checked. Usage is currently unavailable.") : "Runtime and selected authentication mode checked.") : checked.error); } catch (error) { toast(error.message); } finally { target.disabled = false; }
    }
    else if (action === "reconcile") await engine.reconcile(currentRun());
    else if (action === "terminal-open" || action === "terminal-close") {
      target.disabled = true;
      try { engine.update(await request(`/api/terminal/${action === "terminal-open" ? "open" : "close"}`, { id: currentRun().id, stepId: id })); }
      catch (error) { toast(error.message); target.disabled = false; }
    }
    else if (action === "terminal-command") showModal(t("Open the same terminal"), html`<p>From the Agent Studio folder, run:</p><pre class="artifact-preview">./studio terminal ${escape(currentRun().id)}</pre><p>The terminal process stays alive when either view disconnects. Exit the Codex terminal before returning control to Studio.</p>`, button("close-modal", "Close", ""));
    else if (action === "toggle-approval") { state.approvalRequired = !state.approvalRequired; persist(); render(); toast("Default saved for the next run."); }
    else if (action === "open-run") {
      const fromDrawer = mobileNavigation.matches && ui.navigationOpen;
      const entry = state.history.find(run => run.id === id);
      if (entry?.summary) {
        try { Object.assign(entry, await request("/api/runs/read", { id }), { summary: false }); }
        catch (error) { toast(error.message); return; }
      }
      ui.historyId = state.run?.id === id ? null : id;
      ui.view = "run"; ui.step = 0; ui.followRun = false; ui.artifactId = null; ui.navigationOpen = false; ui.navigationActions = false; ui.sessionTab = currentRun()?.review ? "review" : "conversation"; if (currentRun()?.review) ui.step = currentRun().steps.findIndex(s => s.id === currentRun().review.stepId); render();
      if (fromDrawer) app.querySelector(".main").focus({ preventScroll: true });
    }
    else if (action === "artifact") {
      const artifact = findArtifact(id);
      if (artifact) { ui.artifactId = id; render(); }
    }
    else if (action === "download-artifact") { const artifact = findArtifact(id); if (artifact?.mime) { const link = document.createElement("a"); link.href = `/api/artifacts/${currentRun().id}/${artifact.id}`; link.download = artifact.name; link.click(); } else if (artifact) download(artifact.name, artifact.content); }
    else if (action === "export") download("agent-studio-workflow.json", JSON.stringify({ version: 1, name: currentFlow().name, workflow: currentFlow().workflow, rules: currentFlow().rules || [], revision: currentFlow().revision || 1, agents: state.agents.filter(agent => currentFlow().workflow.includes(agent.id)).map(({ skills, ...agent }) => agent), brief: state.brief, approvalRequired: state.approvalRequired }, null, 2), "application/json");
    else if (action === "reset") {
      if (ui.navigationOpen) closeNavigation();
      else { closeNavigationActions(); app.querySelector('[data-action="navigation-actions"]').focus(); }
      showModal(t("Reset this workspace?"), html`<p>This clears Studio presets, connections, and run history. Project registrations, skill sources, project files, and official CLI logins are preserved.</p>`, button("close-modal", "Keep my workspace", "") + button("confirm-reset", "Reset workspace", "reset", "primary"));
    }
    else if (action === "confirm-reset") {
      try { state = await reset(); } catch (error) { toast(error.message); return; }
      engine.dispose();
      engine = new StudioEngine(onRunChange, state.run, state.activeRuns, state.eventSeq);
      ui.view = "home"; ui.selected = null; ui.historyId = null; ui.linkFrom = null; ui.zoom = null; ui.artifactId = null; ui.pendingOrder = null;
      persist(); closeModal(); render(); toast("A fresh studio is ready.");
    }
  });

  document.addEventListener("input", event => {
    if (event.target.id === "local-import-query") renderLocalImportList();
  });
  document.addEventListener("change", event => {
    const input = event.target;
    if (input.id === "max-concurrent-runs") { state.maxConcurrentRuns = Number(input.value); persist(); render(); return; }
    if (input.id === "ui-language") { state.language = input.value; setLanguage(input.value); document.querySelector(".skip-link").textContent = t("Skip to content"); persist(); render(); return; }
    if (input.id === "local-import-provider") renderLocalImportList();
    if (input.dataset.importProject) {
      const key = input.dataset.importProject;
      if (input.checked) ui.importProjects.add(key);
      else ui.importProjects.delete(key);
      renderLocalImportList();
    }
  });

  document.addEventListener("input", event => {
    if (event.target.id === "review-feedback") ui.reviewDraft = event.target.value;
  });
  document.addEventListener("change", event => {
    const form = event.target.closest('[data-form="flow-rule"]');
    if (!form) return;
    form.elements.lockOutputs.disabled = form.elements.review.value !== "always";
    if (form.elements.lockOutputs.disabled) form.elements.lockOutputs.checked = false;
    form.elements.maxCycles.disabled = !form.elements.loopTarget.value;
    form.elements.onLimit.disabled = !form.elements.loopTarget.value;
    enhanceSelects(form);
  });

  document.addEventListener("submit", async event => {
    const form = event.target;
    if (!form.matches("[data-form]")) return;
    event.preventDefault();
    const values = new FormData(form);
    if (form.dataset.form === "flow-rule") await saveFlowRule(form);
    else if (form.dataset.form === "review-feedback") await engine.review("request-revision", values.get("feedback"), currentRun());
    else if (form.dataset.form === "flow") saveFlow(form);
    else if (form.dataset.form === "project") await saveProject(form);
    else if (form.dataset.form === "folder-path") await browseFolders(values.get("path").trim());
    else if (form.dataset.form === "project-settings") await saveProjectSettings(form);
    else if (form.dataset.form === "agent") {
      const agent = state.agents.find(item => item.id === form.dataset.id);
      const name = values.get("name").trim();
      const prompt = values.get("prompt").trim();
      if (!name || !prompt) return toast("Add a name and instructions before saving.");
      const [provider, auth] = values.get("connection").split("|");
      Object.assign(agent, { name, prompt, provider, auth, model: values.get("model"), permissionLevel: values.get("permissionLevel"), codexFastMode: form.elements.codexFastMode.value, tools: [...form.querySelectorAll('[name="tools"]:checked')].map(input => input.value), skillBindings: JSON.parse(values.get("skillBindings")) });
      persist(); if (modal.open) closeModal(); render(); toast(engine.activeRuns.size ? "Preset saved. The active run keeps its original settings." : "Preset saved. Your next run will use these settings.");
    }
    else if (form.dataset.form === "skill-sources") {
      const roots = values.get("roots").split("\n").map(item => item.trim()).filter(Boolean);
      const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
      try { await catalog.refresh(roots); state.skillRoots = roots; persist(); closeModal(); render(); toast("Skill sources saved and scanned."); }
      catch (error) { submit.disabled = false; toast(error.message); }
    }
    else if (form.dataset.form === "new-agent") {
      const name = values.get("name").trim();
      if (!name) return toast("Give your agent a name.");
      const role = values.get("role");
      const template = initialState().agents.find(agent => agent.role === role);
      const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      state.agents.push({ ...template, id, name, prompt: prompts[role] });
      const added = ui.view === "team" && currentFlow().workflow.length < 12;
      if (added) currentFlow().workflow.push(id);
      ui.selected = null; ui.view = "agents"; ui.zoom = null;
      persist(); closeModal(); render(); editAgent(id);
      toast(added ? "Agent created and added to the flow. Edit its shared settings here." : "Agent created in your library. Edit its settings here.");
    }
  });

  document.addEventListener("change", event => {
    if (event.target.id === "agent-permission") updatePermissionFields(event.target.closest("form"));
    if (event.target.id === "new-worktree") {
      document.getElementById("worktree-fields").hidden = !event.target.checked;
      document.getElementById("local-branch").hidden = event.target.checked;
    }
    if (event.target.dataset.skillSelect) {
      const skill = catalog.skills.find(item => item.id === event.target.dataset.skillSelect);
      ui.pickerDraft = ui.pickerDraft.filter(item => item.id !== skill.id);
      if (event.target.checked) ui.pickerDraft.push({ id: skill.id, name: skill.name, version: skill.version, sample: !!skill.sample });
      document.getElementById("selection-count").textContent = t`${ui.pickerDraft.length} selected`;
    }
    if (event.target.id === "agent-connection") {
      const provider = event.target.value.split("|")[0];
      event.target.closest("form").querySelector('[name="model"]').innerHTML = modelOptions(provider, event.target.value.split("|")[1]);
      enhanceSelects(event.target.closest("form"));
    }
    if (["agent-connection", "agent-model", "agent-fast-mode"].includes(event.target.id)) updateFastModeFields(event.target.closest("form"));
    if (event.target.id === "connection-provider") { ui.connectProvider = event.target.value; connectionModal(); }
  });
  document.addEventListener("input", event => {
    if (event.target.id === "project-name") ui.projectDraft.name = event.target.value;
    if (event.target.id === "project-path") ui.projectDraft.path = event.target.value;
    if (event.target.id === "task-brief") { state.brief = event.target.value; persist(); }
    if (event.target.id === "skill-search") { ui.skillQuery = event.target.value; document.getElementById("skill-rows").innerHTML = skillRows(ui.skillQuery); }
    if (event.target.id === "picker-search") { ui.pickerQuery = event.target.value; document.getElementById("picker-rows").innerHTML = skillRows(ui.pickerQuery, true); }
  });
  document.addEventListener("keydown", event => {
    if (modal.open) return;
    if (event.key === "Escape" && ui.navigationActions) {
      closeNavigationActions(); app.querySelector('[data-action="navigation-actions"]').focus(); return;
    }
    if (mobileNavigation.matches && ui.navigationOpen) {
      if (event.key === "Escape") { closeNavigation(); return; }
      if (event.key === "Tab") {
        const controls = [...app.querySelectorAll('.sidebar button:not(:disabled)')].filter(element => element.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    if (event.key === "Escape" && ui.linkFrom) { ui.linkFrom = null; render(); }
  });
  let lookFrame = 0;
  document.addEventListener("pointermove", event => {
    if (!lookFrame) lookFrame = requestAnimationFrame(() => {
      lookFrame = 0;
      document.documentElement.style.setProperty("--look-x", (event.clientX / innerWidth * 2 - 1).toFixed(2));
      document.documentElement.style.setProperty("--look-y", (event.clientY / innerHeight * 2 - 1).toFixed(2));
    });
    const card = event.target.closest?.(".tilt");
    if (!card || reducedMotion.matches) return;
    const box = card.getBoundingClientRect();
    card.style.setProperty("--tilt-x", `${(((event.clientX - box.left) / box.width) - .5) * 8}deg`);
    card.style.setProperty("--tilt-y", `${(.5 - ((event.clientY - box.top) / box.height)) * 8}deg`);
  });
  document.addEventListener("pointerout", event => {
    const card = event.target.closest?.(".tilt");
    if (card && !card.contains(event.relatedTarget)) { card.style.removeProperty("--tilt-x"); card.style.removeProperty("--tilt-y"); }
  });
  mobileNavigation.addEventListener("change", () => { ui.navigationOpen = false; ui.navigationActions = false; render(true); });
  modal.addEventListener("cancel", event => { event.preventDefault(); closeModal(); });
  modal.addEventListener("click", event => { if (event.target === modal && (event.clientX < modal.getBoundingClientRect().left || event.clientX > modal.getBoundingClientRect().right || event.clientY < modal.getBoundingClientRect().top || event.clientY > modal.getBoundingClientRect().bottom)) closeModal(); });
  window.addEventListener("pagehide", () => { void flush().catch(() => {}); engine.dispose(); });
  window.addEventListener("pageshow", event => { if (event.persisted) { engine.closed = false; engine.connect(); } });
  window.addEventListener("studio-save", event => { const label = document.getElementById("save-status"); if (label) label.textContent = t(event.detail); });
  window.addEventListener("studio-error", event => { persistent = false; toast(event.detail); });
  render();
  catalog.load(state.skillRoots).then(() => {
    render(true);
    const form = ui.pickerTarget || modal.querySelector('[data-form="agent"]');
    if (form) form.querySelector(".skill-binding-field").innerHTML = bindingField(JSON.parse(form.elements.skillBindings.value));
    const rows = document.getElementById("picker-rows");
    if (rows) rows.innerHTML = skillRows(ui.pickerQuery, true);
  });
})();
