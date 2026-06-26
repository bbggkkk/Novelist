export type PipelineStatus =
  | "pending_user_confirmation"
  | "planning"
  | "drafting"
  | "reviewing"
  | "blocked"
  | "complete";

export const CURRENT_STATE_SCHEMA_VERSION = 1;

export type AgentRole =
  | "planner"
  | "worldbuilder"
  | "continuity_otaku"
  | "writer"
  | "editor"
  | "proofreader"
  | "epub_builder";

export interface NewProjectInput {
  franchiseName: string;
  workRequest: string;
  volumeRequest?: string;
  genre?: string;
  tone?: string;
  targetLength?: string;
}

export interface ConfirmInput {
  confirmationId: string;
  approved: boolean;
  revisionInstruction?: string;
}

export interface ContinueInput {
  franchiseId?: string;
  workId?: string;
  volumeId?: string;
  current?: boolean;
}

export interface ReviseInput {
  franchiseId: string;
  workId: string;
  volumeId: string;
  target: string;
  instruction: string;
}

export interface BuildEpubInput {
  franchiseId: string;
  workId: string;
  volumeId: string;
}

export interface Confirmation {
  id: string;
  kind: "initial_outline" | "conflict_resolution" | "revision";
  message: string;
  createdAt: string;
  resolvedAt?: string;
  approved?: boolean;
  revisionInstruction?: string;
}

export interface BeatState {
  chapterNo: number;
  beatNo: number;
  title: string;
  targetWords: number;
  status: "pending" | "drafted" | "complete" | "needs_revision";
  retryCount: number;
  lastFeedback?: string;
}

export interface ChapterState {
  chapterNo: number;
  title: string;
  targetWords: number;
  beats: BeatState[];
}

export interface ConflictRecord {
  id: string;
  scope: string;
  description: string;
  severity: "info" | "warning" | "blocking";
  resolved: boolean;
}

export interface VolumeState {
  schemaVersion: 1;
  franchiseId: string;
  franchiseName: string;
  workId: string;
  workTitle: string;
  volumeId: string;
  volumeTitle: string;
  status: PipelineStatus;
  currentChapterNo: number;
  currentBeatNo: number;
  confirmations: Confirmation[];
  conflicts: ConflictRecord[];
  chapters: ChapterState[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentResult {
  text: string;
  issues: string[];
  conflict?: ConflictRecord;
}

export interface AgentContext {
  state: VolumeState;
  input?: unknown;
  previousBeatText?: string;
  currentBeat?: BeatState;
  feedback?: string[];
}

export interface NovelAgents {
  planInitial(input: NewProjectInput): Promise<AgentResult>;
  buildWorld(input: NewProjectInput, approvedOutline: string): Promise<AgentResult>;
  planSkeleton(state: VolumeState, input: NewProjectInput): Promise<AgentResult>;
  writeBeat(context: AgentContext): Promise<AgentResult>;
  editBeat(context: AgentContext, draft: string): Promise<AgentResult>;
  proofreadBeat(context: AgentContext, edited: string): Promise<AgentResult>;
  checkContinuity(context: AgentContext, text: string): Promise<AgentResult>;
  editJoinedBeats(context: AgentContext, text: string): Promise<AgentResult>;
  buildEpub(context: AgentContext, markdown: string): Promise<AgentResult>;
}

export interface ToolResult {
  status: PipelineStatus | "ok";
  message: string;
  data?: unknown;
}
