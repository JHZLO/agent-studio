import { marked } from "marked";
import DOMPurify from "dompurify";

export function isMarkdown(artifact) {
  return /\.(md|markdown)$/i.test(artifact.name) || artifact.mime?.split(";")[0] === "text/markdown";
}

export function renderMarkdown(content) {
  const document = DOMPurify.sanitize(marked.parse(content, { gfm: true, async: false }), {
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
  return `<div class="markdown-body">${document.innerHTML}</div>`;
}
