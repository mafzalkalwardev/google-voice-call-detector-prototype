// This file exposes the Express API used by the Chrome extension to upload, transcribe, and classify audio.

import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import { analyzeAudioBasic } from "./src/audioAnalysis.js";
import { classifyTranscript } from "./src/classifier.js";
import { transcribeAudio } from "./src/transcriber.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, "uploads");
const port = Number(process.env.PORT || 3100);

await fs.mkdir(uploadsDir, { recursive: true });

const app = express();

app.use(cors());
app.use(express.json());

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const extension = path.extname(file.originalname || "") || ".webm";
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

async function processAudioFile(filePath, body = {}) {
  const audioMeta = await analyzeAudioBasic(filePath, {
    durationSeconds: body.durationSeconds,
    rms: body.rms,
    peak: body.peak
  });

  const transcription = await transcribeAudio(filePath);
  const classification = classifyTranscript(transcription.transcript, audioMeta);

  return {
    success: true,
    transcript: transcription.transcript,
    classification: classification.classification,
    confidence: classification.confidence,
    matchedRules: classification.matchedRules,
    durationSeconds: audioMeta.durationSeconds,
    audioMeta,
    transcriptionProvider: transcription.provider,
    warning: transcription.warning
  };
}

async function buildCombinedSessionFile(sessionDir, combinedPath) {
  const chunkFiles = (await fs.readdir(sessionDir))
    .filter((fileName) => fileName.endsWith(".webm"))
    .sort();

  if (chunkFiles.length === 0) {
    const error = new Error("No recording chunks were uploaded.");
    error.code = "missing_chunks";
    throw error;
  }

  const buffers = await Promise.all(
    chunkFiles.map((fileName) => fs.readFile(path.join(sessionDir, fileName)))
  );

  await fs.writeFile(combinedPath, Buffer.concat(buffers));
  return chunkFiles.length;
}

async function processSessionChunks(sessionId, body = {}, options = {}) {
  const sessionDir = path.join(uploadsDir, sessionId);
  const suffix = options.partial ? `partial-${Date.now()}` : "final";
  const combinedPath = path.join(uploadsDir, `${sessionId}-${suffix}.webm`);

  try {
    const chunkCount = await buildCombinedSessionFile(sessionDir, combinedPath);
    const result = await processAudioFile(combinedPath, body);

    return {
      ...result,
      partial: Boolean(options.partial),
      chunkCount
    };
  } finally {
    await fs.unlink(combinedPath).catch(() => {});
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/transcribe-classify", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      errorCode: "missing_audio",
      message: "Upload an audio file in the 'audio' form field."
    });
  }

  const filePath = req.file.path;

  try {
    return res.json(await processAudioFile(filePath, req.body));
  } catch (error) {
    return res.status(500).json({
      success: false,
      errorCode: "transcription_failed",
      message: error.message || "Transcription or classification failed."
    });
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
});

app.post("/api/recording-session", async (_req, res) => {
  const sessionId = crypto.randomUUID();
  const sessionDir = path.join(uploadsDir, sessionId);

  await fs.mkdir(sessionDir, { recursive: true });

  return res.json({
    success: true,
    sessionId
  });
});

app.post("/api/recording-session/:sessionId/chunk", upload.single("chunk"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      errorCode: "missing_chunk",
      message: "Upload a chunk file in the 'chunk' form field."
    });
  }

  const safeSessionId = String(req.params.sessionId || "").replace(/[^a-zA-Z0-9-]/g, "");
  const sessionDir = path.join(uploadsDir, safeSessionId);
  const index = Number.parseInt(req.body.index, 10);

  if (!safeSessionId || !Number.isInteger(index) || index < 0) {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({
      success: false,
      errorCode: "invalid_chunk",
      message: "Invalid recording session chunk metadata."
    });
  }

  try {
    await fs.mkdir(sessionDir, { recursive: true });
    const chunkPath = path.join(sessionDir, `${String(index).padStart(6, "0")}.webm`);
    await fs.rename(req.file.path, chunkPath);

    return res.json({
      success: true,
      sessionId: safeSessionId,
      index
    });
  } catch (error) {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(500).json({
      success: false,
      errorCode: "chunk_save_failed",
      message: error.message || "Could not save recording chunk."
    });
  }
});

app.post("/api/recording-session/:sessionId/finalize", async (req, res) => {
  const safeSessionId = String(req.params.sessionId || "").replace(/[^a-zA-Z0-9-]/g, "");
  const sessionDir = path.join(uploadsDir, safeSessionId);

  if (!safeSessionId) {
    return res.status(400).json({
      success: false,
      errorCode: "invalid_session",
      message: "Invalid recording session."
    });
  }

  try {
    return res.json(await processSessionChunks(safeSessionId, req.body));
  } catch (error) {
    return res.status(500).json({
      success: false,
      errorCode: "finalize_failed",
      message: error.message || "Could not finalize recording session."
    });
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.post("/api/recording-session/:sessionId/partial", async (req, res) => {
  const safeSessionId = String(req.params.sessionId || "").replace(/[^a-zA-Z0-9-]/g, "");

  if (!safeSessionId) {
    return res.status(400).json({
      success: false,
      errorCode: "invalid_session",
      message: "Invalid recording session."
    });
  }

  try {
    return res.json(await processSessionChunks(safeSessionId, req.body, { partial: true }));
  } catch (error) {
    const status = error.code === "missing_chunks" ? 400 : 500;

    return res.status(status).json({
      success: false,
      errorCode: error.code || "partial_failed",
      message: error.message || "Could not process partial recording session."
    });
  }
});

app.delete("/api/recording-session/:sessionId", async (req, res) => {
  const safeSessionId = String(req.params.sessionId || "").replace(/[^a-zA-Z0-9-]/g, "");

  if (!safeSessionId) {
    return res.status(400).json({
      success: false,
      errorCode: "invalid_session",
      message: "Invalid recording session."
    });
  }

  await fs.rm(path.join(uploadsDir, safeSessionId), { recursive: true, force: true }).catch(() => {});

  return res.json({
    success: true
  });
});

const server = app.listen(port, () => {
  console.log(`Call detector backend listening on http://localhost:${port}`);
  console.log(
    process.env.WHISPER_CPP_BIN && process.env.WHISPER_CPP_MODEL
      ? "Transcription provider: whisper.cpp"
      : "Transcription provider: local placeholder. Set WHISPER_CPP_BIN and WHISPER_CPP_MODEL in .env for real transcription."
  );
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Set PORT to another value, for example: PORT=3100 npm run dev`);
    process.exit(1);
  }

  throw error;
});
