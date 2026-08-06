# AXNetCC-SAEA paper-readiness audit

## Evidence tiers

1. **SAEA main systems experiment**: the existing six-query golden set, fixed golden roles, actual localhost HTTP Evidence Gateway/proxy, six network scenarios, three synthetic security-profile seeds, and 30 repetitions. This supports systems feasibility and within-set paired effects, not broad task generalization.
2. **Router secondary experiment**: the existing 40 author-labelled queries with semantic-family-grouped 5-fold evaluation. This separates routing quality from evidence acquisition and includes repository adapters for MasRouter, RouteLLM-MF, and IRT-Router.
3. **Provisional stress set**: the existing 240 LLM-adjudicated items. Every item is currently marked `eligible_for_confirmatory_test: false`; it may be used for engineering stress tests but not described as an independent human-labelled confirmatory set.

No raw dataset is rewritten. Role-specific required concepts for the six-query set are fixed in the derived security manifest before the full run.

## Baseline provenance

- MasRouter: ACL 2025 paper and official repository commit are recorded in `data/evaluation/baseline-provenance.json`. The repository adapter preserves agent-count and role-allocation structure but does not reproduce the upstream VAE/RL checkpoint.
- RouteLLM-MF: the official RouteLLM matrix-factorization structure is mapped to expert-role preference learning. This is a task adapter, not an upstream benchmark reproduction.
- IRT-Router: the ACL 2025 MIRT/2PL structure is mapped from model ability to role ability. This is a task adapter, not the upstream 20-model/12-dataset result.
- Centralized, all-agent parallel, MASRouter-inspired, RemoteRAG-inspired, and PGRF rows are repository architecture baselines. Inspired adapters and exact upstream reproductions must remain visually separated in paper tables.
- Later work such as STRMAC/Optimal-Agent-Selection and RCR-Router is relevant related work, but is not promoted to an experimental baseline without a commensurate fixed-department/evidence-boundary implementation and reproducible training protocol.

Primary sources: [MasRouter, ACL 2025](https://aclanthology.org/2025.acl-long.757/), [IRT-Router, ACL 2025](https://aclanthology.org/2025.acl-long.761/), [RopMura preprint](https://arxiv.org/abs/2501.07813), [STRMAC preprint](https://arxiv.org/abs/2511.02200), and [RCR-Router preprint](https://arxiv.org/abs/2508.04903).

## Corrected validity defects

- Removed execution-time dropping of required concepts. The derived query-role concept map is now fixed in `data/security-evidence-manifest.json`.
- Replaced the hard-coded 0.70 completion check with each role's configured coverage threshold.
- Replaced the prior `oracle-feasible` approximation with offline trials of all four modes over the actual HTTP path, followed by selection among observed feasible outcomes.
- Replaced the latency “P95 proxy” (mean elapsed time) with a per-query empirical P95 before paired query-cluster comparison.
- Added exact paired sign-flip tests for the six-query main set and Holm adjustment across baselines per metric.
- Added query-weighted `method-summary.csv`; trace count is never treated as independent sample size.
- Added bounded concurrency and recorded it in `experiment-config.json`. Concurrency is an execution control, not a sample-size multiplier.

## Accepted runs and recovery audit

- Main accepted run: `paper-full-v4-20260806` — 24,624 jobs, 49,248 finalized role traces, six queries, 30 repetitions, three profiles, and zero final transport-599 traces. `INTEGRITY_REPORT.json` passes with no failures.
- Broader validation run: `paper-validation-40-20260806` — 5,040 jobs, 12,222 finalized role traces, 40 author-labelled queries, one repetition, three profiles, and zero final transport-599 traces. `INTEGRITY_REPORT.json` passes with no failures.
- Forced time limits exposed a two-file checkpoint journal window: trace rows could be appended immediately before termination while their completed-job keys were not. Finalization now keeps the last observation for each deterministic trace ID. The append-only checkpoint is retained and `RESUME_DEDUPLICATION_AUDIT.json` records the transformation.
- Jobs with a final status 599 after all retries were rerun as complete job units. The pre-recovery completed-job list and `TRANSPORT_RECOVERY_AUDIT.json` preserve the recovery trail; final accepted traces contain zero status 599 outcomes.
- `paper-full-20260806`, `paper-full-v2-20260806`, and `paper-full-v3-20260806` remain explicitly rejected pilots because of, respectively, security-profile/evaluation defects, host/socket overload at concurrency 48, and repeated retry seeds. They are not used in paper tables.

## Observed claim boundary

In the six-query main run, AXNetCC-SAEA has zero policy violations, 0.860 required-role completion, and 115.329 mean raw cross-boundary bytes; raw-central has 0.923 policy-violation rate, 0.997 completion, and 3357.199 raw bytes. Fixed-sanitized has zero violations, 0.859 completion, and zero raw bytes. No main-study paired comparison remains significant after Holm adjustment.

In the 40-query validation, AXNetCC-SAEA has zero policy violations, 0.723 completion, and 276.167 raw bytes; fixed-sanitized has zero violations, 0.739 completion, and zero raw bytes. The broader run therefore supports a security/utility trade-off characterization, not a universal quality or disclosure optimum. The task-adapted MasRouter, RouteLLM-MF, and IRT-Router rows remain a separate routing study and are not mixed into this acquisition ranking.

## Remaining external blocker

A blind cross-family check was completed over the same 40 semantic-family candidates using Qwen 2.5 3B, Llama 3.1 8B, Gemma 3 4B, and the configured `gpt-5.4-mini-2026-03-17` OpenAI judge. All 160 finalized labels were valid. Local three-way exact agreement was 0, local mean pairwise Jaccard was 0.267, and local macro Fleiss' κ was 0.041. OpenAI versus author-provisional labels reached micro-F1 0.815, but OpenAI versus local consensus reached only 0.586 and four-model macro Fleiss' κ was 0.123. This result strengthens the audit trail but does not establish an independent gold set; it demonstrates model-family and fan-out sensitivity.

The 240-item set still needs a more reliable reference process before it can be called confirmatory. Options include independent domain review or a preregistered panel of stronger, cross-provider models with calibrated examples and disagreement adjudication. Until then, the defensible paper claim is a systems/feasibility claim with transparent label uncertainty, not universal superiority.
