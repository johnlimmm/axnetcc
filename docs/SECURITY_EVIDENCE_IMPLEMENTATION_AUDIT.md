# AXNetCC-SAEA implementation audit

Audit date: 2026-08-06 (Asia/Seoul)

## Repository state

- Repository: the existing `platform` worktree (no clone performed)
- Branch: `main`
- Base HEAD: `7cd8894170172ceec58de74d6d16a450f2902170`
- The worktree already contains user-owned modified and untracked files. They will be preserved. In particular, the in-progress boundary router/orchestrator and evaluation assets are treated as reusable work, not replaced.

## Reusable existing assets

- `lib/knowledge.ts`: eight fixed department roles, role profiles, RAG scopes, and synthetic internal knowledge chunks.
- `lib/rag.ts`: canonical `data/rag-corpus.json` loader, NFKC normalization, Korean word segmentation, character bigrams, query expansion, BM25 retrieval, and lexical reranking.
- `lib/boundary-router.ts`: in-progress Role-Concept/boundary-aware role selection (PGRF-equivalent routing input for this feature).
- `lib/orchestrator.ts` and `app/api/orchestrate/route.ts`: existing modes and request path; defaults must remain unchanged.
- `data/rag-corpus.json` and `data/manifest.jsonl`: canonical public corpus and provenance manifest.
- `data/evaluation/golden-set.jsonl`, `ax-golden-set-40.jsonl`, adjudicated/candidate sets, and existing result reports: reusable evaluation assets. They remain read-only.
- `scripts/evaluate-*.mjs`, `repeat-benchmark.mjs`, and statistical validity reports: reusable experiment/report conventions and statistical context.
- `tests/orchestrator.test.mjs`: existing regression suite and golden-set checks.
- Existing user changes add routing boundaries, minimal agent outputs, boundary byte accounting, and latency distributions. SAEA will compose with these rather than duplicate them.

## Already implemented

- Eight unique department agents and department-specific RAG scopes.
- Canonical corpus retrieval with NFKC, word tokens, character bigrams, and aliases/query expansion.
- Existing role routing and orchestration modes, evidence IDs, citations, byte estimates, and latency metrics.
- Golden/candidate/adjudicated evaluation datasets and several prior statistical reports.
- Basic confidentiality classes (`public`, `internal`, `confidential`) in synthetic knowledge and per-agent access classes.

## Missing functionality

- No four-mode evidence transformer (`raw`, `sanitized`, `local-summary`, `metadata-only`).
- No explicit cross-department hard policy matrix including `personal`.
- No derived per-document security/canonical/concept manifest.
- No coverage gate over transformed evidence with per-role thresholds.
- No SAEA lexicographic planner, required traces, infeasibility escalation, baselines, oracle, or ablations.
- No real HTTP evidence gateways or application-layer seeded network proxy.
- No security-evidence experiment runner, query-cluster paired bootstrap, required CSV/JSONL outputs, or claim-boundary report.
- No `/api/evidence/plan` endpoint and no optional SAEA integration preserving legacy defaults.
- No policy/transformation/coverage/planner/gateway/proxy/legacy regression tests for this feature.

## Planned changes

- Add a derived security manifest and configuration without editing corpus or evaluation sources.
- Add focused policy, transformation, coverage, planner, and runtime modules under `lib/`.
- Add `/api/evidence/plan`; extend orchestration only behind optional `evidenceStrategy` and `securityEmulation` fields, preserving `legacy`/`false` defaults.
- Add fixed-port department gateways plus a seeded application-layer proxy and supervisor under `emulation/`.
- Add an experiment runner/analyzer that reuses the golden set, sends actual HTTP requests, records raw request-level traces, performs all methods/scenarios/ablations, and computes query-cluster paired bootstrap intervals.
- Add required documentation and tests, then run lint, test, build, and a practical real-HTTP experiment. Full 30-repetition execution remains available; a quick run may be used for validation when runtime is material.

## Deliberately not duplicated or modified

- No repository clone, corpus rebuild, raw-data rewrite, or evaluation-set overwrite.
- No second role router, RAG engine, canonical corpus, or golden set.
- No agent placement, migration, or replica-selection algorithm.
- No packet-level/netem dependency; the default is reproducible application-layer emulation.
- No production policy bypass and no oracle selection in runtime APIs.

## Compatibility risks and mitigations

- Existing user edits overlap orchestration and tests: integrate additively and retain old defaults and response fields.
- Corpus and golden files are valid UTF-8. Some Windows console rendering paths display mojibake, so byte-level validation—not terminal appearance—is authoritative. Concept matching uses NFKC, existing tokenization, and a derived semantic alias map without rewriting source files.
- HTTP timing varies by host load: seeded injected delay is reproducible, while observed elapsed time is reported separately and not claimed as physical-network measurement.
- Synthetic security labels are not verified source classifications: every derived record and report declares `syntheticProfile: true`.
