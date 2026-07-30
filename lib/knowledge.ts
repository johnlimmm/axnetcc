export type AgentId = "tech" | "security" | "legal" | "finance";

export type KnowledgeChunk = {
  id: string;
  agent: AgentId;
  title: string;
  section: string;
  text: string;
  sourceType: "public" | "synthetic-internal";
  classification: "public" | "internal" | "confidential";
  effectiveDate: string;
  sourceUrl?: string;
  tags: string[];
};

export const agentProfiles = {
  tech: {
    name: "기술검토 Agent",
    shortName: "기술",
    color: "#5B8CFF",
    responsibility: "디지털전략팀 기술검토 책임",
    keywords: ["AI", "LLM", "기술", "시스템", "서비스", "클라우드", "구축", "운영", "성능", "RAG", "모델"],
    allowedClasses: ["public", "internal"],
  },
  security: {
    name: "보안 Agent",
    shortName: "보안",
    color: "#45D6B5",
    responsibility: "정보보호팀 보안성 검토",
    keywords: ["보안", "개인정보", "민감", "데이터", "접근", "민원", "내부", "클라우드", "반출", "권한"],
    allowedClasses: ["public", "internal", "confidential"],
  },
  legal: {
    name: "법무 Agent",
    shortName: "법무",
    color: "#AA88FF",
    responsibility: "법무팀 규정·계약 검토",
    keywords: ["법", "책임", "계약", "규정", "민원", "개인정보", "외주", "위탁", "조항"],
    allowedClasses: ["public", "internal"],
  },
  finance: {
    name: "재무 Agent",
    shortName: "재무",
    color: "#FFB25B",
    responsibility: "재무·구매팀 예산 타당성 검토",
    keywords: ["예산", "비용", "조달", "타당성", "계약", "운영비", "TCO", "구매"],
    allowedClasses: ["public", "internal"],
  },
} satisfies Record<AgentId, {
  name: string;
  shortName: string;
  color: string;
  responsibility: string;
  keywords: string[];
  allowedClasses: string[];
}>;

export const knowledge: KnowledgeChunk[] = [
  {
    id: "TECH-ARCH-01",
    agent: "tech",
    title: "AI 서비스 표준 아키텍처",
    section: "2.3 분리 원칙",
    text: "업무 데이터 저장소, 검색 계층, 추론 계층, 출력 검증 계층을 분리한다. 원문 저장소는 조직 경계 안에 두고 검색 결과의 식별자와 최소 문맥만 추론 계층에 전달한다.",
    sourceType: "synthetic-internal",
    classification: "internal",
    effectiveDate: "2026-07-01",
    tags: ["아키텍처", "RAG", "분리", "원문"],
  },
  {
    id: "TECH-OPS-02",
    agent: "tech",
    title: "AI 시범서비스 운영 기준",
    section: "4.1 단계적 도입",
    text: "PoC 단계에서는 필수 항목 포함률, 근거 연결률, 응답시간 P95, 실패율을 측정한다. 운영 전환은 품질과 안전 기준을 연속 3회 충족한 경우에만 검토한다.",
    sourceType: "synthetic-internal",
    classification: "internal",
    effectiveDate: "2026-07-01",
    tags: ["PoC", "SLA", "성능", "평가"],
  },
  {
    id: "SEC-DATA-01",
    agent: "security",
    title: "생성형 AI 데이터 보호 기준",
    section: "3.2 최소 전송",
    text: "개인정보와 내부정보는 목적 달성에 필요한 최소 항목만 처리한다. 주민등록번호, 연락처, 계정, 내부 IP 등 직접 식별자와 운영 비밀은 추론 요청 전에 제거한다.",
    sourceType: "synthetic-internal",
    classification: "confidential",
    effectiveDate: "2026-07-01",
    tags: ["최소처리", "마스킹", "개인정보", "민감정보"],
  },
  {
    id: "SEC-ACCESS-02",
    agent: "security",
    title: "AI Agent 접근통제 정책",
    section: "2.1 권한",
    text: "Agent는 역할별 허용 문서등급 안에서만 검색해야 한다. 모든 검색과 반환에는 요청자, Agent, 문서 식별자, 정책 결정, 반환 필드와 시각을 감사 로그로 남긴다.",
    sourceType: "synthetic-internal",
    classification: "internal",
    effectiveDate: "2026-07-01",
    tags: ["RBAC", "감사로그", "권한", "문서등급"],
  },
  {
    id: "LEGAL-PRIV-01",
    agent: "legal",
    title: "개인정보 보호법",
    section: "제3조 개인정보 보호 원칙",
    text: "개인정보처리자는 처리 목적에 필요한 범위에서 최소한의 개인정보만을 적법하고 정당하게 수집하여야 하며 그 목적 외의 용도로 활용해서는 안 된다.",
    sourceType: "public",
    classification: "public",
    effectiveDate: "2025-10-02",
    sourceUrl: "https://www.law.go.kr/법령/개인정보보호법",
    tags: ["개인정보", "최소수집", "목적제한", "법령"],
  },
  {
    id: "LEGAL-CONT-02",
    agent: "legal",
    title: "AI 서비스 위탁계약 검토 체크리스트",
    section: "5. 데이터 처리",
    text: "계약에는 데이터 이용 목적, 보관기간, 재위탁 제한, 학습 사용 금지 여부, 침해사고 통지, 종료 시 삭제, 산출물 책임과 검수 기준을 명시한다.",
    sourceType: "synthetic-internal",
    classification: "internal",
    effectiveDate: "2026-07-01",
    tags: ["계약", "위탁", "재위탁", "책임"],
  },
  {
    id: "FIN-TCO-01",
    agent: "finance",
    title: "AI 정보화사업 TCO 산정 기준",
    section: "2. 총소유비용",
    text: "총소유비용에는 초기 구축비뿐 아니라 모델 사용료, 저장·네트워크 비용, 보안 검증, 모니터링, 운영 인력, 재학습과 데이터 갱신 비용을 포함한다.",
    sourceType: "synthetic-internal",
    classification: "internal",
    effectiveDate: "2026-07-01",
    tags: ["TCO", "예산", "운영비", "모델사용료"],
  },
  {
    id: "FIN-PROC-02",
    agent: "finance",
    title: "디지털서비스 조달 사전검토서",
    section: "3. 경쟁성",
    text: "PoC와 본사업을 분리하고 특정 모델 또는 사업자 종속성을 검토한다. 성능과 보안 기준을 규격서에 측정 가능한 형태로 작성하고 사용량 증가 시 비용 상한을 설정한다.",
    sourceType: "synthetic-internal",
    classification: "internal",
    effectiveDate: "2026-07-01",
    tags: ["조달", "PoC", "종속성", "비용상한"],
  },
];
