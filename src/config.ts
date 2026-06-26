import { isAbsolute } from "node:path";
import { assertNoDuplicateJsonObjectKeys } from "./jsonPreflight.js";
import { redactErrorMessage } from "./redaction.js";
import { safeGetOwnPropertyDescriptor, safeGetPrototypeOf, safeOwnKeys } from "./safeProto.js";
import { utf8ByteLength, utf8ByteLengthUpTo, utf8PrefixLength } from "./utf8.js";
import {
  MAX_DURATION_MS,
  MAX_CONCURRENT_JOBS,
  MAX_TOTAL_JOBS,
  MIN_STDIO_LINE_LENGTH,
  MAX_STDIO_LINE_LENGTH,
  MAX_EPUBCHECK_ARGS,
  MAX_EPUBCHECK_ARG_LENGTH,
  MAX_EPUBCHECK_ARG_BYTES,
  MAX_EPUBCHECK_ARGS_RAW_LENGTH,
  MAX_EPUBCHECK_ARGS_JSON_DEPTH,
  MAX_NUMERIC_ENV_LENGTH,
  MAX_NUMERIC_ENV_RAW_LENGTH,
  MAX_ENUM_ENV_RAW_LENGTH,
  MAX_ENV_NAME_LENGTH,
  MAX_ENV_NAME_BYTES,
  MAX_ENV_FIELDS,
  RAW_TRIM_PADDING_LENGTH,
  MAX_CONFIG_ERROR_CHARS,
  MAX_CONFIG_ERROR_BYTES,
  defaultStorageRoot,
  EPUB_LANGUAGE
} from "./constants.js";

export interface AppConfig {
  lockTimeoutMs: number;
  lockRetryMs: number;
  lockStaleMs: number;
  logLevel: LogLevel;
  operationTimeoutMs: number;
  jobRetentionMs: number;
  maxConcurrentJobs: number;
  maxJobs: number;
  stdioMaxLineLength: number;
  epubCheckCommand?: string;
  epubCheckArgs: string[];
  storageRoot: string;
  epubLanguage: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const CONFIG_ERROR_CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f]/gu;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const readEnv = envReader(env);
  const epubCheckCommand = parseExecutableCommand(readEnv("NOVELIST_EPUBCHECK_COMMAND"), "NOVELIST_EPUBCHECK_COMMAND");
  const epubCheckArgs = parseEpubCheckArgs(epubCheckCommand, readEnv("NOVELIST_EPUBCHECK_ARGS"));
  return {
    lockTimeoutMs: parsePositiveInt(readEnv("NOVELIST_LOCK_TIMEOUT_MS"), 5000, "NOVELIST_LOCK_TIMEOUT_MS", MAX_DURATION_MS),
    lockRetryMs: parsePositiveInt(readEnv("NOVELIST_LOCK_RETRY_MS"), 50, "NOVELIST_LOCK_RETRY_MS", MAX_DURATION_MS),
    lockStaleMs: parsePositiveInt(readEnv("NOVELIST_LOCK_STALE_MS"), 600000, "NOVELIST_LOCK_STALE_MS", MAX_DURATION_MS),
    logLevel: parseLogLevel(readEnv("NOVELIST_LOG_LEVEL")),
    operationTimeoutMs: parsePositiveInt(readEnv("NOVELIST_OPERATION_TIMEOUT_MS"), 300000, "NOVELIST_OPERATION_TIMEOUT_MS", MAX_DURATION_MS),
    jobRetentionMs: parsePositiveInt(readEnv("NOVELIST_JOB_RETENTION_MS"), 604800000, "NOVELIST_JOB_RETENTION_MS", MAX_DURATION_MS),
    maxConcurrentJobs: parsePositiveInt(readEnv("NOVELIST_MAX_CONCURRENT_JOBS"), 4, "NOVELIST_MAX_CONCURRENT_JOBS", MAX_CONCURRENT_JOBS),
    maxJobs: parsePositiveInt(readEnv("NOVELIST_MAX_JOBS"), 1024, "NOVELIST_MAX_JOBS", MAX_TOTAL_JOBS),
    stdioMaxLineLength: parseStdioMaxLineLength(readEnv("NOVELIST_STDIO_MAX_LINE_LENGTH")),
    epubCheckCommand,
    epubCheckArgs,
    storageRoot: parseStorageRoot(readEnv("NOVELIST_STORAGE_ROOT")),
    epubLanguage: parseEpubLanguage(readEnv("NOVELIST_EPUB_LANGUAGE"))
  };
}

function parseStorageRoot(value: string | undefined): string {
  const root = emptyToUndefined(value, "NOVELIST_STORAGE_ROOT", 4096);
  if (!root) {
    return defaultStorageRoot();
  }
  if (!isAbsolute(root)) {
    throw new Error("NOVELIST_STORAGE_ROOT must be an absolute path.");
  }
  return root;
}

function parseEpubLanguage(value: string | undefined): string {
  const lang = emptyToUndefined(value, "NOVELIST_EPUB_LANGUAGE", 1024);
  if (!lang) {
    return EPUB_LANGUAGE;
  }
  if (lang.length > 64) {
    throw new Error("NOVELIST_EPUB_LANGUAGE must be at most 64 characters.");
  }
  return lang;
}

function envReader(env: Record<string, string | undefined>): (name: string) => string | undefined {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("Configuration environment must be a non-array object.");
  }
  validateEnvironmentObject(env);
  return (name: string): string | undefined => {
    const descriptor = safeGetOwnPropertyDescriptor(env, name, "Configuration environment");
    if (!descriptor) {
      return undefined;
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${name} environment value must be an enumerable data property.`);
    }
    if (descriptor.value !== undefined && typeof descriptor.value !== "string") {
      throw new Error(`${name} environment value must be a string when provided.`);
    }
    return descriptor.value;
  };
}

function validateEnvironmentObject(env: object): void {
  const prototype = safeGetPrototypeOf(env, "Configuration environment");
  if (prototype !== Object.prototype && prototype !== null && env !== process.env) {
    throw new Error("Configuration environment must be a plain object or process.env.");
  }
  let fieldCount = 0;
  for (const key of safeOwnKeys(env, "Configuration environment")) {
    fieldCount += 1;
    if (fieldCount > MAX_ENV_FIELDS) {
      throw new Error(`Configuration environment must contain at most ${MAX_ENV_FIELDS} variables.`);
    }
    if (typeof key !== "string") {
      throw new Error("Configuration environment must not contain symbol properties.");
    }
    validateEnvironmentKey(key);
    const descriptor = safeGetOwnPropertyDescriptor(env, key, "Configuration environment");
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${key} environment value must be an enumerable data property.`);
    }
    if (descriptor.value !== undefined && typeof descriptor.value !== "string") {
      throw new Error(`${key} environment value must be a string when provided.`);
    }
  }
}

function validateEnvironmentKey(key: string): void {
  if (key.length === 0) {
    throw new Error("Configuration environment names must be non-empty strings.");
  }
  if (key.length > MAX_ENV_NAME_LENGTH) {
    throw new Error(`Configuration environment names must be at most ${MAX_ENV_NAME_LENGTH} characters.`);
  }
  if (utf8ByteLengthUpTo(key, MAX_ENV_NAME_BYTES) > MAX_ENV_NAME_BYTES) {
    throw new Error(`Configuration environment names must be at most ${MAX_ENV_NAME_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(key)) {
    throw new Error("Configuration environment names must not contain control characters.");
  }
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string, max: number): number {
  const raw = trimmedOrUndefined(value, name, MAX_NUMERIC_ENV_RAW_LENGTH);
  if (raw === undefined) {
    return fallback;
  }
  if (raw.length > MAX_NUMERIC_ENV_LENGTH) {
    throw new Error(`${name} must be at most ${MAX_NUMERIC_ENV_LENGTH} digits.`);
  }
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${name} must be a positive decimal integer.`);
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive decimal integer.`);
  }
  if (parsed > max) {
    throw new Error(`${name} must be less than or equal to ${max}.`);
  }
  return parsed;
}

function parseStdioMaxLineLength(value: string | undefined): number {
  const parsed = parsePositiveInt(value, 1048576, "NOVELIST_STDIO_MAX_LINE_LENGTH", MAX_STDIO_LINE_LENGTH);
  if (parsed < MIN_STDIO_LINE_LENGTH) {
    throw new Error(`NOVELIST_STDIO_MAX_LINE_LENGTH must be greater than or equal to ${MIN_STDIO_LINE_LENGTH}.`);
  }
  return parsed;
}

function parseNonNegativeInt(value: string | undefined, fallback: number, name: string, max: number): number {
  const raw = trimmedOrUndefined(value, name, MAX_NUMERIC_ENV_RAW_LENGTH);
  if (raw === undefined) {
    return fallback;
  }
  if (raw.length > MAX_NUMERIC_ENV_LENGTH) {
    throw new Error(`${name} must be at most ${MAX_NUMERIC_ENV_LENGTH} digits.`);
  }
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${name} must be a non-negative decimal integer.`);
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative decimal integer.`);
  }
  if (parsed > max) {
    throw new Error(`${name} must be less than or equal to ${max}.`);
  }
  return parsed;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const raw = trimmedOrUndefined(value, "NOVELIST_LOG_LEVEL", MAX_ENUM_ENV_RAW_LENGTH);
  if (!raw) {
    return "warn";
  }
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error" || raw === "silent") {
    return raw;
  }
  throw new Error("NOVELIST_LOG_LEVEL must be one of debug, info, warn, error, or silent.");
}

function parseExecutableCommand(value: string | undefined, name: string): string | undefined {
  const command = emptyToUndefined(value, name, 1024 + RAW_TRIM_PADDING_LENGTH);
  if (!command) {
    return undefined;
  }
  if (command.length > 1024) {
    throw new Error(`${name} must be at most 1024 characters.`);
  }
  if (utf8ByteLengthUpTo(command, 1024) > 1024) {
    throw new Error(`${name} must be at most 1024 UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(command)) {
    throw new Error(`${name} must not contain control characters.`);
  }
  if (/\s/u.test(command)) {
    throw new Error(`${name} must be a single executable path or PATH command without whitespace; put arguments in NOVELIST_EPUBCHECK_ARGS.`);
  }
  if ((command.includes("/") || command.includes("\\")) && !isAbsolute(command)) {
    throw new Error(`${name} must be either a PATH command name or an absolute executable path.`);
  }
  if (!command.includes("/") && !command.includes("\\") && !isSafePathCommand(command)) {
    throw new Error(`${name} PATH command names must contain only letters, numbers, dot, underscore, or hyphen, must not start with hyphen, and must not be . or ...`);
  }
  return command;
}

function isSafePathCommand(command: string): boolean {
  return /^[A-Za-z0-9._-]+$/u.test(command) && !command.startsWith("-") && command !== "." && command !== "..";
}

function emptyToUndefined(value: string | undefined, name: string, maxRawLength: number): string | undefined {
  return trimmedOrUndefined(value, name, maxRawLength);
}

function trimmedOrUndefined(value: string | undefined, name: string, maxRawLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.length > maxRawLength) {
    throw new Error(`${name} must be at most ${maxRawLength} characters before trimming.`);
  }
  if (utf8ByteLengthUpTo(value, maxRawLength) > maxRawLength) {
    throw new Error(`${name} must be at most ${maxRawLength} UTF-8 bytes before trimming.`);
  }
  return value.trim() || undefined;
}

function parseArgs(value: string): string[] {
  if (value.length > MAX_EPUBCHECK_ARGS_RAW_LENGTH) {
    throw new Error(`NOVELIST_EPUBCHECK_ARGS must be at most ${MAX_EPUBCHECK_ARGS_RAW_LENGTH} characters before parsing.`);
  }
  if (utf8ByteLengthUpTo(value, MAX_EPUBCHECK_ARGS_RAW_LENGTH) > MAX_EPUBCHECK_ARGS_RAW_LENGTH) {
    throw new Error(`NOVELIST_EPUBCHECK_ARGS must be at most ${MAX_EPUBCHECK_ARGS_RAW_LENGTH} UTF-8 bytes before parsing.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      assertNoDuplicateJsonObjectKeys(trimmed, "NOVELIST_EPUBCHECK_ARGS JSON array", MAX_EPUBCHECK_ARGS_JSON_DEPTH);
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      throw new Error(`NOVELIST_EPUBCHECK_ARGS JSON array is malformed: ${errorMessage(error)}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error("NOVELIST_EPUBCHECK_ARGS JSON value must be an array.");
    }
    return validateArgs(parsed);
  }
  return validateArgs(trimmed.split(/\s+/).map((part) => part.trim()).filter(Boolean));
}

function errorMessage(error: unknown): string {
  return truncateConfigError(redactErrorMessage(error).replace(CONFIG_ERROR_CONTROL_CHARS_GLOBAL, " "));
}

function truncateConfigError(message: string): string {
  if (
    message.length <= MAX_CONFIG_ERROR_CHARS &&
    utf8ByteLengthUpTo(message, MAX_CONFIG_ERROR_BYTES) <= MAX_CONFIG_ERROR_BYTES
  ) {
    return message;
  }
  if (message.length > MAX_CONFIG_ERROR_CHARS) {
    const candidate = `${message.slice(0, MAX_CONFIG_ERROR_CHARS)}... [truncated ${message.length - MAX_CONFIG_ERROR_CHARS} chars]`;
    if (utf8ByteLengthUpTo(candidate, MAX_CONFIG_ERROR_BYTES) <= MAX_CONFIG_ERROR_BYTES) {
      return candidate;
    }
  }
  const marker = `... [truncated ${Math.max(0, utf8ByteLength(message) - MAX_CONFIG_ERROR_BYTES)} UTF-8 bytes]`;
  const markerBytes = utf8ByteLength(marker);
  if (markerBytes > MAX_CONFIG_ERROR_BYTES) {
    return marker;
  }
  return `${message.slice(0, utf8PrefixLength(message, MAX_CONFIG_ERROR_BYTES - markerBytes))}${marker}`;
}

function parseEpubCheckArgs(command: string | undefined, value: string | undefined): string[] {
  if (!command) {
    const raw = trimmedOrUndefined(value, "NOVELIST_EPUBCHECK_ARGS", MAX_EPUBCHECK_ARGS_RAW_LENGTH);
    if (raw !== undefined) {
      throw new Error("NOVELIST_EPUBCHECK_ARGS requires NOVELIST_EPUBCHECK_COMMAND.");
    }
    return ["{epub}"];
  }
  const args = parseArgs(value ?? "{epub}");
  if (countEpubPlaceholders(args) !== 1) {
    throw new Error("NOVELIST_EPUBCHECK_ARGS must include exactly one {epub} when NOVELIST_EPUBCHECK_COMMAND is configured.");
  }
  return args;
}

function countEpubPlaceholders(args: string[]): number {
  let count = 0;
  for (const arg of args) {
    count += arg.split("{epub}").length - 1;
  }
  return count;
}

function validateArgs(value: unknown[]): string[] {
  if (safeGetPrototypeOf(value, "NOVELIST_EPUBCHECK_ARGS JSON array") !== Array.prototype) {
    throw new Error("NOVELIST_EPUBCHECK_ARGS JSON value must be a standard array.");
  }
  if (value.length > MAX_EPUBCHECK_ARGS) {
    throw new Error(`NOVELIST_EPUBCHECK_ARGS must contain at most ${MAX_EPUBCHECK_ARGS} arguments.`);
  }
  const args: string[] = [];
  for (const key of safeOwnKeys(value, "NOVELIST_EPUBCHECK_ARGS JSON array")) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string") {
      throw new Error("NOVELIST_EPUBCHECK_ARGS JSON array must not contain symbol properties.");
    }
    if (!isArrayIndexKey(key, value.length)) {
      throw new Error(`NOVELIST_EPUBCHECK_ARGS.${key} is not a supported array field.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, "NOVELIST_EPUBCHECK_ARGS JSON array");
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`NOVELIST_EPUBCHECK_ARGS[${key}] must be an enumerable data property.`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = safeGetOwnPropertyDescriptor(value, String(index), "NOVELIST_EPUBCHECK_ARGS JSON array");
    if (!descriptor) {
      throw new Error(`NOVELIST_EPUBCHECK_ARGS[${index}] must not be a sparse array hole.`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`NOVELIST_EPUBCHECK_ARGS[${index}] must be an enumerable data property.`);
    }
    if (typeof descriptor.value !== "string" || descriptor.value.length === 0) {
      throw new Error(`NOVELIST_EPUBCHECK_ARGS[${index}] must be a non-empty string.`);
    }
    if (descriptor.value.trim() !== descriptor.value) {
      throw new Error(`NOVELIST_EPUBCHECK_ARGS[${index}] must not have leading or trailing whitespace.`);
    }
    if (descriptor.value.length > MAX_EPUBCHECK_ARG_LENGTH) {
      throw new Error(`NOVELIST_EPUBCHECK_ARGS[${index}] must be at most ${MAX_EPUBCHECK_ARG_LENGTH} characters.`);
    }
    if (utf8ByteLengthUpTo(descriptor.value, MAX_EPUBCHECK_ARG_BYTES) > MAX_EPUBCHECK_ARG_BYTES) {
      throw new Error(`NOVELIST_EPUBCHECK_ARGS[${index}] must be at most ${MAX_EPUBCHECK_ARG_BYTES} UTF-8 bytes.`);
    }
    if (/[\u0000-\u001f\u007f]/u.test(descriptor.value)) {
      throw new Error(`NOVELIST_EPUBCHECK_ARGS[${index}] must not contain control characters.`);
    }
    args.push(descriptor.value);
  }
  return args;
}

function isArrayIndexKey(value: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    return false;
  }
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === value;
}
