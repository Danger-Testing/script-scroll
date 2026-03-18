// ============================================================
// Script Scroll — Content Script (PDF + Live Caption Matching)
// ============================================================

(() => {
  let enabled = false;
  let scriptLines = []; // [{ pageNum, text, norm, el }]
  let captionObserver = null;
  let lastCaption = "";
  let lastMatchIdx = 0;
  let missStreak = 0;
  let panel = null;
  let pdfLoaded = false;
  let trackListener = null;
  let debugLog = null;

  // ---- Stopwords (ignored in matching) ----
  const STOPWORDS = new Set([
    "i", "me", "my", "you", "your", "he", "she", "it", "we", "they",
    "a", "an", "the", "is", "are", "was", "were", "am", "be", "been",
    "do", "does", "did", "have", "has", "had", "will", "would", "could",
    "should", "can", "may", "might", "shall", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "that", "this",
    "but", "and", "or", "not", "no", "so", "if", "then", "than",
    "up", "out", "just", "about", "what", "all", "when", "how",
    "its", "his", "her", "our", "their", "him", "them", "us",
    "there", "here", "very", "too", "also", "well", "oh", "um",
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
  function normalize(str) {
    return str.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  }

  // ---- Tokenize (remove stopwords) ----
  function tokenize(norm) {
    return norm.split(" ").filter(w => w.length > 1 && !STOPWORDS.has(w));
  }

  // ---- Score match between caption tokens and a line ----
  function scoreMatch(captionTokens, lineNorm) {
    if (!lineNorm || captionTokens.length === 0) return 0;
    let hits = 0;
    for (const w of captionTokens) {
      if (lineNorm.includes(w)) hits++;
    }
    return hits / captionTokens.length;
  }

  // ---- Fuzzy Match (conservative, local-only) ----
  function fuzzyMatch(captionNorm, startIdx, lines) {
    const tokens = tokenize(captionNorm);

    // Very short captions (after removing stopwords) — require exact substring
    if (tokens.length < 2) {
      // Try exact substring in a tiny window
      const end = Math.min(startIdx + 8, lines.length);
      for (let i = Math.max(0, startIdx - 2); i < end; i++) {
        if (lines[i].norm.includes(captionNorm)) return i;
      }
      return -1;
    }

    // --- Local search: small window around current position ---
    const localStart = Math.max(0, startIdx - 2);
    const localEnd = Math.min(startIdx + 15, lines.length);
    let bestIdx = -1;
    let bestScore = 0;

    for (let i = localStart; i < localEnd; i++) {
      const lineNorm = lines[i].norm;
      if (!lineNorm) continue;

      // Exact substring match — immediate accept
      if (lineNorm.includes(captionNorm)) return i;

      // Also check joining with next line (captions can span lines)
      if (i + 1 < lines.length) {
        const combined = lineNorm + " " + lines[i + 1].norm;
        if (combined.includes(captionNorm)) return i;
      }

      const score = scoreMatch(tokens, lineNorm);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    // High confidence local match — accept
    if (bestScore >= 0.75) return bestIdx;

    // --- Recovery mode: only after several consecutive misses ---
    if (missStreak >= 4) {
      const recoveryEnd = Math.min(startIdx + 60, lines.length);
      let recBestIdx = -1;
      let recBestScore = 0;

      for (let i = localEnd; i < recoveryEnd; i++) {
        const lineNorm = lines[i].norm;
        if (!lineNorm) continue;

        if (lineNorm.includes(captionNorm)) return i;

        const score = scoreMatch(tokens, lineNorm);
        if (score > recBestScore) {
          recBestScore = score;
          recBestIdx = i;
        }
      }

      // Only jump on very high confidence recovery
      if (recBestScore >= 0.9) {
        log(`Recovery jump → line ${recBestIdx} (score ${recBestScore.toFixed(2)}, after ${missStreak} misses)`);
        return recBestIdx;
      }
    }

    // No confident match — stay put
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
    const norm = normalize(text);
    if (norm === lastCaption || !norm) return;
    lastCaption = norm;

    const matchIdx = fuzzyMatch(norm, lastMatchIdx, scriptLines);
    if (matchIdx >= 0) {
      highlightMatch(matchIdx);
      missStreak = 0;
    } else {
      missStreak++;
    }
  }

  // ---- Caption Observers ----
  function startCaptionObservers() {
    // Netflix MutationObserver
    const selectors = [
      ".player-timedtext-text-container",
      ".player-timedtext",
      "[data-uia='player-timedtext']",
    ];

    captionObserver = new MutationObserver(() => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) {
          handleCaption(el.textContent.trim());
          return;
        }
      }
    });

    captionObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Peacock TextTrack API
    trackListener = () => {
      const video = document.querySelector("video");
      if (!video) return;
      for (const track of video.textTracks) {
        if (track.mode === "showing" || track.mode === "hidden") {
          track.addEventListener("cuechange", () => {
            const cue = track.activeCues?.[0];
            if (cue?.text) handleCaption(cue.text);
          });
        }
      }
    };

    // Check for video periodically until found
    const videoCheck = setInterval(() => {
      const video = document.querySelector("video");
      if (video) {
        trackListener();
        clearInterval(videoCheck);
      }
    }, 2000);

    captionObserver._videoCheck = videoCheck;
  }

  function stopCaptionObservers() {
    if (captionObserver) {
      if (captionObserver._videoCheck) clearInterval(captionObserver._videoCheck);
      captionObserver.disconnect();
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
    missStreak = 0;

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
    header.textContent = "SCRIPT SCROLL";

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

    // If PDF was already loaded, just restart observers
    if (pdfLoaded && scriptLines.length) {
      document.getElementById("ss-drop-zone").style.display = "none";
      document.getElementById("ss-body").style.display = "block";
      startCaptionObservers();
    }
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
