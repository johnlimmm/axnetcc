import type { KnowledgeChunk } from "./agent-registry";
import { isPublicQualifier as isQualifier, publicSentenceUnits } from "./public-passages.ts";

/** Separate opt-in is required because Edge processes do not carry DEMO_PROFILE. */
export function groundedAnswersEnabled() { return process.env.DEMO_GROUNDED_ANSWERS === "true"; }
export function groundedGenerationEnabled() {
  const rendering = process.env.DEMO_GROUNDED_RENDERING;
  if (rendering && rendering !== "model-guided-extractive" && rendering !== "source-grounded-generation") throw new Error("Invalid DEMO_GROUNDED_RENDERING");
  return rendering === "source-grounded-generation";
}

export function groundedTopK() {
  const value = Number(process.env.DEMO_GROUNDED_TOP_K ?? 3);
  if (!Number.isInteger(value) || value < 3 || value > 6) throw new Error("DEMO_GROUNDED_TOP_K must be an integer from 3 to 6");
  return value;
}

export type GroundedSpan = { id: string; source: KnowledgeChunk; text: string; qualifier?: boolean };
export type GroundedComponent = { id: string; question: string };
const reasons = ["not-in-sources", "organization-information", "scope-uncertain"] as const;
type UnknownReason = typeof reasons[number];

export function groundedInput(query: string, evidence: KnowledgeChunk[]) {
  // The query is untrusted data, not a source of organizational facts.
  // Keep conjunctions/comparisons together: splitting "A 및 B 비교" loses the operation.
  const parts = query.split(/\n+|[?？;；]+/u).map(x => x.trim()).filter(Boolean).slice(0, 6);
  const components: GroundedComponent[] = (parts.length ? parts : [query]).map((question, i) => ({ id: `Q${i + 1}`, question }));
  const spans: GroundedSpan[] = [];
  for (const source of evidence.filter(x => x.classification === "public" && x.sourceType === "public").slice(0, 8)) {
    // Completed sentences form compact windows, never PDF line fragments. Explicit
    // caveats remain inseparable from the preceding rule, even above the soft budget.
    // This lexical guard is not a claim of complete semantic qualifier detection.
    const units = publicSentenceUnits(source.text);
    let window = "";
    const windows: string[] = [];
    for (const unit of units) {
      const qualifier = isQualifier(unit);
      if (unit.trim() && !qualifier && window.length >= 160 && window.length + unit.length > 320) { windows.push(window.trim()); window = ""; }
      window += unit;
    }
    if (window.trim()) windows.push(window.trim());
    for (const text of windows) spans.push({ id: `S${spans.length + 1}`, source, text,
      qualifier: publicSentenceUnits(text).some(isQualifier) });
  }
  return { components, spans };
}

export function groundedSchema(components: GroundedComponent[], spans: GroundedSpan[]) {
  return { type: "object", additionalProperties: false, required: ["answers"], properties: {
    answers: { type: "array", minItems: components.length, maxItems: components.length, items: {
      type: "object", additionalProperties: false, required: ["component", "spans", "unknown"], properties: {
        component: { type: "string", enum: components.map(x => x.id) },
        spans: { type: "array", maxItems: 4, uniqueItems: true, items: { type: "string", enum: spans.map(x => x.id) } },
        unknown: { type: "array", maxItems: 3, uniqueItems: true, items: { type: "string", enum: reasons } },
      },
    } },
  } };
}

const unknownText: Record<UnknownReason, string> = {
  "not-in-sources": "공개 근거에서 해당 부분을 확인하지 못했습니다. 대상 제도·문서명, 기준 시점과 추가 원문이 필요합니다.",
  "organization-information": "실제 조직·서비스의 충족 여부는 판단 불가입니다. 설계·설정, 데이터 처리 흐름, 권한 정책과 운영·점검 증적이 필요합니다.",
  "scope-uncertain": "해당 문서의 적용 범위와 질문 대상의 일치 여부를 확인해야 합니다. 조직 유형, 적용 법령·계약 및 대상 업무를 알려 주세요.",
};

/** ID/shape validation proves only exact attribution, NOT relevance or entailment. */
export function renderGroundedAnswer(raw: string, components: GroundedComponent[], spans: GroundedSpan[]) {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).join() !== "answers") throw new Error("Invalid grounded selection");
  const answers = (parsed as { answers: unknown }).answers;
  if (!Array.isArray(answers) || answers.length !== components.length) throw new Error("Missing requested components");
  const seen = new Set<string>();
  const rendered: string[] = ["모델이 선택한 공개 근거 발췌 (model-guided extractive)"];
  let budget = 2600;
  let omitted = false;
  const allMissing = new Set<UnknownReason>();
  for (const component of components) {
    const a = answers.find(x => x && x.component === component.id);
    if (!a || Object.keys(a).sort().join() !== "component,spans,unknown" || seen.has(a.component) ||
      !Array.isArray(a.spans) || a.spans.length > 4 || new Set(a.spans).size !== a.spans.length ||
      !a.spans.every((id: unknown) => typeof id === "string" && spans.some(s => s.id === id)) ||
      !Array.isArray(a.unknown) || a.unknown.length > 3 || !a.unknown.every((r: unknown) => reasons.includes(r as UnknownReason))) throw new Error("Invalid grounded selection");
    seen.add(a.component);
    rendered.push(`\n요청 ${component.id}: ${component.question.slice(0, 100)}`);
    const selected = spans.filter(span => a.spans.includes(span.id));
    for (const source of new Set(selected.map(span => span.source))) {
      // A selected source cannot lose its known caveat just because the model
      // selected another window. Render the group atomically within the budget.
      const group = spans.filter(span => span.source === source && (a.spans.includes(span.id) || span.qualifier));
      const lines = group.map(span => `- 문서 발췌 — ${span.source.title.slice(0, 120)} / ${span.source.section.slice(0, 100)} (${span.source.effectiveDate || "발행일 미상"}):\n“${span.text}” [${span.source.id}]`);
      const size = lines.reduce((sum, line) => sum + line.length, 0);
      if (size > budget) { omitted = true; continue; }
      budget -= size;
      rendered.push(...lines);
    }
    const missing = new Set<UnknownReason>(a.unknown);
    if (!a.spans.length) missing.add("not-in-sources");
    for (const reason of missing) allMissing.add(reason);
  }
  if (omitted) rendered.push("표시 예산으로 선택된 근거 일부를 생략했습니다. 모든 요청 부분을 답한 것으로 볼 수 없습니다. 세부 질문으로 나누어 확인해 주세요.");
  for (const reason of allMissing) rendered.push(`확인 불가 / 필요한 정보: ${unknownText[reason]}`);
  rendered.push("\n적용 범위: 인용 문서의 대상·조건에 한정됩니다. 공공부문 지침을 모든 민간기업의 의무로 일반화하지 않습니다. 문서 요건만으로 실제 서비스의 충족 여부를 판단하지 않습니다.");
  return rendered.join("\n");
}

export function groundedUnavailable() {
  return "근거 기반 답변을 확정하지 못했습니다. 확인 불가: 공개 근거 또는 유효한 모델 선택 결과가 부족합니다. 문서명·기준 시점과 세부 질문을 알려 주세요. 실제 서비스 충족 여부에는 설계·설정 및 운영 증적이 필요합니다.";
}

const guidance = {
  "architecture-permissions": "권한 있는 담당자가 내부에서 시스템 구성·권한 설정·통제 적용 증적을 확인해야 합니다.",
  "data-provenance-purpose": "권한 있는 담당자가 내부에서 데이터 출처·수집 목적·처리 근거와 이용 범위를 검토해야 합니다.",
  "aggregate-usage-contracts": "권한 있는 담당자가 집계 사용량·산정 기간·적용 단가와 민감정보를 제거한 계약 조건을 내부에서 확인해야 합니다.",
  "authorized-decision-records": "권한 있는 담당자가 공식적으로 열람 가능한 의사결정 기록과 확정 여부를 내부 절차로 확인해야 합니다.",
  "metrics-time": "측정 지표의 정의·대상 기간·측정 환경과 승인된 집계 결과를 확인해야 합니다.",
  "authorized-access-recovery": "소속 조직의 승인된 계정·접근 복구 절차를 권한 있는 담당자와 진행해야 합니다.",
  "public-sources-applicability": "공개 원문·발행 시점·대상 조직과 적용 조건을 확인해야 합니다. 추가 확인에는 공개 자료만 사용합니다.",
} as const;
type GuidanceCategory = keyof typeof guidance;

export function generatedGroundedSchema(components: GroundedComponent[], spans: GroundedSpan[]) {
  return { type:"object", additionalProperties:false, required:["answers"], properties:{ answers:{ type:"array", minItems:components.length, maxItems:components.length, items:{
    type:"object", additionalProperties:false, required:["component","claims","unknown"], properties:{
      component:{type:"string",enum:components.map(x=>x.id)},
      claims:{type:"array",maxItems:8,items:{type:"object",additionalProperties:false,required:["text","spans"],properties:{
        text:{type:"string",minLength:1,maxLength:300},
        spans:{type:"array",minItems:1,maxItems:4,uniqueItems:true,items:{type:"string",enum:spans.map(x=>x.id)}},
      }}},
      unknown:{type:"array",maxItems:3,items:{type:"object",additionalProperties:false,required:["anchor","reason","category"],properties:{
        anchor:{type:"string",minLength:1,maxLength:160},
        reason:{type:"string",enum:reasons},
        category:{type:"string",enum:Object.keys(guidance)},
      }}},
    },
  }}}};
}

/** Validate structure and citation membership only. Generated claims still require
 * independent semantic evaluation; source IDs cannot establish entailment. */
export function renderGeneratedGroundedAnswer(raw:string, components:GroundedComponent[], spans:GroundedSpan[]) {
  const parsed = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.keys(parsed).join() !== "answers" || !Array.isArray(parsed.answers) || parsed.answers.length !== components.length) throw new Error("Invalid generated answer");
  const output = ["공개 근거를 바탕으로 생성한 답변 (source-grounded generation · 의미 검증 미완료)"];
  let budget = 2500;
  for (const component of components) {
    const matches = parsed.answers.filter((a: {component?:unknown}|null) => a?.component === component.id);
    const answer = matches[0];
    const safeText = (value:unknown,max:number) => typeof value === "string" && value.length <= max && !/[\[\]\r\n<>\u0000-\u001f]/u.test(value);
    if (matches.length !== 1 || Object.keys(answer).sort().join() !== "claims,component,unknown" || !Array.isArray(answer.claims) || answer.claims.length > 8 || !Array.isArray(answer.unknown) || answer.unknown.length > 3) throw new Error("Invalid generated component");
    for (const item of answer.unknown) {
      if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join() !== "anchor,category,reason" || !safeText(item.anchor,160) || !item.anchor.trim() || !component.question.includes(item.anchor) || !reasons.includes(item.reason) || (typeof item.category !== "string" || !Object.hasOwn(guidance,item.category))) throw new Error("Invalid typed unknown");
    }
    if (!answer.claims.length && !answer.unknown.length) throw new Error("Empty answer without typed unknown");
    output.push(`\n요청 ${component.id}: ${component.question.slice(0,100)}`);
    for (const claim of answer.claims) {
      if (!claim || Object.keys(claim).sort().join() !== "spans,text" || typeof claim.text !== "string" || !claim.text.trim() || claim.text.length > 300 || /[\[\]\r\n<>\u0000-\u001f]/u.test(claim.text) || !Array.isArray(claim.spans) || !claim.spans.length || claim.spans.length > 4 || new Set(claim.spans).size !== claim.spans.length || !claim.spans.every((id:unknown)=>typeof id === "string" && spans.some(s=>s.id===id))) throw new Error("Invalid generated claim");
      const sources = [...new Set((claim.spans as string[]).map(id=>spans.find(s=>s.id===id)!.source))];
      const line = `- ${claim.text.trim()} ${sources.map(source=>`[${source.id}]`).join(" ")}`;
      if (line.length > budget) throw new Error("Generated answer exceeds display budget; no partial claim set is rendered");
      budget -= line.length;
      output.push(line);
    }
    for (const item of answer.unknown) {
      output.push(`확인 불가 요청 부분 (미검증 사용자 요청 인용): “${item.anchor}”`);
      output.push(`확인 불가 / 필요한 정보: ${unknownText[item.reason as UnknownReason]}`);
      output.push(`권한 있는 내부 확인 안내: ${guidance[item.category as GuidanceCategory]}`);
    }
  }
  output.push("비공개 문서 수집 서비스가 아닙니다. 비밀번호·토큰·개인키·원시 비공개 로그를 제출하지 마세요.");
  output.push("\n판단 범위: 공개 문서의 요건·사례만 설명합니다. 실제 조직의 준수·합법성·비용·내부 결정은 판단 불가이며, 해당 조직의 설계·계약·사용량·운영 증적이 필요합니다. 인용 문서의 대상·조건을 다른 조직에 일반화하지 않습니다.");
  const text = output.join("\n");
  if (text.length > 3900) throw new Error("Generated answer exceeds display budget");
  return text;
}
