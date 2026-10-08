import { sanitizeSensitiveText } from "./data-loss-prevention.ts";

export const feedbackCategories = {
  accuracy: "답변 정확성", evidence: "근거와 출처", latency: "응답 속도", usability: "화면 사용성", other: "기타",
} as const;
export type FeedbackInput = {
  id: string;
  runId: string | null;
  rating: number;
  categories: Array<keyof typeof feedbackCategories>;
  comment: string;
};
export type FeedbackRecord = FeedbackInput & { createdAt: string };
export interface FeedbackStore {
  save(record: FeedbackRecord): Promise<{ created: boolean }>;
  list(): Promise<FeedbackRecord[]>;
}

export function parseFeedback(value: unknown): FeedbackInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.id)) return null;
  if (input.runId !== null && (typeof input.runId !== "string" || !/^RUN-[A-Za-z0-9-]{3,64}$/.test(input.runId))) return null;
  if (!Number.isInteger(input.rating) || Number(input.rating) < 1 || Number(input.rating) > 5) return null;
  if (!Array.isArray(input.categories) || input.categories.length > 5 || input.categories.some((key) => typeof key !== "string" || !Object.hasOwn(feedbackCategories, key))) return null;
  if (typeof input.comment !== "string" || input.comment.length > 2000) return null;
  return {
    id: input.id, runId: input.runId as string | null, rating: Number(input.rating),
    categories: [...new Set(input.categories)] as FeedbackInput["categories"],
    comment: sanitizeSensitiveText(input.comment.trim()).sanitized,
  };
}

export function summarizeFeedback(records: FeedbackRecord[]) {
  const sorted = [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    total: sorted.length,
    averageRating: sorted.length ? sorted.reduce((sum, record) => sum + record.rating, 0) / sorted.length : null,
    ratings: Object.fromEntries([1, 2, 3, 4, 5].map(rating => [rating, sorted.filter(record => record.rating === rating).length])),
    categories: Object.fromEntries(Object.keys(feedbackCategories).map((key) => [key, sorted.filter((record) => record.categories.includes(key as keyof typeof feedbackCategories)).length])),
    recent: sorted.slice(0, 50).map(({ id, runId, rating, categories, comment, createdAt }) => ({ id, runId, rating, categories, comment, createdAt })),
  };
}

export async function handleFeedbackRequest(request: Request, store: FeedbackStore): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  const respond = (body: unknown, status = 200) => Response.json(body, { status, headers });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, allow: "POST" } });
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) return respond({ error: "CROSS_ORIGIN_REQUEST" }, 403);
    if (!request.headers.get("content-type")?.includes("application/json")) return respond({ error: "JSON_REQUIRED" }, 415);
    // Bound the actual streamed body, including requests without Content-Length.
    const reader = request.body?.getReader();
    if (!reader) return respond({ error: "INVALID_FEEDBACK" }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); return respond({ error: "PAYLOAD_TOO_LARGE" }, 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return respond({ error: "INVALID_JSON" }, 400); }
    const input = parseFeedback(raw);
    if (!input) return respond({ error: "INVALID_FEEDBACK" }, 400);
    const { created } = await store.save({ ...input, createdAt: new Date().toISOString() });
    return respond({ id: input.id, saved: true, reused: !created }, created ? 201 : 200);
  } catch {
    // A failed durable write must never be reported as a successful submission.
    return respond({ error: "FEEDBACK_STORAGE_UNAVAILABLE" }, 503);
  }
}
