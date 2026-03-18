// ============================================================
// Script Scroll — Content Script (PDF + Live Caption Matching)
// ============================================================

(() => {
  let enabled = false;
  let scriptText = "";
  let scriptLines = []; // [{ text, el, norm }]
  let captionObserver = null;
  let lastCaption = "";
  let lastMatchIdx = 0;
  let panel = null;
  let pdfLoaded = false;
  let pdfjsReady = false;
  let trackListener = null;

  // ---- Normalization ----
  function normalize(str) {
    return str.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  }

  // ---- Fuzzy Match ----
  function fuzzyMatch(captionNorm, startIdx, lines) {
    const captionWords = captionNorm.split(" ").filter(Boolean);
    if (captionWords.length === 0) return -1;

    const threshold = 0.6;
    let bestIdx = -1;
    let bestScore = 0;

    // Search forward from startIdx in a window of 100 lines
    const windowSize = 100;
    let end = Math.min(startIdx + windowSize, lines.length);

    for (let i = startIdx; i < end; i++) {
      const lineNorm = lines[i].norm;
      if (!lineNorm) continue;

      // Check substring match first
      if (lineNorm.includes(captionNorm)) return i;

      // Word overlap
      let hits = 0;
      for (const w of captionWords) {
        if (lineNorm.includes(w)) hits++;
      }
      const score = hits / captionWords.length;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    // If good match found in window, return it
    if (bestScore >= threshold) return bestIdx;

    // Expand search if nothing found in window
    end = Math.min(startIdx + 500, lines.length);
    for (let i = startIdx + windowSize; i < end; i++) {
      const lineNorm = lines[i].norm;
      if (!lineNorm) continue;

      if (lineNorm.includes(captionNorm)) return i;

      let hits = 0;
      for (const w of captionWords) {
        if (lineNorm.includes(w)) hits++;
      }
      const score = hits / captionWords.length;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    return bestScore >= threshold ? bestIdx : -1;
  }

  // ---- Highlight Match ----
  function highlightMatch(idx) {
    if (idx < 0 || idx >= scriptLines.length) return;

    // Remove previous active
    const prev = document.querySelector(".ss-line-active");
    if (prev) prev.classList.remove("ss-line-active");

    // Mark lines before as past
    for (let i = lastMatchIdx; i < idx; i++) {
      scriptLines[i].el.classList.add("ss-line-past");
    }

    // Set active
    scriptLines[idx].el.classList.add("ss-line-active");
    scriptLines[idx].el.classList.remove("ss-line-past");

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

    // Store the interval so we can clear it on stop
    captionObserver._videoCheck = videoCheck;
  }

  function stopCaptionObservers() {
    if (captionObserver) {
      if (captionObserver._videoCheck) clearInterval(captionObserver._videoCheck);
      captionObserver.disconnect();
      captionObserver = null;
    }
  }

  // ---- Load pdf.js ----
  function loadPdfJs() {
    return new Promise((resolve, reject) => {
      if (pdfjsReady && typeof pdfjsLib !== "undefined") {
        resolve();
        return;
      }

      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("pdf.min.js");
      script.onload = () => {
        if (typeof pdfjsLib !== "undefined") {
          pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.min.js");
          pdfjsReady = true;
          resolve();
        } else {
          reject(new Error("pdfjsLib not found after loading script"));
        }
      };
      script.onerror = () => reject(new Error("Failed to load pdf.js"));
      document.head.appendChild(script);
    });
  }

  // ---- Parse PDF ----
  async function parsePDF(arrayBuffer) {
    await loadPdfJs();

    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = "";

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => item.str).join(" ");
      fullText += pageText + "\n";
    }

    scriptText = fullText;
    return fullText;
  }

  // ---- Render Script ----
  function renderScript(text) {
    const body = document.getElementById("ss-body");
    body.innerHTML = "";
    scriptLines = [];
    lastMatchIdx = 0;
    lastCaption = "";

    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const div = document.createElement("div");
      div.className = "ss-line";
      div.textContent = trimmed;
      body.appendChild(div);

      scriptLines.push({
        text: trimmed,
        el: div,
        norm: normalize(trimmed),
      });
    }

    // Show body, hide drop zone
    body.style.display = "block";
    const dropZone = document.getElementById("ss-drop-zone");
    if (dropZone) dropZone.style.display = "none";

    pdfLoaded = true;
  }

  // ---- Handle File Drop ----
  async function handleFileDrop(file) {
    if (!file || file.type !== "application/pdf") {
      console.warn("[Script Scroll] Not a PDF file");
      return;
    }

    const arrayBuffer = await file.arrayBuffer();
    const text = await parsePDF(arrayBuffer);
    renderScript(text);
    startCaptionObservers();
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

    panel.appendChild(header);
    panel.appendChild(dropZone);
    panel.appendChild(body);
    document.body.appendChild(panel);
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
