// This file handles local audio transcription through whisper.cpp and uses a mock transcript only for setup testing.

import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function getTextTail(text, maxLength = 1600) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? normalized.slice(-maxLength) : normalized;
}

async function convertToWhisperWav(inputPath) {
  const ffmpegBin = process.env.FFMPEG_BIN || "ffmpeg";
  const parsedPath = path.parse(inputPath);
  const wavPath = path.join(parsedPath.dir, `${parsedPath.name}-whisper.wav`);

  await execFileAsync(ffmpegBin, [
    "-y",
    "-i",
    inputPath,
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    wavPath
  ], { timeout: 30000 });

  return wavPath;
}

function getLocalPlaceholder() {
  const whisperBin = process.env.WHISPER_CPP_BIN;
  const modelPath = process.env.WHISPER_CPP_MODEL;

  if (!whisperBin || !modelPath) {
    return {
      transcript: process.env.MOCK_TRANSCRIPT || "",
      provider: "local-placeholder",
      warning: "WHISPER_CPP_BIN or WHISPER_CPP_MODEL is not set; returning MOCK_TRANSCRIPT or an empty transcript."
    };
  }

  return null;
}

async function runWhisperCpp(wavPath) {
  const whisperBin = process.env.WHISPER_CPP_BIN;
  const modelPath = process.env.WHISPER_CPP_MODEL;

  const outputBase = wavPath.replace(/\.wav$/i, "");
  const transcriptPath = `${outputBase}.txt`;
  const args = [
    "-m",
    modelPath,
    "-f",
    wavPath,
    "-otxt",
    "-of",
    outputBase,
    "-l",
    process.env.WHISPER_CPP_LANGUAGE || "en"
  ];

  if (process.env.WHISPER_CPP_USE_GPU !== "true") {
    args.push("-ng");
  }

  try {
    await execFileAsync(whisperBin, args, {
      timeout: Number(process.env.WHISPER_CPP_TIMEOUT_MS || 120000),
      maxBuffer: 1024 * 1024 * 10,
      windowsHide: true
    });
  } catch (error) {
    const partialTranscript = await fs.readFile(transcriptPath, "utf8").catch(() => "");
    const normalizedPartialTranscript = partialTranscript.replace(/\s+/g, " ").trim();

    if (normalizedPartialTranscript) {
      await fs.unlink(transcriptPath).catch(() => {});

      return {
        transcript: normalizedPartialTranscript,
        provider: "whisper.cpp",
        warning: `whisper.cpp exited with an error after writing a transcript. Error tail: ${getTextTail(error.stderr || error.message)}`
      };
    }

    const commandOutput = `${error.stderr || ""} ${error.stdout || ""} ${error.message || ""}`;
    const dllHint = commandOutput.includes("ggml_backend_init") || commandOutput.includes("ggml-cpu.dll")
      ? " This looks like a whisper.cpp binary/DLL mismatch. Rebuild whisper.cpp cleanly or make sure whisper-cli.exe and ggml*.dll files come from the same build folder."
      : "";

    throw new Error(`whisper.cpp failed.${dllHint} Error tail: ${getTextTail(commandOutput)}`);
  }

  const transcript = await fs.readFile(transcriptPath, "utf8");
  await fs.unlink(transcriptPath).catch(() => {});
  const normalizedTranscript = transcript.replace(/\s+/g, " ").trim();

  return {
    transcript: normalizedTranscript,
    provider: "whisper.cpp",
    warning: normalizedTranscript ? undefined : "whisper.cpp ran but returned an empty transcript. Check audio volume, model path, language/model choice, and ffmpeg conversion."
  };
}

async function transcribeAudio(filePath) {
  const placeholder = getLocalPlaceholder();

  if (placeholder) {
    return placeholder;
  }

  let wavPath;

  try {
    wavPath = await convertToWhisperWav(filePath);
    return await runWhisperCpp(wavPath);
  } finally {
    if (wavPath) {
      await fs.unlink(wavPath).catch(() => {});
    }
  }
}

export { transcribeAudio };
