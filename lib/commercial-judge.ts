type JudgeInput = {
  query: string;
  answer: string;
  evidence: string;
  signal?: AbortSignal;
};

export type CommercialJudgeResult = {
  enabled: boolean;
  provider: string;
  model?: string;
  correctness?: number;
  groundedness?: number;
  completeness?: number;
  overall?: number;
  rationale?: string;
  error?: string;
};

export async function evaluateWithCommercialJudge(
  input: JudgeInput,
): Promise<CommercialJudgeResult> {
  const baseUrl = process.env.COMMERCIAL_JUDGE_BASE_URL?.replace(/\/+$/, "");
  const apiKey = process.env.COMMERCIAL_JUDGE_API_KEY;
  const model = process.env.COMMERCIAL_JUDGE_MODEL;
  if (!baseUrl || !apiKey || !model) {
    return {
      enabled: false,
      provider: "not configured",
      error: "상용 LLM 평가 설정이 없습니다.",
    };
  }
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "당신은 블라인드 평가자다. 시스템 종류를 추측하지 말고 제공된 질의·답변·근거만 평가한다. " +
              "correctness, groundedness, completeness, overall을 0~100 정수로, rationale을 한 문장으로 JSON 출력한다.",
          },
          {
            role: "user",
            content: `질의:\n${input.query}\n\n답변:\n${input.answer}\n\n검색 근거:\n${input.evidence}`,
          },
        ],
      }),
      signal: input.signal,
    });
    if (!response.ok) throw new Error(`Judge HTTP ${response.status}`);
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const parsed = JSON.parse(payload.choices?.[0]?.message?.content ?? "{}");
    const score = (value: unknown) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    return {
      enabled: true,
      provider: new URL(baseUrl).hostname,
      model,
      correctness: score(parsed.correctness),
      groundedness: score(parsed.groundedness),
      completeness: score(parsed.completeness),
      overall: score(parsed.overall),
      rationale: String(parsed.rationale ?? ""),
    };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return {
      enabled: true,
      provider: "configured",
      model,
      error: error instanceof Error ? error.message : "상용 LLM 평가 실패",
    };
  }
}
