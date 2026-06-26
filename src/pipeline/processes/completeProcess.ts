import type { PipelineProcess, ProcessInspection } from "../model.js";

export function createCompleteProcess(): PipelineProcess {
  return {
    id: "volume.complete",
    async inspect(): Promise<ProcessInspection> {
      return { status: "needs_action", processId: "volume.complete", requiredAction: "none" };
    }
  };
}
