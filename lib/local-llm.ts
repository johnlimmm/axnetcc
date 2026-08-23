import type { AgentId, KnowledgeChunk } from "./agent-registry";

export type LocalLlmMetrics = {
  backend: "ollama" | "deterministic";
  answerSource: "local-llm" | "deterministic-fallback";
  model: string;
  transport: "none" | "loopback" | "remote";
  ttftMs: number | null;
  tpotMs: number | null;
  tokensPerSecond: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalMs: number;
  fallbackReason?: string;
};

type OllamaChunk = {
  message?: { content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
};

function classifyEndpointTransport(baseUrl: string): LocalLlmMetrics["transport"] {
  if (!baseUrl) return "none";
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname.endsWith(".localhost")
      ? "loopback"
      : "remote";
  } catch {
    // An invalid or opaque endpoint must not be treated as privacy-safe.
    return "remote";
  }
}

function agentEnvironmentKey(agent: AgentId, suffix: "BASE_URL" | "MODEL") {
  return `LOCAL_LLM_${agent.toUpperCase()}_${suffix}`;
}

export function resolveAgentRuntime(agent: AgentId) {
  const baseUrl =
    process.env[agentEnvironmentKey(agent, "BASE_URL")] ??
    process.env.LOCAL_LLM_BASE_URL ??
    "";
  const model =
    process.env[agentEnvironmentKey(agent, "MODEL")] ??
    process.env.LOCAL_LLM_MODEL ??
    "qwen2.5:3b";
  return { baseUrl: baseUrl.replace(/\/+$/, ""), model };
}

export async function generateLocalAnswer(input: {
  agent: AgentId;
  agentName: string;
  responsibility: string;
  query: string;
  evidence: KnowledgeChunk[];
  fallback: string;
  outputFormat?: "brief" | "agent-report" | "integrated-report";
  signal?: AbortSignal;
}): Promise<{ text: string; metrics: LocalLlmMetrics }> {
  input.signal?.throwIfAborted();
  const { baseUrl, model } = resolveAgentRuntime(input.agent);
  if (!baseUrl) {
    return {
      text: input.fallback,
      metrics: {
        backend: "deterministic",
        answerSource: "deterministic-fallback",
        model,
        transport: "none",
        ttftMs: null,
        tpotMs: null,
        tokensPerSecond: null,
        promptTokens: null,
        completionTokens: null,
        totalMs: 0,
        fallbackReason: "LOCAL_LLM_BASE_URL이 설정되지 않았습니다.",
      },
    };
  }

  const transport = classifyEndpointTransport(baseUrl);
  const startedAt = performance.now();
  const contentTimes: number[] = [];
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abortFromRequest, { once: true });
  if (input.signal?.aborted) abortFromRequest();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(process.env.LOCAL_LLM_TIMEOUT_MS ?? 90_000),
  );
  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        think: false,
        keep_alive: "10m",
        options: {
          temperature: 0.1,
          seed: 42,
          num_predict:
            input.outputFormat === "brief"
              ? 96
              : input.outputFormat === "agent-report"
                ? 160
                : 192,
          num_ctx: 4096,
        },
        messages: [
          {
            role: "system",
            content:
              `당신은 ${input.agentName}이며 ${input.responsibility}을 담당한다. ` +
              "분석 과정은 출력하지 말고 최종 답변만 작성한다. 제공된 근거에서 확인되는 사실만 사용한다. " +
              (input.outputFormat === "integrated-report"
                ? "한국어 종합보고서 형식으로 '종합 결론', '전문영역별 검토', '실행 권고', '한계'를 작성한다. 각 문단 끝에 근거 ID를 표시한다. "
                : input.outputFormat === "brief"
                  ? "한국어 2개 항목, 350자 이내로 답하고 각 항목은 '판단: ... 근거: [정확한 근거 ID]' 형식을 지킨다. "
                  : "한국어 검토보고서 형식으로 '핵심 판단', '세부 검토', '실행 권고', '한계'를 작성한다. 각 판단과 권고 끝에 근거 ID를 표시한다. ") +
              "근거에 없는 내용을 추측하지 말고, 확인할 수 없으면 '근거 부족'이라고 표시한다.",
          },
          {
            role: "user",
            content:
              `질의:\n${input.query}\n\n근거:\n` +
              input.evidence
                .slice(0, input.outputFormat === "brief" ? 2 : 10)
                .map((item) => `[${item.id}] ${item.title} / ${item.section}\n${item.text.slice(0, 250)}`)
                .join("\n\n"),
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Ollama HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let finalChunk: OllamaChunk = {};
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line) as OllamaChunk;
        const content = chunk.message?.content ?? "";
        if (content) {
          contentTimes.push(performance.now());
          text += content;
        }
        if (chunk.done) finalChunk = chunk;
      }
    }
    const totalMs = performance.now() - startedAt;
    const gaps = contentTimes.slice(1).map((time, index) => time - contentTimes[index]);
    const tokensPerSecond =
      finalChunk.eval_count && finalChunk.eval_duration
        ? finalChunk.eval_count / (finalChunk.eval_duration / 1_000_000_000)
        : null;
    const tpotMs =
      finalChunk.eval_count && finalChunk.eval_duration
        ? finalChunk.eval_duration / finalChunk.eval_count / 1_000_000
        : gaps.length
          ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length
          : null;
    const generatedText = text.trim();
    if (!generatedText) {
      return {
        text: input.fallback,
        metrics: {
          backend: "deterministic",
          answerSource: "deterministic-fallback",
          model,
          transport,
          ttftMs: null,
          tpotMs: null,
          tokensPerSecond: null,
          promptTokens: finalChunk.prompt_eval_count ?? null,
          completionTokens: finalChunk.eval_count ?? 0,
          totalMs: Math.round(totalMs),
          fallbackReason: "Ollama returned an empty response",
        },
      };
    }
    return {
      text: generatedText,
      metrics: {
        backend: "ollama",
        answerSource: "local-llm",
        model,
        transport,
        ttftMs: contentTimes.length ? Math.round(contentTimes[0] - startedAt) : null,
        tpotMs: tpotMs == null ? null : Number(tpotMs.toFixed(1)),
        tokensPerSecond: tokensPerSecond ? Number(tokensPerSecond.toFixed(2)) : null,
        promptTokens: finalChunk.prompt_eval_count ?? null,
        completionTokens: finalChunk.eval_count ?? null,
        totalMs: Math.round(totalMs),
      },
    };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return {
      text: input.fallback,
      metrics: {
        backend: "deterministic",
        answerSource: "deterministic-fallback",
        model,
        transport,
        ttftMs: null,
        tpotMs: null,
        tokensPerSecond: null,
        promptTokens: null,
        completionTokens: null,
        totalMs: Math.round(performance.now() - startedAt),
        fallbackReason: error instanceof Error ? error.message : "로컬 LLM 호출 실패",
      },
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromRequest);
  }
}
