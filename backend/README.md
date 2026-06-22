# Google Voice Call Detection Prototype

University-project prototype for estimating whether the first 5-10 seconds of a Google Voice call sounds like a human answer, voicemail, busy line, disconnected/carrier message, or unknown.

This project does not reverse-engineer Google Voice, use private Google APIs, use cookies, or call internal Google endpoints. The Chrome extension only runs on `https://voice.google.com/*`, waits for the user to click **Start Detection**, captures user-approved browser audio, and sends that short recording to your own local backend.

## Project Structure

```text
backend/
  server.js                 Express API entry point
  src/audioAnalysis.js      Basic duration and silence heuristics
  src/classifier.js         Rule-based transcript classifier
  src/transcriber.js        Local whisper.cpp transcription or local placeholder
  uploads/                  Temporary upload directory; files are deleted after processing
extension/
  manifest.json             Chrome Extension Manifest V3 config
  background.js             Extension settings storage
  content.js                Floating Google Voice panel and recorder
  popup.html                Settings popup
  popup.js                  Popup settings behavior
  styles.css                Panel and popup styling
```

## Backend Install

```bash
cd backend
npm install
copy .env.example .env
npm run dev
```

On macOS/Linux, use:

```bash
cp .env.example .env
```

If port `3000` is already in use, either set `PORT=3100` in `.env` or run:

```bash
npm run dev:3100
```

Then open the extension popup and set the backend URL to `http://localhost:3100`.

## Local whisper.cpp Setup

For real transcription, install `whisper.cpp`, download a model, install `ffmpeg`, and set these values in `.env`:

```env
WHISPER_CPP_BIN=C:\tools\whisper.cpp\build\bin\Release\whisper-cli.exe
WHISPER_CPP_MODEL=C:\tools\whisper.cpp\models\ggml-base.en.bin
FFMPEG_BIN=ffmpeg
```

Use the actual paths from your machine. On macOS/Linux, `WHISPER_CPP_BIN` may look like `/Users/me/whisper.cpp/build/bin/whisper-cli`.

The backend converts Chrome's WebM/Opus recording to 16 kHz mono WAV with `ffmpeg`, then runs:

```bash
whisper-cli -m <model> -f <converted-wav> -otxt -of <output-base>
```

If the whisper binary or model is not configured, the backend returns `MOCK_TRANSCRIPT` or an empty transcript so the rest of the prototype can still be tested.

## Load The Chrome Extension

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable **Developer Mode**.
4. Click **Load unpacked**.
5. Select the `extension` folder.

## Test Flow

1. Start the backend with `npm run dev`.
2. Open `https://voice.google.com/`.
3. Click **Start Detection** in the floating panel.
4. In Chrome's capture picker, choose the Google Voice tab and enable tab audio sharing.
5. Place a test call.
6. The extension detects the visible Google Voice in-call UI and starts the 5 or 10 second timer automatically.
7. Review the transcript and classification result in the panel.

## API

`POST /api/transcribe-classify`

Form fields:

- `audio`: `webm` audio blob from the extension.
- `durationSeconds`: client-measured recording duration.
- `rms`: client-measured average audio RMS.
- `peak`: client-measured peak amplitude.

The extension prefers a faster streamed upload path:

- `POST /api/recording-session` creates a session before recording starts.
- `POST /api/recording-session/:sessionId/chunk` uploads each MediaRecorder chunk while recording is still running.
- `POST /api/recording-session/:sessionId/partial` transcribes/classifies chunks already uploaded while recording continues.
- `POST /api/recording-session/:sessionId/finalize` combines uploaded chunks and runs transcription/classification.
- `DELETE /api/recording-session/:sessionId` cleans up chunks after an early confident partial result.

If session creation fails, the extension falls back to `POST /api/transcribe-classify` after recording ends.

Example response:

```json
{
  "success": true,
  "transcript": "please leave a message after the tone",
  "classification": "voicemail",
  "confidence": 0.92,
  "matchedRules": ["leave a message", "after the tone"],
  "durationSeconds": 10
}
```

## Classification Rules

- Voicemail: `leave a message`, `after the tone`, `voicemail`, `mailbox`, `you have reached`, `record your message`, `not available to take your call`.
- Carrier/disconnected: `the number you have dialed`, `cannot be completed`, `not in service`, `temporarily unavailable`, `call cannot be completed`, `subscriber is not available`.
- Busy: `busy`, `line is busy`.
- Human: short greetings such as `hello`, `hi`, `yes`, `assalamualaikum`, `who is this` with fewer than 8 words.
- Silence: near-silent recordings are classified as `unknown_or_silence`.
- Too short: recordings under 2 seconds are classified as `disconnected_or_failed`.

## Capture Notes

Manifest V3 service workers are not a reliable place to run `MediaRecorder`, so this prototype records from the injected content script using `navigator.mediaDevices.getDisplayMedia()`. Chrome will show a capture picker. The user must choose the current Google Voice tab and allow audio sharing.

After capture permission is granted, the extension is armed but not recording yet. It watches only visible Google Voice UI elements such as Hang up, Mute, Keypad, and Speaker controls. When those in-call controls appear, the recording timer starts automatically.

If tab audio is not available, Chrome may allow system audio capture depending on operating system and browser settings. The extension never starts recording automatically.

## Limitations

- Google Voice is not a telephony API.
- Human vs voicemail is estimated from audio/transcript and is not guaranteed.
- Accuracy depends on audio quality, language, call routing, and transcription quality.
- Local fallback mode does not perform real transcription; it exists only for offline prototype testing.
- This is a university prototype, not production cold-calling infrastructure.
