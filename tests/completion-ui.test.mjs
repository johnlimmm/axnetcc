import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { startMonitor } from "../monitor/server.mjs";
import { demoProfile } from "../lib/demo-profile.ts";
import { monitorUrl } from "../lib/monitor-url.ts";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const monitorJs = await readFile(new URL("../monitor/public/app.js", import.meta.url), "utf8");

test("completion and distributed caveats have scoped readable prose without restyling legacy labels", async () => {
  const css = await readFile(new URL("../monitor/public/style.css", import.meta.url), "utf8");
  assert.match(css, /:is\(\[data-testid="completion-gates"\], \[data-testid="distributed-evaluation"\], \[data-testid="distributed-empty"\]\) :is\(\.methodNote, \.panelHead p, \.metric small, \.observedPaths small\)\s*\{\s*font-size: 14px;\s*line-height: 1\.8;\s*\}/);
  assert.match(css, /\.metric>span\{[^}]*font-size:12px/);
});

test("final integration progress describes grounded failure honestly and preserves ordinary completion copy", async () => {
  const source = await readFile(new URL("../lib/orchestrator.ts", import.meta.url), "utf8");
  const start = source.lastIndexOf('  report("central.completed",');
  const end = source.indexOf('  report("request.completed",', start);
  const progress = source.slice(start, end);
  for (const grounded of [true, false]) {
    for (const executionStatus of ["completed", "failed", "partial_failed"]) {
      let message;
      vm.runInNewContext(progress, {
        groundedAnswersEnabled: () => grounded, result: { executionStatus },
        integration: { label: "중앙 Core", backend: "ollama" }, evidenceCount: 2,
        report: (_stage, text) => { message = text; },
      });
      assert.equal(message, grounded && executionStatus !== "completed"
        ? "중앙 Core의 최종 통합에 실패했습니다. 최종 답변을 확정하지 못했습니다."
        : "중앙 Core의 최종 통합이 완료됐습니다.");
    }
  }
});

test("evaluation redirect uses unified evaluation and retains only validated run identifiers", async () => {
  const source = await readFile(new URL("../app/evaluation/page.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { exports: {}, require: name => {
    if (name === "next/navigation") return { redirect: location => { throw new Error(location); } };
    if (name === "../../lib/demo-profile") return { demoProfile };
    if (name === "../../lib/monitor-url") return { monitorUrl };
    throw new Error(`Unexpected import ${name}`);
  } };
  vm.runInNewContext(code, context);
  const previous = process.env.DEMO_PROFILE;
  try {
    for (const profile of [undefined, "", "service", "operator", "invalid"]) {
      if (profile === undefined) delete process.env.DEMO_PROFILE;
      else process.env.DEMO_PROFILE = profile;
      for (const run of [undefined, "RUN-abc-123", "https://evil.test", "RUN-a?token=secret", ["RUN-abc-123"]]) {
        const expected = run === "RUN-abc-123"
          ? "/evaluation?run=RUN-abc-123"
          : "/evaluation";
        await assert.rejects(context.exports.default({ searchParams: Promise.resolve({ run }) }), error => error.message === monitorUrl(expected));
      }
    }
  } finally {
    if (previous === undefined) delete process.env.DEMO_PROFILE;
    else process.env.DEMO_PROFILE = previous;
  }
});

test("grounded display preserves attribution, unknowns, scope and escapes source text", () => {
  const component = page.slice(page.indexOf("function GroundedAnswerContent"), page.indexOf("function IntegratedReportDocument"));
  const code = ts.transpileModule(`export ${component}`, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { exports: {}, require: createRequire(import.meta.url) };
  vm.runInNewContext(code, context);
  const text = '모델이 선택한 공개 근거 발췌 (model-guided extractive)\n요청 Q1: 접근 권한\n- 문서 발췌 — 제목 / p.10 (2025):\n“<script>unsafe</script> 최소 권한” [source:10]\n확인 불가 / 필요한 정보: 설계 정보 필요\n적용 범위: 해당 문서';
  const html = renderToStaticMarkup(React.createElement(context.exports.GroundedAnswerContent, { text, evidenceIds: ["source:10"] }));
  assert.match(html, /<blockquote/);
  assert.match(html, /href="#evidence-source%3A10"/);
  assert.match(html, /groundedUnknown/);
  assert.match(html, /groundedScope/);
  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /보증하지 않습니다/);
  const generated = renderToStaticMarkup(React.createElement(context.exports.GroundedAnswerContent, { text: "공개 근거를 바탕으로 생성한 답변 (source-grounded generation · 의미 검증 미완료)\n요청 Q1: 운영\n- 생성된 주장 [source:10]\n판단 범위: 조직의 준수 여부는 판단 불가", evidenceIds: ["source:10"] }));
  assert.match(generated, /생성된 주장에 대한 의미 검증은 완료되지 않았습니다/);
  assert.doesNotMatch(generated, /원문 발췌를 표시합니다/);
  assert.match(generated, /groundedScope/);
  assert.match(generated, /href="#evidence-source%3A10"/);
});

test("service separates public question scope, cancellation and evaluation controls", () => {
  assert.match(page, /등록된 공개 문서에서 근거를 검색합니다/);
  assert.match(page, /지원하는 8개 업무 역할/);
  assert.doesNotMatch(page, /주관기관|지원기관/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /onCancel=\{\(\) => void cancelRun\(\)\}/);
  const cancellation = page.slice(page.indexOf("async function cancelRun"), page.indexOf("function startNewRequest"));
  assert.match(cancellation, /method: "DELETE"/);
  assert.match(cancellation, /if \(!response.ok\)/);
  assert.doesNotMatch(cancellation, /\.abort\(/);
  assert.doesNotMatch(page, /\/api\/fault|\/api\/calls\.csv|operatorToken/);
  assert.match(page, /text=\{result.conclusion\}/);
  assert.match(page, /text=\{agent.summary\}/);
});

test("monitor distinguishes pending acceptance from historical metrics and exports per-call detail", () => {
  assert.match(monitorJs, /평가 보고서 미연결/);
  assert.match(monitorJs, /목표이며 달성 실측값이 아닙니다/);
  assert.match(monitorJs, /과거 WATCH/);
  assert.match(monitorJs, /distributedCallDetails\(run\)/);
  assert.match(monitorJs, /esc\(call.callId\)/);
  assert.match(monitorJs, /usage\.knownPromptTokens/);
  assert.match(monitorJs, /\/api\/calls\.csv/);
  assert.match(monitorJs, /\/api\/run\?instance=/);
});

test("monitor renders repeated-stage calls separately and unknown usage without zero substitution", () => {
  const helpers = monitorJs.slice(monitorJs.indexOf("function completionGateView"), monitorJs.indexOf("function distributedView"));
  const context = {
    numeric: value => typeof value === "number" && Number.isFinite(value),
    count: value => String(value), esc: value => String(value).replaceAll("<", "&lt;"), agents: { tech: "기술" },
  };
  vm.createContext(context); vm.runInContext(helpers, context);
  const run = { instanceId: "i", runId: "r", distributed: { deploymentId: "demo", callDetail: "per-call", calls: [
    { callId: "first", stage: "synthesis", model: "m", backend: "ollama", promptTokens: 7, completionTokens: 3 },
    { callId: "second", stage: "synthesis", model: "m", backend: "ollama", promptTokens: null, completionTokens: null },
  ], attempts: [{ agentId: "tech", role: "primary", nodeId: "observed-primary" }] } };
  const html = context.distributedCallDetails(run);
  assert.match(html, /first/); assert.match(html, /second/);
  assert.match(html, /7 \/ 3/); assert.match(html, /미측정 \/ 미측정/);
  assert.match(context.observedTopology([run]), /observed-primary/);
  assert.match(context.observedTopology([run]), /백업 <b>미관측/);
});

test("calls CSV is a read-only filtered download without inferred historical calls", async () => {
  const monitor = await startMonitor({ port: 0, database: ":memory:", serviceUrl: "http://source.test", fetchImpl: async () => new Response(null, { status: 503 }) });
  try {
    const response = await fetch(`${monitor.url}/api/calls.csv`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition"), /mnc-distributed-calls.csv/);
    const header = await response.text();
    for (const field of ["callId", "stage", "detail", "backend", "model", "promptTokens", "completionTokens"]) assert.ok(header.includes(`"${field}"`));
    assert.equal((await fetch(`${monitor.url}/api/calls.csv?window=invalid`)).status, 400);
    assert.equal((await fetch(`${monitor.url}/api/calls.csv`, { method: "POST" })).status, 405);
  } finally { await monitor.stop(); }
});
