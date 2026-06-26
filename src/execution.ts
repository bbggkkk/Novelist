import { MAX_OPERATION_TIMEOUT_MS } from "./constants.js";
import { safeGetOwnPropertyDescriptor, safeGetPrototypeOf, safeOwnKeys } from "./safeProto.js";
import { utf8ByteLengthUpTo } from "./utf8.js";

export class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationTimeoutError";
  }
}

export class OperationCancelledError extends Error {
  constructor(message = "Operation was cancelled.") {
    super(message);
    this.name = "OperationCancelledError";
  }
}

export interface ExecutionSignal {
  isCancelled(): boolean;
}

const MAX_EXECUTION_SIGNAL_FIELDS = 32;
const MAX_EXECUTION_SIGNAL_KEY_CHARS = 128;
const MAX_EXECUTION_SIGNAL_KEY_BYTES = 256;
const MAX_EXECUTION_LABEL_CHARS = 256;
const MAX_EXECUTION_LABEL_BYTES = 512;

export class ExecutionDeadline {
  private readonly deadlineAt: number;
  private readonly isCancelled?: () => boolean;

  constructor(timeoutMs: number, signal?: ExecutionSignal) {
    this.deadlineAt = Date.now() + validateTimeoutMs(timeoutMs);
    this.isCancelled = validateSignal(signal);
  }

  assertActive(label: string): void {
    const safeLabel = validateLabel(label);
    const cancelled = this.isCancelled?.();
    if (cancelled !== undefined && typeof cancelled !== "boolean") {
      throw new Error("ExecutionDeadline.signal.isCancelled must return a boolean.");
    }
    if (cancelled) {
      throw new OperationCancelledError(`Operation was cancelled while ${safeLabel}.`);
    }
    if (Date.now() > this.deadlineAt) {
      throw new OperationTimeoutError(`Operation timed out while ${safeLabel}.`);
    }
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineAt - Date.now());
  }

  requireRemainingMs(label: string): number {
    const safeLabel = validateLabel(label);
    this.assertActive(safeLabel);
    const remaining = this.remainingMs();
    if (remaining <= 0) {
      throw new OperationTimeoutError(`Operation timed out while ${safeLabel}.`);
    }
    return remaining;
  }
}

function validateSignal(value: unknown): (() => boolean) | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ExecutionDeadline.signal must be an object.");
  }
  const prototype = safeGetPrototypeOf(value, "ExecutionDeadline.signal");
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("ExecutionDeadline.signal must be a plain object.");
  }
  let fieldCount = 0;
  for (const key of safeOwnKeys(value, "ExecutionDeadline.signal")) {
    if (typeof key !== "string") {
      throw new Error("ExecutionDeadline.signal must not contain symbol properties.");
    }
    fieldCount += 1;
    if (fieldCount > MAX_EXECUTION_SIGNAL_FIELDS) {
      throw new Error(`ExecutionDeadline.signal must contain at most ${MAX_EXECUTION_SIGNAL_FIELDS} fields.`);
    }
    if (key.length > MAX_EXECUTION_SIGNAL_KEY_CHARS) {
      throw new Error(`ExecutionDeadline.signal field names must be at most ${MAX_EXECUTION_SIGNAL_KEY_CHARS} characters.`);
    }
    if (utf8ByteLengthUpTo(key, MAX_EXECUTION_SIGNAL_KEY_BYTES) > MAX_EXECUTION_SIGNAL_KEY_BYTES) {
      throw new Error(`ExecutionDeadline.signal field names must be at most ${MAX_EXECUTION_SIGNAL_KEY_BYTES} UTF-8 bytes.`);
    }
    if (/[\u0000-\u001f\u007f]/u.test(key)) {
      throw new Error("ExecutionDeadline.signal field names must not contain control characters.");
    }
    const fieldDescriptor = safeGetOwnPropertyDescriptor(value, key, "ExecutionDeadline.signal");
    if (!fieldDescriptor?.enumerable || !("value" in fieldDescriptor)) {
      throw new Error("ExecutionDeadline.signal must not contain non-enumerable or accessor properties.");
    }
  }
  const descriptor = safeGetOwnPropertyDescriptor(value, "isCancelled", "ExecutionDeadline.signal");
  if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "function") {
    throw new Error("ExecutionDeadline.signal.isCancelled must be an enumerable own data function.");
  }
  const isCancelled = descriptor.value as () => boolean;
  return () => isCancelled.call(value);
}

function validateTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("ExecutionDeadline.timeoutMs must be an integer.");
  }
  if (value < 1 || value > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error(`ExecutionDeadline.timeoutMs must be between 1 and ${MAX_OPERATION_TIMEOUT_MS}.`);
  }
  return value;
}

function validateLabel(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("ExecutionDeadline label must be a non-empty string.");
  }
  if (value.length > MAX_EXECUTION_LABEL_CHARS) {
    throw new Error(`ExecutionDeadline label must be at most ${MAX_EXECUTION_LABEL_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(value, MAX_EXECUTION_LABEL_BYTES) > MAX_EXECUTION_LABEL_BYTES) {
    throw new Error(`ExecutionDeadline label must be at most ${MAX_EXECUTION_LABEL_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("ExecutionDeadline label must not contain control characters.");
  }
  return value;
}
