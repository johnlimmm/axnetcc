const agents = [
  "tech",
  "data",
  "security",
  "legal",
  "policy",
  "finance",
  "procurement",
  "operations",
];

const defaultBaseUrl = process.env.LOCAL_LLM_BASE_URL ?? "http://127.0.0.1:11434";
const defaultModel = process.env.LOCAL_LLM_MODEL ?? "qwen2.5:3b";

function setting(agent, suffix, fallback) {
  return process.env[`LOCAL_LLM_${agent.toUpperCase()}_${suffix}`] ?? fallback;
}

const endpoints = [...new Set(agents.map((agent) => setting(agent, "BASE_URL", defaultBaseUrl)))];
const endpointStatus = new Map();

for (const endpoint of endpoints) {
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, "")}/api/tags`);
    const payload = await response.json();
    endpointStatus.set(endpoint, {
      ok: response.ok,
      models: (payload.models ?? []).map((item) => item.name),
    });
  } catch (error) {
    endpointStatus.set(endpoint, {
      ok: false,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

let failed = false;
for (const agent of agents) {
  const endpoint = setting(agent, "BASE_URL", defaultBaseUrl);
  const model = setting(agent, "MODEL", defaultModel);
  const status = endpointStatus.get(endpoint);
  const modelAvailable = status?.models.some(
    (name) => name === model || name.startsWith(`${model}:`),
  );
  const ok = Boolean(status?.ok && modelAvailable);
  failed ||= !ok;
  console.log(
    `${ok ? "OK" : "FAIL"} ${agent.padEnd(11)} ${model.padEnd(14)} ${endpoint}`,
  );
}

if (failed) process.exitCode = 1;
