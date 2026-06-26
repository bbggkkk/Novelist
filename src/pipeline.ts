import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { StubNovelAgents } from "./agents.js";
import { buildEpubArchive } from "./epub.js";
import { ExecutionDeadline, type ExecutionSignal } from "./execution.js";
import { runExternalEpubCheck } from "./externalEpubCheck.js";
import type { ExternalEpubCheckResult } from "./externalEpubCheck.js";
import { redactErrorMessage, redactInlineSecrets } from "./redaction.js";
import { NovelStorage, slugify, type StorageHealthCheck } from "./storage.js";
import {
  assertBoundedNonEmptyString,
  assertBoundedNonEmptySingleLineString,
  assertNonEmptyString,
  assertObject,
  assertRevisionTargetString,
  assertSafeId,
  assertShape,
  asOptionalBoundedSingleLineString,
  asOptionalBoundedString
} from "./validation.js";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import type {
  BuildEpubInput,
  ChapterState,
  ConfirmInput,
  ContinueInput,
  AgentResult,
  AgentContext,
  ConflictRecord,
  NewProjectInput,
  NovelAgents,
  ReviseInput,
  ToolResult,
  VolumeState
} from "./types.js";
import { CURRENT_STATE_SCHEMA_VERSION } from "./types.js";
import { validateEpubArchive } from "./epub.js";
import { validateVolumeState } from "./stateValidation.js";

const MAX_AGENT_TEXT_CHARS = 8 * 1024 * 1024;
const MAX_AGENT_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_AGENT_ISSUES = 100;
const MAX_AGENT_ISSUE_CHARS = 4000;
const MAX_AGENT_ISSUE_BYTES = 4000;
const MAX_AGENT_CONFLICT_FIELD_CHARS = 4000;
const MAX_REVIEW_ISSUES = 50;
const MAX_REVIEW_ISSUE_CHARS = 1000;
const MAX_REVIEW_ISSUE_BYTES = 4000;
const MAX_TITLE_INPUT_CHARS = 512;
const MAX_TITLE_INPUT_BYTES = 512;
const MAX_OPTION_INPUT_CHARS = 256;
const MAX_OPTION_INPUT_BYTES = 256;
const MAX_INSTRUCTION_INPUT_CHARS = 16 * 1024;
const MAX_INSTRUCTION_INPUT_BYTES = 16 * 1024;
const MAX_SUMMARY_ITEMS = 20;
const MAX_SUMMARY_TEXT_CHARS = 1000;
const MAX_SUMMARY_TEXT_BYTES = 4000;
const MAX_SKIPPED_STATE_DIAGNOSTICS = 20;
const MAX_SKIPPED_STATE_DIAGNOSTIC_CHARS = 180;
const MAX_SKIPPED_STATE_DIAGNOSTIC_BYTES = 720;
const MAX_HEALTH_ERROR_CHARS = 4000;
const MAX_HEALTH_ERROR_BYTES = 16 * 1024;
const MAX_STATE_SCAN_CANDIDATES = 100000;
const MAX_STORED_CONFIRMATIONS = 1000;
const MAX_STORED_CONFLICTS = 1000;
const MAX_RUNTIME_BEAT_RETRY_COUNT = 1000;
const MAX_PIPELINE_ERROR_CHARS = 4000;
const MAX_PIPELINE_ERROR_BYTES = 16 * 1024;
const MAX_PIPELINE_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PIPELINE_REVIEW_RETRIES = 20;
const MAX_PIPELINE_CONCURRENT_JOBS = 64;
const MAX_PIPELINE_TOTAL_JOBS = 100000;
const MIN_PIPELINE_STDIO_LINE_LENGTH = 256;
const MAX_PIPELINE_STDIO_LINE_LENGTH = 16 * 1024 * 1024;
const MAX_PIPELINE_OPENAI_BASE_URL_LENGTH = 2048;
const MAX_PIPELINE_OPENAI_BASE_URL_BYTES = 2048;
const MAX_PIPELINE_OPENAI_MODEL_LENGTH = 200;
const MAX_PIPELINE_OPENAI_MODEL_BYTES = 200;
const MAX_PIPELINE_OPENAI_API_KEY_LENGTH = 4096;
const MAX_PIPELINE_OPENAI_API_KEY_BYTES = 4096;
const MAX_PIPELINE_STORAGE_ROOT_CHARS = 4096;
const MAX_PIPELINE_STORAGE_ROOT_BYTES = 4096;
const MAX_PIPELINE_EPUBCHECK_COMMAND_LENGTH = 1024;
const MAX_PIPELINE_EPUBCHECK_COMMAND_BYTES = 1024;
const MAX_PIPELINE_EPUBCHECK_ARGS = 64;
const MAX_PIPELINE_EPUBCHECK_ARG_LENGTH = 4096;
const MAX_PIPELINE_EPUBCHECK_ARG_BYTES = 4096;
const PIPELINE_ERROR_CONTROL_CHARS_GLOBAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const PIPELINE_CONFIG_FIELDS = new Set<keyof AppConfig>([
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

export class NovelPipeline {
  private readonly storage: NovelStorage;
  private readonly agents: NovelAgents;
  private readonly config: AppConfig;

  constructor(
    storage = new NovelStorage(),
    agents: NovelAgents = new StubNovelAgents(),
    config: AppConfig = loadConfig()
  ) {
    this.storage = validatePipelineStorage(storage);
    this.agents = validatePipelineAgents(agents);
    this.config = validatePipelineConfig(config);
  }

  async newProject(input: NewProjectInput, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      const deadline = new ExecutionDeadline(this.config.operationTimeoutMs, signal);
      const parsed = parseNewProjectInput(input);
      const franchiseId = slugify(parsed.franchiseName);
      const workTitle = parsed.workRequest;
      const workId = slugify(workTitle);
      const volumeTitle = parsed.volumeRequest || `${workTitle} 1권`;
      const volumeId = slugify(volumeTitle);
      return this.storage.withCreationLock(franchiseId, workId, volumeId, async () => {
      deadline.assertActive("creating a new project");
      if (await this.storage.stateExists(franchiseId, workId, volumeId)) {
        throw new Error(
          `Volume already exists: franchiseId=${franchiseId}, workId=${workId}, volumeId=${volumeId}. Use novel_continue, novel_status, or novel_revise.`
        );
      }
      const now = new Date().toISOString();
      deadline.assertActive("planning the initial outline");
      const initialPlan = validateAgentResult(await this.agents.planInitial(parsed), "planner.initial");
      deadline.assertActive("saving the initial outline");
      const confirmationId = createId("confirm");
      const state: VolumeState = {
        franchiseId,
        schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
        franchiseName: parsed.franchiseName,
        workId,
        workTitle,
        volumeId,
        volumeTitle,
        status: "pending_user_confirmation",
        currentChapterNo: 1,
        currentBeatNo: 1,
        confirmations: [
          {
            id: confirmationId,
            kind: "initial_outline",
            message: initialPlan.text,
            createdAt: now
          }
        ],
        conflicts: [],
        chapters: defaultChapters(),
        createdAt: now,
        updatedAt: now
      };
      await this.storage.writeOutline(state, initialPlan.text);
      try {
        await this.storage.saveState(state);
      } catch (error) {
        try {
          await this.storage.deleteOutline(state);
        } catch (cleanupError) {
          throw new Error(`${errorMessage(error, this.storage.root)} Initial outline cleanup failed: ${errorMessage(cleanupError, this.storage.root)}`);
        }
        throw error;
      }
      return {
        status: "pending_user_confirmation",
        message: "대략 전개안을 생성했습니다. novel_confirm으로 승인하거나 수정 지시를 전달하세요.",
        data: {
          confirmationId,
          franchiseId,
          workId,
          volumeId,
          outline: initialPlan.text
        }
      };
      });
    });
  }

  async health(input: unknown = {}): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      assertShape(input, "novel_health arguments", {});
      const storage = await this.storage.healthCheck();
      const publicStorage = publicStorageHealth(storage, this.storage.root);
      const agent = agentHealth(this.config);
      const healthy = publicStorage.writable && publicStorage.jobStoreReadable && agent.ready;
      return {
        status: healthy ? "ok" : "blocked",
        message: healthy ? "Novelist MCP server is healthy." : "Novelist MCP server health checks failed.",
        data: {
          storage: publicStorage,
          agent,
          stateSchemaVersion: CURRENT_STATE_SCHEMA_VERSION,
          operationTimeoutMs: this.config.operationTimeoutMs,
          reviewMaxRetries: this.config.reviewMaxRetries,
          jobRetentionMs: this.config.jobRetentionMs,
          maxConcurrentJobs: this.config.maxConcurrentJobs,
          maxJobs: this.config.maxJobs,
          stdioMaxLineLength: this.config.stdioMaxLineLength,
          epubCheckConfigured: Boolean(this.config.epubCheckCommand),
          timestamp: new Date().toISOString()
        }
      };
    });
  }

  async confirm(input: ConfirmInput, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      const deadline = new ExecutionDeadline(this.config.operationTimeoutMs, signal);
      const parsed = parseConfirmInput(input);
      deadline.assertActive("locating confirmation");
      const located = await this.findStateByConfirmation(parsed.confirmationId);
      let shouldContinue: ContinueInput | undefined;
      const result: ToolResult = await this.storage.withVolumeLock(located.franchiseId, located.workId, located.volumeId, async () => {
      deadline.assertActive("confirming user decision");
      const state = await this.storage.loadState(located.franchiseId, located.workId, located.volumeId);
      const confirmation = state.confirmations.find((item) => item.id === parsed.confirmationId);
      if (!confirmation) {
        throw new Error(`Confirmation not found: ${input.confirmationId}`);
      }
      if (confirmation.resolvedAt) {
        throw new Error(`Confirmation already resolved: ${input.confirmationId}`);
      }
      confirmation.resolvedAt = new Date().toISOString();
      state.updatedAt = confirmation.resolvedAt;
      confirmation.approved = parsed.approved;
      if (!parsed.approved || parsed.revisionInstruction !== undefined) {
        confirmation.revisionInstruction = parsed.revisionInstruction;
      }

      if (!parsed.approved) {
        confirmation.resolvedAt = undefined;
        confirmation.approved = undefined;
        state.status = "pending_user_confirmation";
        await this.storage.saveState(state);
        return {
          status: "pending_user_confirmation",
          message: "수정 지시를 저장했습니다. 다시 승인하려면 novel_confirm을 호출하세요.",
          data: { confirmationId: parsed.confirmationId }
        };
      }

      if (confirmation.kind === "conflict_resolution") {
        for (const conflict of state.conflicts) {
          if (!conflict.resolved) {
            conflict.resolved = true;
          }
        }
        resetCurrentRevisionAfterConfirmation(state, confirmation.revisionInstruction);
        state.status = "drafting";
        await this.storage.saveState(state);
        shouldContinue = { franchiseId: state.franchiseId, workId: state.workId, volumeId: state.volumeId };
        return {
          status: "drafting",
          message: "충돌 해결 확인을 반영했고 다음 비트 작성을 재개할 수 있습니다.",
          data: summarizeState(state)
        };
      }

      state.status = "planning";
      const approvedInstruction = confirmationTextForPlanning(confirmation);
      deadline.assertActive("building the world");
      const world = validateAgentResult(await this.agents.buildWorld(
        {
          franchiseName: state.franchiseName,
          workRequest: state.workTitle,
          volumeRequest: state.volumeTitle
        },
        approvedInstruction
      ), "worldbuilder");
      deadline.assertActive("writing world files");
      const previousWorld = await this.storage.readWorldFile(state);
      const previousWork = await this.storage.readWorkFile(state);
      const previousOutline = await this.storage.readOutlineFile(state);
      let worldWritten = false;
      let workWritten = false;
      let outlineWritten = false;
      try {
        await this.storage.writeWorld(state, world.text);
        worldWritten = true;
        await this.storage.writeWork(state, `# ${state.workTitle}\n\n${approvedInstruction}`);
        workWritten = true;

        deadline.assertActive("planning the volume skeleton");
        const skeleton = validateAgentResult(await this.agents.planSkeleton(cloneVolumeState(state), {
          franchiseName: state.franchiseName,
          workRequest: state.workTitle,
          volumeRequest: state.volumeTitle
        }), "planner.skeleton");
        deadline.assertActive("saving planned state");
        await this.storage.writeOutline(state, skeleton.text);
        outlineWritten = true;
        state.status = "drafting";
        await this.storage.saveState(state);
      } catch (error) {
        try {
          if (outlineWritten && previousOutline !== undefined) {
            await this.storage.writeOutlineFile(state, previousOutline);
          } else if (outlineWritten) {
            await this.storage.deleteOutline(state);
          }
          if (workWritten && previousWork !== undefined) {
            await this.storage.writeWorkFile(state, previousWork);
          } else if (workWritten) {
            await this.storage.deleteWork(state);
          }
          if (worldWritten && previousWorld !== undefined) {
            await this.storage.writeWorldFile(state, previousWorld);
          } else if (worldWritten) {
            await this.storage.deleteWorld(state);
          }
        } catch (cleanupError) {
          throw new Error(`${errorMessage(error, this.storage.root)} Planned artifact cleanup failed: ${errorMessage(cleanupError, this.storage.root)}`);
        }
        throw error;
      }
      shouldContinue = { franchiseId: state.franchiseId, workId: state.workId, volumeId: state.volumeId };
      return {
        status: "drafting",
        message: "사용자 확인을 반영했고 다음 비트 작성을 시작할 수 있습니다.",
        data: summarizeState(state)
      };
      });
      return shouldContinue ? this.continue(shouldContinue, signal) : result;
    });
  }

  async continue(input: ContinueInput, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      const deadline = new ExecutionDeadline(this.config.operationTimeoutMs, signal);
      const resolved = await this.resolveState(parseContinueInput(input));
      return this.storage.withVolumeLock(resolved.franchiseId, resolved.workId, resolved.volumeId, async () => {
      deadline.assertActive("continuing the pipeline");
      const state = await this.storage.loadState(resolved.franchiseId, resolved.workId, resolved.volumeId);
      if (state.status === "pending_user_confirmation") {
        return {
          status: state.status,
          message: "사용자 확인 대기 중입니다.",
          data: summarizeState(state)
        };
      }
      if (state.status === "blocked") {
        return {
          status: "blocked",
          message: "파이프라인이 차단 상태입니다. 상태를 검토한 뒤 수정 또는 수동 해제를 진행하세요.",
          data: summarizeState(state)
        };
      }
      if (state.status === "complete") {
        return {
          status: "complete",
          message: "이미 모든 비트 작성이 완료되었습니다.",
          data: summarizeState(state)
        };
      }

      const beat = findCurrentBeat(state);
      if (!beat) {
        state.status = "complete";
        await this.storage.saveState(state);
        return { status: "complete", message: "모든 비트 작성이 완료되었습니다.", data: summarizeState(state) };
      }

      state.status = "reviewing";
      deadline.assertActive("loading previous beat text");
      const previousBeatText = await this.previousBeatText(state);
      deadline.assertActive("writing the beat");
      const draft = validateAgentResult(await this.agents.writeBeat(agentContextForBeat(state, beat, previousBeatText)), "writer");
      deadline.assertActive("editing the beat");
      const edited = validateAgentResult(await this.agents.editBeat(agentContextForBeat(state, beat, previousBeatText), draft.text), "editor.beat");
      deadline.assertActive("proofreading the beat");
      const proofread = validateAgentResult(await this.agents.proofreadBeat(agentContextForBeat(state, beat, previousBeatText), edited.text), "proofreader.beat");
      deadline.assertActive("checking beat continuity");
      const continuity = validateAgentResult(await this.agents.checkContinuity(agentContextForBeat(state, beat, previousBeatText), proofread.text), "continuity.beat");
      deadline.assertActive("reviewing beat feedback");
      const issues = reviewIssues([draft.issues, edited.issues, proofread.issues, continuity.issues]);

      if (continuity.conflict) {
        appendConflict(state, continuity.conflict);
      }
      const blockingIssues = unresolvedBlockingConflictFeedback(state);
      const allIssues = [...issues, ...blockingIssues];

      if (allIssues.length > 0) {
        incrementBeatRetryCount(beat);
        beat.lastFeedback = allIssues.join("\n");
        beat.status = "needs_revision";
        if (beat.retryCount > this.config.reviewMaxRetries || blockingIssues.length > 0) {
          state.status = "pending_user_confirmation";
          const confirmationId = createId("confirm");
          appendConfirmation(state, {
            id: confirmationId,
            kind: "conflict_resolution",
            message: `비트 검수 중 문제가 발견되었습니다.\n\n${beat.lastFeedback}`,
            createdAt: new Date().toISOString()
          });
          await this.storage.saveState(state);
          return {
            status: "pending_user_confirmation",
            message: "검수 문제가 반복되었거나 설정 충돌이 발견되어 사용자 확인이 필요합니다.",
            data: { confirmationId, issues: summarizeIssues(allIssues) }
          };
        }
        state.status = "drafting";
        await this.storage.saveState(state);
        return {
          status: "drafting",
          message: "검수 피드백을 저장했습니다. novel_continue를 다시 호출하면 같은 비트를 재작성합니다.",
          data: { beat: summarizeBeat(beat), issues: summarizeIssues(allIssues) }
        };
      }

      const joined = previousBeatText ? `${previousBeatText}\n\n${continuity.text}` : continuity.text;
      deadline.assertActive("editing joined beats");
      const joinedEdit = validateAgentResult(await this.agents.editJoinedBeats(agentContextForBeat(state, beat, previousBeatText), joined), "editor.joined");
      deadline.assertActive("proofreading joined beats");
      const joinedProof = validateAgentResult(await this.agents.proofreadBeat(agentContextForBeat(state, beat, previousBeatText), joinedEdit.text), "proofreader.joined");
      deadline.assertActive("checking joined beat continuity");
      const joinedContinuity = validateAgentResult(await this.agents.checkContinuity(agentContextForBeat(state, beat, previousBeatText), joinedProof.text), "continuity.joined");
      deadline.assertActive("reviewing joined beat feedback");
      const joinedIssues = reviewIssues([joinedEdit.issues, joinedProof.issues, joinedContinuity.issues]);
      if (joinedContinuity.conflict) {
        appendConflict(state, joinedContinuity.conflict);
      }
      const joinedBlockingIssues = unresolvedBlockingConflictFeedback(state);
      const allJoinedIssues = [...joinedIssues, ...joinedBlockingIssues];
      if (allJoinedIssues.length > 0) {
        incrementBeatRetryCount(beat);
        beat.lastFeedback = allJoinedIssues.join("\n");
        beat.status = "needs_revision";
        if (beat.retryCount > this.config.reviewMaxRetries || joinedBlockingIssues.length > 0) {
          state.status = "pending_user_confirmation";
          const confirmationId = createId("confirm");
          appendConfirmation(state, {
            id: confirmationId,
            kind: "conflict_resolution",
            message: `연결성 검수 중 문제가 발견되었습니다.\n\n${beat.lastFeedback}`,
            createdAt: new Date().toISOString()
          });
          await this.storage.saveState(state);
          return {
            status: "pending_user_confirmation",
            message: "연결성 검수 문제가 반복되었거나 설정 충돌이 발견되어 사용자 확인이 필요합니다.",
            data: { confirmationId, issues: summarizeIssues(allJoinedIssues) }
          };
        }
        state.status = "drafting";
        await this.storage.saveState(state);
        return {
          status: "drafting",
          message: "연결성 검수 피드백을 저장했습니다. 같은 비트를 재작성합니다.",
          data: { beat: summarizeBeat(beat), issues: summarizeIssues(allJoinedIssues) }
        };
      }

      deadline.assertActive("saving completed beat");
      const previousState = cloneVolumeState(state);
      const previousBeatFile = await this.storage.readBeatFile(state, beat.chapterNo, beat.beatNo);
      const beatPath = await this.storage.writeBeat(state, beat.chapterNo, beat.beatNo, joinedContinuity.text);
      beat.status = "complete";
      beat.lastFeedback = undefined;
      advanceCursor(state);
      state.status = findCurrentBeat(state) ? "drafting" : "complete";
      try {
        await this.storage.saveState(state);
      } catch (error) {
        try {
          if (previousBeatFile === undefined) {
            await this.storage.deleteBeat(previousState, beat.chapterNo, beat.beatNo);
          } else {
            await this.storage.writeBeatFile(previousState, beat.chapterNo, beat.beatNo, previousBeatFile);
          }
        } catch (cleanupError) {
          throw new Error(`${errorMessage(error, this.storage.root)} Beat artifact cleanup failed: ${errorMessage(cleanupError, this.storage.root)}`);
        }
        throw error;
      }
      return {
        status: state.status,
        message: state.status === "complete" ? "모든 비트 작성이 완료되었습니다." : "비트 작성과 검수가 완료되었습니다.",
        data: { beatPath, next: summarizeState(state) }
      };
      });
    });
  }

  async status(input: Partial<ContinueInput> = {}): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      const state = await this.resolveState(parseContinueInput(input));
      return {
        status: state.status,
        message: "현재 소설 파이프라인 상태입니다.",
        data: summarizeState(state)
      };
    });
  }

  async revise(input: ReviseInput, signal?: ExecutionSignal): Promise<ToolResult> {
    return this.withRootRedaction(async () => {
      const deadline = new ExecutionDeadline(this.config.operationTimeoutMs, signal);
      const parsed = parseReviseInput(input);
      await this.storage.withVolumeLock(parsed.franchiseId, parsed.workId, parsed.volumeId, async () => {
      deadline.assertActive("marking a beat for revision");
      const state = await this.storage.loadState(parsed.franchiseId, parsed.workId, parsed.volumeId);
      const beat = findBeatByTarget(state, parsed.target);
      if (!beat) {
        throw new Error(
          `Revision target not found: ${parsed.target}. Use chapter:<n>,beat:<n>, chapter:<n> beat:<n>, <chapter>-<beat>, or <chapter>/<beat>.`
        );
      }
      assertRevisionTargetDoesNotSkipIncompleteBeat(state, beat);
      const previousState = cloneVolumeState(state);
      const previousEpub = previousState.status === "complete" ? await readRestorableEpub(this.storage, previousState) : undefined;
      if (state.status === "blocked") {
        for (const conflict of state.conflicts) {
          if (conflict.severity === "blocking" && !conflict.resolved) {
            conflict.resolved = true;
          }
        }
      }
      state.currentChapterNo = beat.chapterNo;
      state.currentBeatNo = beat.beatNo;
      state.status = "drafting";
      beat.status = "needs_revision";
      beat.lastFeedback = parsed.instruction;
      incrementBeatRetryCount(beat);
      await this.storage.deleteEpub(state);
      try {
        await this.storage.saveState(state);
      } catch (error) {
        if (previousEpub) {
          try {
            await this.storage.writeEpub(previousState, previousEpub);
          } catch (restoreError) {
            throw new Error(
              `Revision state publish failed and previous EPUB restore failed: ${redactErrorMessage(error)}; restore: ${redactErrorMessage(restoreError)}`
            );
          }
        }
        throw error;
      }
      });
      return this.continue({ franchiseId: parsed.franchiseId, workId: parsed.workId, volumeId: parsed.volumeId }, signal);
    });
  }

  async buildEpub(input: BuildEpubInput, signal?: ExecutionSignal): Promise<ToolResult> {
    const deadline = new ExecutionDeadline(this.config.operationTimeoutMs, signal);
    const parsed = parseBuildEpubInput(input);
    try {
      return await this.storage.withVolumeLock(parsed.franchiseId, parsed.workId, parsed.volumeId, async () => {
        deadline.assertActive("building epub");
        const state = await this.storage.loadState(parsed.franchiseId, parsed.workId, parsed.volumeId);
        if (state.status !== "complete") {
          throw new Error("EPUB can only be built for a complete volume.");
        }
        deadline.assertActive("collecting volume markdown");
        const markdown = await this.storage.collectVolumeMarkdown(state);
        deadline.assertActive("preparing epub content");
        const epub = validateAgentResult(await this.agents.buildEpub({ state: cloneVolumeState(state) }, markdown), "epub_builder");
        deadline.assertActive("building epub archive");
        const archive = buildEpubArchive(state, epub.text);
        deadline.assertActive("writing epub candidate archive");
        const candidatePath = await this.storage.writeEpubCandidate(state, archive);
        let path = candidatePath;
        let internalValidation;
        let externalValidation;
        try {
          internalValidation = validateEpubArchive(archive);
          if (!internalValidation.valid) {
            throw new Error(`Internal EPUB validation failed: ${internalValidation.issues.join("; ")}`);
          }
          deadline.assertActive("running external epub validator");
          const externalValidatorTimeoutMs = deadline.requireRemainingMs("running external epub validator");
          externalValidation = redactExternalEpubCheckResult(
            await runExternalEpubCheck(candidatePath, this.config, externalValidatorTimeoutMs),
            this.storage.root
          );
          deadline.assertActive("validating external epub result");
          if (!externalValidation.valid) {
            throw new Error(`External EPUB validation failed: ${externalValidation.error ?? externalValidation.stderr ?? "unknown error"}`);
          }
          deadline.assertActive("promoting epub archive");
          path = await this.storage.promoteEpubCandidate(state, candidatePath);
        } catch (error) {
          try {
            await this.storage.deleteEpubCandidate(state, candidatePath);
          } catch (cleanupError) {
            throw new Error(`${errorMessage(error, this.storage.root)} Candidate cleanup failed: ${errorMessage(cleanupError, this.storage.root)}`);
          }
          throw error;
        }
        return {
          status: "ok",
          message: "EPUB file was built.",
          data: { path, bytes: archive.length, validation: { internal: internalValidation, external: externalValidation } }
        };
      });
    } catch (error) {
      throw new Error(errorMessage(error, this.storage.root));
    }
  }

  private async withRootRedaction<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new Error(errorMessage(error, this.storage.root));
    }
  }

  private async resolveState(input: Partial<ContinueInput>): Promise<VolumeState> {
    const hasExplicitIds = Boolean(input.franchiseId || input.workId || input.volumeId);
    if (input.current && hasExplicitIds) {
      throw new Error("current cannot be combined with franchiseId, workId, or volumeId.");
    }
    if (input.current || !hasExplicitIds) {
      const current = await this.storage.loadCurrentState();
      if (current) {
        return current;
      }
      const fallback = await this.findSingleLoadableState();
      if (fallback) {
        return fallback;
      }
      throw new Error("No current novel pipeline found.");
    }
    if (!input.franchiseId || !input.workId || !input.volumeId) {
      throw new Error("franchiseId, workId, and volumeId are required unless current is true.");
    }
    return this.storage.loadState(input.franchiseId, input.workId, input.volumeId);
  }

  private async findSingleLoadableState(): Promise<VolumeState | undefined> {
    let found: VolumeState | undefined;
    let foundCount = 0;
    let scannedStateCount = 0;
    let skippedStateCount = 0;
    const skippedStates: string[] = [];
    for (const franchiseId of await this.storage.listFranchises()) {
      for (const workId of await this.storage.listWorks(franchiseId)) {
        for (const volumeId of await this.storage.listVolumes(franchiseId, workId)) {
          scannedStateCount += 1;
          if (scannedStateCount > MAX_STATE_SCAN_CANDIDATES) {
            throw stateScanLimitError();
          }
          try {
            const state = await this.storage.loadState(franchiseId, workId, volumeId);
            found = state;
            foundCount += 1;
            if (foundCount > 1) {
              throw new Error("No current novel pipeline found. Multiple volume states exist; provide franchiseId, workId, and volumeId explicitly.");
            }
          } catch (error) {
            if (/Multiple volume states/.test(redactErrorMessage(error))) {
              throw error;
            }
            skippedStateCount += 1;
            if (skippedStates.length < MAX_SKIPPED_STATE_DIAGNOSTICS) {
              skippedStates.push(skippedStateDiagnostic(franchiseId, workId, volumeId, error, this.storage.root));
            }
          }
        }
      }
    }
    if (skippedStateCount > 0) {
      const truncatedCount = skippedStateCount - skippedStates.length;
      const truncation = truncatedCount > 0 ? ` truncated ${truncatedCount} unreadable states from diagnostics.` : "";
      throw new Error(
        `No current novel pipeline found. Skipped ${skippedStateCount} unreadable volume states.${truncation} Details: ${skippedStates.join(
          "; "
        )}; provide explicit IDs for a readable volume.`
      );
    }
    if (found) {
      return found;
    }
    return undefined;
  }

  private async findStateByConfirmation(confirmationId: string): Promise<VolumeState> {
    const franchises = await this.storage.listFranchises();
    const skippedStates: string[] = [];
    let scannedStateCount = 0;
    let skippedStateCount = 0;
    for (const franchiseId of franchises) {
      const works = await this.storage.listWorks(franchiseId);
      for (const workId of works) {
        const volumes = await this.storage.listVolumes(franchiseId, workId);
        for (const volumeId of volumes) {
          scannedStateCount += 1;
          if (scannedStateCount > MAX_STATE_SCAN_CANDIDATES) {
            throw stateScanLimitError();
          }
          let state: VolumeState;
          try {
            state = await this.storage.loadState(franchiseId, workId, volumeId);
          } catch (error) {
            skippedStateCount += 1;
            if (skippedStates.length < MAX_SKIPPED_STATE_DIAGNOSTICS) {
              skippedStates.push(skippedStateDiagnostic(franchiseId, workId, volumeId, error, this.storage.root));
            }
            continue;
          }
          if (state.confirmations.some((item) => item.id === confirmationId)) {
            return state;
          }
        }
      }
    }
    if (skippedStateCount > 0) {
      const truncatedCount = skippedStateCount - skippedStates.length;
      const truncation = truncatedCount > 0 ? ` truncated ${truncatedCount} unreadable states from diagnostics.` : "";
      throw new Error(
        `Confirmation not found: ${confirmationId}. Skipped ${skippedStateCount} unreadable states.${truncation} Details: ${skippedStates.join("; ")}`
      );
    }
    throw new Error(`Confirmation not found: ${confirmationId}`);
  }

  private async previousBeatText(state: VolumeState): Promise<string> {
    const previous = previousBeat(state);
    if (!previous) {
      return "";
    }
    return this.storage.readBeat(state, previous.chapterNo, previous.beatNo);
  }
}

function parseNewProjectInput(input: unknown): NewProjectInput {
  const object = assertShape(input, "novel_new_project arguments", {
    franchiseName: "string",
    workRequest: "string",
    volumeRequest: "optionalString",
    genre: "optionalString",
    tone: "optionalString",
    targetLength: "optionalString"
  });
  const volumeRequest = asOptionalBoundedSingleLineString(object.volumeRequest, "volumeRequest", MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES);
  const genre = asOptionalBoundedSingleLineString(object.genre, "genre", MAX_OPTION_INPUT_CHARS, MAX_OPTION_INPUT_BYTES);
  const tone = asOptionalBoundedSingleLineString(object.tone, "tone", MAX_OPTION_INPUT_CHARS, MAX_OPTION_INPUT_BYTES);
  const targetLength = asOptionalBoundedSingleLineString(object.targetLength, "targetLength", MAX_OPTION_INPUT_CHARS, MAX_OPTION_INPUT_BYTES);
  return {
    franchiseName: assertBoundedNonEmptySingleLineString(object.franchiseName, "franchiseName", MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES),
    workRequest: assertBoundedNonEmptySingleLineString(object.workRequest, "workRequest", MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES),
    ...(volumeRequest ? { volumeRequest } : {}),
    ...(genre ? { genre } : {}),
    ...(tone ? { tone } : {}),
    ...(targetLength ? { targetLength } : {})
  };
}

function parseConfirmInput(input: unknown): ConfirmInput {
  const object = assertShape(input, "novel_confirm arguments", {
    confirmationId: "string",
    approved: "boolean",
    revisionInstruction: "optionalString"
  });
  const approved = object.approved as boolean;
  const revisionInstruction = asOptionalBoundedString(object.revisionInstruction, "revisionInstruction", MAX_INSTRUCTION_INPUT_CHARS, MAX_INSTRUCTION_INPUT_BYTES);
  if (!approved && revisionInstruction === undefined) {
    throw new Error("revisionInstruction is required when approved is false.");
  }
  return {
    confirmationId: assertSafeId(object.confirmationId, "confirmationId"),
    approved,
    revisionInstruction
  };
}

function parseContinueInput(input: unknown): ContinueInput {
  const object = assertShape(input ?? {}, "novel_continue arguments", {
    franchiseId: "optionalString",
    workId: "optionalString",
    volumeId: "optionalString",
    current: "optionalBoolean"
  });
  const hasExplicitIds = Boolean(object.franchiseId || object.workId || object.volumeId);
  if (object.current && hasExplicitIds) {
    throw new Error("current cannot be combined with franchiseId, workId, or volumeId.");
  }
  if (object.current === false && !hasExplicitIds) {
    throw new Error("current:false requires franchiseId, workId, and volumeId.");
  }
  if (hasExplicitIds && (!object.franchiseId || !object.workId || !object.volumeId)) {
    throw new Error("franchiseId, workId, and volumeId are required together.");
  }
  return {
    franchiseId: object.franchiseId === undefined ? undefined : assertSafeId(object.franchiseId, "franchiseId"),
    workId: object.workId === undefined ? undefined : assertSafeId(object.workId, "workId"),
    volumeId: object.volumeId === undefined ? undefined : assertSafeId(object.volumeId, "volumeId"),
    current: object.current as boolean | undefined
  };
}

function parseReviseInput(input: unknown): ReviseInput {
  const object = assertShape(input, "novel_revise arguments", {
    franchiseId: "string",
    workId: "string",
    volumeId: "string",
    target: "string",
    instruction: "string"
  });
  return {
    franchiseId: assertSafeId(object.franchiseId, "franchiseId"),
    workId: assertSafeId(object.workId, "workId"),
    volumeId: assertSafeId(object.volumeId, "volumeId"),
    target: assertRevisionTargetString(object.target, "target", MAX_OPTION_INPUT_CHARS, MAX_OPTION_INPUT_BYTES),
    instruction: assertBoundedNonEmptyString(object.instruction, "instruction", MAX_INSTRUCTION_INPUT_CHARS, MAX_INSTRUCTION_INPUT_BYTES)
  };
}

function parseBuildEpubInput(input: unknown): BuildEpubInput {
  const object = assertShape(input, "novel_build_epub arguments", {
    franchiseId: "string",
    workId: "string",
    volumeId: "string"
  });
  return {
    franchiseId: assertSafeId(object.franchiseId, "franchiseId"),
    workId: assertSafeId(object.workId, "workId"),
    volumeId: assertSafeId(object.volumeId, "volumeId")
  };
}

function validateAgentResult(value: unknown, label: string): AgentResult {
  const result = assertObject(value, `Agent result from ${label}`);
  assertOnlyFields(result, `Agent result from ${label}`, ["text", "issues", "conflict"]);
  const text = boundedNonEmptyString(result.text, `Agent result from ${label}.text`, MAX_AGENT_TEXT_CHARS, MAX_AGENT_TEXT_BYTES);
  const issues = boundedAgentIssueArray(result.issues, `Agent result from ${label}.issues`);
  const hasConflict = Object.prototype.hasOwnProperty.call(result, "conflict");
  if (hasConflict && (result.conflict === undefined || result.conflict === null)) {
    throw new Error(`Agent result from ${label}.conflict must be omitted or a conflict object.`);
  }
  const conflict = hasConflict ? validateAgentConflict(result.conflict, label) : undefined;
  return { text, issues, conflict };
}

function validatePipelineStorage(value: unknown): NovelStorage {
  assertNoSymbolInjectionProperties(value, "NovelPipeline.storage");
  const methods = [
    "withCreationLock",
    "stateExists",
    "writeOutline",
    "saveState",
    "deleteOutline",
    "healthCheck",
    "withVolumeLock",
    "loadState",
    "readWorldFile",
    "readWorkFile",
    "readOutlineFile",
    "writeWorld",
    "writeWorldFile",
    "writeWork",
    "writeWorkFile",
    "writeOutlineFile",
    "deleteWork",
    "deleteWorld",
    "readBeat",
    "readBeatFile",
    "writeBeat",
    "writeBeatFile",
    "deleteBeat",
    "deleteEpub",
    "collectVolumeMarkdown",
    "writeEpubCandidate",
    "promoteEpubCandidate",
    "deleteEpubCandidate",
    "loadCurrentState",
    "listFranchises",
    "listWorks",
    "listVolumes"
  ];
  for (const method of methods) {
    validateMethodObject(value, method, "NovelPipeline.storage");
  }
  const descriptor = safeGetOwnPropertyDescriptor(value as object, "root", "NovelPipeline.storage");
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") {
    throw new Error("NovelPipeline.storage.root must be an enumerable data string.");
  }
  validatePipelineStorageRoot(descriptor.value, "NovelPipeline.storage.root");
  return value as NovelStorage;
}

function assertNoSymbolInjectionProperties(value: unknown, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  for (const key of safeOwnKeys(value, label)) {
    if (typeof key !== "string") {
      throw new Error(`${label} must not contain symbol properties.`);
    }
  }
}

function validatePipelineAgents(value: unknown): NovelAgents {
  assertNoSymbolInjectionProperties(value, "NovelPipeline.agents");
  const methods = [
    "planInitial",
    "buildWorld",
    "planSkeleton",
    "writeBeat",
    "editBeat",
    "proofreadBeat",
    "checkContinuity",
    "editJoinedBeats",
    "buildEpub"
  ];
  for (const method of methods) {
    validateMethodObject(value, method, "NovelPipeline.agents");
  }
  return value as NovelAgents;
}

function validatePipelineStorageRoot(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty absolute path.`);
  }
  if (value.length > MAX_PIPELINE_STORAGE_ROOT_CHARS) {
    throw new Error(`${label} must be at most ${MAX_PIPELINE_STORAGE_ROOT_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(value, MAX_PIPELINE_STORAGE_ROOT_BYTES) > MAX_PIPELINE_STORAGE_ROOT_BYTES) {
    throw new Error(`${label} must be at most ${MAX_PIPELINE_STORAGE_ROOT_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  if (!isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  const root = resolve(value);
  if (dirname(root) === root) {
    throw new Error(`${label} must not be the filesystem root.`);
  }
}

function validateMethodObject(value: unknown, methodName: string, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  let current: object | null = value;
  while (current !== null) {
    const descriptor = safeGetOwnPropertyDescriptor(current, methodName, label);
    if (descriptor) {
      if ("value" in descriptor && typeof descriptor.value === "function") {
        return;
      }
      throw new Error(`${label}.${methodName} must be a data function.`);
    }
    current = safeGetPrototypeOf(current, label);
  }
  throw new Error(`${label}.${methodName} must be a data function.`);
}

function validatePipelineConfig(config: AppConfig): AppConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("NovelPipeline.config must be an object.");
  }
  const prototype = safeGetPrototypeOf(config, "NovelPipeline.config");
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("NovelPipeline.config must be a plain object.");
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of safeOwnKeys(config, "NovelPipeline.config")) {
    if (typeof key !== "string") {
      throw new Error("NovelPipeline.config must not contain symbol properties.");
    }
    if (!PIPELINE_CONFIG_FIELDS.has(key as keyof AppConfig)) {
      throw new Error(`NovelPipeline.${key} is not a supported config field.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(config, key, "NovelPipeline.config");
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`NovelPipeline.${key} must be an enumerable data property.`);
    }
    snapshot[key] = descriptor.value;
  }
  assertIntegerInRange(snapshot.operationTimeoutMs, "NovelPipeline.operationTimeoutMs", 1, MAX_PIPELINE_DURATION_MS);
  assertIntegerInRange(snapshot.lockTimeoutMs, "NovelPipeline.lockTimeoutMs", 1, MAX_PIPELINE_DURATION_MS);
  assertIntegerInRange(snapshot.lockRetryMs, "NovelPipeline.lockRetryMs", 1, MAX_PIPELINE_DURATION_MS);
  assertIntegerInRange(snapshot.lockStaleMs, "NovelPipeline.lockStaleMs", 1, MAX_PIPELINE_DURATION_MS);
  assertIntegerInRange(snapshot.reviewMaxRetries, "NovelPipeline.reviewMaxRetries", 0, MAX_PIPELINE_REVIEW_RETRIES);
  assertIntegerInRange(snapshot.jobRetentionMs, "NovelPipeline.jobRetentionMs", 1, MAX_PIPELINE_DURATION_MS);
  assertIntegerInRange(snapshot.maxConcurrentJobs, "NovelPipeline.maxConcurrentJobs", 1, MAX_PIPELINE_CONCURRENT_JOBS);
  assertIntegerInRange(snapshot.maxJobs, "NovelPipeline.maxJobs", 1, MAX_PIPELINE_TOTAL_JOBS);
  assertIntegerInRange(snapshot.stdioMaxLineLength, "NovelPipeline.stdioMaxLineLength", MIN_PIPELINE_STDIO_LINE_LENGTH, MAX_PIPELINE_STDIO_LINE_LENGTH);
  assertIntegerInRange(snapshot.openaiTimeoutMs, "NovelPipeline.openaiTimeoutMs", 1, MAX_PIPELINE_DURATION_MS);
  assertIntegerInRange(snapshot.openaiMaxRetries, "NovelPipeline.openaiMaxRetries", 0, MAX_PIPELINE_REVIEW_RETRIES);
  assertIntegerInRange(snapshot.openaiRetryBaseMs, "NovelPipeline.openaiRetryBaseMs", 1, MAX_PIPELINE_DURATION_MS);
  const dataDir = snapshotPipelineDataDir(snapshot.dataDir);
  const logLevel = snapshotPipelineLogLevel(snapshot.logLevel);
  if (snapshot.agentProvider !== "stub" && snapshot.agentProvider !== "openai") {
    throw new Error("NovelPipeline.agentProvider must be stub or openai.");
  }
  const openaiBaseUrl = snapshotOpenAiBaseUrl(snapshot.openaiBaseUrl);
  const openaiModel = snapshotOpenAiModel(snapshot.openaiModel);
  const openaiApiKey = snapshotOpenAiApiKey(snapshot.openaiApiKey);
  return {
    dataDir,
    lockTimeoutMs: snapshot.lockTimeoutMs as number,
    lockRetryMs: snapshot.lockRetryMs as number,
    lockStaleMs: snapshot.lockStaleMs as number,
    logLevel,
    operationTimeoutMs: snapshot.operationTimeoutMs as number,
    reviewMaxRetries: snapshot.reviewMaxRetries as number,
    jobRetentionMs: snapshot.jobRetentionMs as number,
    maxConcurrentJobs: snapshot.maxConcurrentJobs as number,
    maxJobs: snapshot.maxJobs as number,
    stdioMaxLineLength: snapshot.stdioMaxLineLength as number,
    agentProvider: snapshot.agentProvider as AppConfig["agentProvider"],
    openaiBaseUrl,
    openaiApiKey,
    openaiModel,
    openaiTimeoutMs: snapshot.openaiTimeoutMs as number,
    openaiMaxRetries: snapshot.openaiMaxRetries as number,
    openaiRetryBaseMs: snapshot.openaiRetryBaseMs as number,
    epubCheckCommand: snapshotEpubCheckCommand(snapshot.epubCheckCommand),
    epubCheckArgs: snapshotEpubCheckArgs(snapshot.epubCheckArgs, snapshot.epubCheckCommand)
  };
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

function snapshotEpubCheckCommand(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("NovelPipeline.epubCheckCommand must be a non-empty string when provided.");
  }
  if (value.length > MAX_PIPELINE_EPUBCHECK_COMMAND_LENGTH) {
    throw new Error(`NovelPipeline.epubCheckCommand must be at most ${MAX_PIPELINE_EPUBCHECK_COMMAND_LENGTH} characters.`);
  }
  if (utf8ByteLengthUpTo(value, MAX_PIPELINE_EPUBCHECK_COMMAND_BYTES) > MAX_PIPELINE_EPUBCHECK_COMMAND_BYTES) {
    throw new Error(`NovelPipeline.epubCheckCommand must be at most ${MAX_PIPELINE_EPUBCHECK_COMMAND_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("NovelPipeline.epubCheckCommand must not contain control characters.");
  }
  if (/\s/u.test(value)) {
    throw new Error("NovelPipeline.epubCheckCommand must be a single executable path or PATH command without whitespace.");
  }
  if ((value.includes("/") || value.includes("\\")) && !isAbsolute(value)) {
    throw new Error("NovelPipeline.epubCheckCommand must be either a PATH command name or an absolute executable path.");
  }
  if (!value.includes("/") && !value.includes("\\") && !/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new Error("NovelPipeline.epubCheckCommand PATH command names must contain only letters, numbers, dot, underscore, or hyphen.");
  }
  if (!value.includes("/") && !value.includes("\\") && (value.startsWith("-") || value === "." || value === "..")) {
    throw new Error("NovelPipeline.epubCheckCommand PATH command names must not start with hyphen and must not be . or ...");
  }
  return value;
}

function snapshotPipelineDataDir(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("NovelPipeline.dataDir must be a string when provided.");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("NovelPipeline.dataDir must be a non-empty absolute path when provided.");
  }
  if (trimmed.length > MAX_PIPELINE_STORAGE_ROOT_CHARS) {
    throw new Error(`NovelPipeline.dataDir must be at most ${MAX_PIPELINE_STORAGE_ROOT_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(trimmed, MAX_PIPELINE_STORAGE_ROOT_BYTES) > MAX_PIPELINE_STORAGE_ROOT_BYTES) {
    throw new Error(`NovelPipeline.dataDir must be at most ${MAX_PIPELINE_STORAGE_ROOT_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new Error("NovelPipeline.dataDir must not contain control characters.");
  }
  if (!isAbsolute(trimmed)) {
    throw new Error("NovelPipeline.dataDir must be an absolute path.");
  }
  const root = resolve(trimmed);
  if (dirname(root) === root) {
    throw new Error("NovelPipeline.dataDir must not be the filesystem root.");
  }
  return root;
}

function snapshotPipelineLogLevel(value: unknown): AppConfig["logLevel"] {
  if (value === "debug" || value === "info" || value === "warn" || value === "error" || value === "silent") {
    return value;
  }
  throw new Error("NovelPipeline.logLevel must be one of debug, info, warn, error, or silent.");
}

function snapshotOpenAiBaseUrl(value: unknown): string {
  assertBoundedOpenAiString(value, "NovelPipeline.openaiBaseUrl", MAX_PIPELINE_OPENAI_BASE_URL_LENGTH, MAX_PIPELINE_OPENAI_BASE_URL_BYTES);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("NovelPipeline.openaiBaseUrl must be a valid http or https URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("NovelPipeline.openaiBaseUrl must be a valid http or https URL.");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error("NovelPipeline.openaiBaseUrl must use https unless the host is localhost or loopback.");
  }
  if (url.username || url.password) {
    throw new Error("NovelPipeline.openaiBaseUrl must not include username or password credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("NovelPipeline.openaiBaseUrl must not include query strings or fragments.");
  }
  const normalized = url.toString().replace(/\/$/g, "");
  if (normalized.length > MAX_PIPELINE_OPENAI_BASE_URL_LENGTH) {
    throw new Error(`NovelPipeline.openaiBaseUrl normalized URL must be at most ${MAX_PIPELINE_OPENAI_BASE_URL_LENGTH} characters.`);
  }
  if (utf8ByteLengthUpTo(normalized, MAX_PIPELINE_OPENAI_BASE_URL_BYTES) > MAX_PIPELINE_OPENAI_BASE_URL_BYTES) {
    throw new Error(`NovelPipeline.openaiBaseUrl normalized URL must be at most ${MAX_PIPELINE_OPENAI_BASE_URL_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error("NovelPipeline.openaiBaseUrl normalized URL must not contain control characters.");
  }
  return normalized;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function snapshotOpenAiModel(value: unknown): string {
  assertBoundedOpenAiString(value, "NovelPipeline.openaiModel", MAX_PIPELINE_OPENAI_MODEL_LENGTH, MAX_PIPELINE_OPENAI_MODEL_BYTES);
  if (/\s/u.test(value)) {
    throw new Error("NovelPipeline.openaiModel must not contain whitespace.");
  }
  return value;
}

function snapshotOpenAiApiKey(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  assertBoundedOpenAiString(value, "NovelPipeline.openaiApiKey", MAX_PIPELINE_OPENAI_API_KEY_LENGTH, MAX_PIPELINE_OPENAI_API_KEY_BYTES);
  if (/\s/u.test(value)) {
    throw new Error("NovelPipeline.openaiApiKey must not contain whitespace.");
  }
  return value;
}

function snapshotEpubCheckArgs(value: unknown, command: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("NovelPipeline.epubCheckArgs must be an array.");
  }
  if (safeGetPrototypeOf(value, "NovelPipeline.epubCheckArgs") !== Array.prototype) {
    throw new Error("NovelPipeline.epubCheckArgs must be a standard array.");
  }
  if (value.length > MAX_PIPELINE_EPUBCHECK_ARGS) {
    throw new Error(`NovelPipeline.epubCheckArgs must contain at most ${MAX_PIPELINE_EPUBCHECK_ARGS} items.`);
  }
  const args: string[] = [];
  for (const key of safeOwnKeys(value, "NovelPipeline.epubCheckArgs")) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string") {
      throw new Error("NovelPipeline.epubCheckArgs must not contain symbol properties.");
    }
    if (!isArrayIndexKey(key, value.length)) {
      throw new Error(`NovelPipeline.epubCheckArgs.${key} is not a supported array field.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, "NovelPipeline.epubCheckArgs");
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`NovelPipeline.epubCheckArgs[${key}] must be an enumerable data property.`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = safeGetOwnPropertyDescriptor(value, String(index), "NovelPipeline.epubCheckArgs");
    if (!descriptor) {
      throw new Error(`NovelPipeline.epubCheckArgs[${index}] must not be a sparse array hole.`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`NovelPipeline.epubCheckArgs[${index}] must be an enumerable data property.`);
    }
    if (typeof descriptor.value !== "string") {
      throw new Error(`NovelPipeline.epubCheckArgs[${index}] must be a string.`);
    }
    if (descriptor.value.length === 0) {
      throw new Error(`NovelPipeline.epubCheckArgs[${index}] must be a non-empty string.`);
    }
    if (descriptor.value.trim() !== descriptor.value) {
      throw new Error(`NovelPipeline.epubCheckArgs[${index}] must not have leading or trailing whitespace.`);
    }
    if (descriptor.value.length > MAX_PIPELINE_EPUBCHECK_ARG_LENGTH) {
      throw new Error(`NovelPipeline.epubCheckArgs[${index}] must be at most ${MAX_PIPELINE_EPUBCHECK_ARG_LENGTH} characters.`);
    }
    if (utf8ByteLengthUpTo(descriptor.value, MAX_PIPELINE_EPUBCHECK_ARG_BYTES) > MAX_PIPELINE_EPUBCHECK_ARG_BYTES) {
      throw new Error(`NovelPipeline.epubCheckArgs[${index}] must be at most ${MAX_PIPELINE_EPUBCHECK_ARG_BYTES} UTF-8 bytes.`);
    }
    if (/[\u0000-\u001f\u007f]/u.test(descriptor.value)) {
      throw new Error(`NovelPipeline.epubCheckArgs[${index}] must not contain control characters.`);
    }
    args.push(descriptor.value);
  }
  if (command === undefined && (args.length !== 1 || args[0] !== "{epub}")) {
    throw new Error("NovelPipeline.epubCheckArgs requires epubCheckCommand unless it is the default {epub} placeholder.");
  }
  if (command !== undefined && !args.some((arg) => arg.includes("{epub}"))) {
    throw new Error("NovelPipeline.epubCheckArgs must include {epub} when epubCheckCommand is configured.");
  }
  return args;
}

function assertIntegerInRange(value: unknown, label: string, min: number, max: number): void {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer.`);
  }
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
}

function assertBoundedOpenAiString(value: unknown, label: string, maxChars: number, maxBytes: number): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string when agentProvider is openai.`);
  }
  if (value.length > maxChars) {
    throw new Error(`${label} must be at most ${maxChars} characters.`);
  }
  if (utf8ByteLengthUpTo(value, maxBytes) > maxBytes) {
    throw new Error(`${label} must be at most ${maxBytes} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must not contain control characters.`);
  }
}

function validateAgentConflict(value: unknown, label: string): ConflictRecord {
  const conflict = assertObject(value, `Agent result from ${label}.conflict`);
  assertOnlyFields(conflict, `Agent result from ${label}.conflict`, ["id", "scope", "description", "severity", "resolved"]);
  const severity = conflict.severity;
  if (severity !== "info" && severity !== "warning" && severity !== "blocking") {
    throw new Error(`Agent result from ${label}.conflict.severity is invalid.`);
  }
  if (typeof conflict.resolved !== "boolean") {
    throw new Error(`Agent result from ${label}.conflict.resolved must be a boolean.`);
  }
  return {
    id: assertSafeId(conflict.id, `Agent result from ${label}.conflict.id`),
    scope: assertBoundedNonEmptySingleLineString(
      conflict.scope,
      `Agent result from ${label}.conflict.scope`,
      MAX_AGENT_CONFLICT_FIELD_CHARS
    ),
    description: boundedNonEmptyString(conflict.description, `Agent result from ${label}.conflict.description`, MAX_AGENT_CONFLICT_FIELD_CHARS),
    severity,
    resolved: conflict.resolved
  };
}

function boundedAgentIssueArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  if (safeGetPrototypeOf(value, label) !== Array.prototype) {
    throw new Error(`${label} must be a standard array.`);
  }
  if (value.length > MAX_AGENT_ISSUES) {
    throw new Error(`${label} must contain at most ${MAX_AGENT_ISSUES} items.`);
  }
  assertArrayDataProperties(value, label);
  const issues: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = safeGetOwnPropertyDescriptor(value, String(index), label);
    if (!descriptor) {
      throw new Error(`${label}[${index}] must not be a sparse array hole.`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label}[${index}] must not be a non-enumerable or accessor array item.`);
    }
    issues.push(boundedNonEmptyString(descriptor.value, `${label}[${index}]`, MAX_AGENT_ISSUE_CHARS, MAX_AGENT_ISSUE_BYTES));
  }
  return issues;
}

function reviewIssues(issueGroups: string[][]): string[] {
  const limited: string[] = [];
  let total = 0;
  for (const group of issueGroups) {
    for (const issue of group) {
      total += 1;
      if (limited.length < MAX_REVIEW_ISSUES) {
        limited.push(truncateReviewIssue(issue));
      }
    }
  }
  const omitted = total - limited.length;
  if (omitted > 0) {
    limited.push(`[truncated ${omitted} review issues]`);
  }
  return limited;
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

function truncateReviewIssue(issue: string): string {
  return truncatePipelineText(issue, MAX_REVIEW_ISSUE_CHARS, MAX_REVIEW_ISSUE_BYTES);
}

function agentHealth(config: AppConfig): { provider: AppConfig["agentProvider"]; ready: boolean; reason?: string; openai?: { baseUrlConfigured: boolean; model: string; apiKeyConfigured: boolean } } {
  if (config.agentProvider === "openai") {
    const apiKeyConfigured = Boolean(config.openaiApiKey);
    return {
      provider: config.agentProvider,
      ready: apiKeyConfigured,
      ...(apiKeyConfigured ? {} : { reason: "NOVELIST_OPENAI_API_KEY is required when NOVELIST_AGENT_PROVIDER=openai." }),
      openai: {
        baseUrlConfigured: Boolean(config.openaiBaseUrl),
        model: config.openaiModel,
        apiKeyConfigured
      }
    };
  }
  return { provider: config.agentProvider, ready: true };
}

function redactExternalEpubCheckResult(result: ExternalEpubCheckResult, root: string): ExternalEpubCheckResult {
  return {
    configured: result.configured,
    valid: result.valid,
    ...(result.command === undefined ? {} : { command: redactRoot(result.command, root) }),
    ...(result.resolvedCommand === undefined ? {} : { resolvedCommand: redactRoot(result.resolvedCommand, root) }),
    ...(result.args === undefined ? {} : { args: result.args.map((arg) => redactRoot(arg, root)) }),
    ...(result.stdout === undefined ? {} : { stdout: redactRoot(result.stdout, root) }),
    ...(result.stderr === undefined ? {} : { stderr: redactRoot(result.stderr, root) }),
    ...(result.error === undefined ? {} : { error: redactRoot(result.error, root) })
  };
}

function publicStorageHealth(value: unknown, root: string): Omit<StorageHealthCheck, "root"> & { rootHash: string } {
  const storage = validateStorageHealthCheck(value);
  const redactRoot = (text: string) => text.split(root).join("<data-root>");
  return {
    rootHash: createHash("sha256").update(root).digest("hex").slice(0, 16),
    writable: storage.writable,
    jobStoreReadable: storage.jobStoreReadable,
    currentPointerReadable: storage.currentPointerReadable,
    jobCount: storage.jobCount,
    jobQuarantineCount: storage.jobQuarantineCount,
    ...(storage.error ? { error: redactRoot(storage.error) } : {}),
    ...(storage.jobStoreError ? { jobStoreError: redactRoot(storage.jobStoreError) } : {}),
    ...(storage.currentPointerError ? { currentPointerError: redactRoot(storage.currentPointerError) } : {})
  };
}

function validateStorageHealthCheck(value: unknown): Omit<StorageHealthCheck, "root"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Storage health check must be an object.");
  }
  const prototype = safeGetPrototypeOf(value, "Storage health check");
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Storage health check must be a plain object.");
  }
  const object = value as object;
  assertStorageHealthFields(object);
  assertRequiredStorageHealthFields(object);
  validateStorageHealthRoot(object);
  const writable = storageHealthBoolean(object, "writable");
  const jobStoreReadable = storageHealthBoolean(object, "jobStoreReadable");
  const currentPointerReadable = storageHealthBoolean(object, "currentPointerReadable");
  const jobCount = storageHealthCount(object, "jobCount");
  const jobQuarantineCount = storageHealthCount(object, "jobQuarantineCount");
  return {
    writable,
    jobStoreReadable,
    currentPointerReadable,
    jobCount,
    jobQuarantineCount,
    ...optionalStorageHealthError(object, "error"),
    ...optionalStorageHealthError(object, "jobStoreError"),
    ...optionalStorageHealthError(object, "currentPointerError")
  };
}

function assertStorageHealthFields(value: object): void {
  const allowed = new Set(["root", "writable", "jobStoreReadable", "currentPointerReadable", "jobCount", "jobQuarantineCount", "error", "jobStoreError", "currentPointerError"]);
  for (const key of safeOwnKeys(value, "Storage health check")) {
    if (typeof key !== "string") {
      throw new Error("Storage health check must not contain symbol properties.");
    }
    if (!allowed.has(key)) {
      throw new Error(`Storage health check.${key} is not a supported field.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, "Storage health check");
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`Storage health check.${key} must be an enumerable data property.`);
    }
  }
}

function assertRequiredStorageHealthFields(value: object): void {
  for (const key of ["writable", "jobStoreReadable", "currentPointerReadable", "jobCount", "jobQuarantineCount"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`Storage health check.${key} is required.`);
    }
  }
}

function validateStorageHealthRoot(value: object): void {
  const descriptor = safeGetOwnPropertyDescriptor(value, "root", "Storage health check");
  if (!descriptor) {
    return;
  }
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new Error("Storage health check.root must be an enumerable data property.");
  }
  if (typeof descriptor.value !== "string" || descriptor.value.trim().length === 0) {
    throw new Error("Storage health check.root must be a non-empty string when provided.");
  }
  if (descriptor.value.length > MAX_PIPELINE_STORAGE_ROOT_CHARS) {
    throw new Error(`Storage health check.root must be at most ${MAX_PIPELINE_STORAGE_ROOT_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(descriptor.value, MAX_PIPELINE_STORAGE_ROOT_BYTES) > MAX_PIPELINE_STORAGE_ROOT_BYTES) {
    throw new Error(`Storage health check.root must be at most ${MAX_PIPELINE_STORAGE_ROOT_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(descriptor.value)) {
    throw new Error("Storage health check.root must not contain control characters.");
  }
}

function storageHealthDataProperty(value: object, key: string): unknown {
  const descriptor = safeGetOwnPropertyDescriptor(value, key, "Storage health check");
  if (!descriptor?.enumerable || !("value" in descriptor)) {
    throw new Error(`Storage health check.${key} must be an enumerable data property.`);
  }
  return descriptor.value;
}

function storageHealthBoolean(value: object, key: string): boolean {
  const field = storageHealthDataProperty(value, key);
  if (typeof field !== "boolean") {
    throw new Error(`Storage health check.${key} must be a boolean.`);
  }
  return field;
}

function storageHealthCount(value: object, key: string): number {
  const field = storageHealthDataProperty(value, key);
  if (typeof field !== "number" || !Number.isInteger(field) || field < 0 || field > MAX_PIPELINE_TOTAL_JOBS) {
    throw new Error(`Storage health check.${key} must be an integer between 0 and ${MAX_PIPELINE_TOTAL_JOBS}.`);
  }
  return field;
}

function optionalStorageHealthError(value: object, key: "error" | "jobStoreError" | "currentPointerError"): Partial<Omit<StorageHealthCheck, "root">> {
  const descriptor = safeGetOwnPropertyDescriptor(value, key, "Storage health check");
  if (!descriptor) {
    return {};
  }
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new Error(`Storage health check.${key} must be an enumerable data property.`);
  }
  if (descriptor.value === undefined) {
    return {};
  }
  if (typeof descriptor.value !== "string") {
    throw new Error(`Storage health check.${key} must be a string when provided.`);
  }
  if (descriptor.value.trim().length === 0) {
    throw new Error(`Storage health check.${key} must be a non-empty string when provided.`);
  }
  return { [key]: truncateHealthError(descriptor.value) };
}

function truncateHealthError(value: string): string {
  const normalized = redactInlineSecrets(value).replace(PIPELINE_ERROR_CONTROL_CHARS_GLOBAL, " ");
  return truncatePipelineText(normalized, MAX_HEALTH_ERROR_CHARS, MAX_HEALTH_ERROR_BYTES);
}

function redactRoot(value: string, root: string): string {
  return value.split(root).join("<data-root>");
}

function confirmationTextForPlanning(confirmation: { message: string; revisionInstruction?: string }): string {
  if (!confirmation.revisionInstruction) {
    return confirmation.message;
  }
  return `${confirmation.message}\n\n사용자 수정 지시: ${confirmation.revisionInstruction}`;
}

function boundedNonEmptyString(value: unknown, label: string, maxChars: number, maxBytes = Math.min(maxChars * 4, MAX_PIPELINE_ERROR_BYTES)): string {
  const text = assertNonEmptyString(value, label);
  if (text.length > maxChars) {
    throw new Error(`${label} must be at most ${maxChars} characters.`);
  }
  if (utf8ByteLengthUpTo(text, maxBytes) > maxBytes) {
    throw new Error(`${label} must be at most ${maxBytes} UTF-8 bytes.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  return text;
}

function assertOnlyFields(value: Record<string, unknown>, label: string, allowed: string[]): void {
  const allowedFields = new Set(allowed);
  let fieldCount = 0;
  for (const key of safeOwnKeys(value, label)) {
    if (typeof key !== "string") {
      throw new Error(`${label} must not contain symbol properties.`);
    }
    fieldCount += 1;
    if (fieldCount > allowed.length) {
      throw new Error(`${label} must contain at most ${allowed.length} supported fields.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, label);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label}.${key} must be an enumerable data property.`);
    }
    if (!allowedFields.has(key)) {
      throw new Error(`${label}.${key} is not a supported field.`);
    }
  }
}

function defaultChapters(): ChapterState[] {
  return [
    {
      chapterNo: 1,
      title: "1장: 균열",
      targetWords: 2400,
      beats: [
        { chapterNo: 1, beatNo: 1, title: "일상의 이상징후", targetWords: 1200, status: "pending", retryCount: 0 },
        { chapterNo: 1, beatNo: 2, title: "세계 규칙의 암시", targetWords: 1200, status: "pending", retryCount: 0 }
      ]
    },
    {
      chapterNo: 2,
      title: "2장: 선택",
      targetWords: 2400,
      beats: [
        { chapterNo: 2, beatNo: 1, title: "갈등의 중심", targetWords: 1200, status: "pending", retryCount: 0 },
        { chapterNo: 2, beatNo: 2, title: "선택의 대가", targetWords: 1200, status: "pending", retryCount: 0 }
      ]
    }
  ];
}

function findCurrentBeat(state: VolumeState) {
  return state.chapters
    .flatMap((chapter) => chapter.beats)
    .find((beat) => beat.chapterNo === state.currentChapterNo && beat.beatNo === state.currentBeatNo && beat.status !== "complete");
}

function findBeatByTarget(state: VolumeState, target: string) {
  const match = target.match(/^chapter:(\d+),? *beat:(\d+)$/i) ?? target.match(/^(\d+)[-/](\d+)$/);
  if (!match) {
    throw new Error(
      `Revision target must use chapter:<n>,beat:<n>, chapter:<n> beat:<n>, <chapter>-<beat>, or <chapter>/<beat>: ${target}`
    );
  }
  const chapterNo = Number(match[1]);
  const beatNo = Number(match[2]);
  return state.chapters.flatMap((chapter) => chapter.beats).find((beat) => beat.chapterNo === chapterNo && beat.beatNo === beatNo);
}

function findBeatByNumber(state: VolumeState, chapterNo: number, beatNo: number) {
  return state.chapters.flatMap((chapter) => chapter.beats).find((beat) => beat.chapterNo === chapterNo && beat.beatNo === beatNo);
}

function assertRevisionTargetDoesNotSkipIncompleteBeat(state: VolumeState, targetBeat: VolumeState["chapters"][number]["beats"][number]): void {
  const beats = state.chapters.flatMap((chapter) => chapter.beats);
  const targetIndex = beats.findIndex((beat) => beat.chapterNo === targetBeat.chapterNo && beat.beatNo === targetBeat.beatNo);
  const firstIncompleteIndex = beats.findIndex((beat) => beat.status !== "complete");
  if (firstIncompleteIndex >= 0 && targetIndex > firstIncompleteIndex) {
    throw new Error("Revision target cannot skip earlier incomplete beats.");
  }
}

function previousBeat(state: VolumeState) {
  const beats = state.chapters.flatMap((chapter) => chapter.beats);
  const index = beats.findIndex((beat) => beat.chapterNo === state.currentChapterNo && beat.beatNo === state.currentBeatNo);
  return index > 0 ? beats[index - 1] : undefined;
}

function advanceCursor(state: VolumeState): void {
  const beats = state.chapters.flatMap((chapter) => chapter.beats);
  const next = beats.find((beat) => beat.status !== "complete");
  if (next) {
    state.currentChapterNo = next.chapterNo;
    state.currentBeatNo = next.beatNo;
    return;
  }
  const finalBeat = beats[beats.length - 1];
  if (finalBeat) {
    state.currentChapterNo = finalBeat.chapterNo;
    state.currentBeatNo = finalBeat.beatNo;
  }
}

function summarizeState(state: VolumeState) {
  const beats = state.chapters.flatMap((chapter) => chapter.beats);
  const pendingConfirmations = state.confirmations.filter((item) => !item.resolvedAt);
  const unresolvedConflicts = state.conflicts.filter((item) => !item.resolved);
  return {
    franchiseId: state.franchiseId,
    workId: state.workId,
    volumeId: state.volumeId,
    status: state.status,
    currentChapterNo: state.currentChapterNo,
    currentBeatNo: state.currentBeatNo,
    completedBeats: beats.filter((beat) => beat.status === "complete").length,
    totalBeats: beats.length,
    pendingConfirmationCount: pendingConfirmations.length,
    unresolvedConflictCount: unresolvedConflicts.length,
    pendingConfirmationHasMore: pendingConfirmations.length > MAX_SUMMARY_ITEMS,
    unresolvedConflictHasMore: unresolvedConflicts.length > MAX_SUMMARY_ITEMS,
    summaryItemLimit: MAX_SUMMARY_ITEMS,
    summaryTextLimit: MAX_SUMMARY_TEXT_CHARS,
    pendingConfirmations: pendingConfirmations.slice(0, MAX_SUMMARY_ITEMS).map(summaryConfirmation),
    unresolvedConflicts: unresolvedConflicts.slice(0, MAX_SUMMARY_ITEMS).map(summaryConflict)
  };
}

function summaryConfirmation(confirmation: VolumeState["confirmations"][number]) {
  return {
    id: confirmation.id,
    kind: confirmation.kind,
    message: truncateSummaryText(confirmation.message),
    createdAt: confirmation.createdAt,
    ...(confirmation.revisionInstruction ? { revisionInstruction: truncateSummaryText(confirmation.revisionInstruction) } : {})
  };
}

function summaryConflict(conflict: VolumeState["conflicts"][number]) {
  return {
    id: conflict.id,
    scope: truncateSummaryText(conflict.scope),
    description: truncateSummaryText(conflict.description),
    severity: conflict.severity,
    resolved: conflict.resolved
  };
}

function summarizeBeat(beat: VolumeState["chapters"][number]["beats"][number]) {
  return {
    chapterNo: beat.chapterNo,
    beatNo: beat.beatNo,
    title: beat.title,
    targetWords: beat.targetWords,
    status: beat.status,
    retryCount: beat.retryCount,
    ...(beat.lastFeedback !== undefined ? { lastFeedback: truncateSummaryText(beat.lastFeedback) } : {})
  };
}

function agentContextForBeat(
  state: VolumeState,
  beat: VolumeState["chapters"][number]["beats"][number],
  previousBeatText: string
): AgentContext {
  const stateSnapshot = cloneVolumeState(state);
  const currentBeat = findBeatByNumber(stateSnapshot, beat.chapterNo, beat.beatNo);
  if (!currentBeat) {
    throw new Error("Agent context current beat was not found in the state snapshot.");
  }
  return {
    state: stateSnapshot,
    currentBeat,
    previousBeatText,
    feedback: beat.lastFeedback ? [beat.lastFeedback] : []
  };
}

function cloneVolumeState(state: VolumeState): VolumeState {
  return validateVolumeState(state);
}

function truncateSummaryText(value: string): string {
  const redacted = redactInlineSecrets(value);
  return truncatePipelineText(redacted, MAX_SUMMARY_TEXT_CHARS, MAX_SUMMARY_TEXT_BYTES);
}

function summarizeIssues(issues: string[]): string[] {
  return issues.map(truncateSummaryText);
}

function skippedStateDiagnostic(franchiseId: string, workId: string, volumeId: string, error: unknown, root: string): string {
  return truncateSkippedStateDiagnostic(`${franchiseId}/${workId}/${volumeId}: ${redactRoot(errorMessage(error), root)}`);
}

function stateScanLimitError(): Error {
  return new Error(
    `State discovery scanned too many volume candidates: maximum is ${MAX_STATE_SCAN_CANDIDATES}; provide franchiseId, workId, and volumeId explicitly.`
  );
}

function truncateSkippedStateDiagnostic(value: string): string {
  return truncatePipelineText(value, MAX_SKIPPED_STATE_DIAGNOSTIC_CHARS, MAX_SKIPPED_STATE_DIAGNOSTIC_BYTES);
}

function errorMessage(error: unknown, root?: string): string {
  const secretRedacted = redactErrorMessage(error).replace(PIPELINE_ERROR_CONTROL_CHARS_GLOBAL, " ");
  const redacted = root ? redactRoot(secretRedacted, root) : secretRedacted;
  return truncatePipelineText(redacted, MAX_PIPELINE_ERROR_CHARS, MAX_PIPELINE_ERROR_BYTES);
}

function truncatePipelineText(value: string, maxChars: number, maxBytes: number): string {
  if (value.length <= maxChars && utf8ByteLengthUpTo(value, maxBytes) <= maxBytes) {
    return value;
  }
  if (value.length > maxChars) {
    const marker = `... [truncated ${value.length - maxChars} chars]`;
    const candidate = `${value.slice(0, maxChars)}${marker}`;
    if (utf8ByteLengthUpTo(candidate, maxBytes) <= maxBytes) {
      return candidate;
    }
  }
  return truncatePipelineTextByCharsAndBytes(value, maxChars, maxBytes);
}

function truncatePipelineTextByCharsAndBytes(value: string, maxChars: number, maxBytes: number): string {
  const marker = `... [truncated ${Math.max(0, utf8ByteLength(value) - maxBytes)} UTF-8 bytes]`;
  const markerBytes = utf8ByteLength(marker);
  if (marker.length > maxChars || markerBytes > maxBytes) {
    return marker;
  }
  return `${value.slice(0, utf8PrefixLength(value, maxChars - marker.length, maxBytes - markerBytes))}${marker}`;
}

function utf8ByteLength(value: string): number {
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
  }
  return bytes;
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

function appendConflict(state: VolumeState, conflict: ConflictRecord): void {
  if (state.conflicts.length >= MAX_STORED_CONFLICTS) {
    throw new Error(`Volume conflict limit reached: at most ${MAX_STORED_CONFLICTS} conflict records can be stored.`);
  }
  const existingIds = new Set(state.conflicts.map((item) => item.id));
  const id = existingIds.has(conflict.id) ? nextUniqueId("conflict", existingIds) : conflict.id;
  state.conflicts.push({ ...conflict, id, resolved: false });
}

function unresolvedBlockingConflictFeedback(state: VolumeState): string[] {
  return state.conflicts
    .filter((conflict) => conflict.severity === "blocking" && !conflict.resolved)
    .map((conflict) => `설정 충돌(${conflict.scope}): ${conflict.description}`);
}

function appendConfirmation(state: VolumeState, confirmation: VolumeState["confirmations"][number]): void {
  if (state.confirmations.length >= MAX_STORED_CONFIRMATIONS) {
    throw new Error(`Volume confirmation limit reached: at most ${MAX_STORED_CONFIRMATIONS} confirmation records can be stored.`);
  }
  state.confirmations.push(confirmation);
}

function incrementBeatRetryCount(beat: VolumeState["chapters"][number]["beats"][number]): void {
  if (beat.retryCount >= MAX_RUNTIME_BEAT_RETRY_COUNT) {
    throw new Error(
      `Beat retry count limit reached for chapter=${beat.chapterNo}, beat=${beat.beatNo}: at most ${MAX_RUNTIME_BEAT_RETRY_COUNT} retries can be stored.`
    );
  }
  beat.retryCount += 1;
}

function resetCurrentRevisionAfterConfirmation(state: VolumeState, revisionInstruction: string | undefined): void {
  const beat = findCurrentBeat(state);
  if (!beat || beat.status !== "needs_revision") {
    return;
  }
  beat.retryCount = 0;
  if (revisionInstruction !== undefined) {
    beat.lastFeedback = revisionInstruction;
  }
}

async function readRestorableEpub(storage: NovelStorage, state: VolumeState): Promise<Uint8Array | undefined> {
  try {
    return await storage.readEpubFile(state);
  } catch {
    // A corrupt or unreadable final EPUB cannot be restored safely. Revision
    // will invalidate it before publishing the draft state.
    return undefined;
  }
}

function nextUniqueId(prefix: string, existingIds: Set<string>): string {
  for (;;) {
    const id = createId(prefix);
    if (!existingIds.has(id)) {
      return id;
    }
  }
}

function createId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
