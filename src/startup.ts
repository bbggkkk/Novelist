import { redactErrorMessage } from "./redaction.js";

const MAX_STARTUP_ERROR_CHARS = 4000;
const MAX_STARTUP_ERROR_BYTES = 16 * 1024;
const STARTUP_ERROR_CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f]/gu;
const encoder = new TextEncoder();

export function startupErrorMessage(error: unknown): string {
  const message = redactErrorMessage(error).replace(STARTUP_ERROR_CONTROL_CHARS_GLOBAL, " ");
  if (
    message.length <= MAX_STARTUP_ERROR_CHARS &&
    utf8ByteLengthUpTo(message, MAX_STARTUP_ERROR_BYTES) <= MAX_STARTUP_ERROR_BYTES
  ) {
    return message;
  }
  return truncateStartupErrorText(message, MAX_STARTUP_ERROR_CHARS, MAX_STARTUP_ERROR_BYTES);
}

export function startupErrorJsonLine(error: unknown): string {
  const entry = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(entry, "level", {
    value: "error",
    enumerable: true,
    configurable: true,
    writable: true
  });
  Object.defineProperty(entry, "event", {
    value: "novelist_startup_failed",
    enumerable: true,
    configurable: true,
    writable: true
  });
  Object.defineProperty(entry, "error", {
    value: startupErrorMessage(error),
    enumerable: true,
    configurable: true,
    writable: true
  });
  return `${JSON.stringify(entry)}\n`;
}

function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
}

function utf8ByteLengthUpTo(value: string, maxBytes: number): number {
  let bytes = 0;
  for (const scalar of value) {
    bytes += utf8ScalarByteLength(scalar);
    if (bytes > maxBytes) {
      return bytes;
    }
  }
  return bytes;
}

function utf8ScalarByteLength(scalar: string): number {
  const codePoint = scalar.codePointAt(0) ?? 0;
  if (codePoint <= 0x7f) {
    return 1;
  }
  if (codePoint <= 0x7ff) {
    return 2;
  }
  if (codePoint <= 0xffff) {
    return 3;
  }
  return 4;
}

function truncateStartupErrorText(value: string, maxChars: number, maxBytes: number): string {
  const truncatedBytes = Math.max(0, utf8ByteLength(value) - maxBytes);
  const marker = truncatedBytes > 0
    ? `... [truncated ${truncatedBytes} UTF-8 bytes]`
    : `... [truncated ${Math.max(0, value.length - maxChars)} chars]`;
  const markerBytes = utf8ByteLength(marker);
  if (marker.length > maxChars || markerBytes > maxBytes) {
    return marker;
  }
  return `${value.slice(0, utf8PrefixLength(value, maxChars - marker.length, maxBytes - markerBytes))}${marker}`;
}

function utf8PrefixLength(value: string, maxChars: number, maxBytes: number): number {
  let chars = 0;
  let bytes = 0;
  for (const scalar of value) {
    const nextChars = chars + scalar.length;
    if (nextChars > maxChars) {
      break;
    }
    const nextBytes = bytes + utf8ScalarByteLength(scalar);
    if (nextBytes > maxBytes) {
      break;
    }
    chars = nextChars;
    bytes = nextBytes;
  }
  return chars;
}
