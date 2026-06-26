import type { PipelineProcess, ProcessInspection } from "../model.js";
import { ArtifactRegistry } from "../artifactRegistry.js";
import type { VolumeState } from "../../types.js";

export function createEpubProcess(artifacts: ArtifactRegistry): PipelineProcess {
  return {
    id: "volume.epub",
    async inspect(state: VolumeState): Promise<ProcessInspection> {
      if (state.phase === "complete") return { status: "complete", processId: "volume.epub" };
      if (state.phase !== "epub") return { status: "complete", processId: "volume.epub" };
      if (await artifacts.epubExists(state)) return { status: "complete", processId: "volume.epub" };
      return { status: "needs_action", processId: "volume.epub", requiredAction: "build_epub" };
    }
  };
}
