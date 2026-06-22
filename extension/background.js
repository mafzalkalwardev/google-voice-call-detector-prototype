// This file keeps small extension-wide state and never contacts Google private APIs or internal endpoints.

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    backendUrl: "http://localhost:3100",
    detectionDurationSeconds: 10
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_SETTINGS") {
    chrome.storage.local.get(["backendUrl", "detectionDurationSeconds"], (settings) => {
      sendResponse({
        backendUrl: settings.backendUrl || "http://localhost:3100",
        detectionDurationSeconds: settings.detectionDurationSeconds || 10
      });
    });

    return true;
  }

  if (message?.type === "SAVE_SETTINGS") {
    chrome.storage.local.set({
      backendUrl: message.backendUrl || "http://localhost:3100",
      detectionDurationSeconds: Number(message.detectionDurationSeconds) === 5 ? 5 : 10
    }, () => sendResponse({ ok: true }));

    return true;
  }

  return false;
});
