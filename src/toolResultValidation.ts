import { safeGetOwnPropertyDescriptor, safeGetPrototypeOf, safeOwnKeys } from "./safeProto.js";
import type { ToolResult } from "./types.js";
import { utf8ByteLengthUpTo } from "./utf8.js";

const DEFAULT_MAX_MESSAGE_CHARS = 4000;
const TOOL_RESULT_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const MAX_TOOL_RESULT_VALUE_DEPTH = 32;
const MAX_TOOL_RESULT_OBJECT_FIELDS = 100;
const MAX_TOOL_RESULT_OBJECT_KEY_CHARS = 256;
const MAX_TOOL_RESULT_OBJECT_KEY_BYTES = 512;
const MAX_TOOL_RESULT_ARRAY_ITEMS = 1000;
const MAX_TOOL_RESULT_TOTAL_NODES = 10000;
const MAX_TOOL_RESULT_STRING_CHARS = 16 * 1024;
const MAX_TOOL_RESULT_STRING_BYTES = 32 * 1024;
const MAX_TOOL_RESULT_LABEL_CHARS = 256;
const MAX_TOOL_RESULT_LABEL_BYTES = 512;
const MAX_TOOL_RESULT_MESSAGE_LIMIT_CHARS = 16 * 1024;

export function validateToolResultShape(
  value: unknown,
  label: string,
  maxMessageChars = DEFAULT_MAX_MESSAGE_CHARS
): ToolResult {
  const safeLabel = validateToolResultLabel(label);
  const safeMaxMessageChars = validateMaxMessageChars(maxMessageChars);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${safeLabel} must be an object.`);
  }
  const result = plainDataObject(value, safeLabel);
  assertKnownFields(result, safeLabel, ["status", "message", "data"]);
  if (typeof result.status !== "string" || !isToolResultStatus(result.status)) {
    throw new Error(`${safeLabel}.status must be a valid tool result status.`);
  }
  if (typeof result.message !== "string" || result.message.trim().length === 0) {
    throw new Error(`${safeLabel}.message must be a non-empty string.`);
  }
  if (result.message.length > safeMaxMessageChars) {
    throw new Error(`${safeLabel}.message must be at most ${safeMaxMessageChars} characters.`);
  }
  if (utf8ByteLengthUpTo(result.message, MAX_TOOL_RESULT_STRING_BYTES) > MAX_TOOL_RESULT_STRING_BYTES) {
    throw new Error(`${safeLabel}.message must be at most ${MAX_TOOL_RESULT_STRING_BYTES} UTF-8 bytes.`);
  }
  if (TOOL_RESULT_CONTROL_CHARS.test(result.message)) {
    throw new Error(`${safeLabel}.message must not contain control characters.`);
  }
  const hasData = Object.prototype.hasOwnProperty.call(result, "data");
  let data: unknown;
  if (hasData) {
    data = validateJsonCompatibleValue(result.data, `${safeLabel}.data`);
  }
  const output: ToolResult = {
    status: result.status,
    message: result.message.trim()
  };
  if (hasData) {
    output.data = data;
  }
  return output;
}

function validateToolResultLabel(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Tool result validation label must be a non-empty string.");
  }
  if (value.length > MAX_TOOL_RESULT_LABEL_CHARS) {
    throw new Error(`Tool result validation label must be at most ${MAX_TOOL_RESULT_LABEL_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(value, MAX_TOOL_RESULT_LABEL_BYTES) > MAX_TOOL_RESULT_LABEL_BYTES) {
    throw new Error(`Tool result validation label must be at most ${MAX_TOOL_RESULT_LABEL_BYTES} UTF-8 bytes.`);
  }
  if (TOOL_RESULT_CONTROL_CHARS.test(value)) {
    throw new Error("Tool result validation label must not contain control characters.");
  }
  return value.trim();
}

function validateMaxMessageChars(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("Tool result maxMessageChars must be an integer.");
  }
  if (value < 1 || value > MAX_TOOL_RESULT_MESSAGE_LIMIT_CHARS) {
    throw new Error(`Tool result maxMessageChars must be between 1 and ${MAX_TOOL_RESULT_MESSAGE_LIMIT_CHARS}.`);
  }
  return value;
}

function validateJsonCompatibleValue(value: unknown, label: string): unknown {
  const stack = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown, currentLabel: string, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_TOOL_RESULT_TOTAL_NODES) {
      throw new Error(`${label} must contain at most ${MAX_TOOL_RESULT_TOTAL_NODES} JSON values.`);
    }
    if (depth > MAX_TOOL_RESULT_VALUE_DEPTH) {
      throw new Error(`${currentLabel} must be nested at most ${MAX_TOOL_RESULT_VALUE_DEPTH} levels deep.`);
    }
    if (current === undefined) {
      throw new Error(`${currentLabel} must not be undefined.`);
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new Error(`${currentLabel} must be a finite number.`);
      }
      if (Number.isInteger(current) && !Number.isSafeInteger(current)) {
        throw new Error(`${currentLabel} must be a safe integer.`);
      }
    }
    if (typeof current === "string") {
      if (current.length > MAX_TOOL_RESULT_STRING_CHARS) {
        throw new Error(`${currentLabel} must be at most ${MAX_TOOL_RESULT_STRING_CHARS} characters.`);
      }
      if (utf8ByteLengthUpTo(current, MAX_TOOL_RESULT_STRING_BYTES) > MAX_TOOL_RESULT_STRING_BYTES) {
        throw new Error(`${currentLabel} must be at most ${MAX_TOOL_RESULT_STRING_BYTES} UTF-8 bytes.`);
      }
      if (TOOL_RESULT_CONTROL_CHARS.test(current)) {
        throw new Error(`${currentLabel} must not contain control characters.`);
      }
      return current;
    }
    if (current === null || typeof current === "number" || typeof current === "boolean") {
      return current;
    }
    if (typeof current !== "object") {
      throw new Error(`${currentLabel} must contain only JSON-compatible values.`);
    }
    if (stack.has(current)) {
      throw new Error(`${currentLabel} must not contain circular references.`);
    }
    stack.add(current);
    if (Array.isArray(current)) {
      if (safeGetPrototypeOf(current, currentLabel) !== Array.prototype) {
        throw new Error(`${currentLabel} must be a standard array.`);
      }
      if (current.length > MAX_TOOL_RESULT_ARRAY_ITEMS) {
        throw new Error(`${currentLabel} must contain at most ${MAX_TOOL_RESULT_ARRAY_ITEMS} array items.`);
      }
      assertArrayDataProperties(current, currentLabel);
      const output: unknown[] = [];
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = safeGetOwnPropertyDescriptor(current, String(index), currentLabel);
        if (!descriptor) {
          throw new Error(`${currentLabel}[${index}] must not be a sparse array hole.`);
        }
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new Error(`${currentLabel}[${index}] must not be a non-enumerable or accessor array item.`);
        }
        output.push(visit(descriptor.value, `${currentLabel}[${index}]`, depth + 1));
      }
      stack.delete(current);
      return output;
    }
    const entries = plainDataObjectEntries(current, currentLabel);
    if (entries.length > MAX_TOOL_RESULT_OBJECT_FIELDS) {
      throw new Error(`${currentLabel} must contain at most ${MAX_TOOL_RESULT_OBJECT_FIELDS} object fields.`);
    }
    const output = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of entries) {
      if (key.length > MAX_TOOL_RESULT_OBJECT_KEY_CHARS) {
        throw new Error(`${currentLabel} object keys must be at most ${MAX_TOOL_RESULT_OBJECT_KEY_CHARS} characters.`);
      }
      if (utf8ByteLengthUpTo(key, MAX_TOOL_RESULT_OBJECT_KEY_BYTES) > MAX_TOOL_RESULT_OBJECT_KEY_BYTES) {
        throw new Error(`${currentLabel} object keys must be at most ${MAX_TOOL_RESULT_OBJECT_KEY_BYTES} UTF-8 bytes.`);
      }
      if (/[\u0000-\u001f\u007f]/u.test(key)) {
        throw new Error(`${currentLabel} object keys must not contain control characters.`);
      }
      Object.defineProperty(output, key, {
        value: visit(item, `${currentLabel}.${key}`, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    stack.delete(current);
    return output;
  };
  return visit(value, label, 0);
}

function assertArrayDataProperties(value: unknown[], label: string): void {
  for (const key of safeOwnKeys(value, label)) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string") {
      throw new Error(`${label} must not contain symbol properties.`);
    }
    if (!isArrayIndexKey(key, value.length)) {
      throw new Error(`${label}.${key} is not a supported array field.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, label);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label}[${key}] must not be a non-enumerable or accessor array item.`);
    }
  }
}

function isArrayIndexKey(value: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    return false;
  }
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === value;
}

function plainDataObject(value: object, label: string): Record<string, unknown> {
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of plainDataObjectEntries(value, label)) {
    Object.defineProperty(output, key, {
      value: item,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return output;
}

function plainDataObjectEntries(value: object, label: string): Array<[string, unknown]> {
  const prototype = safeGetPrototypeOf(value, label);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain JSON object.`);
  }
  const entries: Array<[string, unknown]> = [];
  let fieldCount = 0;
  for (const key of safeOwnKeys(value, label)) {
    if (typeof key !== "string") {
      throw new Error(`${label} must not contain symbol properties.`);
    }
    fieldCount += 1;
    if (fieldCount > MAX_TOOL_RESULT_OBJECT_FIELDS) {
      throw new Error(`${label} must contain at most ${MAX_TOOL_RESULT_OBJECT_FIELDS} object fields.`);
    }
    if (key.length > MAX_TOOL_RESULT_OBJECT_KEY_CHARS) {
      throw new Error(`${label} object keys must be at most ${MAX_TOOL_RESULT_OBJECT_KEY_CHARS} characters.`);
    }
    if (utf8ByteLengthUpTo(key, MAX_TOOL_RESULT_OBJECT_KEY_BYTES) > MAX_TOOL_RESULT_OBJECT_KEY_BYTES) {
      throw new Error(`${label} object keys must be at most ${MAX_TOOL_RESULT_OBJECT_KEY_BYTES} UTF-8 bytes.`);
    }
    if (/[\u0000-\u001f\u007f]/u.test(key)) {
      throw new Error(`${label} object keys must not contain control characters.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, label);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} must not contain non-enumerable or accessor properties.`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function assertKnownFields(value: Record<string, unknown>, label: string, allowed: string[]): void {
  const allowedFields = new Set(allowed);
  for (const key of safeOwnKeys(value, label)) {
    if (typeof key !== "string") {
      throw new Error(`${label} must not contain symbol properties.`);
    }
    if (!allowedFields.has(key)) {
      throw new Error(`${label}.${key} is not a supported field.`);
    }
  }
}

function isToolResultStatus(value: string): value is ToolResult["status"] {
  return value === "ok" ||
    value === "needs_input" ||
    value === "pending_finalization" ||
    value === "ready" ||
    value === "complete";
}
