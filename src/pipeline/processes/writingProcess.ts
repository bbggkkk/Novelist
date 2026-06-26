import type { PipelineProcess, ProcessInspection } from "../model.js";
import type { VolumeState } from "../../types.js";

function currentBeat(state: VolumeState) {
  return state.chapters.flatMap((chapter) => chapter.beats).find((beat) => beat.chapterNo === state.currentChapterNo && beat.beatNo === state.currentBeatNo && beat.status !== "complete");
}

export function createWritingProcess(): PipelineProcess {
  return {
    id: "volume.writing",
    async inspect(state: VolumeState): Promise<ProcessInspection> {
      if (state.completedProcesses.includes("volume.writing")) return { status: "complete", processId: "volume.writing" };
      const beat = currentBeat(state);
      if (!beat) return { status: "complete", processId: "volume.writing" };
      return {
        status: "needs_action",
        processId: "volume.writing",
        requiredAction: "submit_beat",
        target: { chapterNo: beat.chapterNo, beatNo: beat.beatNo },
        currentBeat: beat
      };
    }
  };
}
