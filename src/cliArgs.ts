export type CliAction = "start" | "help" | "version";

const MAX_CLI_ARGS = 256;
const MAX_CLI_ARG_CHARS = 8192;
const MAX_CLI_ARG_BYTES = 8192;
const MAX_UNSUPPORTED_ARG_PREVIEW_COUNT = 8;
const MAX_UNSUPPORTED_ARG_PREVIEW_CHARS = 256;
const MAX_UNSUPPORTED_ARG_PREVIEW_BYTES = 256;
const CLI_ARG_CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f]/gu;

export function parseCliArgs(args: unknown): CliAction {
  const parsed = validateCliArgArray(args);
  if (parsed.length === 0) {
    return "start";
  }
  if (parsed.length === 1 && (parsed[0] === "--help" || parsed[0] === "-h")) {
    return "help";
  }
  if (parsed.length === 1 && (parsed[0] === "--version" || parsed[0] === "-v")) {
    return "version";
  }
  throw new Error(`Unsupported CLI arguments: ${unsupportedArgsPreview(parsed)}`);
}

function validateCliArgArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("CLI arguments must be an array.");
  }
  if (safeGetPrototypeOf(value) !== Array.prototype) {
    throw new Error("CLI arguments must be a standard array.");
  }
  if (value.length > MAX_CLI_ARGS) {
    throw new Error(`CLI arguments must contain at most ${MAX_CLI_ARGS} items.`);
  }
  for (const key of safeOwnKeys(value)) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string") {
      throw new Error("CLI arguments must not contain symbol properties.");
    }
    if (!isArrayIndexKey(key, value.length)) {
      throw new Error(`CLI arguments.${key} is not a supported array field.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`CLI arguments[${key}] must be an enumerable data item.`);
    }
  }
  const args: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = safeGetOwnPropertyDescriptor(value, String(index));
    if (!descriptor) {
      throw new Error(`CLI arguments[${index}] must not be a sparse array hole.`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`CLI arguments[${index}] must be an enumerable data item.`);
    }
    if (typeof descriptor.value !== "string") {
      throw new Error(`CLI arguments[${index}] must be a string.`);
    }
    if (descriptor.value.length > MAX_CLI_ARG_CHARS) {
      throw new Error(`CLI arguments[${index}] must be at most ${MAX_CLI_ARG_CHARS} characters.`);
    }
    if (utf8ByteLengthUpTo(descriptor.value, MAX_CLI_ARG_BYTES) > MAX_CLI_ARG_BYTES) {
      throw new Error(`CLI arguments[${index}] must be at most ${MAX_CLI_ARG_BYTES} UTF-8 bytes.`);
    }
    if (CLI_ARG_CONTROL_CHARS_GLOBAL.test(descriptor.value)) {
      CLI_ARG_CONTROL_CHARS_GLOBAL.lastIndex = 0;
      throw new Error(`CLI arguments[${index}] must not contain control characters.`);
    }
    args.push(descriptor.value);
  }
  return args;
}

function safeGetPrototypeOf(value: object): object | null {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    throw new Error("CLI arguments prototype must be readable.");
  }
}

function safeOwnKeys(value: object): Array<string | symbol> {
  try {
    return Reflect.ownKeys(value);
  } catch {
    throw new Error("CLI arguments property keys must be readable.");
  }
}

function safeGetOwnPropertyDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new Error("CLI arguments property descriptors must be readable.");
  }
}

function unsupportedArgsPreview(args: string[]): string {
  const shown = args.slice(0, MAX_UNSUPPORTED_ARG_PREVIEW_COUNT).map((arg) => {
    const normalized = arg.replace(CLI_ARG_CONTROL_CHARS_GLOBAL, " ");
    if (
      normalized.length <= MAX_UNSUPPORTED_ARG_PREVIEW_CHARS &&
      utf8ByteLengthUpTo(normalized, MAX_UNSUPPORTED_ARG_PREVIEW_BYTES) <= MAX_UNSUPPORTED_ARG_PREVIEW_BYTES
    ) {
      return normalized;
    }
    const marker =
      normalized.length > MAX_UNSUPPORTED_ARG_PREVIEW_CHARS
        ? `... [truncated ${normalized.length - MAX_UNSUPPORTED_ARG_PREVIEW_CHARS} chars]`
        : `... [truncated ${Math.max(0, utf8ByteLength(normalized) - MAX_UNSUPPORTED_ARG_PREVIEW_BYTES)} UTF-8 bytes]`;
    return truncateCliTextWithMarker(normalized, marker, MAX_UNSUPPORTED_ARG_PREVIEW_CHARS, MAX_UNSUPPORTED_ARG_PREVIEW_BYTES);
  });
  const omitted = args.length - shown.length;
  return omitted > 0
    ? `${shown.join(" ")} ... [omitted ${omitted} args]`
    : shown.join(" ");
}

function truncateCliTextWithMarker(value: string, marker: string, maxChars: number, maxBytes: number): string {
  const markerBytes = utf8ByteLength(marker);
  if (marker.length > maxChars || markerBytes > maxBytes) {
    return truncateCliText(value, maxChars, maxBytes);
  }
  return `${truncateCliText(value, maxChars - marker.length, maxBytes - markerBytes)}${marker}`;
}

function truncateCliText(value: string, maxChars: number, maxBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const scalar of value) {
    if (output.length + scalar.length > maxChars) {
      break;
    }
    const nextBytes = bytes + utf8ByteLength(scalar);
    if (nextBytes > maxBytes) {
      break;
    }
    output += scalar;
    bytes = nextBytes;
  }
  return output;
}

function utf8ByteLength(value: string): number {
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
  }
  return bytes;
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

function isArrayIndexKey(value: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    return false;
  }
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === value;
}
