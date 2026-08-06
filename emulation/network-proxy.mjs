import http from "node:http";
import { readFile } from "node:fs/promises";
import { byteLength, ports, seeded } from "./runtime.mjs";
const scenarios = JSON.parse(await readFile(new URL("./scenarios.json", import.meta.url), "utf8"));
const readBody = (request) => new Promise((resolve, reject) => { const chunks = []; request.on("data", (chunk) => chunks.push(chunk)); request.on("end", () => resolve(Buffer.concat(chunks))); request.on("error", reject); });
const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") return json(response, 200, { ok: true, scenarios: Object.keys(scenarios) });
  if (request.method !== "POST" || request.url !== "/proxy/fetch") return json(response, 404, { error: "not found" });
  const raw = await readBody(request); const body = JSON.parse(raw.toString("utf8")); const scenario = scenarios[body.networkScenario] ?? scenarios.normal; const random = seeded(Number(body.seed ?? 20260806));
  const jitter = (random() * 2 - 1) * scenario.jitterMs; const baseDelay = Math.max(0, scenario.latencyMs + jitter); const syntheticFailure = random() < scenario.lossRate;
  if (syntheticFailure) { await delay(baseDelay); return json(response, 503, { syntheticFailure: true, emulatedNetworkDelayMs: baseDelay }); }
  const started = performance.now();
  const ownerDelay = Math.max(0, Number(body.ownerProcessingMs ?? 0) * scenario.ownerProcessingMultiplier);
  await delay(baseDelay + ownerDelay);
  try {
    const upstream = await fetch(`http://127.0.0.1:${ports[body.ownerDepartment]}/evidence/fetch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(scenario.timeoutMs) });
    const upstreamText = await upstream.text(); const transferDelay = byteLength(upstreamText) / scenario.bandwidthBytesPerSecond * 1000; await delay(transferDelay);
    const payload = { ...JSON.parse(upstreamText), seededBaseDelayMs: Number(baseDelay.toFixed(6)), emulatedNetworkDelayMs: Number((baseDelay + ownerDelay + transferDelay).toFixed(3)), proxyElapsedMs: Number((performance.now() - started).toFixed(3)), requestBytes: raw.length, responseBytes: byteLength(upstreamText), httpStatus: upstream.status };
    return json(response, upstream.status, payload);
  } catch (error) { return json(response, 504, { timeout: true, error: error instanceof Error ? error.message : String(error), emulatedNetworkDelayMs: baseDelay }); }
});
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function json(response, status, body) { const data = JSON.stringify(body); response.writeHead(status, { "content-type": "application/json", "content-length": byteLength(data) }); response.end(data); }
server.listen(4400, "127.0.0.1", () => process.send?.({ type: "ready", role: "proxy", port: 4400 }));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
