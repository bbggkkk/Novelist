import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ExecutionSignal } from "./execution.js";
import { NovelPipeline } from "./pipeline.js";
import { NovelStorage } from "./storage.js";
import type { ToolResult } from "./types.js";
import {
  assertBoundedNonEmptyString,
  assertBoundedNonEmptySingleLineString,
  assertObject,
  assertSafeId,
  assertShape,
  asOptionalBoundedSingleLineString
} from "./validation.js";
import { validateToolResultShape } from "./toolResultValidation.js";
import { redactErrorMessage, redactInlineSecrets } from "./redaction.js";
import {
  MAX_CONCURRENT_JOBS,
  MAX_INSTRUCTION_INPUT_CHARS,
  MAX_JOB_RETENTION_MS,
  MAX_OPTION_INPUT_CHARS,
  MAX_SET_TIMEOUT_MS,
  MAX_TITLE_INPUT_CHARS,
  MAX_TOTAL_JOBS
} from "./constants.js";
import { safeGetOwnPropertyDescriptor, safeGetPrototypeOf, safeOwnKeys } from "./safeProto.js";
import { utf8ByteLength, utf8ByteLengthUpTo, utf8PrefixLength } from "./utf8.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type AsyncToolName =
  | "novel_start"
  | "novel_start_volume"
  | "novel_next"
  | "novel_submit_world"
  | "novel_finalize_world"
  | "novel_submit_setting"
  | "novel_finalize_setting"
  | "novel_submit_outline"
  | "novel_finalize_outline"
  | "novel_save_beat_draft"
  | "novel_submit_beat"
  | "novel_rewrite_beat"
  | "novel_build_epub";

export interface JobSnapshot {
  jobId: string;
  toolName: AsyncToolName;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelRequested: boolean;
  result?: ToolResult;
  error?: string;
  persistenceError?: string;
}

export interface JobStatusSnapshot extends JobSnapshot {
  persistencePending?: boolean;
}

export interface JobListSnapshot extends Omit<JobSnapshot, "result" | "error" | "persistenceError"> {
  hasError: boolean;
  hasPersistenceError: boolean;
  persistencePending: boolean;
}

export interface JobLoadResult {
  loaded: number;
  recovered: number;
  failed: number;
  quarantined: number;
  skipped: number;
  errorCount: number;
  errorItemLimit: number;
  errors: Array<{ jobId: string; error: string; quarantinePath?: string }>;
}

export interface JobShutdownResult {
  queuedCancelled: number;
  runningCancellationRequested: number;
  settled: number;
  stillRunning: number;
  persistencePending: number;
}

interface JobRecord extends JobSnapshot, ExecutionSignal {
  args: unknown;
  persistenceTail?: Promise<void>;
}

const MAX_JOB_ERROR_CHARS = 4000;
const MAX_JOB_ERROR_BYTES = 4000;
const MAX_JOB_RESULT_MESSAGE_CHARS = 4000;
const MAX_JOB_RESULT_JSON_CHARS = 256 * 1024;
const MAX_JOB_RESULT_JSON_BYTES = 256 * 1024;
const DEFAULT_JOB_LIST_LIMIT = 100;
const MAX_JOB_LIST_LIMIT = 1000;
const MAX_JOB_LIST_OFFSET = 100000;
const MAX_JOB_SHUTDOWN_WAIT_MS = 60_000;
const MAX_JOB_STORAGE_ROOT_CHARS = 4096;
const MAX_JOB_STORAGE_ROOT_BYTES = 4096;
const MAX_TITLE_INPUT_BYTES = 512;
const MAX_OPTION_INPUT_BYTES = 256;
const MAX_INSTRUCTION_INPUT_BYTES = 16 * 1024;
const MAX_CLEANUP_FAILURE_ITEMS = 20;
const MAX_JOB_LOAD_ERROR_ITEMS = 20;
const MAX_RETURNED_QUARANTINE_FAILURE_ITEMS = 1000;
const CANCEL_PERSISTENCE_WAIT_MS = 250;
const MAX_TIMESTAMP_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const JOB_ERROR_CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const JOB_ERROR_CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f]/gu;

export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly activeRuns = new Set<Promise<void>>();
  private runningJobs = 0;

  constructor(
    private readonly pipeline: NovelPipeline,
    private readonly storage?: NovelStorage,
    private readonly retentionMs = 604800000,
    private readonly maxConcurrentJobs = 4,
    private readonly maxJobs = 1024
  ) {
    validateJobPipeline(pipeline);
    validateJobStorage(storage);
    assertIntegerInRange(retentionMs, "JobManager.retentionMs", 1, MAX_JOB_RETENTION_MS);
    assertIntegerInRange(maxConcurrentJobs, "JobManager.maxConcurrentJobs", 1, MAX_CONCURRENT_JOBS);
    assertIntegerInRange(maxJobs, "JobManager.maxJobs", 1, MAX_TOTAL_JOBS);
  }

  async loadPersistedJobs(): Promise<JobLoadResult> {
    const result: JobLoadResult = {
      loaded: 0,
      recovered: 0,
      failed: 0,
      quarantined: 0,
      skipped: 0,
      errorCount: 0,
      errorItemLimit: MAX_JOB_LOAD_ERROR_ITEMS,
      errors: []
    };
    const storage = this.storage;
    if (!storage) {
      return result;
    }
    for (const jobId of await listPersistedJobIds(storage)) {
      if (this.jobs.size >= this.maxJobs) {
        result.skipped += 1;
        addJobLoadError(result, {
          jobId,
          error: `Persisted job skipped because NOVELIST_MAX_JOBS was reached: ${this.jobs.size}/${this.maxJobs}. Use novel_job_cleanup or increase NOVELIST_MAX_JOBS.`
        });
        continue;
      }
      try {
        const saved = validatePersistedJob(await storage.readJob<unknown>(jobId), jobId);
        if (saved.result !== undefined) {
          saved.result = redactToolResultRoot(saved.result, storage.root);
        }
        const job = recordFromSnapshot(saved);
        let shouldPersistRecoveredState = false;
        if (job.status === "queued" || job.status === "running") {
          job.status = job.cancelRequested ? "cancelled" : "failed";
          job.error = job.cancelRequested
            ? "Job cancellation was recovered after process shutdown."
            : "Job was interrupted by process shutdown before completion.";
          job.finishedAt = new Date().toISOString();
          result.recovered += 1;
          shouldPersistRecoveredState = true;
        }
        this.jobs.set(job.jobId, job);
        result.loaded += 1;
        if (shouldPersistRecoveredState) {
          await this.persistOrRecord(job);
        }
      } catch (error) {
        const message = errorMessage(error);
        result.failed += 1;
        const entry: { jobId: string; error: string; quarantinePath?: string } = {
          jobId,
          error: redactRoot(message, storage.root) ?? message
        };
        try {
          const quarantinePath = await storage.quarantineJob(jobId);
          entry.quarantinePath = reportedJobPath(quarantinePath, storage.root);
          result.quarantined += 1;
        } catch (quarantineError) {
          const quarantineMessage = truncateErrorMessage(`${message}; quarantine failed: ${errorMessage(quarantineError)}`);
          entry.error = redactRoot(quarantineMessage, storage.root) ?? quarantineMessage;
        }
        addJobLoadError(result, entry);
      }
    }
    return result;
  }

  start(input: unknown): ToolResult {
    const parsed = parseJobStartInput(input);
    if (this.jobs.size >= this.maxJobs) {
      throw new Error(`Job queue limit reached: ${this.jobs.size}/${this.maxJobs}. Use novel_job_cleanup or increase NOVELIST_MAX_JOBS.`);
    }
    const now = new Date().toISOString();
    const job: JobRecord = {
      jobId: `job-${randomUUID()}`,
      toolName: parsed.toolName,
      args: parsed.args,
      status: "queued",
      createdAt: now,
      cancelRequested: false,
      isCancelled() {
        return this.cancelRequested;
      }
    };
    this.jobs.set(job.jobId, job);
    this.queuePersistence(job);
    this.pumpQueue();
    return jobToolResult({
      status: "ok",
      message: "Job queued.",
      data: snapshot(job, this.storage?.root)
    });
  }

  status(input: unknown): ToolResult {
    const job = this.requireJob(input);
    return jobToolResult({
      status: "ok",
      message: "Job status.",
      data: snapshot(job, this.storage?.root, true)
    });
  }

  list(input: unknown = {}): ToolResult {
    const parsed = parseJobListInput(input);
    const matched = [...this.jobs.values()]
      .filter((job) => !parsed.status || job.status === parsed.status)
      .sort(compareJobsForList);
    const jobs = jobArray(matched.slice(parsed.offset, parsed.offset + parsed.limit).map((job) => listSnapshot(job)));
    const nextOffset = parsed.offset + jobs.length;
    const hasMore = nextOffset < matched.length;
    return jobToolResult({
      status: "ok",
      message: "Job list.",
      data: jobData({
        jobs,
        count: jobs.length,
        total: matched.length,
        limit: parsed.limit,
        offset: parsed.offset,
        hasMore,
        ...(hasMore ? { nextOffset } : {})
      })
    });
  }

  async cleanup(input: unknown = {}): Promise<ToolResult> {
    assertShape(input, "novel_job_cleanup arguments", {});
    const cutoff = Date.now() - this.retentionMs;
    let deleted = 0;
    let persistencePendingSkipped = 0;
    const failures: Array<{ jobId: string; error: string }> = [];
    let failureCount = 0;
    let quarantineDeleted = 0;
    const quarantineFailures: Array<{ path: string; error: string }> = [];
    let quarantineFailureCount = 0;
    for (const job of [...this.jobs.values()]) {
      if (!isTerminalStatus(job.status) || !job.finishedAt) {
        continue;
      }
      if (Date.parse(job.finishedAt) > cutoff) {
        continue;
      }
      if (job.persistenceTail) {
        persistencePendingSkipped += 1;
        continue;
      }
      try {
        await this.storage?.deleteJob(job.jobId);
        this.jobs.delete(job.jobId);
        deleted += 1;
      } catch (error) {
        const message = errorMessage(error);
        job.persistenceError = redactRoot(message, this.storage?.root) ?? message;
        failureCount += 1;
        if (failures.length < MAX_CLEANUP_FAILURE_ITEMS) {
          failures.push({ jobId: job.jobId, error: message });
        }
      }
    }
    if (this.storage) {
      const diskCleanup = await this.cleanupUnloadedTerminalSnapshots(cutoff);
      deleted += diskCleanup.deleted;
      failureCount += diskCleanup.failed;
      failures.push(...diskCleanup.failures.slice(0, Math.max(0, MAX_CLEANUP_FAILURE_ITEMS - failures.length)));
    }
    try {
      const quarantineCleanup = this.storage
        ? validateJobQuarantineCleanupResult(await this.storage.cleanupJobQuarantine(cutoff))
        : undefined;
      quarantineDeleted = quarantineCleanup?.deleted ?? 0;
      const storageFailures = quarantineCleanup?.failures ?? [];
      quarantineFailureCount += quarantineCleanup?.failed ?? 0;
      quarantineFailures.push(...storageFailures.slice(0, Math.max(0, MAX_CLEANUP_FAILURE_ITEMS - quarantineFailures.length)));
    } catch (error) {
      quarantineFailureCount += 1;
      quarantineFailures.push({ path: "data/jobs/quarantine", error: errorMessage(error) });
    }
    const failed = failureCount + quarantineFailureCount;
    return jobToolResult({
      status: failed > 0 ? "needs_input" : "ok",
      message: failed > 0 ? "Job cleanup completed with deletion failures." : "Job cleanup complete.",
      data: jobData({
        deleted,
        quarantineDeleted,
        failed,
        failureCount,
        quarantineFailureCount,
        persistencePendingSkipped,
        failureItemLimit: MAX_CLEANUP_FAILURE_ITEMS,
        failures: jobArray(failures.map((failure) => jobData({
          jobId: failure.jobId,
          error: redactRoot(failure.error, this.storage?.root) ?? failure.error
        }))),
        quarantineFailures: jobArray(quarantineFailures.map((failure) => jobData({
          path: redactRoot(errorMessage(failure.path), this.storage?.root) ?? errorMessage(failure.path),
          error: redactRoot(errorMessage(failure.error), this.storage?.root) ?? errorMessage(failure.error)
        }))),
        retained: this.jobs.size,
        retentionMs: this.retentionMs,
        cutoff: new Date(cutoff).toISOString()
      })
    });
  }

  async cancel(input: unknown): Promise<ToolResult> {
    const job = this.requireJob(input);
    if (isTerminalStatus(job.status)) {
      return jobToolResult({
        status: "ok",
        message: "Job is already finished.",
        data: snapshot(job, this.storage?.root, true)
      });
    }
    job.cancelRequested = true;
    let persistencePending = false;
    const deadline = Date.now() + CANCEL_PERSISTENCE_WAIT_MS;
    if (job.status === "queued") {
      job.error = "Job was cancelled before it started.";
      job.finishedAt = new Date().toISOString();
      job.status = "cancelled";
      persistencePending = !await this.waitForPersistence(this.persistOrRecord(job), deadline);
    } else {
      persistencePending = !await this.waitForPersistence(this.persistOrRecord(job), deadline);
    }
    this.pumpQueue();
    return jobToolResult({
      status: "ok",
      message: "Job cancellation requested.",
      data: jobData({
        ...snapshot(job, this.storage?.root),
        persistencePending
      })
    });
  }

  async shutdown(waitMs = 5000): Promise<JobShutdownResult> {
    assertIntegerInRange(waitMs, "JobManager.shutdown.waitMs", 0, MAX_JOB_SHUTDOWN_WAIT_MS);
    let queuedCancelled = 0;
    let runningCancellationRequested = 0;
    let persistencePending = 0;
    const deadline = Date.now() + waitMs;
    const persistenceWrites: Promise<void>[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === "queued") {
        job.cancelRequested = true;
        job.error = "Job was cancelled during server shutdown before it started.";
        job.finishedAt = new Date().toISOString();
        job.status = "cancelled";
        persistenceWrites.push(this.persistOrRecord(job));
        queuedCancelled += 1;
        continue;
      }
      if (job.status === "running" && !job.cancelRequested) {
        job.cancelRequested = true;
        persistenceWrites.push(this.persistOrRecord(job));
        runningCancellationRequested += 1;
      }
    }
    for (const persistenceWrite of persistenceWrites) {
      if (!await this.waitForPersistence(persistenceWrite, deadline)) {
        persistencePending += 1;
      }
    }
    const runningAtShutdown = this.activeRuns.size;
    const remainingRunWait = remainingMs(deadline);
    if (runningAtShutdown > 0 && remainingRunWait > 0) {
      await Promise.race([
        Promise.allSettled([...this.activeRuns]),
        sleep(remainingRunWait)
      ]);
    }
    const pendingPersistence = [...this.jobs.values()].map((job) => job.persistenceTail).filter((tail): tail is Promise<void> => Boolean(tail));
    if (pendingPersistence.length > 0) {
      if (!await this.waitForPersistence(Promise.allSettled(pendingPersistence).then(() => undefined), deadline)) {
        persistencePending = Math.max(persistencePending, pendingPersistence.length);
      }
    }
    return {
      queuedCancelled,
      runningCancellationRequested,
      settled: runningAtShutdown - this.activeRuns.size,
      stillRunning: this.activeRuns.size,
      persistencePending
    };
  }

  private async run(job: JobRecord): Promise<void> {
    if (job.cancelRequested) {
      job.error = "Job was cancelled before it started.";
      job.finishedAt = new Date().toISOString();
      job.status = "cancelled";
      this.queuePersistence(job);
      this.runningJobs -= 1;
      this.pumpQueue();
      return;
    }
    job.status = "running";
    job.startedAt = new Date().toISOString();
    this.queuePersistence(job);
    let terminalStatus: JobStatus = "succeeded";
    try {
      job.result = validateToolResult(await this.callPipeline(job.toolName, job.args, job), `job ${job.jobId}.result`);
      if (job.cancelRequested) {
        job.result = undefined;
        job.error = "Job was cancelled before completion.";
        terminalStatus = "cancelled";
      } else {
        terminalStatus = "succeeded";
      }
    } catch (error) {
      const message = errorMessage(error);
      job.result = undefined;
      job.error = message;
      terminalStatus = job.cancelRequested || /cancelled/i.test(message) ? "cancelled" : "failed";
    } finally {
      if (terminalStatus === "cancelled") {
        job.cancelRequested = true;
        job.result = undefined;
      }
      job.finishedAt = new Date().toISOString();
      job.status = terminalStatus;
      this.queuePersistence(job);
      this.runningJobs -= 1;
      this.pumpQueue();
    }
  }

  private pumpQueue(): void {
    while (this.runningJobs < this.maxConcurrentJobs) {
      const next = [...this.jobs.values()].find((job) => job.status === "queued" && !job.cancelRequested);
      if (!next) {
        return;
      }
      this.runningJobs += 1;
      const runPromise = this.run(next).finally(() => {
        this.activeRuns.delete(runPromise);
      });
      this.activeRuns.add(runPromise);
    }
  }

  private callPipeline(toolName: AsyncToolName, args: unknown, signal: ExecutionSignal): Promise<ToolResult> {
    switch (toolName) {
      case "novel_start":
        return this.pipeline.start(args as never, signal);
      case "novel_start_volume":
        return this.pipeline.startVolume(args as never, signal);
      case "novel_next":
        return this.pipeline.next(args as never, signal);
      case "novel_submit_world":
        return this.pipeline.submitWorld(args as never, signal);
      case "novel_finalize_world":
        return this.pipeline.finalizeWorld(args as never, signal);
      case "novel_submit_setting":
        return this.pipeline.submitSetting(args as never, signal);
      case "novel_finalize_setting":
        return this.pipeline.finalizeSetting(args as never, signal);
      case "novel_submit_outline":
        return this.pipeline.submitOutline(args as never, signal);
      case "novel_finalize_outline":
        return this.pipeline.finalizeOutline(args as never, signal);
      case "novel_save_beat_draft":
        return this.pipeline.saveBeatDraft(args as never, signal);
      case "novel_submit_beat":
        return this.pipeline.submitBeat(args as never, signal);
      case "novel_rewrite_beat":
        return this.pipeline.rewriteBeat(args as never, signal);
      case "novel_build_epub":
        return this.pipeline.buildEpub(args as never, signal);
    }
  }

  private requireJob(input: unknown): JobRecord {
    const object = assertShape(input, "job arguments", { jobId: "string" });
    const jobId = assertSafeId(object.jobId, "jobId");
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }
    return job;
  }

  private async persistOrRecord(job: JobRecord): Promise<void> {
    const nextSnapshot = snapshot(job, this.storage?.root);
    delete nextSnapshot.persistenceError;
    const previous = job.persistenceTail ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.writeJobSnapshot(job, nextSnapshot));
    job.persistenceTail = next;
    await next;
    if (job.persistenceTail === next) {
      job.persistenceTail = undefined;
    }
  }

  private queuePersistence(job: JobRecord): void {
    void this.persistOrRecord(job).catch((error: unknown) => {
      const message = errorMessage(error);
      job.persistenceError = redactRoot(message, this.storage?.root) ?? message;
    });
  }

  private async writeJobSnapshot(job: JobRecord, nextSnapshot: JobSnapshot): Promise<void> {
    try {
      job.persistenceError = undefined;
      await this.storage?.writeJob(job.jobId, nextSnapshot);
      job.persistenceError = undefined;
    } catch (error) {
      const message = errorMessage(error);
      job.persistenceError = redactRoot(message, this.storage?.root) ?? message;
    }
  }

  private async waitForPersistence(promise: Promise<void>, deadline: number): Promise<boolean> {
    const remaining = remainingMs(deadline);
    if (remaining <= 0) {
      return false;
    }
    let settled = false;
    await Promise.race([
      promise.then(() => {
        settled = true;
      }),
      sleep(remaining)
    ]);
    return settled;
  }

  private async cleanupUnloadedTerminalSnapshots(cutoff: number): Promise<{ deleted: number; failed: number; failures: Array<{ jobId: string; error: string }> }> {
    let deleted = 0;
    let failed = 0;
    const failures: Array<{ jobId: string; error: string }> = [];
    const storage = this.storage;
    if (!storage) {
      return { deleted, failed, failures };
    }
    for (const jobId of await listPersistedJobIds(storage)) {
      if (this.jobs.has(jobId)) {
        continue;
      }
      let saved: JobSnapshot & { args?: unknown };
      try {
        saved = validatePersistedJob(await storage.readJob<unknown>(jobId), jobId);
      } catch {
        // Startup recovery owns quarantine for invalid snapshots. Cleanup only
        // prunes valid terminal snapshots that were not loaded due maxJobs.
        continue;
      }
      if (!isTerminalStatus(saved.status) || !saved.finishedAt || Date.parse(saved.finishedAt) > cutoff) {
        continue;
      }
      try {
        await storage.deleteJob(jobId);
        deleted += 1;
      } catch (error) {
        failed += 1;
        if (failures.length < MAX_CLEANUP_FAILURE_ITEMS) {
          failures.push({ jobId, error: errorMessage(error) });
        }
      }
    }
    return { deleted, failed, failures };
  }
}

function compareJobsForList(left: JobRecord, right: JobRecord): number {
  const createdAtOrder = right.createdAt.localeCompare(left.createdAt);
  if (createdAtOrder !== 0) {
    return createdAtOrder;
  }
  return left.jobId.localeCompare(right.jobId);
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function listPersistedJobIds(storage: NovelStorage): Promise<string[]> {
  const rawIds = await storage.listJobIds();
  if (!Array.isArray(rawIds)) {
    throw new Error("JobManager.storage.listJobIds result must be an array.");
  }
  if (safeGetPrototypeOf(rawIds, "JobManager.storage.listJobIds result") !== Array.prototype) {
    throw new Error("JobManager.storage.listJobIds result must be a standard array.");
  }
  if (rawIds.length > MAX_TOTAL_JOBS) {
    throw new Error(`JobManager.storage.listJobIds result must contain at most ${MAX_TOTAL_JOBS} items.`);
  }
  const ids: string[] = [];
  const seenIds = new Set<string>();
  for (const key of safeOwnKeys(rawIds, "JobManager.storage.listJobIds result")) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string") {
      throw new Error("JobManager.storage.listJobIds result must not contain symbol properties.");
    }
    if (!isArrayIndexKey(key, rawIds.length)) {
      throw new Error(`JobManager.storage.listJobIds result.${key} is not a supported array field.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(rawIds, key, "JobManager.storage.listJobIds result");
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`JobManager.storage.listJobIds result[${key}] must not contain non-enumerable or accessor properties.`);
    }
  }
  for (let index = 0; index < rawIds.length; index += 1) {
    const descriptor = safeGetOwnPropertyDescriptor(rawIds, String(index), "JobManager.storage.listJobIds result");
    if (!descriptor) {
      throw new Error(`JobManager.storage.listJobIds result[${index}] must not be a sparse array hole.`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`JobManager.storage.listJobIds result[${index}] must not contain non-enumerable or accessor properties.`);
    }
    const jobId = assertSafeId(descriptor.value, `JobManager.storage.listJobIds result[${index}]`);
    if (seenIds.has(jobId)) {
      throw new Error(`JobManager.storage.listJobIds result must not contain duplicate job ids: ${jobId}`);
    }
    seenIds.add(jobId);
    ids.push(jobId);
  }
  return ids;
}

function parseJobListInput(input: unknown): { status?: JobStatus; limit: number; offset: number } {
  const object = assertObject(input, "novel_job_list arguments");
  assertKnownFields(object, "novel_job_list arguments", ["status", "limit", "offset"]);
  const status = object.status === undefined ? undefined : assertJobStatus(object.status, "novel_job_list.status");
  return {
    ...(status ? { status } : {}),
    limit: optionalBoundedInteger(object.limit, "novel_job_list.limit", DEFAULT_JOB_LIST_LIMIT, 1, MAX_JOB_LIST_LIMIT),
    offset: optionalBoundedInteger(object.offset, "novel_job_list.offset", 0, 0, MAX_JOB_LIST_OFFSET)
  };
}

function parseJobStartInput(input: unknown): { toolName: AsyncToolName; args: unknown } {
  const object = assertObject(input, "novel_job_start arguments");
  assertKnownFields(object, "novel_job_start arguments", ["toolName", "args"]);
  const toolName = object.toolName;
  if (typeof toolName !== "string") {
    throw new Error("novel_job_start.toolName must be a string.");
  }
  const asyncToolName = assertAsyncToolName(toolName, "novel_job_start.toolName");
  if (object.args === undefined && toolName !== "novel_next" && toolName !== "novel_finalize_world" && toolName !== "novel_finalize_setting" && toolName !== "novel_finalize_outline") {
    throw new Error(`novel_job_start.args is required for ${toolName}.`);
  }
  return { toolName: asyncToolName, args: cloneJobArgs(validateAsyncToolArgs(asyncToolName, object.args, "novel_job_start.args")) };
}

function isJobStatus(value: string): value is JobStatus {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}

function isAsyncToolName(value: string): value is AsyncToolName {
  return (
    value === "novel_start" ||
    value === "novel_start_volume" ||
    value === "novel_next" ||
    value === "novel_submit_world" ||
    value === "novel_finalize_world" ||
    value === "novel_submit_setting" ||
    value === "novel_finalize_setting" ||
    value === "novel_submit_outline" ||
    value === "novel_finalize_outline" ||
    value === "novel_save_beat_draft" ||
    value === "novel_submit_beat" ||
    value === "novel_rewrite_beat" ||
    value === "novel_build_epub"
  );
}

function assertJobStatus(value: unknown, label: string): JobStatus {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  if (JOB_ERROR_CONTROL_CHARS.test(value)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  if (value.trim() !== value) {
    throw new Error(`${label} must not have leading or trailing whitespace.`);
  }
  if (!isJobStatus(value)) {
    throw new Error(`${label} must be one of queued, running, succeeded, failed, or cancelled.`);
  }
  return value;
}

function assertAsyncToolName(value: unknown, label: string): AsyncToolName {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  if (JOB_ERROR_CONTROL_CHARS.test(value)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  if (value.trim() !== value) {
    throw new Error(`${label} must not have leading or trailing whitespace.`);
  }
  if (!isAsyncToolName(value)) {
    throw new Error(`${label} must be a supported async novel tool.`);
  }
  return value;
}

function isTerminalStatus(status: JobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function validatePersistedJob(value: unknown, expectedJobId: string): JobSnapshot & { args?: unknown } {
  const object = assertObject(value, `persisted job ${expectedJobId}`);
  assertKnownFields(object, `persisted job ${expectedJobId}`, [
    "jobId",
    "toolName",
    "status",
    "createdAt",
    "startedAt",
    "finishedAt",
    "cancelRequested",
    "result",
    "error",
    "persistenceError",
    "args"
  ]);
  const jobId = assertSafeId(object.jobId, "jobId");
  if (jobId !== expectedJobId) {
    throw new Error(`persisted job ${expectedJobId}.jobId must match its filename.`);
  }
  const toolName = assertAsyncToolName(object.toolName, `persisted job ${expectedJobId}.toolName`);
  const status = assertJobStatus(object.status, `persisted job ${expectedJobId}.status`);
  assertIsoString(object.createdAt, `persisted job ${expectedJobId}.createdAt`);
  assertOptionalIsoString(object.startedAt, `persisted job ${expectedJobId}.startedAt`);
  assertOptionalIsoString(object.finishedAt, `persisted job ${expectedJobId}.finishedAt`);
  validateJobTimestampOrder(expectedJobId, status, object.createdAt, object.startedAt, object.finishedAt);
  validateJobOutcomeFields(expectedJobId, status, object.result, object.error);
  if (typeof object.cancelRequested !== "boolean") {
    throw new Error(`persisted job ${expectedJobId}.cancelRequested must be a boolean.`);
  }
  validateJobCancellationFields(expectedJobId, status, object.cancelRequested);
  const args = !isTerminalStatus(status) && Object.prototype.hasOwnProperty.call(object, "args")
    ? validateAsyncToolArgs(toolName, object.args, `persisted job ${expectedJobId}.args`)
    : undefined;
  const result = status === "succeeded" ? redactToolResultRoot(validateToolResult(object.result, `persisted job ${expectedJobId}.result`), undefined) : undefined;
  const error = optionalJobErrorString(object.error, `persisted job ${expectedJobId}.error`);
  const persistenceError = optionalJobErrorString(object.persistenceError, `persisted job ${expectedJobId}.persistenceError`);
  return {
    jobId,
    toolName,
    status,
    createdAt: object.createdAt,
    startedAt: typeof object.startedAt === "string" ? object.startedAt : undefined,
    finishedAt: typeof object.finishedAt === "string" ? object.finishedAt : undefined,
    cancelRequested: object.cancelRequested,
    result,
    error,
    persistenceError,
    args
  };
}

function assertIsoString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !isCanonicalUtcTimestamp(value)) {
    throw new Error(`${label} must be an ISO timestamp string.`);
  }
  if (Date.parse(value) > Date.now() + MAX_TIMESTAMP_FUTURE_SKEW_MS) {
    throw new Error(`${label} must not be more than ${MAX_TIMESTAMP_FUTURE_SKEW_MS}ms in the future.`);
  }
}

function assertOptionalIsoString(value: unknown, label: string): void {
  if (value !== undefined) {
    assertIsoString(value, label);
  }
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

function validateJobTimestampOrder(jobId: string, status: JobStatus, createdAt: string, startedAt: unknown, finishedAt: unknown): void {
  const createdMs = Date.parse(createdAt);
  const startedMs = typeof startedAt === "string" ? Date.parse(startedAt) : undefined;
  const finishedMs = typeof finishedAt === "string" ? Date.parse(finishedAt) : undefined;
  if (status === "queued" && startedMs !== undefined) {
    throw new Error(`persisted job ${jobId}.startedAt is only valid after the job starts.`);
  }
  if ((status === "running" || status === "succeeded") && startedMs === undefined) {
    throw new Error(`persisted job ${jobId}.startedAt is required for running or succeeded status.`);
  }
  if (startedMs !== undefined && startedMs < createdMs) {
    throw new Error(`persisted job ${jobId}.startedAt must be greater than or equal to createdAt.`);
  }
  if (isTerminalStatus(status) && finishedMs === undefined) {
    throw new Error(`persisted job ${jobId}.finishedAt is required for terminal status.`);
  }
  if (!isTerminalStatus(status) && finishedMs !== undefined) {
    throw new Error(`persisted job ${jobId}.finishedAt is only valid for terminal status.`);
  }
  if (finishedMs !== undefined && finishedMs < createdMs) {
    throw new Error(`persisted job ${jobId}.finishedAt must be greater than or equal to createdAt.`);
  }
  if (finishedMs !== undefined && startedMs !== undefined && finishedMs < startedMs) {
    throw new Error(`persisted job ${jobId}.finishedAt must be greater than or equal to startedAt.`);
  }
}

function validateJobOutcomeFields(jobId: string, status: JobStatus, result: unknown, error: unknown): void {
  if (status === "succeeded" && result === undefined) {
    throw new Error(`persisted job ${jobId}.result is required for succeeded status.`);
  }
  if (status !== "succeeded" && result !== undefined) {
    throw new Error(`persisted job ${jobId}.result is only valid for succeeded status.`);
  }
  if ((status === "failed" || status === "cancelled") && (typeof error !== "string" || error.trim().length === 0)) {
    throw new Error(`persisted job ${jobId}.error is required for failed or cancelled status.`);
  }
  if (status !== "failed" && status !== "cancelled" && error !== undefined) {
    throw new Error(`persisted job ${jobId}.error is only valid for failed or cancelled status.`);
  }
}

function validateJobCancellationFields(jobId: string, status: JobStatus, cancelRequested: boolean): void {
  if (status === "succeeded" && cancelRequested) {
    throw new Error(`persisted job ${jobId}.cancelRequested must be false for succeeded status.`);
  }
  if (status === "failed" && cancelRequested) {
    throw new Error(`persisted job ${jobId}.cancelRequested must be false for failed status.`);
  }
  if (status === "cancelled" && !cancelRequested) {
    throw new Error(`persisted job ${jobId}.cancelRequested must be true for cancelled status.`);
  }
}

function validateToolResult(value: unknown, label: string): ToolResult {
  const result = validateToolResultShape(value, label, MAX_JOB_RESULT_MESSAGE_CHARS);
  assertJsonSnapshotSize(result, label);
  return result;
}

function assertJsonSnapshotSize(value: unknown, label: string): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(jsonStringifySnapshot(value, label));
  } catch (error) {
    throw new Error(`${label} must be JSON serializable: ${errorMessage(error)}`);
  }
  if (serialized.length > MAX_JOB_RESULT_JSON_CHARS) {
    throw new Error(`${label} JSON size must be less than or equal to ${MAX_JOB_RESULT_JSON_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(serialized, MAX_JOB_RESULT_JSON_BYTES) > MAX_JOB_RESULT_JSON_BYTES) {
    throw new Error(`${label} JSON size must be less than or equal to ${MAX_JOB_RESULT_JSON_BYTES} UTF-8 bytes.`);
  }
}

function jsonStringifySnapshot(value: unknown, label: string): unknown {
  const stack = new WeakSet<object>();
  const visit = (current: unknown, currentLabel: string): unknown => {
    if (current === null || typeof current === "string" || typeof current === "number" || typeof current === "boolean") {
      return current;
    }
    if (!current || typeof current !== "object") {
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
      assertJsonSnapshotArrayProperties(current, currentLabel);
      const output: unknown[] = [];
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = safeGetOwnPropertyDescriptor(current, String(index), currentLabel);
        if (!descriptor) {
          throw new Error(`${currentLabel}[${index}] must not be a sparse array hole.`);
        }
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new Error(`${currentLabel}[${index}] must be an enumerable data property.`);
        }
        output.push(visit(descriptor.value, `${currentLabel}[${index}]`));
      }
      Object.setPrototypeOf(output, null);
      stack.delete(current);
      return output;
    }
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of safeOwnKeys(current, currentLabel)) {
      if (typeof key !== "string") {
        throw new Error(`${currentLabel} must not contain symbol properties.`);
      }
      const descriptor = safeGetOwnPropertyDescriptor(current, key, currentLabel);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new Error(`${currentLabel} must not contain non-enumerable or accessor properties.`);
      }
      Object.defineProperty(output, key, {
        value: visit(descriptor.value, `${currentLabel}.${key}`),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    stack.delete(current);
    return output;
  };
  return visit(value, label);
}

function assertJsonSnapshotArrayProperties(value: unknown[], label: string): void {
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
      throw new Error(`${label}[${key}] must be an enumerable data property.`);
    }
  }
}

function addJobLoadError(result: JobLoadResult, entry: { jobId: string; error: string; quarantinePath?: string }): void {
  result.errorCount += 1;
  if (result.errors.length < MAX_JOB_LOAD_ERROR_ITEMS) {
    result.errors.push(entry);
  }
}

function validateJobQuarantineCleanupResult(value: unknown): { deleted: number; failed: number; failures: Array<{ path: string; error: string }>; failureItemLimit: number } {
  const object = assertObject(value, "cleanupJobQuarantine result");
  assertKnownFields(object, "cleanupJobQuarantine result", ["deleted", "failed", "failures", "failureItemLimit"]);
  assertRequiredCleanupFields(object);
  const failuresValue = object.failures;
  if (!Array.isArray(failuresValue)) {
    throw new Error("cleanupJobQuarantine.failures must be an array.");
  }
  if (safeGetPrototypeOf(failuresValue, "cleanupJobQuarantine.failures") !== Array.prototype) {
    throw new Error("cleanupJobQuarantine.failures must be a standard array.");
  }
  if (failuresValue.length > MAX_RETURNED_QUARANTINE_FAILURE_ITEMS) {
    throw new Error(`cleanupJobQuarantine.failures must contain at most ${MAX_RETURNED_QUARANTINE_FAILURE_ITEMS} items.`);
  }
  assertQuarantineCleanupFailureArrayProperties(failuresValue);
  const failures = validateQuarantineCleanupFailures(failuresValue);
  const failed = optionalBoundedInteger(object.failed, "cleanupJobQuarantine.failed", failures.length, 0, MAX_TOTAL_JOBS);
  const failureItemLimit = optionalBoundedInteger(object.failureItemLimit, "cleanupJobQuarantine.failureItemLimit", 0, 0, MAX_RETURNED_QUARANTINE_FAILURE_ITEMS);
  assertQuarantineCleanupCounts(failed, failures.length, failureItemLimit);
  return {
    deleted: optionalBoundedInteger(object.deleted, "cleanupJobQuarantine.deleted", 0, 0, MAX_TOTAL_JOBS),
    failed,
    failures,
    failureItemLimit
  };
}

function assertRequiredCleanupFields(value: Record<string, unknown>): void {
  for (const key of ["deleted", "failed", "failures", "failureItemLimit"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`cleanupJobQuarantine.${key} is required.`);
    }
  }
}

function assertQuarantineCleanupCounts(failed: number, returnedFailures: number, failureItemLimit: number): void {
  if (failed < returnedFailures) {
    throw new Error("cleanupJobQuarantine.failed must be greater than or equal to the returned failure count.");
  }
  if (failureItemLimit < returnedFailures) {
    throw new Error("cleanupJobQuarantine.failureItemLimit must be greater than or equal to the returned failure count.");
  }
}

function assertQuarantineCleanupFailureArrayProperties(values: unknown[]): void {
  for (const key of safeOwnKeys(values, "cleanupJobQuarantine.failures")) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string") {
      throw new Error("cleanupJobQuarantine.failures must not contain symbol properties.");
    }
    if (!isArrayIndexKey(key, values.length)) {
      throw new Error(`cleanupJobQuarantine.failures.${key} is not a supported array field.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(values, key, "cleanupJobQuarantine.failures");
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`cleanupJobQuarantine.failures[${key}] must not contain non-enumerable or accessor properties.`);
    }
  }
}

function validateQuarantineCleanupFailures(values: unknown[]): Array<{ path: string; error: string }> {
  const failures: Array<{ path: string; error: string }> = [];
  for (let index = 0; index < values.length; index += 1) {
    const descriptor = safeGetOwnPropertyDescriptor(values, String(index), "cleanupJobQuarantine.failures");
    if (!descriptor) {
      throw new Error(`cleanupJobQuarantine.failures[${index}] must not be a sparse array hole.`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`cleanupJobQuarantine.failures[${index}] must not contain non-enumerable or accessor properties.`);
    }
    failures.push(validateQuarantineCleanupFailure(descriptor.value, index));
  }
  return failures;
}

function validateQuarantineCleanupFailure(value: unknown, index: number): { path: string; error: string } {
  const object = assertObject(value, `cleanupJobQuarantine.failures[${index}]`);
  assertKnownFields(object, `cleanupJobQuarantine.failures[${index}]`, ["path", "error"]);
  return {
    path: quarantineCleanupText(object.path, `cleanupJobQuarantine.failures[${index}].path`),
    error: quarantineCleanupText(object.error, `cleanupJobQuarantine.failures[${index}].error`)
  };
}

function quarantineCleanupText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  const text = value.trim();
  if (text.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (text.length > MAX_JOB_ERROR_CHARS) {
    throw new Error(`${label} must be at most ${MAX_JOB_ERROR_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(text, MAX_JOB_ERROR_BYTES) > MAX_JOB_ERROR_BYTES) {
    throw new Error(`${label} must be at most ${MAX_JOB_ERROR_BYTES} UTF-8 bytes.`);
  }
  if (JOB_ERROR_CONTROL_CHARS.test(text)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  return truncateErrorMessage(redactInlineSecrets(text));
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

function optionalArgsObject(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  return assertObject(value, label);
}

function validateAsyncToolArgs(toolName: AsyncToolName, value: unknown, label: string): Record<string, unknown> {
  const args = optionalArgsObject(value, label);
  switch (toolName) {
    case "novel_start":
      return validateStartArgs(args, label);
    case "novel_start_volume":
      return validateStartVolumeArgs(args, label);
    case "novel_next":
    case "novel_finalize_world":
    case "novel_finalize_setting":
    case "novel_finalize_outline":
      return validateLocatorArgs(args, label);
    case "novel_submit_world":
    case "novel_submit_setting":
    case "novel_submit_outline":
    case "novel_save_beat_draft":
    case "novel_submit_beat":
    case "novel_rewrite_beat":
      return args;
    case "novel_build_epub":
      return validateBuildEpubArgs(args, label);
  }
}

function validateStartVolumeArgs(args: Record<string, unknown>, label: string): Record<string, unknown> {
  const object = assertShape(args, label, {
    franchiseId: "string",
    workId: "string",
    volumeRequest: "string",
    franchiseName: "optionalString",
    workTitle: "optionalString"
  });
  const franchiseName = asOptionalBoundedSingleLineString(object.franchiseName, `${label}.franchiseName`, MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES);
  const workTitle = asOptionalBoundedSingleLineString(object.workTitle, `${label}.workTitle`, MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES);
  return {
    franchiseId: assertSafeId(object.franchiseId, `${label}.franchiseId`),
    workId: assertSafeId(object.workId, `${label}.workId`),
    volumeRequest: assertBoundedNonEmptySingleLineString(object.volumeRequest, `${label}.volumeRequest`, MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES),
    ...(franchiseName ? { franchiseName } : {}),
    ...(workTitle ? { workTitle } : {})
  };
}

function validateStartArgs(args: Record<string, unknown>, label: string): Record<string, unknown> {
  const object = assertShape(args, label, {
    franchiseName: "string",
    workRequest: "string",
    volumeRequest: "optionalString",
    genre: "optionalString",
    tone: "optionalString",
    targetLength: "optionalString"
  });
  const volumeRequest = asOptionalBoundedSingleLineString(object.volumeRequest, `${label}.volumeRequest`, MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES);
  const genre = asOptionalBoundedSingleLineString(object.genre, `${label}.genre`, MAX_OPTION_INPUT_CHARS, MAX_OPTION_INPUT_BYTES);
  const tone = asOptionalBoundedSingleLineString(object.tone, `${label}.tone`, MAX_OPTION_INPUT_CHARS, MAX_OPTION_INPUT_BYTES);
  const targetLength = asOptionalBoundedSingleLineString(object.targetLength, `${label}.targetLength`, MAX_OPTION_INPUT_CHARS, MAX_OPTION_INPUT_BYTES);
  return {
    franchiseName: assertBoundedNonEmptySingleLineString(object.franchiseName, `${label}.franchiseName`, MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES),
    workRequest: assertBoundedNonEmptySingleLineString(object.workRequest, `${label}.workRequest`, MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES),
    ...(volumeRequest ? { volumeRequest } : {}),
    ...(genre ? { genre } : {}),
    ...(tone ? { tone } : {}),
    ...(targetLength ? { targetLength } : {})
  };
}

function validateLocatorArgs(args: Record<string, unknown>, label: string): Record<string, unknown> {
  const object = assertShape(args, label, {
    franchiseId: "optionalString",
    workId: "optionalString",
    volumeId: "optionalString",
    current: "optionalBoolean"
  });
  const hasExplicitIds = Boolean(object.franchiseId || object.workId || object.volumeId);
  if (object.current && hasExplicitIds) {
    throw new Error(`${label}.current cannot be combined with franchiseId, workId, or volumeId.`);
  }
  if (object.current === false && !hasExplicitIds) {
    throw new Error(`${label}.current:false requires franchiseId, workId, and volumeId.`);
  }
  if (hasExplicitIds && (!object.franchiseId || !object.workId || !object.volumeId)) {
    throw new Error(`${label}.franchiseId, workId, and volumeId are required together.`);
  }
  return {
    ...(object.franchiseId === undefined ? {} : { franchiseId: assertSafeId(object.franchiseId, `${label}.franchiseId`) }),
    ...(object.workId === undefined ? {} : { workId: assertSafeId(object.workId, `${label}.workId`) }),
    ...(object.volumeId === undefined ? {} : { volumeId: assertSafeId(object.volumeId, `${label}.volumeId`) }),
    ...(object.current === undefined ? {} : { current: object.current as boolean })
  };
}

function validateBuildEpubArgs(args: Record<string, unknown>, label: string): Record<string, unknown> {
  const object = assertShape(args, label, {
    franchiseId: "string",
    workId: "string",
    volumeId: "string"
  });
  return {
    franchiseId: assertSafeId(object.franchiseId, `${label}.franchiseId`),
    workId: assertSafeId(object.workId, `${label}.workId`),
    volumeId: assertSafeId(object.volumeId, `${label}.volumeId`)
  };
}

function cloneJobArgs(args: Record<string, unknown>): Record<string, unknown> {
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of safeOwnKeys(args, "Validated job args")) {
    if (typeof key !== "string") {
      throw new Error("Validated job args must not contain symbol properties.");
    }
    const descriptor = safeGetOwnPropertyDescriptor(args, key, "Validated job args");
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`Validated job args.${key} must be an enumerable data property.`);
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

function optionalJobErrorString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a non-empty string when present.`);
  }
  const text = value.trim();
  if (text.length === 0) {
    throw new Error(`${label} must be a non-empty string when present.`);
  }
  if (text.length > MAX_JOB_ERROR_CHARS) {
    throw new Error(`${label} must be at most ${MAX_JOB_ERROR_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(text, MAX_JOB_ERROR_BYTES) > MAX_JOB_ERROR_BYTES) {
    throw new Error(`${label} must be at most ${MAX_JOB_ERROR_BYTES} UTF-8 bytes.`);
  }
  if (JOB_ERROR_CONTROL_CHARS.test(text)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  return truncateErrorMessage(redactInlineSecrets(text));
}

function optionalBoundedInteger(value: unknown, label: string, defaultValue: number, min: number, max: number): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer.`);
  }
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

function assertIntegerInRange(value: unknown, label: string, min: number, max: number): void {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer.`);
  }
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
}

function validateJobPipeline(value: unknown): void {
  assertNoSymbolInjectionProperties(value, "JobManager.pipeline");
  if (!safeInstanceOf(value, NovelPipeline, "JobManager.pipeline")) {
    throw new Error("JobManager.pipeline must be a NovelPipeline instance.");
  }
  validateMethodObject(value, "start", "JobManager.pipeline");
  validateMethodObject(value, "startVolume", "JobManager.pipeline");
  validateMethodObject(value, "next", "JobManager.pipeline");
  validateMethodObject(value, "submitWorld", "JobManager.pipeline");
  validateMethodObject(value, "finalizeWorld", "JobManager.pipeline");
  validateMethodObject(value, "submitSetting", "JobManager.pipeline");
  validateMethodObject(value, "finalizeSetting", "JobManager.pipeline");
  validateMethodObject(value, "submitOutline", "JobManager.pipeline");
  validateMethodObject(value, "finalizeOutline", "JobManager.pipeline");
  validateMethodObject(value, "saveBeatDraft", "JobManager.pipeline");
  validateMethodObject(value, "submitBeat", "JobManager.pipeline");
  validateMethodObject(value, "rewriteBeat", "JobManager.pipeline");
  validateMethodObject(value, "status", "JobManager.pipeline");
  validateMethodObject(value, "buildEpub", "JobManager.pipeline");
}

function validateJobStorage(value: unknown): void {
  if (value === undefined) {
    return;
  }
  assertNoSymbolInjectionProperties(value, "JobManager.storage");
  if (!safeInstanceOf(value, NovelStorage, "JobManager.storage")) {
    throw new Error("JobManager.storage must be a NovelStorage instance.");
  }
  validateMethodObject(value, "listJobIds", "JobManager.storage");
  validateMethodObject(value, "readJob", "JobManager.storage");
  validateMethodObject(value, "writeJob", "JobManager.storage");
  validateMethodObject(value, "deleteJob", "JobManager.storage");
  validateMethodObject(value, "quarantineJob", "JobManager.storage");
  validateMethodObject(value, "cleanupJobQuarantine", "JobManager.storage");
  const descriptor = safeGetOwnPropertyDescriptor(value as object, "root", "JobManager.storage");
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") {
    throw new Error("JobManager.storage.root must be an enumerable data string.");
  }
  validateInjectedStorageRoot(descriptor.value, "JobManager.storage.root");
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

function safeInstanceOf(value: unknown, constructor: Function, label: string): boolean {
  try {
    return value instanceof (constructor as any);
  } catch {
    throw new Error(`${label} prototype must be readable.`);
  }
}

function validateInjectedStorageRoot(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty absolute path.`);
  }
  if (value.length > MAX_JOB_STORAGE_ROOT_CHARS) {
    throw new Error(`${label} must be at most ${MAX_JOB_STORAGE_ROOT_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(value, MAX_JOB_STORAGE_ROOT_BYTES) > MAX_JOB_STORAGE_ROOT_BYTES) {
    throw new Error(`${label} must be at most ${MAX_JOB_STORAGE_ROOT_BYTES} UTF-8 bytes.`);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, timeoutMsForTimer(ms));
  });
}

function timeoutMsForTimer(ms: number): number {
  return Math.min(ms, MAX_SET_TIMEOUT_MS);
}

function errorMessage(error: unknown): string {
  return truncateErrorMessage(redactErrorMessage(error).replace(JOB_ERROR_CONTROL_CHARS_GLOBAL, " "));
}

function reportedJobPath(value: string, root: string | undefined): string {
  const redacted = redactRoot(errorMessage(value), root);
  return redacted ?? errorMessage(value);
}

function truncateErrorMessage(message: string): string {
  if (
    message.length <= MAX_JOB_ERROR_CHARS &&
    utf8ByteLengthUpTo(message, MAX_JOB_ERROR_BYTES) <= MAX_JOB_ERROR_BYTES
  ) {
    return message;
  }
  if (message.length > MAX_JOB_ERROR_CHARS) {
    const candidate = `${message.slice(0, MAX_JOB_ERROR_CHARS)}... [truncated ${message.length - MAX_JOB_ERROR_CHARS} chars]`;
    if (utf8ByteLengthUpTo(candidate, MAX_JOB_ERROR_BYTES) <= MAX_JOB_ERROR_BYTES) {
      return candidate;
    }
  }
  return truncateErrorMessageByBytes(message);
}

function truncateErrorMessageByBytes(message: string): string {
  const marker = `... [truncated ${Math.max(0, utf8ByteLength(message) - MAX_JOB_ERROR_BYTES)} UTF-8 bytes]`;
  const markerBytes = utf8ByteLength(marker);
  if (markerBytes > MAX_JOB_ERROR_BYTES) {
    return marker;
  }
  return `${message.slice(0, utf8PrefixLength(message, MAX_JOB_ERROR_BYTES - markerBytes))}${marker}`;
}

function jobToolResult(result: ToolResult): ToolResult {
  const output = jobData({
    status: result.status,
    message: result.message
  }) as unknown as ToolResult;
  if (Object.prototype.hasOwnProperty.call(result, "data")) {
    output.data = result.data;
  }
  return output;
}

function jobData(fields: Record<string, unknown>): Record<string, unknown> {
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of safeOwnKeys(fields, "Job data fields")) {
    if (typeof key !== "string") {
      throw new Error("Job data fields must not contain symbol properties.");
    }
    const descriptor = safeGetOwnPropertyDescriptor(fields, key, "Job data fields");
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`Job data fields.${key} must be an enumerable data property.`);
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

function jobArray<T>(items: T[]): T[] {
  return [...items];
}

function snapshot(job: JobRecord, redactionRoot?: string, includePersistencePending = false): JobStatusSnapshot {
  const output = jobData({
    jobId: job.jobId,
    toolName: job.toolName,
    status: job.status,
    createdAt: job.createdAt,
    cancelRequested: job.cancelRequested
  }) as unknown as JobStatusSnapshot;
  if (job.startedAt !== undefined) {
    output.startedAt = job.startedAt;
  }
  if (job.finishedAt !== undefined) {
    output.finishedAt = job.finishedAt;
  }
  if (job.result !== undefined) {
    output.result = redactToolResultRoot(job.result, redactionRoot);
  }
  const error = redactRoot(job.error, redactionRoot);
  if (error !== undefined) {
    output.error = error;
  }
  const persistenceError = redactRoot(job.persistenceError, redactionRoot);
  if (persistenceError !== undefined) {
    output.persistenceError = persistenceError;
  }
  if (includePersistencePending && job.persistenceTail) {
    output.persistencePending = true;
  }
  return output;
}

function listSnapshot(job: JobRecord): JobListSnapshot {
  const output = jobData({
    jobId: job.jobId,
    toolName: job.toolName,
    status: job.status,
    createdAt: job.createdAt,
    cancelRequested: job.cancelRequested,
    hasError: Boolean(job.error),
    hasPersistenceError: Boolean(job.persistenceError),
    persistencePending: Boolean(job.persistenceTail)
  }) as unknown as JobListSnapshot;
  if (job.startedAt !== undefined) {
    output.startedAt = job.startedAt;
  }
  if (job.finishedAt !== undefined) {
    output.finishedAt = job.finishedAt;
  }
  return output;
}

function redactRoot(value: string | undefined, root: string | undefined): string | undefined {
  if (!value || !root) {
    return value;
  }
  return value.split(root).join("<data-root>");
}

function redactToolResultRoot(result: ToolResult, root: string | undefined): ToolResult {
  const output = jobData({
    status: result.status,
    message: redactToolResultString(result.message, root)
  }) as unknown as ToolResult;
  if (Object.prototype.hasOwnProperty.call(result, "data")) {
    output.data = redactJsonValueRoot(result.data, root);
  }
  return output;
}

function redactToolResultString(value: string, root: string | undefined): string {
  const redacted = redactInlineSecrets(value);
  return redactRoot(redacted, root) ?? redacted;
}

function redactJsonValueRoot(value: unknown, root: string | undefined): unknown {
  if (typeof value === "string") {
    return redactToolResultString(value, root);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    try {
      if (safeGetPrototypeOf(value, "Job result data array") !== Array.prototype) {
        return "[Unredactable non-standard array]";
      }
    } catch {
      return "[Unredactable array with unreadable metadata]";
    }
    let keys: Array<string | symbol>;
    try {
      keys = safeOwnKeys(value, "Job result data array");
    } catch {
      return "[Unredactable array with unreadable metadata]";
    }
    for (const key of keys) {
      if (key === "length") {
        continue;
      }
      if (typeof key !== "string" || !isArrayIndexKey(key, value.length)) {
        return "[Unredactable array with unsupported properties]";
      }
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = safeGetOwnPropertyDescriptor(value, key, "Job result data array");
      } catch {
        return "[Unredactable array with unreadable metadata]";
      }
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        return "[Unredactable array with non-data properties]";
      }
    }
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = safeGetOwnPropertyDescriptor(value, String(index), "Job result data array");
      } catch {
        output.push("[Unredactable array item]");
        continue;
      }
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        output.push("[Unredactable array item]");
        continue;
      }
      output.push(redactJsonValueRoot(descriptor.value, root));
    }
    return jobArray(output);
  }
  if (value && typeof value === "object") {
    let prototype: object | null;
    try {
      prototype = safeGetPrototypeOf(value, "Job result data object");
    } catch {
      return "[Unredactable object with unreadable metadata]";
    }
    if (prototype !== Object.prototype && prototype !== null) {
      return "[Unredactable non-plain object]";
    }
    let keys: Array<string | symbol>;
    try {
      keys = safeOwnKeys(value, "Job result data object");
    } catch {
      return "[Unredactable object with unreadable metadata]";
    }
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") {
        return "[Unredactable object with symbol properties]";
      }
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = safeGetOwnPropertyDescriptor(value, key, "Job result data object");
      } catch {
        return "[Unredactable object with unreadable metadata]";
      }
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        const redactedKey = uniqueRedactedObjectKey(output, redactToolResultString(key, root));
        Object.defineProperty(output, redactedKey, {
          value: "[Unredactable object property]",
          enumerable: true,
          configurable: true,
          writable: true
        });
        continue;
      }
      const redactedKey = uniqueRedactedObjectKey(output, redactToolResultString(key, root));
      Object.defineProperty(output, redactedKey, {
        value: redactJsonValueRoot(descriptor.value, root),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return output;
  }
  return value;
}

function uniqueRedactedObjectKey(output: Record<string, unknown>, key: string): string {
  if (!Object.prototype.hasOwnProperty.call(output, key)) {
    return key;
  }
  let index = 2;
  while (Object.prototype.hasOwnProperty.call(output, `${key} (${index})`)) {
    index += 1;
  }
  return `${key} (${index})`;
}

function isArrayIndexKey(value: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    return false;
  }
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === value;
}

function recordFromSnapshot(saved: JobSnapshot & { args?: unknown }): JobRecord {
  return {
    ...saved,
    args: saved.args ?? {},
    cancelRequested: saved.cancelRequested,
    isCancelled() {
      return this.cancelRequested;
    }
  };
}
