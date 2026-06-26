import type { LogLevel } from "./config.js";
import { redactErrorMessage, redactInlineSecrets } from "./redaction.js";
import {
  LOG_LEVEL_DEBUG_ORDER,
  LOG_LEVEL_ERROR_ORDER,
  LOG_LEVEL_INFO_ORDER,
  LOG_LEVEL_SILENT_ORDER,
  LOG_LEVEL_WARN_ORDER,
  MAX_LOG_ARRAY_ITEMS,
  MAX_LOG_DEPTH,
  MAX_LOG_KEY_BYTES,
  MAX_LOG_KEY_CHARS,
  MAX_LOG_OBJECT_FIELDS,
  MAX_LOG_STRING_BYTES,
  MAX_LOG_STRING_CHARS
} from "./constants.js";

const order: Record<LogLevel, number> = {
  debug: LOG_LEVEL_DEBUG_ORDER,
  info: LOG_LEVEL_INFO_ORDER,
  warn: LOG_LEVEL_WARN_ORDER,
  error: LOG_LEVEL_ERROR_ORDER,
  silent: LOG_LEVEL_SILENT_ORDER
};
const LOG_CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f]/gu;
const UNREADABLE_LOG_VALUE = "[Unreadable]";
const NON_DATA_LOG_PROPERTY = "[NonEnumerableOrAccessor]";
const SPARSE_LOG_ARRAY_HOLE = "[SparseArrayHole]";
const UNDEFINED_LOG_VALUE = "[Undefined]";
const FUNCTION_LOG_VALUE = "[Function]";
const NON_FINITE_NUMBER_LOG_VALUE = "[NonFiniteNumber]";
const encoder = new TextEncoder();

export class Logger {
  private readonly level: LogLevel;

  constructor(level: LogLevel = "warn") {
    this.level = validateLogLevel(level);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write("debug", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write("error", message, meta);
  }

  private write(level: Exclude<LogLevel, "silent">, message: unknown, meta?: Record<string, unknown>): void {
    if (order[level] < order[this.level]) {
      return;
    }
    const entry = logEntry({
      ...sanitizeLogMeta(meta),
      ts: new Date().toISOString(),
      level,
      message: sanitizeLogString(message)
    });
    try {
      process.stderr.write(`${JSON.stringify(entry)}\n`);
    } catch (error) {
      try {
        process.stderr.write(`${JSON.stringify(logEntry({
          ts: new Date().toISOString(),
          level,
          message: sanitizeLogString(message),
          logSerializationError: sanitizeLogString(redactErrorMessage(error))
        }))}\n`);
      } catch {
        // Logging must never break the request path.
      }
    }
  }
}

function logEntry(fields: Record<string, unknown>): Record<string, unknown> {
  const output = Object.create(null) as Record<string, unknown>;
  const keys = safeOwnKeys(fields);
  if (!keys) {
    Object.defineProperty(output, "logEntryError", {
      value: UNREADABLE_LOG_VALUE,
      enumerable: true,
      configurable: true,
      writable: true
    });
    return output;
  }
  for (const key of keys) {
    if (typeof key !== "string") {
      continue;
    }
    const descriptor = safeGetOwnPropertyDescriptor(fields, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      continue;
    }
    Object.defineProperty(output, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return output;
}

function sanitizeLogMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta) {
    return {};
  }
  try {
    const sanitized = sanitizeLogValue(meta);
    if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
      return sanitized as Record<string, unknown>;
    }
    return { metadata: sanitized };
  } catch (error) {
    return { logMetadataError: sanitizeLogString(redactErrorMessage(error)) };
  }
}

function sanitizeLogValue(value: unknown, stack = new WeakSet<object>(), depth = 0): unknown {
  if (value === undefined) {
    return UNDEFINED_LOG_VALUE;
  }
  if (typeof value === "string") {
    return sanitizeLogString(value);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return NON_FINITE_NUMBER_LOG_VALUE;
  }
  if (typeof value === "bigint") {
    return sanitizeLogString(value);
  }
  if (typeof value === "symbol") {
    return sanitizeLogString(value);
  }
  if (typeof value === "function") {
    return FUNCTION_LOG_VALUE;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (depth >= MAX_LOG_DEPTH) {
    return "[MaxDepth]";
  }
  if (stack.has(value)) {
    return "[Circular]";
  }
  stack.add(value);
  try {
    return Array.isArray(value) ? sanitizeLogArray(value, stack, depth) : sanitizeLogObject(value, stack, depth);
  } finally {
    stack.delete(value);
  }
}

function sanitizeLogArray(value: unknown[], stack: WeakSet<object>, depth: number): unknown[] {
  const length = safeArrayLength(value);
  if (length === undefined) {
    return [UNREADABLE_LOG_VALUE];
  }
  const output: unknown[] = [];
  const itemCount = Math.min(length, MAX_LOG_ARRAY_ITEMS);
  for (let index = 0; index < itemCount; index += 1) {
    const descriptor = safeGetOwnPropertyDescriptor(value, String(index));
    if (!descriptor) {
      output.push(SPARSE_LOG_ARRAY_HOLE);
      continue;
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      output.push(NON_DATA_LOG_PROPERTY);
      continue;
    }
    output.push(sanitizeLogValue(descriptor.value, stack, depth + 1));
  }
  if (length > MAX_LOG_ARRAY_ITEMS) {
    output.push(`[truncated ${length - MAX_LOG_ARRAY_ITEMS} items]`);
  }
  Object.setPrototypeOf(output, null);
  return output;
}

function sanitizeLogObject(value: object, stack: WeakSet<object>, depth: number): Record<string, unknown> {
  const output = Object.create(null) as Record<string, unknown>;
  const keys = safeOwnKeys(value);
  if (!keys) {
    return { unreadableObject: UNREADABLE_LOG_VALUE };
  }
  let processedFields = 0;
  let truncatedFields = 0;
  let omittedSymbolProperties = 0;
  for (const key of keys) {
    if (typeof key === "symbol") {
      omittedSymbolProperties += 1;
      continue;
    }
    if (processedFields >= MAX_LOG_OBJECT_FIELDS) {
      truncatedFields += 1;
      continue;
    }
    processedFields += 1;
    if (isSensitiveLogKey(key)) {
      setLogField(output, key, "[Redacted]");
      continue;
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      setLogField(output, key, UNREADABLE_LOG_VALUE);
      continue;
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      setLogField(output, key, NON_DATA_LOG_PROPERTY);
      continue;
    }
    setLogField(output, key, sanitizeLogValue(descriptor.value, stack, depth + 1));
  }
  if (truncatedFields > 0) {
    setLogField(output, "truncatedFields", truncatedFields);
  }
  if (omittedSymbolProperties > 0) {
    setLogField(output, "omittedSymbolProperties", omittedSymbolProperties);
  }
  return output;
}

function setLogField(output: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(output, uniqueLogKey(output, sanitizeLogKey(key)), {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

function uniqueLogKey(output: Record<string, unknown>, key: string): string {
  if (!Object.prototype.hasOwnProperty.call(output, key)) {
    return key;
  }
  for (let index = 2; index <= MAX_LOG_OBJECT_FIELDS + 2; index += 1) {
    const candidate = `${key}#${index}`;
    if (!Object.prototype.hasOwnProperty.call(output, candidate)) {
      return candidate;
    }
  }
  return `${key}#duplicate`;
}

function safeArrayLength(value: unknown[]): number | undefined {
  try {
    return value.length;
  } catch {
    return undefined;
  }
}

function safeOwnKeys(value: object): (string | symbol)[] | undefined {
  try {
    return Reflect.ownKeys(value);
  } catch {
    return undefined;
  }
}

function safeGetOwnPropertyDescriptor(value: object, key: string): PropertyDescriptor | undefined;
function safeGetOwnPropertyDescriptor(value: object, key: string | symbol): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return undefined;
  }
}

function validateLogLevel(value: unknown): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error" || value === "silent") {
    return value;
  }
  throw new Error("Logger.level must be one of debug, info, warn, error, or silent.");
}

function sanitizeLogString(value: unknown): string {
  const text = redactInlineSecrets(value).replace(LOG_CONTROL_CHARS_GLOBAL, " ");
  return truncateLogString(text);
}

function sanitizeLogKey(value: string): string {
  const normalized = redactInlineSecrets(value).replace(LOG_CONTROL_CHARS_GLOBAL, " ").trim() || "[field]";
  if (
    normalized.length <= MAX_LOG_KEY_CHARS &&
    utf8ByteLengthUpTo(normalized, MAX_LOG_KEY_BYTES) <= MAX_LOG_KEY_BYTES
  ) {
    return normalized;
  }
  return truncateLogText(normalized, MAX_LOG_KEY_CHARS, MAX_LOG_KEY_BYTES);
}

function truncateLogString(value: string): string {
  if (
    value.length <= MAX_LOG_STRING_CHARS &&
    utf8ByteLengthUpTo(value, MAX_LOG_STRING_BYTES) <= MAX_LOG_STRING_BYTES
  ) {
    return value;
  }
  return truncateLogText(value, MAX_LOG_STRING_CHARS, MAX_LOG_STRING_BYTES);
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

function truncateLogText(value: string, maxChars: number, maxBytes: number): string {
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

function isSensitiveLogKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized.includes("apikey") ||
    normalized.includes("accesskey") ||
    normalized.includes("authorization") ||
    normalized.includes("credential") ||
    normalized.includes("password") ||
    normalized.includes("privatekey") ||
    normalized.includes("secret") ||
    normalized.includes("sessionkey") ||
    normalized.endsWith("token") ||
    normalized.includes("accesstoken") ||
    normalized.includes("refreshtoken")
  );
}
