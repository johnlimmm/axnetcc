const baseUrl = (process.env.MNC_DEMO_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const query = "권한경계 기밀 대응 절차를 보안과 운영 관점에서 검토해 주세요.";

const response = await fetch(`${baseUrl}/api/orchestrate/stream`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query, mode: "proposed", commercialJudge: false }),
});
if (!response.ok) throw new Error(`Demo HTTP ${response.status}`);

const raw = await response.text();
const packets = raw.split(/\r?\n/).filter(Boolean).map(JSON.parse);
console.log("\n[MNC-6 실행 단계]");
for (const packet of packets.filter((item) => item.type === "progress")) {
  const agent = packet.event.agentId ? ` · ${packet.event.agentId}` : "";
  console.log(`${String(packet.event.sequence).padStart(2, "0")} ${packet.event.stage}${agent} — ${packet.event.message}`);
}

const result = packets.findLast((item) => item.type === "result")?.result;
if (!result) throw new Error("Demo result packet is missing");
const security = result.agents.find((agent) => agent.id === "security");
const operations = result.agents.find((agent) => agent.id === "operations");
console.log("\n[MNC-6 경계 검증]");
console.log(JSON.stringify({
  boundary: result.boundary,
  security: {
    allowedClasses: security.policy.allowedClasses,
    returnedClasses: security.policy.returnedClasses,
    evidence: security.evidence.map((item) => ({
      id: item.id,
      classification: item.classification,
      disclosure: item.disclosure,
      excerpt: item.excerpt,
    })),
  },
  operations: {
    allowedClasses: operations.policy.allowedClasses,
    returnedClasses: operations.policy.returnedClasses,
    blockedCount: operations.policy.blockedCount,
    confidentialEvidenceReturned: operations.evidence.some((item) => item.classification === "confidential"),
  },
  rawCanaryPresentInCoreResponse: /BLUE-731|010-9123-4567/.test(raw),
}, null, 2));
