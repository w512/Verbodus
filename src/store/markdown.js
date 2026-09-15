// Markdown rendering for LLM responses, with syntax highlighting for fenced
// code blocks. We use highlight.js's "common" subset (~35 languages: js, ts,
// python, rust, sql, bash, json, yaml, html, css, …) to keep bundle size
// reasonable; rarer languages render as plain text.
//
// Security: LLM output is *not* trustworthy markdown. `marked` does NOT strip
// embedded HTML by default (the `sanitize` option was removed in v0.7), so a
// response like `<img src=x onerror=…>` or `<script>…</script>` would otherwise
// reach v-html as-is. We pipe the parser output through DOMPurify, which keeps
// safe markup (tables, formatting, our hljs spans) and removes everything that
// could execute JS. Output of `highlight.js` is already HTML-escaped by the
// library — DOMPurify just acts as the second belt.

import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";

// Minimal HTML escape — used as the last-resort fallback inside the highlight
// callback. `highlight.js` itself escapes its output, but if we ever take the
// catch path we must still hand back something safe (otherwise raw code with
// `<script>` could land verbatim inside `<pre><code>`).
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const marked = new Marked(
  markedHighlight({
    emptyLangClass: "hljs",
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : null;
      try {
        return language
          ? hljs.highlight(code, { language, ignoreIllegals: true }).value
          : hljs.highlightAuto(code).value;
      } catch {
        return escapeHtml(code); // never break the render, never emit raw HTML
      }
    },
  })
);

marked.setOptions({
  gfm: true,        // tables, strikethrough, task lists
  breaks: false,    // a single newline does NOT become <br> — matches typical LLM output
});

export function renderMarkdown(text) {
  if (!text) return "";
  const dirty = marked.parse(text);
  // ADD_ATTR keeps highlight.js's class names intact (DOMPurify allows `class`
  // by default; listed for clarity). Links open in same tab — Tauri has no real
  // address bar and we don't want `target="_blank"` opening system browsers
  // implicitly.
  return DOMPurify.sanitize(dirty, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["class"],
  });
}
