const baseUrl = process.argv[2] ?? "http://127.0.0.1:3000";
const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/orchestrate/stream`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    query: "공공 AI 시범사업의 PoC 성능 기준과 운영 전환 조건을 정해 주세요.",
    mode: "proposed",
  }),
});
if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
const packets = (await response.text()).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const events = packets.filter((packet) => packet.type === "progress").map((packet) => packet.event);
const result = packets.findLast((packet) => packet.type === "result")?.result;
if (!result) throw new Error(packets.findLast((packet) => packet.type === "error")?.error ?? "result packet missing");

console.log(JSON.stringify({
  httpStatus: response.status,
  firstStages: events.slice(0, 10).map((event) => event.stage),
  primary: result.routerDecision?.primaryAgent ?? null,
  primarySelection: result.routerDecision?.primarySelection ? {
    algorithm: result.routerDecision.primarySelection.algorithm,
    confidence: result.routerDecision.primarySelection.confidence,
    top1Top2Margin: result.routerDecision.primarySelection.top1Top2Margin,
    hardGate: result.routerDecision.primarySelection.hardGate,
    topCandidates: result.routerDecision.primarySelection.rankedCandidates.slice(0, 3)
      .map(({ agentId, totalScore }) => ({ agentId, totalScore })),
  } : null,
  supporting: result.routerDecision?.supportingAgents ?? [],
  adaptiveAdditions: result.routerDecision?.adaptiveAdditions ?? [],
  coverage: result.evidencePlan?.coverage ?? null,
  humanReviewRequired: result.evidencePlan?.humanReviewRequired ?? null,
  integration: result.integration?.label ?? null,
  finalStatus: result.status,
}, null, 2));
