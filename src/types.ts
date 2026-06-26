export type PipelinePhase =
  | "franchise_world"
  | "franchise_setting"
  | "work_world"
  | "work_setting"
  | "volume_world"
  | "volume_setting"
  | "volume_outline"
  | "writing"
  | "epub"
  | "complete";

export type PipelineFlowStatus = "needs_input" | "pending_finalization" | "ready" | "complete";

export type WorldScope = "franchise" | "work" | "volume";
export type SettingScope = "franchise" | "work" | "volume";

export interface ConsistencyIssue {
  scope: string;
  description: string;
}

export interface ConsistencyReport {
  ok: boolean;
  checkedAgainst: string[];
  issues: ConsistencyIssue[];
}

export interface LastConsistencyFailure {
  phase: PipelinePhase;
  submittedAt: string;
  report: ConsistencyReport;
}

export interface StartInput {
  franchiseName: string;
  workRequest: string;
  volumeRequest?: string;
  genre?: string;
  tone?: string;
  targetLength?: string;
}

export interface LocatorInput {
  franchiseId?: string;
  workId?: string;
  volumeId?: string;
  current?: boolean;
}

export interface BuildEpubInput {
  franchiseId: string;
  workId: string;
  volumeId: string;
}

export interface OutlineBeatInput {
  title: string;
  targetWords: number;
}

export interface OutlineChapterInput {
  title: string;
  targetWords?: number;
  beats: OutlineBeatInput[];
}

export interface BeatState {
  chapterNo: number;
  beatNo: number;
  title: string;
  targetWords: number;
  status: "pending" | "complete";
}

export interface ChapterState {
  chapterNo: number;
  title: string;
  targetWords: number;
  beats: BeatState[];
}

export interface VolumeState {
  schemaVersion: 1;
  franchiseId: string;
  franchiseName: string;
  workId: string;
  workTitle: string;
  volumeId: string;
  volumeTitle: string;
  phase: PipelinePhase;
  flowStatus: PipelineFlowStatus;
  lastConsistencyFailure?: LastConsistencyFailure;
  currentChapterNo: number;
  currentBeatNo: number;
  chapters: ChapterState[];
  createdAt: string;
  updatedAt: string;
}

export interface ToolResult {
  status: PipelineFlowStatus | "ok";
  message: string;
  data?: unknown;
}
