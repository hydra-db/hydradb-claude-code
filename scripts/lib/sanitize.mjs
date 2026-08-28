const SECRET_PATTERNS = [
  { label: "anthropic", regex: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { label: "openai", regex: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { label: "github", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  {
    label: "aws-access-key",
    regex: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA|AIPA)[A-Z0-9]{16}\b/g
  },
  {
    label: "private-key",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
  },
  {
    label: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g
  },
  {
    label: "bearer",
    regex: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g
  },
  {
    label: "generic-secret",
    regex: /\b(api[_-]?key|secret|password|token)\b\s*[:=]\s*["']?[^"'\s]{8,}["']?/gi
  }
];

export function normalizeText(text) {
  return String(text || "").replace(/\r\n/g, "\n");
}

export function truncateText(text, maxLength) {
  const normalized = normalizeText(text).trim();
  if (!maxLength || normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function redactSecrets(text) {
  let redacted = normalizeText(text);

  for (const { label, regex } of SECRET_PATTERNS) {
    redacted = redacted.replace(regex, `[REDACTED:${label}]`);
  }

  return redacted;
}

export function wasRedacted(original, redacted) {
  return normalizeText(original) !== normalizeText(redacted);
}

// Knowledge sources are ingested through `appKnowledge`, which carries each item
// as a structured envelope. The server indexes that envelope verbatim, so recall
// returns the whole JSON object as the chunk's content — internal ids, empty
// format slots, and duplicated metadata included, with the prose buried in
// `content.text`. Injecting that raw would spend the context budget on scaffolding
// and truncate the text it is supposed to deliver, so the envelope is unwrapped
// back to its prose. Anything that is not one of our envelopes is returned as-is.
export function unwrapAppKnowledgeEnvelope(text) {
  if (typeof text !== "string") {
    return "";
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes('"content"')) {
    return text;
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return text;
  }

  if (!parsed || typeof parsed !== "object") {
    return text;
  }

  const candidates = [parsed.content, parsed.content?.text, parsed.content?.markdown];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return text;
}
