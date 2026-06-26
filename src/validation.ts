import { MAX_SAFE_ID_BYTES } from "./constants.js";
import { safeGetOwnPropertyDescriptor, safeGetPrototypeOf, safeOwnKeys } from "./safeProto.js";
import { utf8ByteLengthUpTo } from "./utf8.js";

export type ObjectShape = Record<string, "string" | "boolean" | "optionalString" | "optionalBoolean">;

const MAX_VALIDATION_LABEL_CHARS = 256;
const MAX_VALIDATION_LABEL_BYTES = 512;
const MAX_VALIDATION_BOUND_CHARS = 1024 * 1024;
const MAX_VALIDATION_STRING_BYTES = 1024 * 1024;
const MAX_VALIDATION_OBJECT_FIELDS = 1000;
const MAX_VALIDATION_OBJECT_KEY_CHARS = 256;
const MAX_VALIDATION_OBJECT_KEY_BYTES = 512;
const VALIDATION_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const VALIDATION_LABEL_CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function assertObject(value: unknown, label: string): Record<string, unknown> {
  const safeLabel = validateValidationLabel(label);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${safeLabel} must be an object.`);
  }
  const prototype = safeGetPrototypeOf(value, safeLabel, validationError);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ValidationError(`${safeLabel} must be a plain object.`);
  }
  const output = Object.create(null) as Record<string, unknown>;
  let fieldCount = 0;
  for (const key of safeOwnKeys(value, safeLabel, validationError)) {
    if (typeof key !== "string") {
      throw new ValidationError(`${safeLabel} must not contain symbol properties.`);
    }
    fieldCount += 1;
    if (fieldCount > MAX_VALIDATION_OBJECT_FIELDS) {
      throw new ValidationError(`${safeLabel} must contain at most ${MAX_VALIDATION_OBJECT_FIELDS} fields.`);
    }
    if (key.length > MAX_VALIDATION_OBJECT_KEY_CHARS) {
      throw new ValidationError(`${safeLabel} field names must be at most ${MAX_VALIDATION_OBJECT_KEY_CHARS} characters.`);
    }
    if (utf8ByteLengthUpTo(key, MAX_VALIDATION_OBJECT_KEY_BYTES) > MAX_VALIDATION_OBJECT_KEY_BYTES) {
      throw new ValidationError(`${safeLabel} field names must be at most ${MAX_VALIDATION_OBJECT_KEY_BYTES} UTF-8 bytes.`);
    }
    if (VALIDATION_LABEL_CONTROL_CHARS.test(key)) {
      throw new ValidationError(`${safeLabel} field names must not contain control characters.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, safeLabel, validationError);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new ValidationError(`${safeLabel} must not contain non-enumerable or accessor properties.`);
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

const validationError = (message: string): ValidationError => new ValidationError(message);

export function assertShape(value: unknown, label: string, shape: ObjectShape): Record<string, unknown> {
  const safeLabel = validateValidationLabel(label);
  const safeShape = validateObjectShape(shape);
  const object = assertObject(value, safeLabel);
  const allowedKeys = new Set(objectDataKeys(safeShape, "Validation shape"));
  for (const key of objectDataKeys(object, safeLabel)) {
    if (!allowedKeys.has(key)) {
      throw new ValidationError(`${safeLabel}.${key} is not a supported field.`);
    }
  }
  for (const key of objectDataKeys(safeShape, "Validation shape")) {
    const type = safeShape[key];
    const current = object[key];
    if (type === "string") {
      assertNonEmptyString(current, `${safeLabel}.${key}`);
    } else if (type === "boolean") {
      if (typeof current !== "boolean") {
        throw new ValidationError(`${safeLabel}.${key} must be a boolean.`);
      }
    } else if (type === "optionalString") {
      if (current !== undefined && (typeof current !== "string" || current.trim().length === 0)) {
        throw new ValidationError(`${safeLabel}.${key} must be a non-empty string when provided.`);
      }
    } else if (type === "optionalBoolean" && current !== undefined && typeof current !== "boolean") {
      throw new ValidationError(`${safeLabel}.${key} must be a boolean when provided.`);
    }
  }
  return object;
}

export function assertNonEmptyString(value: unknown, label: string): string {
  const safeLabel = validateValidationLabel(label);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${safeLabel} must be a non-empty string.`);
  }
  return value.trim();
}

export function assertBoundedNonEmptyString(value: unknown, label: string, maxChars: number, maxBytes?: number): string {
  const safeLabel = validateValidationLabel(label);
  const safeMaxChars = validateMaxChars(maxChars);
  const safeMaxBytes = validateMaxBytes(maxBytes, safeMaxChars);
  const text = assertNonEmptyString(value, safeLabel);
  if (text.length > safeMaxChars) {
    throw new ValidationError(`${safeLabel} must be at most ${safeMaxChars} characters.`);
  }
  if (utf8ByteLengthUpTo(text, safeMaxBytes) > safeMaxBytes) {
    throw new ValidationError(`${safeLabel} must be at most ${safeMaxBytes} UTF-8 bytes.`);
  }
  if (VALIDATION_CONTROL_CHARS.test(text)) {
    throw new ValidationError(`${safeLabel} must not contain control characters.`);
  }
  return text;
}

export function assertBoundedNonEmptySingleLineString(value: unknown, label: string, maxChars: number, maxBytes?: number): string {
  const safeLabel = validateValidationLabel(label);
  const text = assertBoundedNonEmptyString(value, safeLabel, maxChars, maxBytes);
  if (/[\t\r\n]/u.test(text)) {
    throw new ValidationError(`${safeLabel} must be a single-line string.`);
  }
  return text;
}

export function assertSafeId(value: unknown, label: string): string {
  const safeLabel = validateValidationLabel(label);
  const id = assertNonEmptyString(value, safeLabel);
  if (typeof value === "string" && value.trim() !== value) {
    throw new ValidationError(`${safeLabel} must not have leading or trailing whitespace.`);
  }
  if (!/^[a-z0-9가-힣][a-z0-9가-힣._-]*$/u.test(id) || id.includes("..")) {
    throw new ValidationError(`${safeLabel} contains unsafe path characters.`);
  }
  if (utf8ByteLengthUpTo(id, MAX_SAFE_ID_BYTES) > MAX_SAFE_ID_BYTES) {
    throw new ValidationError(`${safeLabel} must be at most ${MAX_SAFE_ID_BYTES} UTF-8 bytes.`);
  }
  return id;
}

export function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  if (!text) {
    return undefined;
  }
  if (text.length > MAX_VALIDATION_BOUND_CHARS) {
    throw new ValidationError(`Optional string must be at most ${MAX_VALIDATION_BOUND_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(text, MAX_VALIDATION_STRING_BYTES) > MAX_VALIDATION_STRING_BYTES) {
    throw new ValidationError(`Optional string must be at most ${MAX_VALIDATION_STRING_BYTES} UTF-8 bytes.`);
  }
  if (VALIDATION_CONTROL_CHARS.test(text)) {
    throw new ValidationError("Optional string must not contain control characters.");
  }
  return text;
}

export function asOptionalBoundedString(value: unknown, label: string, maxChars: number, maxBytes?: number): string | undefined {
  const safeLabel = validateValidationLabel(label);
  const safeMaxChars = validateMaxChars(maxChars);
  if (value === undefined) {
    return undefined;
  }
  return assertBoundedNonEmptyString(value, safeLabel, safeMaxChars, maxBytes);
}

export function asOptionalBoundedSingleLineString(value: unknown, label: string, maxChars: number, maxBytes?: number): string | undefined {
  const safeLabel = validateValidationLabel(label);
  const safeMaxChars = validateMaxChars(maxChars);
  if (value === undefined) {
    return undefined;
  }
  return assertBoundedNonEmptySingleLineString(value, safeLabel, safeMaxChars, maxBytes);
}

function validateValidationLabel(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError("Validation label must be a non-empty string.");
  }
  if (value.length > MAX_VALIDATION_LABEL_CHARS) {
    throw new ValidationError(`Validation label must be at most ${MAX_VALIDATION_LABEL_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(value, MAX_VALIDATION_LABEL_BYTES) > MAX_VALIDATION_LABEL_BYTES) {
    throw new ValidationError(`Validation label must be at most ${MAX_VALIDATION_LABEL_BYTES} UTF-8 bytes.`);
  }
  if (VALIDATION_LABEL_CONTROL_CHARS.test(value)) {
    throw new ValidationError("Validation label must not contain control characters.");
  }
  return value.trim();
}

function validateMaxChars(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ValidationError("Validation maxChars must be an integer.");
  }
  if (value < 1 || value > MAX_VALIDATION_BOUND_CHARS) {
    throw new ValidationError(`Validation maxChars must be between 1 and ${MAX_VALIDATION_BOUND_CHARS}.`);
  }
  return value;
}

function validateMaxBytes(value: unknown, maxChars: number): number {
  if (value === undefined) {
    return Math.min(maxChars * 4, MAX_VALIDATION_STRING_BYTES);
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ValidationError("Validation maxBytes must be an integer.");
  }
  if (value < 1 || value > MAX_VALIDATION_STRING_BYTES) {
    throw new ValidationError(`Validation maxBytes must be between 1 and ${MAX_VALIDATION_STRING_BYTES}.`);
  }
  return value;
}

function validateObjectShape(value: unknown): ObjectShape {
  const object = assertObject(value, "Validation shape");
  const output = Object.create(null) as ObjectShape;
  for (const key of objectDataKeys(object, "Validation shape")) {
    const type = object[key];
    if (!isSupportedShapeType(type)) {
      throw new ValidationError(`Validation shape.${key} must be a supported field type.`);
    }
    Object.defineProperty(output, key, {
      value: type,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return output;
}

function objectDataKeys(value: Record<string, unknown>, label: string): string[] {
  const keys: string[] = [];
  for (const key of safeOwnKeys(value, label, validationError)) {
    if (typeof key !== "string") {
      throw new ValidationError(`${label} must not contain symbol properties.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, label, validationError);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new ValidationError(`${label} must not contain non-enumerable or accessor properties.`);
    }
    keys.push(key);
  }
  return keys;
}

function isSupportedShapeType(value: unknown): value is ObjectShape[string] {
  return value === "string" || value === "boolean" || value === "optionalString" || value === "optionalBoolean";
}
