// This file injects the floating Google Voice control panel and records only after the user clicks Start Detection.

const PANEL_ID = "gv-call-detection-panel";
const DEFAULT_BACKEND_URL = "http://localhost:3100";

let mediaRecorder = null;
let captureStream = null;
let audioRecordStream = null;
let recordingChunks = [];
let timerInterval = null;
let callWatchInterval = null;
let audioContext = null;
let analyser = null;
let sourceNode = null;
let audioDestinationNode = null;
let rmsSamples = [];
let peakSamples = [];
let recordingStartedAt = 0;
let selectedDurationSeconds = 10;
let isArmedForNextCall = false;
let isStartingRecorder = false;
let recordedMimeType = "audio/webm";
let debugLines = [];
let passiveStateInterval = null;
let cachedBackendUrl = DEFAULT_BACKEND_URL;
let cachedDurationSeconds = 10;
let uploadSessionId = null;
let uploadChunkIndex = 0;
let uploadChunkPromises = [];
let streamedUploadEnabled = false;
let partialRequestInFlight = false;
let lastPartialRequestAt = 0;
let earlyResultPayload = null;

function isGoogleVoicePage() {
  return window.location.hostname === "voice.google.com";
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            error: chrome.runtime.lastError.message
          });
          return;
        }

        resolve(response || {});
      });
    } catch (error) {
      resolve({
        error: error.message
      });
    }
  });
}

function createPanel() {
  if (!isGoogleVoicePage() || document.getElementById(PANEL_ID)) {
    return;
  }

  const panel = document.createElement("section");
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="gvcd-header">
      <div>
        <strong>Call Detector</strong>
        <span id="gvcd-page-state">Google Voice page detected</span>
      </div>
      <button id="gvcd-collapse" type="button" title="Collapse panel">-</button>
    </div>
    <div id="gvcd-body">
      <label class="gvcd-field">
        <span>Duration</span>
        <select id="gvcd-duration">
          <option value="5">5 seconds</option>
          <option value="10" selected>10 seconds</option>
        </select>
      </label>
      <div class="gvcd-actions">
        <button id="gvcd-start" type="button">Start Detection</button>
        <button id="gvcd-stop" type="button" disabled>Stop Detection</button>
      </div>
      <dl class="gvcd-status-list">
        <div><dt>Status</dt><dd id="gvcd-status">Idle</dd></div>
        <div><dt>Timer</dt><dd id="gvcd-timer">0.0s</dd></div>
        <div><dt>Transcript</dt><dd id="gvcd-transcript">-</dd></div>
        <div><dt>Classification</dt><dd id="gvcd-classification">-</dd></div>
        <div><dt>Debug</dt><dd id="gvcd-debug">No debug events yet.</dd></div>
      </dl>
    </div>
  `;

  document.documentElement.appendChild(panel);

  panel.querySelector("#gvcd-start").addEventListener("click", startDetection);
  panel.querySelector("#gvcd-stop").addEventListener("click", () => stopDetection("Stopped by user."));
  panel.querySelector("#gvcd-duration").addEventListener("change", saveDuration);
  panel.querySelector("#gvcd-collapse").addEventListener("click", () => {
    panel.classList.toggle("gvcd-collapsed");
  });

  loadDuration();
  updateCallStateLabel();
}

function startPassiveStatePolling() {
  if (passiveStateInterval) {
    return;
  }

  passiveStateInterval = window.setInterval(() => {
    if (!document.getElementById(PANEL_ID)) {
      return;
    }

    if (!isArmedForNextCall && mediaRecorder?.state !== "recording") {
      updateCallStateLabel();
    }
  }, 1000);
}

async function loadDuration() {
  const settings = await sendRuntimeMessage({ type: "GET_SETTINGS" });
  const durationSelect = document.getElementById("gvcd-duration");

  if (settings.error) {
    addDebug("Settings load failed; using cached defaults", { message: settings.error });
  } else {
    cachedBackendUrl = settings.backendUrl || DEFAULT_BACKEND_URL;
    cachedDurationSeconds = settings.detectionDurationSeconds || 10;
  }

  if (durationSelect) {
    durationSelect.value = String(cachedDurationSeconds);
  }
}

async function saveDuration() {
  const duration = Number(document.getElementById("gvcd-duration").value);
  const settings = await sendRuntimeMessage({ type: "GET_SETTINGS" });
  const backendUrl = settings.error
    ? cachedBackendUrl
    : settings.backendUrl || DEFAULT_BACKEND_URL;

  const saved = await sendRuntimeMessage({
    type: "SAVE_SETTINGS",
    backendUrl,
    detectionDurationSeconds: duration
  });

  cachedBackendUrl = backendUrl;
  cachedDurationSeconds = duration;

  if (saved.error) {
    addDebug("Settings save failed; using page cache", { message: saved.error });
  }
}

function setText(id, value) {
  const element = document.getElementById(id);

  if (element) {
    element.textContent = value;
  }
}

function addDebug(message, data = null) {
  const timestamp = new Date().toLocaleTimeString();
  const suffix = data ? ` ${JSON.stringify(data)}` : "";
  debugLines.push(`${timestamp} ${message}${suffix}`);
  debugLines = debugLines.slice(-12);
  setText("gvcd-debug", debugLines.join("\n"));
  console.debug("[GV Call Detector]", message, data || "");
}

function summarizeTracks(stream) {
  if (!stream) {
    return [];
  }

  return stream.getTracks().map((track) => ({
    kind: track.kind,
    label: track.label,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    settings: track.getSettings ? track.getSettings() : {}
  }));
}

function setRecordingControls(isRecording) {
  const startButton = document.getElementById("gvcd-start");
  const stopButton = document.getElementById("gvcd-stop");
  const durationSelect = document.getElementById("gvcd-duration");

  if (startButton) {
    startButton.disabled = isRecording || isArmedForNextCall;
  }

  if (stopButton) {
    stopButton.disabled = !isRecording && !isArmedForNextCall;
  }

  if (durationSelect) {
    durationSelect.disabled = isRecording || isArmedForNextCall;
  }
}

function startTimer(maxSeconds) {
  recordingStartedAt = Date.now();
  setText("gvcd-timer", "0.0s");

  timerInterval = window.setInterval(() => {
    const elapsed = (Date.now() - recordingStartedAt) / 1000;
    setText("gvcd-timer", `${Math.min(elapsed, maxSeconds).toFixed(1)}s`);
  }, 100);
}

function stopTimer() {
  if (timerInterval) {
    window.clearInterval(timerInterval);
    timerInterval = null;
  }
}

function findEndCallButton() {
  const candidates = [
    'button[gv-test-id="in-call-end-call"]',
    'button.call-end-button',
    'button[aria-label="Hang up call"]',
    'button[aria-label*="End call"]',
    'button[aria-label*="end call"]',
    'button[aria-label*="End"]',
    'button[aria-label*="end"]',
    'button[aria-label*="Hang up"]',
    'button[aria-label*="hang up"]',
    '[role="button"][aria-label*="End call"]',
    '[role="button"][aria-label*="end call"]',
    '[role="button"][aria-label*="End"]',
    '[role="button"][aria-label*="end"]',
    '[role="button"][aria-label*="Hang up"]',
    '[role="button"][aria-label*="hang up"]',
    '[data-tooltip*="End call"]',
    '[data-tooltip*="Hang up"]'
  ];

  for (const selector of candidates) {
    const nodes = [...document.querySelectorAll(selector)].slice(0, 20);
    const button = nodes.find((node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      const label = `${node.getAttribute("aria-label") || ""} ${node.getAttribute("data-tooltip") || ""} ${node.textContent || ""}`.toLowerCase();
      return (
        (label.includes("end") || label.includes("hang up")) &&
        !label.includes("weekend") &&
        !label.includes("ending soon")
      );
    });

    if (button instanceof HTMLElement) {
      return button;
    }
  }

  return null;
}

function isCallUiActive() {
  if (findEndCallButton()) {
    return true;
  }

  const inCallSelectors = [
    '[gv-test-id="in-call-end-call"]',
    '[data-tooltip*="End call"]',
    '[data-tooltip*="Hang up"]',
    '[aria-label*="Mute"]',
    '[aria-label*="mute"]',
    '[aria-label*="Keypad"]',
    '[aria-label*="keypad"]',
    '[aria-label*="Speaker"]',
    '[aria-label*="speaker"]',
    '[aria-label*="Transfer"]',
    '[aria-label*="transfer"]'
  ];

  return inCallSelectors.some((selector) => document.querySelector(selector));
}

function getLikelyCallContainers() {
  const endButton = findEndCallButton();
  const containers = [];

  if (!endButton) {
    return containers;
  }

  let current = endButton.parentElement;

  for (let depth = 0; current && depth < 7; depth += 1) {
    if (current instanceof HTMLElement) {
      containers.push(current);
    }

    current = current.parentElement;
  }

  return containers;
}

function extractDurationSeconds(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const match = normalized.match(/\b([0-5]?\d):([0-5]\d)\b/);

  if (!match) {
    return null;
  }

  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const totalSeconds = minutes * 60 + seconds;

  return totalSeconds > 0 ? totalSeconds : null;
}

function findVisibleCallTimer() {
  if (!isCallUiActive()) {
    return null;
  }

  const timerSelectors = [
    '[aria-label*="duration" i]',
    '[aria-label*="elapsed" i]',
    '[aria-label*="call time" i]',
    '[data-tooltip*="duration" i]',
    '[data-tooltip*="elapsed" i]',
    '[data-tooltip*="call time" i]',
    'span',
    'div'
  ];

  for (const container of getLikelyCallContainers()) {
    const candidates = [];

    if (container instanceof HTMLElement) {
      candidates.push(container);
    }

    for (const selector of timerSelectors) {
      candidates.push(...[...container.querySelectorAll(selector)].slice(0, 80));
    }

    for (const node of candidates) {
      if (!(node instanceof HTMLElement) || node.closest(`#${PANEL_ID}`)) {
        continue;
      }

      const rect = node.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;

      if (!visible) {
        continue;
      }

      const label = `${node.getAttribute("aria-label") || ""} ${node.getAttribute("data-tooltip") || ""} ${node.textContent || ""}`;
      const compactText = String(node.textContent || "").replace(/\s+/g, " ").trim();
      const semanticLabel = `${node.getAttribute("aria-label") || ""} ${node.getAttribute("data-tooltip") || ""}`.toLowerCase();
      const looksLikeSmallTimerNode = compactText.length > 0 && compactText.length <= 12;
      const hasTimerSemantics = (
        semanticLabel.includes("duration") ||
        semanticLabel.includes("elapsed") ||
        semanticLabel.includes("call time")
      );

      if (!looksLikeSmallTimerNode && !hasTimerSemantics) {
        continue;
      }

      const durationSeconds = extractDurationSeconds(label);

      if (durationSeconds !== null) {
        return {
          text: label.replace(/\s+/g, " ").trim().slice(0, 80),
          durationSeconds
        };
      }
    }
  }

  return null;
}

function isCallTimerRunning() {
  return Boolean(findVisibleCallTimer());
}

function updateCallStateLabel() {
  const timer = findVisibleCallTimer();
  const state = timer
    ? `Call timer active ${timer.durationSeconds}s`
    : isCallUiActive()
      ? "Call dialing/ringing"
      : "Waiting for call";
  setText("gvcd-page-state", state);
}

function stopCallWatcher() {
  if (callWatchInterval) {
    window.clearInterval(callWatchInterval);
    callWatchInterval = null;
  }
}

function watchForCallStart() {
  stopCallWatcher();
  updateCallStateLabel();

  callWatchInterval = window.setInterval(() => {
    updateCallStateLabel();

    if (isArmedForNextCall && isCallTimerRunning()) {
      const timer = findVisibleCallTimer();
      addDebug("Google Voice call timer detected", timer);
      startRecordingFromCapturedAudio();
    }

    // Once recording starts, keep the sample running for the selected 5/10 seconds.
    // Google Voice briefly swaps call UI elements during dialing/connecting, and treating
    // that transition as a hangup caused sub-second recordings.
  }, 300);
}

async function setupAudioPipeline(stream) {
  const audioTracks = stream.getAudioTracks();

  if (audioTracks.length === 0) {
    throw new Error("No audio track was captured. Choose a Chrome tab and enable 'Share tab audio'.");
  }

  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  sourceNode = audioContext.createMediaStreamSource(stream);
  audioDestinationNode = audioContext.createMediaStreamDestination();
  sourceNode.connect(analyser);
  sourceNode.connect(audioDestinationNode);

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  addDebug("Audio pipeline ready", {
    audioContextState: audioContext.state,
    inputTracks: summarizeTracks(stream),
    outputTracks: summarizeTracks(audioDestinationNode.stream)
  });

  const timeDomain = new Float32Array(analyser.fftSize);

  function sample() {
    if (!analyser) {
      return;
    }

    analyser.getFloatTimeDomainData(timeDomain);

    let sumSquares = 0;
    let peak = 0;

    for (const sampleValue of timeDomain) {
      sumSquares += sampleValue * sampleValue;
      peak = Math.max(peak, Math.abs(sampleValue));
    }

    rmsSamples.push(Math.sqrt(sumSquares / timeDomain.length));
    peakSamples.push(peak);
    window.requestAnimationFrame(sample);
  }

  sample();
  return audioDestinationNode.stream;
}

async function requestDisplayCaptureWithFallbacks() {
  const audioConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  };
  const attempts = [
    {
      label: "current-tab low-video",
      constraints: {
        video: {
          frameRate: { ideal: 1, max: 5 },
          width: { ideal: 320, max: 640 },
          height: { ideal: 180, max: 360 }
        },
        audio: audioConstraints,
        preferCurrentTab: true
      }
    },
    {
      label: "low-video",
      constraints: {
        video: {
          frameRate: { ideal: 1, max: 5 },
          width: { ideal: 320, max: 640 },
          height: { ideal: 180, max: 360 }
        },
        audio: audioConstraints
      }
    },
    {
      label: "browser-default",
      constraints: {
        video: true,
        audio: audioConstraints
      }
    }
  ];

  let lastError = null;

  for (const attempt of attempts) {
    try {
      addDebug("Trying display capture", { label: attempt.label });
      const stream = await navigator.mediaDevices.getDisplayMedia(attempt.constraints);
      addDebug("Display capture succeeded", {
        label: attempt.label,
        tracks: summarizeTracks(stream)
      });
      return stream;
    } catch (error) {
      lastError = error;
      addDebug("Display capture failed", {
        label: attempt.label,
        name: error.name,
        message: error.message
      });
    }
  }

  throw lastError || new Error("Unable to start tab capture.");
}

async function startDetection() {
  if (mediaRecorder?.state === "recording" || isArmedForNextCall) {
    return;
  }

  const settings = await sendRuntimeMessage({ type: "GET_SETTINGS" });
  if (settings.error) {
    addDebug("Settings refresh failed before capture; using cache", { message: settings.error });
  } else {
    cachedBackendUrl = settings.backendUrl || DEFAULT_BACKEND_URL;
    cachedDurationSeconds = settings.detectionDurationSeconds || 10;
  }

  selectedDurationSeconds = Number(document.getElementById("gvcd-duration")?.value || 10);
  cachedDurationSeconds = selectedDurationSeconds;

  setText("gvcd-status", "Requesting capture permission...");
  setText("gvcd-transcript", "-");
  setText("gvcd-classification", "-");
  debugLines = [];
  addDebug("Start clicked", { selectedDurationSeconds });

  try {
    if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) {
      throw new Error("Unsupported browser capture. Chrome with screen/tab audio capture is required.");
    }

    addDebug("Media support", {
      audioWebmOpus: MediaRecorder.isTypeSupported("audio/webm;codecs=opus"),
      audioWebm: MediaRecorder.isTypeSupported("audio/webm"),
      videoWebmOpus: MediaRecorder.isTypeSupported("video/webm;codecs=opus"),
      videoWebmVp8Opus: MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
    });

    captureStream = await requestDisplayCaptureWithFallbacks();

    addDebug("Capture granted", { tracks: summarizeTracks(captureStream) });

    const audioTracks = captureStream.getAudioTracks();

    if (audioTracks.length === 0) {
      throw new Error("No audio track was captured. Choose the Google Voice tab and enable 'Share tab audio'.");
    }

    recordingChunks = [];
    rmsSamples = [];
    peakSamples = [];
    audioRecordStream = await setupAudioPipeline(new MediaStream(audioTracks));

    isArmedForNextCall = true;
    setRecordingControls(false);
    setText(
      "gvcd-status",
      isCallUiActive()
        ? "Armed. Waiting for Google Voice call timer..."
        : "Armed. Dial a call; recording starts when the call timer starts."
    );
    addDebug("Armed for answered call", {
      callUiActive: isCallUiActive(),
      callTimer: findVisibleCallTimer()
    });
    watchForCallStart();
  } catch (error) {
    addDebug("Capture setup failed", { name: error.name, message: error.message });
    cleanupCapture();
    setRecordingControls(false);
    setText("gvcd-status", `Capture error: ${error.message}. Try selecting the Google Voice tab, keep it visible, and enable Share tab audio.`);
  }
}

function getRecorderCandidates() {
  const candidates = [];

  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
    candidates.push({
      label: "audio-pipeline audio/webm;codecs=opus",
      stream: audioRecordStream,
      options: { mimeType: "audio/webm;codecs=opus" }
    });
  }

  if (MediaRecorder.isTypeSupported("audio/webm")) {
    candidates.push({
      label: "audio-pipeline audio/webm",
      stream: audioRecordStream,
      options: { mimeType: "audio/webm" }
    });
  }

  candidates.push({
    label: "audio-pipeline browser-default",
    stream: audioRecordStream,
    options: {}
  });

  if (captureStream && MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")) {
    candidates.push({
      label: "capture-stream video/webm;codecs=vp8,opus",
      stream: captureStream,
      options: { mimeType: "video/webm;codecs=vp8,opus" }
    });
  }

  if (captureStream && MediaRecorder.isTypeSupported("video/webm")) {
    candidates.push({
      label: "capture-stream video/webm",
      stream: captureStream,
      options: { mimeType: "video/webm" }
    });
  }

  return candidates;
}

async function startUploadSession() {
  uploadSessionId = null;
  uploadChunkIndex = 0;
  uploadChunkPromises = [];
  streamedUploadEnabled = false;
  partialRequestInFlight = false;
  lastPartialRequestAt = 0;
  earlyResultPayload = null;

  const backendUrl = cachedBackendUrl || DEFAULT_BACKEND_URL;
  const response = await fetch(`${backendUrl}/api/recording-session`, {
    method: "POST"
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.success || !payload.sessionId) {
    throw new Error(payload?.message || "Could not create backend recording session.");
  }

  uploadSessionId = payload.sessionId;
  streamedUploadEnabled = true;
  addDebug("Upload session started", { backendUrl, sessionId: uploadSessionId });
}

function queueChunkUpload(blob) {
  if (!streamedUploadEnabled || !uploadSessionId || !blob?.size) {
    return;
  }

  const backendUrl = cachedBackendUrl || DEFAULT_BACKEND_URL;
  const index = uploadChunkIndex;
  uploadChunkIndex += 1;

  const chunkFormData = new FormData();
  chunkFormData.append("chunk", blob, `chunk-${String(index).padStart(6, "0")}.webm`);
  chunkFormData.append("index", String(index));

  const uploadPromise = fetch(`${backendUrl}/api/recording-session/${uploadSessionId}/chunk`, {
    method: "POST",
    body: chunkFormData
  })
    .then(async (response) => {
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.success) {
        throw new Error(payload?.message || `Chunk ${index} upload failed.`);
      }

      addDebug("Chunk uploaded", { index, size: blob.size });
      maybeRequestPartialClassification(index + 1);
      return payload;
    })
    .catch((error) => {
      addDebug("Chunk upload failed", { index, message: error.message });
      throw error;
    });

  uploadChunkPromises.push(uploadPromise);
}

function isConfidentTerminalClassification(payload) {
  const terminalClassifications = new Set([
    "human",
    "voicemail",
    "busy",
    "carrier_message",
    "disconnected"
  ]);

  return (
    payload?.success &&
    terminalClassifications.has(payload.classification) &&
    Number(payload.confidence || 0) >= 0.65
  );
}

async function maybeRequestPartialClassification(uploadedChunkCount) {
  if (
    !streamedUploadEnabled ||
    !uploadSessionId ||
    partialRequestInFlight ||
    earlyResultPayload ||
    mediaRecorder?.state !== "recording"
  ) {
    return;
  }

  const now = Date.now();

  if (now - lastPartialRequestAt < 900) {
    return;
  }

  partialRequestInFlight = true;
  lastPartialRequestAt = now;

  try {
    const elapsedSeconds = Math.max(1, (Date.now() - recordingStartedAt) / 1000);
    const backendUrl = cachedBackendUrl || DEFAULT_BACKEND_URL;
    const avgRms = rmsSamples.length
      ? rmsSamples.reduce((sum, value) => sum + value, 0) / rmsSamples.length
      : 0;
    const maxPeak = peakSamples.length ? Math.max(...peakSamples) : 0;

    addDebug("Requesting partial classification", {
      uploadedChunkCount,
      elapsedSeconds: Number(elapsedSeconds.toFixed(2))
    });

    const response = await fetch(`${backendUrl}/api/recording-session/${uploadSessionId}/partial`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        durationSeconds: elapsedSeconds,
        rms: avgRms,
        peak: maxPeak
      })
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload?.success) {
      throw new Error(payload?.message || "Partial classification failed.");
    }

    addDebug("Partial backend response", {
      classification: payload.classification,
      confidence: payload.confidence,
      transcript: payload.transcript,
      chunkCount: payload.chunkCount
    });

    if (isConfidentTerminalClassification(payload)) {
      earlyResultPayload = payload;
      streamedUploadEnabled = false;
      setText("gvcd-status", "Early result found. Stopping recorder...");

      if (mediaRecorder?.state === "recording") {
        mediaRecorder.stop();
      }
    }
  } catch (error) {
    addDebug("Partial classification failed", { message: error.message });
  } finally {
    partialRequestInFlight = false;
  }
}

function attachRecorderEvents(recorder) {
  recorder.addEventListener("dataavailable", (event) => {
    addDebug("Recorder dataavailable", { size: event.data?.size || 0, type: event.data?.type || "" });
    if (event.data?.size > 0) {
      recordingChunks.push(event.data);
      queueChunkUpload(event.data);
    }
  });
  recorder.addEventListener("start", () => {
    addDebug("Recorder started", { state: recorder.state, mimeType: recorder.mimeType });
  });
  recorder.addEventListener("pause", () => addDebug("Recorder paused"));
  recorder.addEventListener("resume", () => addDebug("Recorder resumed"));
  recorder.addEventListener("error", (event) => {
    addDebug("Recorder async error", {
      name: event.error?.name,
      message: event.error?.message
    });
  });
  recorder.addEventListener("stop", () => uploadRecording(selectedDurationSeconds), { once: true });
}

async function createAndStartRecorder() {
  const candidates = getRecorderCandidates();
  let lastError = null;

  for (const candidate of candidates) {
    try {
      addDebug("Trying recorder candidate", {
        label: candidate.label,
        options: candidate.options,
        tracks: summarizeTracks(candidate.stream)
      });

      const recorder = new MediaRecorder(candidate.stream, candidate.options);
      attachRecorderEvents(recorder);
      recorder.start(1000);
      recordedMimeType = recorder.mimeType || candidate.options.mimeType || "audio/webm";
      mediaRecorder = recorder;
      addDebug("Recorder start requested", {
        label: candidate.label,
        state: recorder.state,
        mimeType: recordedMimeType
      });
      return recorder;
    } catch (error) {
      lastError = error;
      addDebug("Recorder candidate failed", {
        label: candidate.label,
        name: error.name,
        message: error.message
      });
    }
  }

  throw lastError || new Error("No MediaRecorder candidate could start.");
}

async function startRecordingFromCapturedAudio() {
  if (!isArmedForNextCall || isStartingRecorder || mediaRecorder?.state === "recording") {
    return;
  }

  if (!audioRecordStream || audioRecordStream.getAudioTracks().length === 0) {
    cleanupCapture();
    setRecordingControls(false);
    setText("gvcd-status", "Capture error: no tab audio track is available.");
    return;
  }

  isStartingRecorder = true;

  try {
    if (audioContext?.state === "suspended") {
      await audioContext.resume();
    }

    addDebug("Creating MediaRecorder", {
      audioContextState: audioContext?.state,
      recordTracks: summarizeTracks(audioRecordStream),
      captureTracks: summarizeTracks(captureStream)
    });

    recordingChunks = [];
    recordingStartedAt = Date.now();
    try {
      await startUploadSession();
    } catch (error) {
      addDebug("Upload session unavailable; using final upload fallback", { message: error.message });
      streamedUploadEnabled = false;
    }
    await createAndStartRecorder();

    isArmedForNextCall = false;
    setRecordingControls(true);
    setText("gvcd-status", "Call detected. Recording first audio segment...");
    startTimer(selectedDurationSeconds);

    window.setTimeout(() => {
      if (mediaRecorder?.state === "recording") {
        stopDetection("Recording complete. Uploading...");
      }
    }, selectedDurationSeconds * 1000);
  } catch (error) {
    addDebug("Recorder start failed", {
      name: error.name,
      message: error.message,
      recordTracks: summarizeTracks(audioRecordStream),
      captureTracks: summarizeTracks(captureStream),
      audioContextState: audioContext?.state
    });
    cleanupCapture();
    setRecordingControls(false);
    setText("gvcd-status", `Recorder error: ${error.message}`);
  } finally {
    isStartingRecorder = false;
  }
}

function stopDetection(statusText) {
  setText("gvcd-status", statusText);
  stopTimer();
  isArmedForNextCall = false;

  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
  } else {
    cleanupCapture();
    setRecordingControls(false);
  }
}

function displayBackendResult(payload) {
  addDebug("Backend response", {
    classification: payload.classification,
    confidence: payload.confidence,
    durationSeconds: payload.durationSeconds,
    transcriptionProvider: payload.transcriptionProvider,
    warning: payload.warning,
    partial: payload.partial
  });
  setText("gvcd-status", payload.warning ? `Complete with warning: ${payload.warning}` : "Complete");
  setText("gvcd-transcript", payload.transcript || "(empty transcript)");
  setText(
    "gvcd-classification",
    `${payload.classification} (${Math.round((payload.confidence || 0) * 100)}%) via ${payload.transcriptionProvider || "unknown"}`
  );
}

async function uploadRecording(selectedDurationSeconds) {
  const actualDurationSeconds = (Date.now() - recordingStartedAt) / 1000;
  const blob = new Blob(recordingChunks, { type: recordedMimeType || "audio/webm" });
  const avgRms = rmsSamples.length
    ? rmsSamples.reduce((sum, value) => sum + value, 0) / rmsSamples.length
    : 0;
  const maxPeak = peakSamples.length ? Math.max(...peakSamples) : 0;

  cleanupCapture();

  addDebug("Upload prepared", {
    blobSize: blob.size,
    chunkCount: recordingChunks.length,
    avgRms,
    maxPeak,
    actualDurationSeconds
  });

  if (earlyResultPayload) {
    const backendUrl = cachedBackendUrl || DEFAULT_BACKEND_URL;
    const sessionId = uploadSessionId;
    const chunkPromises = [...uploadChunkPromises];

    displayBackendResult(earlyResultPayload);

    if (sessionId) {
      Promise.allSettled(chunkPromises)
        .then(() => fetch(`${backendUrl}/api/recording-session/${sessionId}`, { method: "DELETE" }))
        .catch(() => {});
    }

    earlyResultPayload = null;
    uploadSessionId = null;
    uploadChunkPromises = [];
    uploadChunkIndex = 0;
    streamedUploadEnabled = false;
    setRecordingControls(false);
    return;
  }

  if (blob.size === 0) {
    setRecordingControls(false);
    setText("gvcd-status", "Capture failed: no audio data was recorded.");
    return;
  }

  try {
    const backendUrl = cachedBackendUrl || DEFAULT_BACKEND_URL;

    setText("gvcd-status", streamedUploadEnabled ? "Finalizing backend transcription..." : "Uploading to backend...");
    addDebug(streamedUploadEnabled ? "Finalizing streamed upload" : "Uploading", {
      backendUrl,
      sessionId: uploadSessionId,
      durationSeconds: Math.min(actualDurationSeconds, selectedDurationSeconds),
      queuedChunks: uploadChunkPromises.length
    });

    try {
      const healthResponse = await fetch(`${backendUrl}/health`, { method: "GET" });

      if (!healthResponse.ok) {
        throw new Error(`Health check returned HTTP ${healthResponse.status}`);
      }
    } catch (error) {
      throw new Error(`Backend offline or wrong URL (${backendUrl}). ${error.message}`);
    }

    let response;

    if (streamedUploadEnabled && uploadSessionId) {
      await Promise.all(uploadChunkPromises);

      response = await fetch(`${backendUrl}/api/recording-session/${uploadSessionId}/finalize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          durationSeconds: Math.min(actualDurationSeconds, selectedDurationSeconds),
          rms: avgRms,
          peak: maxPeak
        })
      });
    } else {
      const formData = new FormData();

      formData.append("audio", blob, "google-voice-call.webm");
      formData.append("durationSeconds", String(Math.min(actualDurationSeconds, selectedDurationSeconds)));
      formData.append("rms", String(avgRms));
      formData.append("peak", String(maxPeak));

      response = await fetch(`${backendUrl}/api/transcribe-classify`, {
        method: "POST",
        body: formData
      });
    }

    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload?.success) {
      throw new Error(payload?.message || "Backend offline or transcription failed.");
    }

    displayBackendResult(payload);
  } catch (error) {
    addDebug("Backend request failed", { name: error.name, message: error.message });
    setText("gvcd-status", `Backend error: ${error.message}`);
  } finally {
    uploadSessionId = null;
    uploadChunkPromises = [];
    uploadChunkIndex = 0;
    streamedUploadEnabled = false;
    partialRequestInFlight = false;
    setRecordingControls(false);
  }
}

function cleanupCapture() {
  stopTimer();
  stopCallWatcher();

  if (captureStream) {
    captureStream.getTracks().forEach((track) => track.stop());
    captureStream = null;
  }

  audioRecordStream = null;

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  if (audioDestinationNode) {
    audioDestinationNode.disconnect();
    audioDestinationNode = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  analyser = null;
  mediaRecorder = null;
  isArmedForNextCall = false;
  isStartingRecorder = false;
  partialRequestInFlight = false;
  updateCallStateLabel();
}

createPanel();
startPassiveStatePolling();

let lastUrl = location.href;
new MutationObserver((mutations) => {
  const onlyPanelChanged = mutations.every((mutation) => {
    const target = mutation.target;
    return target instanceof HTMLElement && Boolean(target.closest(`#${PANEL_ID}`));
  });

  if (onlyPanelChanged) {
    return;
  }

  if (location.href !== lastUrl) {
    lastUrl = location.href;
    createPanel();
  }
}).observe(document.documentElement, { childList: true, subtree: true });
