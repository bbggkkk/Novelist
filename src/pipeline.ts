import { dirname, isAbsolute, resolve } from "node:path";
import { buildEpubArchive, validateEpubArchive } from "./epub.js";
import { ExecutionDeadline, type ExecutionSignal } from "./execution.js";
import { runExternalEpubCheck } from "./externalEpubCheck.js";
import { redactErrorMessage } from "./redaction.js";
import { NovelStorage, slugify } from "./storage.js";
import {
  assertBoundedNonEmptyString,
  assertBoundedNonEmptySingleLineString,
  assertObject,
  assertSafeId,
  assertShape,
  asOptionalBoundedSingleLineString
} from "./validation.js";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import type {
  BuildEpubInput,
  ChapterState,
  ConsistencyReport,
  OutlineChapterInput,
  PipelinePhase,
  StartInput,
  ToolResult,
  VolumeState,
  WorldScope,
  SettingScope
} from "./types.js";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  HEALTH_AGENT_PROVIDER,
  HEALTH_STORAGE_ROOT_HASH,
  MAX_INSTRUCTION_INPUT_CHARS,
  MAX_OPTION_INPUT_CHARS,
  MAX_TITLE_INPUT_CHARS
} from "./constants.js";
import { validateVolumeState } from "./stateValidation.js";
import { utf8ByteLengthUpTo } from "./utf8.js";

const MAX_TITLE_INPUT_BYTES = 512;
const MAX_OPTION_INPUT_BYTES = 256;
const MAX_INSTRUCTION_INPUT_BYTES = 16 * 1024;
const MAX_DOCUMENT_CHARS = 1024 * 1024;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_SUMMARY_TEXT_CHARS = 1000;
const MAX_SUMMARY_TEXT_BYTES = 4000;
const PIPELINE_ERROR_CONTROL_CHARS_GLOBAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

type LocatorInput = { franchiseId?: string; workId?: string; volumeId?: string; current?: boolean };
type SubmitWorldInput = { franchiseId?: string; workId?: string; volumeId?: string; current?: boolean; scope?: WorldScope; text: string; consistencyReport: ConsistencyReport };
type SubmitSettingInput = { franchiseId?: string; workId?: string; volumeId?: string; current?: boolean; scope?: SettingScope; text: string; consistencyReport: ConsistencyReport };
type SubmitOutlineInput = { franchiseId?: string; workId?: string; volumeId?: string; current?: boolean; text: string; chapters: OutlineChapterInput[]; consistencyReport: ConsistencyReport };
type SubmitBeatInput = { franchiseId?: string; workId?: string; volumeId?: string; current?: boolean; chapterNo?: number; beatNo?: number; text: string; consistencyReport: ConsistencyReport };
type SaveBeatDraftInput = { franchiseId?: string; workId?: string; volumeId?: string; current?: boolean; chapterNo?: number; beatNo?: number; text: string };
type RewriteBeatInput = { franchiseId?: string; workId?: string; volumeId?: string; current?: boolean; chapterNo: number; beatNo: number; text: string; consistencyReport: ConsistencyReport };
type StartVolumeInput = { franchiseId: string; workId: string; volumeRequest: string; franchiseName?: string; workTitle?: string };

const PHASE_ORDER: PipelinePhase[] = [
  "franchise_world",
  "franchise_setting",
  "work_world",
  "work_setting",
  "volume_world",
  "volume_setting",
  "volume_outline",
  "writing",
  "epub",
  "complete"
];

export class NovelPipeline {
  private readonly storage: NovelStorage;
  private readonly config: AppConfig;

  constructor(storage = new NovelStorage(), config: AppConfig = loadConfig()) {
    this.storage = storage;
    this.config = config;
  }

  async start(input: StartInput, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      new ExecutionDeadline(this.config.operationTimeoutMs, signal).assertActive("starting the pipeline");
      const parsed = parseStartInput(input);
      const franchiseId = slugify(parsed.franchiseName);
      const workTitle = parsed.workRequest;
      const workId = slugify(workTitle);
      const volumeTitle = parsed.volumeRequest || `${workTitle} 1권`;
      const volumeId = slugify(volumeTitle);
      return this.storage.withCreationLock(franchiseId, workId, volumeId, async () => {
        if (await this.storage.stateExists(franchiseId, workId, volumeId)) {
          const existing = await this.storage.loadState(franchiseId, workId, volumeId);
          await this.ensurePhaseForExistingArtifacts(existing);
          return nextResult(existing, await this.contextForPhase(existing));
        }
        const now = new Date().toISOString();
        const state = validateVolumeState({
          schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
          franchiseId,
          franchiseName: parsed.franchiseName,
          workId,
          workTitle,
          volumeId,
          volumeTitle,
          phase: "franchise_world",
          flowStatus: "needs_input",
          currentChapterNo: 1,
          currentBeatNo: 1,
          chapters: [],
          createdAt: now,
          updatedAt: now
        });
        await this.ensurePhaseForExistingArtifacts(state);
        await this.storage.saveState(state);
        return nextResult(state, await this.contextForPhase(state));
      });
    });
  }

  async next(input: LocatorInput = {}, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      new ExecutionDeadline(this.config.operationTimeoutMs, signal).assertActive("advancing the pipeline");
      const resolved = await this.resolveState(parseLocatorInput(input));
      return this.storage.withVolumeLock(resolved.franchiseId, resolved.workId, resolved.volumeId, async () => {
        const state = await this.storage.loadState(resolved.franchiseId, resolved.workId, resolved.volumeId);
        await this.ensurePhaseForExistingArtifacts(state);
        await this.storage.saveState(state);
        return nextResult(state, await this.contextForPhase(state));
      });
    });
  }

  async startVolume(input: StartVolumeInput, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      new ExecutionDeadline(this.config.operationTimeoutMs, signal).assertActive("starting a volume");
      const parsed = parseStartVolumeInput(input);
      const volumeTitle = parsed.volumeRequest;
      const volumeId = slugify(volumeTitle);
      return this.storage.withCreationLock(parsed.franchiseId, parsed.workId, volumeId, async () => {
        if (await this.storage.stateExists(parsed.franchiseId, parsed.workId, volumeId)) {
          const existing = await this.storage.loadState(parsed.franchiseId, parsed.workId, volumeId);
          await this.ensurePhaseForExistingArtifacts(existing);
          return nextResult(existing, await this.contextForPhase(existing));
        }
        const base = await this.existingWorkIdentity(parsed.franchiseId, parsed.workId, parsed.franchiseName, parsed.workTitle);
        const now = new Date().toISOString();
        const state = validateVolumeState({
          schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
          franchiseId: parsed.franchiseId,
          franchiseName: base.franchiseName,
          workId: parsed.workId,
          workTitle: base.workTitle,
          volumeId,
          volumeTitle,
          phase: "volume_world",
          flowStatus: "needs_input",
          currentChapterNo: 1,
          currentBeatNo: 1,
          chapters: [],
          createdAt: now,
          updatedAt: now
        });
        await this.requireWorkFoundation(state);
        await this.storage.saveState(state);
        return nextResult(state, await this.contextForPhase(state));
      });
    });
  }

  async submitWorld(input: SubmitWorldInput, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      new ExecutionDeadline(this.config.operationTimeoutMs, signal).assertActive("submitting world document");
      const parsed = parseSubmitWorldInput(input);
      const resolved = await this.resolveState(parsed);
      return this.storage.withVolumeLock(resolved.franchiseId, resolved.workId, resolved.volumeId, async () => {
        const state = await this.storage.loadState(resolved.franchiseId, resolved.workId, resolved.volumeId);
        const scope = worldScopeForPhase(state.phase);
        if (!scope || state.flowStatus !== "needs_input" || (parsed.scope && parsed.scope !== scope)) {
          throw new Error(`Current phase does not accept world submission: phase=${state.phase}, status=${state.flowStatus}.`);
        }
        return this.acceptScopedDocument(state, scope, "world", parsed.text, parsed.consistencyReport);
      });
    });
  }

  async finalizeWorld(input: LocatorInput = {}, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.finalizeScopedDocument(input, "world", signal);
  }

  async submitSetting(input: SubmitSettingInput, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      new ExecutionDeadline(this.config.operationTimeoutMs, signal).assertActive("submitting setting document");
      const parsed = parseSubmitSettingInput(input);
      const resolved = await this.resolveState(parsed);
      return this.storage.withVolumeLock(resolved.franchiseId, resolved.workId, resolved.volumeId, async () => {
        const state = await this.storage.loadState(resolved.franchiseId, resolved.workId, resolved.volumeId);
        const scope = settingScopeForPhase(state.phase);
        if (!scope || state.flowStatus !== "needs_input" || (parsed.scope && parsed.scope !== scope)) {
          throw new Error(`Current phase does not accept setting submission: phase=${state.phase}, status=${state.flowStatus}.`);
        }
        return this.acceptScopedDocument(state, scope, "setting", parsed.text, parsed.consistencyReport);
      });
    });
  }

  async finalizeSetting(input: LocatorInput = {}, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.finalizeScopedDocument(input, "setting", signal);
  }

  async submitOutline(input: SubmitOutlineInput, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      new ExecutionDeadline(this.config.operationTimeoutMs, signal).assertActive("submitting outline");
      const parsed = parseSubmitOutlineInput(input);
      const resolved = await this.resolveState(parsed);
      return this.storage.withVolumeLock(resolved.franchiseId, resolved.workId, resolved.volumeId, async () => {
        const state = await this.storage.loadState(resolved.franchiseId, resolved.workId, resolved.volumeId);
        if (state.phase !== "volume_outline" || state.flowStatus !== "needs_input") {
          throw new Error(`Current phase does not accept outline submission: phase=${state.phase}, status=${state.flowStatus}.`);
        }
        if (!parsed.consistencyReport.ok) {
          state.lastConsistencyFailure = { phase: state.phase, submittedAt: new Date().toISOString(), report: parsed.consistencyReport };
          state.updatedAt = new Date().toISOString();
          await this.storage.saveState(state);
          return nextResult(state, await this.contextForPhase(state));
        }
        state.chapters = outlineChapters(parsed.chapters);
        state.currentChapterNo = 1;
        state.currentBeatNo = 1;
        state.lastConsistencyFailure = undefined;
        await this.storage.writeOutline(state, parsed.text);
        setPhase(state, "volume_outline", "pending_finalization");
        await this.storage.saveState(state);
        return nextResult(state, await this.contextForPhase(state));
      });
    });
  }

  async finalizeOutline(input: LocatorInput = {}, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      new ExecutionDeadline(this.config.operationTimeoutMs, signal).assertActive("finalizing outline");
      const resolved = await this.resolveState(parseLocatorInput(input));
      return this.storage.withVolumeLock(resolved.franchiseId, resolved.workId, resolved.volumeId, async () => {
        const state = await this.storage.loadState(resolved.franchiseId, resolved.workId, resolved.volumeId);
        if (state.phase !== "volume_outline" || state.flowStatus !== "pending_finalization") {
          throw new Error(`Current phase does not accept outline finalization: phase=${state.phase}, status=${state.flowStatus}.`);
        }
        if (state.chapters.length === 0) throw new Error("Outline finalization requires at least one chapter.");
        setPhase(state, "writing", "needs_input");
        await this.storage.saveState(state);
        return nextResult(state, await this.contextForPhase(state));
      });
    });
  }

  async submitBeat(input: SubmitBeatInput, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      new ExecutionDeadline(this.config.operationTimeoutMs, signal).assertActive("submitting beat");
      const parsed = parseSubmitBeatInput(input);
      const resolved = await this.resolveState(parsed);
      return this.storage.withVolumeLock(resolved.franchiseId, resolved.workId, resolved.volumeId, async () => {
        const state = await this.storage.loadState(resolved.franchiseId, resolved.workId, resolved.volumeId);
        if (state.phase !== "writing" || state.flowStatus !== "needs_input") {
          throw new Error(`Current phase does not accept beat submission: phase=${state.phase}, status=${state.flowStatus}.`);
        }
        const beat = findCurrentBeat(state);
        if (!beat) {
          setPhase(state, "epub", "ready");
          await this.storage.saveState(state);
          return nextResult(state, await this.contextForPhase(state));
        }
        if ((parsed.chapterNo && parsed.chapterNo !== beat.chapterNo) || (parsed.beatNo && parsed.beatNo !== beat.beatNo)) {
          throw new Error(`Current beat mismatch: expected chapter=${beat.chapterNo}, beat=${beat.beatNo}.`);
        }
        if (!parsed.consistencyReport.ok) {
          state.lastConsistencyFailure = { phase: state.phase, submittedAt: new Date().toISOString(), report: parsed.consistencyReport };
          state.updatedAt = new Date().toISOString();
          await this.storage.saveState(state);
          return nextResult(state, await this.contextForPhase(state));
        }
        const previous = cloneVolumeState(state);
        const previousBeatFile = await this.storage.readBeatFile(state, beat.chapterNo, beat.beatNo);
        const beatPath = await this.storage.writeBeat(state, beat.chapterNo, beat.beatNo, parsed.text);
        beat.status = "complete";
        state.lastConsistencyFailure = undefined;
        advanceCursor(state);
        setPhase(state, findCurrentBeat(state) ? "writing" : "epub", findCurrentBeat(state) ? "needs_input" : "ready");
        try {
          await this.storage.saveState(state);
        } catch (error) {
          if (previousBeatFile === undefined) await this.storage.deleteBeat(previous, beat.chapterNo, beat.beatNo);
          else await this.storage.writeBeatFile(previous, beat.chapterNo, beat.beatNo, previousBeatFile);
          throw error;
        }
        return { status: state.flowStatus, message: "비트를 저장했고 파이프라인을 다음 단계로 이동했습니다.", data: { beatPath, next: summarizeState(state), context: await this.contextForPhase(state) } };
      });
    });
  }

  async saveBeatDraft(input: SaveBeatDraftInput, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      new ExecutionDeadline(this.config.operationTimeoutMs, signal).assertActive("saving beat draft");
      const parsed = parseSaveBeatDraftInput(input);
      const resolved = await this.resolveState(parsed);
      return this.storage.withVolumeLock(resolved.franchiseId, resolved.workId, resolved.volumeId, async () => {
        const state = await this.storage.loadState(resolved.franchiseId, resolved.workId, resolved.volumeId);
        if (state.phase !== "writing" || state.flowStatus !== "needs_input") {
          throw new Error(`Current phase does not accept beat draft: phase=${state.phase}, status=${state.flowStatus}.`);
        }
        const beat = findCurrentBeat(state);
        if (!beat) throw new Error("No current beat is available for draft save.");
        if ((parsed.chapterNo && parsed.chapterNo !== beat.chapterNo) || (parsed.beatNo && parsed.beatNo !== beat.beatNo)) {
          throw new Error(`Current beat mismatch: expected chapter=${beat.chapterNo}, beat=${beat.beatNo}.`);
        }
        const draftPath = await this.storage.writeBeatDraft(state, beat.chapterNo, beat.beatNo, parsed.text);
        return { status: state.flowStatus, message: "비트 초안을 저장했습니다.", data: { draftPath, next: summarizeState(state), context: await this.contextForPhase(state) } };
      });
    });
  }

  async rewriteBeat(input: RewriteBeatInput, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      new ExecutionDeadline(this.config.operationTimeoutMs, signal).assertActive("rewriting beat");
      const parsed = parseRewriteBeatInput(input);
      const resolved = await this.resolveState(parsed);
      return this.storage.withVolumeLock(resolved.franchiseId, resolved.workId, resolved.volumeId, async () => {
        const state = await this.storage.loadState(resolved.franchiseId, resolved.workId, resolved.volumeId);
        if (!(state.phase === "writing" || state.phase === "epub" || state.phase === "complete")) {
          throw new Error(`Current phase does not accept beat rewrite: phase=${state.phase}, status=${state.flowStatus}.`);
        }
        const beat = state.chapters.flatMap((chapter) => chapter.beats).find((item) => item.chapterNo === parsed.chapterNo && item.beatNo === parsed.beatNo);
        if (!beat) throw new Error(`Unknown beat: chapter=${parsed.chapterNo}, beat=${parsed.beatNo}.`);
        if (!parsed.consistencyReport.ok) {
          state.lastConsistencyFailure = { phase: state.phase, submittedAt: new Date().toISOString(), report: parsed.consistencyReport };
          state.updatedAt = new Date().toISOString();
          await this.storage.saveState(state);
          return nextResult(state, await this.contextForPhase(state));
        }
        const beatPath = await this.storage.writeBeat(state, parsed.chapterNo, parsed.beatNo, parsed.text);
        beat.status = "complete";
        state.lastConsistencyFailure = undefined;
        if (state.phase === "complete") setPhase(state, "epub", "ready");
        else if (state.phase === "epub") setPhase(state, "epub", "ready");
        else setPhase(state, "writing", findCurrentBeat(state) ? "needs_input" : "ready");
        if (state.phase === "writing" && state.flowStatus === "ready") setPhase(state, "epub", "ready");
        await this.storage.saveState(state);
        return { status: state.flowStatus, message: "비트를 다시 저장했습니다.", data: { beatPath, next: summarizeState(state), context: await this.contextForPhase(state) } };
      });
    });
  }

  async health(input: unknown = {}): Promise<ToolResult> {
    assertShape(input, "novel_health arguments", {});
    const storage = await this.storage.healthCheck();
    return {
      status: storage.writable && storage.jobStoreReadable ? "ok" : "needs_input",
      message: storage.writable && storage.jobStoreReadable ? "Novelist MCP server is healthy." : "Novelist MCP server health checks failed.",
      data: {
        storage: { rootHash: HEALTH_STORAGE_ROOT_HASH, writable: storage.writable, jobStoreReadable: storage.jobStoreReadable, currentPointerReadable: storage.currentPointerReadable, jobCount: storage.jobCount, jobQuarantineCount: storage.jobQuarantineCount },
        agent: { provider: HEALTH_AGENT_PROVIDER, ready: true },
        stateSchemaVersion: CURRENT_STATE_SCHEMA_VERSION,
        timestamp: new Date().toISOString()
      }
    };
  }

  async status(input: Partial<LocatorInput> = {}): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      const state = await this.resolveState(parseLocatorInput(input));
      return { status: state.flowStatus, message: "현재 소설 파이프라인 상태입니다.", data: { ...summarizeState(state), context: await this.contextForPhase(state) } };
    });
  }

  async buildEpub(input: BuildEpubInput, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      const deadline = new ExecutionDeadline(this.config.operationTimeoutMs, signal);
      const parsed = parseBuildEpubInput(input);
      return this.storage.withVolumeLock(parsed.franchiseId, parsed.workId, parsed.volumeId, async () => {
        deadline.assertActive("building epub");
        const state = await this.storage.loadState(parsed.franchiseId, parsed.workId, parsed.volumeId);
        if (state.phase !== "epub" || state.flowStatus !== "ready") {
          throw new Error("EPUB can only be built when phase=epub and status=ready.");
        }
        const allComplete = state.chapters.every((chapter) => chapter.beats.every((beat) => beat.status === "complete"));
        if (!allComplete) throw new Error("EPUB can only be built after every beat is complete.");
        const markdown = await this.storage.collectVolumeMarkdown(state);
        const archive = buildEpubArchive(state, markdown);
        const candidatePath = await this.storage.writeEpubCandidate(state, archive);
        const internal = validateEpubArchive(archive);
        if (!internal.valid) throw new Error(`Internal EPUB validation failed: ${internal.issues.join("; ")}`);
        const external = await runExternalEpubCheck(candidatePath, this.config, deadline.requireRemainingMs("running external epub validator"));
        if (!external.valid) throw new Error(`External EPUB validation failed: ${external.error ?? external.stderr ?? "unknown error"}`);
        const path = await this.storage.promoteEpubCandidate(state, candidatePath);
        setPhase(state, "complete", "complete");
        await this.storage.saveState(state);
        return { status: "ok", message: "EPUB file was built.", data: { path, bytes: archive.length, validation: { internal, external } } };
      });
    });
  }

  private async acceptScopedDocument(state: VolumeState, scope: WorldScope | SettingScope, kind: "world" | "setting", text: string, report: ConsistencyReport): Promise<ToolResult> {
    if (!report.ok) {
      state.lastConsistencyFailure = { phase: state.phase, submittedAt: new Date().toISOString(), report };
      state.updatedAt = new Date().toISOString();
      await this.storage.saveState(state);
      return nextResult(state, await this.contextForPhase(state));
    }
    if (kind === "world") await this.storage.writeScopedWorld(state, scope, text);
    else await this.storage.writeScopedSetting(state, scope, text);
    state.lastConsistencyFailure = undefined;
    setPhase(state, state.phase, "pending_finalization");
    await this.storage.saveState(state);
    return nextResult(state, await this.contextForPhase(state));
  }

  private async finalizeScopedDocument(input: LocatorInput, kind: "world" | "setting", signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      new ExecutionDeadline(this.config.operationTimeoutMs, signal).assertActive(`finalizing ${kind}`);
      const resolved = await this.resolveState(parseLocatorInput(input));
      return this.storage.withVolumeLock(resolved.franchiseId, resolved.workId, resolved.volumeId, async () => {
        const state = await this.storage.loadState(resolved.franchiseId, resolved.workId, resolved.volumeId);
        const scope = kind === "world" ? worldScopeForPhase(state.phase) : settingScopeForPhase(state.phase);
        if (!scope || state.flowStatus !== "pending_finalization") {
          throw new Error(`Current phase does not accept ${kind} finalization: phase=${state.phase}, status=${state.flowStatus}.`);
        }
        setPhase(state, nextPhase(state.phase), "needs_input");
        await this.ensurePhaseForExistingArtifacts(state);
        await this.storage.saveState(state);
        return nextResult(state, await this.contextForPhase(state));
      });
    });
  }

  private async ensurePhaseForExistingArtifacts(state: VolumeState): Promise<void> {
    for (;;) {
      if (state.phase === "writing") {
        if (findCurrentBeat(state)) setPhase(state, "writing", "needs_input");
        else setPhase(state, "epub", "ready");
        return;
      }
      if (state.phase === "epub" || state.phase === "complete") return;
      if (state.phase === "volume_outline") {
        const exists = await this.storage.readOutlineFile(state);
        setPhase(state, "volume_outline", exists && state.chapters.length > 0 ? "pending_finalization" : "needs_input");
        return;
      }
      const worldScope = worldScopeForPhase(state.phase);
      const settingScope = settingScopeForPhase(state.phase);
      const exists = worldScope
        ? await this.storage.readScopedWorldFile(state, worldScope)
        : settingScope
          ? await this.storage.readScopedSettingFile(state, settingScope)
          : undefined;
      setPhase(state, state.phase, exists ? "pending_finalization" : "needs_input");
      return;
    }
  }

  private async contextForPhase(state: VolumeState): Promise<Record<string, unknown>> {
    const base = summarizeState(state);
    if (state.phase === "writing") {
      const currentBeat = findCurrentBeat(state);
      return { ...base, requiredAction: "submit_beat", currentBeat, currentBeatDraft: currentBeat ? await this.storage.readBeatDraftFile(state, currentBeat.chapterNo, currentBeat.beatNo) : undefined, previousBeatText: await this.previousBeatText(state), references: await this.referenceDocuments(state) };
    }
    if (state.phase === "volume_outline") return { ...base, requiredAction: state.flowStatus === "pending_finalization" ? "finalize_outline" : "submit_outline", references: await this.referenceDocuments(state) };
    if (state.phase === "epub") return { ...base, requiredAction: "build_epub" };
    if (state.phase === "complete") return { ...base, requiredAction: "none" };
    return { ...base, requiredAction: state.flowStatus === "pending_finalization" ? `finalize_${phaseKind(state.phase)}` : `submit_${phaseKind(state.phase)}`, references: await this.referenceDocuments(state) };
  }

  private async referenceDocuments(state: VolumeState): Promise<Record<string, boolean>> {
    return {
      "franchise.world": Boolean(await this.storage.readScopedWorldFile(state, "franchise")),
      "franchise.setting": Boolean(await this.storage.readScopedSettingFile(state, "franchise")),
      "work.world": Boolean(await this.storage.readScopedWorldFile(state, "work")),
      "work.setting": Boolean(await this.storage.readScopedSettingFile(state, "work")),
      "volume.world": Boolean(await this.storage.readScopedWorldFile(state, "volume")),
      "volume.setting": Boolean(await this.storage.readScopedSettingFile(state, "volume"))
    };
  }

  private async previousBeatText(state: VolumeState): Promise<string> {
    const previous = previousBeat(state);
    return previous ? this.storage.readBeat(state, previous.chapterNo, previous.beatNo).catch(() => "") : "";
  }

  private async resolveState(input: Partial<LocatorInput>): Promise<VolumeState> {
    if (input.current || !(input.franchiseId || input.workId || input.volumeId)) {
      const current = await this.storage.loadCurrentState();
      if (current) return current;
      throw new Error("No current novel pipeline found.");
    }
    if (!input.franchiseId || !input.workId || !input.volumeId) throw new Error("franchiseId, workId, and volumeId are required together.");
    return this.storage.loadState(input.franchiseId, input.workId, input.volumeId);
  }

  private async existingWorkIdentity(franchiseId: string, workId: string, franchiseName?: string, workTitle?: string): Promise<{ franchiseName: string; workTitle: string }> {
    const current = await this.storage.loadCurrentState().catch(() => undefined);
    if (current && current.franchiseId === franchiseId && current.workId === workId) {
      return { franchiseName: current.franchiseName, workTitle: current.workTitle };
    }
    return { franchiseName: franchiseName ?? franchiseId, workTitle: workTitle ?? workId };
  }

  private async requireWorkFoundation(state: VolumeState): Promise<void> {
    const missing: string[] = [];
    if (!await this.storage.readScopedWorldFile(state, "franchise")) missing.push("franchise.world");
    if (!await this.storage.readScopedSettingFile(state, "franchise")) missing.push("franchise.setting");
    if (!await this.storage.readScopedWorldFile(state, "work")) missing.push("work.world");
    if (!await this.storage.readScopedSettingFile(state, "work")) missing.push("work.setting");
    if (missing.length > 0) throw new Error(`Cannot start a new volume before foundational documents exist: ${missing.join(", ")}.`);
  }

  private async withRootRedaction<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) { throw new Error(errorMessage(error, this.storage.root)); }
  }
}

function parseStartInput(input: unknown): StartInput {
  const object = assertShape(input, "novel_start arguments", { franchiseName: "string", workRequest: "string", volumeRequest: "optionalString", genre: "optionalString", tone: "optionalString", targetLength: "optionalString" });
  return {
    franchiseName: assertBoundedNonEmptySingleLineString(object.franchiseName, "franchiseName", MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES),
    workRequest: assertBoundedNonEmptySingleLineString(object.workRequest, "workRequest", MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES),
    ...(asOptionalBoundedSingleLineString(object.volumeRequest, "volumeRequest", MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES) ? { volumeRequest: asOptionalBoundedSingleLineString(object.volumeRequest, "volumeRequest", MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES) } : {}),
    ...(asOptionalBoundedSingleLineString(object.genre, "genre", MAX_OPTION_INPUT_CHARS, MAX_OPTION_INPUT_BYTES) ? { genre: asOptionalBoundedSingleLineString(object.genre, "genre", MAX_OPTION_INPUT_CHARS, MAX_OPTION_INPUT_BYTES) } : {}),
    ...(asOptionalBoundedSingleLineString(object.tone, "tone", MAX_OPTION_INPUT_CHARS, MAX_OPTION_INPUT_BYTES) ? { tone: asOptionalBoundedSingleLineString(object.tone, "tone", MAX_OPTION_INPUT_CHARS, MAX_OPTION_INPUT_BYTES) } : {}),
    ...(asOptionalBoundedSingleLineString(object.targetLength, "targetLength", MAX_OPTION_INPUT_CHARS, MAX_OPTION_INPUT_BYTES) ? { targetLength: asOptionalBoundedSingleLineString(object.targetLength, "targetLength", MAX_OPTION_INPUT_CHARS, MAX_OPTION_INPUT_BYTES) } : {})
  };
}

function parseStartVolumeInput(input: unknown): StartVolumeInput {
  const object = assertShape(input, "novel_start_volume arguments", { franchiseId: "string", workId: "string", volumeRequest: "string", franchiseName: "optionalString", workTitle: "optionalString" });
  return {
    franchiseId: assertSafeId(object.franchiseId, "franchiseId"),
    workId: assertSafeId(object.workId, "workId"),
    volumeRequest: assertBoundedNonEmptySingleLineString(object.volumeRequest, "volumeRequest", MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES),
    ...(asOptionalBoundedSingleLineString(object.franchiseName, "franchiseName", MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES) ? { franchiseName: asOptionalBoundedSingleLineString(object.franchiseName, "franchiseName", MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES) } : {}),
    ...(asOptionalBoundedSingleLineString(object.workTitle, "workTitle", MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES) ? { workTitle: asOptionalBoundedSingleLineString(object.workTitle, "workTitle", MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES) } : {})
  };
}

function parseLocatorInput(input: unknown): LocatorInput {
  const object = assertShape(input ?? {}, "novel_next arguments", { franchiseId: "optionalString", workId: "optionalString", volumeId: "optionalString", current: "optionalBoolean" });
  return { franchiseId: object.franchiseId === undefined ? undefined : assertSafeId(object.franchiseId, "franchiseId"), workId: object.workId === undefined ? undefined : assertSafeId(object.workId, "workId"), volumeId: object.volumeId === undefined ? undefined : assertSafeId(object.volumeId, "volumeId"), current: object.current as boolean | undefined };
}

function parseSubmitWorldInput(input: unknown): SubmitWorldInput { const object = assertSubmitDocument(input, "novel_submit_world arguments"); return { ...parseLocatorFields(object), scope: parseOptionalScope(object.scope, "world"), text: boundedDocument(object.text, "text"), consistencyReport: validateConsistencyReportInput(object.consistencyReport) }; }
function parseSubmitSettingInput(input: unknown): SubmitSettingInput { const object = assertSubmitDocument(input, "novel_submit_setting arguments"); return { ...parseLocatorFields(object), scope: parseOptionalScope(object.scope, "setting"), text: boundedDocument(object.text, "text"), consistencyReport: validateConsistencyReportInput(object.consistencyReport) }; }
function parseSubmitOutlineInput(input: unknown): SubmitOutlineInput {
  const object = assertObject(input, "novel_submit_outline arguments");
  return { ...parseLocatorFields(object), text: boundedDocument(object.text, "text"), chapters: validateOutlineInput(object.chapters), consistencyReport: validateConsistencyReportInput(object.consistencyReport) };
}

function parseSubmitBeatInput(input: unknown): SubmitBeatInput {
  const object = assertObject(input, "novel_submit_beat arguments");
  return { ...parseLocatorFields(object), chapterNo: optionalPositiveInteger(object.chapterNo, "chapterNo"), beatNo: optionalPositiveInteger(object.beatNo, "beatNo"), text: boundedDocument(object.text, "text"), consistencyReport: validateConsistencyReportInput(object.consistencyReport) };
}
function parseSaveBeatDraftInput(input: unknown): SaveBeatDraftInput { const object = assertObject(input, "novel_save_beat_draft arguments"); return { ...parseLocatorFields(object), chapterNo: optionalPositiveInteger(object.chapterNo, "chapterNo"), beatNo: optionalPositiveInteger(object.beatNo, "beatNo"), text: boundedDocument(object.text, "text") }; }
function parseRewriteBeatInput(input: unknown): RewriteBeatInput { const object = assertObject(input, "novel_rewrite_beat arguments"); return { ...parseLocatorFields(object), chapterNo: requiredPositiveInteger(object.chapterNo, "chapterNo"), beatNo: requiredPositiveInteger(object.beatNo, "beatNo"), text: boundedDocument(object.text, "text"), consistencyReport: validateConsistencyReportInput(object.consistencyReport) }; }

function assertSubmitDocument(input: unknown, label: string): Record<string, unknown> { return assertObject(input, label); }
function parseLocatorFields(object: Record<string, unknown>): LocatorInput { return { franchiseId: object.franchiseId === undefined ? undefined : assertSafeId(object.franchiseId, "franchiseId"), workId: object.workId === undefined ? undefined : assertSafeId(object.workId, "workId"), volumeId: object.volumeId === undefined ? undefined : assertSafeId(object.volumeId, "volumeId"), current: object.current as boolean | undefined }; }
function parseOptionalScope(value: unknown, label: string): WorldScope | SettingScope | undefined { if (value === undefined) return undefined; if (value === "franchise" || value === "work" || value === "volume") return value; throw new Error(`${label} scope must be franchise, work, or volume.`); }
function optionalPositiveInteger(value: unknown, label: string): number | undefined { if (value === undefined) return undefined; if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`); return value; }
function requiredPositiveInteger(value: unknown, label: string): number { const parsed = optionalPositiveInteger(value, label); if (parsed === undefined) throw new Error(`${label} is required.`); return parsed; }
function boundedDocument(value: unknown, label: string): string { return assertBoundedNonEmptyString(value, label, MAX_DOCUMENT_CHARS, MAX_DOCUMENT_BYTES); }

function validateOutlineInput(value: unknown): OutlineChapterInput[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("chapters must be a non-empty array.");
  if (value.length > 200) throw new Error("chapters must contain at most 200 chapters.");
  let totalBeats = 0;
  return value.map((chapterValue, chapterIndex) => {
    const chapter = assertObject(chapterValue, `chapters[${chapterIndex}]`);
    const beatsValue = chapter.beats;
    if (!Array.isArray(beatsValue) || beatsValue.length === 0) throw new Error(`chapters[${chapterIndex}].beats must be a non-empty array.`);
    if (beatsValue.length > 200) throw new Error(`chapters[${chapterIndex}].beats must contain at most 200 beats.`);
    totalBeats += beatsValue.length;
    if (totalBeats > 5000) throw new Error("outline must contain at most 5000 beats.");
    const beats = beatsValue.map((beatValue, beatIndex) => {
      const beat = assertObject(beatValue, `chapters[${chapterIndex}].beats[${beatIndex}]`);
      return { title: assertBoundedNonEmptySingleLineString(beat.title, `chapters[${chapterIndex}].beats[${beatIndex}].title`, MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES), targetWords: requiredPositiveInteger(beat.targetWords, `chapters[${chapterIndex}].beats[${beatIndex}].targetWords`) };
    });
    const beatTargetSum = beats.reduce((sum, beat) => sum + beat.targetWords, 0);
    const targetWords = chapter.targetWords === undefined ? beatTargetSum : requiredPositiveInteger(chapter.targetWords, `chapters[${chapterIndex}].targetWords`);
    if (targetWords !== beatTargetSum) throw new Error(`chapters[${chapterIndex}].targetWords must equal the sum of beat targetWords.`);
    return { title: assertBoundedNonEmptySingleLineString(chapter.title, `chapters[${chapterIndex}].title`, MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES), targetWords, beats };
  });
}

function validateConsistencyReportInput(value: unknown): ConsistencyReport {
  const object = assertObject(value, "consistencyReport");
  const ok = object.ok;
  if (typeof ok !== "boolean") throw new Error("consistencyReport.ok must be boolean.");
  if (!Array.isArray(object.checkedAgainst)) throw new Error("consistencyReport.checkedAgainst must be an array.");
  if (!Array.isArray(object.issues)) throw new Error("consistencyReport.issues must be an array.");
  return { ok, checkedAgainst: object.checkedAgainst.map((item, index) => assertBoundedNonEmptySingleLineString(item, `checkedAgainst[${index}]`, MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES)), issues: object.issues.map(validateConsistencyIssueInput) };
}
function validateConsistencyIssueInput(value: unknown): ConsistencyReport["issues"][number] { const object = assertObject(value, "consistencyReport.issues[]"); return { scope: assertBoundedNonEmptySingleLineString(object.scope, "issue.scope", MAX_OPTION_INPUT_CHARS, MAX_OPTION_INPUT_BYTES), description: assertBoundedNonEmptyString(object.description, "issue.description", MAX_INSTRUCTION_INPUT_CHARS, MAX_INSTRUCTION_INPUT_BYTES) }; }

function parseBuildEpubInput(input: unknown): BuildEpubInput { const object = assertShape(input, "novel_build_epub arguments", { franchiseId: "string", workId: "string", volumeId: "string" }); return { franchiseId: assertSafeId(object.franchiseId, "franchiseId"), workId: assertSafeId(object.workId, "workId"), volumeId: assertSafeId(object.volumeId, "volumeId") }; }

function outlineChapters(chapters: OutlineChapterInput[]): ChapterState[] { return chapters.map((chapter, chapterIndex) => ({ chapterNo: chapterIndex + 1, title: chapter.title, targetWords: chapter.targetWords ?? chapter.beats.reduce((sum, beat) => sum + beat.targetWords, 0), beats: chapter.beats.map((beat, beatIndex) => ({ chapterNo: chapterIndex + 1, beatNo: beatIndex + 1, title: beat.title, targetWords: beat.targetWords, status: "pending" })) })); }
function findCurrentBeat(state: VolumeState) { return state.chapters.flatMap((chapter) => chapter.beats).find((beat) => beat.chapterNo === state.currentChapterNo && beat.beatNo === state.currentBeatNo && beat.status !== "complete"); }
function previousBeat(state: VolumeState) { const beats = state.chapters.flatMap((chapter) => chapter.beats); const index = beats.findIndex((beat) => beat.chapterNo === state.currentChapterNo && beat.beatNo === state.currentBeatNo); return index > 0 ? beats[index - 1] : undefined; }
function advanceCursor(state: VolumeState): void { const next = state.chapters.flatMap((chapter) => chapter.beats).find((beat) => beat.status !== "complete"); if (next) { state.currentChapterNo = next.chapterNo; state.currentBeatNo = next.beatNo; return; } const last = state.chapters.flatMap((chapter) => chapter.beats).at(-1); if (last) { state.currentChapterNo = last.chapterNo; state.currentBeatNo = last.beatNo; } }
function cloneVolumeState(state: VolumeState): VolumeState { return validateVolumeState(state); }
function setPhase(state: VolumeState, phase: PipelinePhase, flowStatus: VolumeState["flowStatus"]): void { state.phase = phase; state.flowStatus = flowStatus; state.updatedAt = new Date().toISOString(); }
function nextPhase(phase: PipelinePhase): PipelinePhase { return PHASE_ORDER[Math.min(PHASE_ORDER.indexOf(phase) + 1, PHASE_ORDER.length - 1)] ?? "complete"; }
function worldScopeForPhase(phase: PipelinePhase): WorldScope | undefined { if (phase === "franchise_world") return "franchise"; if (phase === "work_world") return "work"; if (phase === "volume_world") return "volume"; return undefined; }
function settingScopeForPhase(phase: PipelinePhase): SettingScope | undefined { if (phase === "franchise_setting") return "franchise"; if (phase === "work_setting") return "work"; if (phase === "volume_setting") return "volume"; return undefined; }
function phaseKind(phase: PipelinePhase): "world" | "setting" { return phase.endsWith("world") ? "world" : "setting"; }
function nextResult(state: VolumeState, context: Record<string, unknown>): ToolResult { return { status: state.flowStatus, message: "파이프라인의 현재 단계와 필요한 다음 작업입니다.", data: context }; }
function summarizeState(state: VolumeState) { const beats = state.chapters.flatMap((chapter) => chapter.beats); return { franchiseId: state.franchiseId, workId: state.workId, volumeId: state.volumeId, phase: state.phase, flowStatus: state.flowStatus, currentChapterNo: state.currentChapterNo, currentBeatNo: state.currentBeatNo, completedBeats: beats.filter((beat) => beat.status === "complete").length, totalBeats: beats.length, ...(state.lastConsistencyFailure ? { lastConsistencyFailure: state.lastConsistencyFailure } : {}) }; }
function errorMessage(error: unknown, root?: string): string { const secretRedacted = redactErrorMessage(error).replace(PIPELINE_ERROR_CONTROL_CHARS_GLOBAL, " "); const redacted = root ? secretRedacted.split(root).join("<data-root>") : secretRedacted; return truncatePipelineText(redacted, MAX_SUMMARY_TEXT_CHARS, MAX_SUMMARY_TEXT_BYTES); }
function truncatePipelineText(value: string, maxChars: number, maxBytes: number): string { if (value.length <= maxChars && utf8ByteLengthUpTo(value, maxBytes) <= maxBytes) return value; return `${value.slice(0, maxChars)}... [truncated]`; }
