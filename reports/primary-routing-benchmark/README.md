# Primary-Agent Routing Benchmark

This report compares four routing techniques on the repository's 40-query AX golden set. The proposed method's quality metrics come from actual built application execution; its JavaScript routing mirror must match every final `routerDecision.selected` before this report is written.

Generated: `2026-08-07T10:21:22.575Z`

Dataset: `data/evaluation/ax-golden-set-40.jsonl` (SHA-256 `16612553e21258e0749b4c5d6c5f551e3b159042fabc4ad7afa654b2ee57ffdc`, 40 cases)

## Results

| Method | Macro F1 | Exact match | Critical-role recall | Primary in expected set* | Avg fan-out | Routing-policy CPU median (us/query) |
|---|---:|---:|---:|---:|---:|---:|
| Keyword top-1 | 35.7% | 5.0% | 22.7% | 57.5% | 1.00 | 13.60 |
| Keyword fan-out | 64.6% | 20.0% | 88.6% | 57.5% | 3.33 | 14.62 |
| v2 boundary heuristic | 66.2% | 22.5% | 90.9% | 77.5% | 3.30 | 28.97 |
| Proposed adaptive hybrid | 96.8% | 85.0% | 100.0% | 97.5% | 2.58 | 3826.99 |

*The dataset has no separately adjudicated primary label. "Primary in expected set" is therefore the primary-accuracy proxy.

On this fixed development set, the highest Macro F1 is **Proposed adaptive hybrid** (96.8%), while the lowest average fan-out is **Keyword top-1** (1.00).

The proposed adaptive hybrid passed the repository regression gates and its mirror matched the built proposed runtime on 40/40 cases. Its measured result is Macro F1 96.8%, Exact Match 85.0%, Primary-in-Expected 97.5%, Critical-role Recall 100.0%, and fan-out 2.58.

## Methods

- **Keyword top-1:** Selects only the Agent with the largest exact keyword-overlap count.
- **Keyword fan-out:** Reproduces the pre-MNC-16 route: call every Agent with at least one keyword hit.
- **v2 boundary heuristic:** Standalone reconstruction of teamlead/v2 coverage/cost and coupled-domain routing.
- **Proposed adaptive hybrid:** Current proposed-mode hybrid-profile-v1 primary selection plus post-primary missing-concept additions.

## Selected-set contract

All set metrics use the final deduplicated Agent IDs returned by each method, including its primary. Every method receives the same application-sanitized query. No method sees golden labels while routing, and the proposed method uses the application's normal proposed-mode request path.

- **Keyword top-1:** A singleton containing the highest exact substring-keyword score; agentOrder breaks ties and tech is the zero-hit fallback.
- **Keyword fan-out:** Every Agent whose exact substring-keyword score is greater than zero; tech is selected only when no Agent has a hit.
- **v2 boundary heuristic:** The ordered subset of keyword/coupling-required Agents that passes v2 class allowance and is retained by its utility/coverage loop, capped by maxAgents; tech is the empty-set fallback.
- **Proposed adaptive hybrid:** The actual final result.routerDecision.selected from proposed orchestration: the hybrid-profile-v1 primary, then mandatory reviewers and candidate owners of concepts still uncovered by the primary Edge response.

## Metric definitions

- **Macro F1:** unweighted mean of per-query set F1 over predicted versus `expected_agents`.
- **Exact match:** percentage of queries where the predicted Agent set exactly equals `expected_agents`.
- **Critical-role recall:** micro recall restricted to expected `security`, `legal`, `procurement`, and `finance` roles, matching the repository's routing-v2 evaluator.
- **Primary in expected set:** percentage where the selected primary belongs to `expected_agents`; this is a membership proxy, not a uniquely adjudicated primary label.
- **Average fan-out:** mean number of final selected Agents per query, including the primary and adaptive additions.
- **Routing-policy CPU decision time:** median batch-amortized CPU time across 5 rounds of 50 repetitions of all 40 queries. Baselines time only their route function. The proposed method times its exact JS mirror of initial routing plus adaptive selection with the already-computed primary coverage supplied as input. All figures exclude orchestration, Edge retrieval, RAG, LLM, network, and process startup.

## Artifacts

- `routing-benchmark-results.json`: provenance, parity gate, acceptance gates, summary metrics, timing configuration, and every prediction.
- `routing-benchmark-summary.csv`: chart-ready aggregate data table.
- `routing-benchmark-per-query.csv`: raw per-query predictions and set-scoring components.
- `routing-quality.png`: quality comparison with a 0-100% baseline and direct labels.
- `routing-efficiency.png`: fan-out and routing-policy CPU comparison with zero baselines and direct labels.

## Chart descriptions (text alternative)

- **Quality chart:** four horizontal-bar panels compare all methods on a common 0-100% scale. Highest values are Macro F1 Proposed adaptive hybrid (96.8%), Exact Match Proposed adaptive hybrid (85.0%), Critical-role Recall Proposed adaptive hybrid (100.0%), and Primary-in-Expected Proposed adaptive hybrid (97.5%).
- **Efficiency chart:** two zero-baseline panels compare average selected Agents and routing-policy CPU median. Lowest fan-out is Keyword top-1 (1.00 Agents/query); lowest measured routing-policy median is Keyword top-1 (13.60 us/query).

## Caveats

- This is a **development-set diagnostic**, not an independent or held-out evaluation. The rule taxonomy and the 40-query fixture come from the same project and may overstate generalization.
- The golden set labels only a relevant Agent set, so primary accuracy is evaluated as set membership rather than equality to a unique ground-truth lead.
- The v2 method is a standalone reconstruction of the routing logic at `21db814eabebe342173a90558fa25a038a5d55fd`; it does not execute the full v2 application.
- Proposed quality predictions come from the built deterministic proposed-mode orchestrator (bundle SHA-256 `1a27045b19f9eabb92d67563d2da21115e78645a5ef6ce4bbd40013e16e40a46`). The JS mirror of current `lib/boundary-router.ts` (source SHA-256 `10cdf7a7584fcd8bb11a7d42c547977fc083d52b8bc5073cf8415455bb13b12c`) is separately asserted against its primary, candidates, required roles, scores, adaptive additions, and final selected set.
- The proposed CPU timing receives primary evidence coverage as a precomputed input. Producing that coverage is outside the routing timer. The actual full deterministic orchestration median (97.0 ms) is recorded separately and is not compared in the CPU chart.
- CPU timings are machine- and runtime-dependent microbenchmarks. They support relative routing-policy comparison here, not end-to-end service latency claims.
- No uncertainty interval is reported because this is one fixed 40-query set. Repeated or cross-validated evaluation is required before making population-level claims.
- Exact match assumes `expected_agents` is complete; extra defensible reviewers count as false positives.

## Reproduce

The current source and `dist/server/index.js` must represent the same build; otherwise the parity assertion stops report generation. From the repository root:

```powershell
npm run build
node scripts/benchmark-primary-routing.mjs
python scripts/render-primary-routing-charts.py
```

Chart rendering requires Pillow.
