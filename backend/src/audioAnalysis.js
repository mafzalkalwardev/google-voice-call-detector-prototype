// This file contains lightweight backend-side audio heuristics for short uploaded call recordings.

import fs from "node:fs/promises";

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function analyzeAudioBasic(filePath, clientHints = {}) {
  const stats = await fs.stat(filePath);
  const durationSeconds = parseNumber(clientHints.durationSeconds);
  const rms = parseNumber(clientHints.rms);
  const peak = parseNumber(clientHints.peak);

  // The extension calculates RMS/peak from captured PCM samples. If those hints are unavailable,
  // fall back to a conservative file-size check that only marks extremely tiny files as silence.
  const nearSilenceFromClient = rms > 0 ? rms < 0.01 && peak < 0.03 : false;
  const nearSilenceFromSize = durationSeconds >= 2 && stats.size < 1500;
  const nearSilence = nearSilenceFromClient || nearSilenceFromSize;

  return {
    durationSeconds,
    nearSilence,
    rms,
    peak,
    fileSizeBytes: stats.size
  };
}

export { analyzeAudioBasic };
