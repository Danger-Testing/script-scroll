// ============================================================
// Script Scroll — Content Script (PDF + Live Caption Matching)
// ============================================================

(() => {
  const VERSION = "1.0";
  let enabled = false;
  let scriptLines = []; // [{ pageNum, text, norm, tokens, sigTokens, el }]
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
  // Punctuation → spaces (not nothing!) so "your..wardrobe" → "your wardrobe"
  function normalize(str) {
    return str.toLowerCase()
      .replace(/['']/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---- Token helpers ----
  function isSignificant(tok) {
    return tok.length >= 3 && !STOP_WORDS.has(tok);
  }

  function buildTokenStats() {
    tokenLineFreq = new Map();
    for (const line of scriptLines) {
      line.tokens = line.norm ? line.norm.split(" ").filter(Boolean) : [];
      const unique = new Set(line.tokens);
      for (const tok of unique) {
        tokenLineFreq.set(tok, (tokenLineFreq.get(tok) || 0) + 1);
      }
    }
    const cutoff = Math.max(8, Math.floor(scriptLines.length * 0.05));
    for (const line of scriptLines) {
      line.sigTokens = line.tokens.filter(t => isSignificant(t) && (tokenLineFreq.get(t) || 0) <= cutoff);
    }
  }

  // Count how many tokens from needle appear in order in haystack
  function orderedMatchCount(needle, haystack) {
    let j = 0, matched = 0;
    for (const tok of needle) {
      while (j < haystack.length && haystack[j] !== tok) j++;
      if (j < haystack.length) { matched++; j++; }
    }
    return matched;
  }

  // ---- Find Match ----
  // Pass 1: exact substring (Ctrl+F). Pass 2: fuzzy token match.
  function findMatch(captionText, startIdx, lines) {
    const captionNorm = normalize(captionText);
    if (captionNorm.length < 3) return -1;

    const captionTokens = captionNorm.split(" ").filter(Boolean);
    const captionSig = captionTokens.filter(t => isSignificant(t) && (tokenLineFreq.get(t) || 0) <= Math.max(8, Math.floor(lines.length * 0.05)));

    // Build search ranges: forward from current, then rest, then behind (rewind)
    const ranges = [
      [startIdx, Math.min(lines.length, startIdx + 150)],
      [Math.min(lines.length, startIdx + 150), lines.length],
      [0, startIdx],
    ].filter(([a, b]) => a < b);

    // Pass 1: exact normalized substring match
    for (const [from, to] of ranges) {
      for (let i = from; i < to; i++) {
        const ln = lines[i].norm;
        if (!ln) continue;
        if (ln.includes(captionNorm)) return i;
        if (i + 1 < lines.length && (ln + " " + lines[i + 1].norm).includes(captionNorm)) return i;
      }
    }

    // Pass 2: fuzzy token match (need at least 2 unique significant words)
    const uniqueSig = [...new Set(captionSig)];
    if (uniqueSig.length < 2) return -1;

    for (const [from, to] of ranges) {
      let bestIdx = -1, bestScore = 0;

      for (let i = from; i < to; i++) {
        const lineSig = lines[i].sigTokens;
        if (!lineSig || !lineSig.length) continue;

        // Combine with next line (caption can span two script lines)
        const combined = i + 1 < lines.length ? lineSig.concat(lines[i + 1].sigTokens) : lineSig;
        const ordered = orderedMatchCount(uniqueSig, combined);
        if (ordered < 2) continue;

        const coverage = ordered / uniqueSig.length;
        if (coverage > bestScore) {
          bestScore = coverage;
          bestIdx = i;
        }

        // Strong match — take it immediately
        if (coverage >= 0.9) return i;
      }

      // Accept if enough words matched in order
      const needed = uniqueSig.length <= 3 ? 0.65 : 0.55;
      if (bestScore >= needed && bestIdx >= 0) return bestIdx;
    }

    return -1;
  }

  // ---- Highlight Match ----
  function highlightMatch(idx) {
    if (idx < 0 || idx >= scriptLines.length) return;

    // Remove previous active highlight
    const prev = document.querySelector(".ss-anchor-active");
    if (prev) prev.classList.remove("ss-anchor-active");

    // Set active
    scriptLines[idx].el.classList.add("ss-anchor-active");

    // Scroll into view
    scriptLines[idx].el.scrollIntoView({ behavior: "smooth", block: "center" });

    lastMatchIdx = idx;
  }

  // ---- Handle Caption ----
  function handleCaption(text) {
    if (!text || !scriptLines.length) return;

    const matchIdx = findMatch(text, lastMatchIdx, scriptLines);
    if (matchIdx >= 0) {
      log(`Matched → line ${matchIdx}: "${scriptLines[matchIdx].text.substring(0, 50)}…"`);
      highlightMatch(matchIdx);
    }
  }

  // ---- Caption Observer (from working Cortisol Maxxer commit aacc5ec) ----
  function startCaptionObservers() {
    if (captionObserver) return;
    lastCaption = "";

    const findCaptionContainer = () => {
      return document.querySelector(".player-timedtext-text-container")
        || document.querySelector(".player-timedtext")
        || document.querySelector("[data-uia='player-timedtext']")
        || document.querySelector("[class*='subtitles']")
        || document.querySelector("[class*='caption']")
        || document.querySelector("[class*='cue']");
    };

    // Extract caption text from Netflix DOM without duplication.
    // Netflix nests spans: <span><span>text</span></span>
    // Only read leaf spans (those with no child spans) to avoid doubling.
    function extractCaptionText(container) {
      const allSpans = container.querySelectorAll("span");
      const leaves = [];
      allSpans.forEach(s => {
        if (s.querySelector("span")) return; // skip parents
        const t = s.textContent.trim();
        if (t) leaves.push(t);
      });
      if (leaves.length > 0) return leaves.join(" ");
      // Fallback if no spans at all
      return container.textContent.replace(/\s+/g, " ").trim();
    }

    let captionDebounce = null;
    const processCaptions = () => {
      const container = findCaptionContainer();
      if (!container) return;

      const raw = extractCaptionText(container);
      if (!raw || raw === lastCaption) return;

      // Debounce: Netflix renders lines sequentially, wait 150ms
      // for the full caption to appear before processing
      if (captionDebounce) clearTimeout(captionDebounce);
      captionDebounce = setTimeout(() => {
        const text = extractCaptionText(container);
        if (text && text !== lastCaption) {
          lastCaption = text;
          log(`Caption: "${text}"`);
          handleCaption(text);
        }
      }, 150);
    };

    // MutationObserver on the player area
    captionObserver = new MutationObserver(processCaptions);
    const target = document.querySelector(".watch-video") || document.body;
    captionObserver.observe(target, { childList: true, subtree: true, characterData: true });

    // Poll every 500ms as fallback
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

  // ---- Extract real lines from PDF text content ----
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
      .sort((a, b) => {
        if (Math.abs(a.y - b.y) < 3) return a.x - b.x;
        return a.y - b.y;
      });

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

  // ---- Load & Render PDF as Canvas Pages ----
  async function loadPdf(arrayBuffer) {
    const pdfjsLib = getPdfJs();
    log(`pdf.js version: ${pdfjsLib.version}`);

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

      // Page container
      const pageEl = document.createElement("div");
      pageEl.className = "ss-page";
      pageEl.style.width = `${viewport.width}px`;
      pageEl.style.height = `${viewport.height}px`;
      pageEl.style.position = "relative";

      // Canvas for rendering
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      ctx.scale(dpr, dpr);
      pageEl.appendChild(canvas);

      // Extract text lines with positions for matching
      const textContent = await page.getTextContent();
      const lines = extractPageLines(textContent, viewport, pdfjsLib);

      for (const line of lines) {
        // Invisible anchor overlay for scrolling/highlighting
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

      // Render the page to canvas
      await page.render({ canvasContext: ctx, viewport }).promise;

      if (pageNum % 10 === 0) log(`Rendered ${pageNum}/${pdf.numPages} pages…`);
    }

    buildTokenStats();
    log(`Done: ${scriptLines.length} lines across ${pdf.numPages} pages`);

    // Show body, hide drop zone
    body.style.display = "block";
    const dropZone = document.getElementById("ss-drop-zone");
    if (dropZone) dropZone.style.display = "none";

    pdfLoaded = true;
  }

  // ---- Handle File Drop ----
  async function handleFileDrop(file) {
    log(`File dropped: "${file.name}" (${file.type}, ${(file.size / 1024).toFixed(0)} KB)`);

    if (!file || !file.name.toLowerCase().endsWith(".pdf")) {
      log("❌ Not a PDF file");
      return;
    }

    try {
      const arrayBuffer = await file.arrayBuffer();
      log(`Read ${arrayBuffer.byteLength} bytes`);
      await loadPdf(arrayBuffer);
      startCaptionObservers();
      log("Caption observers started — ready for sync");
    } catch (err) {
      log(`❌ Error: ${err.message}`);
      console.error("[Script Scroll]", err);
    }
  }

  // ---- Build UI ----
  function buildUI() {
    if (panel) return;

    panel = document.createElement("div");
    panel.id = "ss-panel";

    // Header
    const header = document.createElement("div");
    header.id = "ss-header";
    header.textContent = `SCRIPT SCROLL v${VERSION}`;

    // Drop Zone
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

    // Drag and drop events
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add("ss-drag-over");
    });

    dropZone.addEventListener("dragenter", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add("ss-drag-over");
    });

    dropZone.addEventListener("dragleave", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove("ss-drag-over");
    });

    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove("ss-drag-over");

      const file = e.dataTransfer?.files?.[0];
      if (file) handleFileDrop(file);
    });

    // Script Body
    const body = document.createElement("div");
    body.id = "ss-body";

    // Debug Log
    debugLog = document.createElement("div");
    debugLog.id = "ss-debug";

    panel.appendChild(header);
    panel.appendChild(dropZone);
    panel.appendChild(body);
    panel.appendChild(debugLog);
    document.body.appendChild(panel);

    log("UI built, pdf.js available: " + (typeof pdfjsLib !== "undefined"));
  }

  // ---- Start / Stop ----
  function start() {
    enabled = true;
    document.documentElement.classList.add("ss-active");
    buildUI();
    panel.style.display = "flex";

    // If PDF was already loaded, hide drop zone
    if (pdfLoaded && scriptLines.length) {
      document.getElementById("ss-drop-zone").style.display = "none";
      document.getElementById("ss-body").style.display = "block";
    }

    // Always start caption observers immediately
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
    if (msg.enabled) {
      start();
    } else {
      stop();
    }
  });
})();
