import type { BeatState, ConsistencyReport, OutlineChapterInput, VolumeState, WorldScope, SettingScope } from "../types.js";

export type ProcessId =
  | "franchise.world"
  | "franchise.setting"
  | "work.world"
  | "work.setting"
  | "volume.world"
  | "volume.setting"
  | "volume.outline"
  | "volume.writing"
  | "volume.epub"
  | "volume.complete";

export type ActionKind =
  | "submit_document"
  | "finalize_document"
  | "submit_outline"
  | "finalize_outline"
  | "submit_beat"
  | "save_beat_draft"
  | "rewrite_beat"
  | "build_epub"
  | "none";

export interface ActionTarget {
  scope?: WorldScope | SettingScope;
  document?: "world" | "setting";
  chapterNo?: number;
  beatNo?: number;
}

export type PipelineAction =
  | { kind: "submit_document"; processId: ProcessId; target: ActionTarget; text: string; report: ConsistencyReport }
  | { kind: "finalize_document"; processId: ProcessId; target: ActionTarget }
  | { kind: "submit_outline"; text: string; chapters: OutlineChapterInput[]; report: ConsistencyReport }
  | { kind: "finalize_outline" }
  | { kind: "submit_beat"; chapterNo?: number; beatNo?: number; text: string; report: ConsistencyReport }
  | { kind: "save_beat_draft"; chapterNo?: number; beatNo?: number; text: string }
  | { kind: "rewrite_beat"; chapterNo: number; beatNo: number; text: string; report: ConsistencyReport }
  | { kind: "build_epub" };

export interface ActiveAction {
  id: string;
  processId: ProcessId;
  kind: Exclude<ActionKind, "none">;
  status: "started" | "artifact_written" | "state_committed";
  target?: ActionTarget;
  artifactPaths: string[];
  inputHash: string;
  startedAt: string;
  updatedAt: string;
}

export interface PipelineStatus {
  processId: ProcessId;
  requiredAction: ActionKind;
  target?: ActionTarget;
  currentBeat?: BeatState;
}

export type ProcessInspection =
  | { status: "complete"; processId: ProcessId }
  | { status: "needs_action"; processId: ProcessId; requiredAction: ActionKind; target?: ActionTarget; currentBeat?: BeatState };

export interface PipelineProcess {
  id: ProcessId;
  inspect(state: VolumeState): Promise<ProcessInspection>;
}
