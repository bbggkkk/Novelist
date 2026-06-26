import { NovelStorage } from "../storage.js";
import type { VolumeState, WorldScope, SettingScope } from "../types.js";

export class ArtifactRegistry {
  constructor(private readonly storage: NovelStorage) {}

  async documentExists(state: VolumeState, scope: WorldScope | SettingScope, document: "world" | "setting"): Promise<boolean> {
    return Boolean(document === "world"
      ? await this.storage.readScopedWorldFile(state, scope)
      : await this.storage.readScopedSettingFile(state, scope));
  }

  async outlineExists(state: VolumeState): Promise<boolean> {
    return Boolean(await this.storage.readOutlineFile(state));
  }

  async beatExists(state: VolumeState, chapterNo: number, beatNo: number): Promise<boolean> {
    return this.storage.beatFileExists(state, chapterNo, beatNo);
  }

  async epubExists(state: VolumeState): Promise<boolean> {
    return this.storage.epubFileExists(state);
  }
}
