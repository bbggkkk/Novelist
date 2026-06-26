const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
}

export function utf8ByteLengthUpTo(value: string, maxBytes: number): number {
  let bytes = 0;
  for (const scalar of value) {
    bytes += utf8ScalarByteLength(scalar);
    if (bytes > maxBytes) {
      return bytes;
    }
  }
  return bytes;
}

export function utf8PrefixLength(value: string, maxBytes: number): number;
export function utf8PrefixLength(value: string, maxChars: number, maxBytes: number): number;
export function utf8PrefixLength(value: string, maxCharsOrBytes: number, maxBytes?: number): number {
  const maxChars = maxBytes === undefined ? Number.POSITIVE_INFINITY : maxCharsOrBytes;
  const byteLimit = maxBytes === undefined ? maxCharsOrBytes : maxBytes;
  let chars = 0;
  let bytes = 0;
  for (const scalar of value) {
    const nextChars = chars + scalar.length;
    if (nextChars > maxChars) {
      break;
    }
    const nextBytes = bytes + utf8ScalarByteLength(scalar);
    if (nextBytes > byteLimit) {
      break;
    }
    chars = nextChars;
    bytes = nextBytes;
  }
  return chars;
}

export function utf8ScalarByteLength(scalar: string | number): number {
  const codePoint = typeof scalar === "number" ? scalar : scalar.codePointAt(0) ?? 0;
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
