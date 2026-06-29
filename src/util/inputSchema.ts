import { z } from "zod";

/** 모든 MCP tool에 공통으로 포함되는 기본 입력 필드 */
const INPUT_SCHEMA = {
  workspace: z.string().describe("작업중인 프로젝트 폴더"),
} as const;

/**
 * 입력 스키마에 `workspace` 필드를 추가합니다.
 * 모든 MCP tool은 이 함수로 스키마를 감싸주세요.
 *
 * @example
 * const MySchema = createInputSchema({
 *   name: z.string(),
 * })
 * // 결과 타입: { workspace: ZodString, name: ZodString }
 */
export function createInputSchema<T extends Record<string, z.ZodTypeAny>>(
  input: T,
): T & typeof INPUT_SCHEMA {
  return {
    ...input,
    ...INPUT_SCHEMA,
  };
}