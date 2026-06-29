// ========================
// Basic Primitives
// ========================

/** YYYY-MM-DD HH:mm:ss 형식의 날짜/시간 문자열 */
export type Date = `${number}-${number}-${number} ${number}:${number}:${number}`;

/** YYYY-MM-DD 형식의 날짜 문자열 */
export type DateOnly = `${number}-${number}-${number}`;

// ========================
// Sentinel (상징적 값)
// ========================

/** 열린 집합 타입에서 "기타" / "알 수 없음" 을 나타내는 센티널 */
export type Sentinel = {
    type: "other",
    value: string
};

// ========================
// Character-related Enums / Unions
// ========================

/** 성별 */
export type Gender = "male" | "female" | "non-binary" | Sentinel;

/** 캐릭터의 서사적 역할 */
export type CharacterRole =
  | "protagonist"
  | "antagonist"
  | "deuteragonist"
  | "tritagonist"
  | "love_interest"
  | "mentor"
  | "ally"
  | "foil"
  | "comic_relief"
  | "narrator"
  | "supporting"
  | "minor"
  | "cameo"
  | Sentinel;

/** 캐릭터 아키타입 */
export type Archetype =
  | "hero"
  | "villain"
  | "mentor"
  | "herald"
  | "trickster"
  | "shapeshifter"
  | "guardian"
  | "shadow"
  | "ally"
  | "innocent"
  | "orphan"
  | "warrior"
  | "caregiver"
  | "explorer"
  | "rebel"
  | "lover"
  | "creator"
  | "ruler"
  | "magician"
  | "sage"
  | Sentinel;

/** 체형 */
export type Build = "slim" | "average" | "athletic" | "muscular" | "plump" | "obese" | "frail" | Sentinel;

/** 성격 특성 (Big Five 기반) */
export type PersonalityTrait =
  | "openness"
  | "conscientiousness"
  | "extraversion"
  | "agreeableness"
  | "neuroticism";

/** 혈액형 */
export type BloodType = "A" | "B" | "AB" | "O";

// ========================
// World-building Enums
// ========================

/** 세계관/장르 유형 */
export type Genre =
  | "fantasy"
  | "sci_fi"
  | "romance"
  | "mystery"
  | "thriller"
  | "horror"
  | "historical"
  | "slice_of_life"
  | "adventure"
  | "drama"
  | "comedy"
  | "tragedy"
  | "mythic"
  | "post_apocalyptic"
  | "superhero"
  | Sentinel;

/** 캐릭터 상태 (스토리 진행에 따른) */
export type CharacterStatus = "alive" | "deceased" | "missing" | "presumed_dead" | Sentinel;

// ========================
// Relationship
// ========================

/** 캐릭터 간 관계 */
export interface Relationship {
  characterId: string;
  type: "family" | "friend" | "romance" | "rival" | "enemy" | "mentor" | "subordinate" | "ally" | "acquaintance" | Sentinel;
  label?: string;        // 구체적인 호칭 (예: "어머니", "라이벌")
  description?: string;   // 관계 설명
  intensity?: number;     // 관계 강도 (1-10)
}

// ========================
// Metadata
// ========================

/** 생성/수정 이력 */
export interface Timestamped {
  createdAt: Date;
  updatedAt: Date;
}