import type { AgentId, KnowledgeChunk } from "./knowledge";

export type LocalLlmMetrics = {
  backend: "ollama" | "deterministic";
  model: string;
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

const inferenceQueues = new Map<string, Promise<void>>();

async function acquireInferenceSlot(endpoint: string) {
  const previous = inferenceQueues.get(endpoint) ?? Promise.resolve();
  let release = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  inferenceQueues.set(endpoint, next);
  await previous;
  return () => {
    release();
    if (inferenceQueues.get(endpoint) === next) {
      inferenceQueues.delete(endpoint);
    }
  };
}

function agentEnvironmentKey(agent: AgentId, suffix: "BASE_URL" | "MODEL") {
  return `LOCAL_LLM_${agent.toUpperCase()}_${suffix}`;
}

function resolveAgentRuntime(agent: AgentId) {
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
}): Promise<{ text: string; metrics: LocalLlmMetrics }> {
  const { baseUrl, model } = resolveAgentRuntime(input.agent);
  if (!baseUrl) {
    return {
      text: input.fallback,
      metrics: {
        backend: "deterministic",
        model,
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

  const releaseInferenceSlot = await acquireInferenceSlot(baseUrl);
  const startedAt = performance.now();
  const contentTimes: number[] = [];
  const controller = new AbortController();
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
          num_predict: 64,
          num_ctx: 2048,
        },
        messages: [
          {
            role: "system",
            content:
              `당신은 ${input.agentName}이며 ${input.responsibility}을 담당한다. ` +
              "분석 과정은 출력하지 말고 최종 답변만 작성한다. 제공된 근거만 사용해 한국어 2개 항목, 250자 이내로 답하라. " +
              "각 항목 끝에 [근거 ID]를 표시하고, 근거가 부족하면 명시하라.",
          },
          {
            role: "user",
            content:
              `질의:\n${input.query}\n\n근거:\n` +
              input.evidence
                .slice(0, 2)
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
    return {
      text: text.trim() || input.fallback,
      metrics: {
        backend: "ollama",
        model,
        ttftMs: contentTimes.length ? Math.round(contentTimes[0] - startedAt) : null,
        tpotMs: tpotMs == null ? null : Number(tpotMs.toFixed(1)),
        tokensPerSecond: tokensPerSecond ? Number(tokensPerSecond.toFixed(2)) : null,
        promptTokens: finalChunk.prompt_eval_count ?? null,
        completionTokens: finalChunk.eval_count ?? null,
        totalMs: Math.round(totalMs),
      },
    };
  } catch (error) {
    return {
      text: input.fallback,
      metrics: {
        backend: "deterministic",
        model,
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
    releaseInferenceSlot();
  }
}
