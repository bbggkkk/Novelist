import type { Genre, Timestamped } from "./common"

// ========================
// World-building Lore
// ========================

/** 주요 설정 카테고리 */
export type LoreCategory =
  | "world"
  | "geography"
  | "history"
  | "magic"
  | "technology"
  | "culture"
  | "religion"
  | "politics"
  | "economy"
  | "organization"
  | "creature"
  | "item"
  | "event"
  | "concept"
  | "other";

/** 설정 간 관계 */
export interface LoreRelation {
  targetId: string;
  type: "causes" | "follows" | "contradicts" | "supports" | "located_in" | "part_of" | "related_to";
  description?: string;
}

/** 세계관 설정 */
export interface Lore extends Partial<Timestamped> {
  id: string;
  title: string;
  category: LoreCategory;
  summary: string;               // 간략 요약
  content: string;               // 상세 내용 (마크다운)

  /** 연결된 캐릭터 ID 목록 */
  relatedCharacters?: string[];

  /** 연결된 다른 설정 ID 목록 */
  relatedLores?: LoreRelation[];

  /** 장르 */
  genres?: Genre[];

  /** 중요도 (1-10) */
  importance?: number;

  /** 공개/비공개 (작가 노트용) */
  isPublic?: boolean;

  /** 태그 */
  tags?: string[];

  /** 참고 자료 */
  references?: string[];
}

/** Lore 생성 타입 */
export type CreateLore = Omit<Lore, "id" | "createdAt" | "updatedAt">;