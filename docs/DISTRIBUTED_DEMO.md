# Isolated distributed demo: operator runbook

## Status and scope

The isolated demo is deployed and a **15-sample real distributed pilot** has been captured on 2026-09-23. Existing production services were preserved. Service: <http://127.0.0.1:35100>; separate performance monitor: <http://127.0.0.1:35200/distributed> (through the operator's local tunnel). Final delivery browser verification covered normal, backup-recovered and both-down journeys; it is tracked separately from benchmark evidence. All fixtures are public/synthetic; eight logical Agents retain their existing functional roles, not invented government departments.

Topology: Core on HPC; eight primary Edge services on ai-cloud; eight backups on mnckoren. Edge-VM was unreachable and excluded. A static backup repeats the same logical Agent with trusted node/replica/corpus/model identity: this is request re-execution, not VM or KV-cache migration. Core/gateway remain single points of failure; Core HA is out of scope. The operator now confirms ai-cloud is an allocated VM and mnckoren is a separately installed physical node. This is operator-confirmed physical separation, not independent machine/provider verification; no host reboot test was performed. The original campaign manifest physicalHostIndependenceVerified=false remains unchanged historical evidence; the later operator attestation is a separate receipt.

### Measured pilot, not a general performance claim

Evidence root: `outputs/distributed-demo-20260923/`. The preregistered v3 deployment is `isolated-demo-20260923-synth3b-v3`, using one fixed supported-source workload, two repeats per normal/fault scenario, concurrency one, plus one final cancellation. `campaign-v3/report.json` remains **partial**, with `stopReason: planned-final-cancellation`; cancellation confirmation, transport drainage and fault restoration are all true. This does not prove backend compute stopped. A dedicated model restart was recorded in `post-cancellation-demo-model-reset.json` before subsequent work.

| Scenario | Samples | Real-response availability | All-terminal p50 / p95 (seconds) | Target backup recovery |
| --- | ---: | ---: | ---: | ---: |
| Healthy, backup disabled | 2 | 2/2 | 13.152 / 15.050 | Not applicable |
| Healthy, backup enabled | 2 | 2/2 | 13.164 / 14.267 | Not applicable |
| Primary path unavailable | 2 | 2/2 | 1.029 / 1.050 | 2/2 |
| Primary inference unavailable | 2 | 2/2 | 0.995 / 1.005 | 2/2 |
| Backup unavailable | 2 | 2/2 | 14.052 / 15.411 | Not applicable |
| Both unavailable | 2 | 0/2; explicit partial | 0.840 / 0.880 | 0/2 |
| Restored primary | 2 | 2/2 | 12.981 / 13.994 | Not applicable |
| Planned final cancellation | 1 | Cancelled | 0.025 / 0.025 | Not applicable |

These are small, sequential pilot observations, not statistically reliable tail latency or throughput estimates. Fault recovery on the faster backup host is not evidence that failures improve performance. Successful scenarios have identical all-terminal and real-success latency distributions; both-down/cancellation have no real-success latency distribution.

Healthy baseline and backup-enabled cohorts each recorded 2,168 input / 504 output provider tokens across two samples. Primary-path and inference-fault cohorts each have the same **known subtotal**, but complete totals remain null because failed-attempt usage is unknown. Their prepared request bytes are 2,324 per cohort (versus 1,162 healthy); received response-body bytes are 7,501 and 7,831 respectively (healthy baseline 7,461, enabled 7,463). These are application-body measurements, not NIC traffic or wire-level transmission totals. Raw per-attempt accounting and coverage remain in the report/JSONL artifacts.

Additional live process tests are separate from that cohort: `actual-agent-stop.json` records two concurrent requests recovering after an actual dedicated primary Agent process stop; `actual-model-stop.json` records one recovery after the dedicated primary model process stopped. Combined with four controlled-fault recoveries, **7/7 refers only to technical backup availability, never semantic quality**. `production-preservation.json` records all 16 original service PIDs still alive; PID survival alone is not a complete production health audit.

### Quality boundary and delivery evidence

**The Edge qwen2.5:0.5b summaries failed semantic review by the automated operator inspection, including an invented one-year claim. Do not present them as factually validated.** The Core qwen2.5:3b final answers in all 12 successful same-fixture pilot samples contained the two supported source facts in that inspection. This is narrow fixture-specific evidence, not human quality approval or broad model validation. There has been no human quality review. BOTH-DOWN output is uncited and untrusted, even when the UI correctly labels the run degraded/partial; do not use that output as advice.

The pilot predates the final presentation-only citation-preservation fix. Original pilot artifacts retain that identity; provider requests/counters were unchanged by the later presentation fix. Earlier failed v1/v2 pilots are retained as `pilot-0.5b-quality-failed.json` and `pilot-v2-quality-failed.json`, not merged into v3.

Final delivery validation: 207/207 tests, Windows and Linux builds passed (`validation/full-tests-delivery.log`, `build-delivery.log`, `linux-build-delivery.log`); typecheck/lint logs are adjacent. Independent code review closed APPROVE and architecture review CLEAR. These checks validate implementation contracts, not semantic truth. Keep browser evidence and deployment manifests alongside the raw pilot, not as replacements for it.

## Private configuration files

Keep config files outside tracked/public directories, owner-readable only. Never commit tokens or TLS private keys. All scripts accept `--config PRIVATE_JSON`; errors and startup messages do not print configuration values. No additional dependency is required.

### TLS gateway (HPC)

```json
{
  "tls": { "certFile": "/absolute/demo/transport/gateway.crt", "keyFile": "/absolute/demo/transport/gateway.key" },
  "listenHost": "127.0.0.1", "port": 19443,
  "controlPort": 19444, "controlToken": "REPLACE_WITH_RANDOM_SECRET_AT_LEAST_16_CHARS",
  "faultsEnabled": true,
  "routes": [
    { "role": "primary", "agentId": "tech", "port": 25101, "token": "REPLACE_WITH_PRIMARY_AGENT_TOKEN" },
    { "role": "backup", "agentId": "tech", "port": 25201, "token": "REPLACE_WITH_BACKUP_AGENT_TOKEN" }
  ]
}
```

Add the same two entries for each deployed Agent using its dedicated tunnel port. The only accepted public route is `POST /<primary|backup>/<agent>/api/edge/agent`, with matching bearer and `x-edge-agent-id`. Upstreams are fixed loopback ports, never request-selected URLs. Trusted `x-edge-*` response identity headers pass through unchanged. Gateway body limits are64KiB request and256KiB response; redirects are not followed. Require normal TLS verification through `NODE_EXTRA_CA_CERTS`, never `NODE_TLS_REJECT_UNAUTHORIZED=0`.

Start: `node scripts/demo-gateway.mjs --config /private/gateway.json`.

Controls exist on a separate loopback listener: authenticated `GET /fault` and JSON `POST /fault` with `{ "scenario": "primary-down", "agentId": "all", "ttlMs": 180000 }`. Allowlisted scenarios: healthy, primary-down, backup-down, both-down. Agent can be all or one logical Agent. Maximum TTL300000ms; faults automatically restore. Faults are disabled unless explicitly enabled in the isolated config. Origin-bearing writes, arbitrary fields, process commands, PIDs and arbitrary targets are rejected.

### Inference dependency proxy (ai-cloud)

```json
{
  "listenHost": "127.0.0.1", "port": 13435, "upstreamPort": 13434,
  "controlToken": "REPLACE_WITH_RANDOM_SECRET_AT_LEAST_16_CHARS", "faultsEnabled": true
}
```

Start: `node scripts/demo-inference-proxy.mjs --config /private/inference-proxy.json`.

Point only the demo primary Edge instances at `http://127.0.0.1:13435`. `/api/chat` streams the real dedicated Ollama13434 response without fabricating tokens. `/api/version` and `/api/tags` remain available during faults. Authenticated `POST /__control` accepts only `{ "unavailable": true, "ttlMs": 180000 }`; `false` restores. Shared proxy admission allows at most one active upstream request; excess work receives typed503 rather than an unbounded queue. Fault503 uses the explicit `inference-unavailable` code. Edge itself stays alive. `/__health` requires the same bearer and returns active upstream request count.

Drain evidence means upstream transport closed, not proof that an inference backend has stopped all computation. Do not call `/api/ps` proof of active-compute status. Never stop shared model services for this demo.

### Core replica manifest

For each Agent configure `EDGE_AGENT_<ID>_BASE_URL`, `_TOKEN`, `_NODE_ID`, `_REPLICA_ID` and corresponding `_BACKUP_BASE_URL`, `_BACKUP_TOKEN`, `_BACKUP_NODE_ID`, `_BACKUP_REPLICA_ID`. Node IDs group shared inference capacity. Set `EDGE_EXPECTED_CORPUS_VERSION`, `EDGE_EXPECTED_MODEL_VERSION`, `DEMO_DEPLOYMENT_ID` and `DEMO_REQUIRE_LLM=true`. Edge identity comes from server `EDGE_NODE_ID`, `EDGE_REPLICA_ID`, `EDGE_CORPUS_VERSION`, `EDGE_MODEL_VERSION`.

`EDGE_AGENT_TIMEOUT_MS` is per-attempt budget including queue; `EDGE_AGENT_BUDGET_MS` is the logical Agent budget including both attempts. Service-wide `DEMO_RUN_TIMEOUT_MS` cannot exceed120000ms. The existing request contract caps each Agent request at120000ms. Primary reserves a backup window, and neither retry nor queue restarts the overall clock. No retries for caller cancellation, auth/policy/DLP/schema/identity/TLS/config failures or unknown HTTP503 errors.

Service35100: `DEMO_PROFILE=service` fixes normal inference and rejects judge/evaluation options. Operator35101: `DEMO_PROFILE=operator`, `DEMO_OPERATOR_TOKEN`. Optional baseline35102 uses a distinct instance with all BACKUP configuration omitted. Never turn backups off per public request.

## Reproducible campaign

```json
{
  "coreUrl": "http://127.0.0.1:35100", "profile": "service",
  "operatorToken": "REPLACE_WITH_OPERATOR_TOKEN",
  "telemetryToken": "REPLACE_WITH_MONITOR_SCRAPE_TOKEN",
  "baselineUrl": "http://127.0.0.1:35102", "baselineToken": "REPLACE_WITH_BASELINE_OPERATOR_TOKEN",
  "gatewayControlUrl": "http://127.0.0.1:19444", "gatewayControlToken": "REPLACE_WITH_GATEWAY_TOKEN",
  "inferenceControlUrl": "http://127.0.0.1:25199", "inferenceControlToken": "REPLACE_WITH_PROXY_TOKEN",
  "deploymentId": "isolated-demo-20260923", "modelVersion": "TRUSTED_MODEL_HASH", "corpusVersion": "TRUSTED_PUBLIC_CORPUS_HASH",
  "targetAgent": "tech", "faultAgentId": "all", "timeoutMs": 120000,
  "fixturesFile": "data/evaluation/distributed-demo-fixtures.json", "outputRoot": "outputs/distributed-demo"
}
```

Baseline telemetry is fetched from its own Core, retaining telemetry instance ID with each sample. Configure the same telemetry scrape token on benchmark Core instances or omit it only when their local telemetry endpoints genuinely need none. Service Core accepts normal proposed inference; it need not be an operator instance.

Run: `node scripts/benchmark-distributed-demo.mjs --config /private/benchmark.json --count 1 --repeats 3`.

Count1..3 selects public fixtures; repeats1..10; concurrency is deliberately1. The complete plan is capped at180 samples and an absolute two-hour admission/execution deadline. Expiry and SIGINT/SIGTERM stop admission, retain the active run ID, and use independent bounded cleanup: at most45seconds per sample shutdown phase and45seconds final campaign restoration. Cleanup is deliberately not aborted by the expired campaign signal. Caller cancellation executes only once, last. Scenarios are healthy backup-disabled, healthy backup-enabled, primary-down, inference-down, backup-down, both-down, restored-primary and caller-cancelled. Fault TTL refreshes for each sample, and final cleanup restores healthy routes/proxy. A missing separate baseline is reported skipped, not simulated. JSON/JSONL/CSV artifacts retain every outcome. Fixed seed, workload hash, nonsecret configuration hash, model/corpus versions and timestamps are preregistered in manifest.json before execution.

The harness starts async `/api/runs`, polls, explicitly DELETE-cancels on timeout, and waits for executionSettled plus scheduler active/queue counts zero and configured proxy activeRequests zero. An uncertain launch or unproved drain stops the campaign. ANY caller cancellation, physical timeout/interruption, or failed/unknown inference stage stops further samples even if backup succeeded and transports drained; preserve the measurement and require a verified demo-only runtime restart before a new campaign. Deliberate TTL fault rejections known not to enter inference are exempt. It does not claim backend compute cessation from transport drainage. Cancellation can therefore yield a partial report rather than unsafe continued testing.

## Reading results honestly

- Complete token totals stay null if any participating attempt has unknown usage. Known subtotals and coverage are separate. Failed/discarded attempts remain in cost accounting.
- Input/output tokens are provider counters; prepared request bytes are not proof of network delivery. Received response-body bytes exclude HTTP/TLS/NIC overhead.
- Complete payload-byte totals also remain null when any sample/attempt is missing byte observations; known byte subtotals and measured/unknown sample coverage are separate.
- Report all-terminal p50/p95 and real-success-only p50/p95 separately; failed, partial, cancelled and missing telemetry samples remain in denominators.
- Target-Agent backup recovery and whole-request success are distinct. A deterministic answer is not real LLM availability, and no-evidence policy outcomes do not trigger failover.
- Automated quality checks cover nonempty answers, citation existence/validity and expected-term diagnostics, not factual or semantic truth. Reports remain awaiting semantic review even when execution completes.
- Historical/mock runs never become fresh measurement evidence. Tooling tests explicitly use mocks and do not generate scored campaign artifacts.

## Demonstration order and completion evidence

1. Show service journey: public question, logical-Agent progress, answer and citations.
2. Open separate evaluation monitor and select the same run ID; show trusted node/replica, physical attempts, nullable token coverage and payload bytes.
3. Apply a TTL-bounded primary fault through the private controller; repeat fixture; show primary failure and same-Agent backup response on an independent path.
4. Apply inference-only fault; show Edge reachable but model dependency unavailable, then backup adoption.
5. Show both-down degradation without claiming success; restore primary and repeat.
6. Attach fresh benchmark artifacts and screenshots; state sample count, unknown costs, measured regressions and deployment limitations.

Cleanup only recorded demo-owned process IDs, directories, tunnels and ports after verifying ownership. Never issue blanket service kills, host reboot, firewall isolation or recursive deletion of shared runtime paths.


## Public-grounded synthesis revision

Isolated service/operator profiles feed Core synthesis the already-approved public `sanitized-preview` excerpts with exact evidence IDs, not Edge generated summaries treated as source facts. Internal/confidential/reference-only excerpts are excluded. All generated Edge notes are omitted, even when their referenced evidence is public, because summary classification can differ from reference classification. The transport disclosure policy is unchanged.

Demo synthesis asks for2-3 concise supported Korean points. `DEMO_SYNTHESIS_MAX_TOKENS` defaults384 and accepts only128..512; ordinary deployments retain the existing192-token integration budget. Model context remains4096. The campaign manifest and configuration hash include `synthesisModelVersion` and `synthesisMaxTokens`, separate from the Edge-pair model version. Retain the original poor0.5B pilot as diagnostic evidence; evaluate the isolated3B synthesis revision under a distinct deployment/campaign identity. Automated tests prove privacy filtering, prompt configuration and provenance, not semantic quality of actual model responses.


### V3 fixed supported-source workload

The first fixture now asks only about Parsing, chunking, embedding and search API components in the already-approved public2026.5 AI adoption guide excerpt. Its semantic rubric forbids unsupported numbers and backup guarantees and requires exact source citations. It does not ask the model to invent a recovery guarantee absent from its sources. This query change creates a new workload hash and requires a distinct v3 campaign identity; prior v1/v2 poor responses remain diagnostic artifacts, never overwritten or merged into the new cohort.

Demo synthesis includes at most4 already-approved public preview chunks and up to800 JavaScript text characters per chunk, preserving the complete approximately600-character supported excerpt. It does not request new source disclosure or increase restricted access. Ordinary non-demo input remains capped at250characters per chunk with its existing chunk-count behavior. Model context4096 and synthesis output default384 (bounded128..512) remain unchanged.

Final demo citation validation accepts only the exact public IDs within the4-chunk supplied prompt budget. It removes out-of-set citations without inventing replacements; a citation-free insufficient-evidence response remains citation-free, including when zero public snippets are eligible. Per-Agent legacy citation behavior outside the demo synthesis boundary is unchanged.

The final presentation-only citation correction also preserves the Core report section's original citation choices in demo mode; it no longer appends the first public ID to a citation-free insufficiency response. Ordinary report assembly remains unchanged. Measurements already captured before this presentation-only correction must retain their original artifact/build identity; do not relabel them as measured against the later build. The correction changes neither model requests nor provider counters.

## Existing deployment startup and safe teardown

Final delivery browser verification covered normal, backup-recovered and both-down journeys on the same delivered artifact. These browser checks remain separate from the pilot measurements.

Each host uses `$HOME/axnetcc-demo-20260923`, with `release/`, private `shared/config/`, and `shared/<name>-process.json` ownership records. There is no deployed launcher file: deployment used an inline Python loader merging the selected JSON environment into `os.environ`, then `subprocess.Popen(..., cwd=release)`, retaining the resulting PID, arguments and `ownedRoot`. Never print the environment or start a duplicate listener. `runtime/` links to an existing read-only runtime; HPC also has a read-only dependency symlink. Do not build in place on HPC or modify either shared target.

With `ROOT=$HOME/axnetcc-demo-20260923` and `NODE=$ROOT/runtime/node-v24.20.0-linux-x64/bin/node`, the existing commands are:

```sh
# App: first load its existing private JSON environment via the Python loader.
"$NODE" "$ROOT/release/node_modules/vinext/dist/cli.js" start --hostname 127.0.0.1 --port 35100
# Monitor: load shared/config/monitor.json first.
"$NODE" --experimental-strip-types "$ROOT/release/monitor/server.mjs"
# Gateway on HPC; proxy on ai-cloud:
"$NODE" "$ROOT/release/scripts/demo-gateway.mjs" --config "$ROOT/shared/config/gateway.json"
"$NODE" "$ROOT/release/scripts/demo-inference-proxy.mjs" --config "$ROOT/shared/config/inference-proxy.json"
```

App role/config/port pairs: HPC `service.json`/35100, `operator.json`/35101, `baseline.json`/35102; ai-cloud `edge-<agent>.json`/5101..5108; mnckoren `edge-<agent>.json`/5201..5208. Preserve the existing Agent-to-port mapping in private config, not a newly inferred ordering. Monitor port is 35200. All app/monitor cwd values are `release`.

Dedicated Ollama runs from `ROOT` with `OLLAMA_MODELS=$ROOT/models`, `OLLAMA_HOST=127.0.0.1:13434`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_MAX_QUEUE=8`, and `HOME=$ROOT/shared/model-home`, using `$ROOT/runtime/ollama-0.33.3/bin/ollama serve`. Record PID/cwd/scope in `shared/model-process.json`. Never stop or reconfigure shared inference port 12434.

HPC uses exact demo SSH master sockets `transport/ai.sock` and `transport/hub.sock`, verified known-host records and no persistent SSH credentials. Existing forwards are 25101..25108 to primary 5101..5108, 25201..25208 to backup 5201..5208, and 25199 to primary proxy 13435. Keep SSH trust verification enabled. The existing local UI helper is `outputs/distributed-demo-20260923/open-demo-ui.py`.

### Restore controls without exposing credentials

Read the controller token from its existing private config in memory; never print or paste it into public artifacts. On HPC send authenticated JSON `POST http://127.0.0.1:19444/fault` with `{"scenario":"healthy","agentId":"all","ttlMs":1000}` using `shared/config/gateway.json`. On ai-cloud send authenticated JSON `POST http://127.0.0.1:13435/__control` with `{"unavailable":false,"ttlMs":1000}` using `shared/config/inference-proxy.json`. Require HTTP 200, then verify authenticated controller GET state, Core health and proxy health. TTL expiry is a safeguard, not a substitute for checking restoration.

### Safe demo-only PID stop/restart

1. Stop campaign admission, DELETE-cancel the known active run through its own Core, and wait for executor settlement, zero scheduler active/queued work and zero proxy active transports. Transport drainage is not proof of compute cessation; ambiguous cancellation requires a verified dedicated-model restart before another campaign.
2. Restore both controllers and preserve raw artifacts.
3. Before signalling each exact recorded PID, verify `/proc/<pid>/cwd`, complete `/proc/<pid>/cmdline`, owner UID, process start time and expected port against its demo role and resolved demo root. Shared executable identity alone is insufficient. If PID reuse or scope cannot be ruled out, do not signal it. Historical records are not perpetual kill authorization.
4. Only after verifying identity, send SIGTERM to that exact demo-owned PID and wait for exit. No blanket process kills, host reboot, broad firewall isolation or deletion of shared directories/symlink targets. Verify dedicated ports closed and original service PIDs still alive.
5. Close only the verified demo SSH masters using their exact socket paths after dependent apps stop. Preserve unrelated sessions. Restart only the stopped role with its existing config, refresh its process record and recheck health/identity. Never use stale report PIDs as a stop list.


## Post-pilot fail-closed correction: no public evidence

The original v3 BOTH-DOWN uncited outputs remain failed historical semantic evidence. They have not been relabelled or overwritten. A subsequent bounded correction now skips Core synthesis entirely in isolated service/operator profiles when no approved public previews are available, including successful Edge responses that provide only restricted references. It returns an explicit deterministic evidence-insufficient answer, with no fabricated synthesis attempt or token counters. Planned synthesis tasks become skipped/terminal; actual failed or successful Edge provider usage remains in the attempt ledger. Final-answer provenance is deterministic and degraded (partial when Edge work otherwise completes), not real-LLM answer availability. Ordinary deployment synthesis behavior is preserved.

Final correction validation passed: 212/212 full tests, lint/typecheck, and Windows/Linux builds (validation/*final-closure.log). Independent no-evidence closure review APPROVE and corrected architecture review CLEAR cover this delta. Fresh live runs confirm healthy RUN-0618E8D6-161 and backup-recovered RUN-A1F7CC5A-2D0 completed; BOTH-DOWN RUN-242AAC6B-544 failed with deterministic evidence insufficiency, zero synthesis attempts and zero remaining tasks. Fault controls were restored healthy. This does not complete overall semantic acceptance or A2: Edge 0.5B semantic quality remains unresolved, and physical separation is operator-confirmed rather than independently verified. No new model-quality claim follows from suppressing unsupported synthesis.


### Final closure evidence and remaining WATCH

The corrected architecture review additionally ran 54 focused tests, ordinary parallel/managed direct checks and four no-evidence variants. Independent closure evidence is `.omx/plans/distributed-demo-no-evidence-closure-review.txt`. Preserve earlier pilot and review artifacts as historical rather than replacing their results with the corrected-build outcome.

Two additional query extensions failed semantic checks in the delivery audit. Model-quality status therefore remains **WATCH**, even though failover and the no-evidence guard are technically verified. The narrow original fixed-fixture final-answer result is not evidence of general answer quality. Physical separation is operator-attested, not independently machine/provider verified; no host reboot test was performed.

The local PC UI tunnel disconnected once and was restored with auto-reconnect; server execution was unaffected. At handoff, the helper is a tool-managed foreground process (session 82436, PID 2320); the helper pidfile is the current operational record, not those historical numeric identifiers. Revalidate its identity before any stop/restart. Local tunnel continuity is separate from server availability and is not a permanent service/SLA guarantee.
