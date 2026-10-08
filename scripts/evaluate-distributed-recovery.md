# Distributed recovery evaluator

The runner measures the preregistered **16 questions (2 per functional role) x 7 conditions = 112 requests**, with three closed-loop clients. It reuses the healthy evaluator's submission/SSE/client clock, concurrency and accounting-finalization paths; it does not change runtime or author questions/grades.

```text
node scripts/evaluate-distributed-recovery.mjs --manifest <manifest.json> --config <absolute-private-config.json> --budget <shared-budget.json> --output <new-directory>
```

Exit 0 means only `measured-awaiting-semantic-review`, never completed acceptance. Failed/interrupted/control-error campaigns exit 1. New directories are required; no merge, resume, request retry or best-of selection. Existing healthy evaluator and old benchmark are unchanged.

## Manifest

`schemaVersion:"distributed-recovery/v1"`, `deploymentId`, integer `seed`, past ISO `frozenAt`, `concurrency:3`, `maximumRequests:112`, `deadlineMs:60000`.

`scenarios` is exactly this order:
1. `healthy-backup-disabled`
2. `healthy-backup-enabled`
3. `primary-down`
4. `inference-down`
5. `backup-down`
6. `both-down`
7. `restored-primary`

`cases`: exactly 16 distinct `{id,role,query}`, two per tech/data/security/legal/policy/finance/procurement/operations. These are independently preregistered representative questions, not the final 40+10 cohort. Do not import expected passages or fixture IDs into runtime. `workloadHash` is SHA256 of `JSON.stringify(cases)`. Every scenario uses the same order sorted by SHA256 of `seed:caseId`.

`coreNode` is an explicit identifier; `topology` has eight `{role,primaryNode,backupNode}` entries. Use actual configured attempt node IDs, never hardcoded old host assignments. Primary and backup IDs must differ. Source/corpus/policy/model/physical placement claims still require separate deployment receipts; this runner does not prove physical machine independence.

`configurationHash` is SHA256 of `JSON.stringify(config.frozenConfiguration)`; `artifacts` contains `{path,sha256}` exported source/build/corpus/model/config receipts, byte-checked relative to the manifest before network access. Operator remains responsible for ensuring the live revision matches these receipts.

## Private config and shared campaign budget

Same private fields as healthy completion runner: `coreUrl`, `operatorToken`, `gatewayControlUrl`, `gatewayControlToken`, `inferenceControlUrl`, `inferenceControlToken`, optional `telemetryToken`, `frozenConfiguration`. Additionally **required** `baselineUrl`, `baselineToken`; optional `baselineTelemetryToken`. Baseline endpoint must actually have backup disabled in its frozen deployment configuration; URL alone cannot prove that setting. HTTPS except loopback; no embedded credentials/query/fragment, redirects or public fault exposure. `faultAgentId` must be absent or `all`.

Budget file:
```json
{"campaignId":"shared-run-id","startedAtMs":0,"usedRequests":50,"maximumRequests":180,"maximumWallMs":7200000}
```
Replace zero with the actual shared campaign start epoch milliseconds, not a new start for this runner. `usedRequests + 112` must be <=180; shared elapsed time must remain <2h. Healthy50 + recovery112 leaves18 for the preregistered cold/cancellation/actual-stop probes. Root owns the shared reservation ledger and sequential execution; this runner is not a cross-process concurrent budget lock. Do not run parallel campaign tools against the same remaining allowance. After a partial run, preserve its `usedRequestsAfter`; do not reset the budget or silently resume.

## Fault lease and residual-compute safety

Only existing authenticated, bounded dedicated controls are used. POST gateway `/fault` with `{scenario,agentId:"all",ttlMs:180000}` and inference `/__control` with `{unavailable,ttlMs:180000}`; validate exact acknowledgment and expiry. Renew the **same** scenario every60s while requests remain pending. Renewal must acknowledge before the old lease expires; stop on failure/gap, insufficient lease at admission, external interrupt or shared wall deadline. Await any in-flight renewal before switching conditions/restoring healthy.

A controlled-failure exemption needs exact scenario, authenticated continuous lease covering submission/observation **and every attempt timestamp**, trusted role/node, failed status, null model backend/counters, and exact typed rejection:
- `edge-unavailable` only for the affected primary/backup/both route.
- `inference-unavailable` only for primary while inference-only fault is active.

Separately, a trusted Edge attempt with `status:"failed"`, `adopted:false`, `backend:"ollama"`, exact `reasonCode:"inference-invalid"`, and strict boolean `providerFinalObserved:true` proves provider completion even though its answer is invalid. It still requires the existing topology/timestamp/lease checks. A Core per-call `backend:"deterministic"`, `status:"failed"`, exact `failureCode:"invalid-response"`, and strict boolean completion proof receives the same narrow exemption. Finalization proof means a clean provider stream ending, not valid or semantically correct content; these answers remain failures, never adopted or promoted to quality successes. Token counters alone, absent/false/string proof, cancellation, accounting-incomplete ledgers, and any other uncertain attempt/call remain unsafe. Legacy aggregate stages do not receive this exemption.

No generic HTTP/403/policy/connection/timeout exemption. A successful backup cannot erase unknown primary compute. The wrapper defers only the healthy helper's residual-policy callback long enough to examine the returned attempts; all other callbacks halt immediately. It records `healthyPolicyComputeCompletionProven` and `scenarioResidualPolicyApplied` explicitly, plus the scenario-aware proof. Unknown risk halts all clients before additional snapshot collection. No inference of backend termination from transport drain or `/api/ps`.

Final accounting re-reads late ledgers and settled snapshots without altering client timing/transcripts. Initially uncertain compute is never upgraded. Unknown/missing final counters remain null, known subtotals retained. Final healthy restoration/cancellation uses the existing independent bounded cleanup path; failures remain explicit. Actual owned process stops, cold starts and cancellation probe scheduling are **not implemented here** and require separate receipts.

## Output and remaining review

- Frozen `manifest.json`, shared `budget.json`.
- Append-only `samples.jsonl`, `samples-final.jsonl`, `fault-receipts.jsonl`, hash-bound by `report.json`.
- Per-scenario planned denominator16, counts, all-terminal and successful real-inference p50/p95, recovery counts, no-synthesis both-down check, nullable/full/known costs; raw transcripts and attempts remain available. Body byte fields retain original prepared/received semantics, not NIC traffic.
- `status:"measured-awaiting-semantic-review"` is collection status, not semantic or availability success. Failed requests remain present; there is no extra 16/16 semantic gate and no silent 60s failover SLA claim. Independent review must inspect Q3 across all visible transcripts and scenario recovery evidence.
- `fullCompletionProven:false` always. Independent semantic review, owned Agent/model stop receipts, cold/cancellation probes, browser and final reviews remain required.

Tests are dependency-injected local mocks only; they do not claim actual fault injection or remote restoration.

## Hybrid rendering configuration evidence

Optional `renderingConfiguration:{"edge":"model-guided-extractive","core":"source-grounded-generation"}` must match in the public frozen manifest and private `frozenConfiguration`. Each value is one of those two modes or null; missing legacy values remain null. Malformed declarations or configuration/sample binding mismatches fail validation. This is configuration evidence, not per-call observation; matching primary/backup Edge replicas requires independent deployment configuration receipts. Never infer Edge mode from the final answer.

`answerRendering` and generated/extractive outcome counts retain their **final answer only** meaning; an explicit Core declaration must agree with `answerRendering`. Samples, report summary and sanitized monitor projection expose the separate Edge/Core declaration without promoting quality, semantic correctness or overall completion.
