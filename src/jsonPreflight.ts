const MAX_JSON_PREFLIGHT_LABEL_CHARS = 256;
const MAX_JSON_PREFLIGHT_LABEL_BYTES = 512;
const MAX_JSON_PREFLIGHT_TEXT_CHARS = 16 * 1024 * 1024;
const MAX_JSON_PREFLIGHT_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_JSON_PREFLIGHT_DEPTH = 1024;
const MAX_JSON_PREFLIGHT_OBJECT_KEYS = 10000;

export function assertNoDuplicateJsonObjectKeys(text: string, label: string, maxDepth: number): void {
  const safeText = validateJsonPreflightText(text);
  const safeLabel = validateJsonPreflightLabel(label);
  const safeMaxDepth = validateJsonPreflightMaxDepth(maxDepth);
  let index = 0;

  const skipWhitespace = (): void => {
    while (index < safeText.length && /[\t\n\r ]/u.test(safeText[index] ?? "")) {
      index += 1;
    }
  };

  const parseJsonStringToken = (): string | undefined => {
    const start = index;
    index += 1;
    while (index < safeText.length) {
      const char = safeText[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "\"") {
        index += 1;
        try {
          return JSON.parse(safeText.slice(start, index)) as string;
        } catch {
          return undefined;
        }
      }
      index += 1;
    }
    return undefined;
  };

  const skipPrimitiveToken = (): void => {
    while (index < safeText.length && !/[\t\n\r ,\]}]/u.test(safeText[index] ?? "")) {
      index += 1;
    }
  };

  const assertScanDepth = (depth: number): void => {
    if (depth > safeMaxDepth) {
      throw new Error(`${safeLabel} must be nested at most ${safeMaxDepth} levels deep.`);
    }
  };

  const parseValue = (depth: number): boolean => {
    assertScanDepth(depth);
    skipWhitespace();
    const char = safeText[index];
    if (char === "{") {
      return parseObject(depth);
    }
    if (char === "[") {
      return parseArray(depth);
    }
    if (char === "\"") {
      return parseJsonStringToken() !== undefined;
    }
    skipPrimitiveToken();
    return true;
  };

  const parseArray = (depth: number): boolean => {
    index += 1;
    skipWhitespace();
    if (safeText[index] === "]") {
      index += 1;
      return true;
    }
    while (index < safeText.length) {
      if (!parseValue(depth + 1)) {
        return false;
      }
      skipWhitespace();
      if (safeText[index] === ",") {
        index += 1;
        continue;
      }
      if (safeText[index] === "]") {
        index += 1;
        return true;
      }
      return false;
    }
    return false;
  };

  const parseObject = (depth: number): boolean => {
    index += 1;
    const keys = new Set<string>();
    skipWhitespace();
    if (safeText[index] === "}") {
      index += 1;
      return true;
    }
    while (index < safeText.length) {
      skipWhitespace();
      if (safeText[index] !== "\"") {
        return false;
      }
      const key = parseJsonStringToken();
      if (key === undefined) {
        return false;
      }
      if (keys.has(key)) {
        throw new Error(`${safeLabel} must not contain duplicate object keys.`);
      }
      keys.add(key);
      if (keys.size > MAX_JSON_PREFLIGHT_OBJECT_KEYS) {
        throw new Error(`${safeLabel} objects must contain at most ${MAX_JSON_PREFLIGHT_OBJECT_KEYS} keys.`);
      }
      skipWhitespace();
      if (safeText[index] !== ":") {
        return false;
      }
      index += 1;
      if (!parseValue(depth + 1)) {
        return false;
      }
      skipWhitespace();
      if (safeText[index] === ",") {
        index += 1;
        continue;
      }
      if (safeText[index] === "}") {
        index += 1;
        return true;
      }
      return false;
    }
    return false;
  };

  parseValue(0);
}

function validateJsonPreflightText(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("JSON preflight text must be a string.");
  }
  if (value.length > MAX_JSON_PREFLIGHT_TEXT_CHARS) {
    throw new Error(`JSON preflight text must be at most ${MAX_JSON_PREFLIGHT_TEXT_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(value, MAX_JSON_PREFLIGHT_TEXT_BYTES) > MAX_JSON_PREFLIGHT_TEXT_BYTES) {
    throw new Error(`JSON preflight text must be at most ${MAX_JSON_PREFLIGHT_TEXT_BYTES} UTF-8 bytes.`);
  }
  return value;
}

function validateJsonPreflightLabel(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("JSON preflight label must be a non-empty string.");
  }
  if (value.length > MAX_JSON_PREFLIGHT_LABEL_CHARS) {
    throw new Error(`JSON preflight label must be at most ${MAX_JSON_PREFLIGHT_LABEL_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(value, MAX_JSON_PREFLIGHT_LABEL_BYTES) > MAX_JSON_PREFLIGHT_LABEL_BYTES) {
    throw new Error(`JSON preflight label must be at most ${MAX_JSON_PREFLIGHT_LABEL_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("JSON preflight label must not contain control characters.");
  }
  return value.trim();
}

function utf8ByteLengthUpTo(value: string, maxBytes: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    let scalar = first;
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
      const second = value.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        scalar = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
        index += 1;
      }
    }
    bytes += utf8ScalarByteLength(scalar);
    if (bytes > maxBytes) {
      return bytes;
    }
  }
  return bytes;
}

function utf8ScalarByteLength(scalar: number): number {
  if (scalar <= 0x7f) {
    return 1;
  }
  if (scalar <= 0x7ff) {
    return 2;
  }
  if (scalar <= 0xffff) {
    return 3;
  }
  return 4;
}

function validateJsonPreflightMaxDepth(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("JSON preflight maxDepth must be an integer.");
  }
  if (value < 1 || value > MAX_JSON_PREFLIGHT_DEPTH) {
    throw new Error(`JSON preflight maxDepth must be between 1 and ${MAX_JSON_PREFLIGHT_DEPTH}.`);
  }
  return value;
}
