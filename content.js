// ============================================================
// Script Scroll — Content Script
// ============================================================

(() => {
  // ==========================================================
  // State
  // ==========================================================

  let enabled = false;
  let captionObserver = null;
  let captionHistory = [];
  const MAX_CAPTION_LINES = 50;
  let lastCaption = "";
  let devVisible = false;
  let labelTimeout = null;

  // ==========================================================
  // UI Creation — Dev Toggle Button (top-right)
  // ==========================================================

  const devBtn = document.createElement("button");
  devBtn.id = "ss-dev-btn";
  devBtn.textContent = "SHOW DEV";

  // ==========================================================
  // UI Creation — Caption Overlay (dev view)
  // ==========================================================

  const captionOverlay = document.createElement("div");
  captionOverlay.id = "ss-caption-overlay";

  const captionLive = document.createElement("div");
  captionLive.id = "ss-caption-live";
  captionLive.textContent = "Waiting for captions…";

  const captionLog = document.createElement("div");
  captionLog.id = "ss-caption-log";

  captionOverlay.appendChild(captionLive);
  captionOverlay.appendChild(captionLog);

  // ==========================================================
  // UI Creation — Label Flash (bottom of screen)
  // ==========================================================

  const scriptLabel = document.createElement("div");
  scriptLabel.id = "ss-label";

  // ==========================================================
  // UI Creation — Copy Image Button
  // ==========================================================

  const copyImgBtn = document.createElement("button");
  copyImgBtn.id = "ss-copy-img";
  copyImgBtn.textContent = "COPY IMAGE TO CLIPBOARD";

  // ==========================================================
  // Mount All Elements
  // ==========================================================

  document.documentElement.appendChild(devBtn);
  document.documentElement.appendChild(captionOverlay);
  document.documentElement.appendChild(scriptLabel);
  document.documentElement.appendChild(copyImgBtn);

  // Start hidden
  devBtn.style.display = "none";
  captionOverlay.style.display = "none";
  scriptLabel.style.display = "none";
  copyImgBtn.style.display = "none";

  // ==========================================================
  // Label Flash
  // ==========================================================

  function flashLabel(text) {
    scriptLabel.textContent = text;
    scriptLabel.style.display = "block";
    scriptLabel.style.opacity = "1";
    copyImgBtn.style.display = "block";
    if (labelTimeout) clearTimeout(labelTimeout);
    labelTimeout = setTimeout(() => {
      scriptLabel.style.opacity = "0";
      copyImgBtn.style.display = "none";
      setTimeout(() => { scriptLabel.style.display = "none"; }, 400);
    }, 3000);
  }

  // ==========================================================
  // Caption Processing
  // ==========================================================

  function pushCaption(captionText) {
    if (!captionText || captionText === lastCaption) return;
    lastCaption = captionText;
    captionLive.textContent = captionText;

    captionHistory.push(captionText);
    if (captionHistory.length > MAX_CAPTION_LINES) captionHistory.shift();

    const line = document.createElement("div");
    line.className = "ss-caption-line";
    line.textContent = captionText;
    captionLog.appendChild(line);
    captionLog.scrollTop = captionLog.scrollHeight;

    while (captionLog.children.length > MAX_CAPTION_LINES) {
      captionLog.removeChild(captionLog.firstChild);
    }
  }

  // ==========================================================
  // Caption Observer — Dual Strategy
  // ==========================================================

  function startCaptionObserver() {
    if (captionObserver) return;

    captionHistory = [];
    captionLog.innerHTML = "";
    captionLive.textContent = "Waiting for captions…";
    lastCaption = "";

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

      pushCaption(lines.join(" "));
    };

    // MutationObserver for DOM-rendered captions
    captionObserver = new MutationObserver(processDomCaptions);
    const target = document.querySelector(".watch-video") || document.querySelector("[class*='player']") || document.body;
    captionObserver.observe(target, { childList: true, subtree: true, characterData: true });

    // --- Strategy 2: TextTrack API (Peacock & most other players use native cues) ---
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
          pushCaption(lines.join(" "));
        };

        for (let i = 0; i < tracks.length; i++) {
          const track = tracks[i];
          if (track.kind === "subtitles" || track.kind === "captions") {
            track.mode = "showing";
            track.addEventListener("cuechange", () => onCueChange(track));
          }
        }

        // Watch for tracks added later
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

    // Poll for video elements and DOM captions as fallback
    captionObserver._pollInterval = setInterval(() => {
      processDomCaptions();
      hookTextTracks();
    }, 500);
  }

  function stopCaptionObserver() {
    if (captionObserver) {
      captionObserver.disconnect();
      if (captionObserver._pollInterval) clearInterval(captionObserver._pollInterval);
      captionObserver = null;
    }
    document.querySelectorAll("video").forEach(v => { v._ssTracked = false; });
  }

  // ==========================================================
  // Event Listeners
  // ==========================================================

  devBtn.addEventListener("click", () => {
    devVisible = !devVisible;
    devBtn.textContent = devVisible ? "HIDE DEV" : "SHOW DEV";
    captionOverlay.style.display = devVisible ? "flex" : "none";
  });

  copyImgBtn.addEventListener("click", () => {
    const hideEls = [captionOverlay, devBtn, copyImgBtn];
    hideEls.forEach(el => el.style.visibility = "hidden");

    chrome.runtime.sendMessage({ type: "ss:screenshot" }, async (res) => {
      hideEls.forEach(el => el.style.visibility = "");
      if (res?.dataUrl) {
        const resp = await fetch(res.dataUrl);
        const blob = await resp.blob();
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        copyImgBtn.textContent = "COPIED ✓";
        setTimeout(() => { copyImgBtn.textContent = "COPY IMAGE TO CLIPBOARD"; }, 1500);
      }
    });
  });

  // ==========================================================
  // Lifecycle — Start / Stop
  // ==========================================================

  function startLoop() {
    enabled = true;
    devVisible = false;
    devBtn.textContent = "SHOW DEV";
    devBtn.style.display = "block";
    copyImgBtn.style.display = "none";
    captionOverlay.style.display = "none";
    startCaptionObserver();
  }

  function stopLoop() {
    enabled = false;
    devBtn.style.display = "none";
    copyImgBtn.style.display = "none";
    captionOverlay.style.display = "none";
    scriptLabel.style.display = "none";
    if (labelTimeout) { clearTimeout(labelTimeout); labelTimeout = null; }
    stopCaptionObserver();
  }

  // ==========================================================
  // Message Listener — Toggle from Background
  // ==========================================================

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "ss:toggle") {
      if (message.enabled) startLoop();
      else stopLoop();
    }
  });
})();
