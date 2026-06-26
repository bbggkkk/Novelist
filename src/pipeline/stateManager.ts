import { createHash, randomUUID } from "node:crypto";
import { NovelStorage } from "../storage.js";
import type { VolumeState } from "../types.js";
import type { ActionKind, ActionTarget, ActiveAction, ProcessId } from "./model.js";

type MutableVolumeState = VolumeState & { activeAction?: ActiveAction };

export class PipelineStateManager {
  constructor(private readonly storage: NovelStorage) {}

  async beginAction(state: MutableVolumeState, input: { processId: ProcessId; kind: Exclude<ActionKind, "none">; target?: ActionTarget; input: unknown }): Promise<ActiveAction> {
    const now = new Date().toISOString();
    const action: ActiveAction = {
      id: `action-${randomUUID()}`,
      processId: input.processId,
      kind: input.kind,
      status: "started",
      ...(input.target ? { target: input.target } : {}),
      artifactPaths: [],
      inputHash: stableInputHash(input.input),
      startedAt: now,
      updatedAt: now
    };
    state.activeAction = action;
    await this.storage.saveState(state);
    return action;
  }

  async markArtifactWritten(state: MutableVolumeState, actionId: string, artifactPaths: string[]): Promise<void> {
    const action = requireActiveAction(state, actionId);
    action.status = "artifact_written";
    action.artifactPaths = [...artifactPaths];
    action.updatedAt = new Date().toISOString();
    await this.storage.saveState(state);
  }

  async commitState(state: MutableVolumeState, actionId: string, mutate: () => void): Promise<void> {
    const action = requireActiveAction(state, actionId);
    mutate();
    action.status = "state_committed";
    action.updatedAt = new Date().toISOString();
    await this.storage.saveState(state);
  }

  async clearAction(state: MutableVolumeState, actionId: string): Promise<void> {
    requireActiveAction(state, actionId);
    state.activeAction = undefined;
    await this.storage.saveState(state);
  }
}

function requireActiveAction(state: MutableVolumeState, actionId: string): ActiveAction {
  if (!state.activeAction) throw new Error("No active pipeline action is available.");
  if (state.activeAction.id !== actionId) throw new Error(`Active pipeline action mismatch: expected ${state.activeAction.id}, actual ${actionId}.`);
  return state.activeAction;
}

function stableInputHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}
