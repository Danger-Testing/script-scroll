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
  let allLines = []; // { startTime, endTime, text, el }

  // ==========================================================
  // Inject Fetch Interceptor into Page World
  // ==========================================================

  function injectInterceptor() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("interceptor.js");
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  // Listen for intercepted subtitle data from page world
  window.addEventListener("message", (event) => {
    if (event.data?.type !== "ss:subtitles-intercepted") return;
    if (fullScriptLoaded) return; // Already have a script loaded
    parseTTML(event.data.data);
  });

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
  scriptWaiting.textContent = "Waiting for subtitles…\nMake sure captions are enabled.";

  scriptBody.appendChild(scriptWaiting);
  scriptPanel.appendChild(scriptHeader);
  scriptPanel.appendChild(scriptBody);

  // ==========================================================
  // Mount
  // ==========================================================

  document.documentElement.appendChild(scriptPanel);
  scriptPanel.style.display = "none";

  // ==========================================================
  // TTML Parser
  // ==========================================================

  function parseTTML(xmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, "text/xml");

    // Find all <p> elements (each is a subtitle cue)
    const pEls = doc.querySelectorAll("p");
    if (pEls.length < 5) return; // Not a real subtitle file

    const cues = [];
    pEls.forEach(p => {
      const begin = p.getAttribute("begin");
      const end = p.getAttribute("end");
      // Get text content, stripping inner tags like <span>, <br>
      const text = p.textContent?.replace(/\s+/g, " ").trim();
      if (!text || !begin) return;

      cues.push({
        startTime: parseTimestamp(begin),
        endTime: end ? parseTimestamp(end) : null,
        text: text,
      });
    });

    if (cues.length < 5) return;

    renderFullScript(cues);
  }

  function parseTimestamp(ts) {
    // Handle formats like "00:01:23.456" or tick-based
    if (ts.includes(":")) {
      const parts = ts.split(":");
      if (parts.length === 3) {
        const h = parseFloat(parts[0]);
        const m = parseFloat(parts[1]);
        const s = parseFloat(parts[2]);
        return h * 3600 + m * 60 + s;
      }
    }
    // Tick-based format (ticks / 10000000)
    const tickMatch = ts.match(/^(\d+)t$/);
    if (tickMatch) return parseInt(tickMatch[1]) / 10000000;
    return parseFloat(ts) || 0;
  }

  // ==========================================================
  // Full Script Rendering
  // ==========================================================

  function renderFullScript(cues) {
    scriptBody.innerHTML = "";
    allLines = [];
    fullScriptLoaded = true;

    // Deduplicate consecutive identical lines
    let prevText = "";
    cues.forEach(cue => {
      if (cue.text === prevText) return;
      prevText = cue.text;

      const line = document.createElement("div");
      line.className = "ss-line";
      line.textContent = cue.text;

      scriptBody.appendChild(line);
      allLines.push({
        startTime: cue.startTime,
        endTime: cue.endTime,
        text: cue.text,
        el: line,
      });
    });

    scriptHeader.textContent = `SCRIPT SCROLL — ${allLines.length} lines`;

    // Start syncing with video time
    startTimeSync();
  }

  // ==========================================================
  // Time Sync — Highlight Current Line
  // ==========================================================

  let syncRaf = null;

  function startTimeSync() {
    if (syncRaf) cancelAnimationFrame(syncRaf);

    function tick() {
      if (!enabled || !fullScriptLoaded) return;

      const video = document.querySelector("video");
      if (video) {
        const currentTime = video.currentTime;
        let activeIdx = -1;

        // Find the line that matches current time
        for (let i = allLines.length - 1; i >= 0; i--) {
          if (currentTime >= allLines[i].startTime) {
            activeIdx = i;
            break;
          }
        }

        if (activeIdx >= 0) {
          const activeLine = allLines[activeIdx];
          if (!activeLine.el.classList.contains("ss-line-active")) {
            // Clear previous active
            const prev = scriptBody.querySelector(".ss-line-active");
            if (prev) prev.classList.remove("ss-line-active");

            // Mark all lines before as past
            allLines.forEach((l, i) => {
              if (i < activeIdx) l.el.classList.add("ss-line-past");
              else l.el.classList.remove("ss-line-past");
            });

            // Highlight current
            activeLine.el.classList.add("ss-line-active");
            activeLine.el.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        }
      }

      syncRaf = requestAnimationFrame(tick);
    }

    syncRaf = requestAnimationFrame(tick);
  }

  function stopTimeSync() {
    if (syncRaf) {
      cancelAnimationFrame(syncRaf);
      syncRaf = null;
    }
  }

  // ==========================================================
  // Realtime Fallback (DOM observer for when interception fails)
  // ==========================================================

  function startCaptionObserver() {
    if (captionObserver) return;
    lastCaption = "";

    const findCaptionContainer = () => {
      return document.querySelector(".player-timedtext-text-container")
        || document.querySelector(".player-timedtext")
        || document.querySelector("[data-uia='player-timedtext']");
    };

    const processDomCaptions = () => {
      if (fullScriptLoaded) return; // Full script takes priority

      const container = findCaptionContainer();
      if (!container) return;

      const spans = container.querySelectorAll("span");
      const lines = [];
      spans.forEach(s => {
        const t = s.textContent.trim();
        if (t) lines.push(t);
      });

      const captionText = lines.join(" ");
      if (!captionText || captionText === lastCaption) return;
      lastCaption = captionText;

      // Remove waiting message
      if (scriptWaiting.parentNode) scriptWaiting.remove();

      // Clear previous active
      const prev = scriptBody.querySelector(".ss-line-active");
      if (prev) {
        prev.classList.remove("ss-line-active");
        prev.classList.add("ss-line-past");
      }

      const line = document.createElement("div");
      line.className = "ss-line ss-line-active";
      line.textContent = captionText;
      scriptBody.appendChild(line);
      line.scrollIntoView({ behavior: "smooth", block: "center" });

      while (scriptBody.querySelectorAll(".ss-line").length > 500) {
        const first = scriptBody.querySelector(".ss-line");
        if (first) first.remove();
      }
    };

    captionObserver = new MutationObserver(processDomCaptions);
    const target = document.querySelector(".watch-video") || document.querySelector("[class*='player']") || document.body;
    captionObserver.observe(target, { childList: true, subtree: true, characterData: true });

    // TextTrack API fallback
    const hookTextTracks = () => {
      const videos = document.querySelectorAll("video");
      videos.forEach(video => {
        if (video._ssTracked) return;
        video._ssTracked = true;

        const tracks = video.textTracks;
        if (!tracks) return;

        const tryDumpCues = (track) => {
          if (fullScriptLoaded) return;
          if (track.cues && track.cues.length > 10) {
            const cues = [];
            for (let i = 0; i < track.cues.length; i++) {
              cues.push({
                startTime: track.cues[i].startTime,
                endTime: track.cues[i].endTime,
                text: track.cues[i].text?.replace(/<[^>]*>/g, "").trim(),
              });
            }
            renderFullScript(cues);
          }
        };

        for (let i = 0; i < tracks.length; i++) {
          const track = tracks[i];
          if (track.kind === "subtitles" || track.kind === "captions") {
            track.mode = "showing";
            tryDumpCues(track);
          }
        }

        tracks.addEventListener("addtrack", (e) => {
          const track = e.track;
          if (track.kind === "subtitles" || track.kind === "captions") {
            track.mode = "showing";
            setTimeout(() => tryDumpCues(track), 1000);
          }
        });
      });
    };

    hookTextTracks();

    captionObserver._pollInterval = setInterval(() => {
      if (!fullScriptLoaded) processDomCaptions();
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
  // Layout
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
  // Lifecycle
  // ==========================================================

  function startLoop() {
    enabled = true;
    fullScriptLoaded = false;
    allLines = [];
    scriptBody.innerHTML = "";
    scriptBody.appendChild(scriptWaiting);
    scriptHeader.textContent = "SCRIPT SCROLL";
    enableSideBySide();
    injectInterceptor();
    startCaptionObserver();
  }

  function stopLoop() {
    enabled = false;
    fullScriptLoaded = false;
    allLines = [];
    disableSideBySide();
    stopCaptionObserver();
    stopTimeSync();
  }

  // ==========================================================
  // Message Listener
  // ==========================================================

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "ss:toggle") {
      if (message.enabled) startLoop();
      else stopLoop();
    }
  });
})();
