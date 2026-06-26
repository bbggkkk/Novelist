import { STARTUP_FAILED_EVENT } from "./constants.js";
import { redactErrorMessage } from "./redaction.js";
import { utf8ByteLength, utf8ByteLengthUpTo, utf8PrefixLength } from "./utf8.js";

const MAX_STARTUP_ERROR_CHARS = 4000;
const MAX_STARTUP_ERROR_BYTES = 16 * 1024;
const STARTUP_ERROR_CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f]/gu;

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
    value: STARTUP_FAILED_EVENT,
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
