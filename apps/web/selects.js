const controls = new WeakMap();
let openControl;
let nextId = 0;

export function closeSelects(root = document) {
  if (openControl && root.contains(openControl.button)) openControl.close();
}

export function enhanceSelects(root) {
  for (const select of root.querySelectorAll("select:not([multiple])")) {
    if (select.size > 1) continue;
    if (!controls.has(select)) controls.set(select, createSelect(select));
    controls.get(select).sync();
  }
}

function createSelect(select) {
  const id = select.id || `studio-select-${++nextId}`;
  const labels = [...select.labels];
  const wrapper = document.createElement("div");
  wrapper.className = "studio-select";
  const button = document.createElement("button");
  button.type = "button";
  button.id = `${id}-control`;
  button.className = "select-trigger";
  button.setAttribute("role", "combobox");
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = '<span class="select-value"></span><svg class="select-chevron" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 7.5 5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const value = button.firstElementChild;
  const menu = document.createElement("div");
  menu.id = `${id}-options`;
  menu.className = "select-menu";
  menu.popover = "auto";
  menu.setAttribute("role", "listbox");
  button.setAttribute("aria-controls", menu.id);
  button.setAttribute("popovertarget", menu.id);
  if (labels.length) {
    const labelledBy = labels.map((label, index) => {
      label.id ||= `${id}-label-${index}`;
      label.htmlFor = button.id;
      return label.id;
    }).join(" ");
    button.setAttribute("aria-labelledby", labelledBy);
    menu.setAttribute("aria-labelledby", labelledBy);
  } else {
    const label = select.getAttribute("aria-label") || select.name;
    button.setAttribute("aria-label", label);
    menu.setAttribute("aria-label", label);
  }
  const description = select.getAttribute("aria-describedby");
  if (description) button.setAttribute("aria-describedby", description);
  select.before(wrapper);
  wrapper.append(select, button, menu);
  // Retain native form values and change events without opening an OS menu.
  select.hidden = true;
  let activeIndex = -1;
  let search = "", searchedAt = 0;
  const enabled = () => [...select.options].map((option, index) => ({ option, index })).filter(({ option }) => !option.disabled && !option.hidden && !option.closest("optgroup[disabled]"));
  const isOpen = () => menu.matches(":popover-open");

  function sync() {
    value.textContent = select.selectedOptions[0]?.label || "Choose an option";
    button.title = value.textContent;
    button.disabled = select.matches(":disabled") || !enabled().length;
    button.setAttribute("aria-required", String(select.required));
    menu.replaceChildren(...[...select.options].map((option, index) => {
      const item = document.createElement("div");
      item.id = `${id}-option-${index}`;
      item.className = "select-option";
      item.dataset.index = String(index);
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.selected));
      item.setAttribute("aria-disabled", String(option.disabled || !!option.closest("optgroup[disabled]")));
      item.hidden = option.hidden;
      item.textContent = option.label;
      return item;
    }));
  }

  function activate(index, scroll = true) {
    if (!enabled().some(item => item.index === index)) return;
    activeIndex = index;
    for (const item of menu.children) item.classList.toggle("active", Number(item.dataset.index) === index);
    const item = menu.children[index];
    button.setAttribute("aria-activedescendant", item.id);
    if (scroll) {
      if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop;
      else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight;
    }
  }

  function position() {
    const rect = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftEdge = (viewport?.offsetLeft || 0) + 12, topEdge = (viewport?.offsetTop || 0) + 12;
    const rightEdge = leftEdge + (viewport?.width || innerWidth) - 24;
    const bottomEdge = topEdge + (viewport?.height || innerHeight) - 24;
    if (!button.isConnected || !rect.height || rect.bottom < topEdge || rect.top > bottomEdge) { close(); return; }
    const width = Math.min(rect.width, rightEdge - leftEdge);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(leftEdge, Math.min(rect.left, rightEdge - width))}px`;
    const below = bottomEdge - rect.bottom - 8, above = rect.top - topEdge - 8;
    const upward = below < Math.min(320, menu.scrollHeight) && above > below;
    menu.style.maxHeight = `${Math.max(0, Math.min(320, upward ? above : below))}px`;
    menu.style.top = `${upward ? rect.top - menu.getBoundingClientRect().height - 8 : rect.bottom + 8}px`;
  }

  function open() {
    sync();
    if (button.disabled) return;
    closeSelects();
    menu.showPopover();
    openControl = control;
    button.setAttribute("aria-expanded", "true");
    position();
    activate(enabled().some(item => item.index === select.selectedIndex) ? select.selectedIndex : enabled()[0].index);
  }

  function close() {
    if (isOpen()) menu.hidePopover();
  }

  function commit(index) {
    if (!enabled().some(item => item.index === index)) return;
    const changed = select.selectedIndex !== index;
    select.selectedIndex = index;
    close();
    sync();
    button.focus({ preventScroll: true });
    if (changed) {
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  button.addEventListener("click", event => { event.preventDefault(); isOpen() ? close() : open(); });
  button.addEventListener("keydown", event => {
    if (event.key === "Escape" && isOpen()) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === "Tab") { if (isOpen()) commit(activeIndex); return; }
    if (event.ctrlKey || event.metaKey) return;
    if (["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const wasOpen = isOpen();
      if (!wasOpen) open();
      const options = enabled();
      if (!options.length) return;
      const current = options.findIndex(item => item.index === activeIndex);
      if (["Enter", " "].includes(event.key)) { if (wasOpen) commit(activeIndex); }
      else if (event.key === "Home") activate(options[0].index);
      else if (event.key === "End") activate(options.at(-1).index);
      else if (wasOpen) activate(options[Math.max(0, Math.min(options.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)))].index);
    } else if (event.key.length === 1 && !event.altKey) {
      event.preventDefault();
      if (!isOpen()) open();
      const now = Date.now();
      search = now - searchedAt > 700 ? event.key : search + event.key;
      searchedAt = now;
      const term = [...search].every(letter => letter === search[0]) ? search[0] : search;
      const options = enabled(), current = options.findIndex(item => item.index === activeIndex);
      const ordered = term.length === 1 ? [...options.slice(current + 1), ...options.slice(0, current + 1)] : options;
      const match = ordered.find(({ option }) => option.label.toLocaleLowerCase().startsWith(term.toLocaleLowerCase()));
      if (match) activate(match.index);
    }
  });
  menu.addEventListener("pointerdown", event => event.preventDefault());
  menu.addEventListener("pointermove", event => {
    const item = event.target.closest(".select-option");
    if (item) activate(Number(item.dataset.index), false);
  });
  menu.addEventListener("click", event => {
    const item = event.target.closest(".select-option");
    if (item) commit(Number(item.dataset.index));
  });
  menu.addEventListener("beforetoggle", event => {
    if (event.newState === "closed") {
      button.setAttribute("aria-expanded", "false");
      button.removeAttribute("aria-activedescendant");
      search = "";
      if (openControl === control) openControl = null;
    }
  });
  select.addEventListener("change", sync);
  select.addEventListener("invalid", event => { event.preventDefault(); button.focus(); });
  const control = { button, menu, sync, close, position };
  return control;
}

window.addEventListener("resize", () => openControl?.position());
window.addEventListener("scroll", event => {
  if (openControl && !openControl.menu.contains(event.target)) openControl.position();
}, true);
window.visualViewport?.addEventListener("resize", () => openControl?.position());
window.visualViewport?.addEventListener("scroll", () => openControl?.position());
