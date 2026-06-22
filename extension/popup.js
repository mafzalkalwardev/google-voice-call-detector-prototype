// This file saves extension settings used by the injected Google Voice floating panel.

const backendUrlInput = document.getElementById("backend-url");
const durationSelect = document.getElementById("duration");
const statusElement = document.getElementById("popup-status");

chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (settings) => {
  backendUrlInput.value = settings?.backendUrl || "http://localhost:3100";
  durationSelect.value = String(settings?.detectionDurationSeconds || 10);
});

document.getElementById("save-settings").addEventListener("click", () => {
  chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    backendUrl: backendUrlInput.value.trim() || "http://localhost:3100",
    detectionDurationSeconds: Number(durationSelect.value)
  }, () => {
    statusElement.textContent = "Settings saved.";
  });
});
