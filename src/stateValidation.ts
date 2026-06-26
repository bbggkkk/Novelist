import { CURRENT_STATE_SCHEMA_VERSION } from "./constants.js";
import type { BeatState, ChapterState, ConsistencyReport, PipelineFlowStatus, PipelinePhase, VolumeState } from "./types.js";
import { assertSafeId, ValidationError } from "./validation.js";
import { utf8ByteLengthUpTo } from "./utf8.js";
import {
  MAX_CHAPTERS,
  MAX_BEATS_PER_CHAPTER,
  MAX_TOTAL_BEATS,
  MAX_TITLE_CHARS,
  MAX_TITLE_BYTES,
  MAX_TEXT_CHARS,
  MAX_TEXT_BYTES,
  MAX_TIMESTAMP_CHARS,
  MAX_TIMESTAMP_BYTES,
  MAX_BEAT_TARGET_WORDS,
  MAX_OBJECT_FIELDS,
  MAX_OBJECT_KEY_CHARS,
  MAX_OBJECT_KEY_BYTES
} from "./constants.js";

const PHASES: PipelinePhase[] = ["franchise_world", "franchise_setting", "work_world", "work_setting", "volume_world", "volume_setting", "volume_outline", "writing", "epub", "complete"];
const FLOW_STATUSES: PipelineFlowStatus[] = ["needs_input", "pending_finalization", "ready", "complete"];
const BEAT_STATUSES: BeatState["status"][] = ["pending", "complete"];
const MAX_CHAPTER_TARGET_WORDS = MAX_BEATS_PER_CHAPTER * MAX_BEAT_TARGET_WORDS;
const OBJECT_KEY_CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export function validateVolumeState(value: unknown): VolumeState {
  const state = assertRecord(value, "VolumeState");
  assertKnownFields(state, "VolumeState", [
    "schemaVersion", "franchiseId", "franchiseName", "workId", "workTitle", "volumeId", "volumeTitle",
    "phase", "flowStatus", "lastConsistencyFailure", "currentChapterNo", "currentBeatNo", "chapters", "createdAt", "updatedAt"
  ]);
  const chapters = boundedArrayField(state.chapters, "VolumeState.chapters", MAX_CHAPTERS).map(validateChapter);
  assertUnique(chapters.map((chapter) => chapter.chapterNo), "ChapterState.chapterNo");
  assertSequential(chapters.map((chapter) => chapter.chapterNo), "ChapterState.chapterNo");
  const totalBeats = chapters.reduce((sum, chapter) => sum + chapter.beats.length, 0);
  if (totalBeats > MAX_TOTAL_BEATS) throw new ValidationError(`VolumeState total beats must be less than or equal to ${MAX_TOTAL_BEATS}.`);
  const createdAt = timestampField(state.createdAt, "VolumeState.createdAt");
  const updatedAt = timestampField(state.updatedAt, "VolumeState.updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new ValidationError("VolumeState.updatedAt must be greater than or equal to createdAt.");
  const volumeState: VolumeState = {
    schemaVersion: schemaVersionField(state.schemaVersion, "VolumeState.schemaVersion"),
    franchiseId: assertSafeId(state.franchiseId, "VolumeState.franchiseId"),
    franchiseName: boundedSingleLineStringField(state.franchiseName, "VolumeState.franchiseName", MAX_TITLE_CHARS, MAX_TITLE_BYTES),
    workId: assertSafeId(state.workId, "VolumeState.workId"),
    workTitle: boundedSingleLineStringField(state.workTitle, "VolumeState.workTitle", MAX_TITLE_CHARS, MAX_TITLE_BYTES),
    volumeId: assertSafeId(state.volumeId, "VolumeState.volumeId"),
    volumeTitle: boundedSingleLineStringField(state.volumeTitle, "VolumeState.volumeTitle", MAX_TITLE_CHARS, MAX_TITLE_BYTES),
    phase: oneOf(state.phase, PHASES, "VolumeState.phase"),
    flowStatus: oneOf(state.flowStatus, FLOW_STATUSES, "VolumeState.flowStatus"),
    ...(state.lastConsistencyFailure === undefined ? {} : { lastConsistencyFailure: validateLastConsistencyFailure(state.lastConsistencyFailure) }),
    currentChapterNo: positiveInteger(state.currentChapterNo, "VolumeState.currentChapterNo"),
    currentBeatNo: positiveInteger(state.currentBeatNo, "VolumeState.currentBeatNo"),
    chapters,
    createdAt,
    updatedAt
  };
  if (requiresChapters(volumeState.phase) && volumeState.chapters.length === 0) throw new ValidationError("VolumeState writing and final phases require chapters.");
  if (volumeState.chapters.length > 0) {
    const cursorBeat = volumeState.chapters.flatMap((chapter) => chapter.beats).find((beat) => beat.chapterNo === volumeState.currentChapterNo && beat.beatNo === volumeState.currentBeatNo);
    if (!cursorBeat) throw new ValidationError("VolumeState cursor does not point to a known beat.");
    validateCursorPosition(volumeState);
    validatePendingBeatOrder(volumeState);
  }
  if (volumeState.phase === "complete" && volumeState.flowStatus !== "complete") throw new ValidationError("VolumeState complete phase requires complete flowStatus.");
  if (volumeState.flowStatus === "complete" && volumeState.phase !== "complete") throw new ValidationError("VolumeState complete flowStatus requires complete phase.");
  if (volumeState.phase === "complete" && volumeState.chapters.some((chapter) => chapter.beats.some((beat) => beat.status !== "complete"))) {
    throw new ValidationError("VolumeState complete phase requires every beat to be complete.");
  }
  return volumeState;
}

function requiresChapters(phase: PipelinePhase): boolean {
  return phase === "writing" || phase === "epub" || phase === "complete";
}

function validateCursorPosition(state: VolumeState): void {
  const beats = state.chapters.flatMap((chapter) => chapter.beats);
  if (state.phase === "complete" || state.phase === "epub") {
    const finalBeat = beats[beats.length - 1];
    if (finalBeat && (finalBeat.chapterNo !== state.currentChapterNo || finalBeat.beatNo !== state.currentBeatNo)) throw new ValidationError("VolumeState final phases must point cursor to the final beat.");
    return;
  }
  const firstIncompleteBeat = beats.find((beat) => beat.status !== "complete");
  if (!firstIncompleteBeat) return;
  if (firstIncompleteBeat.chapterNo !== state.currentChapterNo || firstIncompleteBeat.beatNo !== state.currentBeatNo) throw new ValidationError("VolumeState cursor must point to the first incomplete beat.");
}

function validatePendingBeatOrder(state: VolumeState): void {
  let seenPending = false;
  for (const beat of state.chapters.flatMap((chapter) => chapter.beats)) {
    if (beat.status === "pending") seenPending = true;
    else if (seenPending) throw new ValidationError("VolumeState pending beats must not be followed by complete beats.");
  }
}

function validateLastConsistencyFailure(value: unknown): VolumeState["lastConsistencyFailure"] {
  const record = assertRecord(value, "LastConsistencyFailure");
  assertKnownFields(record, "LastConsistencyFailure", ["phase", "submittedAt", "report"]);
  return { phase: oneOf(record.phase, PHASES, "LastConsistencyFailure.phase"), submittedAt: timestampField(record.submittedAt, "LastConsistencyFailure.submittedAt"), report: validateConsistencyReport(record.report) };
}

function validateConsistencyReport(value: unknown): ConsistencyReport {
  const record = assertRecord(value, "ConsistencyReport");
  assertKnownFields(record, "ConsistencyReport", ["ok", "checkedAgainst", "issues"]);
  return {
    ok: booleanField(record.ok, "ConsistencyReport.ok"),
    checkedAgainst: boundedArrayField(record.checkedAgainst, "ConsistencyReport.checkedAgainst", 1000).map((item, index) => boundedStringField(item, `ConsistencyReport.checkedAgainst[${index}]`, MAX_TITLE_CHARS, MAX_TITLE_BYTES)),
    issues: boundedArrayField(record.issues, "ConsistencyReport.issues", 1000).map(validateConsistencyIssue)
  };
}

function validateConsistencyIssue(value: unknown): ConsistencyReport["issues"][number] {
  const record = assertRecord(value, "ConsistencyIssue");
  assertKnownFields(record, "ConsistencyIssue", ["scope", "description"]);
  return { scope: boundedSingleLineStringField(record.scope, "ConsistencyIssue.scope", MAX_TITLE_CHARS, MAX_TITLE_BYTES), description: boundedStringField(record.description, "ConsistencyIssue.description", MAX_TEXT_CHARS, MAX_TEXT_BYTES) };
}

function validateChapter(value: unknown): ChapterState {
  const chapter = assertRecord(value, "ChapterState");
  assertKnownFields(chapter, "ChapterState", ["chapterNo", "title", "targetWords", "beats"]);
  const chapterNo = positiveInteger(chapter.chapterNo, "ChapterState.chapterNo");
  const beats = boundedNonEmptyArrayField(chapter.beats, "ChapterState.beats", MAX_BEATS_PER_CHAPTER).map((beat) => validateBeat(beat, chapterNo));
  assertUnique(beats.map((beat) => beat.beatNo), `ChapterState(${chapterNo}).beats.beatNo`);
  assertSequential(beats.map((beat) => beat.beatNo), `ChapterState(${chapterNo}).beats.beatNo`);
  const targetWords = boundedPositiveInteger(chapter.targetWords, "ChapterState.targetWords", MAX_CHAPTER_TARGET_WORDS);
  if (targetWords !== beats.reduce((sum, beat) => sum + beat.targetWords, 0)) throw new ValidationError(`ChapterState(${chapterNo}).targetWords must equal the sum of beat targetWords.`);
  return { chapterNo, title: boundedSingleLineStringField(chapter.title, "ChapterState.title", MAX_TITLE_CHARS, MAX_TITLE_BYTES), targetWords, beats };
}

function validateBeat(value: unknown, chapterNo: number): BeatState {
  const beat = assertRecord(value, "BeatState");
  assertKnownFields(beat, "BeatState", ["chapterNo", "beatNo", "title", "targetWords", "status"]);
  const beatChapterNo = positiveInteger(beat.chapterNo, "BeatState.chapterNo");
  if (beatChapterNo !== chapterNo) throw new ValidationError("BeatState.chapterNo must match its parent chapter.");
  return { chapterNo: beatChapterNo, beatNo: positiveInteger(beat.beatNo, "BeatState.beatNo"), title: boundedSingleLineStringField(beat.title, "BeatState.title", MAX_TITLE_CHARS, MAX_TITLE_BYTES), targetWords: boundedPositiveInteger(beat.targetWords, "BeatState.targetWords", MAX_BEAT_TARGET_WORDS), status: oneOf(beat.status, BEAT_STATUSES, "BeatState.status") };
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ValidationError(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}

function assertKnownFields(value: Record<string, unknown>, label: string, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  let fieldCount = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new ValidationError(`${label} must not contain symbol properties.`);
    fieldCount += 1;
    if (fieldCount > MAX_OBJECT_FIELDS) throw new ValidationError(`${label} must contain at most ${MAX_OBJECT_FIELDS} fields.`);
    if (key.length > MAX_OBJECT_KEY_CHARS || utf8ByteLengthUpTo(key, MAX_OBJECT_KEY_BYTES) > MAX_OBJECT_KEY_BYTES || OBJECT_KEY_CONTROL_CHARS.test(key)) throw new ValidationError(`${label} object keys are invalid.`);
    if (!allowedSet.has(key)) throw new ValidationError(`${label}.${key} is not a supported field.`);
  }
}

function boundedArrayField(value: unknown, label: string, max: number): unknown[] { if (!Array.isArray(value)) throw new ValidationError(`${label} must be an array.`); if (value.length > max) throw new ValidationError(`${label} must contain at most ${max} items.`); return value; }
function boundedNonEmptyArrayField(value: unknown, label: string, max: number): unknown[] { const array = boundedArrayField(value, label, max); if (array.length === 0) throw new ValidationError(`${label} must contain at least one item.`); return array; }
function schemaVersionField(value: unknown, label: string): 1 { if (value !== CURRENT_STATE_SCHEMA_VERSION) throw new ValidationError(`${label} must be ${CURRENT_STATE_SCHEMA_VERSION}.`); return CURRENT_STATE_SCHEMA_VERSION; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T { if (typeof value !== "string" || !allowed.includes(value as T)) throw new ValidationError(`${label} is invalid.`); return value as T; }
function positiveInteger(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new ValidationError(`${label} must be a positive integer.`); return value; }
function boundedPositiveInteger(value: unknown, label: string, max: number): number { const number = positiveInteger(value, label); if (number > max) throw new ValidationError(`${label} must be less than or equal to ${max}.`); return number; }
function booleanField(value: unknown, label: string): boolean { if (typeof value !== "boolean") throw new ValidationError(`${label} must be a boolean.`); return value; }
function timestampField(value: unknown, label: string): string { const text = boundedSingleLineStringField(value, label, MAX_TIMESTAMP_CHARS, MAX_TIMESTAMP_BYTES); if (Number.isNaN(Date.parse(text))) throw new ValidationError(`${label} must be a valid timestamp.`); return text; }
function boundedSingleLineStringField(value: unknown, label: string, maxChars: number, maxBytes: number): string { const text = boundedStringField(value, label, maxChars, maxBytes); if (/\r|\n/u.test(text)) throw new ValidationError(`${label} must be single-line.`); return text; }
function boundedStringField(value: unknown, label: string, maxChars: number, maxBytes: number): string { if (typeof value !== "string") throw new ValidationError(`${label} must be a string.`); if (value.length > maxChars || utf8ByteLengthUpTo(value, maxBytes) > maxBytes) throw new ValidationError(`${label} is too large.`); if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new ValidationError(`${label} must not contain control characters.`); return value; }
function assertUnique<T extends number | string>(values: T[], label: string): void { if (new Set<T>(values).size !== values.length) throw new ValidationError(`${label} values must be unique.`); }
function assertSequential(values: number[], label: string): void { values.forEach((value, index) => { if (value !== index + 1) throw new ValidationError(`${label} values must be sequential starting at 1.`); }); }
