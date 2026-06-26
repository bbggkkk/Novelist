import { dirname, isAbsolute, resolve } from "node:path";
import { assertNoDuplicateJsonObjectKeys } from "./jsonPreflight.js";
import { redactErrorMessage } from "./redaction.js";

export interface AppConfig {
  dataDir?: string;
  lockTimeoutMs: number;
  lockRetryMs: number;
  lockStaleMs: number;
  logLevel: LogLevel;
  operationTimeoutMs: number;
  reviewMaxRetries: number;
  jobRetentionMs: number;
  maxConcurrentJobs: number;
  maxJobs: number;
  stdioMaxLineLength: number;
  agentProvider: AgentProvider;
  openaiBaseUrl: string;
  openaiApiKey?: string;
  openaiModel: string;
  openaiTimeoutMs: number;
  openaiMaxRetries: number;
  openaiRetryBaseMs: number;
  epubCheckCommand?: string;
  epubCheckArgs: string[];
}

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type AgentProvider = "stub" | "openai";

const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RETRY_COUNT = 20;
const MAX_CONCURRENT_JOBS = 64;
const MAX_TOTAL_JOBS = 100000;
const MIN_STDIO_LINE_LENGTH = 256;
const MAX_STDIO_LINE_LENGTH = 16 * 1024 * 1024;
const MAX_OPENAI_API_KEY_LENGTH = 4096;
const MAX_OPENAI_API_KEY_BYTES = 4096;
const MAX_OPENAI_MODEL_LENGTH = 200;
const MAX_OPENAI_MODEL_BYTES = 200;
const MAX_OPENAI_BASE_URL_LENGTH = 2048;
const MAX_OPENAI_BASE_URL_BYTES = 2048;
const MAX_DATA_DIR_LENGTH = 4096;
const MAX_DATA_DIR_BYTES = 4096;
const MAX_EPUBCHECK_ARGS = 64;
const MAX_EPUBCHECK_ARG_LENGTH = 4096;
const MAX_EPUBCHECK_ARG_BYTES = 4096;
const MAX_EPUBCHECK_ARGS_RAW_LENGTH = 300 * 1024;
const MAX_EPUBCHECK_ARGS_JSON_DEPTH = 64;
const MAX_NUMERIC_ENV_LENGTH = 32;
const MAX_NUMERIC_ENV_RAW_LENGTH = 1024;
const MAX_ENUM_ENV_RAW_LENGTH = 1024;
const MAX_ENV_NAME_LENGTH = 256;
const MAX_ENV_NAME_BYTES = 512;
const MAX_ENV_FIELDS = 10000;
const RAW_TRIM_PADDING_LENGTH = 1024;
const MAX_CONFIG_ERROR_CHARS = 1000;
const MAX_CONFIG_ERROR_BYTES = 1000;
const CONFIG_ERROR_CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f]/gu;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const readEnv = envReader(env);
  const epubCheckCommand = parseExecutableCommand(readEnv("NOVELIST_EPUBCHECK_COMMAND"), "NOVELIST_EPUBCHECK_COMMAND");
  const epubCheckArgs = parseEpubCheckArgs(epubCheckCommand, readEnv("NOVELIST_EPUBCHECK_ARGS"));
  return {
    dataDir: parseDataDir(readEnv("NOVELIST_DATA_DIR")),
    lockTimeoutMs: parsePositiveInt(readEnv("NOVELIST_LOCK_TIMEOUT_MS"), 5000, "NOVELIST_LOCK_TIMEOUT_MS", MAX_DURATION_MS),
    lockRetryMs: parsePositiveInt(readEnv("NOVELIST_LOCK_RETRY_MS"), 50, "NOVELIST_LOCK_RETRY_MS", MAX_DURATION_MS),
    lockStaleMs: parsePositiveInt(readEnv("NOVELIST_LOCK_STALE_MS"), 600000, "NOVELIST_LOCK_STALE_MS", MAX_DURATION_MS),
    logLevel: parseLogLevel(readEnv("NOVELIST_LOG_LEVEL")),
    operationTimeoutMs: parsePositiveInt(readEnv("NOVELIST_OPERATION_TIMEOUT_MS"), 300000, "NOVELIST_OPERATION_TIMEOUT_MS", MAX_DURATION_MS),
    reviewMaxRetries: parseNonNegativeInt(readEnv("NOVELIST_REVIEW_MAX_RETRIES"), 2, "NOVELIST_REVIEW_MAX_RETRIES", MAX_RETRY_COUNT),
    jobRetentionMs: parsePositiveInt(readEnv("NOVELIST_JOB_RETENTION_MS"), 604800000, "NOVELIST_JOB_RETENTION_MS", MAX_DURATION_MS),
    maxConcurrentJobs: parsePositiveInt(readEnv("NOVELIST_MAX_CONCURRENT_JOBS"), 4, "NOVELIST_MAX_CONCURRENT_JOBS", MAX_CONCURRENT_JOBS),
    maxJobs: parsePositiveInt(readEnv("NOVELIST_MAX_JOBS"), 1024, "NOVELIST_MAX_JOBS", MAX_TOTAL_JOBS),
    stdioMaxLineLength: parseStdioMaxLineLength(readEnv("NOVELIST_STDIO_MAX_LINE_LENGTH")),
    agentProvider: parseAgentProvider(readEnv("NOVELIST_AGENT_PROVIDER")),
    openaiBaseUrl: parseOpenAiBaseUrl(readEnv("NOVELIST_OPENAI_BASE_URL")),
    openaiApiKey: parseOpenAiApiKey(readEnv("NOVELIST_OPENAI_API_KEY")),
    openaiModel: parseOpenAiModel(readEnv("NOVELIST_OPENAI_MODEL")),
    openaiTimeoutMs: parsePositiveInt(readEnv("NOVELIST_OPENAI_TIMEOUT_MS"), 60000, "NOVELIST_OPENAI_TIMEOUT_MS", MAX_DURATION_MS),
    openaiMaxRetries: parseNonNegativeInt(readEnv("NOVELIST_OPENAI_MAX_RETRIES"), 2, "NOVELIST_OPENAI_MAX_RETRIES", MAX_RETRY_COUNT),
    openaiRetryBaseMs: parsePositiveInt(readEnv("NOVELIST_OPENAI_RETRY_BASE_MS"), 250, "NOVELIST_OPENAI_RETRY_BASE_MS", MAX_DURATION_MS),
    epubCheckCommand,
    epubCheckArgs
  };
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

function safeGetPrototypeOf(value: object, label: string): object | null {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    throw new Error(`${label} prototype must be readable.`);
  }
}

function safeOwnKeys(value: object, label: string): Array<string | symbol> {
  try {
    return Reflect.ownKeys(value);
  } catch {
    throw new Error(`${label} keys must be readable.`);
  }
}

function safeGetOwnPropertyDescriptor(value: object, key: string, label: string): PropertyDescriptor | undefined;
function safeGetOwnPropertyDescriptor(value: object, key: string | symbol, label: string): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new Error(`${label} property descriptors must be readable.`);
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

function parseDataDir(value: string | undefined): string | undefined {
  const dataDir = emptyToUndefined(value, "NOVELIST_DATA_DIR", MAX_DATA_DIR_LENGTH + RAW_TRIM_PADDING_LENGTH);
  if (!dataDir) {
    return undefined;
  }
  if (dataDir.length > MAX_DATA_DIR_LENGTH) {
    throw new Error(`NOVELIST_DATA_DIR must be at most ${MAX_DATA_DIR_LENGTH} characters.`);
  }
  if (utf8ByteLengthUpTo(dataDir, MAX_DATA_DIR_BYTES) > MAX_DATA_DIR_BYTES) {
    throw new Error(`NOVELIST_DATA_DIR must be at most ${MAX_DATA_DIR_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(dataDir)) {
    throw new Error("NOVELIST_DATA_DIR must not contain control characters.");
  }
  if (!isAbsolute(dataDir)) {
    throw new Error("NOVELIST_DATA_DIR must be an absolute path.");
  }
  const normalized = resolve(dataDir);
  if (dirname(normalized) === normalized) {
    throw new Error("NOVELIST_DATA_DIR must not be the filesystem root.");
  }
  return normalized;
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

function parseAgentProvider(value: string | undefined): AgentProvider {
  const raw = trimmedOrUndefined(value, "NOVELIST_AGENT_PROVIDER", MAX_ENUM_ENV_RAW_LENGTH);
  if (!raw) {
    return "stub";
  }
  if (raw === "stub" || raw === "openai") {
    return raw;
  }
  throw new Error("NOVELIST_AGENT_PROVIDER must be stub or openai.");
}

function parseOpenAiBaseUrl(value: string | undefined): string {
  const raw = trimmedOrUndefined(value, "NOVELIST_OPENAI_BASE_URL", MAX_OPENAI_BASE_URL_LENGTH + RAW_TRIM_PADDING_LENGTH) ?? "https://api.openai.com/v1";
  if (raw.length > MAX_OPENAI_BASE_URL_LENGTH) {
    throw new Error(`NOVELIST_OPENAI_BASE_URL must be at most ${MAX_OPENAI_BASE_URL_LENGTH} characters.`);
  }
  if (utf8ByteLengthUpTo(raw, MAX_OPENAI_BASE_URL_BYTES) > MAX_OPENAI_BASE_URL_BYTES) {
    throw new Error(`NOVELIST_OPENAI_BASE_URL must be at most ${MAX_OPENAI_BASE_URL_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(raw)) {
    throw new Error("NOVELIST_OPENAI_BASE_URL must not contain control characters.");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("NOVELIST_OPENAI_BASE_URL must be a valid http or https URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("NOVELIST_OPENAI_BASE_URL must be a valid http or https URL.");
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error("NOVELIST_OPENAI_BASE_URL must use https unless the host is localhost or loopback.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("NOVELIST_OPENAI_BASE_URL must not include username or password credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("NOVELIST_OPENAI_BASE_URL must not include query strings or fragments.");
  }
  const normalized = parsed.toString().replace(/\/$/g, "");
  if (normalized.length > MAX_OPENAI_BASE_URL_LENGTH) {
    throw new Error(`NOVELIST_OPENAI_BASE_URL normalized URL must be at most ${MAX_OPENAI_BASE_URL_LENGTH} characters.`);
  }
  if (utf8ByteLengthUpTo(normalized, MAX_OPENAI_BASE_URL_BYTES) > MAX_OPENAI_BASE_URL_BYTES) {
    throw new Error(`NOVELIST_OPENAI_BASE_URL normalized URL must be at most ${MAX_OPENAI_BASE_URL_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error("NOVELIST_OPENAI_BASE_URL normalized URL must not contain control characters.");
  }
  return normalized;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function parseOpenAiModel(value: string | undefined): string {
  const model = emptyToUndefined(value, "NOVELIST_OPENAI_MODEL", MAX_OPENAI_MODEL_LENGTH + RAW_TRIM_PADDING_LENGTH) ?? "gpt-4.1-mini";
  if (model.length > MAX_OPENAI_MODEL_LENGTH) {
    throw new Error(`NOVELIST_OPENAI_MODEL must be at most ${MAX_OPENAI_MODEL_LENGTH} characters.`);
  }
  if (utf8ByteLengthUpTo(model, MAX_OPENAI_MODEL_BYTES) > MAX_OPENAI_MODEL_BYTES) {
    throw new Error(`NOVELIST_OPENAI_MODEL must be at most ${MAX_OPENAI_MODEL_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(model)) {
    throw new Error("NOVELIST_OPENAI_MODEL must not contain control characters.");
  }
  if (/\s/u.test(model)) {
    throw new Error("NOVELIST_OPENAI_MODEL must not contain whitespace.");
  }
  return model;
}

function parseOpenAiApiKey(value: string | undefined): string | undefined {
  const apiKey = emptyToUndefined(value, "NOVELIST_OPENAI_API_KEY", MAX_OPENAI_API_KEY_LENGTH + RAW_TRIM_PADDING_LENGTH);
  if (!apiKey) {
    return undefined;
  }
  if (apiKey.length > MAX_OPENAI_API_KEY_LENGTH) {
    throw new Error(`NOVELIST_OPENAI_API_KEY must be at most ${MAX_OPENAI_API_KEY_LENGTH} characters.`);
  }
  if (utf8ByteLengthUpTo(apiKey, MAX_OPENAI_API_KEY_BYTES) > MAX_OPENAI_API_KEY_BYTES) {
    throw new Error(`NOVELIST_OPENAI_API_KEY must be at most ${MAX_OPENAI_API_KEY_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(apiKey)) {
    throw new Error("NOVELIST_OPENAI_API_KEY must not contain control characters.");
  }
  if (/\s/u.test(apiKey)) {
    throw new Error("NOVELIST_OPENAI_API_KEY must not contain whitespace.");
  }
  return apiKey;
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

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const scalar of value) {
    bytes += utf8ScalarByteLength(scalar);
  }
  return bytes;
}

function utf8PrefixLength(value: string, maxBytes: number): number {
  let chars = 0;
  let bytes = 0;
  for (const scalar of value) {
    const nextBytes = bytes + utf8ScalarByteLength(scalar);
    if (nextBytes > maxBytes) {
      break;
    }
    chars += scalar.length;
    bytes = nextBytes;
  }
  return chars;
}

function utf8ScalarByteLength(scalar: string): number {
  const codePoint = scalar.codePointAt(0);
  if (codePoint === undefined) {
    return 0;
  }
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
