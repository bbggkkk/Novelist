import type { PipelineProcess, ProcessId, ProcessInspection } from "../model.js";
import { ArtifactRegistry } from "../artifactRegistry.js";
import type { VolumeState, WorldScope, SettingScope } from "../../types.js";

type DocumentKind = "world" | "setting";

export function createDocumentProcess(id: ProcessId, scope: WorldScope | SettingScope, document: DocumentKind, artifacts: ArtifactRegistry): PipelineProcess {
  return {
    id,
    async inspect(state: VolumeState): Promise<ProcessInspection> {
      if (state.completedProcesses.includes(id)) return { status: "complete", processId: id };
      const exists = await artifacts.documentExists(state, scope, document);
      return {
        status: "needs_action",
        processId: id,
        requiredAction: exists ? "finalize_document" : "submit_document",
        target: { scope, document }
      };
    }
  };
}
