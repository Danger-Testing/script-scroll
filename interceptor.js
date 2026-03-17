// ============================================================
// Script Scroll — Fetch Interceptor (runs in page MAIN world)
// Captures Netflix TTML subtitle files from network requests
// ============================================================

(() => {
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";

      // Netflix subtitle requests contain "?o=" in the URL
      // and come from nflxvideo.net or similar CDN domains
      if (url.includes("?o=") && !url.includes("/range/")) {
        const clone = response.clone();
        clone.text().then(text => {
          // Check if it's TTML/XML subtitle content
          if (text.includes("<tt") || text.includes("<body") || text.includes("<p ")) {
            window.postMessage({
              type: "ss:subtitles-intercepted",
              data: text,
              url: url,
            }, "*");
          }
        }).catch(() => {});
      }
    } catch (e) {
      // Don't break the page if interception fails
    }

    return response;
  };

  // Also intercept XMLHttpRequest for older players
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ssUrl = url;
    return originalXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const url = this._ssUrl || "";
        if (url.includes("?o=") && !url.includes("/range/")) {
          const text = this.responseText;
          if (text && (text.includes("<tt") || text.includes("<body") || text.includes("<p "))) {
            window.postMessage({
              type: "ss:subtitles-intercepted",
              data: text,
              url: url,
            }, "*");
          }
        }
      } catch (e) {}
    });
    return originalXHRSend.apply(this, args);
  };
})();
