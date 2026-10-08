import type { AgentId } from "./agent-registry";
export type EdgeReplica = {
  endpoint: string; token: string; role: "primary" | "backup"; nodeId: string; replicaId: string;
  corpusVersion: string | null; modelVersion: string | null;
};
export function remoteAgentEnabled(agentId: AgentId) {
  const mode = (process.env.EDGE_AGENT_MODE ?? "auto").trim().toLowerCase();
  return mode === "remote" || (mode === "auto" && Boolean(process.env[`EDGE_AGENT_${agentId.toUpperCase()}_BASE_URL`] ?? process.env.EDGE_AGENT_BASE_URL));
}
export function edgeEndpoint(baseUrl: string) {
  const url = new URL(baseUrl);
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && process.env.NODE_ENV !== "production")) {
    throw new Error("Edge Agent requires HTTPS (HTTP allowed only on development loopback)");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Invalid Edge endpoint configuration");
  if (!url.pathname.endsWith("/api/edge/agent")) url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/edge/agent`;
  return url.toString();
}
export function resolveEdgeReplicas(agentId: AgentId): EdgeReplica[] {
  const prefix = `EDGE_AGENT_${agentId.toUpperCase()}_`;
  const backup = process.env[`${prefix}BACKUP_BASE_URL`];
  const strict = Boolean(backup) || process.env.DEMO_REQUIRE_LLM === "true";
  if (process.env.NODE_ENV === "production" && process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("TLS certificate verification must not be disabled");
  const roles = backup ? ["primary", "backup"] as const : ["primary"] as const;
  const replicas = roles.map(role => {
    const key = role === "backup" ? `${prefix}BACKUP_` : prefix;
    const base = process.env[`${key}BASE_URL`] ?? (role === "primary" ? process.env.EDGE_AGENT_BASE_URL : "") ?? "";
    const token = process.env[`${key}TOKEN`] || (role === "primary" && process.env.NODE_ENV !== "production" ? process.env.EDGE_AGENT_TOKEN : "") || "";
    if (!token) throw new Error("Remote Edge Agent authentication token is required");
    const nodeId = process.env[`${key}NODE_ID`] || "unconfigured";
    const replicaId = process.env[`${key}REPLICA_ID`] || "unconfigured";
    const corpusVersion = process.env.EDGE_EXPECTED_CORPUS_VERSION || null;
    const modelVersion = process.env.EDGE_EXPECTED_MODEL_VERSION || null;
    if (strict && (nodeId === "unconfigured" || replicaId === "unconfigured" || !corpusVersion || !modelVersion)) throw new Error("Incomplete trusted Edge replica manifest");
    if (![nodeId, replicaId].every(value => /^[a-zA-Z0-9_-]{1,96}$/.test(value))) throw new Error("Invalid Edge identity configuration");
    return { endpoint: edgeEndpoint(base), token, role, nodeId, replicaId, corpusVersion: strict ? corpusVersion : null, modelVersion: strict ? modelVersion : null };
  });
  if (replicas.length === 2 && (replicas[0].nodeId === replicas[1].nodeId || replicas[0].replicaId === replicas[1].replicaId || replicas[0].endpoint === replicas[1].endpoint)) throw new Error("Backup must have a distinct endpoint and node/replica identity");
  return replicas;
}
