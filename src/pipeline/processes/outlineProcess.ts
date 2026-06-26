import type { PipelineProcess, ProcessInspection } from "../model.js";
import { ArtifactRegistry } from "../artifactRegistry.js";
import type { VolumeState } from "../../types.js";

export function createOutlineProcess(artifacts: ArtifactRegistry): PipelineProcess {
  return {
    id: "volume.outline",
    async inspect(state: VolumeState): Promise<ProcessInspection> {
      if (state.completedProcesses.includes("volume.outline")) return { status: "complete", processId: "volume.outline" };
      const exists = await artifacts.outlineExists(state);
      return {
        status: "needs_action",
        processId: "volume.outline",
        requiredAction: exists && state.chapters.length > 0 ? "finalize_outline" : "submit_outline"
      };
    }
  };
}
