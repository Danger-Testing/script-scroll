// ============================================================
// Script Scroll — Background Service Worker
// ============================================================

const enabledTabs = new Map();

chrome.tabs.onRemoved.addListener((tabId) => {
  enabledTabs.delete(tabId);
});

// --- Extension Icon Toggle ---
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  const nextEnabled = !(enabledTabs.get(tab.id) ?? false);
  enabledTabs.set(tab.id, nextEnabled);

  chrome.action.setBadgeText({ tabId: tab.id, text: nextEnabled ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#000000" });

  chrome.tabs.sendMessage(tab.id, { type: "ss:toggle", enabled: nextEnabled }, () => {
    void chrome.runtime.lastError;
  });
});

// --- Screenshot Handler ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "ss:screenshot") return;
  const tab = sender.tab;
  if (!tab?.windowId) { sendResponse({}); return; }
  chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }, (dataUrl) => {
    sendResponse({ dataUrl });
  });
  return true;
});
