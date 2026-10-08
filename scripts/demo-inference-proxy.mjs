import http from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { authorized, json, readJson, forward, validPort, createFaultState } from "./demo-gateway.mjs";
export function createInferenceProxyHandler(config) {
  validPort(config.upstreamPort ?? 13434);
  if (typeof config.controlToken !== "string" || config.controlToken.length < 16) throw new Error("Invalid control token");
  let activeRequests = 0;
  const fault = createFaultState(config.faultsEnabled === true);
  const handler = async (request, response) => {
    if (request.url === "/__health" && request.method === "GET") {
      if (!authorized(request, config.controlToken)) return json(response, 401, { code: "unauthorized" });
      return json(response, 200, { activeRequests, drainSemantics: "upstream-transport-closed-not-proof-of-compute-stop" });
    }
    if (request.url === "/__control") {
      if (!authorized(request, config.controlToken)) return json(response, 401, { code: "unauthorized" });
      if (request.method === "GET") return json(response, 200, { unavailable: fault.get().scenario !== "healthy", expiresAt: fault.get().expiresAt, enabled: config.faultsEnabled === true });
      if (request.method !== "POST") return json(response, 405, { code: "method-not-allowed" });
      if (!config.faultsEnabled) return json(response, 403, { code: "faults-disabled" });
      try {
        const body = await readJson(request);
        if (typeof body.unavailable !== "boolean" || Object.keys(body).some(key => !["unavailable", "ttlMs"].includes(key))) throw new Error("Invalid control");
        const state = fault.set({ scenario: body.unavailable ? "primary-down" : "healthy", ttlMs: body.ttlMs });
        return json(response, 200, { unavailable: state.scenario !== "healthy", expiresAt: state.expiresAt });
      } catch { return json(response, 400, { code: "invalid-fault-request" }); }
    }
    if (!((request.url === "/api/chat" && request.method === "POST") || (["/api/tags", "/api/version"].includes(request.url) && request.method === "GET"))) return json(response, 404, { code: "not-found" });
    if (request.url === "/api/chat" && fault.get().scenario !== "healthy") return json(response, 503, { code: "inference-unavailable" });
    if (activeRequests >= 1) return json(response, 503, { code: "inference-unavailable" });
    activeRequests++;
    const upstream = forward(request, response, { port: config.upstreamPort ?? 13434, path: request.url, requestLimit: 262144, responseLimit: 16 * 1024 * 1024, transientCode: "inference-unavailable" });
    if (upstream) upstream.once("close", () => { activeRequests--; });
    else activeRequests--;
  };
  handler.close = () => fault.close(); return handler;
}
export function startInferenceProxy(config) {
  if (config.listenHost && config.listenHost !== "127.0.0.1") throw new Error("Inference proxy binds loopback only");
  const handler = createInferenceProxyHandler(config); const server = http.createServer(handler);
  server.listen(validPort(config.port ?? 13435), "127.0.0.1"); return { server, close() { handler.close(); server.close(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[process.argv.indexOf("--config") + 1];
  if (!process.argv.includes("--config") || !file) throw new Error("Usage: node scripts/demo-inference-proxy.mjs --config PRIVATE_JSON");
  startInferenceProxy(JSON.parse(readFileSync(file, "utf8"))); console.log("Isolated loopback inference proxy started");
}
