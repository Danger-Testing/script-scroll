// ============================================================
// Script Scroll — Content Script (PDF + Live Caption Matching)
// ============================================================

(() => {
  const VERSION = "0.5";
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
    return str.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  }

  // ---- Find Match (Ctrl+F style) ----
  // Search ALL lines for the caption. Like Ctrl+F.
  // Prefer the first match at or after lastMatchIdx.
  // If none found forward, check behind (user may have rewound).
  function findMatch(captionNorm, startIdx, lines) {
    if (captionNorm.length < 3) return -1;

    // Pass 1: search forward from current position — first substring hit wins
    for (let i = startIdx; i < lines.length; i++) {
      const lineNorm = lines[i].norm;
      if (!lineNorm) continue;
      if (lineNorm.includes(captionNorm)) return i;
      // Check combined with next line (captions can span two script lines)
      if (i + 1 < lines.length) {
        const combined = lineNorm + " " + lines[i + 1].norm;
        if (combined.includes(captionNorm)) return i;
      }
    }

    // Pass 2: search from beginning (user might have rewound)
    for (let i = 0; i < startIdx; i++) {
      const lineNorm = lines[i].norm;
      if (!lineNorm) continue;
      if (lineNorm.includes(captionNorm)) return i;
      if (i + 1 < lines.length) {
        const combined = lineNorm + " " + lines[i + 1].norm;
        if (combined.includes(captionNorm)) return i;
      }
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
    const norm = normalize(text);
    if (norm === lastCaption || !norm) return;
    lastCaption = norm;

    const matchIdx = findMatch(norm, lastMatchIdx, scriptLines);
    if (matchIdx >= 0) {
      log(`Caption matched → line ${matchIdx}: "${scriptLines[matchIdx].text.substring(0, 40)}…"`);
      highlightMatch(matchIdx);
    }
  }

  // ---- Caption Observer (original dual-strategy from initial commit) ----
  function startCaptionObservers() {
    if (captionObserver) return;

    // --- Strategy 1: DOM-based (Netflix renders captions as styled spans) ---
    const findCaptionContainer = () => {
      return document.querySelector(".player-timedtext-text-container")
        || document.querySelector(".player-timedtext")
        || document.querySelector("[data-uia='player-timedtext']");
    };

    const processDomCaptions = () => {
      const container = findCaptionContainer();
      if (!container) return;

      const spans = container.querySelectorAll("span");
      const lines = [];
      spans.forEach(s => {
        const t = s.textContent.trim();
        if (t) lines.push(t);
      });

      const text = lines.join(" ");
      if (text) handleCaption(text);
    };

    // MutationObserver scoped to the player, not document.body
    captionObserver = new MutationObserver(processDomCaptions);
    const target = document.querySelector(".watch-video")
      || document.querySelector("[class*='player']")
      || document.body;
    captionObserver.observe(target, { childList: true, subtree: true, characterData: true });

    // --- Strategy 2: TextTrack API (Peacock & other players with native cues) ---
    const hookTextTracks = () => {
      const videos = document.querySelectorAll("video");
      videos.forEach(video => {
        if (video._ssTracked) return;
        video._ssTracked = true;

        const tracks = video.textTracks;
        if (!tracks) return;

        const onCueChange = (track) => {
          if (!track.activeCues || track.activeCues.length === 0) return;
          const lines = [];
          for (let i = 0; i < track.activeCues.length; i++) {
            const text = track.activeCues[i].text?.replace(/<[^>]*>/g, "").trim();
            if (text) lines.push(text);
          }
          const joined = lines.join(" ");
          if (joined) handleCaption(joined);
        };

        for (let i = 0; i < tracks.length; i++) {
          const track = tracks[i];
          if (track.kind === "subtitles" || track.kind === "captions") {
            track.mode = "showing";
            track.addEventListener("cuechange", () => onCueChange(track));
          }
        }

        tracks.addEventListener("addtrack", (e) => {
          const track = e.track;
          if (track.kind === "subtitles" || track.kind === "captions") {
            track.mode = "showing";
            track.addEventListener("cuechange", () => onCueChange(track));
          }
        });
      });
    };

    hookTextTracks();

    // Poll every 500ms as fallback for both DOM captions and new video elements
    captionObserver._pollInterval = setInterval(() => {
      processDomCaptions();
      hookTextTracks();
    }, 500);
  }

  function stopCaptionObservers() {
    if (captionObserver) {
      captionObserver.disconnect();
      if (captionObserver._pollInterval) clearInterval(captionObserver._pollInterval);
      captionObserver = null;
    }
    document.querySelectorAll("video").forEach(v => { v._ssTracked = false; });
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
