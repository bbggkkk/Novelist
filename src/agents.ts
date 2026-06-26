import type { AgentContext, AgentResult, NewProjectInput, NovelAgents } from "./types.js";

export class StubNovelAgents implements NovelAgents {
  async planInitial(input: NewProjectInput): Promise<AgentResult> {
    const title = input.workRequest.trim();
    return {
      text: [
        `# 대략 전개안: ${title}`,
        "",
        `- 프랜차이즈: ${input.franchiseName}`,
        `- 장르: ${input.genre ?? "미정"}`,
        `- 톤: ${input.tone ?? "미정"}`,
        `- 목표 분량: ${input.targetLength ?? "중편 1권"}`,
        "",
        "## 기",
        "주인공은 일상의 균열을 발견하고, 세계의 숨은 규칙과 처음 마주한다.",
        "",
        "## 승",
        "동료와 적대자가 드러나며 주인공의 선택이 세계관의 오래된 갈등을 건드린다.",
        "",
        "## 전",
        "주인공은 가장 믿었던 전제가 틀렸음을 깨닫고, 대가가 큰 결정을 내린다.",
        "",
        "## 결",
        "갈등은 일단락되지만 다음 작품으로 이어질 감정적·세계관적 여운을 남긴다."
      ].join("\n"),
      issues: []
    };
  }

  async buildWorld(input: NewProjectInput, approvedOutline: string): Promise<AgentResult> {
    return {
      text: [
        `# ${input.franchiseName} 세계관`,
        "",
        "## 핵심 규칙",
        "- 세계는 주인공의 선택에 반응하는 명확한 원인과 결과를 가진다.",
        "- 중요한 설정은 이후 작품과 권에서 정합성을 유지해야 한다.",
        "",
        "## 주요 갈등",
        "- 개인의 욕망과 세계의 오래된 질서가 충돌한다.",
        "",
        "## 승인된 초기 전개",
        approvedOutline
      ].join("\n"),
      issues: []
    };
  }

  async planSkeleton(contextState: AgentContext["state"], input: NewProjectInput): Promise<AgentResult> {
    const title = contextState.workTitle;
    return {
      text: [
        `# ${title} 스켈레톤`,
        "",
        "## 1장: 균열",
        "- 1비트: 주인공이 일상 속 이상징후를 발견한다.",
        "- 2비트: 이상징후가 개인 문제가 아니라 세계의 규칙임을 암시한다.",
        "",
        "## 2장: 선택",
        "- 1비트: 주인공은 충돌의 중심으로 들어간다.",
        "- 2비트: 첫 선택의 대가를 치르고 다음 갈등으로 나아간다.",
        "",
        `요청 메모: ${input.workRequest}`
      ].join("\n"),
      issues: []
    };
  }

  async writeBeat(context: AgentContext): Promise<AgentResult> {
    const beat = requireBeat(context);
    return {
      text: [
        `### ${beat.title}`,
        "",
        `이 장면은 ${beat.title}에 해당한다. 주인공은 현재 사건의 의미를 오해한 채 움직이지만, 행동의 결과는 세계의 숨은 규칙을 선명하게 드러낸다.`,
        "",
        "대화와 행동은 다음 장면으로 이어질 질문을 남긴다. 감정선은 과장하지 않고, 선택의 무게가 독자에게 자연스럽게 전달되도록 쌓아 간다."
      ].join("\n"),
      issues: []
    };
  }

  async editBeat(_context: AgentContext, draft: string): Promise<AgentResult> {
    return {
      text: `${draft}\n\n편집 메모를 반영해 문장의 리듬과 장면 전환을 다듬었다.`,
      issues: []
    };
  }

  async proofreadBeat(_context: AgentContext, edited: string): Promise<AgentResult> {
    const issues = edited.includes("깨진문장") ? ["깨진 문장 표식이 남아 있습니다."] : [];
    return { text: edited, issues };
  }

  async checkContinuity(context: AgentContext, text: string): Promise<AgentResult> {
    const issueText = [...(context.feedback ?? []), text].join("\n");
    if (issueText.includes("[CONFLICT]")) {
      return {
        text,
        issues: ["명시적 충돌 표식 [CONFLICT]가 발견되었습니다."],
        conflict: {
          id: `conflict-${Date.now()}`,
          scope: "continuity",
          description: "명시적 충돌 표식 [CONFLICT]가 발견되었습니다.",
          severity: "blocking",
          resolved: false
        }
      };
    }
    return { text, issues: [] };
  }

  async editJoinedBeats(_context: AgentContext, text: string): Promise<AgentResult> {
    return {
      text: `${text.trim()}\n\n연결 검수: 이전 비트와 현재 비트의 장면 흐름을 확인했다.`,
      issues: []
    };
  }

  async buildEpub(context: AgentContext, markdown: string): Promise<AgentResult> {
    return {
      text: markdown,
      issues: []
    };
  }
}

function requireBeat(context: AgentContext) {
  if (!context.currentBeat) {
    throw new Error("currentBeat is required");
  }
  return context.currentBeat;
}
