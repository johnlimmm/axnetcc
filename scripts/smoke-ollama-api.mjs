const model = process.argv[2] ?? "qwen2.5:3b";
const started = performance.now();
const response = await fetch("http://127.0.0.1:11434/api/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  signal: AbortSignal.timeout(180000),
  body: JSON.stringify({
    model,
    stream: false,
    format: "json",
    messages: [{ role: "user", content: "Return JSON only with expected_agents (1-4 values from tech, security, legal) and confidence (0-1). Query: Design a secure public AI citizen service." }],
    options: { temperature: 0, num_ctx: 1024, num_predict: 100 },
  }),
});
if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
const payload = await response.json();
console.log(JSON.stringify({ model, elapsedMs: Number((performance.now() - started).toFixed(1)), content: payload.message?.content, evalCount: payload.eval_count, totalDuration: payload.total_duration }, null, 2));
