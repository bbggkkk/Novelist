import { NovelStorage } from "../storage.js";
import type { VolumeState } from "../types.js";
import { ArtifactRegistry } from "./artifactRegistry.js";
import type { PipelineProcess, PipelineStatus } from "./model.js";
import { createCompleteProcess } from "./processes/completeProcess.js";
import { createDocumentProcess } from "./processes/documentProcess.js";
import { createEpubProcess } from "./processes/epubProcess.js";
import { createOutlineProcess } from "./processes/outlineProcess.js";
import { createWritingProcess } from "./processes/writingProcess.js";

export class PipelineOrchestrator {
  private readonly processes: PipelineProcess[];

  constructor(storage: NovelStorage) {
    const artifacts = new ArtifactRegistry(storage);
    this.processes = [
      createDocumentProcess("franchise.world", "franchise", "world", artifacts),
      createDocumentProcess("franchise.setting", "franchise", "setting", artifacts),
      createDocumentProcess("work.world", "work", "world", artifacts),
      createDocumentProcess("work.setting", "work", "setting", artifacts),
      createDocumentProcess("volume.world", "volume", "world", artifacts),
      createDocumentProcess("volume.setting", "volume", "setting", artifacts),
      createOutlineProcess(artifacts),
      createWritingProcess(),
      createEpubProcess(artifacts),
      createCompleteProcess()
    ];
  }

  async inspect(state: VolumeState): Promise<PipelineStatus> {
    for (const process of this.processes) {
      const inspection = await process.inspect(state);
      if (inspection.status === "needs_action") {
        return {
          processId: inspection.processId,
          requiredAction: inspection.requiredAction,
          ...(inspection.target ? { target: inspection.target } : {}),
          ...(inspection.currentBeat ? { currentBeat: inspection.currentBeat } : {})
        };
      }
    }
    return { processId: "volume.complete", requiredAction: "none" };
  }
}
