// ============================================================
// Script Scroll — Content Script (PDF + Live Caption Matching)
// ============================================================

(() => {
  const VERSION = "2.0.4";
  let enabled = false;
  let scriptLines = []; // [{ pageNum, text, norm, sigTokens: Set, el }]
  let captionObserver = null;
  let lastCaption = "";
  let lastMatchIdx = 0;
  let panel = null;
  let pdfLoaded = false;
  let debugLog = null;
  let tokenLineFreq = new Map();

  const STOP_WORDS = new Set([
    "a","an","and","are","as","at","be","been","but","by","do","did","for","from",
    "get","got","had","has","have","he","her","him","his","i","if","in","into",
    "is","it","its","just","me","my","no","not","of","oh","ok","okay","on","or",
    "our","out","she","so","that","the","their","them","there","they","this","to",
    "uh","um","up","was","we","well","were","what","yeah","yes","you","your",
  ]);

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
  // Expand PDF ligatures first, then lowercase and collapse to plain words.
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

  // ---- Token stats (called once after PDF loads) ----
  function buildTokenStats() {
    tokenLineFreq = new Map();
    for (const line of scriptLines) {
      const toks = line.norm ? line.norm.split(" ").filter(Boolean) : [];
      line.tokens = toks;
      const unique = new Set(toks);
      for (const tok of unique) {
        tokenLineFreq.set(tok, (tokenLineFreq.get(tok) || 0) + 1);
      }
    }
    const cutoff = Math.max(8, Math.floor(scriptLines.length * 0.05));
    for (const line of scriptLines) {
      // Store as Set for O(1) lookup during matching
      line.sigTokens = new Set(
        line.tokens.filter(t =>
          t.length >= 3 && !STOP_WORDS.has(t) && (tokenLineFreq.get(t) || 0) <= cutoff
        )
      );
    }
  }

  // ---- Find Match ----
  // No artificial window cap. Always searches forward from startIdx to end
  // of script so we naturally re-sync if we ever drift, no matter how far.
  // A movie fires captions every 1-3 seconds — there's no time to "count
  // misses". Just always look forward and find where we are.
  function findMatch(captionNorm, startIdx) {
    if (!captionNorm || captionNorm.length < 3) return -1;

    const total = scriptLines.length;
    const LOOK_BEHIND = 30; // small backward buffer for a line we briefly missed

    const lo = Math.max(0, startIdx - LOOK_BEHIND);

    // ------------------------------------------------------------------
    // Pass 1: exact normalized substring
    // Forward from startIdx to end, then small backward buffer.
    // ------------------------------------------------------------------
    for (let i = startIdx; i < total; i++) {
      const ln = scriptLines[i].norm;
      if (!ln) continue;
      if (ln.includes(captionNorm)) return i;
      // Caption may span two adjacent PDF lines (wrapped dialogue)
      if (i + 1 < total && scriptLines[i + 1].norm) {
        if ((ln + " " + scriptLines[i + 1].norm).includes(captionNorm)) return i;
      }
    }
    for (let i = lo; i < startIdx; i++) {
      const ln = scriptLines[i].norm;
      if (ln && ln.includes(captionNorm)) return i;
    }

    const cutoff = Math.max(8, Math.floor(total * 0.05));
    const capSig = [...new Set(
      captionNorm.split(" ").filter(t =>
        t.length >= 3 && !STOP_WORDS.has(t) && (tokenLineFreq.get(t) || 0) <= cutoff
      )
    )];

    // ------------------------------------------------------------------
    // Pass 2: anchor-word match
    // A word appearing in ≤ 3 script lines uniquely identifies the line.
    // Search forward from startIdx — still naturally re-syncs if drifted.
    // ------------------------------------------------------------------
    const anchors = capSig
      .filter(t => (tokenLineFreq.get(t) || 0) <= 3)
      .sort((a, b) => (tokenLineFreq.get(a) || 0) - (tokenLineFreq.get(b) || 0));

    for (const anchor of anchors) {
      for (let i = startIdx; i < total; i++) {
        if (scriptLines[i].sigTokens.has(anchor)) return i;
      }
      for (let i = lo; i < startIdx; i++) {
        if (scriptLines[i].sigTokens.has(anchor)) return i;
      }
    }

    if (capSig.length < 2) return -1;

    // ------------------------------------------------------------------
    // Pass 3a: hot zone — next 15 lines with relaxed threshold (40%)
    // When watching live the next caption is almost always right here.
    // ------------------------------------------------------------------
    const hotEnd = Math.min(total, startIdx + 15);
    let bestIdx = -1, bestScore = 0;

    for (let i = Math.max(lo, startIdx - 5); i < hotEnd; i++) {
      const lineSig = scriptLines[i].sigTokens;
      if (!lineSig || lineSig.size === 0) continue;
      let matches = 0;
      for (const t of capSig) if (lineSig.has(t)) matches++;
      const score = matches / capSig.length;
      if (score >= 0.9) return i;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    if (bestScore >= 0.4 && bestIdx >= 0) return bestIdx;

    // ------------------------------------------------------------------
    // Pass 3b: full forward search with normal threshold (55%)
    // Handles re-sync after any amount of drift.
    // ------------------------------------------------------------------
    bestIdx = -1; bestScore = 0;
    for (let i = startIdx; i < total; i++) {
      const lineSig = scriptLines[i].sigTokens;
      if (!lineSig || lineSig.size === 0) continue;
      let matches = 0;
      for (const t of capSig) if (lineSig.has(t)) matches++;
      const score = matches / capSig.length;
      if (score >= 0.9) return i;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    const threshold = capSig.length <= 3 ? 0.67 : 0.55;
    if (bestScore >= threshold && bestIdx >= 0) return bestIdx;

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

    // Try the full caption first
    const norm = normalize(text);
    let matchIdx = findMatch(norm, lastMatchIdx);
    if (matchIdx >= 0) {
      log(`Match line ${matchIdx}: "${scriptLines[matchIdx].text.substring(0, 60)}"`);
      highlightMatch(matchIdx);
      return;
    }

    // Netflix sometimes joins two different speakers into one caption:
    //   "Yes, it's called accountability. I'm not talking to you, bitch!"
    //   = JANE's line + ERIN's line merged with no separator in the DOM.
    // Split on sentence-ending punctuation and try each fragment separately.
    // We match the FIRST fragment found (that's where we are in the script).
    const fragments = text.split(/(?<=[.!?])\s+/).map(f => normalize(f)).filter(f => f.length >= 3);
    if (fragments.length > 1) {
      for (const frag of fragments) {
        matchIdx = findMatch(frag, lastMatchIdx);
        if (matchIdx >= 0) {
          log(`Fragment match line ${matchIdx}: "${scriptLines[matchIdx].text.substring(0, 60)}"`);
          highlightMatch(matchIdx);
          return;
        }
      }
    }

    log(`No match: "${text.substring(0, 50)}"`);
  }

  // ---- Caption Extraction ----
  // Netflix renders each caption line TWICE in the DOM:
  // once as a shadow/stroke span and once as the visible text span.
  // Both are leaf spans (no child spans) with identical text content.
  // We collect leaf texts and deduplicate consecutive identical entries
  // to get back to the actual caption lines without doubling.
  function extractLeafText(container) {
    const rawLeaves = [];
    container.querySelectorAll("span").forEach(s => {
      if (s.querySelector("span")) return; // skip parent spans, only leaves
      const t = s.textContent.trim();
      if (t) rawLeaves.push(t);
    });

    // Deduplicate consecutive identical strings (shadow effect)
    const deduped = [];
    for (const t of rawLeaves) {
      if (deduped[deduped.length - 1] !== t) deduped.push(t);
    }
    return deduped.join(" ");
  }

  function extractCaptionText() {
    // Netflix puts each displayed line in its own .player-timedtext-text-container.
    // Querying all of them and joining gives us all visible caption lines.
    const lineContainers = document.querySelectorAll(".player-timedtext-text-container");
    if (lineContainers.length > 0) {
      const lines = [];
      lineContainers.forEach(c => {
        const t = extractLeafText(c);
        if (t) lines.push(t);
      });
      return lines.join(" ");
    }

    // Fallback selectors for Peacock or future Netflix DOM changes
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

      // Debounce 120ms: Netflix sometimes updates caption DOM incrementally.
      // Wait for it to settle before matching.
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

    buildTokenStats();
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
