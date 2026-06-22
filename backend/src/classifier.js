// This file classifies a transcript and basic audio metadata into the prototype call outcome labels.

const RULES = {
  voicemail: [
    "leave a message",
    "leave your message",
    "after the tone",
    "at the tone",
    "voicemail",
    "mailbox",
    "you have reached",
    "you've reached",
    "you have reached the voicemail",
    "you have reached the voice mail",
    "record your message",
    "record a message",
    "please record your message",
    "please record your",
    "not available to take your call"
  ],
  disconnected: [
    "not in service",
    "temporarily unavailable",
    "subscriber is not available"
  ],
  carrier_message: [
    "the number you have dialed",
    "cannot be completed",
    "call cannot be completed"
  ],
  busy: [
    "busy",
    "line is busy"
  ]
};

const HUMAN_GREETINGS = [
  "hello",
  "hi",
  "yes",
  "assalamualaikum",
  "who is this"
];

function normalizeTranscript(transcript) {
  return String(transcript || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findMatchedRules(normalizedTranscript, phrases) {
  return phrases.filter((phrase) => normalizedTranscript.includes(phrase));
}

function countWords(normalizedTranscript) {
  if (!normalizedTranscript) {
    return 0;
  }

  return normalizedTranscript.split(/\s+/).filter(Boolean).length;
}

function classifyTranscript(transcript, audioMeta = {}) {
  const normalizedTranscript = normalizeTranscript(transcript);
  const durationSeconds = Number(audioMeta.durationSeconds || 0);

  if (durationSeconds > 0 && durationSeconds < 2) {
    return {
      classification: "disconnected_or_failed",
      confidence: 0.74,
      matchedRules: ["recording_less_than_2_seconds"]
    };
  }

  if (audioMeta.nearSilence) {
    return {
      classification: "unknown_or_silence",
      confidence: 0.7,
      matchedRules: ["near_silence"]
    };
  }

  for (const [classification, phrases] of Object.entries(RULES)) {
    const matchedRules = findMatchedRules(normalizedTranscript, phrases);

    if (matchedRules.length > 0) {
      return {
        classification,
        confidence: Math.min(0.98, 0.82 + matchedRules.length * 0.05),
        matchedRules
      };
    }
  }

  const wordCount = countWords(normalizedTranscript);
  const humanMatches = findMatchedRules(normalizedTranscript, HUMAN_GREETINGS);

  if (wordCount > 0 && wordCount < 8 && humanMatches.length > 0) {
    return {
      classification: "human",
      confidence: wordCount <= 3 ? 0.78 : 0.68,
      matchedRules: humanMatches
    };
  }

  return {
    classification: "unknown",
    confidence: 0.35,
    matchedRules: []
  };
}

export { classifyTranscript };
