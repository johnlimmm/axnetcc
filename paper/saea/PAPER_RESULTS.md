# AXNetCC-SAEA paper results package

## Experimental hierarchy

- Acquisition main study: 6 fixed-role golden queries, 7 methods, 6 network scenarios, 3 synthetic-profile seeds, 30 repetitions, actual application-layer HTTP.
- Acquisition ablation: 6 configurations and 3 repetitions per profile.
- Router secondary study: 40 author-labelled queries with 5-fold semantic-family-grouped cross-validation.
- The 240-item LLM-adjudicated set remains provisional and is not represented as an independent human-labelled confirmatory test.

## Main acquisition table

| Method | Completion | Policy violation | Coverage | P95 ms | Raw bytes | Weighted bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| raw-central | 0.997 | 0.923 | 0.997 | 6949.967 | 3357.199 | 14108.132 |
| always-local | 0.722 | 0.000 | 0.906 | 6963.923 | 0.000 | 8317.040 |
| fixed-sanitized | 0.859 | 0.000 | 0.952 | 6936.043 | 0.000 | 9533.371 |
| network-only | 0.000 | 0.000 | 0.000 | 6891.280 | 0.000 | 3454.416 |
| security-only | 0.738 | 0.000 | 0.910 | 6890.294 | 332.166 | 8512.835 |
| axnetcc-saea | 0.860 | 0.000 | 0.860 | 6877.204 | 115.329 | 8056.922 |
| oracle-feasible | 0.861 | 0.000 | 0.861 | 2485.642 | 115.329 | 8058.804 |

## Acquisition validation (40 queries)

| Method | Completion | Policy violation | Coverage | P95 ms | Raw bytes | Weighted bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| raw-central | 0.759 | 0.675 | 0.891 | 12197.374 | 3502.363 | 7613.123 |
| always-local | 0.645 | 0.000 | 0.827 | 12240.935 | 0.000 | 4494.004 |
| fixed-sanitized | 0.739 | 0.000 | 0.879 | 11709.593 | 0.000 | 6482.484 |
| network-only | 0.000 | 0.000 | 0.000 | 12507.773 | 0.000 | 1792.405 |
| security-only | 0.681 | 0.000 | 0.854 | 12053.551 | 1260.022 | 5092.071 |
| axnetcc-saea | 0.723 | 0.000 | 0.685 | 12196.887 | 276.167 | 4271.857 |
| oracle-feasible | 0.743 | 0.000 | 0.705 | 3558.463 | 285.949 | 4321.931 |

This validation uses one execution per query/scenario/profile combination and a derived role-concept manifest. Thirteen mappings required deterministic fallback assignment. It broadens query coverage but is not an independently human-adjudicated confirmatory set. 17 of 36 paired metric comparisons remain below 0.05 after Holm adjustment.

## Multi-family LLM judge robustness check

40 semantic-family cases were independently labelled by Qwen 2.5 3B, Llama 3.1 8B, and Gemma 3 4B. All 120 calls were valid. Three-way exact agreement was 0.000, mean pairwise Jaccard was 0.267 (95% bootstrap CI 0.230 to 0.309), and macro Fleiss' kappa was 0.041. The 2-of-3 consensus matched the author-provisional labels with exact agreement 0.100 and micro-F1 0.667. This low cross-family agreement is evidence of label sensitivity, not confirmation of an independent gold set.

## OpenAI blind-judge cross-check

The configured gpt-5.4-mini-2026-03-17 judge produced 40/40 valid blind labels using 14307 tokens. Against author-provisional labels it achieved exact agreement 0.200, mean Jaccard 0.694, and micro-F1 0.815. Against the aligned local three-family consensus it achieved exact agreement 0.000, Jaccard 0.427, and micro-F1 0.586. Four-model macro Fleiss' kappa was 0.123. Its mean fan-out was 3.825, showing a high-recall but over-selection tendency.

## Router table

| Method | Macro-F1 | Exact match | Fan-out | Boundary bytes |
| --- | ---: | ---: | ---: | ---: |
| static | 60.400 | 17.500 | 2.170 | 1212.000 |
| topk | 59.900 | 15.000 | 2.200 | 1216.000 |
| threshold | 57.800 | 15.000 | 1.480 | 845.000 |
| learned | 46.600 | 2.500 | 1.000 | 548.000 |
| costAware | 57.800 | 15.000 | 1.480 | 845.000 |
| masRouterAdapted | 30.000 | 2.500 | 2.600 | 871.000 |
| routeLlmMfAdapted | 33.700 | 7.500 | 2.130 | 848.000 |
| irtRouterAdapted | 35.300 | 0.000 | 2.650 | 1053.000 |
| proposed | 66.500 | 25.000 | 3.200 | 1900.000 |
| oracle | 100.000 | 100.000 | 2.420 | 1220.000 |

The research-based router rows are AX task adapters. MasRouter preserves the count/role cascade, RouteLLM-MF maps preference routing to role selection, and IRT-Router maps model ability to role ability. They are not upstream benchmark reproductions. Inspected provenance date: 2026-07-30T15:00:00.000Z.

## Correct statistical interpretation

There are 36 paired metric comparisons and 0 remain below 0.05 after Holm adjustment. The sampling unit is the unique query, not the HTTP trace. Empirical P95 is computed within each query-method cluster before paired comparison. With only 6 main queries, confidence intervals are necessarily coarse; statistical significance does not establish broad external validity.

## Artifacts

- `TABLE_ACQUISITION.csv`: query-weighted systems results.
- `TABLE_ABLATION.csv`: separately executed ablations.
- `TABLE_ACQUISITION_VALIDATION_40.csv`: separate 40-query acquisition validation.
- `TABLE_ROUTER_BASELINES.csv`: existing five-fold router results.
- `MULTI_LLM_JUDGE_REPORT.json`: three-family blind-label agreement and uncertainty.
- `FIGURE_SECURITY_QUALITY_PARETO.svg`: completion versus raw boundary bytes, with policy violation encoded by color.
- `OPENAI_BLIND_JUDGE_REPORT.json`: configured OpenAI judge and aligned four-model comparison.
- Run-local raw traces, configuration, environment, bootstrap, and permutation outputs remain the source of truth.

## Non-claims

No physical KOREN or packet-level measurement, real institutional secrecy validation, privacy guarantee, legal-compliance guarantee, exact upstream baseline reproduction, or independent expert validation is claimed.
