import { Marked } from "marked";
import DOMPurify from "dompurify";
import { t } from "./i18n.js";

export function isMarkdown(artifact) {
  return /\.(md|markdown)$/i.test(artifact.name) || artifact.mime?.split(";")[0] === "text/markdown";
}

export function renderMarkdown(content) {
  const diagrams = new Map();
  const parser = new Marked({ gfm: true, renderer: { code(token) {
    if (token.lang?.trim().toLowerCase() !== "mermaid") return false;
    const marker = crypto.randomUUID();
    diagrams.set(marker, token.text);
    return `<pre><code>${marker}</code></pre>`;
  } } });
  const document = DOMPurify.sanitize(parser.parse(content, { async: false }), {
    ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "del", "blockquote", "ul", "ol", "li", "pre", "code", "a", "table", "thead", "tbody", "tr", "th", "td", "input"],
    ALLOWED_ATTR: ["href", "title", "start", "type", "checked", "disabled"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM: true,
  });
  for (const link of document.querySelectorAll("a")) {
    if (/^(https?:\/\/|mailto:)/i.test(link.getAttribute("href") || "")) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    } else link.removeAttribute("href");
  }
  for (const input of document.querySelectorAll("input")) {
    if (input.getAttribute("type") !== "checkbox") input.remove();
    else input.disabled = true;
  }
  for (const table of document.querySelectorAll("table")) table.tabIndex = 0;
  for (const code of document.querySelectorAll("pre > code")) {
    const source = diagrams.get(code.textContent);
    if (source === undefined) continue;
    const figure = window.document.createElement("figure");
    figure.className = "mermaid-diagram";
    const caption = window.document.createElement("figcaption");
    caption.textContent = t("Mermaid diagram");
    const output = window.document.createElement("div");
    output.className = "mermaid-output";
    output.setAttribute("aria-busy", "true");
    const status = window.document.createElement("p");
    status.className = "mermaid-status";
    status.textContent = t("Drawing diagram...");
    const details = window.document.createElement("details");
    const summary = window.document.createElement("summary");
    summary.textContent = t("Diagram source");
    code.textContent = source;
    const pre = code.parentElement;
    pre.replaceWith(figure);
    details.append(summary, pre);
    figure.append(caption, output, status, details);
  }
  return `<div class="markdown-body">${document.innerHTML}</div>`;
}

let mermaid;
const diagramCache = new Map();

function diagramImage(source) {
  if (diagramCache.has(source)) return diagramCache.get(source);
  const image = (async () => {
    // Diagram configuration must not override the application's security settings.
    if (source.length > 16000 || /%%\s*\{|^\s*---/m.test(source)) throw new Error("Unsupported diagram configuration or size");
    mermaid ||= import("mermaid").then(({ default: api }) => {
      api.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, htmlLabels: false, maxTextSize: 16000, maxEdges: 200, layout: "dagre", fontFamily: "sans-serif" });
      return api;
    });
    const api = await mermaid;
    const host = document.createElement("div");
    host.className = "mermaid-render-host";
    host.setAttribute("aria-hidden", "true");
    document.body.append(host);
    try {
      const { svg } = await api.render(`diagram-${crypto.randomUUID()}`, source, host);
      const safe = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["foreignObject", "a", "image"], FORBID_ATTR: ["href", "xlink:href"], ALLOW_DATA_ATTR: false });
      const drawing = new DOMParser().parseFromString(safe, "image/svg+xml").documentElement;
      const [, , width, height] = (drawing.getAttribute("viewBox") || "").split(/\s+/).map(Number);
      if (!(width > 0 && height > 0 && Number.isFinite(width + height))) throw new Error("Invalid diagram dimensions");
      drawing.setAttribute("width", String(width));
      drawing.setAttribute("height", String(height));
      // An image keeps SVG styles and events outside the application's DOM.
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(drawing))}`;
    } finally { host.remove(); }
  })().catch(() => null);
  diagramCache.set(source, image);
  if (diagramCache.size > 32) {
    const oldest = diagramCache.keys().next().value;
    diagramCache.delete(oldest);
  }
  return image;
}

export function renderDiagrams(root) {
  for (const figure of root.querySelectorAll('.mermaid-diagram:not([data-rendered])')) {
    figure.dataset.rendered = "true";
    const source = figure.querySelector("code").textContent;
    diagramImage(source).then(url => {
      if (!figure.isConnected) return;
      const output = figure.querySelector(".mermaid-output"), status = figure.querySelector(".mermaid-status");
      output.removeAttribute("aria-busy");
      if (url) {
        const image = document.createElement("img");
        image.alt = t("Mermaid diagram"); image.src = url;
        output.append(image); status.remove();
      } else {
        status.textContent = t("Diagram unavailable. Read the source below.");
        figure.querySelector("details").open = true;
      }
    });
  }
}
