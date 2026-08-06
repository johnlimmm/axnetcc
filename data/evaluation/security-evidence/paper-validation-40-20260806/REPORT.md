# AXNetCC-SAEA experiment report

## Configuration

- Mode: validation
- Queries: 40
- Methods: 7
- Scenarios: 6
- Repetitions: 1
- Profile seeds: 17, 29, 43
- Execution concurrency: 24
- Ablation repetitions per profile: 0
- Total HTTP traces (including ablations): 12222
- Query-cluster bootstrap: 10,000 resamples, seed 20260806
- Paired sign-flip/permutation test with Holm correction per metric

## Main results

AXNetCC-SAEA overall: policy violation rate 0.000, source-bundle coverage 0.892, runtime-proxy coverage 0.685, required-role completion 0.723, routing-miss rate 0.000, mean agent fan-out 2.425, infeasible-role rate 0.257, P95 latency 12196.887 ms, raw cross-boundary bytes 276.167, sensitivity-weighted bytes 4271.857.

| Method | Completion | Policy violation | Runtime coverage | P95 ms | Raw bytes | Weighted bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| raw-central | 0.759 | 0.675 | 0.891 | 12197.374 | 3502.363 | 7613.123 |
| always-local | 0.645 | 0.000 | 0.827 | 12240.935 | 0.000 | 4494.004 |
| fixed-sanitized | 0.739 | 0.000 | 0.879 | 11709.593 | 0.000 | 6482.484 |
| network-only | 0.000 | 0.000 | 0.000 | 12507.773 | 0.000 | 1792.405 |
| security-only | 0.681 | 0.000 | 0.854 | 12053.551 | 1260.022 | 5092.071 |
| axnetcc-saea | 0.723 | 0.000 | 0.685 | 12196.887 | 276.167 | 4271.857 |
| oracle-feasible | 0.743 | 0.000 | 0.705 | 3558.463 | 285.949 | 4321.931 |

- owner-overload: P95 10191.976 ms; source coverage 0.891; runtime coverage 0.680; required-role completion 0.711; routing misses 0.000; fan-out 2.425; policy violations 0.000; HTTP failures 0.000
- normal: P95 10917.390 ms; source coverage 0.891; runtime coverage 0.680; required-role completion 0.711; routing misses 0.000; fan-out 2.425; policy violations 0.000; HTTP failures 0.000
- lossy: P95 12577.079 ms; source coverage 0.870; runtime coverage 0.664; required-role completion 0.694; routing misses 0.000; fan-out 2.425; policy violations 0.000; HTTP failures 0.021
- interdepartmental: P95 10822.987 ms; source coverage 0.891; runtime coverage 0.680; required-role completion 0.711; routing misses 0.000; fan-out 2.425; policy violations 0.000; HTTP failures 0.000
- mixed: P95 13240.788 ms; source coverage 0.891; runtime coverage 0.680; required-role completion 0.711; routing misses 0.000; fan-out 2.425; policy violations 0.000; HTTP failures 0.000
- low-bandwidth: P95 11700.490 ms; source coverage 0.891; runtime coverage 0.680; required-role completion 0.711; routing misses 0.000; fan-out 2.425; policy violations 0.000; HTTP failures 0.000

Coverage and completion are evaluated only for golden-required roles. Payload, exposure, and policy metrics include every selected role, so unnecessary fan-out is not hidden. Corpus and golden inputs are valid UTF-8. Semantic aliases bridge terminology variants, not damaged bytes. Source-bundle coverage is measured on greedily retrieved existing evidence IDs; runtime-proxy coverage is measured independently on the transformed HTTP response. Metadata transferred for an infeasible role is escalation metadata, not accepted evidence. Paired bootstrap results are in `paired-differences.json` (36 metric comparisons). Repeated executions of the same query are never treated as independent queries.

## Ablations

No ablation traces were requested.

Ablation traces are not pooled with primary-method summaries. Paired results are in `ablation-paired-differences.json` (0 comparisons).

## Claim boundaries

- Synthetic security emulation profile (`syntheticProfile: true`).
- Public and synthetic source data; no assertion that public documents carry real security labels.
- Application-layer HTTP emulation and measured application payload bytes/elapsed time.
- No physical KOREN measurement and no packet-level wire-byte claim.
- No legal-compliance or privacy guarantee.
- No expert validation of final business correctness.

## Limitations

The six-query full run estimates within-set systems effects; it is not a broad confirmatory task benchmark. Host scheduling and the recorded concurrency affect elapsed time; injected delays and planner choices are seeded/deterministic, while observed wall-clock timing is not perfectly deterministic. Semantic aliases and role-concept assignments are derived configuration and are not independent human adjudication.
