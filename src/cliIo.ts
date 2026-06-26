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
