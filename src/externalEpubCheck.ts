import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AppConfig } from "./config.js";
import { MAX_EPUB_ARCHIVE_BYTES } from "./epub.js";
import { redactErrorMessage, redactInlineSecrets } from "./redaction.js";

export interface ExternalEpubCheckResult {
  configured: boolean;
  valid: boolean;
  command?: string;
  resolvedCommand?: string;
  args?: string[];
  stdout?: string;
  stderr?: string;
  error?: string;
}

const MAX_CAPTURED_OUTPUT_CHARS = 16 * 1024;
const MAX_CAPTURED_OUTPUT_BYTES = 16 * 1024;
const MAX_PROCESS_BUFFER_BYTES = 1024 * 1024;
const MAX_REPORTED_COMMAND_CHARS = 1024;
const MAX_REPORTED_COMMAND_BYTES = 1024;
const MAX_REPORTED_ARG_CHARS = 1024;
const MAX_REPORTED_ARG_BYTES = 1024;
const MAX_REPORTED_ARGS = 64;
const MAX_REPORTED_ERROR_CHARS = 4000;
const MAX_REPORTED_ERROR_BYTES = 4000;
const MAX_EPUB_PATH_CHARS = 4096;
const MAX_EPUB_PATH_BYTES = 4096;
const MAX_EXEC_ARGS = 64;
const MAX_EXEC_ARG_TEMPLATE_CHARS = 4096;
const MAX_EXEC_ARG_TEMPLATE_BYTES = 4096;
const MAX_EXEC_ARG_CHARS = 8192;
const MAX_EXEC_ARGV_BYTES = 256 * 1024;
const EXEC_ARG_CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const REPORTED_FIELD_CONTROL_CHARS_GLOBAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const REPORTED_ERROR_CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f]/gu;
const MAX_VALIDATOR_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SET_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_VALIDATOR_PATH = "/usr/local/bin:/usr/bin:/bin";
const DEFAULT_VALIDATOR_CWD = "/";
const EXTERNAL_VALIDATOR_CONFIG_FIELDS = new Set<keyof AppConfig>([
  "dataDir",
  "lockTimeoutMs",
  "lockRetryMs",
  "lockStaleMs",
  "logLevel",
  "operationTimeoutMs",
  "reviewMaxRetries",
  "jobRetentionMs",
  "maxConcurrentJobs",
  "maxJobs",
  "stdioMaxLineLength",
  "agentProvider",
  "openaiBaseUrl",
  "openaiApiKey",
  "openaiModel",
  "openaiTimeoutMs",
  "openaiMaxRetries",
  "openaiRetryBaseMs",
  "epubCheckCommand",
  "epubCheckArgs"
]);
const encoder = new TextEncoder();

interface ExternalValidatorConfig {
  operationTimeoutMs: unknown;
  epubCheckCommand?: unknown;
  epubCheckArgs?: unknown;
}

export async function runExternalEpubCheck(epubPath: string, config: AppConfig, timeoutMs?: number): Promise<ExternalEpubCheckResult> {
  const validatorConfig = validateConfigObject(config);
  if (validatorConfig.epubCheckCommand === undefined) {
    return externalEpubCheckResult({ configured: false, valid: true });
  }
  const command = validatorConfig.epubCheckCommand;
  validateCommand(command);
  const executableCommand = await resolveCommandPath(command);
  validateEpubPath(epubPath);
  const operationTimeoutMs = validateTimeout(validatorConfig.operationTimeoutMs, "External EPUB validator operationTimeoutMs");
  const remainingTimeoutMs = validateTimeout(timeoutMs ?? validatorConfig.operationTimeoutMs, "External EPUB validator timeoutMs");
  const boundedTimeoutMs = timeoutMsForTimer(Math.max(1, Math.min(operationTimeoutMs, remainingTimeoutMs)));
  const argTemplates = validateArgTemplates(validatorConfig.epubCheckArgs);
  if (countEpubPlaceholders(argTemplates) !== 1) {
    throw new Error("External EPUB validator arguments must include exactly one {epub}.");
  }
  const args = argTemplates.map((arg) => arg.replaceAll("{epub}", epubPath));
  validateRuntimeArgs(args);
  await assertReadableRegularEpubFile(epubPath);
  const reportedCommand = truncateField(command, MAX_REPORTED_COMMAND_CHARS, MAX_REPORTED_COMMAND_BYTES);
  const reportedResolvedCommand = executableCommand === command ? undefined : truncateField(executableCommand, MAX_REPORTED_COMMAND_CHARS, MAX_REPORTED_COMMAND_BYTES);
  const reportedArgs = reportedArgsList(args);
  return new Promise((resolveCheck) => {
    execFile(
      executableCommand,
      args,
      {
        encoding: "utf8",
        timeout: boundedTimeoutMs,
        maxBuffer: MAX_PROCESS_BUFFER_BYTES,
        cwd: DEFAULT_VALIDATOR_CWD,
        env: externalValidatorEnv()
      },
      (error, stdout, stderr) => {
        if (error) {
          resolveCheck(externalEpubCheckResult({
            configured: true,
            valid: false,
            command: reportedCommand,
            ...(reportedResolvedCommand !== undefined ? { resolvedCommand: reportedResolvedCommand } : {}),
            args: reportedArgs,
            stdout: truncateOutput(stdout),
            stderr: truncateOutput(stderr),
            error: truncateReportedError(error)
          }));
          return;
        }
        resolveCheck(externalEpubCheckResult({
          configured: true,
          valid: true,
          command: reportedCommand,
          ...(reportedResolvedCommand !== undefined ? { resolvedCommand: reportedResolvedCommand } : {}),
          args: reportedArgs,
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr)
        }));
      }
    );
  });
}

function countEpubPlaceholders(args: string[]): number {
  let count = 0;
  for (const arg of args) {
    count += arg.split("{epub}").length - 1;
  }
  return count;
}

function externalEpubCheckResult(fields: ExternalEpubCheckResult): ExternalEpubCheckResult {
  const snapshot = snapshotExternalEpubCheckResult(fields);
  const result: ExternalEpubCheckResult = { ...snapshot };
  if (snapshot.args !== undefined) {
    result.args = stableJsonStringArray(snapshot.args);
  }
  Object.defineProperty(result, "toJSON", {
    enumerable: false,
    value: () => snapshotExternalEpubCheckJsonValue(snapshot)
  });
  return result;
}

function snapshotExternalEpubCheckResult(fields: ExternalEpubCheckResult): ExternalEpubCheckResult {
  return {
    configured: fields.configured,
    valid: fields.valid,
    ...(fields.command !== undefined ? { command: fields.command } : {}),
    ...(fields.resolvedCommand !== undefined ? { resolvedCommand: fields.resolvedCommand } : {}),
    ...(fields.args !== undefined ? { args: [...fields.args] } : {}),
    ...(fields.stdout !== undefined ? { stdout: fields.stdout } : {}),
    ...(fields.stderr !== undefined ? { stderr: fields.stderr } : {}),
    ...(fields.error !== undefined ? { error: fields.error } : {})
  };
}

function stableJsonStringArray(values: string[]): string[] {
  const snapshot = [...values];
  const result = [...snapshot];
  Object.defineProperty(result, "toJSON", {
    enumerable: false,
    value: () => [...snapshot]
  });
  return result;
}

function snapshotExternalEpubCheckJsonValue(fields: ExternalEpubCheckResult): ExternalEpubCheckResult {
  const snapshot = snapshotExternalEpubCheckResult(fields);
  const result: ExternalEpubCheckResult = { ...snapshot };
  if (snapshot.args !== undefined) {
    result.args = stableJsonStringArray(snapshot.args);
  }
  Object.setPrototypeOf(result, null);
  return result;
}

function validateConfigObject(config: unknown): ExternalValidatorConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("External EPUB validator config must be an object.");
  }
  const prototype = safeGetPrototypeOf(config, "External EPUB validator config");
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("External EPUB validator config must be a plain object.");
  }
  for (const key of safeOwnKeys(config, "External EPUB validator config")) {
    if (typeof key !== "string") {
      throw new Error("External EPUB validator config must not contain symbol properties.");
    }
    if (!EXTERNAL_VALIDATOR_CONFIG_FIELDS.has(key as keyof AppConfig)) {
      throw new Error(`External EPUB validator config.${key} is not a supported field.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(config, key, "External EPUB validator config");
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`External EPUB validator config.${key} must be an enumerable data property.`);
    }
  }
  return {
    operationTimeoutMs: readRequiredConfigField(config, "operationTimeoutMs"),
    epubCheckCommand: readOptionalConfigField(config, "epubCheckCommand"),
    epubCheckArgs: readOptionalConfigField(config, "epubCheckArgs")
  };
}

function readRequiredConfigField(config: object, key: keyof AppConfig): unknown {
  const value = readOptionalConfigField(config, key);
  if (value === undefined) {
    throw new Error(`External EPUB validator config.${key} is required.`);
  }
  return value;
}

function readOptionalConfigField(config: object, key: keyof AppConfig): unknown {
  const descriptor = safeGetOwnPropertyDescriptor(config, key, "External EPUB validator config");
  if (!descriptor) {
    return undefined;
  }
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new Error(`External EPUB validator config.${key} must be an enumerable data property.`);
  }
  return descriptor.value;
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

function validateCommand(command: unknown): asserts command is string {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("External EPUB validator command must be a non-empty string.");
  }
  if (command.length > MAX_REPORTED_COMMAND_CHARS) {
    throw new Error(`External EPUB validator command must be at most ${MAX_REPORTED_COMMAND_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(command, MAX_REPORTED_COMMAND_BYTES) > MAX_REPORTED_COMMAND_BYTES) {
    throw new Error(`External EPUB validator command must be at most ${MAX_REPORTED_COMMAND_BYTES} UTF-8 bytes.`);
  }
  if (EXEC_ARG_CONTROL_CHARS.test(command)) {
    throw new Error("External EPUB validator command must not contain control characters.");
  }
  if (/\s/u.test(command)) {
    throw new Error("External EPUB validator command must be a single executable path or PATH command without whitespace.");
  }
  if (!isAbsolute(command) && !/^(?!-)(?!\.{1,2}$)[A-Za-z0-9._-]+$/u.test(command)) {
    throw new Error("External EPUB validator command must be either a safe PATH command name or an absolute executable path.");
  }
}

async function resolveCommandPath(command: string): Promise<string> {
  if (!isAbsolute(command)) {
    return command;
  }
  const reportedCommand = truncateField(command, MAX_REPORTED_COMMAND_CHARS, MAX_REPORTED_COMMAND_BYTES);
  let resolvedCommand;
  try {
    resolvedCommand = await realpath(command);
  } catch (error) {
    throw new Error(`External EPUB validator command path is not readable: ${reportedCommand}: ${truncateField(errorMessage(error), MAX_REPORTED_ERROR_CHARS, MAX_REPORTED_ERROR_BYTES)}`);
  }
  if (resolvedCommand.length > MAX_REPORTED_COMMAND_CHARS) {
    throw new Error(`External EPUB validator resolved command path must be at most ${MAX_REPORTED_COMMAND_CHARS} characters: ${reportedCommand}`);
  }
  if (utf8ByteLengthUpTo(resolvedCommand, MAX_REPORTED_COMMAND_BYTES) > MAX_REPORTED_COMMAND_BYTES) {
    throw new Error(`External EPUB validator resolved command path must be at most ${MAX_REPORTED_COMMAND_BYTES} UTF-8 bytes: ${reportedCommand}`);
  }
  if (EXEC_ARG_CONTROL_CHARS.test(resolvedCommand)) {
    throw new Error(`External EPUB validator resolved command path must not contain control characters: ${reportedCommand}`);
  }
  if (!isAbsolute(resolvedCommand)) {
    throw new Error(`External EPUB validator resolved command path must be absolute: ${reportedCommand}`);
  }
  let stats;
  try {
    stats = await stat(resolvedCommand);
  } catch (error) {
    throw new Error(`External EPUB validator command path is not readable: ${reportedCommand}: ${truncateField(errorMessage(error), MAX_REPORTED_ERROR_CHARS, MAX_REPORTED_ERROR_BYTES)}`);
  }
  if (!stats.isFile()) {
    throw new Error(`External EPUB validator command path must be a regular file: ${reportedCommand}`);
  }
  if ((stats.mode & 0o111) === 0) {
    throw new Error(`External EPUB validator command path must be executable: ${reportedCommand}`);
  }
  try {
    await access(resolvedCommand, constants.X_OK);
  } catch (error) {
    throw new Error(`External EPUB validator command path is not executable: ${reportedCommand}: ${truncateField(errorMessage(error), MAX_REPORTED_ERROR_CHARS, MAX_REPORTED_ERROR_BYTES)}`);
  }
  return resolvedCommand;
}

function validateTimeout(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer.`);
  }
  if (value < 1 || value > MAX_VALIDATOR_TIMEOUT_MS) {
    throw new Error(`${label} must be between 1 and ${MAX_VALIDATOR_TIMEOUT_MS}.`);
  }
  return value;
}

function timeoutMsForTimer(ms: number): number {
  return Math.min(ms, MAX_SET_TIMEOUT_MS);
}

function externalValidatorEnv(): Record<string, string> {
  return {
    PATH: DEFAULT_VALIDATOR_PATH
  };
}

function validateArgTemplates(value: unknown): string[] {
  if (value === undefined) {
    throw new Error("External EPUB validator config.epubCheckArgs is required when epubCheckCommand is configured.");
  }
  if (!Array.isArray(value)) {
    throw new Error("External EPUB validator arguments must be an array.");
  }
  if (safeGetPrototypeOf(value, "External EPUB validator arguments") !== Array.prototype) {
    throw new Error("External EPUB validator arguments must be a standard array.");
  }
  if (value.length > MAX_EXEC_ARGS) {
    throw new Error(`External EPUB validator arguments must contain at most ${MAX_EXEC_ARGS} items.`);
  }
  const args: string[] = [];
  for (const key of safeOwnKeys(value, "External EPUB validator arguments")) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string") {
      throw new Error("External EPUB validator arguments must not contain symbol properties.");
    }
    if (!isArrayIndexKey(key, value.length)) {
      throw new Error(`External EPUB validator arguments.${key} is not a supported array field.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, "External EPUB validator arguments");
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`External EPUB validator argument template ${key} must be an enumerable data property.`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = safeGetOwnPropertyDescriptor(value, String(index), "External EPUB validator arguments");
    if (!descriptor) {
      throw new Error(`External EPUB validator argument template ${index} must not be a sparse array hole.`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`External EPUB validator argument template ${index} must be an enumerable data property.`);
    }
    if (typeof descriptor.value !== "string" || descriptor.value.length === 0) {
      throw new Error(`External EPUB validator argument template ${index} must be a non-empty string.`);
    }
    if (descriptor.value.trim() !== descriptor.value) {
      throw new Error(`External EPUB validator argument template ${index} must not have leading or trailing whitespace.`);
    }
    if (descriptor.value.length > MAX_EXEC_ARG_TEMPLATE_CHARS) {
      throw new Error(`External EPUB validator argument template ${index} must be at most ${MAX_EXEC_ARG_TEMPLATE_CHARS} characters.`);
    }
    if (utf8ByteLengthUpTo(descriptor.value, MAX_EXEC_ARG_TEMPLATE_BYTES) > MAX_EXEC_ARG_TEMPLATE_BYTES) {
      throw new Error(`External EPUB validator argument template ${index} must be at most ${MAX_EXEC_ARG_TEMPLATE_BYTES} UTF-8 bytes.`);
    }
    if (EXEC_ARG_CONTROL_CHARS.test(descriptor.value)) {
      throw new Error(`External EPUB validator argument template ${index} must not contain control characters.`);
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

function validateEpubPath(epubPath: unknown): asserts epubPath is string {
  if (typeof epubPath !== "string") {
    throw new Error("External EPUB validator path must be a string.");
  }
  if (!epubPath.trim()) {
    throw new Error("External EPUB validator path must be a non-empty string.");
  }
  if (epubPath.length > MAX_EPUB_PATH_CHARS) {
    throw new Error(`External EPUB validator path must be at most ${MAX_EPUB_PATH_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(epubPath, MAX_EPUB_PATH_BYTES) > MAX_EPUB_PATH_BYTES) {
    throw new Error(`External EPUB validator path must be at most ${MAX_EPUB_PATH_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(epubPath)) {
    throw new Error("External EPUB validator path must not contain control characters.");
  }
  if (!isAbsolute(epubPath)) {
    throw new Error("External EPUB validator path must be absolute.");
  }
}

async function assertReadableRegularEpubFile(epubPath: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(epubPath);
  } catch (error) {
    throw new Error(`External EPUB validator path is not readable: ${truncateField(epubPath, MAX_EPUB_PATH_CHARS, MAX_EPUB_PATH_BYTES)}: ${truncateReportedError(error)}`);
  }
  if (!stats.isFile()) {
    throw new Error(`External EPUB validator path must be a regular file: ${truncateField(epubPath, MAX_EPUB_PATH_CHARS, MAX_EPUB_PATH_BYTES)}`);
  }
  if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
    throw new Error(`External EPUB validator file size must be a non-negative safe integer: ${truncateField(epubPath, MAX_EPUB_PATH_CHARS, MAX_EPUB_PATH_BYTES)}`);
  }
  if (stats.size > MAX_EPUB_ARCHIVE_BYTES) {
    throw new Error(`External EPUB validator file is too large: ${stats.size} bytes, maximum is ${MAX_EPUB_ARCHIVE_BYTES} bytes.`);
  }
  try {
    await access(epubPath, constants.R_OK);
  } catch (error) {
    throw new Error(`External EPUB validator path is not readable: ${truncateField(epubPath, MAX_EPUB_PATH_CHARS, MAX_EPUB_PATH_BYTES)}: ${truncateReportedError(error)}`);
  }
}

function validateRuntimeArgs(args: string[]): void {
  if (args.length > MAX_EXEC_ARGS) {
    throw new Error(`External EPUB validator arguments must contain at most ${MAX_EXEC_ARGS} items.`);
  }
  let totalBytes = 0;
  for (const [index, arg] of args.entries()) {
    if (arg.length > MAX_EXEC_ARG_CHARS) {
      throw new Error(`External EPUB validator argument ${index} must be at most ${MAX_EXEC_ARG_CHARS} characters after path expansion.`);
    }
    if (EXEC_ARG_CONTROL_CHARS.test(arg)) {
      throw new Error(`External EPUB validator argument ${index} must not contain control characters after path expansion.`);
    }
    const remainingBytes = Math.max(0, MAX_EXEC_ARGV_BYTES - totalBytes - 1);
    totalBytes += utf8ByteLengthUpTo(arg, remainingBytes) + 1;
    if (totalBytes > MAX_EXEC_ARGV_BYTES) {
      throw new Error(`External EPUB validator arguments must be at most ${MAX_EXEC_ARGV_BYTES} bytes after path expansion.`);
    }
  }
}

function truncateOutput(value: string): string {
  const redacted = redactInlineSecrets(value.replace(REPORTED_FIELD_CONTROL_CHARS_GLOBAL, " "));
  if (
    redacted.length <= MAX_CAPTURED_OUTPUT_CHARS &&
    utf8ByteLengthUpTo(redacted, MAX_CAPTURED_OUTPUT_BYTES) <= MAX_CAPTURED_OUTPUT_BYTES
  ) {
    return redacted;
  }
  return truncateTextByCharsAndBytes(redacted, MAX_CAPTURED_OUTPUT_CHARS, MAX_CAPTURED_OUTPUT_BYTES);
}

function reportedArgsList(args: string[]): string[] {
  const reported = args.slice(0, MAX_REPORTED_ARGS).map((arg) => truncateField(arg, MAX_REPORTED_ARG_CHARS, MAX_REPORTED_ARG_BYTES));
  if (args.length > MAX_REPORTED_ARGS) {
    reported.push(`[truncated ${args.length - MAX_REPORTED_ARGS} args]`);
  }
  return reported;
}

function truncateField(value: string, maxChars: number, maxBytes: number): string {
  const redacted = redactInlineSecrets(value.replace(REPORTED_FIELD_CONTROL_CHARS_GLOBAL, " "));
  if (redacted.length <= maxChars && utf8ByteLengthUpTo(redacted, maxBytes) <= maxBytes) {
    return redacted;
  }
  const marker = `... [truncated ${Math.max(0, redacted.length - maxChars)} chars]`;
  return truncateTextByCharsAndBytesWithMarker(redacted, marker, maxChars, maxBytes);
}

function truncateReportedError(value: unknown): string {
  return truncateField(errorMessage(value).replace(REPORTED_ERROR_CONTROL_CHARS_GLOBAL, " "), MAX_REPORTED_ERROR_CHARS, MAX_REPORTED_ERROR_BYTES);
}

function errorMessage(error: unknown): string {
  return redactErrorMessage(error);
}

function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
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

function truncateTextByCharsAndBytes(value: string, maxChars: number, maxBytes: number): string {
  const marker = "\n[truncated]";
  const markerBytes = utf8ByteLength(marker);
  if (marker.length > maxChars || markerBytes > maxBytes) {
    return marker;
  }
  return `${value.slice(0, utf8PrefixLength(value, maxChars - marker.length, maxBytes - markerBytes))}${marker}`;
}

function truncateTextByCharsAndBytesWithMarker(value: string, marker: string, maxChars: number, maxBytes: number): string {
  if (marker.length > maxChars || utf8ByteLength(marker) > maxBytes) {
    return truncateTextByCharsAndBytes(marker, maxChars, maxBytes);
  }
  const markerBytes = utf8ByteLength(marker);
  return `${value.slice(0, utf8PrefixLength(value, maxChars - marker.length, maxBytes - markerBytes))}${marker}`;
}

function utf8PrefixLength(value: string, maxChars: number, maxBytes: number): number {
  let chars = 0;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    let scalar = first;
    let charLength = 1;
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
      const second = value.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        scalar = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
        charLength = 2;
      }
    }
    const nextChars = chars + charLength;
    if (nextChars > maxChars) {
      break;
    }
    const nextBytes = bytes + utf8ScalarByteLength(scalar);
    if (nextBytes > maxBytes) {
      break;
    }
    chars = nextChars;
    bytes = nextBytes;
    if (charLength === 2) {
      index += 1;
    }
  }
  return chars;
}
