# Google Voice Call Detection Prototype

## Overview

This university prototype estimates whether a Google Voice call was answered by a human, voicemail, busy line, carrier message, disconnected line, silence, or an unknown state.

The system does not reverse-engineer Google Voice, use private Google APIs, use Google cookies, or call internal Google endpoints. The Chrome extension only uses browser audio capture, visible Google Voice UI state, and this project's local backend.

## Project Layout

```text
backend/
  server.js                 Express API and recording-session endpoints
  src/audioAnalysis.js      Basic audio metadata and silence heuristics
  src/classifier.js         Rule-based transcript classifier
  src/transcriber.js        Local whisper.cpp transcription wrapper
  uploads/                  Temporary upload/chunk directory

extension/
  manifest.json             Chrome Extension Manifest V3 config
  background.js             Extension settings storage
  content.js                Google Voice floating panel, capture, streaming upload
  popup.html                Backend URL/duration settings popup
  popup.js                  Popup behavior
  styles.css                Floating panel and popup styling
```

## High-Level Flow

1. User opens `https://voice.google.com/`.
2. User clicks **Start Detection** in the floating panel.
3. Chrome asks for capture permission.
4. User selects the Google Voice tab and enables tab audio.
5. Extension enters standby mode.
6. User dials a call.
7. Extension waits until the visible Google Voice call timer starts.
8. Extension records call audio in 1-second chunks.
9. Chunks are uploaded to the backend while recording continues.
10. Backend can transcribe/classify partial uploaded audio.
11. If a confident result appears early, recording stops and the result is shown.
12. If no confident result appears, recording finalizes at 5 or 10 seconds.

## Chrome Extension Behavior

The extension runs only on:

```text
https://voice.google.com/*
```

It injects a floating control panel with:

- Start Detection
- Stop Detection
- Status
- Timer
- Transcript
- Classification
- Debug log

Start Detection does not immediately record. It arms the system. Recording starts only after Google Voice shows an active call duration timer, which indicates that the call was answered by a person, voicemail, or carrier system.

## Backend Behavior

The backend is a Node.js Express app. It supports both single-upload and streamed recording-session flows.

Main endpoints:

```text
GET    /health
POST   /api/transcribe-classify
POST   /api/recording-session
POST   /api/recording-session/:sessionId/chunk
POST   /api/recording-session/:sessionId/partial
POST   /api/recording-session/:sessionId/finalize
DELETE /api/recording-session/:sessionId
```

The progressive flow is used for speed:

- `/api/recording-session` creates a temporary upload session.
- `/chunk` receives 1-second WebM chunks while recording is still happening.
- `/partial` combines the chunks already uploaded and runs whisper/classification.
- `/finalize` combines all chunks and runs the final classification.
- `DELETE` cleans up early-result sessions.

## Local whisper.cpp

This project uses local `whisper.cpp`, not OpenAI or any cloud transcription API.

Example `.env`:

```env
PORT=3100
WHISPER_CPP_BIN=C:\tools\whisper.cpp\build\bin\whisper-cli.exe
WHISPER_CPP_MODEL=C:\tools\whisper.cpp\models\ggml-base.en.bin
FFMPEG_BIN=ffmpeg
WHISPER_CPP_USE_GPU=false
WHISPER_CPP_LANGUAGE=en
WHISPER_CPP_TIMEOUT_MS=120000
```

Chrome records WebM/Opus audio. The backend converts uploaded audio to 16 kHz mono WAV with `ffmpeg`, then runs `whisper-cli`.

Important local requirement: `whisper-cli.exe` and all `ggml*.dll` files must come from the same whisper.cpp build. A mismatch can cause errors such as:

```text
failed to find ggml_backend_init in ggml-cpu.dll
```

## Classification Rules

The backend classifies transcripts into:

- `human`
- `voicemail`
- `disconnected`
- `busy`
- `carrier_message`
- `unknown`
- `unknown_or_silence`
- `disconnected_or_failed`

Voicemail phrases include:

- `leave a message`
- `leave your message`
- `after the tone`
- `at the tone`
- `voicemail`
- `mailbox`
- `you have reached`
- `you've reached`
- `record your message`
- `please record your message`
- `not available to take your call`

Carrier/disconnected phrases include:

- `the number you have dialed`
- `cannot be completed`
- `not in service`
- `temporarily unavailable`
- `call cannot be completed`
- `subscriber is not available`

Busy phrases include:

- `busy`
- `line is busy`

Short greeting phrases can classify as human when fewer than 8 words:

- `hello`
- `hi`
- `yes`
- `assalamualaikum`
- `who is this`

## Audio Heuristics

The backend uses simple audio metadata from the extension:

- Very short recordings under 2 seconds become `disconnected_or_failed`.
- Near-silent recordings become `unknown_or_silence`.
- Otherwise transcript rules determine the result.

## Setup

Backend:

```bash
cd backend
npm install
copy .env.example .env
npm run dev:3100
```

Chrome extension:

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Click **Load unpacked**.
4. Select the `extension` folder.
5. Open the extension popup and verify backend URL is `http://localhost:3100`.

## Testing

1. Start the backend.
2. Open Google Voice.
3. Click **Start Detection**.
4. Select the Google Voice tab in Chrome's capture picker.
5. Enable tab audio.
6. Dial a test number.
7. Wait for the Google Voice call timer to start.
8. Watch the panel for progressive transcript/classification results.

## Limitations

- Google Voice is not a telephony API.
- Classification is estimated from short audio and transcript text.
- Accuracy depends on call audio quality, language, and whisper model quality.
- Local whisper.cpp speed depends on CPU, model size, and build quality.
- Progressive partial transcription starts multiple local whisper processes, so a small model such as `base.en` or `tiny.en` is faster.
- This is a university prototype, not production cold-calling infrastructure.
