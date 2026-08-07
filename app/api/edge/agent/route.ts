import { agentIds, type AgentId } from "../../../../lib/agent-registry";
import {
  validateEdgeAgentRequest,
  validateEdgeAgentResponse,
  type EdgeAgentResponse,
} from "../../../../lib/edge-agent-contract";
import { executeEdgeAgentLocally } from "../../../../lib/edge-agent-service";

export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 32 * 1024;
const agentIdSet = new Set<string>(agentIds);
const encoder = new TextEncoder();
const responseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

class RequestTooLargeError extends Error {}

function isAgentId(value: string | null | undefined): value is AgentId {
  return typeof value === "string" && agentIdSet.has(value);
}

function isLoopback(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "localhost" ||
    hostname === "::1" || hostname === "[::1]";
}

function errorResponse(code: string, status: number) {
  return Response.json({ error: code }, { status, headers: responseHeaders });
}

function deployedAgentId() {
  const configured = process.env.EDGE_AGENT_ID;
  return isAgentId(configured) ? configured : null;
}

function configuredToken(agentId: AgentId) {
  const agentToken = process.env[`EDGE_AGENT_${agentId.toUpperCase()}_TOKEN`] ?? "";
  if (process.env.NODE_ENV === "production") return agentToken;
  return agentToken || process.env.EDGE_AGENT_TOKEN || "";
}

function bearerToken(header: string | null) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(header ?? "");
  return match?.[1] ?? "";
}

function constantTimeEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function usesTls(request: Request) {
  if (new URL(request.url).protocol === "https:") return true;
  const forwardedProtocol = request.headers.get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  return forwardedProtocol === "https";
}

async function readLimitedRequest(request: Request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new RequestTooLargeError();
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function serializeMeasuredResponse(response: EdgeAgentResponse) {
  response.boundary.transport = "http";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const body = JSON.stringify(response);
    const bytes = encoder.encode(body).length;
    if (response.boundary.returnedBytes === bytes && response.metrics.egressBytes === bytes) {
      return body;
    }
    response.boundary.returnedBytes = bytes;
    response.metrics.egressBytes = bytes;
  }
  throw new Error("EDGE_RESPONSE_SIZE_DID_NOT_CONVERGE");
}

export async function POST(request: Request) {
  const production = process.env.NODE_ENV === "production";
  const headerAgent = request.headers.get("x-edge-agent-id");
  const configuredAgent = deployedAgentId();

  if (production && !configuredAgent) {
    return errorResponse("EDGE_AGENT_ID_NOT_CONFIGURED", 503);
  }
  const endpointAgent = configuredAgent ?? (isAgentId(headerAgent) ? headerAgent : null);
  if (!endpointAgent || headerAgent !== endpointAgent) {
    return errorResponse("EDGE_AGENT_ID_MISMATCH", 403);
  }
  if (production && !usesTls(request)) {
    return errorResponse("EDGE_TLS_REQUIRED", 426);
  }

  const expectedToken = configuredToken(endpointAgent);
  if (production && !expectedToken) {
    return errorResponse("EDGE_AGENT_TOKEN_NOT_CONFIGURED", 503);
  }
  const suppliedToken = bearerToken(request.headers.get("authorization"));
  const requestHost = new URL(request.url).hostname;
  const unauthenticatedLoopbackDevelopment = !production && !expectedToken && isLoopback(requestHost);
  if (!unauthenticatedLoopbackDevelopment &&
      (!expectedToken || !constantTimeEqual(suppliedToken, expectedToken))) {
    return errorResponse("EDGE_AUTH_FAILED", 401);
  }

  const declaredLengthHeader = request.headers.get("content-length");
  const declaredLength = declaredLengthHeader === null ? 0 : Number(declaredLengthHeader);
  if (!Number.isFinite(declaredLength) || declaredLength < 0) {
    return errorResponse("EDGE_CONTENT_LENGTH_INVALID", 400);
  }
  if (declaredLength > MAX_REQUEST_BYTES) {
    return errorResponse("EDGE_REQUEST_TOO_LARGE", 413);
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return errorResponse("EDGE_CONTENT_TYPE_UNSUPPORTED", 415);
  }

  let raw: string;
  try {
    raw = await readLimitedRequest(request);
  } catch (error) {
    if (error instanceof RequestTooLargeError) {
      return errorResponse("EDGE_REQUEST_TOO_LARGE", 413);
    }
    return errorResponse("EDGE_REQUEST_READ_FAILED", 400);
  }

  let edgeRequest;
  try {
    edgeRequest = validateEdgeAgentRequest(JSON.parse(raw));
  } catch {
    return errorResponse("EDGE_REQUEST_INVALID", 400);
  }
  if (edgeRequest.agentId !== endpointAgent) {
    return errorResponse("EDGE_AGENT_ID_MISMATCH", 403);
  }

  try {
    const localResult = await executeEdgeAgentLocally(edgeRequest, request.signal);
    localResult.boundary.transport = "http";
    const result = validateEdgeAgentResponse(localResult);
    const body = serializeMeasuredResponse(result);
    return new Response(body, {
      status: 200,
      headers: {
        ...responseHeaders,
        "content-type": "application/json; charset=utf-8",
      },
    });
  } catch {
    return errorResponse(request.signal.aborted ? "EDGE_REQUEST_ABORTED" : "EDGE_EXECUTION_FAILED", 500);
  }
}
