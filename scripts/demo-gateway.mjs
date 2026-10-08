import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const agents = new Set(["tech", "data", "security", "legal", "policy", "finance", "procurement", "operations"]);
export function validPort(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("Invalid fixed loopback port");
  return value;
}
export function authorized(request, token) {
  if (typeof token !== "string" || token.length < 16) return false;
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
export function json(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}
export async function readJson(request, maximum = 4096) {
  if (request.headers.origin || request.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new Error("Invalid control request");
  let length = 0; const chunks = [];
  for await (const chunk of request) {
    length += chunk.length; if (length > maximum) throw new Error("Request too large"); chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function createFaultState(enabled) {
  let state = { scenario: "healthy", agentId: "all", expiresAt: null }; let timer;
  return {
    get() { if (state.expiresAt !== null && Date.now() >= state.expiresAt) { clearTimeout(timer); state = { scenario: "healthy", agentId: "all", expiresAt: null }; } return { ...state }; },
    set(value) {
      if (!enabled) throw new Error("Fault controls disabled");
      if (!value || Object.keys(value).some(key => !["scenario", "agentId", "ttlMs"].includes(key)) || !["healthy", "primary-down", "backup-down", "both-down", "primary-delay-300"].includes(value.scenario)) throw new Error("Invalid scenario");
      const agentId = value.agentId ?? "all";
      if (agentId !== "all" && !agents.has(agentId)) throw new Error("Invalid Agent");
      if (value.scenario !== "healthy" && (!Number.isInteger(value.ttlMs) || value.ttlMs < 1 || value.ttlMs > 300000)) throw new Error("Invalid fault TTL");
      clearTimeout(timer);
      state = { scenario: value.scenario, agentId, expiresAt: value.scenario === "healthy" ? null : Date.now() + value.ttlMs };
      if (state.expiresAt !== null) { timer = setTimeout(() => { state = { scenario: "healthy", agentId: "all", expiresAt: null }; }, value.ttlMs); timer.unref(); }
      return { ...state };
    },
    close() { clearTimeout(timer); },
  };
}
/** Fixed-loopback streaming proxy; never follows redirects, rewrites identity, or fabricates usage. */
export function forward(request, response, { port, path, requestLimit = 65536, responseLimit = 262144, token, timeoutMs = 120000, transientCode = "edge-unavailable", forwardedProto }) {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > requestLimit)) {
    json(response, 413, { code: "request-too-large" }); request.resume(); return null;
  }
  const headers = { "content-type": request.headers["content-type"] ?? "application/json", accept: request.headers.accept ?? "application/json" };
  for (const name of ["x-edge-agent-id", "x-edge-attempt-id"]) if (request.headers[name]) headers[name] = request.headers[name];
  if (forwardedProto === "https") headers["x-forwarded-proto"] = "https";
  if (token) headers.authorization = `Bearer ${token}`;
  let received = 0; let completed = false;
  const upstream = http.request({ hostname: "127.0.0.1", port: validPort(port), path, method: request.method, headers }, async incoming => {
    const outgoingHeaders = { "cache-control": "no-store" };
    for (const name of ["content-type", "x-edge-node-id", "x-edge-replica-id", "x-edge-corpus-version", "x-edge-model-version"]) {
      if (incoming.headers[name]) outgoingHeaders[name] = incoming.headers[name];
    }
    response.writeHead(incoming.statusCode ?? 502, outgoingHeaders);
    const limit = new Transform({ transform(chunk, _encoding, callback) { received += chunk.length; callback(received > responseLimit ? new Error("Response limit") : null, chunk); } });
    try { await pipeline(incoming, limit, response); completed = true; }
    catch { incoming.destroy(); response.destroy(); }
    finally { clearTimeout(timer); }
  });
  const timer = setTimeout(() => { upstream.destroy(Object.assign(new Error("Upstream timeout"), { code: "ETIMEDOUT" })); }, timeoutMs); timer.unref();
  upstream.on("error", error => { clearTimeout(timer); const transient = ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"].includes(error.code); json(response, transient ? 503 : 502, { code: transient ? transientCode : "edge-invalid" }); });
  request.on("aborted", () => upstream.destroy());
  response.on("close", () => { clearTimeout(timer); if (!completed) upstream.destroy(); });
  let sent = 0;
  request.on("data", chunk => { sent += chunk.length; if (sent > requestLimit) { json(response, 413, { code: "request-too-large" }); upstream.destroy(); } else if (!upstream.write(chunk)) request.pause(); });
  upstream.on("drain", () => request.resume());
  request.on("end", () => upstream.end());
  request.on("error", () => upstream.destroy());
  return upstream;
}
export function createGatewayHandlers(config) {
  if (!Array.isArray(config.routes) || config.routes.length > 16 || !config.routes.length) throw new Error("Invalid fixed routes");
  const routes = new Map();
  for (const route of config.routes) {
    if (!["primary", "backup"].includes(route.role) || !agents.has(route.agentId) || typeof route.token !== "string" || route.token.length < 16) throw new Error("Invalid route configuration");
    validPort(route.port);
    const path = `/${route.role}/${route.agentId}/api/edge/agent`;
    if (routes.has(path)) throw new Error("Duplicate route"); routes.set(path, { ...route });
  }
  if (typeof config.controlToken !== "string" || config.controlToken.length < 16) throw new Error("Invalid control token");
  const faults = createFaultState(config.faultsEnabled === true);
  return {
    close: () => faults.close(),
    data(request, response) {
      const route = routes.get(request.url);
      if (!route) return json(response, 404, { code: "route-not-found" });
      if (request.method !== "POST") return json(response, 405, { code: "method-not-allowed" });
      if (!authorized(request, route.token)) return json(response, 401, { code: "unauthorized" });
      if (request.headers["x-edge-agent-id"] !== route.agentId) return json(response, 403, { code: "agent-mismatch" });
      const fault = faults.get();
      if ((fault.agentId === "all" || fault.agentId === route.agentId) && (fault.scenario === "both-down" || fault.scenario === `${route.role}-down`)) return json(response, 503, { code: "edge-unavailable" });
      const execute = () => {
        if (!response.destroyed && !request.aborted) forward(request, response, { port: route.port, path: "/api/edge/agent", token: route.token, forwardedProto: "https" });
      };
      if (fault.scenario === "primary-delay-300" && route.role === "primary" && (fault.agentId === "all" || fault.agentId === route.agentId)) {
        const timer = setTimeout(execute, 300);
        response.once("close", () => clearTimeout(timer));
      } else execute();
    },
    async control(request, response) {
      if (!authorized(request, config.controlToken)) return json(response, 401, { code: "unauthorized" });
      if (request.url !== "/fault") return json(response, 404, { code: "not-found" });
      if (request.method === "GET") return json(response, 200, { enabled: config.faultsEnabled === true, ...faults.get() });
      if (request.method !== "POST") return json(response, 405, { code: "method-not-allowed" });
      if (!config.faultsEnabled) return json(response, 403, { code: "faults-disabled" });
      try { json(response, 200, faults.set(await readJson(request))); }
      catch { json(response, 400, { code: "invalid-fault-request" }); }
    },
  };
}
export function startGateway(config) {
  if (config.listenHost && config.listenHost !== "127.0.0.1") throw new Error("Gateway binds loopback only; use verified SSH forwarding");
  const handlers = createGatewayHandlers(config);
  const server = https.createServer({ cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile) }, handlers.data);
  const control = http.createServer(handlers.control);
  server.listen(validPort(config.port ?? 19443), "127.0.0.1"); control.listen(validPort(config.controlPort ?? 19444), "127.0.0.1");
  return { server, control, close() { handlers.close(); server.close(); control.close(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[process.argv.indexOf("--config") + 1];
  if (!process.argv.includes("--config") || !file) throw new Error("Usage: node scripts/demo-gateway.mjs --config PRIVATE_JSON");
  startGateway(JSON.parse(readFileSync(file, "utf8")));
  console.log("Isolated demo TLS gateway and loopback fault controller started");
}
