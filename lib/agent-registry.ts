export type AgentId =
  | "tech"
  | "data"
  | "security"
  | "legal"
  | "policy"
  | "finance"
  | "procurement"
  | "operations";

export type Classification = "public" | "internal" | "confidential";

export const classifications = ["public", "internal", "confidential"] as const;

export type KnowledgeChunk = {
  id: string;
  agent: AgentId;
  title: string;
  section: string;
  text: string;
  sourceType: "public" | "synthetic-internal";
  classification: Classification;
  effectiveDate: string;
  sourceUrl?: string;
  sourceSha256?: string;
  licenseReview?: string;
  tags: string[];
};

type AgentProfile = {
  name: string;
  shortName: string;
  color: string;
  responsibility: string;
  keywords: string[];
  allowedClasses: Classification[];
  ragAgents: AgentId[];
};

/** Core가 알아도 되는 라우팅 메타데이터. 원문 corpus와 분리한다. */
export const agentProfiles = {
  tech: {
    name: "기술검토 Agent",
    shortName: "기술",
    color: "#5B8CFF",
    responsibility: "디지털전략팀 기술검토 책임",
    keywords: ["AI", "LLM", "기술", "시스템", "서비스", "클라우드", "구축", "운영", "성능", "응답시간", "품질", "RAG", "모델"],
    allowedClasses: ["public", "internal"],
    ragAgents: ["tech"],
  },
  data: {
    name: "데이터거버넌스 Agent",
    shortName: "데이터",
    color: "#31B7C2",
    responsibility: "데이터 관리부서 품질·수명주기·메타데이터 검토",
    keywords: ["데이터셋", "데이터 품질", "학습데이터", "수집", "정제", "라벨링", "메타데이터", "갱신", "가명정보", "공공데이터"],
    allowedClasses: ["public", "internal"],
    ragAgents: ["data", "tech", "legal"],
  },
  security: {
    name: "보안 Agent",
    shortName: "보안",
    color: "#45D6B5",
    responsibility: "정보보호팀 보안성 검토",
    keywords: ["보안", "개인정보", "민감", "데이터", "접근", "민원", "내부", "클라우드", "반출", "권한", "기밀"],
    allowedClasses: ["public", "internal", "confidential"],
    ragAgents: ["security"],
  },
  legal: {
    name: "법무 Agent",
    shortName: "법무",
    color: "#AA88FF",
    responsibility: "법무팀 규정·계약 검토",
    keywords: ["법", "책임", "계약", "규정", "민원", "개인정보", "외주", "위탁", "조항"],
    allowedClasses: ["public", "internal"],
    ragAgents: ["legal"],
  },
  policy: {
    name: "정책·윤리 Agent",
    shortName: "정책",
    color: "#D57BEA",
    responsibility: "AI 정책담당 공공성·투명성·영향평가 검토",
    keywords: ["정책", "윤리", "공정성", "편향", "투명성", "설명가능", "영향평가", "공공성", "책임성", "인권"],
    allowedClasses: ["public", "internal"],
    ragAgents: ["policy", "legal", "tech"],
  },
  finance: {
    name: "재무 Agent",
    shortName: "재무",
    color: "#FFB25B",
    responsibility: "재무·구매팀 예산 타당성 검토",
    keywords: ["예산", "비용", "조달", "타당성", "계약", "운영비", "TCO", "구매"],
    allowedClasses: ["public", "internal"],
    ragAgents: ["finance"],
  },
  procurement: {
    name: "조달·계약 Agent",
    shortName: "조달",
    color: "#F58B55",
    responsibility: "구매·계약부서 발주·경쟁성·사업자 종속 검토",
    keywords: ["조달", "발주", "입찰", "제안요청서", "규격서", "사업자", "수의계약", "카탈로그", "디지털서비스", "계약"],
    allowedClasses: ["public", "internal"],
    ragAgents: ["procurement", "finance", "legal"],
  },
  operations: {
    name: "운영·품질 Agent",
    shortName: "운영",
    color: "#84B65A",
    responsibility: "서비스 운영부서 SLA·장애·품질·모니터링 검토",
    keywords: ["운영", "SLA", "장애", "모니터링", "응답시간", "가용성", "품질", "평가", "검수", "유지보수", "성능", "대응", "절차"],
    allowedClasses: ["public", "internal"],
    ragAgents: ["operations", "tech", "security"],
  },
} satisfies Record<AgentId, AgentProfile>;

export const agentIds = Object.keys(agentProfiles) as AgentId[];
