import type { PipelineProcess, ProcessId, ProcessInspection } from "../model.js";
import { ArtifactRegistry } from "../artifactRegistry.js";
import type { PipelinePhase, VolumeState, WorldScope, SettingScope } from "../../types.js";

type DocumentKind = "world" | "setting";

const phaseByProcess: Record<ProcessId, PipelinePhase | undefined> = {
  "franchise.world": "franchise_world",
  "franchise.setting": "franchise_setting",
  "work.world": "work_world",
  "work.setting": "work_setting",
  "volume.world": "volume_world",
  "volume.setting": "volume_setting",
  "volume.outline": undefined,
  "volume.writing": undefined,
  "volume.epub": undefined,
  "volume.complete": undefined
};

export function createDocumentProcess(id: ProcessId, scope: WorldScope | SettingScope, document: DocumentKind, artifacts: ArtifactRegistry): PipelineProcess {
  const phase = phaseByProcess[id];
  if (!phase) throw new Error(`Document process has no matching phase: ${id}`);
  return {
    id,
    async inspect(state: VolumeState): Promise<ProcessInspection> {
      if (state.phase !== phase) return { status: "complete", processId: id };
      const exists = await artifacts.documentExists(state, scope, document);
      return {
        status: "needs_action",
        processId: id,
        requiredAction: exists || state.flowStatus === "pending_finalization" ? "finalize_document" : "submit_document",
        target: { scope, document }
      };
    }
  };
}
