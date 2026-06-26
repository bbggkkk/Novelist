import { utf8ByteLength, utf8ByteLengthUpTo, utf8PrefixLength } from "./utf8.js";

const MAX_REDACTION_INPUT_CHARS = 1024 * 1024;
const MAX_REDACTION_INPUT_BYTES = 1024 * 1024;
const REDACTION_BOUNDARY_LOOKAHEAD_CHARS = 4096;

export function redactInlineSecrets(value: unknown): string {
  const bounded = boundedRedactionInput(value);
  const redacted = redactBoundedText(bounded.text);
  if (bounded.truncatedChars === 0 && bounded.truncatedBytes === 0) {
    return redacted;
  }
  const marker = bounded.truncatedChars > 0
    ? `... [truncated ${bounded.truncatedChars} chars before redaction]`
    : `... [truncated ${bounded.truncatedBytes} UTF-8 bytes before redaction]`;
  return truncateRedactionTextWithMarker(redacted, marker, MAX_REDACTION_INPUT_CHARS, MAX_REDACTION_INPUT_BYTES);
}

function redactBoundedText(value: string): string {
  return value
    .replace(/\bBearer(\s+)(["']?)[A-Za-z0-9._~+/-]+=*(["']?)/gi, "Bearer$1$2[Redacted]$3")
    .replace(/\bAuthorization\b(\s*[:=]\s*)(["']?)(?!Bearer\b)(?:[A-Za-z][A-Za-z0-9._~-]*\s+)?[^\s"',;&}/]+(["']?)/gi, "Authorization$1$2[Redacted]$3")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[Redacted]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "AIza[Redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "gh[Redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_[Redacted]")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "AWS[Redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[Redacted JWT]")
    .replace(
      /\b((?:x-)?api[-_]?key|x?apiKey|aws[-_]?access[-_]?key[-_]?id|awsAccessKeyId|aws[-_]?secret[-_]?access[-_]?key|awsSecretAccessKey|access[-_]?token|refresh[-_]?token|accessToken|refreshToken|token|client[-_]?secret|clientSecret|password|secret)\b(\s*[:=]\s*)(["']?)[^\s"',;&}/]+(["']?)/gi,
      "$1$2$3[Redacted]$4"
    );
}

export function redactErrorMessage(value: unknown): string {
  return redactInlineSecrets(coerceErrorMessageInput(value));
}

function boundedRedactionInput(value: unknown): { text: string; truncatedChars: number; truncatedBytes: number } {
  const text = coerceRedactionInput(value);
  if (
    text.length <= MAX_REDACTION_INPUT_CHARS &&
    utf8ByteLengthUpTo(text, MAX_REDACTION_INPUT_BYTES) <= MAX_REDACTION_INPUT_BYTES
  ) {
    return { text, truncatedChars: 0, truncatedBytes: 0 };
  }
  const bytes = utf8ByteLength(text);
  const boundedPrefix = truncateRedactionText(text, MAX_REDACTION_INPUT_CHARS, MAX_REDACTION_INPUT_BYTES);
  return {
    text: text.slice(0, boundedPrefix.length + REDACTION_BOUNDARY_LOOKAHEAD_CHARS),
    truncatedChars: Math.max(0, text.length - MAX_REDACTION_INPUT_CHARS),
    truncatedBytes: Math.max(0, bytes - MAX_REDACTION_INPUT_BYTES)
  };
}

function coerceRedactionInput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || typeof value === "symbol" || typeof value === "undefined") {
    return String(value);
  }
  if (typeof value === "function") {
    return "[Function]";
  }
  return "[Object]";
}

function coerceErrorMessageInput(value: unknown): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }
  const message = safeOwnMessageDescriptor(value);
  if (message && "value" in message && typeof message.value === "string") {
    return message.value;
  }
  return typeof value === "function" ? "[Function]" : "[Object]";
}

function safeOwnMessageDescriptor(value: object): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, "message");
  } catch {
    return undefined;
  }
}

function truncateRedactionText(value: string, maxChars: number, maxBytes: number): string {
  if (value.length <= maxChars && utf8ByteLengthUpTo(value, maxBytes) <= maxBytes) {
    return value;
  }
  return value.slice(0, utf8PrefixLength(value, maxChars, maxBytes));
}

function truncateRedactionTextWithMarker(value: string, marker: string, maxChars: number, maxBytes: number): string {
  if (marker.length > maxChars || utf8ByteLength(marker) > maxBytes) {
    return truncateRedactionText(marker, maxChars, maxBytes);
  }
  const markerBytes = utf8ByteLength(marker);
  if (
    value.length + marker.length <= maxChars &&
    utf8ByteLengthUpTo(value, maxBytes - markerBytes) + markerBytes <= maxBytes
  ) {
    return `${value}${marker}`;
  }
  return `${value.slice(0, utf8PrefixLength(value, maxChars - marker.length, maxBytes - markerBytes))}${marker}`;
}
