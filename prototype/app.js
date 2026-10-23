(() => {
  "use strict";

  const { roles, models, prompts, initialState, DemoEngine } = window.StudioDemo;
  const storageKey = "agent-studio-prototype-v1";
  const app = document.getElementById("app");
  const modal = document.getElementById("modal");
  let persistent = true;
  let state;
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || "null");
    state = stored?.version === 1 && Array.isArray(stored.agents) && stored.agents.length &&
      stored.agents.every(agent => roles[agent.role] && models[agent.provider] && Array.isArray(agent.tools)) &&
      Array.isArray(stored.workflow) && stored.workflow.every(id => stored.agents.some(agent => agent.id === id)) &&
      Array.isArray(stored.connections) && Array.isArray(stored.history) ? stored : initialState();
  } catch {
    state = initialState();
    persistent = false;
  }

  const ui = {
    view: "workflow", tab: "builder", selected: state.workflow[0] || state.agents[0].id,
    sessionTab: "conversation", step: 0, followRun: true, historyId: null,
    linkFrom: null, zoom: null, connectProvider: "codex", connectAuth: "subscription",
  };
  let toastTimer;
  let connectionTimer;
  let resizeObserver;
  let lastFocused;

  const iconPaths = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    flow: '<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M6 9v9h9M9 6h9v9"/>',
    agents: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2"/>',
    plug: '<path d="m8 3 2 4m6-4-2 4M6 7h12v3a6 6 0 0 1-12 0V7Zm6 9v5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    sliders: '<path d="M4 7h8m4 0h4M4 17h3m4 0h9"/><circle cx="14" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    leaf: '<path d="M20 3C10 2 3 6 4 14c1 7 12 7 14-1 1-4 0-7 2-10Z"/><path d="m4 21 11-12"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .7-1.5 1-1.5 3M12 17h.01"/>',
    reset: '<path d="M3 11a9 9 0 1 1 2 7M3 5v6h6"/>',
    play: '<path d="m8 4 12 8-12 8V4Z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    up: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
    down: '<path d="M12 4v16m-6-6 6 6 6-6"/>',
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6M8 13h8m-8 4h5"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2.5 5.5L8 16l2.5-5.5L16 8Z"/>',
    code: '<path d="m7 7-5 5 5 5m10-10 5 5-5 5m-3-14-4 18"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    terminal: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 8 4 4-4 4m7 0h5"/>',
    browser: '<rect x="2" y="3" width="20" height="18" rx="2"/><path d="M2 8h20M6 5.5h.01M10 5.5h.01M8 13l3 3 5-5"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m12-10c0 7-12 2-12 8"/>',
    message: '<path d="M21 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v9Z"/><path d="M7 8h10M7 12h7"/>',
    cursor: '<path d="m4 3 6 18 3-8 8-3L4 3Z"/>',
    fit: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
    edit: '<path d="m16 3 5 5L8 21H3v-5L16 3Zm-2 2 5 5"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>',
    spark: '<path d="m12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8L12 2Z"/>',
    activity: '<path d="M2 12h4l3-8 5 16 3-8h5"/>',
    alert: '<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3h.01"/>',
    loader: '<path d="M12 3a9 9 0 1 1-9 9"/>',
  };
  const icon = (name, className = "") => `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.file}</svg>`;
  const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const selected = (actual, expected) => actual === expected ? " selected" : "";
  const providerName = provider => provider === "codex" ? "Codex" : "Claude Code";
  const authName = auth => auth === "api" ? "API key" : "Subscription";
  const agentStyle = agent => `--agent-color:${roles[agent.role].color};--agent-bg:${roles[agent.role].background}`;
  const agentIcon = (agent, large = false) => `<span class="agent-icon${large ? " large" : ""}" style="${agentStyle(agent)}">${icon(roles[agent.role].icon)}</span>`;
  const button = (action, label, iconName, className = "", data = "", disabled = false) => `<button type="button" class="btn ${className}" data-action="${action}" ${data}${disabled ? " disabled" : ""}>${iconName ? icon(iconName) : ""}${label}</button>`;
  const statusNames = { running: "Running", paused: "Paused", waiting_approval: "Needs approval", succeeded: "Completed", failed: "Blocked", cancelled: "Cancelled", queued: "Queued" };
  const statusBadge = status => `<span class="badge ${["paused", "waiting_approval"].includes(status) ? "amber" : status === "failed" ? "red" : status === "cancelled" ? "gray" : ""}">${status === "running" ? icon("loader", "spinning") : ""}${statusNames[status] || "Ready"}</span>`;

  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); }
    catch { persistent = false; }
  }

  function onRunChange(run) {
    state.run = run;
    if (ui.followRun && run) ui.step = Math.min(run.index, run.steps.length - 1);
    persist();
    render(true);
  }

  let engine = new DemoEngine(onRunChange, state.run);
  state.run = engine.run;
  persist();

  function toast(message) {
    clearTimeout(toastTimer);
    const element = document.getElementById("toast");
    element.textContent = message;
    element.classList.add("show");
    toastTimer = setTimeout(() => element.classList.remove("show"), 4200);
  }

  function currentRun() {
    return ui.historyId ? state.history.find(run => run.id === ui.historyId) : state.run;
  }

  function navItem(view, name, iconName, count = null) {
    return `<button type="button" class="nav-item ${ui.view === view ? "active" : ""}" data-action="navigate" data-view="${view}" aria-label="${name}" ${ui.view === view ? 'aria-current="page"' : ""}>${icon(iconName)}<span>${name}</span>${count !== null ? `<span class="nav-count">${count}</span>` : ""}</button>`;
  }

  function sidebar() {
    return `<aside class="sidebar"><div class="brand"><span class="brand-mark"><svg viewBox="0 0 30 30" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="5" y="4" width="13" height="13" rx="2"/><rect x="12" y="12" width="13" height="13" rx="2"/></svg></span><span class="brand-name">agent studio<span style="color:#91a57d">.</span></span></div>
      <div class="workspace-label"><span class="avatar">ME</span><div><strong>Personal workspace</strong><small>Your local environment</small></div></div>
      <div class="eyebrow nav-label">Your studio</div><nav class="nav" aria-label="Main navigation">
        ${navItem("workflow", "Workflow", "flow")}${navItem("agents", "Agents", "agents", state.agents.length)}${navItem("connections", "Connections", "plug")}${navItem("runs", "Runs", "clock", state.history.length + (state.run ? 1 : 0))}${navItem("defaults", "Defaults", "sliders")}
      </nav><div class="sidebar-bottom"><div class="context-note">${icon("leaf")}<strong>Fresh context. Clear work.</strong><p>Each agent starts a new session with just the context it needs.</p></div>
      <button class="nav-item" data-action="help" aria-label="How this demo works">${icon("help")}<span>How this works</span></button>
      <button class="nav-item" data-action="reset" aria-label="Reset demo">${icon("reset")}<span>Reset demo</span></button>
      <div class="sidebar-status"><span class="dot"></span>Demo engine / browser only</div></div></aside>`;
  }

  function heading(title, subtitle, actions, eyebrow = "Your personal agent workspace") {
    return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p class="subtitle">${subtitle}</p></div><div class="actions">${actions}</div></div>`;
  }

  function render(live = false) {
    const preserved = live && ui.view === "workflow" && ui.tab === "builder" ? [document.querySelector(".inspector"), document.querySelector(".brief-panel")] : [];
    const viewNames = { workflow: "Feature delivery", agents: "Agent library", connections: "AI connections", runs: "Run history", defaults: "Workspace defaults" };
    app.innerHTML = `<div class="shell">${sidebar()}<div class="main"><header class="topbar"><div class="crumbs">Personal workspace <span>/</span><strong>${viewNames[ui.view]}</strong></div><span class="prototype-pill"><span class="dot"></span>Interactive prototype</span></header><main id="main-content" class="page">${ui.view === "workflow" ? workflowView() : ui.view === "agents" ? agentsView() : ui.view === "connections" ? connectionsView() : ui.view === "runs" ? runsView() : defaultsView()}</main></div></div>`;
    for (const panel of preserved) {
      if (!panel) continue;
      const next = document.querySelector(panel.classList.contains("inspector") ? ".inspector" : ".brief-panel");
      if (next) next.replaceWith(panel);
    }
    resizeObserver?.disconnect();
    const viewport = document.querySelector(".canvas-viewport");
    if (viewport) {
      resizeObserver = new ResizeObserver(() => sizeCanvas());
      resizeObserver.observe(viewport);
      sizeCanvas();
    }
  }

  function workflowView() {
    const run = currentRun();
    const tabs = [["builder", "Workflow", "flow"], ["session", "Run & sessions", "activity"], ["artifacts", "Artifacts", "file"]];
    return heading("Feature delivery", "A small team. One clear path from idea to verified change.",
      button("export", "Export", "download", "text") + button("run", engine.isActive() ? "View active run" : "Run demo", "play", "primary")) +
      `<div class="tabs" role="tablist" aria-label="Workflow views">${tabs.map(([id, label, glyph]) => `<button role="tab" type="button" class="tab ${ui.tab === id ? "active" : ""}" aria-selected="${ui.tab === id}" data-action="tab" data-tab="${id}">${icon(glyph)}${label}${id === "artifacts" && run?.artifacts.length ? `<span class="tab-count">${run.artifacts.length}</span>` : ""}</button>`).join("")}<span class="save-state">${icon("check")}${persistent ? "Saved in this browser" : "Session only"}</span></div>` +
      (ui.tab === "builder" ? builderView() : ui.tab === "session" ? sessionView(run) : artifactsView(run));
  }

  function builderView() {
    let agent = state.agents.find(item => item.id === ui.selected);
    if (!agent) { agent = state.agents[0]; ui.selected = agent.id; }
    return `<div class="builder-grid"><div><section class="panel"><div class="panel-heading"><div class="flow-meta"><h2>${state.workflow.length} steps</h2><span class="divider"></span><span class="meta">Sequential workflow</span></div>${button("library", "Add agent", "plus", "small", "", engine.isActive())}</div><div class="canvas-viewport" aria-label="Agent workflow canvas"><div class="canvas-wrap"><div class="canvas-stage">${canvas()}</div></div></div><div class="canvas-footer"><span class="canvas-tip">${icon("cursor")}${ui.linkFrom ? "Choose an input port to reconnect. Esc cancels." : "Select a step to edit. Connect ports to reorder."}</span><div class="zoom-controls">${button("zoom-out", "", "minus", "text icon-only", 'aria-label="Zoom out"')}<span class="zoom-value">Fit</span>${button("zoom-in", "", "plus", "text icon-only", 'aria-label="Zoom in"')}${button("fit", "", "fit", "text icon-only", 'aria-label="Fit workflow"')}</div></div></section>
      <section class="panel brief-panel"><div class="brief-top"><h2>${icon("message")}Task brief</h2><span class="repo-chip">${icon("branch")}storefront-lab / demo</span></div><label class="eyebrow" for="task-brief" style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)">Task brief</label><textarea id="task-brief" maxlength="2000" rows="2" placeholder="What should your team build?">${escape(state.brief)}</textarea><p class="brief-hint">Runs use a scripted newsletter example. Your brief and presets are saved for exploration.</p></section>
      ${activityStrip()}</div><aside class="panel inspector" aria-label="Agent configuration"><div class="inspector-header">${agentIcon(agent)}<div><h2>${escape(agent.name)}</h2><p>Agent preset / ${engine.isActive() ? "Edits apply to the next run" : "Configure this step"}</p></div></div>${agentForm(agent)}</aside></div>`;
  }

  function position(index) {
    const row = Math.floor(index / 3);
    const column = row % 2 === 0 ? index % 3 : 2 - index % 3;
    return { x: 43 + column * 261, y: 65 + row * 230, row, forward: row % 2 === 0 };
  }

  function canvas() {
    const height = Math.ceil(Math.max(state.workflow.length, 1) / 3) * 230 + 20;
    const matchingRun = state.run && state.workflow.length === state.run.steps.length &&
      state.workflow.every((id, index) => id === state.run.steps[index].agent.id) &&
      (engine.isActive() || (state.brief === state.run.brief && state.workflow.every((id, index) =>
        JSON.stringify(state.agents.find(agent => agent.id === id)) === JSON.stringify(state.run.steps[index].agent))));
    let lines = "";
    let nodes = "";
    state.workflow.forEach((id, index) => {
      const agent = state.agents.find(item => item.id === id);
      const pos = position(index);
      const step = matchingRun ? state.run.steps.find(item => item.agent.id === id) : null;
      const stepStatus = state.run?.status === "paused" && step?.status === "running" ? "paused" : step?.status || "ready";
      const done = stepStatus === "succeeded";
      const inputSide = index % 3 === 0 && index > 0 ? "top" : pos.forward ? "left" : "right";
      const outputSide = index % 3 === 2 ? "bottom" : pos.forward ? "right" : "left";
      if (index < state.workflow.length - 1) {
        const next = position(index + 1);
        const path = pos.row === next.row ? `M ${pos.forward ? pos.x + 208 : pos.x} ${pos.y + 67} H ${pos.forward ? next.x : next.x + 208}` : `M ${pos.x + 104} ${pos.y + 135} V ${next.y}`;
        lines += `<path class="flow-line ${done ? "done" : stepStatus === "running" ? "live" : ""}" d="${path}" marker-end="url(#arrowhead)"/>`;
      }
      nodes += `<div class="node ${ui.selected === id ? "selected" : ""} ${done ? "done" : stepStatus}" style="left:${pos.x}px;top:${pos.y}px"><button class="node-body" data-action="select-agent" data-id="${escape(id)}" aria-label="Configure ${escape(agent.name)}" aria-pressed="${ui.selected === id}"><span class="node-top">${agentIcon(agent)}<span><span class="node-name">${escape(agent.name)}</span><span class="node-role">${escape(roles[agent.role].label)}</span></span></span><span class="node-provider">${icon("spark")}${providerName(agent.provider)} <span style="color:#b4bdab">/</span> ${authName(agent.auth)}</span><span class="node-bottom"><span class="node-status">${icon(done ? "check" : stepStatus === "waiting_approval" ? "lock" : "leaf")}${stepStatus === "ready" ? "Fresh session" : statusNames[stepStatus]}</span><span class="node-number">${String(index + 1).padStart(2, "0")}</span></span></button><button class="port ${inputSide}" data-action="connect-to" data-id="${escape(id)}" aria-label="Connect to ${escape(agent.name)}" ${engine.isActive() ? "disabled" : ""}></button><button class="port ${outputSide} ${ui.linkFrom === id ? "linking" : ""}" data-action="connect-from" data-id="${escape(id)}" aria-label="Connect from ${escape(agent.name)}" ${engine.isActive() ? "disabled" : ""}></button></div>`;
    });
    return `<svg class="connections-svg" viewBox="0 0 820 ${height}" style="height:${height}px" aria-hidden="true"><defs><marker id="arrowhead" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0 0L5 2.5L0 5" fill="none" stroke="#b4c2a6" stroke-width="1"/></marker></defs>${lines}</svg><div class="flow-caption" style="top:27px">${icon("message")} YOUR BRIEF</div>${nodes}${!state.workflow.length ? `<div style="padding:100px 70px"><h2>Your workflow starts here.</h2><p style="margin-top:15px">Add an agent to create the first step.</p></div>` : ""}`;
  }

  function sizeCanvas() {
    const viewport = document.querySelector(".canvas-viewport");
    if (!viewport) return;
    const height = Math.ceil(Math.max(state.workflow.length, 1) / 3) * 230 + 20;
    const fit = Math.max(.72, Math.min((viewport.clientWidth - 12) / 820, (viewport.clientHeight - 10) / height, 1.12));
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

  function agentForm(agent, inModal = false) {
    const index = state.workflow.indexOf(agent.id);
    return `<form class="inspector-form" data-form="agent" data-id="${escape(agent.id)}"><div class="field"><label for="agent-name">Name</label><input id="agent-name" name="name" value="${escape(agent.name)}" maxlength="40" required></div>
      <div class="field prompt-field"><label for="agent-prompt">Instructions</label><textarea id="agent-prompt" name="prompt" rows="4" maxlength="2500" required>${escape(agent.prompt)}</textarea></div>
      <div class="field"><label for="agent-connection">AI connection</label><select id="agent-connection" name="connection">${["codex", "claude"].flatMap(provider => ["subscription", "api"].map(auth => `<option value="${provider}|${auth}"${selected(`${agent.provider}|${agent.auth}`, `${provider}|${auth}`)}>${providerName(provider)} / ${authName(auth)}</option>`)).join("")}</select></div>
      <div class="field"><label for="agent-model">Model</label><select id="agent-model" name="model">${models[agent.provider].map(model => `<option${selected(agent.model, model)}>${model}</option>`).join("")}</select><small>Sample model choices for this prototype.</small></div>
      <div class="field"><span class="field-label">Skills</span><div class="skill-list">${roles[agent.role].skills.concat("Project rules").map(skill => `<button type="button" class="skill-chip" data-action="skill" data-skill="${escape(skill)}" aria-pressed="${agent.skills.includes(skill)}">${escape(skill)}</button>`).join("")}</div></div>
      <div class="field"><span class="field-label">Allowed tools</span><div class="checks">${[["read", "Read files"], ["write", "Write files"], ["shell", "Shell"], ["browser", "Browser"]].map(([value, label]) => `<label class="check"><input type="checkbox" name="tools" value="${value}"${agent.tools.includes(value) ? " checked" : ""}>${label}</label>`).join("")}</div></div>
      <div class="context-chip">${icon("leaf")}New session per step. Only the brief, decisions, and artifact references carry forward.</div><button type="submit" class="btn primary full">${icon("check")}Save preset</button>
      ${!inModal && index >= 0 ? `<div class="inspector-bottom"><div class="actions">${button("move-up", "", "up", "small icon-only", 'aria-label="Move step earlier"', index === 0 || engine.isActive())}${button("move-down", "", "down", "small icon-only", 'aria-label="Move step later"', index === state.workflow.length - 1 || engine.isActive())}</div>${button("remove-step", "Remove step", "trash", "text small", "", engine.isActive())}</div>` : ""}</form>`;
  }

  function activityStrip() {
    const run = state.run;
    if (!run) return `<div class="activity-strip">${icon("activity")}<p><strong>Your team is ready.</strong> Run the demo to watch each handoff.</p>${button("help", "Quick tour", "arrow", "text small")}</div>`;
    return `<div class="activity-strip">${icon(run.status === "waiting_approval" ? "lock" : "activity")}<p><strong>${escape(run.id)} / ${statusNames[run.status]}.</strong> ${run.status === "waiting_approval" ? "Your agent is waiting for permission to continue." : `${run.steps.filter(step => step.status === "succeeded").length} of ${run.steps.length} steps complete.`}</p>${button("live-session", "Open session", "arrow", "text small")}</div>`;
  }

  function agentsView() {
    return heading("Your agents", "Give each role a purpose, a model, and a set of boundaries.", button("new-agent", "New agent", "plus", "primary"), "Reusable presets") +
      `<div class="content-grid">${state.agents.map(agent => `<section class="panel agent-card"><div class="card-top">${agentIcon(agent, true)}<div><h2>${escape(agent.name)}</h2><p>${providerName(agent.provider)} / ${escape(agent.model)}</p></div></div><p>${escape(roles[agent.role].description)}</p><div class="skill-list">${agent.skills.map(skill => `<span class="skill-chip" aria-pressed="true">${escape(skill)}</span>`).join("")}</div><div class="card-footer">${state.workflow.includes(agent.id) ? '<span class="badge">In workflow</span>' : button("add-existing", "Add to workflow", "plus", "small", `data-id="${escape(agent.id)}"`, engine.isActive())}${button("edit-agent", "Edit preset", "edit", "text small", `data-id="${escape(agent.id)}"`)}</div></section>`).join("")}</div>`;
  }

  function connectionsView() {
    return heading("Connect your AI", "Use an API key or your own subscription through an official local runtime.", button("connect", "Add connection", "plus", "primary"), "Bring your own account") +
      `<div class="info-banner">${icon("shield")}<span>This prototype uses demo accounts. It never asks for real keys, opens a login page, or makes paid requests. Connection states below are simulated.</span></div><div class="connection-grid">${state.connections.map(connection => `<section class="panel connection-card"><div class="card-top"><div class="actions"><div class="provider-logo ${connection.provider}">${connection.provider === "codex" ? "&lt;/&gt;" : "✳"}</div><div><h2>${providerName(connection.provider)}</h2><p>${connection.provider === "codex" ? "OpenAI" : "Anthropic"} / ${authName(connection.auth)}</p></div></div><span class="badge ${connection.connected ? "" : "gray"}">${connection.connected ? "Demo connected" : "Disconnected"}</span></div><dl class="definition-list"><dt>Authentication</dt><dd>${connection.auth === "api" ? "API key (demo placeholder)" : "Official CLI sign-in"}</dd><dt>Billing mode</dt><dd>${connection.auth === "api" ? "API usage" : "Your subscription"}</dd><dt>Automatic API fallback</dt><dd>Off</dd><dt>Actual requests</dt><dd>0</dd></dl><div class="card-footer">${button("test-connection", "Test demo connection", "activity", "small", `data-id="${connection.id}"`, !connection.connected)}${button("toggle-connection", connection.connected ? "Disconnect" : "Reconnect demo", connection.connected ? "plug" : "plus", "text small", `data-id="${connection.id}"`)}</div></section>`).join("")}</div>`;
  }

  function runsView() {
    const runs = [state.run, ...state.history].filter(Boolean);
    return heading("Run history", "Every session, decision, and artifact stays connected to its run.", button("navigate", "Open workflow", "arrow", "primary", 'data-view="workflow"'), "A record of the work") +
      (runs.length ? `<section class="panel"><table class="history-table"><thead><tr><th>RUN / TASK</th><th>STATUS</th><th>ARTIFACTS</th><th></th></tr></thead><tbody>${runs.map(run => `<tr><td>${escape(run.id)}<small>${escape(run.brief.slice(0, 75))}${run.brief.length > 75 ? "..." : ""}</small></td><td>${statusBadge(run.status)}</td><td>${run.artifacts.length} files</td><td>${button("open-run", "Inspect", "arrow", "text small", `data-id="${run.id}"`)}</td></tr>`).join("")}</tbody></table></section>` : emptyState("clock", "Your first run starts here", "Run the sample workflow to see conversations, approvals, and artifacts collected in one place.", button("run", "Run demo", "play", "primary")));
  }

  function emptyState(iconName, title, description, action = "") {
    return `<section class="panel empty"><div class="empty-icon">${icon(iconName)}</div><h2>${title}</h2><p>${description}</p>${action}</section>`;
  }

  function sessionView(run) {
    if (!run) return emptyState("message", "Watch your team work", "Start a demo run. Each agent opens a fresh session, completes a step, and hands its outputs to the next agent.", button("run", "Run demo", "play", "primary"));
    ui.step = Math.min(Math.max(ui.step, 0), run.steps.length - 1);
    const step = run.steps[ui.step];
    const isCurrent = run.id === state.run?.id;
    const controls = isCurrent ? (run.status === "running" ? button("pause", "Pause", "pause") : run.status === "paused" ? button("resume", "Resume", "play", "primary") : "") + (["running", "paused", "waiting_approval"].includes(run.status) ? button("cancel", "Cancel", "stop", "danger") : button("run", "Run again", "play", "primary")) : button("live-session", "Latest run", "arrow");
    const approval = isCurrent && run.status === "waiting_approval" ? `<div class="approval"><h3>${escape(run.steps[run.index].agent.name)} needs your approval</h3><p>Allow simulated file changes in <strong>storefront-lab / demo worktree</strong> for this run. Your real files stay untouched.</p><div class="actions">${button("approve", "Approve demo changes", "check", "primary small")}${button("cancel", "Reject & cancel", "close", "small")}</div></div>` : "";
    return `<section class="panel run-bar"><div><h2>${escape(run.id)} <span class="badge gray">Simulation</span></h2><p class="meta">${escape(run.note)}</p><div class="run-progress" aria-label="${run.steps.filter(item => item.status === "succeeded").length} of ${run.steps.length} steps complete">${run.steps.map(item => `<span class="${item.status === "succeeded" ? "done" : item.status}"></span>`).join("")}</div></div><div class="actions">${statusBadge(run.status)}${controls}</div></section>
      <section class="panel run-grid"><aside class="run-steps" aria-label="Run sessions"><div class="eyebrow">Agent sessions</div>${run.steps.map((item, index) => `<button class="run-step ${index === ui.step ? "active" : ""}" data-action="run-step" data-index="${index}" aria-label="View ${escape(item.agent.name)} session" aria-pressed="${index === ui.step}">${agentIcon(item.agent)}<span><strong>${escape(item.agent.name)}</strong><small>${statusNames[item.status]}</small></span>${item.status === "succeeded" ? icon("check", "step-check") : ""}</button>`).join("")}</aside><div class="session"><div class="session-head"><div><h2>${escape(step.agent.name)} <span class="session-id">/ ${escape(step.sessionId)}</span></h2><p>${escape(step.agent.model)} / ${authName(step.agent.auth)} / fresh context</p></div><span class="badge gray">${step.receivedArtifacts.length} inputs</span></div><div class="session-tabs" role="tablist" aria-label="Session content">${[["conversation", "Conversation"], ["tools", "Tool activity"], ["handoff", "Handoff"]].map(([id, label]) => `<button class="tab ${ui.sessionTab === id ? "active" : ""}" role="tab" aria-selected="${ui.sessionTab === id}" data-action="session-tab" data-tab="${id}">${label}</button>`).join("")}</div><div class="session-content">${approval}${ui.sessionTab === "handoff" ? handoffView(step, run) : messagesView(step)}</div></div></section>`;
  }

  function messagesView(step) {
    const messages = step.messages.filter(message => ui.sessionTab === "conversation" ? message.type !== "tool" : message.type === "tool");
    if (!messages.length) return `<div class="empty" style="padding:45px 15px"><h2 style="font-size:15px">${step.status === "queued" ? "This session has not started yet" : "Waiting for the next event"}</h2><p>${ui.sessionTab === "tools" ? "Simulated tool calls will appear here when this step uses a tool." : "The agent will receive a fresh session and references to the previous outputs."}</p></div>`;
    return messages.map(message => `<div class="message ${message.type}"><div class="message-label"><span>${message.type === "assistant" ? escape(step.agent.name) : message.type === "tool" ? "Simulated tool call" : "Session event"}</span><span>${new Date(message.time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span></div><div class="message-text">${escape(message.text)}</div></div>`).join("");
  }

  function handoffView(step, run) {
    const outputs = run.artifacts.filter(artifact => artifact.stepId === step.id);
    return `<div class="handoff-card"><h3>A small handoff, with the full evidence nearby.</h3><p><strong>Goal:</strong> ${escape(run.brief)}<br><strong>Context:</strong> a new session, not the previous conversation.<br><strong>Inputs:</strong> ${step.receivedArtifacts.length ? step.receivedArtifacts.map(item => escape(item.name)).join(", ") : "The task brief and project rules."}<br><strong>Code reference:</strong> demo-diff-v1 (sample)<br><strong>Instructions snapshot:</strong> ${escape(step.agent.prompt)}</p></div><div style="margin-top:20px"><p class="eyebrow" style="margin-bottom:12px">Outputs from this step</p>${outputs.length ? `<div class="artifact-list">${outputs.map(artifactRow).join("")}</div>` : '<p class="meta">Artifacts appear after this step completes.</p>'}</div>`;
  }

  function artifactRow(artifact) {
    return `<button class="artifact-row" data-action="artifact" data-id="${escape(artifact.id)}">${icon(artifact.type === "Code diff" ? "code" : "file")}<span><strong>${escape(artifact.name)}</strong><small>${escape(artifact.agent)} / sample artifact</small></span><span class="badge gray">${escape(artifact.type)}</span>${icon("chevron")}</button>`;
  }

  function artifactsView(run) {
    if (!run?.artifacts.length) return emptyState("file", "Evidence, not just a finish line", "The plan, QA sheet, diff, review, and test reports will appear here as your demo run progresses.", run ? button("live-session", "Watch the run", "activity", "primary") : button("run", "Run demo", "play", "primary"));
    return `<div class="info-banner">${icon("file")}<span><strong>${escape(run.id)}</strong> / ${run.artifacts.length} sample artifacts. Open any file to inspect or download it. These outputs are scripted examples.</span></div><div class="artifact-list">${run.artifacts.map(artifactRow).join("")}</div>`;
  }

  function defaultsView() {
    return heading("Good habits, built in", "Set the boundaries once. Every agent starts with them.", button("help", "About this demo", "help"), "Workspace defaults") +
      `<section class="panel settings-panel"><div class="setting-row"><div><h2>Fresh session at each handoff</h2><p>Pass the goal, decisions, and artifact references. Keep the original conversation available for inspection.</p></div><span class="badge">Always on</span></div><div class="setting-row"><div><h2>Approval before file changes</h2><p>Pause the demo before the first write-enabled agent. Your choice applies to the next run.</p></div><button class="toggle" role="switch" aria-label="Approval before file changes" aria-checked="${state.approvalRequired}" data-action="toggle-approval"></button></div><div class="setting-row"><div><h2>No automatic paid fallback</h2><p>A subscription limit should pause the task. Switching to API billing is a separate, explicit choice.</p></div><span class="badge">Always on</span></div><div class="setting-row"><div><h2>Keep the evidence</h2><p>Plans, QA cases, diffs, and test results stay attached to the run and its code reference.</p></div><span class="badge">Always on</span></div><div class="setting-row"><div><h2>One active demo at a time</h2><p>Pause, resume, or cancel an active run before starting another. Preset edits never change an active run's snapshot.</p></div><span class="badge gray">1 run</span></div><div class="setting-row"><div><h2>Browser storage</h2><p>Demo presets and recent runs are saved in this browser. Real keys are never collected. Reset only removes this prototype's data.</p></div>${button("reset", "Reset demo", "reset", "small")}</div></section>`;
  }

  function showModal(title, body, footer = "", wide = false, eyebrow = "Agent Studio") {
    clearTimeout(connectionTimer);
    lastFocused = document.activeElement;
    modal.className = wide ? "wide" : "";
    modal.innerHTML = `<div class="modal-head"><div><div class="eyebrow">${eyebrow}</div><h2 id="modal-title">${title}</h2></div>${button("close-modal", "", "close", "text icon-only", 'aria-label="Close dialog"')}</div><div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ""}`;
    if (!modal.open) modal.showModal();
  }

  function closeModal() {
    clearTimeout(connectionTimer);
    modal.close();
    if (lastFocused?.isConnected) lastFocused.focus();
  }

  function connectionModal() {
    showModal("Add an AI connection", `<p>Choose how your agent would connect. This is a simulated setup; no credentials are collected.</p><div class="field"><label for="connection-provider">Provider</label><select id="connection-provider"><option value="codex"${selected(ui.connectProvider, "codex")}>Codex / OpenAI</option><option value="claude"${selected(ui.connectProvider, "claude")}>Claude Code / Anthropic</option></select></div><div class="field"><span class="field-label">Authentication</span><div class="segment">${[["subscription", "My subscription"], ["api", "API key"]].map(([auth, name]) => `<button data-action="auth-mode" data-auth="${auth}" class="${ui.connectAuth === auth ? "active" : ""}" aria-pressed="${ui.connectAuth === auth}">${name}</button>`).join("")}</div></div>${ui.connectAuth === "api" ? '<div class="field"><label for="demo-api-key">API key</label><input id="demo-api-key" value="Demo placeholder - no real key needed" disabled><small>The real product will store keys through the local engine, outside browser storage.</small></div>' : ""}<div class="connect-preview"><h3>${ui.connectAuth === "subscription" ? "Use your existing subscription" : "Pay through your API account"}</h3><div class="connect-check">${icon("check")}${providerName(ui.connectProvider)} runtime detected (demo)</div><div class="connect-check">${icon("lock")}${ui.connectAuth === "subscription" ? "Authentication stays with the official CLI" : "A demo key is supplied for this prototype"}</div><p>${ui.connectAuth === "subscription" ? "The real setup will ask you to sign in through the official runtime. Agent Studio will not collect your subscription token." : "API billing is separate from a subscription. A subscription limit will never silently switch this connection to API billing."}</p></div>`, button("close-modal", "Cancel", "", "") + button("simulate-connect", "Connect demo account", "plug", "primary"), false, "Connection setup / simulation");
  }

  function libraryModal() {
    if (engine.isActive()) return toast("Finish or cancel the current run before changing its workflow.");
    const available = state.agents.filter(agent => !state.workflow.includes(agent.id));
    showModal("Add a step", `<p>Choose a preset. New steps are added to the end of your sequential workflow.</p><div class="library-list">${available.map(agent => `<button class="library-item" data-action="add-existing" data-id="${escape(agent.id)}">${agentIcon(agent)}<span><strong>${escape(agent.name)}</strong><small>${providerName(agent.provider)} / ${escape(agent.model)}</small></span>${icon("plus")}</button>`).join("")}${!available.length ? '<p class="meta" style="padding:15px 0">All your current presets are already in this workflow.</p>' : ""}</div>`, button("new-agent", "Create a new agent", "plus", "primary"));
  }

  function newAgentModal() {
    showModal("Make it your own", `<p>Create a preset, then tune its instructions, model, skills, and permissions.</p><form id="new-agent-form" data-form="new-agent"><div class="field"><label for="new-agent-name">Agent name</label><input id="new-agent-name" name="name" maxlength="40" placeholder="e.g. Data architect" required></div><div class="field"><label for="new-agent-role">Start from a role</label><select id="new-agent-role" name="role">${Object.entries(roles).map(([key, role]) => `<option value="${key}">${role.label}</option>`).join("")}</select></div></form>`, button("close-modal", "Cancel", "") + '<button type="submit" form="new-agent-form" class="btn primary">Create preset</button>');
  }

  function helpModal() {
    const steps = [
      ["Connect your AI", "Explore API key and subscription setup in Connections. Both use demo accounts here."],
      ["Make an agent yours", "Select a workflow step. Change the prompt, model, skills, or tools, then save the preset."],
      ["Shape the handoffs", "Add or remove steps. Use the order buttons or connect an output port to a later input port."],
      ["Run, approve, and inspect", "Run the demo, approve the coder, and inspect conversations, tool activity, handoffs, and artifacts."],
    ];
    showModal("Take your team for a spin", `<p>A working interaction prototype. AI responses, account checks, code changes, and QA results are scripted examples.</p><div class="tour-list">${steps.map(([title, description], index) => `<div class="tour-step"><span>0${index + 1}</span><div><strong>${title}</strong><p>${description}</p></div></div>`).join("")}</div>`, button("close-modal", "Explore the studio", "arrow", "primary"));
  }

  function startRun() {
    if (engine.isActive()) {
      ui.view = "workflow"; ui.tab = "session"; ui.historyId = null;
      ui.step = Math.min(state.run.index, state.run.steps.length - 1); ui.followRun = true;
      render(); return;
    }
    if (!state.workflow.length) return toast("Add at least one agent to the workflow first.");
    if (!state.brief.trim()) return toast("Add a task brief before running the demo.");
    const agents = state.workflow.map(id => state.agents.find(agent => agent.id === id));
    const missing = agents.find(agent => !state.connections.some(connection => connection.provider === agent.provider && connection.auth === agent.auth && connection.connected));
    if (missing) {
      ui.view = "connections"; render();
      toast(`${missing.name} needs a ${providerName(missing.provider)} / ${authName(missing.auth)} demo connection.`);
      return;
    }
    if (state.run) state.history = [structuredClone(state.run), ...state.history].slice(0, 9);
    ui.view = "workflow"; ui.tab = "session"; ui.historyId = null; ui.step = 0; ui.followRun = true; ui.sessionTab = "conversation";
    engine.start({ id: `demo-${String(state.nextRun++).padStart(3, "0")}`, brief: state.brief, agents, approvalRequired: state.approvalRequired });
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

  document.addEventListener("click", event => {
    const target = event.target.closest("[data-action]");
    if (!target || target.disabled) return;
    const action = target.dataset.action;
    const id = target.dataset.id;
    if (action === "navigate") { ui.view = target.dataset.view; ui.historyId = null; render(); }
    else if (action === "tab") { ui.tab = target.dataset.tab; render(); }
    else if (action === "select-agent") { ui.selected = id; render(); }
    else if (action === "help") helpModal();
    else if (action === "close-modal") closeModal();
    else if (action === "run") startRun();
    else if (action === "pause") engine.pause();
    else if (action === "resume") engine.resume();
    else if (action === "approve") engine.approve();
    else if (action === "cancel") engine.cancel();
    else if (action === "live-session") { ui.view = "workflow"; ui.tab = "session"; ui.historyId = null; ui.followRun = true; ui.step = Math.min(state.run?.index || 0, (state.run?.steps.length || 1) - 1); render(); }
    else if (action === "run-step") { ui.step = Number(target.dataset.index); ui.followRun = false; render(); }
    else if (action === "session-tab") { ui.sessionTab = target.dataset.tab; render(); }
    else if (action === "skill") target.setAttribute("aria-pressed", target.getAttribute("aria-pressed") !== "true");
    else if (["zoom-in", "zoom-out", "fit"].includes(action)) {
      const scale = Number.parseInt(document.querySelector(".zoom-value").textContent, 10) / 100;
      ui.zoom = action === "fit" ? null : Math.max(.3, Math.min(1.5, scale + (action === "zoom-in" ? .1 : -.1)));
      sizeCanvas();
    }
    else if (["move-up", "move-down"].includes(action)) {
      if (engine.isActive()) return;
      const index = state.workflow.indexOf(ui.selected);
      const destination = index + (action === "move-up" ? -1 : 1);
      if (destination < 0 || destination >= state.workflow.length) return;
      [state.workflow[index], state.workflow[destination]] = [state.workflow[destination], state.workflow[index]];
      persist(); render(); toast("Step order saved. Handoffs now follow the new sequence.");
    }
    else if (action === "remove-step") {
      if (engine.isActive()) return;
      state.workflow = state.workflow.filter(item => item !== ui.selected);
      ui.selected = state.workflow[0] || state.agents[0].id;
      ui.linkFrom = null; persist(); render(); toast("Step removed. Its preset is still in your agent library.");
    }
    else if (action === "connect-from") { if (engine.isActive()) return; ui.linkFrom = id; render(); toast("Select a later step's input port. This prototype keeps one sequential chain."); }
    else if (action === "connect-to") {
      if (engine.isActive()) return;
      if (!ui.linkFrom) return toast("Select an output port first.");
      const from = state.workflow.indexOf(ui.linkFrom);
      const to = state.workflow.indexOf(id);
      if (to <= from) { toast("Backward links would create a cycle. Choose a later step."); return; }
      state.workflow.splice(to, 1); state.workflow.splice(from + 1, 0, id);
      ui.linkFrom = null; persist(); render(); toast("Connection saved. The remaining steps follow in sequence.");
    }
    else if (action === "library") libraryModal();
    else if (action === "new-agent") newAgentModal();
    else if (action === "edit-agent") {
      const agent = state.agents.find(item => item.id === id);
      showModal(`Edit ${escape(agent.name)}`, agentForm(agent, true));
    }
    else if (action === "add-existing") {
      if (engine.isActive()) return toast("Finish or cancel the active run before editing the workflow.");
      if (state.workflow.length >= 12) return toast("This prototype supports up to 12 steps in a workflow.");
      if (!state.workflow.includes(id)) state.workflow.push(id);
      ui.selected = id; ui.zoom = null; ui.view = "workflow"; ui.tab = "builder";
      closeModal(); persist(); render(); toast("Agent added to the workflow.");
    }
    else if (action === "connect") connectionModal();
    else if (action === "auth-mode") { ui.connectAuth = target.dataset.auth; connectionModal(); }
    else if (action === "simulate-connect") {
      target.disabled = true; target.innerHTML = icon("loader", "spinning") + "Checking demo runtime...";
      const provider = ui.connectProvider, auth = ui.connectAuth;
      connectionTimer = setTimeout(() => {
        const connectionId = `${provider}-${auth}`;
        const existing = state.connections.find(connection => connection.id === connectionId);
        if (existing) existing.connected = true;
        else state.connections.push({ id: connectionId, provider, auth, connected: true });
        persist(); closeModal(); render(); toast("Demo connection ready. No account was contacted.");
      }, 850);
    }
    else if (action === "toggle-connection") {
      const connection = state.connections.find(item => item.id === id);
      connection.connected = !connection.connected; persist(); render();
      toast(connection.connected ? "Demo connection restored." : "Demo disconnected. Existing CLI accounts are unaffected.");
    }
    else if (action === "test-connection") toast("Simulated connection check passed. No account was contacted.");
    else if (action === "toggle-approval") { state.approvalRequired = !state.approvalRequired; persist(); render(); toast("Default saved for the next run."); }
    else if (action === "open-run") {
      ui.historyId = state.run?.id === id ? null : id;
      ui.view = "workflow"; ui.tab = "session"; ui.step = 0; ui.followRun = false; render();
    }
    else if (action === "artifact") {
      const artifact = findArtifact(id);
      if (artifact) showModal(escape(artifact.name), `<p>${escape(artifact.agent)} / ${escape(artifact.type)} / simulated artifact</p><pre>${escape(artifact.content)}</pre>`, button("download-artifact", "Download sample", "download", "primary", `data-id="${escape(id)}"`), true, "Run evidence");
    }
    else if (action === "download-artifact") { const artifact = findArtifact(id); if (artifact) download(artifact.name, artifact.content); }
    else if (action === "export") download("agent-studio-demo-workflow.json", JSON.stringify({ prototype: true, name: "Feature delivery", workflow: state.workflow, agents: state.agents.filter(agent => state.workflow.includes(agent.id)), brief: state.brief, approvalRequired: state.approvalRequired }, null, 2), "application/json");
    else if (action === "reset") showModal("Reset this demo?", "<p>This removes the prototype's presets, demo connections, and saved runs from this browser. Your repositories and real AI accounts are untouched.</p>", button("close-modal", "Keep my demo", "") + button("confirm-reset", "Reset demo", "reset", "primary"));
    else if (action === "confirm-reset") {
      engine.dispose(); state = initialState();
      engine = new DemoEngine(onRunChange);
      ui.view = "workflow"; ui.tab = "builder"; ui.selected = "planner"; ui.historyId = null; ui.linkFrom = null; ui.zoom = null;
      persist(); closeModal(); render(); toast("A fresh studio is ready.");
    }
  });

  document.addEventListener("submit", event => {
    const form = event.target;
    if (!form.matches("[data-form]")) return;
    event.preventDefault();
    const values = new FormData(form);
    if (form.dataset.form === "agent") {
      const agent = state.agents.find(item => item.id === form.dataset.id);
      const name = values.get("name").trim();
      const prompt = values.get("prompt").trim();
      if (!name || !prompt) return toast("Add a name and instructions before saving.");
      const [provider, auth] = values.get("connection").split("|");
      Object.assign(agent, { name, prompt, provider, auth, model: values.get("model"), tools: values.getAll("tools"), skills: [...form.querySelectorAll('.skill-chip[aria-pressed="true"]')].map(chip => chip.dataset.skill) });
      persist(); if (modal.open) closeModal(); render(); toast(engine.isActive() ? "Preset saved. The active run keeps its original settings." : "Preset saved. Your next run will use these settings.");
    }
    else if (form.dataset.form === "new-agent") {
      const name = values.get("name").trim();
      if (!name) return toast("Give your agent a name.");
      const role = values.get("role");
      const template = initialState().agents.find(agent => agent.role === role);
      const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      state.agents.push({ ...template, id, name, prompt: prompts[role] });
      const added = !engine.isActive() && state.workflow.length < 12;
      if (added) state.workflow.push(id);
      ui.selected = id; ui.view = added ? "workflow" : "agents"; ui.tab = "builder"; ui.zoom = null;
      persist(); closeModal(); render(); toast(added ? "Agent created and added. Tune its instructions in the side panel." : "Preset created in your library. Add it after the current run.");
    }
  });

  document.addEventListener("change", event => {
    if (event.target.id === "agent-connection") {
      const provider = event.target.value.split("|")[0];
      event.target.closest("form").querySelector('[name="model"]').innerHTML = models[provider].map(model => `<option>${model}</option>`).join("");
    }
    if (event.target.id === "connection-provider") { ui.connectProvider = event.target.value; connectionModal(); }
  });
  document.addEventListener("input", event => {
    if (event.target.id === "task-brief") { state.brief = event.target.value; persist(); }
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && ui.linkFrom) { ui.linkFrom = null; render(); }
  });
  modal.addEventListener("cancel", () => clearTimeout(connectionTimer));
  modal.addEventListener("click", event => { if (event.target === modal && (event.clientX < modal.getBoundingClientRect().left || event.clientX > modal.getBoundingClientRect().right || event.clientY < modal.getBoundingClientRect().top || event.clientY > modal.getBoundingClientRect().bottom)) closeModal(); });
  window.addEventListener("pagehide", () => { persist(); engine.dispose(); });
  window.addEventListener("pageshow", event => { if (event.persisted) engine.pause(); });
  render();
})();
