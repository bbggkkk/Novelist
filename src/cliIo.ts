import { utf8ByteLengthUpTo, utf8PrefixLength } from "./utf8.js";

export type SyncWriter = (fd: number, data: string) => unknown;

const MAX_CLI_OUTPUT_CHARS = 64 * 1024;
const MAX_CLI_OUTPUT_BYTES = 64 * 1024;

export function writeCliOutput(write: SyncWriter, fd: number, data: string): void {
  try {
    if (typeof write !== "function" || !Number.isInteger(fd) || fd < 0 || typeof data !== "string") {
      return;
    }
    write(fd, boundedCliOutput(data));
  } catch {
    // CLI output is best-effort; startup failure handling must not throw again.
  }
}

function boundedCliOutput(value: string): string {
  if (
    value.length <= MAX_CLI_OUTPUT_CHARS &&
    utf8ByteLengthUpTo(value, MAX_CLI_OUTPUT_BYTES) <= MAX_CLI_OUTPUT_BYTES
  ) {
    return value;
  }
  const marker = "... [truncated CLI output]\n";
  const markerBytes = utf8ByteLengthUpTo(marker, MAX_CLI_OUTPUT_BYTES + 1);
  if (marker.length > MAX_CLI_OUTPUT_CHARS || markerBytes > MAX_CLI_OUTPUT_BYTES) {
    return "";
  }
  const prefixLength = utf8PrefixLength(value, MAX_CLI_OUTPUT_CHARS - marker.length, MAX_CLI_OUTPUT_BYTES - markerBytes);
  return `${value.slice(0, prefixLength)}${marker}`;
}
