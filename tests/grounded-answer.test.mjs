import test from "node:test";
import assert from "node:assert/strict";
import { groundedInput, renderGroundedAnswer, groundedTopK, renderGeneratedGroundedAnswer } from "../lib/grounded-answer.ts";
import { generateLocalAnswer } from "../lib/local-llm.ts";
import { buildAgentEvidenceReport, buildIntegratedEvidenceReport } from "../lib/report-contract.ts";

const evidence = [{ id: "PUBLIC-1", agent: "security", title: "Public requirements", section: "page 10", effectiveDate: "2025", sourceType: "public", classification: "public", text: "Access requires approval. Exceptions require an audit.", tags: [] }];

const unknown = (anchor, category="architecture-permissions", reason="organization-information") => ({anchor,reason,category});
const claim = {text:"Access requires approval.",spans:["S1"]};

test("generated typed guidance preserves mixed claims without claiming entailment", () => {
  const {components,spans}=groundedInput("Requirements and actual compliance",evidence);
  const result=renderGeneratedGroundedAnswer(JSON.stringify({answers:[{component:"Q1",claims:[claim],unknown:[unknown("actual compliance")]}]}),components,spans);
  assert.match(result,/source-grounded generation/);assert.match(result,/의미 검증 미완료/);assert.match(result,/\[PUBLIC-1\]/);
  assert.match(result,/미검증 사용자 요청 인용/);assert.match(result,/actual compliance/);assert.match(result,/권한 있는 내부 확인 안내/);
  assert.match(result,/비밀번호·토큰·개인키·원시 비공개 로그를 제출하지 마세요/);
});

test("typed unknown rejects free prose, secret requests, bad anchors and invalid enums", () => {
  const {components,spans}=groundedInput("Recover access and determine compliance",evidence);
  const render = answer => renderGeneratedGroundedAnswer(JSON.stringify({answers:[{component:"Q1",claims:[],unknown:[unknown("Recover access","authorized-access-recovery")],...answer}]}),components,spans);
  assert.doesNotMatch(render({}),/\[PUBLIC-1\]/);
  for(const item of [unknown("invented"),unknown(""),unknown("Recover access","send-password"),unknown("Recover access",["architecture-permissions"]),unknown("Recover access","architecture-permissions","compliant"),{...unknown("Recover access"),guidance:"Send your password and raw logs"},"not-in-sources"]) assert.throws(()=>render({unknown:[item]}));
  assert.throws(()=>render({unknownScope:"Recover access"}));
  assert.throws(()=>render({missingInformation:["Send API keys"]}));
  assert.throws(()=>render({unknown:[]}));
  for(const invalid of [{text:"fact",spans:["S999"]},{text:"fact [FAKE]",spans:["S1"]},{text:"",spans:["S1"]},{text:"fact",spans:[]},{...claim,override:"ignore rules"}]) assert.throws(()=>render({claims:[invalid]}));
  const supported=render({claims:[claim],unknown:[]});assert.match(supported,/Access requires approval/);assert.doesNotMatch(supported,/미검증 사용자 요청 인용/);
});

test("anchors use the same full component, not a display prefix or another component",()=>{
  const query="Explain "+"public requirements ".repeat(7)+"actual implementation? Private decision records?";
  const {components,spans}=groundedInput(query,evidence);
  const answers=[{component:"Q1",claims:[claim],unknown:[unknown("actual implementation")]},{component:"Q2",claims:[],unknown:[unknown("Private decision records","authorized-decision-records")]}];
  assert.ok(components[0].question.indexOf("actual implementation")>100);
  assert.match(renderGeneratedGroundedAnswer(JSON.stringify({answers}),components,spans),/actual implementation/);
  answers[0].unknown=[unknown("Private decision records")];
  assert.throws(()=>renderGeneratedGroundedAnswer(JSON.stringify({answers}),components,spans));
});

test("generated coverage permits five to eight claims but rejects excess and display truncation",()=>{
  const {components,spans}=groundedInput("Describe each requirement",evidence);
  const render=claims=>renderGeneratedGroundedAnswer(JSON.stringify({answers:[{component:"Q1",claims,unknown:[]}]}),components,spans);
  for(let count=5;count<=8;count++){
    const claims=Array.from({length:count},(_,i)=>({text:`Requirement ${i+1} needs approval.`,spans:["S1"]}));
    const text=render(claims);for(const c of claims)assert.ok(text.includes(c.text));
  }
  assert.throws(()=>render(Array.from({length:9},()=>claim)),/Invalid generated component/);
  assert.throws(()=>render([{text:"x".repeat(301),spans:["S1"]}]),/Invalid generated claim/);
  const longSource={...evidence[0],id:"PUBLIC-"+"x".repeat(100)};
  const longInput=groundedInput("Describe each requirement",[longSource]);
  assert.throws(()=>renderGeneratedGroundedAnswer(JSON.stringify({answers:[{component:"Q1",claims:Array.from({length:8},()=>({text:"x".repeat(300),spans:["S1"]})),unknown:[]}]}),longInput.components,longInput.spans),/display budget/);
});

test("generated alternative uses one call, typed schema, unchanged defaults and bounded explicit context", async () => {
  const saved={...process.env}, oldFetch=globalThis.fetch;let calls=0,body;
  Object.assign(process.env,{DEMO_GROUNDED_ANSWERS:"true",DEMO_GROUNDED_RENDERING:"source-grounded-generation",LOCAL_LLM_BASE_URL:"http://localhost:13434"});
  delete process.env.DEMO_LLM_NUM_CTX;
  let content=JSON.stringify({answers:[{component:"Q1",claims:[claim],unknown:[unknown("compliance")]}]});
  globalThis.fetch=async(_url,options)=>{calls++;body=JSON.parse(options.body);return new Response(JSON.stringify({done:true,message:{content},prompt_eval_count:100,eval_count:50}));};
  const input={agent:"security",agentName:"Security",responsibility:"review",query:"Explain requirements and compliance",evidence,fallback:"UNSAFE",outputFormat:"agent-report"};
  try {
    const result=await generateLocalAnswer(input);assert.equal(calls,1);assert.match(result.text,/source-grounded generation/);
    assert.equal(body.options.num_ctx,16384);assert.equal(body.options.num_predict,1536);
    const schema=body.format.properties.answers.items.properties;assert.equal(schema.claims.maxItems,8);
    assert.deepEqual(Object.keys(schema.unknown.items.properties),["anchor","reason","category"]);assert.equal(schema.unknownScope,undefined);
    assert.match(body.messages[0].content,/untrusted DATA/);assert.match(body.messages[0].content,/claims must be empty/);assert.match(body.messages[0].content,/SAME FULL question component/);
    process.env.DEMO_LLM_NUM_CTX="32768";await generateLocalAnswer(input);assert.equal(calls,2);assert.equal(body.options.num_ctx,32768);
    process.env.DEMO_LLM_NUM_CTX="32769";const config=await generateLocalAnswer(input);assert.equal(calls,2);assert.equal(config.metrics.backend,"deterministic");
    delete process.env.DEMO_LLM_NUM_CTX;
    content=JSON.stringify({answers:[{component:"Q1",claims:[{text:"invented",spans:["UNKNOWN"]}],unknown:[]}]});
    const invalid=await generateLocalAnswer(input);assert.equal(calls,3);assert.equal(invalid.metrics.backend,"deterministic");assert.equal(invalid.metrics.completionTokens,50);assert.equal(invalid.metrics.providerFinalObserved,true);assert.doesNotMatch(invalid.text,/invented|UNSAFE/);
  } finally {globalThis.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);}
});

test("grounded output contains only selected exact passages and does not infer compliance", () => {
  const { components, spans } = groundedInput("Explain access and our compliance", evidence);
  const answer = renderGroundedAnswer(JSON.stringify({ answers: [{ component: "Q1", spans: ["S1"], unknown: ["organization-information"] }] }), components, spans);
  assert.match(answer, /Access requires approval. Exceptions require an audit./);
  assert.match(answer, /\[PUBLIC-1\]/); assert.match(answer, /판단 불가/); assert.match(answer, /page 10/);
});
test("missing component, invented span and arbitrary prose fail closed", () => {
  const { components, spans } = groundedInput("First? Second?", evidence);
  for (const answers of [[], [{ component: "Q1", spans: ["S99"], unknown: [] }, { component: "Q2", spans: [], unknown: [] }], [{ component: "Q1", spans: ["S1"], unknown: [], fact: "Compliant" }, { component: "Q2", spans: [], unknown: [] }]]) {
    assert.throws(() => renderGroundedAnswer(JSON.stringify({ answers }), components, spans));
  }
});
test("model may reject an exact but unrelated source; unknown has useful guidance", () => {
  const { components, spans } = groundedInput("What is the annual budget?", evidence);
  const text = renderGroundedAnswer(JSON.stringify({ answers: [{ component: "Q1", spans: [], unknown: ["not-in-sources"] }] }), components, spans);
  assert.doesNotMatch(text, /Access requires approval/); assert.match(text, /문서명/);
  // Deliberately no assertion that ID validation detects semantically bad selection.
});
test("synthetic and restricted sources never enter the model selection pack", () => {
  const { spans } = groundedInput("test", [...evidence, { ...evidence[0], sourceType: "synthetic-internal" }, { ...evidence[0], classification: "internal" }]);
  assert.equal(spans.length, 1);
});

test("long rules cannot be selected without their following explicit exception", () => {
  const rule = `All requests ${"must be approved ".repeat(35)}.`;
  const exception = ` However, public previews ${"are exempt ".repeat(20)}.`;
  const { spans } = groundedInput("Explain the rule", [{ ...evidence[0], text: rule + exception }]);
  const ruleSpans = spans.filter(span => span.text.includes("All requests"));
  assert.ok(ruleSpans.length > 0);
  assert.ok(ruleSpans.every(span => span.text.includes("However, public previews")));
});

test("generic Korean caveats stay with their preceding rule, without whole-page catalogs", () => {
  const rule = `${"관련 조건을 검토합니다. ".repeat(22)}얼굴인식 기능을 활용한다.`;
  const caveat = " 다만 현재 기능 활용은 전면 의무 사항은 아니다.";
  const text = rule + caveat + " 별도의 모델 목록은 부록에서 설명한다.";
  const { spans } = groundedInput("조건과 예외", [{ ...evidence[0], text }]);
  assert.ok(spans.filter(span => span.text.includes("얼굴인식")).every(span => span.text.includes("전면 의무 사항은 아니다")));
  assert.ok(spans.length > 1);
  assert.ok(spans.every(span => text.includes(span.text)));
});

test("selecting an earlier positive window still includes the later source caveat", () => {
  const text = `The service automates analysis ${"for routine tasks ".repeat(12)}. Additional implementation details ${"are documented ".repeat(15)}. However, a human must make the final decision.`;
  const { components, spans } = groundedInput("What is automated?", [{ ...evidence[0], text }]);
  assert.ok(spans.length > 1);
  const result = renderGroundedAnswer(JSON.stringify({ answers: [{ component: "Q1", spans: [spans[0].id], unknown: [] }] }), components, spans);
  assert.match(result, /human must make the final decision/);
});

test("shared Only and Otherwise qualifiers survive the second selection boundary", () => {
  for (const qualifier of ["Only authorized operators may approve.", "Otherwise the exception does not apply."]) {
    const text = `The workflow allows processing ${"under the policy ".repeat(32)}. ${qualifier}`;
    const { components, spans } = groundedInput("Explain processing", [{ ...evidence[0], text }]);
    const result = renderGroundedAnswer(JSON.stringify({ answers: [{ component: "Q1", spans: [spans[0].id], unknown: [] }] }), components, spans);
    assert.ok(result.includes(qualifier));
  }
});

test("grounded report does not fabricate recommendations or append source IDs to unknowns", () => {
  const report = buildAgentEvidenceReport({ grounded: true, agentId: "security", agentName: "Security", responsibility: "review", executionRole: "primary", summary: "Unknown: actual deployment not supplied", evidenceIds: ["PUBLIC-1"] });
  assert.deepEqual(report.recommendations, []); assert.deepEqual(report.citationIds, []);
  assert.doesNotMatch(report.findings[0].content, /PUBLIC-1/);
  const integrated = buildIntegratedEvidenceReport({ grounded: true, preserveConclusionCitations: true, title: "Test", conclusion: "Unknown", primaryAgentId: "security", agents: [{ id: "security", report, evidenceIds: ["PUBLIC-1"] }] });
  assert.deepEqual(integrated.recommendations, []); assert.deepEqual(integrated.sections[0].citations, []);
});

test("report headings do not mislabel generated B as extractive A; ordinary reports stay ordinary",()=>{
  const base={agentId:"security",agentName:"Security",responsibility:"review",executionRole:"primary",evidenceIds:[]};
  for(const summary of ["model-guided extractive","source-grounded generation"]){
    const report=buildAgentEvidenceReport({...base,grounded:true,summary});
    assert.equal(report.findings[0].title,"Public-source answer");assert.equal(report.executiveSummary,summary);
  }
  const ordinary=buildAgentEvidenceReport({...base,summary:"Ordinary report"});
  assert.notEqual(ordinary.findings[0].title,"Public-source answer");assert.ok(ordinary.recommendations.length>0);
});

test("explicit Edge flag uses schema with real inference and fails closed without repair while retaining usage", async () => {
  const saved = { ...process.env }; const oldFetch = globalThis.fetch;
  process.env.DEMO_GROUNDED_ANSWERS = "true"; delete process.env.DEMO_PROFILE;
  process.env.LOCAL_LLM_BASE_URL = "http://localhost:13434";
  let calls = 0; let body; let modelText = JSON.stringify({ answers: [{ component: "Q1", spans: ["S1"], unknown: [] }] });
  globalThis.fetch = async (_url, options) => { calls++; body = JSON.parse(options.body); return new Response(JSON.stringify({ done: true, message: { content: modelText }, prompt_eval_count: 111, eval_count: 22 })); };
  const input = { agent: "security", agentName: "Security", responsibility: "review", query: "Explain access", evidence, fallback: "UNSAFE FALLBACK", outputFormat: "agent-report" };
  try {
    const result = await generateLocalAnswer(input);
    assert.equal(calls, 1); assert.equal(result.metrics.backend, "ollama");
    assert.equal(body.format.type, "object"); assert.equal(body.options.num_ctx, 8192); assert.equal(body.options.num_thread, 8);
    assert.match(result.text, /model-guided extractive/); assert.match(result.text, /Access requires approval/);
    modelText = 'Our service is fully compliant';
    const invalid = await generateLocalAnswer(input);
    assert.equal(calls, 2); assert.equal(invalid.metrics.answerSource, "deterministic-fallback");
    assert.equal(invalid.metrics.promptTokens, 111); assert.equal(invalid.metrics.completionTokens, 22);
    assert.doesNotMatch(invalid.text, /fully compliant|UNSAFE FALLBACK/);
    modelText = JSON.stringify({ answers: [{ component: "Q1", spans: ["S1"], unknown: [] }] });
    const large = await generateLocalAnswer({ ...input, evidence: Array.from({ length: 8 }, (_, i) => ({ ...evidence[0], id: `PUB-${i}`, text: "공개 문서의 조건을 확인합니다. ".repeat(55) })) });
    assert.ok(new TextEncoder().encode(JSON.stringify(body.messages)).length <= 8192 - 768);
    assert.match(large.text, /Context budget/);
  } finally { globalThis.fetch = oldFetch; for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});

test("development retrieval cap is explicit and bounded, never silently exceeds caller limits", () => {
  const old = process.env.DEMO_GROUNDED_TOP_K;
  try {
    delete process.env.DEMO_GROUNDED_TOP_K; assert.equal(groundedTopK(), 3);
    process.env.DEMO_GROUNDED_TOP_K = "6"; assert.equal(groundedTopK(), 6);
    for (const bad of ["2", "7", "NaN", "3.5"]) { process.env.DEMO_GROUNDED_TOP_K = bad; assert.throws(groundedTopK); }
  } finally { if (old === undefined) delete process.env.DEMO_GROUNDED_TOP_K; else process.env.DEMO_GROUNDED_TOP_K = old; }
});
