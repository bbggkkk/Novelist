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
import { PipelineOrchestrator } from "./pipeline/orchestrator.js";
import type { PipelineStatus, ProcessId } from "./pipeline/model.js";
import { PipelineStateManager } from "./pipeline/stateManager.js";

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

export class NovelPipeline {
  private readonly storage: NovelStorage;
  private readonly config: AppConfig;
  private readonly orchestrator: PipelineOrchestrator;
  private readonly stateManager: PipelineStateManager;

  constructor(storage = new NovelStorage(), config: AppConfig = loadConfig()) {
    this.storage = storage;
    this.config = config;
    this.orchestrator = new PipelineOrchestrator(storage);
    this.stateManager = new PipelineStateManager(storage);
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
          await this.reconcileAndSaveState(existing);
          return this.nextResult(existing);
        }
        const state = newVolumeState({ franchiseId, franchiseName: parsed.franchiseName, workId, workTitle, volumeId, volumeTitle, completedProcesses: [] });
        await this.storage.saveState(state);
        return this.nextResult(state);
      });
    });
  }

  async next(input: LocatorInput = {}, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      new ExecutionDeadline(this.config.operationTimeoutMs, signal).assertActive("advancing the pipeline");
      const resolved = await this.resolveState(parseLocatorInput(input));
      return this.storage.withVolumeLock(resolved.franchiseId, resolved.workId, resolved.volumeId, async () => {
        const state = await this.storage.loadState(resolved.franchiseId, resolved.workId, resolved.volumeId);
        await this.reconcileAndSaveState(state);
        return this.nextResult(state);
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
          await this.reconcileAndSaveState(existing);
          return this.nextResult(existing);
        }
        const base = await this.existingWorkIdentity(parsed.franchiseId, parsed.workId, parsed.franchiseName, parsed.workTitle);
        const state = newVolumeState({
          franchiseId: parsed.franchiseId,
          franchiseName: base.franchiseName,
          workId: parsed.workId,
          workTitle: base.workTitle,
          volumeId,
          volumeTitle,
          completedProcesses: ["franchise.world", "franchise.setting", "work.world", "work.setting"]
        });
        await this.requireWorkFoundation(state);
        await this.storage.saveState(state);
        return this.nextResult(state);
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
        await this.reconcileAndSaveState(state);
        const status = await this.requireAction(state, "submit_document");
        if (status.target?.document !== "world") throw new Error(`Current process does not accept world submission: process=${status.processId}.`);
        if (parsed.scope && parsed.scope !== status.target.scope) throw new Error(`Current world scope mismatch: expected ${String(status.target.scope)}.`);
        return this.acceptScopedDocument(state, status.processId, status.target.scope!, "world", parsed.text, parsed.consistencyReport);
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
        await this.reconcileAndSaveState(state);
        const status = await this.requireAction(state, "submit_document");
        if (status.target?.document !== "setting") throw new Error(`Current process does not accept setting submission: process=${status.processId}.`);
        if (parsed.scope && parsed.scope !== status.target.scope) throw new Error(`Current setting scope mismatch: expected ${String(status.target.scope)}.`);
        return this.acceptScopedDocument(state, status.processId, status.target.scope!, "setting", parsed.text, parsed.consistencyReport);
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
        await this.reconcileAndSaveState(state);
        await this.requireAction(state, "submit_outline");
        if (!parsed.consistencyReport.ok) {
          state.lastConsistencyFailure = { processId: "volume.outline", submittedAt: new Date().toISOString(), report: parsed.consistencyReport };
          state.updatedAt = new Date().toISOString();
          await this.storage.saveState(state);
          return this.nextResult(state);
        }
        const action = await this.stateManager.beginAction(state, { processId: "volume.outline", kind: "submit_outline", input: { text: parsed.text, chapters: parsed.chapters, report: parsed.consistencyReport } });
        await this.storage.writeOutline(state, parsed.text);
        await this.stateManager.markArtifactWritten(state, action.id, []);
        await this.stateManager.commitState(state, action.id, () => {
          state.chapters = outlineChapters(parsed.chapters);
          state.currentChapterNo = 1;
          state.currentBeatNo = 1;
          state.lastConsistencyFailure = undefined;
        });
        await this.stateManager.clearAction(state, action.id);
        return this.nextResult(state);
      });
    });
  }

  async finalizeOutline(input: LocatorInput = {}, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      new ExecutionDeadline(this.config.operationTimeoutMs, signal).assertActive("finalizing outline");
      const resolved = await this.resolveState(parseLocatorInput(input));
      return this.storage.withVolumeLock(resolved.franchiseId, resolved.workId, resolved.volumeId, async () => {
        const state = await this.storage.loadState(resolved.franchiseId, resolved.workId, resolved.volumeId);
        await this.reconcileAndSaveState(state);
        await this.requireAction(state, "finalize_outline");
        if (state.chapters.length === 0) throw new Error("Outline finalization requires at least one chapter.");
        const action = await this.stateManager.beginAction(state, { processId: "volume.outline", kind: "finalize_outline", input: {} });
        await this.stateManager.commitState(state, action.id, () => completeProcess(state, "volume.outline"));
        await this.stateManager.clearAction(state, action.id);
        return this.nextResult(state);
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
        await this.reconcileAndSaveState(state);
        const status = await this.requireAction(state, "submit_beat");
        const beat = findCurrentBeat(state);
        if (!beat) throw new Error("No current beat is available for submission.");
        if ((parsed.chapterNo && parsed.chapterNo !== beat.chapterNo) || (parsed.beatNo && parsed.beatNo !== beat.beatNo)) {
          throw new Error(`Current beat mismatch: expected chapter=${beat.chapterNo}, beat=${beat.beatNo}.`);
        }
        if (!parsed.consistencyReport.ok) {
          state.lastConsistencyFailure = { processId: status.processId, submittedAt: new Date().toISOString(), report: parsed.consistencyReport };
          state.updatedAt = new Date().toISOString();
          await this.storage.saveState(state);
          return this.nextResult(state);
        }
        const previous = cloneVolumeState(state);
        const previousBeatFile = await this.storage.readBeatFile(state, beat.chapterNo, beat.beatNo);
        const action = await this.stateManager.beginAction(state, { processId: "volume.writing", kind: "submit_beat", target: { chapterNo: beat.chapterNo, beatNo: beat.beatNo }, input: { text: parsed.text, report: parsed.consistencyReport } });
        const beatPath = await this.storage.writeBeat(state, beat.chapterNo, beat.beatNo, parsed.text);
        await this.stateManager.markArtifactWritten(state, action.id, [beatPath]);
        try {
          await this.stateManager.commitState(state, action.id, () => {
            beat.status = "complete";
            state.lastConsistencyFailure = undefined;
            advanceCursor(state);
            if (!findCurrentBeat(state)) completeProcess(state, "volume.writing");
          });
          await this.stateManager.clearAction(state, action.id);
        } catch (error) {
          if (previousBeatFile === undefined) await this.storage.deleteBeat(previous, beat.chapterNo, beat.beatNo);
          else await this.storage.writeBeatFile(previous, beat.chapterNo, beat.beatNo, previousBeatFile);
          throw error;
        }
        return { status: await this.resultStatus(state), message: "비트를 저장했고 파이프라인을 다음 단계로 이동했습니다.", data: { beatPath, next: await this.summarizeState(state), context: await this.contextForState(state) } };
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
        await this.reconcileAndSaveState(state);
        await this.requireAction(state, "submit_beat");
        const beat = findCurrentBeat(state);
        if (!beat) throw new Error("No current beat is available for draft save.");
        if ((parsed.chapterNo && parsed.chapterNo !== beat.chapterNo) || (parsed.beatNo && parsed.beatNo !== beat.beatNo)) {
          throw new Error(`Current beat mismatch: expected chapter=${beat.chapterNo}, beat=${beat.beatNo}.`);
        }
        const action = await this.stateManager.beginAction(state, { processId: "volume.writing", kind: "save_beat_draft", target: { chapterNo: beat.chapterNo, beatNo: beat.beatNo }, input: { text: parsed.text } });
        const draftPath = await this.storage.writeBeatDraft(state, beat.chapterNo, beat.beatNo, parsed.text);
        await this.stateManager.markArtifactWritten(state, action.id, [draftPath]);
        await this.stateManager.commitState(state, action.id, () => undefined);
        await this.stateManager.clearAction(state, action.id);
        return { status: await this.resultStatus(state), message: "비트 초안을 저장했습니다.", data: { draftPath, next: await this.summarizeState(state), context: await this.contextForState(state) } };
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
        await this.reconcileAndSaveState(state);
        const beat = state.chapters.flatMap((chapter) => chapter.beats).find((item) => item.chapterNo === parsed.chapterNo && item.beatNo === parsed.beatNo);
        if (!beat) throw new Error(`Unknown beat: chapter=${parsed.chapterNo}, beat=${parsed.beatNo}.`);
        if (!parsed.consistencyReport.ok) {
          state.lastConsistencyFailure = { processId: "volume.writing", submittedAt: new Date().toISOString(), report: parsed.consistencyReport };
          state.updatedAt = new Date().toISOString();
          await this.storage.saveState(state);
          return this.nextResult(state);
        }
        const previous = cloneVolumeState(state);
        const previousBeatFile = await this.storage.readBeatFile(state, parsed.chapterNo, parsed.beatNo);
        const action = await this.stateManager.beginAction(state, { processId: "volume.writing", kind: "rewrite_beat", target: { chapterNo: parsed.chapterNo, beatNo: parsed.beatNo }, input: { text: parsed.text, report: parsed.consistencyReport } });
        const beatPath = await this.storage.writeBeat(state, parsed.chapterNo, parsed.beatNo, parsed.text);
        await this.stateManager.markArtifactWritten(state, action.id, [beatPath]);
        try {
          await this.stateManager.commitState(state, action.id, () => {
            beat.status = "complete";
            state.lastConsistencyFailure = undefined;
            removeCompletedProcesses(state, ["volume.epub", "volume.complete"]);
            if (!findCurrentBeat(state)) completeProcess(state, "volume.writing");
          });
          await this.stateManager.clearAction(state, action.id);
        } catch (error) {
          if (previousBeatFile === undefined) await this.storage.deleteBeat(previous, parsed.chapterNo, parsed.beatNo);
          else await this.storage.writeBeatFile(previous, parsed.chapterNo, parsed.beatNo, previousBeatFile);
          throw error;
        }
        return { status: await this.resultStatus(state), message: "비트를 다시 저장했습니다.", data: { beatPath, next: await this.summarizeState(state), context: await this.contextForState(state) } };
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
      await this.reconcileState(state, { clearActiveAction: false });
      return { status: await this.resultStatus(state), message: "현재 소설 파이프라인 상태입니다.", data: { ...await this.summarizeState(state), context: await this.contextForState(state) } };
    });
  }

  async buildEpub(input: BuildEpubInput, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      const deadline = new ExecutionDeadline(this.config.operationTimeoutMs, signal);
      const parsed = parseBuildEpubInput(input);
      return this.storage.withVolumeLock(parsed.franchiseId, parsed.workId, parsed.volumeId, async () => {
        deadline.assertActive("building epub");
        const state = await this.storage.loadState(parsed.franchiseId, parsed.workId, parsed.volumeId);
        await this.reconcileAndSaveState(state);
        await this.requireAction(state, "build_epub");
        const allComplete = state.chapters.every((chapter) => chapter.beats.every((beat) => beat.status === "complete"));
        if (!allComplete) throw new Error("EPUB can only be built after every beat is complete.");
        const action = await this.stateManager.beginAction(state, { processId: "volume.epub", kind: "build_epub", input: parsed });
        const markdown = await this.storage.collectVolumeMarkdown(state);
        const archive = buildEpubArchive(state, markdown);
        const candidatePath = await this.storage.writeEpubCandidate(state, archive);
        await this.stateManager.markArtifactWritten(state, action.id, [candidatePath]);
        const internal = validateEpubArchive(archive);
        if (!internal.valid) throw new Error(`Internal EPUB validation failed: ${internal.issues.join("; ")}`);
        const external = await runExternalEpubCheck(candidatePath, this.config, deadline.requireRemainingMs("running external epub validator"));
        if (!external.valid) throw new Error(`External EPUB validation failed: ${external.error ?? external.stderr ?? "unknown error"}`);
        const path = await this.storage.promoteEpubCandidate(state, candidatePath);
        await this.stateManager.commitState(state, action.id, () => {
          completeProcess(state, "volume.epub");
          completeProcess(state, "volume.complete");
        });
        await this.stateManager.clearAction(state, action.id);
        return { status: "ok", message: "EPUB file was built.", data: { path, bytes: archive.length, validation: { internal, external } } };
      });
    });
  }

  private async acceptScopedDocument(state: VolumeState, processId: ProcessId, scope: WorldScope | SettingScope, kind: "world" | "setting", text: string, report: ConsistencyReport): Promise<ToolResult> {
    if (!report.ok) {
      state.lastConsistencyFailure = { processId, submittedAt: new Date().toISOString(), report };
      state.updatedAt = new Date().toISOString();
      await this.storage.saveState(state);
      return this.nextResult(state);
    }
    const action = await this.stateManager.beginAction(state, { processId, kind: "submit_document", target: { scope, document: kind }, input: { text, report } });
    if (kind === "world") await this.storage.writeScopedWorld(state, scope, text);
    else await this.storage.writeScopedSetting(state, scope, text);
    const artifactPath = kind === "world" ? this.storage.scopedWorldPath(state, scope) : this.storage.scopedSettingPath(state, scope);
    await this.stateManager.markArtifactWritten(state, action.id, [artifactPath]);
    await this.stateManager.commitState(state, action.id, () => {
      state.lastConsistencyFailure = undefined;
    });
    await this.stateManager.clearAction(state, action.id);
    return this.nextResult(state);
  }

  private async finalizeScopedDocument(input: LocatorInput, kind: "world" | "setting", signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      new ExecutionDeadline(this.config.operationTimeoutMs, signal).assertActive(`finalizing ${kind}`);
      const resolved = await this.resolveState(parseLocatorInput(input));
      return this.storage.withVolumeLock(resolved.franchiseId, resolved.workId, resolved.volumeId, async () => {
        const state = await this.storage.loadState(resolved.franchiseId, resolved.workId, resolved.volumeId);
        await this.reconcileAndSaveState(state);
        const status = await this.requireAction(state, "finalize_document");
        if (status.target?.document !== kind) throw new Error(`Current process does not accept ${kind} finalization: process=${status.processId}.`);
        const action = await this.stateManager.beginAction(state, { processId: status.processId, kind: "finalize_document", target: status.target, input: { kind } });
        await this.stateManager.commitState(state, action.id, () => completeProcess(state, status.processId));
        await this.stateManager.clearAction(state, action.id);
        return this.nextResult(state);
      });
    });
  }

  private async reconcileAndSaveState(state: VolumeState): Promise<void> {
    await this.reconcileState(state, { clearActiveAction: true });
    await this.storage.saveState(state);
  }

  private async reconcileState(state: VolumeState, options: { clearActiveAction: boolean }): Promise<void> {
    await this.reconcileWritingArtifacts(state);
    if (state.chapters.length > 0 && state.chapters.every((chapter) => chapter.beats.every((beat) => beat.status === "complete"))) {
      completeProcess(state, "volume.writing");
    }
    if (await this.storage.epubFileExists(state)) {
      completeProcess(state, "volume.epub");
      completeProcess(state, "volume.complete");
    }
    if (options.clearActiveAction) recoverActiveAction(state);
  }

  private async reconcileWritingArtifacts(state: VolumeState): Promise<boolean> {
    let changed = false;
    for (const beat of state.chapters.flatMap((chapter) => chapter.beats)) {
      if (beat.status === "complete") continue;
      const fileExists = await this.storage.beatFileExists(state, beat.chapterNo, beat.beatNo);
      if (!fileExists) {
        break;
      }
      beat.status = "complete";
      changed = true;
    }
    if (changed) {
      const nextIncomplete = state.chapters.flatMap((chapter) => chapter.beats).find((beat) => beat.status !== "complete");
      if (nextIncomplete) {
        state.currentChapterNo = nextIncomplete.chapterNo;
        state.currentBeatNo = nextIncomplete.beatNo;
      } else {
        const last = state.chapters.flatMap((chapter) => chapter.beats).at(-1);
        if (last) {
          state.currentChapterNo = last.chapterNo;
          state.currentBeatNo = last.beatNo;
        }
      }
      state.updatedAt = new Date().toISOString();
    }
    return changed;
  }

  private async contextForState(state: VolumeState): Promise<Record<string, unknown>> {
    const base = await this.summarizeState(state);
    const pipelineStatus = await this.orchestrator.inspect(state);
    const requiredAction = legacyRequiredAction(pipelineStatus);
    const statusContext = { ...base, processId: pipelineStatus.processId, requiredAction };
    if (pipelineStatus.requiredAction === "submit_beat") {
      const currentBeat = pipelineStatus.currentBeat ?? findCurrentBeat(state);
      return { ...statusContext, currentBeat, currentBeatDraft: currentBeat ? await this.storage.readBeatDraftFile(state, currentBeat.chapterNo, currentBeat.beatNo) : undefined, previousBeatText: await this.previousBeatText(state), references: await this.referenceDocuments(state) };
    }
    if (pipelineStatus.requiredAction === "build_epub" || pipelineStatus.requiredAction === "none") return statusContext;
    return { ...statusContext, references: await this.referenceDocuments(state) };
  }

  private async nextResult(state: VolumeState): Promise<ToolResult> {
    return { status: await this.resultStatus(state), message: "파이프라인의 현재 단계와 필요한 다음 작업입니다.", data: await this.contextForState(state) };
  }

  private async requireAction(state: VolumeState, action: PipelineStatus["requiredAction"]): Promise<PipelineStatus> {
    const status = await this.orchestrator.inspect(state);
    if (status.requiredAction !== action) throw new Error(`Current process requires ${status.requiredAction}, not ${action}.`);
    return status;
  }

  private async resultStatus(state: VolumeState): Promise<ToolResult["status"]> {
    const status = await this.orchestrator.inspect(state);
    if (status.requiredAction === "none") return "complete";
    if (status.requiredAction === "build_epub") return "ready";
    if (status.requiredAction.startsWith("finalize")) return "pending_finalization";
    return "needs_input";
  }

  private async summarizeState(state: VolumeState): Promise<Record<string, unknown>> {
    const beats = state.chapters.flatMap((chapter) => chapter.beats);
    return { franchiseId: state.franchiseId, workId: state.workId, volumeId: state.volumeId, completedProcesses: state.completedProcesses, currentChapterNo: state.currentChapterNo, currentBeatNo: state.currentBeatNo, completedBeats: beats.filter((beat) => beat.status === "complete").length, totalBeats: beats.length, ...(state.lastConsistencyFailure ? { lastConsistencyFailure: state.lastConsistencyFailure } : {}) };
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
  return parseLocatorFields(object);
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
function parseLocatorFields(object: Record<string, unknown>): LocatorInput {
  const franchiseId = object.franchiseId === undefined ? undefined : assertSafeId(object.franchiseId, "franchiseId");
  const workId = object.workId === undefined ? undefined : assertSafeId(object.workId, "workId");
  const volumeId = object.volumeId === undefined ? undefined : assertSafeId(object.volumeId, "volumeId");
  if (object.current !== undefined && typeof object.current !== "boolean") throw new Error("current must be a boolean.");
  const current = object.current;
  if (current && (franchiseId !== undefined || workId !== undefined || volumeId !== undefined)) {
    throw new Error("current=true cannot be combined with explicit franchiseId, workId, or volumeId.");
  }
  return { franchiseId, workId, volumeId, current };
}
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
function completeProcess(state: VolumeState, processId: ProcessId): void {
  const order: ProcessId[] = ["franchise.world", "franchise.setting", "work.world", "work.setting", "volume.world", "volume.setting", "volume.outline", "volume.writing", "volume.epub", "volume.complete"];
  const index = order.indexOf(processId);
  if (index < 0) throw new Error(`Unknown pipeline process: ${processId}.`);
  state.completedProcesses = order.slice(0, Math.max(state.completedProcesses.length, index + 1));
  state.updatedAt = new Date().toISOString();
}
function removeCompletedProcesses(state: VolumeState, processIds: ProcessId[]): void { state.completedProcesses = state.completedProcesses.filter((processId) => !processIds.includes(processId)); state.updatedAt = new Date().toISOString(); }
function recoverActiveAction(state: VolumeState): void { if (!state.activeAction) return; state.activeAction = undefined; state.updatedAt = new Date().toISOString(); }
function legacyRequiredAction(status: PipelineStatus): string {
  if (status.requiredAction === "submit_document") return `submit_${status.target?.document ?? "document"}`;
  if (status.requiredAction === "finalize_document") return `finalize_${status.target?.document ?? "document"}`;
  return status.requiredAction;
}
function newVolumeState(input: { franchiseId: string; franchiseName: string; workId: string; workTitle: string; volumeId: string; volumeTitle: string; completedProcesses: ProcessId[] }): VolumeState { const now = new Date().toISOString(); return validateVolumeState({ schemaVersion: CURRENT_STATE_SCHEMA_VERSION, ...input, currentChapterNo: 1, currentBeatNo: 1, chapters: [], createdAt: now, updatedAt: now }); }
function errorMessage(error: unknown, root?: string): string { const secretRedacted = redactErrorMessage(error).replace(PIPELINE_ERROR_CONTROL_CHARS_GLOBAL, " "); const redacted = root ? secretRedacted.split(root).join("<data-root>") : secretRedacted; return truncatePipelineText(redacted, MAX_SUMMARY_TEXT_CHARS, MAX_SUMMARY_TEXT_BYTES); }
function truncatePipelineText(value: string, maxChars: number, maxBytes: number): string { if (value.length <= maxChars && utf8ByteLengthUpTo(value, maxBytes) <= maxBytes) return value; return `${value.slice(0, maxChars)}... [truncated]`; }
