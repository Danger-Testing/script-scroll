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
  const MAX_CAPTION_LINES = 200;
  let lastCaption = "";

  // ==========================================================
  // UI Creation — Script Panel (right side)
  // ==========================================================

  const scriptPanel = document.createElement("div");
  scriptPanel.id = "ss-panel";

  const scriptHeader = document.createElement("div");
  scriptHeader.id = "ss-header";
  scriptHeader.textContent = "SCRIPT SCROLL";

  const scriptBody = document.createElement("div");
  scriptBody.id = "ss-body";

  const scriptWaiting = document.createElement("div");
  scriptWaiting.id = "ss-waiting";
  scriptWaiting.textContent = "Waiting for captions…";

  scriptBody.appendChild(scriptWaiting);
  scriptPanel.appendChild(scriptHeader);
  scriptPanel.appendChild(scriptBody);

  // ==========================================================
  // Mount
  // ==========================================================

  document.documentElement.appendChild(scriptPanel);
  scriptPanel.style.display = "none";

  // ==========================================================
  // Caption Processing
  // ==========================================================

  function pushCaption(captionText) {
    if (!captionText || captionText === lastCaption) return;
    lastCaption = captionText;

    // Remove waiting message on first caption
    if (scriptWaiting.parentNode) {
      scriptWaiting.remove();
    }

    captionHistory.push(captionText);
    if (captionHistory.length > MAX_CAPTION_LINES) captionHistory.shift();

    const line = document.createElement("div");
    line.className = "ss-line";
    line.textContent = captionText;
    scriptBody.appendChild(line);
    scriptBody.scrollTop = scriptBody.scrollHeight;

    while (scriptBody.querySelectorAll(".ss-line").length > MAX_CAPTION_LINES) {
      const first = scriptBody.querySelector(".ss-line");
      if (first) first.remove();
    }
  }

  // ==========================================================
  // Caption Observer — Dual Strategy
  // ==========================================================

  function startCaptionObserver() {
    if (captionObserver) return;

    captionHistory = [];
    scriptBody.innerHTML = "";
    scriptBody.appendChild(scriptWaiting);
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
  // Layout — Squeeze Page Left
  // ==========================================================

  function enableSideBySide() {
    document.documentElement.classList.add("ss-active");
    scriptPanel.style.display = "flex";
  }

  function disableSideBySide() {
    document.documentElement.classList.remove("ss-active");
    scriptPanel.style.display = "none";
  }

  // ==========================================================
  // Lifecycle — Start / Stop
  // ==========================================================

  function startLoop() {
    enabled = true;
    enableSideBySide();
    startCaptionObserver();
  }

  function stopLoop() {
    enabled = false;
    disableSideBySide();
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
