# AXNetCC-SAEA experiment report

## Configuration

- Mode: full
- Queries: 6
- Methods: 7
- Scenarios: 6
- Repetitions: 30
- Profile seeds: 17, 29, 43
- Execution concurrency: 24
- Ablation repetitions per profile: 3
- Total HTTP traces (including ablations): 49248
- Query-cluster bootstrap: 10,000 resamples, seed 20260806
- Paired sign-flip/permutation test with Holm correction per metric

## Main results

AXNetCC-SAEA overall: policy violation rate 0.000, source-bundle coverage 0.999, runtime-proxy coverage 0.860, required-role completion 0.860, routing-miss rate 0.000, mean agent fan-out 2.000, infeasible-role rate 0.139, P95 latency 6877.204 ms, raw cross-boundary bytes 115.329, sensitivity-weighted bytes 8056.922.

| Method | Completion | Policy violation | Runtime coverage | P95 ms | Raw bytes | Weighted bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| raw-central | 0.997 | 0.923 | 0.997 | 6949.967 | 3357.199 | 14108.132 |
| always-local | 0.722 | 0.000 | 0.906 | 6963.923 | 0.000 | 8317.040 |
| fixed-sanitized | 0.859 | 0.000 | 0.952 | 6936.043 | 0.000 | 9533.371 |
| network-only | 0.000 | 0.000 | 0.000 | 6891.280 | 0.000 | 3454.416 |
| security-only | 0.738 | 0.000 | 0.910 | 6890.294 | 332.166 | 8512.835 |
| axnetcc-saea | 0.860 | 0.000 | 0.860 | 6877.204 | 115.329 | 8056.922 |
| oracle-feasible | 0.861 | 0.000 | 0.861 | 2485.642 | 115.329 | 8058.804 |

- interdepartmental: P95 6649.118 ms; source coverage 1.000; runtime coverage 0.833; required-role completion 0.833; routing misses 0.000; fan-out 2.000; policy violations 0.000; HTTP failures 0.000
- mixed: P95 7254.741 ms; source coverage 1.000; runtime coverage 0.833; required-role completion 0.833; routing misses 0.000; fan-out 2.000; policy violations 0.000; HTTP failures 0.000
- normal: P95 5960.366 ms; source coverage 1.000; runtime coverage 0.833; required-role completion 0.833; routing misses 0.000; fan-out 2.000; policy violations 0.000; HTTP failures 0.000
- lossy: P95 7645.099 ms; source coverage 0.996; runtime coverage 0.830; required-role completion 0.830; routing misses 0.000; fan-out 2.000; policy violations 0.000; HTTP failures 0.004
- low-bandwidth: P95 7317.275 ms; source coverage 1.000; runtime coverage 0.833; required-role completion 0.833; routing misses 0.000; fan-out 2.000; policy violations 0.000; HTTP failures 0.000
- owner-overload: P95 6206.377 ms; source coverage 1.000; runtime coverage 0.833; required-role completion 0.833; routing misses 0.000; fan-out 2.000; policy violations 0.000; HTTP failures 0.000

Coverage and completion are evaluated only for golden-required roles. Payload, exposure, and policy metrics include every selected role, so unnecessary fan-out is not hidden. Corpus and golden inputs are valid UTF-8. Semantic aliases bridge terminology variants, not damaged bytes. Source-bundle coverage is measured on greedily retrieved existing evidence IDs; runtime-proxy coverage is measured independently on the transformed HTTP response. Metadata transferred for an infeasible role is escalation metadata, not accepted evidence. Paired bootstrap results are in `paired-differences.json` (36 metric comparisons). Repeated executions of the same query are never treated as independent queries.

## Ablations

| Method | Completion | Policy violation | Runtime coverage | P95 ms | Raw bytes | Weighted bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| axnetcc-saea-full | 0.852 | 0.000 | 0.852 | 10627.377 | 115.329 | 7876.683 |
| without-policy-constraint | 0.994 | 0.673 | 0.994 | 9905.266 | 2032.235 | 11468.532 |
| without-coverage-constraint | 0.000 | 0.000 | 0.000 | 10249.753 | 0.000 | 3462.415 |
| without-sensitivity-criterion | 0.858 | 0.000 | 0.858 | 10051.941 | 115.329 | 8003.314 |
| without-network-criterion | 0.855 | 0.000 | 0.855 | 9859.976 | 115.332 | 8005.299 |
| weighted-objective | 0.853 | 0.000 | 0.853 | 10130.716 | 115.331 | 7994.487 |

Ablation traces are not pooled with primary-method summaries. Paired results are in `ablation-paired-differences.json` (30 comparisons).

## Claim boundaries

- Synthetic security emulation profile (`syntheticProfile: true`).
- Public and synthetic source data; no assertion that public documents carry real security labels.
- Application-layer HTTP emulation and measured application payload bytes/elapsed time.
- No physical KOREN measurement and no packet-level wire-byte claim.
- No legal-compliance or privacy guarantee.
- No expert validation of final business correctness.

## Limitations

The six-query full run estimates within-set systems effects; it is not a broad confirmatory task benchmark. Host scheduling and the recorded concurrency affect elapsed time; injected delays and planner choices are seeded/deterministic, while observed wall-clock timing is not perfectly deterministic. Semantic aliases and role-concept assignments are derived configuration and are not independent human adjudication.
