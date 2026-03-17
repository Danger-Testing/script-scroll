// ============================================================
// Script Scroll — Content Script
// ============================================================

(() => {
  // ==========================================================
  // State
  // ==========================================================

  let enabled = false;
  let captionObserver = null;
  let lastCaption = "";
  let fullScriptLoaded = false;
  let cueLineMap = new Map(); // Maps cue text → DOM element

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
  // Full Script Rendering
  // ==========================================================

  function renderFullScript(cues) {
    scriptBody.innerHTML = "";
    cueLineMap.clear();
    fullScriptLoaded = true;

    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      const text = cue.text?.replace(/<[^>]*>/g, "").trim();
      if (!text) continue;

      const line = document.createElement("div");
      line.className = "ss-line";
      line.textContent = text;
      line.dataset.startTime = cue.startTime;
      line.dataset.endTime = cue.endTime;
      scriptBody.appendChild(line);

      // Map by start time for precise matching
      cueLineMap.set(cue.startTime, line);
    }

    scriptHeader.textContent = `SCRIPT SCROLL — ${cues.length} lines`;
  }

  function highlightActiveCue(startTime) {
    const activeLine = cueLineMap.get(startTime);
    if (!activeLine) return;

    // Remove previous highlight
    const prev = scriptBody.querySelector(".ss-line-active");
    if (prev) prev.classList.remove("ss-line-active");

    // Highlight current
    activeLine.classList.add("ss-line-active");

    // Smooth scroll to keep active line centered
    activeLine.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // ==========================================================
  // Realtime Fallback (append as they come)
  // ==========================================================

  function pushCaption(captionText) {
    if (!captionText || captionText === lastCaption) return;
    lastCaption = captionText;

    // If full script is loaded, just highlight the matching line
    if (fullScriptLoaded) {
      // Find by text content match
      const lines = scriptBody.querySelectorAll(".ss-line");
      for (const line of lines) {
        if (line.textContent === captionText && !line.classList.contains("ss-line-past")) {
          const prev = scriptBody.querySelector(".ss-line-active");
          if (prev) {
            prev.classList.remove("ss-line-active");
            prev.classList.add("ss-line-past");
          }
          line.classList.add("ss-line-active");
          line.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
      }
      return;
    }

    // Fallback: append in real-time
    if (scriptWaiting.parentNode) scriptWaiting.remove();

    const line = document.createElement("div");
    line.className = "ss-line ss-line-active";

    // Remove highlight from previous
    const prev = scriptBody.querySelector(".ss-line-active");
    if (prev) {
      prev.classList.remove("ss-line-active");
      prev.classList.add("ss-line-past");
    }

    line.textContent = captionText;
    scriptBody.appendChild(line);
    line.scrollIntoView({ behavior: "smooth", block: "center" });

    // Cap total lines
    while (scriptBody.querySelectorAll(".ss-line").length > 500) {
      const first = scriptBody.querySelector(".ss-line");
      if (first) first.remove();
    }
  }

  // ==========================================================
  // Caption Observer — Dual Strategy
  // ==========================================================

  function startCaptionObserver() {
    if (captionObserver) return;

    scriptBody.innerHTML = "";
    scriptBody.appendChild(scriptWaiting);
    lastCaption = "";
    fullScriptLoaded = false;
    cueLineMap.clear();

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

    // --- Strategy 2: TextTrack API ---
    const hookTextTracks = () => {
      const videos = document.querySelectorAll("video");
      videos.forEach(video => {
        if (video._ssTracked) return;
        video._ssTracked = true;

        const tracks = video.textTracks;
        if (!tracks) return;

        const tryDumpFullScript = (track) => {
          if (fullScriptLoaded) return;
          if (track.cues && track.cues.length > 10) {
            renderFullScript(track.cues);
          }
        };

        const onCueChange = (track) => {
          // Try full dump on first cue change if not yet loaded
          tryDumpFullScript(track);

          if (!track.activeCues || track.activeCues.length === 0) return;

          if (fullScriptLoaded) {
            // Highlight by start time
            for (let i = 0; i < track.activeCues.length; i++) {
              highlightActiveCue(track.activeCues[i].startTime);
            }
          } else {
            const lines = [];
            for (let i = 0; i < track.activeCues.length; i++) {
              const text = track.activeCues[i].text?.replace(/<[^>]*>/g, "").trim();
              if (text) lines.push(text);
            }
            pushCaption(lines.join(" "));
          }
        };

        for (let i = 0; i < tracks.length; i++) {
          const track = tracks[i];
          if (track.kind === "subtitles" || track.kind === "captions") {
            track.mode = "showing";
            tryDumpFullScript(track);
            track.addEventListener("cuechange", () => onCueChange(track));
          }
        }

        tracks.addEventListener("addtrack", (e) => {
          const track = e.track;
          if (track.kind === "subtitles" || track.kind === "captions") {
            track.mode = "showing";
            // Wait a moment for cues to load
            setTimeout(() => tryDumpFullScript(track), 1000);
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
