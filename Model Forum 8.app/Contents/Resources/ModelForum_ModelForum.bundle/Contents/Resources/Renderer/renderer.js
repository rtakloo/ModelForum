/* Offline message rendering. All dependencies are pinned and shipped beside this file. */
(() => {
  "use strict";
  const MAX_INPUT = 200000;
  const MAX_MATH = 10000;
  const MAX_HEIGHT = 10000;
  const MAX_FORMULAS = 500;
  const root = document.getElementById("message");
  let formulas = 0;
  let framePending = false;
  let lastHeight = -1;
  let lastScrollState = "";

  const escapeHTML = text => String(text).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  function safeURL(value) {
    try {
      const url = new URL(value);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
      return url.href;
    } catch { return null; }
  }

  function post(message) {
    try { window.webkit?.messageHandlers?.renderer?.postMessage(message); } catch { /* Native bridge is optional in tests. */ }
  }

  function scheduleHeight() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      const height = Math.max(22, Math.min(MAX_HEIGHT, Math.ceil(root.getBoundingClientRect().height)));
      if (height !== lastHeight) { lastHeight = height; post({ type: "height", height }); }
      const nonnegative = value => Number.isFinite(value) ? Math.max(0, value) : 0;
      const scrollHeight = nonnegative(root.scrollHeight);
      const clientHeight = nonnegative(root.clientHeight);
      const scrollTop = Math.min(nonnegative(root.scrollTop), Math.max(0, scrollHeight - clientHeight));
      const state = { type: "scrollState", scrollTop, scrollHeight, clientHeight };
      const signature = JSON.stringify(state);
      if (signature !== lastScrollState) { lastScrollState = signature; post(state); }
    });
  }

  function containingFormula(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const inline = element?.closest(".katex");
    return inline?.closest(".katex-display") || inline || element?.closest(".katex-display");
  }

  function selectsFormulaContent(range, formula) {
    if (!formula || !root.contains(formula) || !range.intersectsNode(formula)) return false;
    const contents = document.createRange();
    contents.selectNodeContents(formula);
    const overlap = range.cloneRange();
    if (overlap.compareBoundaryPoints(Range.START_TO_START, contents) < 0) overlap.setStart(contents.startContainer, contents.startOffset);
    if (overlap.compareBoundaryPoints(Range.END_TO_END, contents) > 0) overlap.setEnd(contents.endContainer, contents.endOffset);
    return !overlap.collapsed && (overlap.toString().length > 0 || !!overlap.cloneContents().querySelector("svg"));
  }

  // Detached fragments have no rendered innerText. Preserve semantic line breaks explicitly,
  // while leaving code whitespace and the original TeX annotation untouched.
  function selectionText(fragment) {
    let output = "";
    let pendingBreaks = 0;
    const lineBreak = count => { pendingBreaks = Math.max(pendingBreaks, count); };
    const append = (text, verbatim = false) => {
      if (!verbatim) text = text.replace(/[\t\r\n\f ]+/g, " ");
      if (!text || (!verbatim && pendingBreaks && !text.trim())) return;
      if (output && pendingBreaks) {
        const existing = /\n*$/.exec(output)[0].length;
        output += "\n".repeat(Math.max(0, pendingBreaks - existing));
      }
      pendingBreaks = 0;
      output += text;
    };
    function visit(node) {
      if (node.nodeType === Node.TEXT_NODE) { append(node.nodeValue); return; }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      const tag = node.nodeName;
      if (node.nodeType === Node.ELEMENT_NODE && node.hasAttribute("data-copy-tex")) {
        const display = node.hasAttribute("data-copy-display");
        if (display) lineBreak(2);
        append(node.textContent, true);
        if (display) lineBreak(2);
        return;
      }
      if (tag === "BR") { lineBreak(1); return; }
      if (tag === "PRE") { lineBreak(2); append(node.textContent, true); lineBreak(2); return; }
      if (tag === "CODE") { append(node.textContent, true); return; }
      const block = /^(P|H[1-6]|BLOCKQUOTE|DIV|UL|OL|TABLE)$/.test(tag);
      if (block) lineBreak(2);
      if (tag === "LI" || tag === "TR") lineBreak(1);
      if (tag === "LI" && node.hasAttribute("data-copy-list-marker")) append(node.getAttribute("data-copy-list-marker"), true);
      const children = Array.from(node.childNodes);
      for (const child of children) {
        if (/^(TABLE|THEAD|TBODY|TFOOT|TR)$/.test(tag) && child.nodeType === Node.TEXT_NODE && !child.nodeValue.trim()) continue;
        if ((child.nodeName === "TD" || child.nodeName === "TH") && child.previousElementSibling) append("\t", true);
        visit(child);
      }
      if (tag === "LI" || tag === "TR") lineBreak(1);
      if (block) lineBreak(2);
    }
    visit(fragment);
    return output;
  }

  document.addEventListener("copy", event => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount || !event.clipboardData) return;
    const fragments = [];
    let hasMath = false;
    for (let index = 0; index < selection.rangeCount; index++) {
      // Never mutate the live range: copying must not change the user's visible selection.
      const range = selection.getRangeAt(index).cloneRange();
      if (!range.intersectsNode(root)) return;
      const start = containingFormula(range.startContainer);
      const end = containingFormula(range.endContainer);
      if (selectsFormulaContent(range, start)) range.setStartBefore(start);
      if (selectsFormulaContent(range, end)) range.setEndAfter(end);
      const fragment = range.cloneContents();
      for (const formula of fragment.querySelectorAll(".katex")) {
        const annotation = formula.querySelector('annotation[encoding="application/x-tex"]');
        if (!annotation) continue;
        const display = !!formula.closest(".katex-display");
        const replacement = document.createElement("span");
        replacement.setAttribute("data-copy-tex", "");
        if (display) replacement.setAttribute("data-copy-display", "");
        replacement.textContent = display ? "\\[" + annotation.textContent + "\\]" : "\\(" + annotation.textContent + "\\)";
        formula.replaceWith(replacement);
        hasMath = true;
      }
      fragments.push(fragment);
    }
    if (!hasMath) return; // Ordinary prose/code selections retain the browser's normal clipboard formats.
    try {
      const text = fragments.map(selectionText).join("\n");
      event.clipboardData.clearData();
      event.clipboardData.setData("text/plain", text);
      // No text/html entry: rich paste targets must also receive LaTeX rather than visual spans.
      event.preventDefault();
    } catch { /* If clipboard writes are unavailable, allow the platform's ordinary copy behavior. */ }
  });

  function isEscaped(source, position) {
    let count = 0;
    while (position > 0 && source[--position] === "\\") count++;
    return count % 2 === 1;
  }

  // Extensions run only where Marked is tokenizing ordinary text. Fenced and inline code
  // tokens consume their contents first and are never scanned for delimiters afterward.
  function mathAtStart(source) {
    let opening, closing, display;
    if (source.startsWith("\\(")) { opening = "\\("; closing = "\\)"; display = false; }
    else if (source.startsWith("\\[")) { opening = "\\["; closing = "\\]"; display = true; }
    else if (source.startsWith("$$")) { opening = "$$"; closing = "$$"; display = true; }
    else if (source[0] === "$" && source[1] && !/\s/.test(source[1])) { opening = "$"; closing = "$"; display = false; }
    else return;
    let position = opening.length;
    // The search is bounded independently of the overall Markdown limit.
    const search = source.slice(0, MAX_MATH + opening.length + closing.length + 1);
    while ((position = search.indexOf(closing, position)) !== -1) {
      if (isEscaped(search, position)) { position += closing.length; continue; }
      if (opening === "$" && (/\s/.test(search[position - 1]) || /[\d$]/.test(search[position + 1] || ""))) { position++; continue; }
      const text = search.slice(opening.length, position);
      if (!text.trim() || (!display && text.includes("\n"))) return;
      return { raw: source.slice(0, position + closing.length), text, display };
    }
  }

  function mathHTML(text, display) {
    formulas++;
    if (text.length > MAX_MATH || formulas > MAX_FORMULAS) {
      return `<span class="math-limit">Formula rendering limit reached: <code>${escapeHTML(text)}</code></span>`;
    }
    try {
      const html = katex.renderToString(text, {
        displayMode: display, throwOnError: false, trust: false, strict: "ignore",
        maxExpand: 1000, maxSize: 20, output: "htmlAndMathml", macros: {}
      });
      return display ? `<span class="math-display">${html}</span>` : html;
    } catch {
      return `<code class="math-limit">${escapeHTML(text)}</code>`;
    }
  }

  function isFormulaFence(token) {
    // Only an explicit math fence opts into typesetting. LaTeX/TeX files and examples stay code.
    if ((token.lang || "").trim().toLowerCase() !== "math") return false;
    return !/\\(?:documentclass\b|usepackage\b|begin\s*\{document\}|end\s*\{document\})/i.test(token.text);
  }

  const parser = new marked.Marked({ gfm: true, breaks: false, async: false });
  parser.use({
    extensions: [
      {
        name: "displayMath", level: "block",
        start(source) { const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source); return match?.index; },
        tokenizer(source) {
          const indent = /^ {0,3}/.exec(source)[0];
          const match = mathAtStart(source.slice(indent.length));
          if (!match?.display) return;
          const remainder = source.slice(indent.length + match.raw.length);
          if (!/^(?:[ \t]*\n|[ \t]*$)/.test(remainder)) return;
          const tail = /^[ \t]*(?:\n|$)/.exec(remainder)[0];
          return { type: "displayMath", ...match, raw: indent + match.raw + tail };
        },
        renderer(token) { return mathHTML(token.text, true) + "\n"; }
      },
      {
        name: "inlineMath", level: "inline",
        start(source) { const match = /\$|\\[([]/.exec(source); return match?.index; },
        tokenizer(source) { const match = mathAtStart(source); if (match) return { type: "inlineMath", ...match }; },
        renderer(token) { return mathHTML(token.text, token.display); }
      }
    ],
    renderer: {
      // Raw HTML is displayed as text. This prevents user-authored CSS/attributes from being
      // confused with KaTeX's trusted generated layout when final HTML is sanitized below.
      html(token) { return escapeHTML(token.text); },
      code(token) { if (isFormulaFence(token)) return mathHTML(token.text, true) + "\n"; return false; },
      image(token) { return `<span class="image-placeholder">Image: ${escapeHTML(token.text || "image omitted")}</span>`; },
      link(token) {
        const label = this.parser.parseInline(token.tokens);
        const url = safeURL(token.href);
        return url ? `<a href="${escapeHTML(url)}" rel="noopener noreferrer">${label}</a>` : label;
      }
    }
  });

  function showSource(text, notice) {
    root.replaceChildren();
    const message = document.createElement("p");
    message.className = "render-notice";
    message.textContent = notice;
    const source = document.createElement("pre");
    source.className = "source-fallback";
    source.textContent = text;
    root.append(message, source);
  }

  window.renderMessage = text => {
    if (typeof text !== "string") throw new TypeError("renderMessage requires a string");
    formulas = 0;
    let mode = "rich";
    if (text.length > MAX_INPUT) {
      showSource(text, "This message exceeds the rich-rendering limit. The complete source is shown below.");
      mode = "source";
    } else {
      try {
        const html = parser.parse(text);
        root.innerHTML = DOMPurify.sanitize(html, {
          USE_PROFILES: { html: true, svg: true, mathMl: true },
          // KaTeX's plain-text source annotation supports accessible math and LaTeX copying.
          ADD_TAGS: ["semantics", "annotation"], ADD_ATTR: ["encoding"],
          FORBID_TAGS: ["script", "style", "iframe", "frame", "object", "embed", "img", "video", "audio", "source", "link", "meta", "base", "form", "input", "button", "textarea", "select"],
          FORBID_ATTR: ["src", "srcset", "xlink:href"],
          ALLOW_DATA_ATTR: false
        });
        for (const anchor of root.querySelectorAll("a")) {
          const url = safeURL(anchor.getAttribute("href"));
          if (url) { anchor.setAttribute("href", url); anchor.setAttribute("rel", "noopener noreferrer"); }
          else anchor.replaceWith(...anchor.childNodes);
        }
        // Capture live list numbering before a selection clone drops preceding siblings or the
        // enclosing list. These generated attributes affect copy only, not displayed content.
        for (const list of root.querySelectorAll("ol, ul")) {
          const parsedStart = Number.parseInt(list.getAttribute("start") || "1", 10);
          const start = Number.isFinite(parsedStart) ? parsedStart : 1;
          Array.from(list.children).filter(child => child.tagName === "LI").forEach((item, index) => {
            item.setAttribute("data-copy-list-marker", list.tagName === "OL" ? `${start + index}. ` : "- ");
          });
        }
      } catch {
        showSource(text, "Formatting could not be displayed. The complete source is shown below.");
        mode = "source";
      }
    }
    root.scrollTop = 0;
    lastScrollState = ""; // Native resets its routing state for every replaced message.
    scheduleHeight();
    return { mode, characters: text.length, truncated: false };
  };

  if (typeof ResizeObserver !== "undefined") new ResizeObserver(scheduleHeight).observe(root);
  root.addEventListener("scroll", scheduleHeight, { passive: true });
  window.addEventListener("resize", scheduleHeight);
  if (document.fonts?.ready) document.fonts.ready.then(scheduleHeight);
  document.fonts?.addEventListener?.("loadingdone", scheduleHeight);
  function ready() { post({ type: "ready" }); scheduleHeight(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
})();
