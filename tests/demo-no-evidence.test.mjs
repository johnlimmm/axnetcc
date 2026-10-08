import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const { orchestrate } = await import("../lib/orchestrator.ts");
const { getDistributedRun, recordInferenceStage } = await import("../lib/distributed-metrics.ts");
const { projectDistributedTelemetry } = await import("../lib/distributed-telemetry.ts");
const { residualComputeRisk } = await import("../scripts/benchmark-distributed-demo.mjs");
const { summarizeCompletion } = await import("../scripts/evaluate-grounded-completion.mjs");
const { projectEdgeAgentResponseForCore } = await import("../lib/edge-core-contract.ts");
const { RunRegistry } = await import("../lib/run-registry.ts");

async function fixture(profile, run, restrictedSuccess = false, publicUnknown = false) {
  const saved = { ...process.env }; const fetch = globalThis.fetch;
  Object.assign(process.env, { NODE_ENV: "test", DEMO_PROFILE: profile, EDGE_AGENT_MODE: "remote",
    LOCAL_LLM_BASE_URL: "http://localhost:13434", EDGE_EXPECTED_CORPUS_VERSION: "public-v1", EDGE_EXPECTED_MODEL_VERSION: "model-v1" });
  for (const agent of ["tech", "data", "security", "legal", "policy", "finance", "procurement", "operations"]) {
    const prefix = `EDGE_AGENT_${agent.toUpperCase()}`;
    for (const key of Object.keys(process.env)) if (key.startsWith(`${prefix}_BACKUP`)) delete process.env[key];
    Object.assign(process.env, { [`${prefix}_BASE_URL`]: `https://primary.test/${agent}`, [`${prefix}_TOKEN`]: "primary-token",
      [`${prefix}_NODE_ID`]: "primary", [`${prefix}_REPLICA_ID`]: "primary-replica" });
  }
  let providerCalls = 0; let edgeCalls = 0; const requests = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("primary.test")) {
      edgeCalls++;
      const request = JSON.parse(options.body);
      requests.push(request.minimalQuery);
      if (restrictedSuccess || publicUnknown) {
        const response = projectEdgeAgentResponseForCore({ version: "1", requestId: request.requestId, agentId: request.agentId, status: "completed",
          answer: publicUnknown ? { text: "Unknown: no selected supporting span", classification: "public", citations: [] } : { text: "Restricted source summary [INT-1]", classification: "internal", citations: ["INT-1"] },
          evidence: publicUnknown ? [{ referenceId: "PUB-UNSELECTED", classification: "public", disclosure: "excerpt", title: "Unrelated public source", section: "page:1", excerpt: "An unrelated source fact.", retrievalScore: 1 }] : [{ referenceId: "INT-1", classification: "internal", disclosure: "reference-only", title: "Restricted", section: "Internal", retrievalScore: 1 }],
          policy: { decisionId: "POL-TEST", outcome: "allow", effectiveClasses: ["public", "internal"], highestEvidenceClassification: publicUnknown ? "public" : "internal", redactionCount: 0, blockedCount: 0 },
          metrics: { backend: "ollama", answerSource: "local-llm", model: "test-model", evidenceCount: 1, sourceBytesProcessed: 100, egressBytes: 0, latencyMs: 2, ttftMs: 1, tpotMs: 1, promptTokens: 31, completionTokens: 4, corpusChunks: 1 },
          audit: { eventId: "AUD-TEST", recordedAt: "2026-09-23T00:00:00.000Z", policyVersion: "edge-rag-v1" } }, "http");
        return new Response(JSON.stringify(response), { headers: { "x-edge-node-id": "primary", "x-edge-replica-id": "primary-replica", "x-edge-corpus-version": "public-v1", "x-edge-model-version": "model-v1" } });
      }
      return new Response(JSON.stringify({ error: "inference-invalid", code: "inference-invalid", requestId: request.requestId,
        agentId: request.agentId, usage: { model: "test-model", promptTokens: 31, completionTokens: 4 } }),
      { status: 503, headers: { "x-edge-node-id": "primary", "x-edge-replica-id": "primary-replica",
        "x-edge-corpus-version": "public-v1", "x-edge-model-version": "model-v1" } });
    }
    providerCalls++;
    return new Response(JSON.stringify({ done: true, message: { content: "UNSUPPORTED-GENERATED-CONTENT" }, prompt_eval_count: 9, eval_count: 3 }));
  };
  try { await run(() => ({ providerCalls, edgeCalls, requests })); }
  finally { globalThis.fetch = fetch; for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
}

for (const profile of ["service", "operator"]) {
  test(`${profile} demo with no approved public evidence never schedules synthesis and retains failed Edge usage`, () => fixture(profile, async counts => {
    const runId = `RUN-NO-EVIDENCE-${profile.toUpperCase()}`;
    const result = await orchestrate("Explain RAG architecture", "proposed", false, undefined, undefined, runId);
    assert.ok(counts().edgeCalls > 0);
    assert.equal(counts().providerCalls, 0);
    assert.equal(result.integration.backend, "deterministic");
    assert.equal(result.integration.model, null);
    assert.equal(result.execution.remainingCount, 0);
    assert.ok(result.execution.tasks.some(task => task.kind === "central-integration" && task.status === "skipped"));
    assert.match(result.integration.fallbackReason, /Insufficient approved public evidence; synthesis not attempted/);
    assert.match(result.conclusion, /공개 근거가 부족/);
    assert.doesNotMatch(result.conclusion, /UNSUPPORTED-GENERATED-CONTENT|\[[^\]]+\]/);
    const ledger = getDistributedRun(runId);
    assert.deepEqual(ledger.stages, []);
    assert.equal(ledger.attempts.length, counts().edgeCalls);
    assert.ok(ledger.attempts.every(item => item.status === "failed" && item.promptTokens === 31 && item.completionTokens === 4));
    assert.equal(ledger.totals.knownPromptTokens, counts().edgeCalls * 31);
    assert.equal(ledger.totals.knownCompletionTokens, counts().edgeCalls * 4);
  }));
}

test("successful restricted-only Edge responses produce degraded settled insufficiency with no fabricated synthesis cost", () => fixture("service", async counts => {
  const runId = "RUN-RESTRICTED-SUCCESS";
  const registry = new RunRegistry({ idFactory: () => runId,
    executor: async (input, progress, signal) => orchestrate(input.query, input.mode, false, progress, signal, input.requestId) });
  await registry.start({ query: "Explain RAG architecture", mode: "proposed", commercialJudge: false });
  for (let i = 0; i < 100 && !registry.get(runId).executionSettled; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const snapshot = registry.get(runId);
  assert.equal(snapshot.executionSettled, true);
  assert.equal(snapshot.status, "partial_failed");
  const result = snapshot.result;
  assert.equal(result.resilience.degraded, true);
  assert.equal(result.integration.backend, "deterministic");
  assert.equal(result.metrics.llmBackend, "deterministic");
  assert.equal(result.execution.remainingCount, 0);
  assert.equal(counts().providerCalls, 0);
  const ledger = getDistributedRun(runId);
  assert.ok(ledger.attempts.length > 0);
  assert.ok(ledger.attempts.every(item => item.status === "succeeded" && item.backend === "ollama"));
  assert.deepEqual(ledger.stages, []);
  assert.equal(ledger.totals.promptTokens, counts().edgeCalls * 31);
  assert.equal(ledger.totals.completionTokens, counts().edgeCalls * 4);
  assert.match(result.conclusion, /공개 근거가 부족/);
  assert.doesNotMatch(result.conclusion, /INT-1|Restricted source summary/);
}, true));

test("ordinary no-evidence orchestration preserves its existing provider synthesis behavior", () => fixture("", async counts => {
  const runId = "RUN-NO-EVIDENCE-ORDINARY";
  const result = await orchestrate("Explain RAG architecture", "proposed", false, undefined, undefined, runId);
  assert.equal(counts().providerCalls, 1);
  assert.equal(result.integration.backend, "ollama");
  assert.match(result.conclusion, /UNSUPPORTED-GENERATED-CONTENT/);
  assert.equal(getDistributedRun(runId).stages[0].stage, "synthesis");
}));

test("actual Core orchestration marks accounting incomplete when its normal recorder rejects a call", () => fixture("", async () => {
  const runId="RUN-ORCHESTRATOR-ACCOUNTING-FAILURE";
  for(let i=0;i<64;i++)recordInferenceStage(runId,"synthesis",{backend:"ollama",model:"test",promptTokens:1,completionTokens:1},`existing-${i}`);
  const result=await orchestrate("Explain RAG architecture","proposed",false,undefined,undefined,runId);
  assert.equal(result.integration.backend,"ollama");
  const projected=projectDistributedTelemetry(getDistributedRun(runId),runId);
  assert.equal(projected.accountingIncomplete,true);assert.equal(projected.accountingFailures.length,1);
  assert.equal(projected.totals.promptTokens,null);assert.ok(projected.totals.knownPromptTokens>=64);
}));

for (const mode of ["proposed", "parallel", "managed", "centralized"]) {
  test(`grounded ${mode} actual orchestration preserves an uncited unknown and unaugmented question`, () => fixture("service", async counts => {
    process.env.DEMO_GROUNDED_ANSWERS = "true";
    const events=[];
    const result = await orchestrate("Explain RAG architecture", mode, false, event=>events.push(event), undefined, `RUN-GROUNDED-UNKNOWN-${mode}`);
    const executed = result.agents.filter(agent => agent.summary.includes("Unknown: no selected supporting span"));
    assert.ok(executed.length > 0);
    for (const agent of executed) {
      assert.doesNotMatch(agent.summary, /\[PUB-UNSELECTED\]/);
      assert.deepEqual(agent.report.citationIds, []);
      assert.deepEqual(agent.report.recommendations, []);
    }
    assert.ok(counts().requests.every(query => query === "Explain RAG architecture"), "grounded request must not append role focus");
    assert.doesNotMatch(JSON.stringify(events),/정합성을 검증|근거·누락·충돌을 검증|검증 지표 생성이 완료/);
  }, false, true));
}

for (const mode of ["proposed","managed","centralized","remoterag"]) {
  test(`grounded ${mode} rejected Core output stays failed despite proven provider completion`,()=>fixture("service",async counts=>{
    process.env.DEMO_GROUNDED_ANSWERS="true";
    const runId=`RUN-REJECTED-CORE-${mode.toUpperCase()}`;
    const result=await orchestrate("Explain RAG architecture",mode,false,undefined,undefined,runId);
    assert.ok(["partial_failed","failed"].includes(result.executionStatus));
    assert.equal(result.execution.executionStatus,result.executionStatus);
    const tasks=result.execution.tasks.filter(task=>["central-integration","managed-supervisor"].includes(task.kind));
    assert.ok(tasks.length>0);assert.ok(tasks.every(task=>task.status==="failed"));
    assert.equal(result.integration.backend,"deterministic");assert.doesNotMatch(result.conclusion,/UNSUPPORTED-GENERATED-CONTENT/);
    assert.equal(counts().providerCalls,1);
    const ledger=getDistributedRun(runId);assert.equal(ledger.calls.length,1);assert.equal(ledger.calls[0].providerFinalObserved,true);
    assert.equal(ledger.calls[0].status,"failed");assert.equal(ledger.calls[0].promptTokens,9);assert.equal(ledger.calls[0].completionTokens,3);
    assert.equal(residualComputeRisk({distributed:ledger}),false);
    const cases=Array.from({length:50},(_,i)=>({id:`status-fixture-${i}`,role:"tech",kind:i<40?"answerable":"unsupported"}));
    const samples=cases.map(c=>({caseId:c.id,occurrence:1,status:result.executionStatus,hasFinal:result.executionStatus==="completed",elapsedMs:1000,transcriptComplete:true,computeCompletionProven:true}));
    const evaluation=summarizeCompletion({cases},samples);
    assert.equal(evaluation.finalResponseP95Ms,"Infinity");assert.equal(evaluation.gates.P1,false);
  },false,true));
}

test("run registry never advertises rejected grounded Core output as completed",()=>fixture("service",async()=>{
  process.env.DEMO_GROUNDED_ANSWERS="true";
  const runId="RUN-REJECTED-CORE-REGISTRY";
  const registry=new RunRegistry({idFactory:()=>runId,executor:async(input,progress,signal)=>orchestrate(input.query,input.mode,false,progress,signal,input.requestId)});
  await registry.start({query:"Explain RAG architecture",mode:"proposed",commercialJudge:false});
  for(let i=0;i<100&&!registry.get(runId).executionSettled;i++)await new Promise(resolve=>setTimeout(resolve,10));
  const snapshot=registry.get(runId);assert.equal(snapshot.executionSettled,true);assert.equal(snapshot.status,"partial_failed");
  assert.equal(snapshot.result.executionStatus,"partial_failed");
},false,true));
