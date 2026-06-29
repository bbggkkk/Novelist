import type {
  Date,
  Gender,
  CharacterRole,
  Archetype,
  Build,
  BloodType,
  CharacterStatus,
  Relationship,
  Timestamped,
} from "./common"

// ========================
// Physical Appearance
// ========================

/** 캐릭터의 신체적 외형 */
export interface Appearance {
  height?: number           // cm
  weight?: number           // kg
  build?: Build
  hairColor?: string
  hairStyle?: string
  eyeColor?: string
  skinTone?: string
  distinctiveFeatures?: string[]  // 흉터, 문신, 특이점 등
  handedness?: "left" | "right" | "ambidextrous"
  voice?: string            // 목소리 특징
  style?: string            // 패션/복장 스타일
}

// ========================
// Personality
// ========================

/** 캐릭터의 성격/심리 */
export interface Personality {
  mbti?: string             // MBTI (예: "INFP")
  enneagram?: string        // 에니어그램 (예: "4w5")
  traits?: string[]         // 성격 형용사들
  strengths?: string[]      // 강점
  weaknesses?: string[]     // 약점
  fears?: string[]          // 두려워하는 것
  desires?: string[]        // 갈망/욕구
  values?: string[]         // 가치관
  quirks?: string[]         // 버릇/특이사항
  habits?: string[]         // 습관
  hobbies?: string[]        // 취미
}

// ========================
// Background
// ========================

/** 캐릭터의 배경 스토리 */
export interface Background {
  birthplace?: string
  nationality?: string
  ethnicity?: string
  occupation?: string
  education?: string
  socialClass?: "lower" | "middle" | "upper" | "nobility" | "royalty"
  religion?: string
  affiliation?: string      // 소속 (길드, 조직, 국가 등)
  family?: string           // 가족 관계 설명
  backstory?: string        // 종합 과거사
}

// ========================
// Story Role
// ========================

/** 작품 내 캐릭터의 서사적 위치 */
export interface StoryRole {
  role: CharacterRole
  archetype?: Archetype
  importance?: number       // 중요도 (1-10)
  characterArc?: string     // 성장 곡선 설명 (예: "겁쟁이에서 용사로")
  motivation?: string       // 핵심 동기
  conflict?: string         // 내적/외적 갈등
  catchphrase?: string[]    // 대표 대사
}

// ========================
// Main Character Interface
// ========================

export interface Character extends Partial<Timestamped> {
  /** 고유 식별자 */
  id: string

  /** 이름 */
  name: string

  /** 다른 이름/별칭/필명 */
  alias: string[]

  /** 성별 */
  gender: Gender

  /** 생년월일 (게임 시간 기준) */
  birth?: Date

  /** 사망일 (사망한 캐릭터의 경우) */
  death?: Date

  /** 나이 (작품 시작 시점) */
  age?: number

  /** 혈액형 */
  bloodType?: BloodType

  /** 종 (판타지/SF 한정: 인간, 엘프, 오크, 안드로이드 등) */
  species?: string

  /** 외형 */
  appearance?: Appearance

  /** 성격 */
  personality?: Personality

  /** 배경 */
  background?: Background

  /** 서사적 역할 */
  storyRole?: StoryRole

  /** 상태 */
  status?: CharacterStatus

  /** 타 캐릭터와의 관계 */
  relationships?: Relationship[]

  /** 캐릭터 태그 (분류/검색용) */
  tags?: string[]

  /** 캐릭터에 대한 작가 노트 */
  notes?: string
}

// ========================
// Character Create/Update
// ========================

/** 캐릭터 생성 시 필요한 필드 (id, 생성일 제외) */
export type CreateCharacter = Omit<Character, "id" | "createdAt" | "updatedAt">

/** 캐릭터 일부 업데이트용 */
export type UpdateCharacter = Partial<CreateCharacter>