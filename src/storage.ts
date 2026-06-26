import { access, lstat, mkdir, open, opendir, realpath, rename, rm, rmdir, stat, unlink, utimes } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type VolumeState } from "./types.js";
import { CURRENT_STATE_SCHEMA_VERSION } from "./constants.js";
import { assertObject, assertSafeId } from "./validation.js";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { validateVolumeState } from "./stateValidation.js";
import { redactErrorMessage, redactInlineSecrets } from "./redaction.js";
import {
  MAX_EPUB_ARCHIVE_BYTES,
  MAX_JSON_FILE_BYTES,
  MAX_MARKDOWN_FILE_BYTES,
  MAX_WORLD_FILE_BYTES,
  MAX_COLLECTED_VOLUME_MARKDOWN_CHARS,
  MAX_COLLECTED_VOLUME_MARKDOWN_BYTES,
  MAX_ATOMIC_WRITE_BYTES,
  MAX_LOCK_OWNER_FILE_BYTES,
  MAX_LOCK_OWNER_TOKEN_CHARS,
  MAX_SAFE_ID_BYTES,
  MAX_STORAGE_ROOT_CHARS,
  MAX_STORAGE_ROOT_BYTES,
  MAX_QUARANTINE_CLEANUP_FAILURE_ITEMS,
  MAX_MARKDOWN_FRONTMATTER_CHARS,
  MAX_MARKDOWN_FRONTMATTER_BYTES,
  MAX_MARKDOWN_FRONTMATTER_FIELDS,
  MAX_MARKDOWN_FRONTMATTER_KEY_CHARS,
  MAX_MARKDOWN_FRONTMATTER_KEY_BYTES,
  MAX_JSON_VALUE_DEPTH,
  MAX_JSON_OBJECT_FIELDS,
  MAX_JSON_OBJECT_KEY_CHARS,
  MAX_JSON_OBJECT_KEY_BYTES,
  MAX_JSON_STRING_CHARS,
  MAX_JSON_STRING_BYTES,
  MAX_JSON_ARRAY_ITEMS,
  MAX_JSON_TOTAL_NODES,
  MAX_DIRECTORY_SCAN_ENTRIES,
  MAX_DIRECTORY_ENTRY_NAME_CHARS,
  MAX_DIRECTORY_ENTRY_NAME_BYTES,
  MAX_SAFE_CHILD_DIRECTORIES,
  MAX_STORAGE_ERROR_CHARS,
  MAX_STORAGE_ERROR_BYTES,
  MAX_BEAT_PATH_INDEX,
  MAX_SET_TIMEOUT_MS,
  MAX_STORAGE_DURATION_MS,
  MAX_STORAGE_JOB_SNAPSHOTS,
  MAX_STORAGE_PATH_CHARS,
  MAX_STORAGE_PATH_BYTES,
  MAX_SLUG_INPUT_CHARS
} from "./constants.js";
import { validateEpubArchive } from "./epub.js";
import { assertNoDuplicateJsonObjectKeys } from "./jsonPreflight.js";
import { safeGetOwnPropertyDescriptor, safeGetPrototypeOf, safeOwnKeys } from "./safeProto.js";
import { utf8ByteLength, utf8ByteLengthUpTo } from "./utf8.js";

const STORAGE_ERROR_CONTROL_CHARS_GLOBAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const MARKDOWN_TEXT_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface StorageHealthCheck {
  root: string;
  writable: boolean;
  jobStoreReadable: boolean;
  currentPointerReadable: boolean;
  jobCount: number;
  jobQuarantineCount: number;
  error?: string;
  jobStoreError?: string;
  currentPointerError?: string;
}

export interface JobQuarantineCleanupResult {
  deleted: number;
  failed: number;
  failures: Array<{ path: string; error: string }>;
  failureItemLimit: number;
}

interface LockHandle {
  token: string;
  dev: number;
  ino: number;
}

export class NovelStorage {
  readonly root: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly lockStaleMs: number;
  private readonly maxJobSnapshots: number;

  constructor(config: AppConfig = loadConfig()) {
    const safeConfig = normalizeStorageConfig(config);
    this.root = assertStorageRoot(safeConfig.storageRoot);
    this.lockTimeoutMs = assertIntegerInRange(safeConfig.lockTimeoutMs, "NovelStorage.lockTimeoutMs", 1, MAX_STORAGE_DURATION_MS);
    this.lockRetryMs = assertIntegerInRange(safeConfig.lockRetryMs, "NovelStorage.lockRetryMs", 1, MAX_STORAGE_DURATION_MS);
    this.lockStaleMs = assertIntegerInRange(safeConfig.lockStaleMs, "NovelStorage.lockStaleMs", 1, MAX_STORAGE_DURATION_MS);
    this.maxJobSnapshots = assertIntegerInRange(safeConfig.maxJobs, "NovelStorage.maxJobs", 1, MAX_STORAGE_JOB_SNAPSHOTS);
  }

  franchiseDir(franchiseId: string): string {
    return this.insideRoot("franchises", assertSafeId(franchiseId, "franchiseId"));
  }

  workDir(franchiseId: string, workId: string): string {
    return this.insideRoot("franchises", assertSafeId(franchiseId, "franchiseId"), "works", assertSafeId(workId, "workId"));
  }

  volumeDir(franchiseId: string, workId: string, volumeId: string): string {
    return this.insideRoot(
      "franchises",
      assertSafeId(franchiseId, "franchiseId"),
      "works",
      assertSafeId(workId, "workId"),
      "volumes",
      assertSafeId(volumeId, "volumeId")
    );
  }

  statePath(franchiseId: string, workId: string, volumeId: string): string {
    return join(this.volumeDir(franchiseId, workId, volumeId), "state.json");
  }

  async ensureVolumeLayout(state: VolumeState): Promise<void> {
    const validated = validateVolumeState(state);
    const franchiseDir = this.franchiseDir(validated.franchiseId);
    const workDir = this.workDir(validated.franchiseId, validated.workId);
    const volumeDir = this.volumeDir(validated.franchiseId, validated.workId, validated.volumeId);
    await this.mkdirInsideRoot(join(franchiseDir, "canon"));
    await this.mkdirInsideRoot(workDir);
    await this.mkdirInsideRoot(join(volumeDir, "draft"));
    for (const chapter of validated.chapters) {
      await this.mkdirInsideRoot(join(volumeDir, "chapters", String(chapter.chapterNo).padStart(2, "0"), "beats"));
    }
  }

  async saveState(state: VolumeState): Promise<void> {
    const validated = validateVolumeState(stateWithStorageMetadata(state));
    await this.ensureVolumeLayout(validated);
    const path = this.statePath(validated.franchiseId, validated.workId, validated.volumeId);
    await this.backupStateIfPresent(path, validated);
    await this.writeJson(path, validated);
    await this.writeCurrentPointerBestEffort(validated);
  }

  async loadState(franchiseId: string, workId: string, volumeId: string): Promise<VolumeState> {
    const path = this.statePath(franchiseId, workId, volumeId);
    const backupPath = this.stateBackupPath(franchiseId, workId, volumeId);
    let primary: unknown;
    try {
      primary = await this.readJson<unknown>(path);
    } catch (error) {
      if (isRecoverableJsonPrimaryError(error) && await exists(backupPath)) {
        return this.validateStateForPath(await this.readJson<unknown>(backupPath), franchiseId, workId, volumeId);
      }
      throw error;
    }
    return this.validateStateForPath(primary, franchiseId, workId, volumeId);
  }

  async stateExists(franchiseId: string, workId: string, volumeId: string): Promise<boolean> {
    return exists(this.statePath(franchiseId, workId, volumeId));
  }

  stateBackupPath(franchiseId: string, workId: string, volumeId: string): string {
    return `${this.statePath(franchiseId, workId, volumeId)}.bak`;
  }

  async withVolumeLock<T>(
    franchiseId: string,
    workId: string,
    volumeId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const safeFranchiseId = assertSafeId(franchiseId, "franchiseId");
    const safeWorkId = assertSafeId(workId, "workId");
    const safeVolumeId = assertSafeId(volumeId, "volumeId");
    assertLockOperation(operation);
    return this.withLock(`volume-${hashIdParts(safeFranchiseId, safeWorkId, safeVolumeId)}`, operation);
  }

  async withCreationLock<T>(franchiseId: string, workId: string, volumeId: string, operation: () => Promise<T>): Promise<T> {
    return this.withVolumeLock(franchiseId, workId, volumeId, operation);
  }

  async loadCurrentState(): Promise<VolumeState | undefined> {
    const pointerPath = this.currentPointerPath();
    const backupPath = this.currentPointerBackupPath();
    if (!(await exists(pointerPath)) && !(await exists(backupPath))) {
      return undefined;
    }
    const pointer = await this.readCurrentPointerWithBackup(pointerPath);
    return this.loadState(pointer.franchiseId, pointer.workId, pointer.volumeId);
  }

  async writeCurrentPointer(state: VolumeState): Promise<void> {
    const validated = validateVolumeState(state);
    const pointerPath = this.currentPointerPath();
    const pointer = {
      franchiseId: validated.franchiseId,
      workId: validated.workId,
      volumeId: validated.volumeId
    };
    await this.backupCurrentPointerIfPresent(pointerPath);
    await this.writeJson(pointerPath, pointer);
    await this.syncCurrentPointerBackupBestEffort(pointer);
  }

  private async writeCurrentPointerBestEffort(state: VolumeState): Promise<void> {
    try {
      await this.writeCurrentPointer(state);
    } catch {
      // State is the authoritative record and has already been persisted.
      // A stale or missing current pointer should not make a successful state
      // write look like a failed pipeline operation.
    }
  }

  currentPointerPath(): string {
    return this.insideRoot("current.json");
  }

  currentPointerBackupPath(): string {
    return `${this.currentPointerPath()}.bak`;
  }

  async writeWorld(state: VolumeState, worldText: string): Promise<void> {
    await this.writeScopedWorld(state, "franchise", worldText);
  }

  async writeScopedWorld(state: VolumeState, scope: "franchise" | "work" | "volume", worldText: string): Promise<void> {
    const validated = validateVolumeState(state);
    const frontmatter: Record<string, unknown> = {
      franchiseId: validated.franchiseId,
      franchiseName: validated.franchiseName,
      scope,
      updatedAt: new Date().toISOString()
    };
    if (scope === "work" || scope === "volume") frontmatter.workId = validated.workId;
    if (scope === "volume") frontmatter.volumeId = validated.volumeId;
    await this.writeMarkdown(this.scopedWorldPath(validated, scope), frontmatter, worldText);
  }

  async writeScopedSetting(state: VolumeState, scope: "franchise" | "work" | "volume", settingText: string): Promise<void> {
    const validated = validateVolumeState(state);
    const frontmatter: Record<string, unknown> = {
      franchiseId: validated.franchiseId,
      franchiseName: validated.franchiseName,
      scope,
      updatedAt: new Date().toISOString()
    };
    if (scope === "work" || scope === "volume") frontmatter.workId = validated.workId;
    if (scope === "volume") frontmatter.volumeId = validated.volumeId;
    await this.writeMarkdown(this.scopedSettingPath(validated, scope), frontmatter, settingText);
  }

  async deleteWorld(state: VolumeState): Promise<void> {
    const { franchiseId } = this.volumeIdentity(state);
    const path = join(this.franchiseDir(franchiseId), "world.md");
    await this.unlinkInsideRealParent(path, `world ${path}`);
  }

  async readWorldFile(state: VolumeState): Promise<string | undefined> {
    const path = this.scopedWorldPath(validateVolumeState(state), "franchise");
    if (!(await exists(path))) {
      return undefined;
    }
    return this.readBoundedText(path, MAX_WORLD_FILE_BYTES, "World markdown file");
  }

  async readScopedWorldFile(state: VolumeState, scope: "franchise" | "work" | "volume"): Promise<string | undefined> {
    const path = this.scopedWorldPath(validateVolumeState(state), scope);
    if (!(await exists(path))) {
      return undefined;
    }
    return this.readBoundedText(path, MAX_WORLD_FILE_BYTES, `${scope} world markdown file`);
  }

  async readScopedSettingFile(state: VolumeState, scope: "franchise" | "work" | "volume"): Promise<string | undefined> {
    const path = this.scopedSettingPath(validateVolumeState(state), scope);
    if (!(await exists(path))) {
      return undefined;
    }
    return this.readBoundedText(path, MAX_MARKDOWN_FILE_BYTES, `${scope} setting markdown file`);
  }

  async writeWorldFile(state: VolumeState, content: string): Promise<void> {
    const { franchiseId } = this.volumeIdentity(state);
    const path = join(this.franchiseDir(franchiseId), "world.md");
    await this.writeBoundedText(path, content, MAX_WORLD_FILE_BYTES, "World markdown file");
  }

  async readWorld(state: VolumeState): Promise<string> {
    const path = this.scopedWorldPath(validateVolumeState(state), "franchise");
    return (await exists(path)) ? this.readBoundedText(path, MAX_WORLD_FILE_BYTES, "World markdown file") : "";
  }

  scopedWorldPath(state: VolumeState, scope: "franchise" | "work" | "volume"): string {
    const validated = validateVolumeState(state);
    if (scope === "franchise") {
      return join(this.franchiseDir(validated.franchiseId), "world.md");
    }
    if (scope === "work") {
      return join(this.workDir(validated.franchiseId, validated.workId), "world.md");
    }
    return join(this.volumeDir(validated.franchiseId, validated.workId, validated.volumeId), "world.md");
  }

  scopedSettingPath(state: VolumeState, scope: "franchise" | "work" | "volume"): string {
    const validated = validateVolumeState(state);
    if (scope === "franchise") {
      return join(this.franchiseDir(validated.franchiseId), "setting.md");
    }
    if (scope === "work") {
      return join(this.workDir(validated.franchiseId, validated.workId), "setting.md");
    }
    return join(this.volumeDir(validated.franchiseId, validated.workId, validated.volumeId), "setting.md");
  }

  async writeWork(state: VolumeState, content: string): Promise<void> {
    const validated = validateVolumeState(state);
    await this.writeMarkdown(join(this.workDir(validated.franchiseId, validated.workId), "work.md"), {
      franchiseId: validated.franchiseId,
      workId: validated.workId,
      title: validated.workTitle
    }, content);
  }

  async deleteWork(state: VolumeState): Promise<void> {
    const { franchiseId, workId } = this.volumeIdentity(state);
    const path = join(this.workDir(franchiseId, workId), "work.md");
    await this.unlinkInsideRealParent(path, `work ${path}`);
  }

  async readWorkFile(state: VolumeState): Promise<string | undefined> {
    const { franchiseId, workId } = this.volumeIdentity(state);
    const path = join(this.workDir(franchiseId, workId), "work.md");
    if (!(await exists(path))) {
      return undefined;
    }
    return this.readBoundedText(path, MAX_MARKDOWN_FILE_BYTES, "Work markdown file");
  }

  async writeWorkFile(state: VolumeState, content: string): Promise<void> {
    const { franchiseId, workId } = this.volumeIdentity(state);
    const path = join(this.workDir(franchiseId, workId), "work.md");
    await this.writeBoundedText(path, content, MAX_MARKDOWN_FILE_BYTES, "Work markdown file");
  }

  async writeOutline(state: VolumeState, content: string): Promise<void> {
    const validated = validateVolumeState(state);
    await this.writeMarkdown(join(this.volumeDir(validated.franchiseId, validated.workId, validated.volumeId), "outline.md"), {
      franchiseId: validated.franchiseId,
      workId: validated.workId,
      volumeId: validated.volumeId,
      title: validated.volumeTitle
    }, content);
  }

  async readOutlineFile(state: VolumeState): Promise<string | undefined> {
    const { franchiseId, workId, volumeId } = this.volumeIdentity(state);
    const path = join(this.volumeDir(franchiseId, workId, volumeId), "outline.md");
    if (!(await exists(path))) {
      return undefined;
    }
    return this.readBoundedText(path, MAX_MARKDOWN_FILE_BYTES, "Outline markdown file");
  }

  async writeOutlineFile(state: VolumeState, content: string): Promise<void> {
    const { franchiseId, workId, volumeId } = this.volumeIdentity(state);
    const path = join(this.volumeDir(franchiseId, workId, volumeId), "outline.md");
    await this.writeBoundedText(path, content, MAX_MARKDOWN_FILE_BYTES, "Outline markdown file");
  }

  async deleteOutline(state: VolumeState): Promise<void> {
    const { franchiseId, workId, volumeId } = this.volumeIdentity(state);
    const path = join(this.volumeDir(franchiseId, workId, volumeId), "outline.md");
    await this.unlinkInsideRealParent(path, `outline ${path}`);
  }

  async writeBeat(state: VolumeState, chapterNo: number, beatNo: number, content: string): Promise<string> {
    const validated = validateVolumeState(state);
    assertDeclaredBeat(validated, chapterNo, beatNo);
    const path = this.beatPath(validated, chapterNo, beatNo);
    const markdown = this.markdownContent(path, {
      franchiseId: validated.franchiseId,
      workId: validated.workId,
      volumeId: validated.volumeId,
      chapterNo,
      beatNo
    }, content);
    await this.deleteEpub(validated);
    await this.writeFileAtomic(path, markdown);
    return path;
  }

  async readBeat(state: VolumeState, chapterNo: number, beatNo: number): Promise<string> {
    const validated = validateVolumeState(state);
    assertDeclaredBeat(validated, chapterNo, beatNo);
    const path = this.beatPath(validated, chapterNo, beatNo);
    if (!(await exists(path))) {
      throw new Error(`Beat markdown file is missing: chapter=${chapterNo}, beat=${beatNo}, path=${path}`);
    }
    return this.readBoundedText(path, MAX_MARKDOWN_FILE_BYTES, "Beat markdown file");
  }

  async beatFileExists(state: VolumeState, chapterNo: number, beatNo: number): Promise<boolean> {
    const path = this.beatPath(state, chapterNo, beatNo);
    return exists(path);
  }

  async epubFileExists(state: VolumeState): Promise<boolean> {
    const path = this.epubPath(state);
    return exists(path);
  }

  async readBeatFile(state: VolumeState, chapterNo: number, beatNo: number): Promise<string | undefined> {
    const validated = validateVolumeState(state);
    assertDeclaredBeat(validated, chapterNo, beatNo);
    const path = this.beatPath(validated, chapterNo, beatNo);
    if (!(await exists(path))) {
      return undefined;
    }
    return this.readBoundedText(path, MAX_MARKDOWN_FILE_BYTES, "Beat markdown file");
  }

  async writeBeatFile(state: VolumeState, chapterNo: number, beatNo: number, content: string): Promise<string> {
    const validated = validateVolumeState(state);
    assertDeclaredBeat(validated, chapterNo, beatNo);
    const path = this.beatPath(validated, chapterNo, beatNo);
    const text = this.boundedTextContent(path, content, MAX_MARKDOWN_FILE_BYTES, "Beat markdown file");
    await this.deleteEpub(validated);
    await this.writeFileAtomic(path, text);
    return path;
  }

  async writeBeatDraft(state: VolumeState, chapterNo: number, beatNo: number, content: string): Promise<string> {
    const validated = validateVolumeState(state);
    assertDeclaredBeat(validated, chapterNo, beatNo);
    const path = this.beatDraftPath(validated, chapterNo, beatNo);
    const markdown = this.markdownContent(path, {
      franchiseId: validated.franchiseId,
      workId: validated.workId,
      volumeId: validated.volumeId,
      chapterNo,
      beatNo
    }, content);
    await this.writeFileAtomic(path, markdown);
    return path;
  }

  async readBeatDraftFile(state: VolumeState, chapterNo: number, beatNo: number): Promise<string | undefined> {
    const validated = validateVolumeState(state);
    assertDeclaredBeat(validated, chapterNo, beatNo);
    const path = this.beatDraftPath(validated, chapterNo, beatNo);
    if (!(await exists(path))) {
      return undefined;
    }
    return this.readBoundedText(path, MAX_MARKDOWN_FILE_BYTES, "Beat draft markdown file");
  }

  async deleteBeat(state: VolumeState, chapterNo: number, beatNo: number): Promise<void> {
    const validated = validateVolumeState(state);
    assertDeclaredBeat(validated, chapterNo, beatNo);
    const path = this.beatPath(validated, chapterNo, beatNo);
    await this.deleteEpub(validated);
    await this.unlinkInsideRealParent(path, `beat ${path}`);
  }

  beatPath(state: VolumeState, chapterNo: number, beatNo: number): string {
    const safeChapterNo = assertPositivePathIndex(chapterNo, "chapterNo");
    const safeBeatNo = assertPositivePathIndex(beatNo, "beatNo");
    const validated = validateVolumeState(state);
    assertDeclaredBeat(validated, safeChapterNo, safeBeatNo);
    const { franchiseId, workId, volumeId } = this.volumeIdentity(validated);
    return join(
      this.volumeDir(franchiseId, workId, volumeId),
      "chapters",
      String(safeChapterNo).padStart(2, "0"),
      "beats",
      `${String(safeBeatNo).padStart(2, "0")}.md`
    );
  }

  beatDraftPath(state: VolumeState, chapterNo: number, beatNo: number): string {
    const finalPath = this.beatPath(state, chapterNo, beatNo);
    return finalPath.replace(/\.md$/u, ".draft.md");
  }

  async collectVolumeMarkdown(state: VolumeState): Promise<string> {
    const validated = validateVolumeState(state);
    const parts: string[] = [];
    let collectedLength = 0;
    let collectedBytes = 0;
    const appendPart = (part: string) => {
      const nextLength = collectedLength + part.length + (parts.length > 0 ? 2 : 0);
      if (nextLength + 1 > MAX_COLLECTED_VOLUME_MARKDOWN_CHARS) {
        throw new Error(`Collected volume markdown is too large: maximum is ${MAX_COLLECTED_VOLUME_MARKDOWN_CHARS} characters.`);
      }
      const nextBytes = collectedBytes + utf8ByteLengthUpTo(part, MAX_COLLECTED_VOLUME_MARKDOWN_BYTES) + (parts.length > 0 ? 2 : 0);
      if (nextBytes + 1 > MAX_COLLECTED_VOLUME_MARKDOWN_BYTES) {
        throw new Error(`Collected volume markdown is too large: maximum is ${MAX_COLLECTED_VOLUME_MARKDOWN_BYTES} UTF-8 bytes.`);
      }
      parts.push(part);
      collectedLength = nextLength;
      collectedBytes = nextBytes;
    };
    appendPart(`# ${validated.volumeTitle}`);
    for (const chapter of validated.chapters) {
      appendPart(`\n## ${chapter.title}\n`);
      for (const beat of chapter.beats) {
        const text = await this.readBeat(validated, beat.chapterNo, beat.beatNo);
        appendPart(beatMarkdownBody(text, {
          franchiseId: validated.franchiseId,
          workId: validated.workId,
          volumeId: validated.volumeId,
          chapterNo: beat.chapterNo,
          beatNo: beat.beatNo
        }));
      }
    }
    return `${parts.join("\n\n")}\n`;
  }

  async writeEpub(state: VolumeState, content: Uint8Array): Promise<string> {
    const validated = validateVolumeState(state);
    const validation = validateEpubArchive(content);
    if (!validation.valid) {
      throw new Error(`EPUB archive validation failed: ${validation.issues.join("; ")}`);
    }
    const path = this.epubPath(validated);
    await this.writeFileAtomic(path, content);
    return path;
  }

  async readEpubFile(state: VolumeState): Promise<Uint8Array | undefined> {
    const path = this.epubPath(state);
    if (!(await exists(path))) {
      return undefined;
    }
    const content = await this.readBoundedBytes(path, MAX_EPUB_ARCHIVE_BYTES, "EPUB archive");
    const validation = validateEpubArchive(content);
    if (!validation.valid) {
      throw new Error(`EPUB archive validation failed: ${validation.issues.join("; ")}`);
    }
    return content;
  }

  async deleteEpub(state: VolumeState): Promise<void> {
    const path = this.epubPath(state);
    await this.unlinkInsideRealParent(path, `EPUB ${path}`);
  }

  async writeEpubCandidate(state: VolumeState, content: Uint8Array): Promise<string> {
    const validated = validateVolumeState(state);
    const { franchiseId, workId, volumeId } = this.volumeIdentity(validated);
    const validation = validateEpubArchive(content);
    if (!validation.valid) {
      throw new Error(`EPUB candidate archive validation failed: ${validation.issues.join("; ")}`);
    }
    const path = join(this.volumeDir(franchiseId, workId, volumeId), `${volumeId}.candidate-${randomUUID()}.epub`);
    await this.writeFileAtomic(path, content);
    return path;
  }

  async promoteEpubCandidate(state: VolumeState, candidatePath: string): Promise<string> {
    this.assertInsideRoot(candidatePath);
    await this.assertRealPathInsideRoot(candidatePath, "EPUB candidate");
    const candidateStats = await lstat(candidatePath);
    if (!candidateStats.isFile()) {
      throw new Error(`EPUB candidate must be a regular file: ${candidatePath}`);
    }
    if (!Number.isSafeInteger(candidateStats.size) || candidateStats.size < 0) {
      throw new Error(`EPUB candidate size must be a non-negative safe integer: ${candidatePath}`);
    }
    if (candidateStats.size > MAX_EPUB_ARCHIVE_BYTES) {
      throw new Error(`EPUB candidate archive is too large: ${candidateStats.size} bytes, maximum is ${MAX_EPUB_ARCHIVE_BYTES} bytes.`);
    }
    this.assertEpubCandidateForVolume(state, candidatePath);
    const validated = validateVolumeState(state);
    const validation = validateEpubArchive(await this.readBoundedBytes(candidatePath, MAX_EPUB_ARCHIVE_BYTES, "EPUB candidate archive"));
    if (!validation.valid) {
      throw new Error(`EPUB candidate archive validation failed: ${validation.issues.join("; ")}`);
    }
    const finalPath = this.epubPath(validated);
    await this.mkdirInsideRoot(dirname(finalPath));
    await this.assertRealPathInsideRoot(dirname(finalPath), `parent directory for EPUB ${finalPath}`);
    await this.beforePromoteEpubCandidateRename(candidatePath);
    await this.assertSameFileIdentity(candidatePath, candidateStats, "EPUB candidate after validation");
    await rename(candidatePath, finalPath);
    await this.syncDirectory(dirname(finalPath), `parent directory for EPUB ${finalPath}`);
    return finalPath;
  }

  protected async beforePromoteEpubCandidateRename(_candidatePath: string): Promise<void> {
    return undefined;
  }

  async deleteEpubCandidate(state: VolumeState, candidatePath: string): Promise<void> {
    this.assertInsideRoot(candidatePath);
    this.assertEpubCandidateForVolume(state, candidatePath);
    await this.unlinkInsideRealParent(candidatePath, `EPUB candidate ${candidatePath}`);
  }

  epubPath(state: VolumeState): string {
    const { franchiseId, workId, volumeId } = this.volumeIdentity(state);
    return join(this.volumeDir(franchiseId, workId, volumeId), `${volumeId}.epub`);
  }

  private assertEpubCandidateForVolume(state: VolumeState, candidatePath: string): void {
    const { franchiseId, workId, volumeId } = this.volumeIdentity(state);
    const volumeDir = this.volumeDir(franchiseId, workId, volumeId);
    const resolvedCandidate = resolve(candidatePath);
    if (dirname(resolvedCandidate) !== volumeDir) {
      throw new Error(`EPUB candidate must be inside the target volume directory: ${candidatePath}`);
    }
    const name = resolvedCandidate.slice(volumeDir.length + 1);
    const escapedVolumeId = escapeRegExp(volumeId);
    if (!new RegExp(`^${escapedVolumeId}\\.candidate-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.epub$`, "u").test(name)) {
      throw new Error(`EPUB candidate has an invalid candidate filename: ${candidatePath}`);
    }
  }

  private volumeIdentity(state: VolumeState): { franchiseId: string; workId: string; volumeId: string } {
    return this.volumeIdentityFromObject(this.volumeData(state));
  }

  private volumeData(state: VolumeState): Record<string, unknown> {
    return assertObject(state, "VolumeState");
  }

  private volumeIdentityFromObject(object: Record<string, unknown>): { franchiseId: string; workId: string; volumeId: string } {
    return {
      franchiseId: assertSafeId(object.franchiseId, "franchiseId"),
      workId: assertSafeId(object.workId, "workId"),
      volumeId: assertSafeId(object.volumeId, "volumeId")
    };
  }

  async healthCheck(): Promise<StorageHealthCheck> {
    const result: StorageHealthCheck = {
      root: this.root,
      writable: false,
      jobStoreReadable: false,
      currentPointerReadable: true,
      jobCount: 0,
      jobQuarantineCount: 0
    };
    const probePath = this.insideRoot(".health", `probe-${randomUUID()}.tmp`);
    try {
      await this.writeFileAtomic(probePath, "ok\n");
      await unlink(probePath);
      result.writable = true;
    } catch (error) {
      result.error = errorMessage(error);
    }
    try {
      const jobIds = await this.listJobIds();
      result.jobStoreReadable = true;
      result.jobCount = jobIds.length;
      result.jobQuarantineCount = await this.countJobQuarantineFiles();
    } catch (error) {
      result.jobStoreReadable = false;
      result.jobStoreError = errorMessage(error);
    }
    try {
      const pointerPath = this.currentPointerPath();
      const backupPath = this.currentPointerBackupPath();
      if ((await exists(pointerPath)) || (await exists(backupPath))) {
        await this.loadCurrentState();
      }
    } catch (error) {
      result.currentPointerReadable = false;
      result.currentPointerError = errorMessage(error);
    }
    return result;
  }

  jobPath(jobId: string): string {
    return this.insideRoot("jobs", `${assertSafeId(jobId, "jobId")}.json`);
  }

  async writeJob(jobId: string, value: unknown): Promise<void> {
    await this.writeJson(this.jobPath(jobId), value);
  }

  async readJob<T>(jobId: string): Promise<T> {
    return this.readJson<T>(this.jobPath(jobId));
  }

  async deleteJob(jobId: string): Promise<void> {
    const path = this.jobPath(jobId);
    await this.unlinkInsideRealParent(path, `job snapshot ${path}`);
  }

  async quarantineJob(jobId: string): Promise<string> {
    const source = this.jobPath(jobId);
    const destination = this.insideRoot("jobs", "quarantine", `${assertSafeId(jobId, "jobId")}-${Date.now()}-${randomUUID()}.json`);
    await this.assertRealPathInsideRoot(dirname(source), `directory ${dirname(source)}`);
    const sourceStats = await lstat(source);
    if (!sourceStats.isFile() && !sourceStats.isSymbolicLink()) {
      throw new Error(`job snapshot path is not a file: ${source}`);
    }
    if (!sourceStats.isSymbolicLink()) {
      await this.assertRealPathInsideRoot(source, `job snapshot ${source}`);
    }
    await this.mkdirInsideRoot(dirname(destination));
    await this.assertRealPathInsideRoot(dirname(destination), `directory ${dirname(destination)}`);
    await this.beforeQuarantineJobRename(source, destination);
    await this.assertSameFileIdentity(source, sourceStats, `job snapshot ${source}`);
    await rename(source, destination);
    return destination;
  }

  protected async beforeQuarantineJobRename(_source: string, _destination: string): Promise<void> {
    return undefined;
  }

  async cleanupJobQuarantine(cutoffMs: number): Promise<JobQuarantineCleanupResult> {
    const safeCutoffMs = assertIntegerInRange(cutoffMs, "Job quarantine cleanup cutoffMs", 0, Number.MAX_SAFE_INTEGER);
    const dir = this.insideRoot("jobs", "quarantine");
    let deleted = 0;
    let failed = 0;
    const failures: Array<{ path: string; error: string }> = [];
    if (!(await exists(dir))) {
      return { deleted, failed, failures, failureItemLimit: MAX_QUARANTINE_CLEANUP_FAILURE_ITEMS };
    }
    await this.assertRealPathInsideRoot(dir, `directory ${dir}`);
    let scannedSnapshots = 0;
    const deleteCandidates: Array<{ path: string; identity: FileIdentity }> = [];
    for await (const name of this.readDirectoryNames(dir)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const path = join(dir, name);
      try {
        const stats = await lstat(path);
        if (!stats.isFile() && !stats.isSymbolicLink()) {
          continue;
        }
        scannedSnapshots += 1;
        if (scannedSnapshots > this.maxJobSnapshots) {
          throw new Error(`Job quarantine directory has too many snapshot files: maximum is ${this.maxJobSnapshots}.`);
        }
        if (stats.mtimeMs > safeCutoffMs) {
          continue;
        }
        deleteCandidates.push({
          path,
          identity: {
            dev: stats.dev,
            ino: stats.ino,
            size: stats.size,
            mtimeMs: stats.mtimeMs
          }
        });
      } catch (error) {
        if (redactErrorMessage(error).startsWith("Job quarantine directory has too many snapshot files:")) {
          throw error;
        }
        failed += 1;
        if (failures.length < MAX_QUARANTINE_CLEANUP_FAILURE_ITEMS) {
          failures.push({ path, error: errorMessage(error) });
        }
      }
    }
    for (const { path, identity } of deleteCandidates) {
      try {
        await this.beforeDeleteJobQuarantineCandidate(path);
        await this.assertSameFileIdentity(path, identity, `job quarantine snapshot ${path}`);
        await this.unlinkInsideRealParent(path, `job quarantine snapshot ${path}`);
        deleted += 1;
      } catch (error) {
        failed += 1;
        if (failures.length < MAX_QUARANTINE_CLEANUP_FAILURE_ITEMS) {
          failures.push({ path, error: errorMessage(error) });
        }
      }
    }
    return { deleted, failed, failures, failureItemLimit: MAX_QUARANTINE_CLEANUP_FAILURE_ITEMS };
  }

  protected async beforeDeleteJobQuarantineCandidate(_path: string): Promise<void> {
    return undefined;
  }

  async countJobQuarantineFiles(): Promise<number> {
    const dir = this.insideRoot("jobs", "quarantine");
    if (!(await exists(dir))) {
      return 0;
    }
    await this.assertRealPathInsideRoot(dir, `directory ${dir}`);
    let count = 0;
    for await (const name of this.readDirectoryNames(dir)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const path = join(dir, name);
      let stats;
      try {
        stats = await lstat(path);
      } catch (error) {
        if (isErrno(error, "ENOENT")) {
          continue;
        }
        throw error;
      }
      if (stats.isFile() || stats.isSymbolicLink()) {
        count += 1;
      }
      if (count > this.maxJobSnapshots) {
        throw new Error(`Job quarantine directory has too many snapshot files: maximum is ${this.maxJobSnapshots}.`);
      }
    }
    return count;
  }

  async listJobIds(): Promise<string[]> {
    const dir = this.insideRoot("jobs");
    if (!(await exists(dir))) {
      return [];
    }
    await this.assertRealPathInsideRoot(dir, `directory ${dir}`);
    const jobIds: string[] = [];
    for await (const name of this.readDirectoryNames(dir)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const jobId = name.slice(0, -".json".length);
      if (!isSafeIdSegment(jobId)) {
        continue;
      }
      try {
        const stats = await lstat(join(dir, name));
        if (stats.isFile() || stats.isSymbolicLink()) {
          jobIds.push(jobId);
        }
      } catch (error) {
        if (!isErrno(error, "ENOENT")) {
          throw error;
        }
        // Ignore entries that disappear while the directory is being scanned.
      }
      if (jobIds.length > this.maxJobSnapshots) {
        throw new Error(`Job snapshot directory has too many safe job snapshots: maximum is ${this.maxJobSnapshots}.`);
      }
    }
    return jobIds.sort();
  }

  async listFranchises(): Promise<string[]> {
    return this.listSafeChildDirectories(this.insideRoot("franchises"));
  }

  async listWorks(franchiseId: string): Promise<string[]> {
    return this.listSafeChildDirectories(join(this.franchiseDir(franchiseId), "works"));
  }

  async listVolumes(franchiseId: string, workId: string): Promise<string[]> {
    return this.listSafeChildDirectories(join(this.workDir(franchiseId, workId), "volumes"));
  }

  async readJson<T>(path: string): Promise<T> {
    const text = await this.readBoundedJsonText(path);
    return parseJsonMetadataText<T>(text, path);
  }

  async writeJson(path: string, value: unknown): Promise<void> {
    const stableValue = snapshotJsonMetadataValue(value, "JSON metadata file");
    let content: string;
    try {
      content = `${JSON.stringify(stableValue, null, 2)}\n`;
    } catch (error) {
      throw new Error(`JSON metadata file must be JSON serializable: ${errorMessage(error)}`);
    }
    const bytes = utf8ByteLengthUpTo(content, MAX_JSON_FILE_BYTES);
    if (bytes > MAX_JSON_FILE_BYTES) {
      throw new Error(`JSON metadata file is too large to write: ${path} is ${bytes} bytes, maximum is ${MAX_JSON_FILE_BYTES} bytes.`);
    }
    await this.writeFileAtomic(path, content);
  }

  async writeMarkdown(path: string, frontmatter: Record<string, unknown>, body: string): Promise<void> {
    const content = this.markdownContent(path, frontmatter, body);
    await this.writeFileAtomic(path, content);
  }

  private markdownContent(path: string, frontmatter: Record<string, unknown>, body: string): string {
    if (typeof body !== "string") {
      throw new Error(`Markdown body for ${path} must be a string.`);
    }
    if (body.length > MAX_MARKDOWN_FILE_BYTES) {
      throw new Error(`Markdown body for ${path} must be at most ${MAX_MARKDOWN_FILE_BYTES} characters before trimming.`);
    }
    if (MARKDOWN_TEXT_CONTROL_CHARS.test(body)) {
      throw new Error(`Markdown body for ${path} must not contain non-printing control characters.`);
    }
    const trimmedBody = body.trim();
    if (trimmedBody.length === 0) {
      throw new Error(`Markdown body for ${path} must be non-empty after trimming.`);
    }
    const entries = markdownFrontmatterEntries(frontmatter, `Markdown frontmatter for ${path}`);
    if (entries.length > MAX_MARKDOWN_FRONTMATTER_FIELDS) {
      throw new Error(`Markdown frontmatter for ${path} has too many fields: maximum is ${MAX_MARKDOWN_FRONTMATTER_FIELDS}.`);
    }
    const header = entries
      .map(([key, value]) => `${frontmatterKey(key, `Markdown frontmatter for ${path}`)}: ${JSON.stringify(frontmatterValue(value, key, path))}`)
      .join("\n");
    if (header.length > MAX_MARKDOWN_FRONTMATTER_CHARS) {
      throw new Error(`Markdown frontmatter for ${path} is too large: maximum is ${MAX_MARKDOWN_FRONTMATTER_CHARS} characters.`);
    }
    if (utf8ByteLengthUpTo(header, MAX_MARKDOWN_FRONTMATTER_BYTES) > MAX_MARKDOWN_FRONTMATTER_BYTES) {
      throw new Error(`Markdown frontmatter for ${path} is too large: maximum is ${MAX_MARKDOWN_FRONTMATTER_BYTES} UTF-8 bytes.`);
    }
    const content = `---\n${header}\n---\n\n${trimmedBody}\n`;
    const bytes = utf8ByteLengthUpTo(content, MAX_MARKDOWN_FILE_BYTES);
    if (bytes > MAX_MARKDOWN_FILE_BYTES) {
      throw new Error(`Markdown file is too large to write: ${path} is ${bytes} bytes, maximum is ${MAX_MARKDOWN_FILE_BYTES} bytes.`);
    }
    return content;
  }

  async writeFileAtomic(path: string, content: string | Uint8Array): Promise<void> {
    this.assertInsideRoot(path);
    const contentLabel = `Atomic write content for ${path}`;
    assertWritableContent(content, contentLabel);
    const stableContent = snapshotWritableContent(content, contentLabel);
    const parent = dirname(path);
    await this.mkdirInsideRoot(parent);
    await this.assertRealPathInsideRoot(parent, `parent directory for ${path}`);
    const tempPath = this.tempPathFor(path);
    this.assertInsideRoot(tempPath);
    this.assertSameDirectoryTempPath(path, tempPath);
    let tempCreated = false;
    try {
      const tempIdentity = await this.writeTempFileExclusive(tempPath, stableContent);
      tempCreated = true;
      await this.assertRealPathInsideRoot(tempPath, `temporary file for ${path}`);
      await this.assertRealPathInsideRoot(parent, `parent directory for ${path}`);
      await this.beforeAtomicRename(tempPath, path);
      await this.assertSameFileIdentity(tempPath, tempIdentity, `temporary file for ${path}`);
      await rename(tempPath, path);
      tempCreated = false;
      await this.syncDirectory(parent, `parent directory for ${path}`);
    } catch (error) {
      if (tempCreated) {
        await this.unlinkTempIfInsideRoot(tempPath);
      }
      throw error;
    }
  }

  protected async writeFileAtomicExistingDirectory(path: string, content: string | Uint8Array): Promise<void> {
    this.assertInsideRoot(path);
    const contentLabel = `Atomic write content for ${path}`;
    assertWritableContent(content, contentLabel);
    const stableContent = snapshotWritableContent(content, contentLabel);
    const parent = dirname(path);
    await this.assertExistingAncestorInsideRoot(parent, `parent directory for ${path}`);
    await this.assertRealPathInsideRoot(parent, `parent directory for ${path}`);
    const tempPath = this.tempPathFor(path);
    this.assertInsideRoot(tempPath);
    this.assertSameDirectoryTempPath(path, tempPath);
    let tempCreated = false;
    try {
      const tempIdentity = await this.writeTempFileExclusive(tempPath, stableContent);
      tempCreated = true;
      await this.assertRealPathInsideRoot(tempPath, `temporary file for ${path}`);
      await this.assertRealPathInsideRoot(parent, `parent directory for ${path}`);
      await this.beforeAtomicRename(tempPath, path);
      await this.assertSameFileIdentity(tempPath, tempIdentity, `temporary file for ${path}`);
      await rename(tempPath, path);
      tempCreated = false;
      await this.syncDirectory(parent, `parent directory for ${path}`);
    } catch (error) {
      if (tempCreated) {
        await this.unlinkTempIfInsideRoot(tempPath);
      }
      throw error;
    }
  }

  protected tempPathFor(path: string): string {
    return `${path}.tmp-${randomUUID()}`;
  }

  private assertSameDirectoryTempPath(path: string, tempPath: string): void {
    const target = resolve(path);
    const temporary = resolve(tempPath);
    if (temporary === target) {
      throw new Error(`Atomic temporary file must be distinct from target: ${tempPath}`);
    }
    if (dirname(temporary) !== dirname(target)) {
      throw new Error(`Atomic temporary file must be created in the target directory: ${tempPath}`);
    }
  }

  private async writeTempFileExclusive(path: string, content: string | Uint8Array): Promise<FileIdentity> {
    const handle = await open(path, "wx");
    let failure: unknown;
    let identity: FileIdentity | undefined;
    try {
      await this.writeTempFileContent(handle, content);
      await this.syncWrittenFile(handle, `temporary file ${path}`);
      const stats = await handle.stat();
      identity = {
        dev: stats.dev,
        ino: stats.ino,
        size: stats.size,
        mtimeMs: stats.mtimeMs
      };
    } catch (error) {
      failure = error;
    }
    try {
      await handle.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) {
      await this.unlinkTempIfInsideRoot(path);
      throw failure;
    }
    if (!identity) {
      await this.unlinkTempIfInsideRoot(path);
      throw new Error(`Failed to record temporary file identity: ${path}`);
    }
    return identity;
  }

  protected async beforeAtomicRename(_tempPath: string, _targetPath: string): Promise<void> {
    return undefined;
  }

  protected async writeTempFileContent(handle: Awaited<ReturnType<typeof open>>, content: string | Uint8Array): Promise<void> {
    await handle.writeFile(content, typeof content === "string" ? "utf8" : undefined);
  }

  protected async syncWrittenFile(handle: Awaited<ReturnType<typeof open>>, label: string): Promise<void> {
    try {
      await handle.sync();
    } catch (error) {
      throw new Error(`Failed to sync ${label}: ${errorMessage(error)}`);
    }
  }

  protected async syncDirectory(path: string, label: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, "r");
      await handle.sync();
    } catch (error) {
      if (isErrno(error, "EINVAL") || isErrno(error, "ENOTSUP") || isErrno(error, "EISDIR") || isErrno(error, "EPERM")) {
        return;
      }
      throw new Error(`Failed to sync ${label}: ${errorMessage(error)}`);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async unlinkTempIfInsideRoot(path: string): Promise<void> {
    try {
      await this.assertRealPathInsideRoot(path, `temporary file ${path}`);
      await unlink(path);
    } catch {
      // Best-effort cleanup must not mask the write or rename failure.
    }
  }

  private async unlinkInsideRealParent(path: string, label: string): Promise<void> {
    this.assertInsideRoot(path);
    const parent = dirname(path);
    try {
      await this.assertRealPathInsideRoot(parent, `parent directory for ${label}`);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    await unlink(path).catch((error: unknown) => {
      if (!isErrno(error, "ENOENT")) {
        throw error;
      }
    });
  }

  private async backupStateIfPresent(path: string, nextState: VolumeState): Promise<void> {
    if (!(await exists(path))) {
      return;
    }
    let current: string;
    try {
      current = await this.readBoundedJsonText(path);
      this.validateStateForPath(parseJsonMetadataText(current, path), nextState.franchiseId, nextState.workId, nextState.volumeId);
    } catch {
      return;
    }
    const backupPath = `${path}.bak`;
    await this.writeFileAtomic(backupPath, current);
  }

  private async backupCurrentPointerIfPresent(path: string): Promise<void> {
    if (!(await exists(path))) {
      return;
    }
    let current: string;
    let pointer: { franchiseId: string; workId: string; volumeId: string };
    try {
      current = await this.readBoundedJsonText(path);
      pointer = this.validateCurrentPointer(parseJsonMetadataText(current, path));
      await this.loadState(pointer.franchiseId, pointer.workId, pointer.volumeId);
    } catch {
      return;
    }
    await this.writeFileAtomic(this.currentPointerBackupPath(), current);
  }

  private async syncCurrentPointerBackupBestEffort(pointer: { franchiseId: string; workId: string; volumeId: string }): Promise<void> {
    try {
      await this.writeJson(this.currentPointerBackupPath(), pointer);
    } catch {
      // The primary current pointer is authoritative; backup sync must not turn
      // an otherwise successful state write into a confusing partial failure.
    }
  }

  private async readCurrentPointer(path: string): Promise<{ franchiseId: string; workId: string; volumeId: string }> {
    return this.validateCurrentPointer(await this.readJson<unknown>(path));
  }

  private async readBoundedJsonText(path: string): Promise<string> {
    return this.readBoundedText(path, MAX_JSON_FILE_BYTES, "JSON metadata file");
  }

  private async assertSameFileIdentity(path: string, expected: FileIdentity, label: string): Promise<void> {
    const actual = await lstat(path);
    if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs) {
      throw new Error(`${label} changed before promotion: ${path}`);
    }
  }

  private async readBoundedBytes(path: string, maxBytes: number, label: string): Promise<Uint8Array> {
    this.assertInsideRoot(path);
    const linkStats = await lstat(path);
    if (linkStats.isSymbolicLink()) {
      throw new Error(`${label} path must not be a symbolic link: ${path}`);
    }
    if (!linkStats.isFile()) {
      throw new Error(`${label} path is not a file: ${path}`);
    }
    await this.assertRealPathInsideRoot(path, label);
    const handle = await open(path, "r");
    try {
      const stats = await handle.stat();
      if (stats.dev !== linkStats.dev || stats.ino !== linkStats.ino) {
        throw new Error(`${label} path changed while being opened: ${path}`);
      }
      if (!stats.isFile()) {
        throw new Error(`${label} path is not a file: ${path}`);
      }
      if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
        throw new Error(`${label} size must be a non-negative safe integer: ${path}`);
      }
      if (stats.size > maxBytes) {
        throw new Error(`${label} is too large: ${path} is ${stats.size} bytes, maximum is ${maxBytes} bytes.`);
      }
      const expectedLength = Number(stats.size);
      const buffer = new Uint8Array(expectedLength);
      let offset = 0;
      while (offset < expectedLength) {
        const { bytesRead } = await handle.read(buffer, offset, expectedLength - offset, offset);
        if (bytesRead === 0) {
          break;
        }
        offset += bytesRead;
      }
      if (offset !== expectedLength) {
        throw new Error(`${label} changed while being read: ${path}`);
      }
      await this.assertOpenedFileUnchanged(handle, stats, label, path);
      return buffer;
    } finally {
      await handle.close();
    }
  }

  private async readBoundedText(path: string, maxBytes: number, label: string): Promise<string> {
    this.assertInsideRoot(path);
    const linkStats = await lstat(path);
    if (linkStats.isSymbolicLink()) {
      throw new Error(`${label} path must not be a symbolic link: ${path}`);
    }
    if (!linkStats.isFile()) {
      throw new Error(`${label} path is not a file: ${path}`);
    }
    await this.assertRealPathInsideRoot(path, label);
    const handle = await open(path, "r");
    try {
      const stats = await handle.stat();
      if (stats.dev !== linkStats.dev || stats.ino !== linkStats.ino) {
        throw new Error(`${label} path changed while being opened: ${path}`);
      }
      if (!stats.isFile()) {
        throw new Error(`${label} path is not a file: ${path}`);
      }
      if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
        throw new Error(`${label} size must be a non-negative safe integer: ${path}`);
      }
      if (stats.size > maxBytes) {
        throw new Error(`${label} is too large: ${path} is ${stats.size} bytes, maximum is ${maxBytes} bytes.`);
      }
      const expectedLength = Number(stats.size);
      await this.beforeReadBoundedTextContent(path, label);
      const buffer = new Uint8Array(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maxBytes) {
        throw new Error(`${label} is too large: ${path} exceeded maximum ${maxBytes} bytes while reading.`);
      }
      if (bytesRead !== expectedLength) {
        throw new Error(`${label} changed while being read: ${path}`);
      }
      await this.assertOpenedFileUnchanged(handle, stats, label, path);
      let text: string;
      try {
        text = decoder.decode(buffer.slice(0, bytesRead));
      } catch (error) {
        throw new Error(`${label} must be valid UTF-8: ${path}: ${errorMessage(error)}`);
      }
      if (MARKDOWN_TEXT_CONTROL_CHARS.test(text)) {
        throw new Error(`${label} must not contain non-printing control characters: ${path}`);
      }
      return text;
    } finally {
      await handle.close();
    }
  }

  protected async beforeReadBoundedTextContent(_path: string, _label: string): Promise<void> {
    return undefined;
  }

  private async assertOpenedFileUnchanged(handle: Awaited<ReturnType<typeof open>>, expected: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>, label: string, path: string): Promise<void> {
    const actual = await handle.stat();
    if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs) {
      throw new Error(`${label} changed while being read: ${path}`);
    }
  }

  private async writeBoundedText(path: string, content: string, maxBytes: number, label: string): Promise<void> {
    await this.writeFileAtomic(path, this.boundedTextContent(path, content, maxBytes, label));
  }

  private boundedTextContent(path: string, content: string, maxBytes: number, label: string): string {
    if (typeof content !== "string") {
      throw new Error(`${label} content for ${path} must be a string.`);
    }
    if (content.trim().length === 0) {
      throw new Error(`${label} content for ${path} must be non-empty after trimming.`);
    }
    if (MARKDOWN_TEXT_CONTROL_CHARS.test(content)) {
      throw new Error(`${label} content for ${path} must not contain non-printing control characters.`);
    }
    const bytes = utf8ByteLengthUpTo(content, maxBytes);
    if (bytes > maxBytes) {
      throw new Error(`${label} is too large to write: ${path} is ${bytes} bytes, maximum is ${maxBytes} bytes.`);
    }
    return content;
  }

  private async listSafeChildDirectories(dir: string): Promise<string[]> {
    this.assertInsideRoot(dir);
    if (!(await exists(dir))) {
      return [];
    }
    await this.assertRealPathInsideRoot(dir, `directory ${dir}`);
    const directories: string[] = [];
    for await (const name of this.readDirectoryNames(dir)) {
      if (!isSafeIdSegment(name)) {
        continue;
      }
      const entryPath = join(dir, name);
      try {
        const stats = await lstat(entryPath);
        if (stats.isDirectory()) {
          await this.assertRealPathInsideRoot(entryPath, `directory ${entryPath}`);
          directories.push(name);
        }
      } catch (error) {
        if (!isErrno(error, "ENOENT")) {
          throw error;
        }
        // Ignore entries that disappear while the directory is being scanned.
      }
      if (directories.length > MAX_SAFE_CHILD_DIRECTORIES) {
        throw new Error(`Directory ${dir} has too many safe child directories: maximum is ${MAX_SAFE_CHILD_DIRECTORIES}.`);
      }
    }
    return directories.sort();
  }

  private async *readDirectoryNames(dir: string): AsyncGenerator<string> {
    const directory = await opendir(dir);
    let scanned = 0;
    for await (const entry of directory) {
      scanned += 1;
      if (scanned > MAX_DIRECTORY_SCAN_ENTRIES) {
        throw new Error(`Directory ${dir} has too many entries: maximum is ${MAX_DIRECTORY_SCAN_ENTRIES}.`);
      }
      if (!isSupportedDirectoryEntryName(entry.name)) {
        continue;
      }
      yield entry.name;
    }
  }

  private validateStateForPath(value: unknown, franchiseId: string, workId: string, volumeId: string): VolumeState {
    const state = validateVolumeState(value);
    if (state.franchiseId !== franchiseId || state.workId !== workId || state.volumeId !== volumeId) {
      throw new Error(
        `VolumeState identity mismatch: expected ${franchiseId}/${workId}/${volumeId}, actual ${state.franchiseId}/${state.workId}/${state.volumeId}.`
      );
    }
    return state;
  }

  private validateCurrentPointer(value: unknown): { franchiseId: string; workId: string; volumeId: string } {
    const pointer = assertObject(value, "current pointer");
    assertKnownFields(pointer, "current pointer", ["franchiseId", "workId", "volumeId"]);
    return {
      franchiseId: assertSafeId(pointer.franchiseId, "current.franchiseId"),
      workId: assertSafeId(pointer.workId, "current.workId"),
      volumeId: assertSafeId(pointer.volumeId, "current.volumeId")
    };
  }

  private async readCurrentPointerWithBackup(path: string): Promise<{ franchiseId: string; workId: string; volumeId: string }> {
    let primary: unknown;
    try {
      primary = await this.readJson<unknown>(path);
    } catch (error) {
      const backupPath = this.currentPointerBackupPath();
      if (isRecoverableJsonPrimaryError(error) && await exists(backupPath)) {
        return this.readCurrentPointer(backupPath);
      }
      throw error;
    }
    return this.validateCurrentPointer(primary);
  }

  private insideRoot(...segments: string[]): string {
    const path = resolve(this.root, ...segments);
    this.assertInsideRoot(path);
    return path;
  }

  private assertInsideRoot(path: string): void {
    assertPathString(path, "Storage path");
    const resolved = resolve(path);
    if (resolved !== this.root && !resolved.startsWith(`${this.root}/`)) {
      throw new Error(`Path escapes storage root: ${path}`);
    }
  }

  private async mkdirInsideRoot(path: string): Promise<void> {
    this.assertInsideRoot(path);
    await this.ensureRootDirectory();
    if (resolve(path) === this.root) {
      await this.assertRealPathInsideRoot(path, `directory ${path}`);
      return;
    }
    await this.assertExistingAncestorInsideRoot(dirname(path), `parent directory for ${path}`);
    await mkdir(path, { recursive: true });
    await this.assertRealPathInsideRoot(path, `directory ${path}`);
  }

  private async assertExistingAncestorInsideRoot(path: string, label: string): Promise<void> {
    this.assertInsideRoot(path);
    await this.ensureRootDirectory();
    let current = resolve(path);
    for (;;) {
      try {
        await this.assertRealPathInsideRoot(current, label);
        return;
      } catch (error) {
        if (!isErrno(error, "ENOENT")) {
          throw error;
        }
        const parent = dirname(current);
        if (parent === current) {
          throw error;
        }
        current = parent;
      }
    }
  }

  private async assertRealPathInsideRoot(path: string, label: string): Promise<void> {
    this.assertInsideRoot(path);
    const realRoot = await realpath(this.root);
    const realTarget = await realpath(path);
    if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}/`)) {
      throw new Error(`${label} resolves outside storage root: ${path}`);
    }
  }

  private async ensureRootDirectory(): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
    }
    const stats = await stat(this.root);
    if (!stats.isDirectory()) {
      throw new Error(`Storage root is not a directory: ${this.root}`);
    }
  }

  private async withLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = this.insideRoot(".locks", assertSafeId(name, "lockName"));
    const lock = await this.acquireLock(lockPath);
    const stopHeartbeat = this.startLockHeartbeat(lockPath, lock);
    let operationError: unknown;
    try {
      return await operation();
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      await stopHeartbeat();
      try {
        await this.releaseLock(lockPath, lock);
      } catch (releaseError) {
        if (operationError === undefined) {
          throw releaseError;
        }
      }
    }
  }

  private async acquireLock(lockPath: string): Promise<LockHandle> {
    const startedAt = Date.now();
    await this.mkdirInsideRoot(dirname(lockPath));
    for (;;) {
      try {
        await this.assertExistingAncestorInsideRoot(dirname(lockPath), `parent directory for ${lockPath}`);
        await mkdir(lockPath);
      } catch (error) {
        await this.removeStaleLock(lockPath);
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new Error(`Timed out acquiring lock: ${lockPath}`);
        }
        await sleep(this.lockRetryMs);
        continue;
      }
      const token = randomUUID();
      try {
        const stats = await lstat(lockPath);
        if (!stats.isDirectory()) {
          throw new Error(`Lock path is not a directory: ${lockPath}`);
        }
        await this.writeLockOwner(lockPath, token);
        await this.assertLockDirectoryIdentity(lockPath, stats);
        return { token, dev: stats.dev, ino: stats.ino };
      } catch (error) {
        await rmdir(lockPath).catch(() => undefined);
        throw new Error(`Failed to initialize lock owner: ${errorMessage(error)}`);
      }
    }
  }

  private async removeStaleLock(lockPath: string): Promise<void> {
    try {
      const ownerPath = join(lockPath, "owner.json");
      const lockStats = await lstat(lockPath);
      const stats = lockStats.isDirectory()
        ? await lstat(ownerPath).catch(() => lockStats)
        : lockStats;
      if (Date.now() - stats.mtimeMs <= this.lockStaleMs) {
        if (!lockStats.isDirectory()) {
          throw new Error(`Lock path is not a directory: ${lockPath}`);
        }
        return;
      }
      if (lockStats.isSymbolicLink()) {
        await unlink(lockPath).catch(() => undefined);
        return;
      }
      if (!lockStats.isDirectory()) {
        await unlink(lockPath).catch(() => undefined);
        return;
      }
      await this.assertRealPathInsideRoot(lockPath, `lock directory ${lockPath}`);
      await rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Lock path is not a directory:")) {
        throw error;
      }
      return;
    }
  }

  private startLockHeartbeat(lockPath: string, lock: LockHandle): () => Promise<void> {
    let stopped = false;
    let timer: unknown;
    let inFlight: Promise<void> | undefined;
    const intervalMs = Math.max(10, Math.min(1000, Math.floor(this.lockStaleMs / 3)));
    const beat = async () => {
      if (stopped) {
        return;
      }
      inFlight = this.refreshLockOwner(lockPath, lock).catch(() => undefined);
      await inFlight;
      inFlight = undefined;
      if (!stopped) {
        timer = setTimeout(beat, intervalMs);
      }
    };
    timer = setTimeout(beat, intervalMs);
    return async () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (inFlight) {
        await inFlight;
      }
    };
  }

  private async refreshLockOwner(lockPath: string, lock: LockHandle): Promise<void> {
    const ownerPath = join(lockPath, "owner.json");
    const lockStats = await lstat(lockPath);
    if (!lockStats.isDirectory() || lockStats.dev !== lock.dev || lockStats.ino !== lock.ino) {
      return;
    }
    const ownerToken = parseLockOwnerToken(await this.readLockOwnerText(ownerPath));
    if (ownerToken !== lock.token) {
      return;
    }
    const now = new Date();
    await utimes(ownerPath, now, now);
  }

  private async writeLockOwner(lockPath: string, token: string): Promise<void> {
    const owner = snapshotJsonMetadataValue({ token, updatedAt: new Date().toISOString() }, "Lock owner file");
    await this.writeFileAtomicExistingDirectory(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`);
  }

  private async assertLockDirectoryIdentity(lockPath: string, expected: Awaited<ReturnType<typeof lstat>>): Promise<void> {
    const actual = await lstat(lockPath);
    if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new Error(`Lock directory changed while initializing owner: ${lockPath}`);
    }
  }

  private async releaseLock(lockPath: string, lock: LockHandle): Promise<void> {
    const ownerPath = join(lockPath, "owner.json");
    try {
      const lockStats = await lstat(lockPath);
      if (!lockStats.isDirectory() || lockStats.dev !== lock.dev || lockStats.ino !== lock.ino) {
        return;
      }
      const ownerToken = parseLockOwnerToken(await this.readLockOwnerText(ownerPath));
      if (ownerToken !== lock.token) {
        return;
      }
      await unlink(ownerPath).catch((error: unknown) => {
        if (!isErrno(error, "ENOENT")) {
          throw error;
        }
      });
      await rmdir(lockPath).catch((error: unknown) => {
        if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTEMPTY")) {
          throw error;
        }
      });
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        throw error;
      }
    }
  }

  private async readLockOwnerText(path: string): Promise<string> {
    return this.readBoundedText(path, MAX_LOCK_OWNER_FILE_BYTES, "Lock owner file");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, timeoutMsForTimer(ms));
  });
}

function timeoutMsForTimer(ms: number): number {
  return Math.min(ms, MAX_SET_TIMEOUT_MS);
}

function assertStorageRoot(value: string): string {
  if (!isAbsolute(value)) {
    throw new Error("Storage root must be an absolute path.");
  }
  const root = resolve(value);
  if (dirname(root) === root) {
    throw new Error("Storage root must not be the filesystem root.");
  }
  return root;
}

function stateWithStorageMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const prototype = safeGetPrototypeOf(value, "Storage state");
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of safeOwnKeys(value, "Storage state")) {
    if (typeof key !== "string") {
      return value;
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, "Storage state");
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      return value;
    }
    Object.defineProperty(output, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  Object.defineProperty(output, "schemaVersion", {
    value: CURRENT_STATE_SCHEMA_VERSION,
    enumerable: true,
    configurable: true,
    writable: true
  });
  Object.defineProperty(output, "updatedAt", {
    value: new Date().toISOString(),
    enumerable: true,
    configurable: true,
    writable: true
  });
  return output;
}

function normalizeStorageConfig(value: unknown): AppConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("NovelStorage config must be an object.");
  }
  validateStorageConfigObject(value as object);
  return {
    ...loadConfig(),
    lockTimeoutMs: readRequiredStorageConfigField(value as object, "lockTimeoutMs") as number,
    lockRetryMs: readRequiredStorageConfigField(value as object, "lockRetryMs") as number,
    lockStaleMs: readRequiredStorageConfigField(value as object, "lockStaleMs") as number,
    maxJobs: readRequiredStorageConfigField(value as object, "maxJobs") as number,
    storageRoot: readRequiredStorageConfigField(value as object, "storageRoot") as string,
    epubLanguage: readRequiredStorageConfigField(value as object, "epubLanguage") as string
  };
}

function validateStorageConfigObject(value: object): void {
  const prototype = safeGetPrototypeOf(value, "NovelStorage config");
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("NovelStorage config must be a plain object.");
  }
  for (const key of safeOwnKeys(value, "NovelStorage config")) {
    if (typeof key !== "string") {
      throw new Error("NovelStorage config must not contain symbol properties.");
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, "NovelStorage config");
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`NovelStorage.${key} must be an enumerable data property.`);
    }
  }
}

function readRequiredStorageConfigField(value: object, key: keyof AppConfig): unknown {
  const field = readOptionalStorageConfigField(value, key);
  if (field === undefined) {
    throw new Error(`NovelStorage.${key} is required.`);
  }
  return field;
}

function readOptionalStorageConfigField(value: object, key: keyof AppConfig): unknown {
  const descriptor = safeGetOwnPropertyDescriptor(value, key, "NovelStorage config");
  if (!descriptor) {
    return undefined;
  }
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new Error(`NovelStorage.${key} must be an enumerable data property.`);
  }
  return descriptor.value;
}

function assertPathString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (value.length > MAX_STORAGE_PATH_CHARS) {
    throw new Error(`${label} must be at most ${MAX_STORAGE_PATH_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(value, MAX_STORAGE_PATH_BYTES) > MAX_STORAGE_PATH_BYTES) {
    throw new Error(`${label} must be at most ${MAX_STORAGE_PATH_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must not contain control characters.`);
  }
}

function assertWritableContent(value: unknown, label: string): asserts value is string | Uint8Array {
  if (typeof value !== "string" && !isWritableUint8Array(value, label)) {
    throw new Error(`${label} must be a string or Uint8Array.`);
  }
  const byteLength = typeof value === "string" ? boundedUtf8ByteLength(value, label) : writableUint8ArrayByteLength(value, label);
  if (byteLength > MAX_ATOMIC_WRITE_BYTES) {
    throw new Error(`${label} must be at most ${MAX_ATOMIC_WRITE_BYTES} bytes.`);
  }
}

function snapshotWritableContent(value: string | Uint8Array, label: string): string | Uint8Array {
  if (typeof value === "string") {
    return value;
  }
  try {
    return new Uint8Array(value);
  } catch {
    throw new Error(`${label} must be snapshot-readable.`);
  }
}

function isWritableUint8Array(value: unknown, label: string): value is Uint8Array {
  try {
    return value instanceof Uint8Array;
  } catch {
    throw new Error(`${label} Uint8Array prototype must be readable.`);
  }
}

function writableUint8ArrayByteLength(value: Uint8Array, label: string): number {
  try {
    return value.byteLength;
  } catch {
    throw new Error(`${label} Uint8Array byteLength must be readable.`);
  }
}

function boundedUtf8ByteLength(value: string, label: string): number {
  if (value.length > MAX_ATOMIC_WRITE_BYTES) {
    throw new Error(`${label} must be at most ${MAX_ATOMIC_WRITE_BYTES} bytes.`);
  }
  return utf8ByteLengthUpTo(value, MAX_ATOMIC_WRITE_BYTES);
}

export async function exists(path: string): Promise<boolean> {
  assertPathString(path, "exists path");
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertLockOperation(value: unknown): asserts value is () => Promise<unknown> {
  if (typeof value !== "function") {
    throw new Error("Volume lock operation must be a function.");
  }
}

export function slugify(value: string): string {
  if (typeof value !== "string") {
    throw new Error("slugify value must be a string.");
  }
  if (value.length > MAX_SLUG_INPUT_CHARS) {
    throw new Error(`slugify value must be at most ${MAX_SLUG_INPUT_CHARS} characters.`);
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return `item-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
  }
  if (utf8ByteLengthUpTo(normalized, MAX_SAFE_ID_BYTES) <= MAX_SAFE_ID_BYTES) {
    return normalized;
  }
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 16);
  const prefixBudget = MAX_SAFE_ID_BYTES - suffix.length - 1;
  const prefix = truncateUtf8(normalized, prefixBudget).replace(/[-._]+$/g, "");
  return `${prefix || "item"}-${suffix}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let output = "";
  let used = 0;
  for (const char of value) {
    const bytes = utf8ByteLength(char);
    if (used + bytes > maxBytes) {
      break;
    }
    output += char;
    used += bytes;
  }
  return output;
}

function hashIdParts(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

function isErrno(error: unknown, code: string): boolean {
  if (!error || (typeof error !== "object" && typeof error !== "function")) {
    return false;
  }
  let current: object | null = error;
  while (current) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = safeGetOwnPropertyDescriptor(current, "code", "Storage errno");
    } catch {
      return false;
    }
    if (descriptor) {
      return "value" in descriptor && descriptor.value === code;
    }
    try {
      current = safeGetPrototypeOf(current, "Storage errno");
    } catch {
      return false;
    }
  }
  return false;
}

function isRecoverableJsonPrimaryError(error: unknown): boolean {
  if (isErrno(error, "ENOENT")) {
    return true;
  }
  const message = errorMessage(error);
  return (
    message.includes("JSON metadata file must contain valid JSON") ||
    message.includes("JSON metadata file must be valid UTF-8") ||
    message.includes("JSON metadata file must not contain non-printing control characters") ||
    message.includes("JSON metadata file is too large") ||
    message.includes("JSON metadata file must contain at most") ||
    message.includes("JSON metadata file must be nested at most") ||
    message.includes("JSON metadata file object keys must") ||
    /^JSON metadata file\.[\s\S]* must be at most/u.test(message) ||
    /^JSON metadata file\.[\s\S]* must not contain control characters/u.test(message)
  );
}

function parseJsonMetadataText<T = unknown>(text: string, path: string): T {
  let parsed: unknown;
  try {
    assertNoDuplicateJsonObjectKeys(text, "JSON metadata file", MAX_JSON_VALUE_DEPTH);
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`JSON metadata file must contain valid JSON: ${path}: ${errorMessage(error)}`);
  }
  validateJsonMetadataValue(parsed, "JSON metadata file");
  return parsed as T;
}

function assertIntegerInRange(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer.`);
  }
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

function parseLockOwnerToken(text: string): string | undefined {
  let owner: unknown;
  try {
    assertNoDuplicateJsonObjectKeys(text, "Lock owner file", MAX_JSON_VALUE_DEPTH);
    owner = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Lock owner file must contain valid JSON: ${errorMessage(error)}`);
  }
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
    throw new Error("Lock owner file must contain a JSON object.");
  }
  const prototype = safeGetPrototypeOf(owner, "Lock owner file");
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Lock owner file must contain a plain JSON object.");
  }
  assertKnownFields(owner as Record<string, unknown>, "Lock owner file", ["token", "updatedAt"]);
  for (const key of safeOwnKeys(owner, "Lock owner file")) {
    if (typeof key !== "string") {
      throw new Error("Lock owner file must not contain symbol properties.");
    }
    const fieldDescriptor = safeGetOwnPropertyDescriptor(owner, key, "Lock owner file");
    if (!fieldDescriptor?.enumerable || !("value" in fieldDescriptor)) {
      throw new Error(`Lock owner file ${key} must be an enumerable data property.`);
    }
  }
  const updatedAtDescriptor = safeGetOwnPropertyDescriptor(owner, "updatedAt", "Lock owner file");
  if (updatedAtDescriptor !== undefined) {
    if (!updatedAtDescriptor.enumerable || !("value" in updatedAtDescriptor)) {
      throw new Error("Lock owner file updatedAt must be an enumerable data property.");
    }
    if (typeof updatedAtDescriptor.value !== "string" || !isCanonicalUtcTimestamp(updatedAtDescriptor.value)) {
      throw new Error("Lock owner file updatedAt must be an ISO timestamp string when provided.");
    }
  }
  const descriptor = safeGetOwnPropertyDescriptor(owner, "token", "Lock owner file");
  if (!descriptor) {
    return undefined;
  }
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new Error("Lock owner file token must be an enumerable data property.");
  }
  if (descriptor.value !== undefined && typeof descriptor.value !== "string") {
    throw new Error("Lock owner file token must be a string when provided.");
  }
  if (typeof descriptor.value === "string" && descriptor.value.trim().length === 0) {
    throw new Error("Lock owner file token must be non-empty when provided.");
  }
  if (typeof descriptor.value === "string" && descriptor.value.length > MAX_LOCK_OWNER_TOKEN_CHARS) {
    throw new Error(`Lock owner file token must be at most ${MAX_LOCK_OWNER_TOKEN_CHARS} characters.`);
  }
  if (typeof descriptor.value === "string" && /[\u0000-\u001f\u007f]/u.test(descriptor.value)) {
    throw new Error("Lock owner file token must not contain control characters.");
  }
  return descriptor.value;
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

function errorMessage(error: unknown): string {
  const redacted = redactErrorMessage(error).replace(STORAGE_ERROR_CONTROL_CHARS_GLOBAL, " ");
  if (redacted.length <= MAX_STORAGE_ERROR_CHARS && utf8ByteLengthUpTo(redacted, MAX_STORAGE_ERROR_BYTES) <= MAX_STORAGE_ERROR_BYTES) {
    return redacted;
  }
  if (redacted.length > MAX_STORAGE_ERROR_CHARS) {
    const candidate = `${redacted.slice(0, MAX_STORAGE_ERROR_CHARS)}... [truncated ${redacted.length - MAX_STORAGE_ERROR_CHARS} chars]`;
    if (utf8ByteLengthUpTo(candidate, MAX_STORAGE_ERROR_BYTES) <= MAX_STORAGE_ERROR_BYTES) {
      return candidate;
    }
  }
  return truncateStorageErrorByBytes(redacted);
}

function truncateStorageErrorByBytes(value: string): string {
  const marker = `... [truncated ${Math.max(0, utf8ByteLength(value) - MAX_STORAGE_ERROR_BYTES)} UTF-8 bytes]`;
  let output = "";
  for (const char of value) {
    const next = `${output}${char}`;
    if (utf8ByteLengthUpTo(`${next}${marker}`, MAX_STORAGE_ERROR_BYTES) > MAX_STORAGE_ERROR_BYTES) {
      break;
    }
    output = next;
  }
  return `${output}${marker}`;
}

function validateJsonMetadataValue(value: unknown, label: string, options: { validateNumbers?: boolean } = {}): void {
  snapshotJsonMetadataValue(value, label, options);
}

function snapshotJsonMetadataValue(value: unknown, label: string, options: { validateNumbers?: boolean } = {}): unknown {
  const validateNumbers = options.validateNumbers ?? true;
  const stack = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown, currentLabel: string, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_JSON_TOTAL_NODES) {
      throw new Error(`${label} must contain at most ${MAX_JSON_TOTAL_NODES} JSON values.`);
    }
    if (depth > MAX_JSON_VALUE_DEPTH) {
      throw new Error(`${currentLabel} must be nested at most ${MAX_JSON_VALUE_DEPTH} levels deep.`);
    }
    if (current === undefined) {
      throw new Error(`${currentLabel} must not be undefined.`);
    }
    if (validateNumbers && typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new Error(`${currentLabel} must be a finite number.`);
      }
      if (Number.isInteger(current) && !Number.isSafeInteger(current)) {
        throw new Error(`${currentLabel} must be a safe integer.`);
      }
    }
    if (typeof current === "string") {
      if (current.length > MAX_JSON_STRING_CHARS) {
        throw new Error(`${currentLabel} must be at most ${MAX_JSON_STRING_CHARS} characters.`);
      }
      if (utf8ByteLengthUpTo(current, MAX_JSON_STRING_BYTES) > MAX_JSON_STRING_BYTES) {
        throw new Error(`${currentLabel} must be at most ${MAX_JSON_STRING_BYTES} UTF-8 bytes.`);
      }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(current)) {
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
      if (current.length > MAX_JSON_ARRAY_ITEMS) {
        throw new Error(`${currentLabel} must contain at most ${MAX_JSON_ARRAY_ITEMS} array items.`);
      }
      assertJsonArrayDataProperties(current, currentLabel);
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
      Object.setPrototypeOf(output, null);
      return output;
    }
    const prototype = safeGetPrototypeOf(current, currentLabel);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${currentLabel} must be a plain JSON object.`);
    }
    const entries = jsonDataObjectEntries(current, currentLabel);
    if (entries.length > MAX_JSON_OBJECT_FIELDS) {
      throw new Error(`${currentLabel} must contain at most ${MAX_JSON_OBJECT_FIELDS} object fields.`);
    }
    const output = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of entries) {
      if (key.length > MAX_JSON_OBJECT_KEY_CHARS) {
        throw new Error(`${currentLabel} object keys must be at most ${MAX_JSON_OBJECT_KEY_CHARS} characters.`);
      }
      if (utf8ByteLengthUpTo(key, MAX_JSON_OBJECT_KEY_BYTES) > MAX_JSON_OBJECT_KEY_BYTES) {
        throw new Error(`${currentLabel} object keys must be at most ${MAX_JSON_OBJECT_KEY_BYTES} UTF-8 bytes.`);
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

function assertJsonArrayDataProperties(value: unknown[], label: string): void {
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

function jsonDataObjectEntries(value: object, label: string): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const key of safeOwnKeys(value, label)) {
    if (typeof key !== "string") {
      throw new Error(`${label} must not contain symbol properties.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, label);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} must not contain non-enumerable or accessor properties.`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function isArrayIndexKey(value: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    return false;
  }
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === value;
}

function assertKnownFields(value: Record<string, unknown>, label: string, allowed: string[]): void {
  const allowedFields = new Set(allowed);
  for (const key of safeOwnKeys(value, label)) {
    if (typeof key !== "string") {
      throw new Error(`${label} must not contain symbol properties.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, label);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} must not contain non-enumerable or accessor properties.`);
    }
    if (!allowedFields.has(key)) {
      throw new Error(`${label}.${key} is not a supported field.`);
    }
  }
}

function isSafeIdSegment(value: string): boolean {
  try {
    assertSafeId(value, "pathSegment");
    return true;
  } catch {
    return false;
  }
}

function isSupportedDirectoryEntryName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_DIRECTORY_ENTRY_NAME_CHARS &&
    utf8ByteLengthUpTo(value, MAX_DIRECTORY_ENTRY_NAME_BYTES) <= MAX_DIRECTORY_ENTRY_NAME_BYTES &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

interface BeatMarkdownExpectation {
  franchiseId: string;
  workId: string;
  volumeId: string;
  chapterNo: number;
  beatNo: number;
}

function beatMarkdownBody(markdown: string, expected: BeatMarkdownExpectation): string {
  if (!markdown.startsWith("---\n")) {
    throw new Error(`Beat markdown frontmatter is missing: chapter=${expected.chapterNo}, beat=${expected.beatNo}`);
  }
  const end = markdown.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error(`Beat markdown frontmatter is malformed: chapter=${expected.chapterNo}, beat=${expected.beatNo}`);
  }
  const header = markdown.slice(4, end);
  if (header.length > MAX_MARKDOWN_FRONTMATTER_CHARS) {
    throw new Error(`Beat markdown frontmatter is too large: chapter=${expected.chapterNo}, beat=${expected.beatNo}, maximum=${MAX_MARKDOWN_FRONTMATTER_CHARS} characters`);
  }
  if (utf8ByteLengthUpTo(header, MAX_MARKDOWN_FRONTMATTER_BYTES) > MAX_MARKDOWN_FRONTMATTER_BYTES) {
    throw new Error(`Beat markdown frontmatter is too large: chapter=${expected.chapterNo}, beat=${expected.beatNo}, maximum=${MAX_MARKDOWN_FRONTMATTER_BYTES} UTF-8 bytes`);
  }
  const frontmatter = parseFrontmatter(header, expected);
  assertKnownFields(frontmatter, `Beat markdown frontmatter: chapter=${expected.chapterNo}, beat=${expected.beatNo}`, [
    "franchiseId",
    "workId",
    "volumeId",
    "chapterNo",
    "beatNo"
  ]);
  assertFrontmatterField(frontmatter, "franchiseId", expected.franchiseId, expected);
  assertFrontmatterField(frontmatter, "workId", expected.workId, expected);
  assertFrontmatterField(frontmatter, "volumeId", expected.volumeId, expected);
  assertFrontmatterField(frontmatter, "chapterNo", expected.chapterNo, expected);
  assertFrontmatterField(frontmatter, "beatNo", expected.beatNo, expected);
  const body = markdown.slice(end + "\n---\n".length).trim();
  if (!body) {
    throw new Error(`Beat markdown body is empty: chapter=${expected.chapterNo}, beat=${expected.beatNo}`);
  }
  return body;
}

function parseFrontmatter(header: string, expected: BeatMarkdownExpectation): Record<string, unknown> {
  const parsed: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const lines = header.split("\n");
  if (lines.length > MAX_MARKDOWN_FRONTMATTER_FIELDS) {
    throw new Error(`Beat markdown frontmatter has too many fields: chapter=${expected.chapterNo}, beat=${expected.beatNo}, maximum=${MAX_MARKDOWN_FRONTMATTER_FIELDS}`);
  }
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new Error(`Beat markdown frontmatter is malformed: chapter=${expected.chapterNo}, beat=${expected.beatNo}`);
    }
    const key = line.slice(0, separator).trim();
    frontmatterKey(key, `Beat markdown frontmatter: chapter=${expected.chapterNo}, beat=${expected.beatNo}`);
    const rawValue = line.slice(separator + 1).trim();
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      throw new Error(`Beat markdown frontmatter has duplicate field: chapter=${expected.chapterNo}, beat=${expected.beatNo}, field=${key}`);
    }
    let parsedValue: unknown;
    try {
      assertNoDuplicateJsonObjectKeys(rawValue, `Beat markdown frontmatter field ${key}`, MAX_JSON_VALUE_DEPTH);
      parsedValue = JSON.parse(rawValue) as unknown;
    } catch (error) {
      throw new Error(`Beat markdown frontmatter is malformed: chapter=${expected.chapterNo}, beat=${expected.beatNo}, field=${key}: ${errorMessage(error)}`);
    }
    validateParsedFrontmatterValue(parsedValue, key, expected);
    try {
      Object.defineProperty(parsed, key, {
        value: parsedValue,
        enumerable: true,
        configurable: true,
        writable: true
      });
    } catch {
      throw new Error(`Beat markdown frontmatter is malformed: chapter=${expected.chapterNo}, beat=${expected.beatNo}, field=${key}`);
    }
  }
  return parsed;
}

function validateParsedFrontmatterValue(value: unknown, key: string, expected: BeatMarkdownExpectation): void {
  if (typeof value === "string") {
    if (/[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error(`Beat markdown frontmatter field must not contain control characters: chapter=${expected.chapterNo}, beat=${expected.beatNo}, field=${key}`);
    }
    return;
  }
  if (typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Beat markdown frontmatter field must be finite: chapter=${expected.chapterNo}, beat=${expected.beatNo}, field=${key}`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`Beat markdown frontmatter field must be a safe integer: chapter=${expected.chapterNo}, beat=${expected.beatNo}, field=${key}`);
    }
    return;
  }
  const actualType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  throw new Error(
    `Beat markdown frontmatter field has unsupported value type: chapter=${expected.chapterNo}, beat=${expected.beatNo}, field=${key}, actualType=${actualType}`
  );
}

function frontmatterKey(key: string, label: string): string {
  if (key.length > MAX_MARKDOWN_FRONTMATTER_KEY_CHARS) {
    throw new Error(`${label}.${key || "<empty>"} must be at most ${MAX_MARKDOWN_FRONTMATTER_KEY_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(key, MAX_MARKDOWN_FRONTMATTER_KEY_BYTES) > MAX_MARKDOWN_FRONTMATTER_KEY_BYTES) {
    throw new Error(`${label}.${key || "<empty>"} must be at most ${MAX_MARKDOWN_FRONTMATTER_KEY_BYTES} UTF-8 bytes.`);
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || key === "constructor" || key === "prototype") {
    throw new Error(`${label}.${key || "<empty>"} is not a supported frontmatter field name.`);
  }
  return key;
}

function markdownFrontmatterEntries(frontmatter: Record<string, unknown>, label: string): Array<[string, unknown]> {
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error(`${label} must be a plain object.`);
  }
  const prototype = safeGetPrototypeOf(frontmatter, label);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of safeOwnKeys(frontmatter, label)) {
    if (typeof key !== "string") {
      throw new Error(`${label} must not contain symbol properties.`);
    }
    if (entries.length >= MAX_MARKDOWN_FRONTMATTER_FIELDS) {
      throw new Error(`${label} has too many fields: maximum is ${MAX_MARKDOWN_FRONTMATTER_FIELDS}.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(frontmatter, key, label);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} must not contain non-enumerable or accessor properties.`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function frontmatterValue(value: unknown, key: string, path: string): string | number | boolean {
  if (typeof value === "string") {
    if (/[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error(`Markdown frontmatter for ${path}.${key} must not contain control characters.`);
    }
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Markdown frontmatter for ${path}.${key} must be a finite number.`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`Markdown frontmatter for ${path}.${key} must be a safe integer.`);
    }
    return value;
  }
  throw new Error(`Markdown frontmatter for ${path}.${key} must be a string, finite number, or boolean.`);
}

function assertPositivePathIndex(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_BEAT_PATH_INDEX) {
    throw new Error(`${label} must be an integer between 1 and ${MAX_BEAT_PATH_INDEX}.`);
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function assertDeclaredBeat(state: VolumeState, chapterNo: number, beatNo: number): void {
  const safeChapterNo = assertPositivePathIndex(chapterNo, "chapterNo");
  const safeBeatNo = assertPositivePathIndex(beatNo, "beatNo");
  const declared = state.chapters.some((chapter) =>
    chapter.chapterNo === safeChapterNo && chapter.beats.some((beat) => beat.beatNo === safeBeatNo)
  );
  if (!declared) {
    throw new Error(`Beat is not declared in volume state: chapter=${safeChapterNo}, beat=${safeBeatNo}.`);
  }
}

function assertFrontmatterField(frontmatter: Record<string, unknown>, field: keyof BeatMarkdownExpectation, expectedValue: string | number, expected: BeatMarkdownExpectation): void {
  const actual = frontmatter[field];
  if (typeof actual !== typeof expectedValue) {
    throw new Error(
      `Beat markdown frontmatter field has invalid type: chapter=${expected.chapterNo}, beat=${expected.beatNo}, field=${field}, expectedType=${typeof expectedValue}, actualType=${typeof actual}`
    );
  }
  if (actual !== expectedValue) {
    throw new Error(
      `Beat markdown frontmatter mismatch: chapter=${expected.chapterNo}, beat=${expected.beatNo}, field=${field}, expected=${String(expectedValue)}, actual=${boundedDiagnosticValue(actual)}`
    );
  }
}

function boundedDiagnosticValue(value: unknown): string {
  const text = String(value).replace(STORAGE_ERROR_CONTROL_CHARS_GLOBAL, " ");
  const maxChars = 200;
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}
