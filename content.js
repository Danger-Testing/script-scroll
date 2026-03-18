// ============================================================
// Script Scroll — Content Script
// ============================================================

(() => {
  const VERSION = "3.0.0";
  let enabled = false;
  let scriptLines = []; // [{ pageNum, text, norm, el }]
  let captionObserver = null;
  let lastCaption = "";
  let lastMatchIdx = 0;
  let panel = null;
  let pdfLoaded = false;
  let debugLog = null;

  // ---- Debug Logger ----
  function log(msg) {
    console.log(`[Script Scroll] ${msg}`);
    if (debugLog) {
      const line = document.createElement("div");
      line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
      debugLog.appendChild(line);
      debugLog.scrollTop = debugLog.scrollHeight;
      while (debugLog.children.length > 50) debugLog.removeChild(debugLog.firstChild);
    }
  }

  // ---- Init pdf.js ----
  let pdfjsInitialized = false;
  function getPdfJs() {
    const lib = globalThis.pdfjsLib;
    if (!lib) throw new Error("pdf.js not available in content script");
    if (!pdfjsInitialized) {
      lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.min.js");
      pdfjsInitialized = true;
    }
    return lib;
  }

  // ---- Normalization ----
  function normalize(str) {
    return str
      .replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl").replace(/ﬀ/g, "ff")
      .replace(/ﬃ/g, "ffi").replace(/ﬄ/g, "ffl").replace(/ﬅ/g, "st").replace(/ﬆ/g, "st")
      .toLowerCase()
      .replace(/[''`]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---- TODO: matching goes here ----
  function findMatch(captionNorm, startIdx) {
    return -1;
  }

  // ---- Highlight + Scroll ----
  function highlightMatch(idx) {
    if (idx < 0 || idx >= scriptLines.length) return;
    const prev = document.querySelector(".ss-anchor-active");
    if (prev) prev.classList.remove("ss-anchor-active");
    scriptLines[idx].el.classList.add("ss-anchor-active");
    scriptLines[idx].el.scrollIntoView({ behavior: "smooth", block: "center" });
    lastMatchIdx = idx;
  }

  // ---- Handle Caption ----
  function handleCaption(text) {
    if (!text || !scriptLines.length) return;
    const norm = normalize(text);
    const matchIdx = findMatch(norm, lastMatchIdx);
    if (matchIdx >= 0) {
      log(`Match line ${matchIdx}: "${scriptLines[matchIdx].text.substring(0, 60)}"`);
      highlightMatch(matchIdx);
    } else {
      log(`No match: "${text.substring(0, 50)}"`);
    }
  }

  // ---- Caption Extraction ----
  function extractLeafText(container) {
    const rawLeaves = [];
    container.querySelectorAll("span").forEach(s => {
      if (s.querySelector("span")) return;
      const t = s.textContent.trim();
      if (t) rawLeaves.push(t);
    });
    const deduped = [];
    for (const t of rawLeaves) {
      if (deduped[deduped.length - 1] !== t) deduped.push(t);
    }
    return deduped.join(" ");
  }

  function extractCaptionText() {
    const lineContainers = document.querySelectorAll(".player-timedtext-text-container");
    if (lineContainers.length > 0) {
      const lines = [];
      lineContainers.forEach(c => {
        const t = extractLeafText(c);
        if (t) lines.push(t);
      });
      return lines.join(" ");
    }
    const fallback =
      document.querySelector(".player-timedtext") ||
      document.querySelector("[data-uia='player-timedtext']") ||
      document.querySelector("[class*='subtitles']") ||
      document.querySelector("[class*='caption']") ||
      document.querySelector("[class*='cue']");
    if (!fallback) return "";
    const t = extractLeafText(fallback);
    return t || fallback.textContent.replace(/\s+/g, " ").trim();
  }

  // ---- Caption Observer ----
  function startCaptionObservers() {
    if (captionObserver) return;
    lastCaption = "";

    let debounceTimer = null;
    const processCaptions = () => {
      const text = extractCaptionText();
      if (!text || text === lastCaption) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const settled = extractCaptionText();
        if (settled && settled !== lastCaption) {
          lastCaption = settled;
          log(`Caption: "${settled}"`);
          handleCaption(settled);
        }
      }, 120);
    };

    captionObserver = new MutationObserver(processCaptions);
    const target = document.querySelector(".watch-video") || document.body;
    captionObserver.observe(target, { childList: true, subtree: true, characterData: true });
    captionObserver._pollInterval = setInterval(processCaptions, 500);
    log("Caption observer started");
  }

  function stopCaptionObservers() {
    if (captionObserver) {
      captionObserver.disconnect();
      if (captionObserver._pollInterval) clearInterval(captionObserver._pollInterval);
      captionObserver = null;
    }
  }

  // ---- Extract text lines from a PDF page ----
  function extractPageLines(textContent, viewport, pdfjsLib) {
    const items = textContent.items
      .filter(item => item.str && item.str.trim())
      .map(item => {
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
        const x = tx[4];
        const y = tx[5] - Math.abs(tx[3]);
        const height = Math.abs(tx[3]) || item.height || 12;
        return { text: item.str.trim(), x, y, height, hasEOL: !!item.hasEOL };
      })
      .sort((a, b) => Math.abs(a.y - b.y) < 3 ? a.x - b.x : a.y - b.y);

    const lines = [];
    let current = null;
    for (const item of items) {
      if (!current || Math.abs(item.y - current.y) > 3) {
        current = { y: item.y, height: item.height, parts: [item.text] };
        lines.push(current);
      } else {
        current.parts.push(item.text);
        current.height = Math.max(current.height, item.height);
      }
      if (item.hasEOL) current = null;
    }

    return lines
      .map(line => {
        const text = line.parts.join(" ").replace(/\s+/g, " ").trim();
        return text ? { text, y: line.y, height: line.height } : null;
      })
      .filter(Boolean);
  }

  // ---- Load & Render PDF ----
  async function loadPdf(arrayBuffer) {
    const pdfjsLib = getPdfJs();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    log(`PDF loaded: ${pdf.numPages} pages`);

    const body = document.getElementById("ss-body");
    body.innerHTML = "";
    scriptLines = [];
    lastMatchIdx = 0;
    lastCaption = "";

    const scale = 1.2;

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale });

      const pageEl = document.createElement("div");
      pageEl.className = "ss-page";
      pageEl.style.width = `${viewport.width}px`;
      pageEl.style.height = `${viewport.height}px`;
      pageEl.style.position = "relative";

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      ctx.scale(dpr, dpr);
      pageEl.appendChild(canvas);

      const textContent = await page.getTextContent();
      const lines = extractPageLines(textContent, viewport, pdfjsLib);

      for (const line of lines) {
        const anchor = document.createElement("div");
        anchor.className = "ss-anchor";
        anchor.style.top = `${line.y}px`;
        anchor.style.height = `${Math.max(line.height, 16)}px`;
        pageEl.appendChild(anchor);
        scriptLines.push({
          pageNum,
          text: line.text,
          norm: normalize(line.text),
          el: anchor,
        });
      }

      body.appendChild(pageEl);
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (pageNum % 10 === 0) log(`Rendered ${pageNum}/${pdf.numPages} pages…`);
    }

    log(`Done: ${scriptLines.length} lines across ${pdf.numPages} pages`);
    body.style.display = "block";
    const dropZone = document.getElementById("ss-drop-zone");
    if (dropZone) dropZone.style.display = "none";
    pdfLoaded = true;
  }

  // ---- Handle File Drop ----
  async function handleFileDrop(file) {
    if (!file || !file.name.toLowerCase().endsWith(".pdf")) {
      log("Not a PDF file");
      return;
    }
    log(`Loading: "${file.name}" (${(file.size / 1024).toFixed(0)} KB)`);
    try {
      const arrayBuffer = await file.arrayBuffer();
      await loadPdf(arrayBuffer);
      startCaptionObservers();
    } catch (err) {
      log(`Error: ${err.message}`);
      console.error("[Script Scroll]", err);
    }
  }

  // ---- Build UI ----
  function buildUI() {
    if (panel) return;

    panel = document.createElement("div");
    panel.id = "ss-panel";

    const header = document.createElement("div");
    header.id = "ss-header";
    header.textContent = `SCRIPT SCROLL v${VERSION}`;

    const dropZone = document.createElement("div");
    dropZone.id = "ss-drop-zone";

    const icon = document.createElement("div");
    icon.className = "ss-drop-icon";
    icon.textContent = "📄";

    const dropText = document.createElement("div");
    dropText.className = "ss-drop-text";
    dropText.textContent = "Drop screenplay PDF here";

    const hint = document.createElement("div");
    hint.className = "ss-drop-hint";
    hint.textContent = "Supports any screenplay PDF format";

    dropZone.appendChild(icon);
    dropZone.appendChild(dropText);
    dropZone.appendChild(hint);

    dropZone.addEventListener("dragover",  e => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add("ss-drag-over"); });
    dropZone.addEventListener("dragenter", e => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add("ss-drag-over"); });
    dropZone.addEventListener("dragleave", e => { e.preventDefault(); e.stopPropagation(); dropZone.classList.remove("ss-drag-over"); });
    dropZone.addEventListener("drop", e => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove("ss-drag-over");
      const file = e.dataTransfer?.files?.[0];
      if (file) handleFileDrop(file);
    });

    const body = document.createElement("div");
    body.id = "ss-body";

    debugLog = document.createElement("div");
    debugLog.id = "ss-debug";

    panel.appendChild(header);
    panel.appendChild(dropZone);
    panel.appendChild(body);
    panel.appendChild(debugLog);
    document.body.appendChild(panel);
  }

  // ---- Start / Stop ----
  function start() {
    enabled = true;
    document.documentElement.classList.add("ss-active");
    buildUI();
    panel.style.display = "flex";
    if (pdfLoaded && scriptLines.length) {
      document.getElementById("ss-drop-zone").style.display = "none";
      document.getElementById("ss-body").style.display = "block";
    }
    startCaptionObservers();
  }

  function stop() {
    enabled = false;
    document.documentElement.classList.remove("ss-active");
    if (panel) panel.style.display = "none";
    stopCaptionObservers();
  }

  // ---- Message Listener ----
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "ss:toggle") return;
    msg.enabled ? start() : stop();
  });
})();
