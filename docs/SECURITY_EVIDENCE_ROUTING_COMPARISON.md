# Security evidence routing comparison

Run: `security-evidence-2026-08-06T02-19-49-144Z`

Configuration: 6 existing golden queries, 7 methods, 6 application-layer network scenarios, 3 repetitions, profile seed 17. All evidence transfers used the fixed localhost HTTP Evidence Gateway and network proxy. Values below are query-cluster means across scenarios; latency is descriptive wall-clock P95 averaged by query.

| Method | Required-role completion | Routing miss | Agent fan-out | Policy violation | Runtime coverage | Raw boundary bytes | P95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| centralized-legacy | 0.972 | 0.000 | 8.000 | 0.060 | 0.972 | 3637.97 | 544.96 |
| parallel-legacy | 0.713 | 0.000 | 8.000 | 0.000 | 0.886 | 0.00 | 499.10 |
| masrouter-legacy | 0.815 | 0.139 | 2.167 | 0.157 | 0.815 | 3063.10 | 263.93 |
| remoterag-legacy | 0.827 | 0.139 | 2.167 | 0.157 | 0.827 | 3114.87 | 264.01 |
| pgrf-legacy | 0.701 | 0.000 | 2.833 | 0.000 | 0.876 | 0.00 | 235.08 |
| pgrf-saea | 0.944 | 0.000 | 2.833 | 0.000 | 0.944 | 1576.81 | 261.39 |
| axnetcc-saea (golden-role reference) | 0.963 | 0.000 | 2.000 | 0.000 | 0.963 | 1627.95 | 231.91 |

Paired query-cluster bootstrap used 10,000 resamples (seed 20260806). Against centralized-legacy, AXNetCC-SAEA reduced policy violations by 0.060 (95% CI 0.020 to 0.102 reduction) and raw boundary bytes by 2010.03 (95% CI 905.10 to 3131.52 reduction); the required-role completion difference was -0.009 with a CI spanning zero. Against MASRouter-inspired, completion improved by 0.148 (95% CI 0.019 to 0.315) and raw boundary bytes decreased by 1435.15 (95% CI 173.28 to 2619.52 reduction). PGRF+SAEA versus PGRF-legacy isolates the acquisition contribution under the same router: completion increased from 0.701 to 0.944, while raw bytes increased from zero to 1576.81 because the planner permits raw public evidence when policy and coverage allow it.

The small six-query quick run is implementation evidence, not a confirmatory benchmark. `axnetcc-saea` uses golden-required roles and is therefore an acquisition upper-reference, not a deployable learned router. MASRouter and RemoteRAG rows are repository-inspired adapters, not exact upstream system reproductions. See the run-local `REPORT.md`, `raw-traces.jsonl`, `query-summary.csv`, `method-scenario-summary.csv`, and `paired-differences.json` for auditable results.
