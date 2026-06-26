import { CURRENT_STATE_SCHEMA_VERSION, type BeatState, type ChapterState, type Confirmation, type ConflictRecord, type PipelineStatus, type VolumeState } from "./types.js";
import { assertSafeId, ValidationError } from "./validation.js";

const STATUSES: PipelineStatus[] = ["pending_user_confirmation", "planning", "drafting", "reviewing", "blocked", "complete"];
const BEAT_STATUSES: BeatState["status"][] = ["pending", "drafted", "complete", "needs_revision"];
const CONFIRMATION_KINDS: Confirmation["kind"][] = ["initial_outline", "conflict_resolution", "revision"];
const SEVERITIES: ConflictRecord["severity"][] = ["info", "warning", "blocking"];
const MAX_CHAPTERS = 200;
const MAX_BEATS_PER_CHAPTER = 200;
const MAX_TOTAL_BEATS = 5000;
const MAX_CONFIRMATIONS = 1000;
const MAX_CONFLICTS = 1000;
const MAX_TITLE_CHARS = 512;
const MAX_TITLE_BYTES = 512;
const MAX_STATE_TEXT_CHARS = 256 * 1024;
const MAX_STATE_TEXT_BYTES = 256 * 1024;
const MAX_REVISION_INSTRUCTION_CHARS = 16 * 1024;
const MAX_REVISION_INSTRUCTION_BYTES = 16 * 1024;
const MAX_CONFLICT_FIELD_CHARS = 4000;
const MAX_CONFLICT_FIELD_BYTES = 4000;
const MAX_TIMESTAMP_CHARS = 64;
const MAX_TIMESTAMP_BYTES = 64;
const MAX_BEAT_TARGET_WORDS = 1_000_000;
const MAX_CHAPTER_TARGET_WORDS = MAX_BEATS_PER_CHAPTER * MAX_BEAT_TARGET_WORDS;
const MAX_BEAT_RETRY_COUNT = 1000;
const MAX_TIMESTAMP_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const MAX_STATE_OBJECT_FIELDS = 1000;
const MAX_STATE_OBJECT_KEY_CHARS = 1024;
const MAX_STATE_OBJECT_KEY_BYTES = 2048;
const STATE_OBJECT_KEY_CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export function validateVolumeState(value: unknown): VolumeState {
  const state = assertRecord(value, "VolumeState");
  assertKnownFields(state, "VolumeState", [
    "schemaVersion",
    "franchiseId",
    "franchiseName",
    "workId",
    "workTitle",
    "volumeId",
    "volumeTitle",
    "status",
    "currentChapterNo",
    "currentBeatNo",
    "confirmations",
    "conflicts",
    "chapters",
    "createdAt",
    "updatedAt"
  ]);
  const schemaVersion = schemaVersionField(state.schemaVersion, "VolumeState.schemaVersion");
  const chapters = boundedNonEmptyArrayField(state.chapters, "VolumeState.chapters", MAX_CHAPTERS).map(validateChapter);
  assertUnique(chapters.map((chapter) => chapter.chapterNo), "ChapterState.chapterNo");
  assertSequential(chapters.map((chapter) => chapter.chapterNo), "ChapterState.chapterNo");
  const totalBeats = chapters.reduce((sum, chapter) => sum + chapter.beats.length, 0);
  if (totalBeats > MAX_TOTAL_BEATS) {
    throw new ValidationError(`VolumeState total beats must be less than or equal to ${MAX_TOTAL_BEATS}.`);
  }
  const createdAt = timestampField(state.createdAt, "VolumeState.createdAt");
  const updatedAt = timestampField(state.updatedAt, "VolumeState.updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new ValidationError("VolumeState.updatedAt must be greater than or equal to createdAt.");
  }
  const volumeState: VolumeState = {
    schemaVersion,
    franchiseId: assertSafeId(state.franchiseId, "VolumeState.franchiseId"),
    franchiseName: boundedSingleLineStringField(state.franchiseName, "VolumeState.franchiseName", MAX_TITLE_CHARS, MAX_TITLE_BYTES),
    workId: assertSafeId(state.workId, "VolumeState.workId"),
    workTitle: boundedSingleLineStringField(state.workTitle, "VolumeState.workTitle", MAX_TITLE_CHARS, MAX_TITLE_BYTES),
    volumeId: assertSafeId(state.volumeId, "VolumeState.volumeId"),
    volumeTitle: boundedSingleLineStringField(state.volumeTitle, "VolumeState.volumeTitle", MAX_TITLE_CHARS, MAX_TITLE_BYTES),
    status: oneOf(state.status, STATUSES, "VolumeState.status"),
    currentChapterNo: positiveInteger(state.currentChapterNo, "VolumeState.currentChapterNo"),
    currentBeatNo: positiveInteger(state.currentBeatNo, "VolumeState.currentBeatNo"),
    confirmations: boundedArrayField(state.confirmations, "VolumeState.confirmations", MAX_CONFIRMATIONS).map(validateConfirmation),
    conflicts: boundedArrayField(state.conflicts, "VolumeState.conflicts", MAX_CONFLICTS).map(validateConflict),
    chapters,
    createdAt,
    updatedAt
  };
  assertUnique(volumeState.confirmations.map((confirmation) => confirmation.id), "Confirmation.id");
  assertUnique(volumeState.conflicts.map((conflict) => conflict.id), "ConflictRecord.id");
  validateConfirmationTimeline(volumeState.confirmations, volumeState.createdAt, volumeState.updatedAt);
  const cursorBeat = volumeState.chapters
    .flatMap((chapter) => chapter.beats)
    .find((beat) => beat.chapterNo === volumeState.currentChapterNo && beat.beatNo === volumeState.currentBeatNo);
  if (!cursorBeat) {
    throw new ValidationError("VolumeState cursor does not point to a known beat.");
  }
  if (volumeState.status !== "complete" && volumeState.status !== "blocked" && cursorBeat.status === "complete") {
    throw new ValidationError("VolumeState active cursor must point to an incomplete beat.");
  }
  validateCursorPosition(volumeState);
  const pendingConfirmations = volumeState.confirmations.filter((confirmation) => !confirmation.resolvedAt);
  const pendingConfirmationCount = pendingConfirmations.length;
  if (pendingConfirmationCount > 1) {
    throw new ValidationError("VolumeState must not contain more than one unresolved confirmation.");
  }
  if (volumeState.status === "pending_user_confirmation" && pendingConfirmationCount === 0) {
    throw new ValidationError("VolumeState pending_user_confirmation status requires an unresolved confirmation.");
  }
  if (volumeState.status !== "pending_user_confirmation" && pendingConfirmationCount > 0) {
    throw new ValidationError("VolumeState unresolved confirmations require pending_user_confirmation status.");
  }
  if (volumeState.status === "complete" && volumeState.chapters.some((chapter) => chapter.beats.some((beat) => beat.status !== "complete"))) {
    throw new ValidationError("VolumeState complete status requires every beat to be complete.");
  }
  validatePendingBeatOrder(volumeState);
  const hasUnresolvedBlockingConflict = volumeState.conflicts.some((conflict) => conflict.severity === "blocking" && !conflict.resolved);
  if (hasUnresolvedBlockingConflict && volumeState.status !== "pending_user_confirmation" && volumeState.status !== "blocked") {
    throw new ValidationError("VolumeState unresolved blocking conflicts require pending_user_confirmation or blocked status.");
  }
  if (hasUnresolvedBlockingConflict && volumeState.status === "pending_user_confirmation" && pendingConfirmations[0]?.kind === "initial_outline") {
    throw new ValidationError("VolumeState unresolved blocking conflicts require a conflict_resolution or revision confirmation.");
  }
  if (volumeState.status === "blocked" && !hasUnresolvedBlockingConflict) {
    throw new ValidationError("VolumeState blocked status requires an unresolved blocking conflict.");
  }
  return volumeState;
}

function validateConfirmationTimeline(confirmations: Confirmation[], volumeCreatedAt: string, volumeUpdatedAt: string): void {
  const volumeCreatedAtMs = Date.parse(volumeCreatedAt);
  const volumeUpdatedAtMs = Date.parse(volumeUpdatedAt);
  for (const confirmation of confirmations) {
    const confirmationCreatedAtMs = Date.parse(confirmation.createdAt);
    if (confirmationCreatedAtMs < volumeCreatedAtMs) {
      throw new ValidationError("Confirmation.createdAt must be greater than or equal to VolumeState.createdAt.");
    }
    if (confirmationCreatedAtMs > volumeUpdatedAtMs) {
      throw new ValidationError("Confirmation.createdAt must be less than or equal to VolumeState.updatedAt.");
    }
    if (confirmation.resolvedAt && Date.parse(confirmation.resolvedAt) > volumeUpdatedAtMs) {
      throw new ValidationError("Confirmation.resolvedAt must be less than or equal to VolumeState.updatedAt.");
    }
  }
}

function validatePendingBeatOrder(state: VolumeState): void {
  let seenPending = false;
  for (const beat of state.chapters.flatMap((chapter) => chapter.beats)) {
    if (beat.status === "pending") {
      seenPending = true;
      continue;
    }
    if (seenPending) {
      throw new ValidationError("VolumeState pending beats must not be followed by already-started beats.");
    }
  }
}

function validateCursorPosition(state: VolumeState): void {
  const beats = state.chapters.flatMap((chapter) => chapter.beats);
  if (state.status === "complete") {
    const finalBeat = beats[beats.length - 1];
    if (finalBeat && (finalBeat.chapterNo !== state.currentChapterNo || finalBeat.beatNo !== state.currentBeatNo)) {
      throw new ValidationError("VolumeState complete status cursor must point to the final beat.");
    }
    return;
  }
  const firstIncompleteBeat = beats.find((beat) => beat.status !== "complete");
  if (!firstIncompleteBeat) {
    throw new ValidationError("VolumeState incomplete status requires an incomplete cursor beat.");
  }
  if (firstIncompleteBeat.chapterNo !== state.currentChapterNo || firstIncompleteBeat.beatNo !== state.currentBeatNo) {
    throw new ValidationError("VolumeState cursor must point to the first incomplete beat.");
  }
}

function validateConfirmation(value: unknown): Confirmation {
  const confirmation = assertRecord(value, "Confirmation");
  assertKnownFields(confirmation, "Confirmation", ["id", "kind", "message", "createdAt", "resolvedAt", "approved", "revisionInstruction"]);
  const createdAt = timestampField(confirmation.createdAt, "Confirmation.createdAt");
  const resolvedAt = optionalTimestamp(confirmation.resolvedAt, "Confirmation.resolvedAt");
  const approved = optionalBoolean(confirmation.approved, "Confirmation.approved");
  if (resolvedAt && Date.parse(resolvedAt) < Date.parse(createdAt)) {
    throw new ValidationError("Confirmation.resolvedAt must be greater than or equal to createdAt.");
  }
  if (resolvedAt && approved !== true) {
    throw new ValidationError("Confirmation.resolvedAt requires approved to be true.");
  }
  if (!resolvedAt && approved !== undefined) {
    throw new ValidationError("Confirmation.approved requires resolvedAt.");
  }
  const validated: Confirmation = {
    id: assertSafeId(confirmation.id, "Confirmation.id"),
    kind: oneOf(confirmation.kind, CONFIRMATION_KINDS, "Confirmation.kind"),
    message: boundedStringField(confirmation.message, "Confirmation.message", MAX_STATE_TEXT_CHARS, MAX_STATE_TEXT_BYTES),
    createdAt
  };
  if (resolvedAt !== undefined) {
    validated.resolvedAt = resolvedAt;
  }
  if (approved !== undefined) {
    validated.approved = approved;
  }
  const revisionInstruction = optionalBoundedString(
    confirmation.revisionInstruction,
    "Confirmation.revisionInstruction",
    MAX_REVISION_INSTRUCTION_CHARS,
    MAX_REVISION_INSTRUCTION_BYTES
  );
  if (validated.kind === "revision" && revisionInstruction === undefined) {
    throw new ValidationError("Confirmation.revisionInstruction is required when kind is revision.");
  }
  if (revisionInstruction !== undefined) {
    validated.revisionInstruction = revisionInstruction;
  }
  return validated;
}

function validateConflict(value: unknown): ConflictRecord {
  const conflict = assertRecord(value, "ConflictRecord");
  assertKnownFields(conflict, "ConflictRecord", ["id", "scope", "description", "severity", "resolved"]);
  return {
    id: assertSafeId(conflict.id, "ConflictRecord.id"),
    scope: boundedSingleLineStringField(conflict.scope, "ConflictRecord.scope", MAX_CONFLICT_FIELD_CHARS, MAX_CONFLICT_FIELD_BYTES),
    description: boundedStringField(conflict.description, "ConflictRecord.description", MAX_CONFLICT_FIELD_CHARS, MAX_CONFLICT_FIELD_BYTES),
    severity: oneOf(conflict.severity, SEVERITIES, "ConflictRecord.severity"),
    resolved: booleanField(conflict.resolved, "ConflictRecord.resolved")
  };
}

function validateChapter(value: unknown): ChapterState {
  const chapter = assertRecord(value, "ChapterState");
  assertKnownFields(chapter, "ChapterState", ["chapterNo", "title", "targetWords", "beats"]);
  const chapterNo = positiveInteger(chapter.chapterNo, "ChapterState.chapterNo");
  const beats = boundedNonEmptyArrayField(chapter.beats, "ChapterState.beats", MAX_BEATS_PER_CHAPTER).map((beat) => validateBeat(beat, chapterNo));
  assertUnique(beats.map((beat) => beat.beatNo), `ChapterState(${chapterNo}).beats.beatNo`);
  assertSequential(beats.map((beat) => beat.beatNo), `ChapterState(${chapterNo}).beats.beatNo`);
  const targetWords = boundedPositiveInteger(chapter.targetWords, "ChapterState.targetWords", MAX_CHAPTER_TARGET_WORDS);
  const beatTargetWords = beats.reduce((sum, beat) => sum + beat.targetWords, 0);
  if (targetWords !== beatTargetWords) {
    throw new ValidationError(`ChapterState(${chapterNo}).targetWords must equal the sum of beat targetWords.`);
  }
  return {
    chapterNo,
    title: boundedSingleLineStringField(chapter.title, "ChapterState.title", MAX_TITLE_CHARS, MAX_TITLE_BYTES),
    targetWords,
    beats
  };
}

function validateBeat(value: unknown, chapterNo: number): BeatState {
  const beat = assertRecord(value, "BeatState");
  assertKnownFields(beat, "BeatState", ["chapterNo", "beatNo", "title", "targetWords", "status", "retryCount", "lastFeedback"]);
  const beatChapterNo = positiveInteger(beat.chapterNo, "BeatState.chapterNo");
  if (beatChapterNo !== chapterNo) {
    throw new ValidationError("BeatState.chapterNo must match its parent chapter.");
  }
  const status = oneOf(beat.status, BEAT_STATUSES, "BeatState.status");
  const lastFeedback = optionalBoundedString(beat.lastFeedback, "BeatState.lastFeedback", MAX_STATE_TEXT_CHARS, MAX_STATE_TEXT_BYTES);
  if (status === "needs_revision" && !lastFeedback) {
    throw new ValidationError("BeatState.lastFeedback is required when status is needs_revision.");
  }
  if (status !== "needs_revision" && lastFeedback !== undefined) {
    throw new ValidationError("BeatState.lastFeedback is only allowed when status is needs_revision.");
  }
  const validated: BeatState = {
    chapterNo: beatChapterNo,
    beatNo: positiveInteger(beat.beatNo, "BeatState.beatNo"),
    title: boundedSingleLineStringField(beat.title, "BeatState.title", MAX_TITLE_CHARS, MAX_TITLE_BYTES),
    targetWords: boundedPositiveInteger(beat.targetWords, "BeatState.targetWords", MAX_BEAT_TARGET_WORDS),
    status,
    retryCount: boundedNonNegativeInteger(beat.retryCount, "BeatState.retryCount", MAX_BEAT_RETRY_COUNT)
  };
  if (lastFeedback !== undefined) {
    validated.lastFeedback = lastFeedback;
  }
  return validated;
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object.`);
  }
  const prototype = safeGetPrototypeOf(value, label);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ValidationError(`${label} must be a plain object.`);
  }
  const output = Object.create(null) as Record<string, unknown>;
  let fieldCount = 0;
  for (const key of safeOwnKeys(value, label)) {
    if (typeof key !== "string") {
      throw new ValidationError(`${label} must not contain symbol properties.`);
    }
    fieldCount += 1;
    if (fieldCount > MAX_STATE_OBJECT_FIELDS) {
      throw new ValidationError(`${label} must contain at most ${MAX_STATE_OBJECT_FIELDS} fields.`);
    }
    if (key.length > MAX_STATE_OBJECT_KEY_CHARS) {
      throw new ValidationError(`${label} field names must be at most ${MAX_STATE_OBJECT_KEY_CHARS} characters.`);
    }
    if (utf8ByteLengthUpTo(key, MAX_STATE_OBJECT_KEY_BYTES) > MAX_STATE_OBJECT_KEY_BYTES) {
      throw new ValidationError(`${label} field names must be at most ${MAX_STATE_OBJECT_KEY_BYTES} UTF-8 bytes.`);
    }
    if (STATE_OBJECT_KEY_CONTROL_CHARS.test(key)) {
      throw new ValidationError(`${label} field names must not contain control characters.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, label);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new ValidationError(`${label} must not contain non-enumerable or accessor properties.`);
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

function assertKnownFields(value: Record<string, unknown>, label: string, allowed: string[]): void {
  const allowedFields = new Set(allowed);
  for (const key of safeOwnKeys(value, label)) {
    if (typeof key !== "string") {
      throw new ValidationError(`${label} must not contain symbol properties.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, label);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new ValidationError(`${label} must not contain non-enumerable or accessor properties.`);
    }
    if (!allowedFields.has(key)) {
      throw new ValidationError(`${label}.${key} is not a supported field.`);
    }
  }
}

function safeGetPrototypeOf(value: object, label: string): object | null {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    throw new ValidationError(`${label} prototype must be readable.`);
  }
}

function safeOwnKeys(value: object, label: string): Array<string | symbol> {
  try {
    return Reflect.ownKeys(value);
  } catch {
    throw new ValidationError(`${label} property keys must be readable.`);
  }
}

function safeGetOwnPropertyDescriptor(value: object, key: PropertyKey, label: string): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new ValidationError(`${label} property descriptors must be readable.`);
  }
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty string.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new ValidationError(`${label} must not contain control characters.`);
  }
  return value;
}

function boundedStringField(value: unknown, label: string, maxChars: number, maxBytes: number): string {
  const text = stringField(value, label);
  if (text.length > maxChars) {
    throw new ValidationError(`${label} must be at most ${maxChars} characters.`);
  }
  if (utf8ByteLengthUpTo(text, maxBytes) > maxBytes) {
    throw new ValidationError(`${label} must be at most ${maxBytes} UTF-8 bytes.`);
  }
  return text;
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

function boundedSingleLineStringField(value: unknown, label: string, maxChars: number, maxBytes: number): string {
  const text = boundedStringField(value, label, maxChars, maxBytes);
  if (/[\t\r\n]/u.test(text)) {
    throw new ValidationError(`${label} must be a single-line string.`);
  }
  return text;
}

function optionalBoundedString(value: unknown, label: string, maxChars: number, maxBytes: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return boundedStringField(value, label, maxChars, maxBytes);
}

function timestampField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty string.`);
  }
  if (value.length > MAX_TIMESTAMP_CHARS) {
    throw new ValidationError(`${label} must be at most ${MAX_TIMESTAMP_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(value, MAX_TIMESTAMP_BYTES) > MAX_TIMESTAMP_BYTES) {
    throw new ValidationError(`${label} must be at most ${MAX_TIMESTAMP_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new ValidationError(`${label} must not contain control characters.`);
  }
  const timestamp = value;
  if (!isCanonicalUtcTimestamp(timestamp)) {
    throw new ValidationError(`${label} must be an ISO timestamp string.`);
  }
  if (Date.parse(timestamp) > Date.now() + MAX_TIMESTAMP_FUTURE_SKEW_MS) {
    throw new ValidationError(`${label} must not be more than ${MAX_TIMESTAMP_FUTURE_SKEW_MS}ms in the future.`);
  }
  return timestamp;
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return timestampField(value, label);
}

function schemaVersionField(value: unknown, label: string): typeof CURRENT_STATE_SCHEMA_VERSION {
  if (value === undefined) {
    throw new ValidationError(`${label} is required.`);
  }
  if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new ValidationError(`${label} must be a safe integer.`);
  }
  if ((value as number) < CURRENT_STATE_SCHEMA_VERSION) {
    throw new ValidationError(`${label} ${value} is older than supported version ${CURRENT_STATE_SCHEMA_VERSION}.`);
  }
  if ((value as number) > CURRENT_STATE_SCHEMA_VERSION) {
    throw new ValidationError(`${label} ${value} is newer than supported version ${CURRENT_STATE_SCHEMA_VERSION}.`);
  }
  return CURRENT_STATE_SCHEMA_VERSION;
}

function isCanonicalUtcTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function booleanField(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ValidationError(`${label} must be a boolean.`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  return booleanField(value, label);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new ValidationError(`${label} must be a positive integer.`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError(`${label} must be a safe integer.`);
  }
  return value as number;
}

function boundedPositiveInteger(value: unknown, label: string, max: number): number {
  const integer = positiveInteger(value, label);
  if (integer > max) {
    throw new ValidationError(`${label} must be less than or equal to ${max}.`);
  }
  return integer;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ValidationError(`${label} must be a non-negative integer.`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError(`${label} must be a safe integer.`);
  }
  return value as number;
}

function boundedNonNegativeInteger(value: unknown, label: string, max: number): number {
  const integer = nonNegativeInteger(value, label);
  if (integer > max) {
    throw new ValidationError(`${label} must be less than or equal to ${max}.`);
  }
  return integer;
}

function arrayField(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${label} must be an array.`);
  }
  if (safeGetPrototypeOf(value, label) !== Array.prototype) {
    throw new ValidationError(`${label} must be a standard array.`);
  }
  assertArrayDataProperties(value, label);
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = safeGetOwnPropertyDescriptor(value, index, label);
    if (!descriptor) {
      throw new ValidationError(`${label}[${index}] must not be a sparse array hole.`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new ValidationError(`${label}[${index}] must not be a non-enumerable or accessor array item.`);
    }
    output.push(descriptor.value);
  }
  return output;
}

function assertArrayDataProperties(value: unknown[], label: string): void {
  for (const key of safeOwnKeys(value, label)) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string") {
      throw new ValidationError(`${label} must not contain symbol properties.`);
    }
    if (!isArrayIndexKey(key, value.length)) {
      throw new ValidationError(`${label}.${key} is not a supported array field.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, label);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new ValidationError(`${label}[${key}] must not be a non-enumerable or accessor array item.`);
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

function boundedArrayField(value: unknown, label: string, maxItems: number): unknown[] {
  const items = arrayField(value, label);
  if (items.length > maxItems) {
    throw new ValidationError(`${label} must contain at most ${maxItems} items.`);
  }
  return items;
}

function nonEmptyArrayField(value: unknown, label: string): unknown[] {
  const items = arrayField(value, label);
  if (items.length === 0) {
    throw new ValidationError(`${label} must not be empty.`);
  }
  return items;
}

function boundedNonEmptyArrayField(value: unknown, label: string, maxItems: number): unknown[] {
  const items = nonEmptyArrayField(value, label);
  if (items.length > maxItems) {
    throw new ValidationError(`${label} must contain at most ${maxItems} items.`);
  }
  return items;
}

function oneOf<T extends string>(value: unknown, allowed: T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ValidationError(`${label} is invalid.`);
  }
  return value as T;
}

function assertUnique<T>(values: T[], label: string): void {
  const seen = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new ValidationError(`${label} must be unique.`);
    }
    seen.add(value);
  }
}

function assertSequential(values: number[], label: string): void {
  for (let index = 0; index < values.length; index += 1) {
    const expected = index + 1;
    if (values[index] !== expected) {
      throw new ValidationError(`${label} must be sequential in array order starting at 1.`);
    }
  }
}
