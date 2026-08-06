# Security evidence experiment method

The runner reuses `data/evaluation/golden-set.jsonl` and the canonical RAG corpus. It does not invoke an LLM. Each trace covers retrieval/candidate choice, policy, transformation, actual HTTP transfer through the proxy, runtime coverage, elapsed time, payload bytes, failure, and retry status.

Primary methods are `raw-central`, `always-local`, `fixed-sanitized`, `network-only`, `security-only`, `axnetcc-saea`, and `oracle-feasible`; ablations are retained separately. Six network scenarios are used. Quick mode uses one synthetic profile seed and three repetitions; full mode uses three seeds and 30 repetitions.

`--routing-comparison` adds the repository's existing orchestration comparison family to the same HTTP experiment: centralized, parallel, MASRouter-inspired, RemoteRAG-inspired, legacy PGRF, PGRF with SAEA, and an oracle-routed AXNetCC-SAEA reference. These are repository adapters to the existing implementations, not claims of exact reproduction of every upstream paper. A required golden role that is not selected becomes an explicit zero-coverage `routingMiss` trace. Coverage and role completion are computed only over golden-required roles; policy and transferred-byte metrics include every selected role, including unnecessary fan-out.

Analysis performs 10,000 paired resamples with seed `20260806`. The sampling unit is the query ID, so repeated executions of the same query remain one cluster. Differences are AXNetCC-SAEA minus each baseline.

The analyzer also computes an empirical P95 inside each query-method cluster, an exact paired sign-flip test when the query count is at most 20, and Holm-adjusted p-values across baselines for each metric. `method-summary.csv` averages query clusters rather than traces. Ablations have separate query/method summaries and paired statistics.

`oracle-feasible` is offline-only. It executes all four modes over the real HTTP path and chooses among the observed policy- and coverage-feasible results. Oracle probing is run in a separate phase so its extra requests do not load the online methods. The runner checkpoints completed jobs in batches and resumes with the same `--run-id` without duplicating completed jobs. Transport exceptions are retried and retained as status 599 failures rather than aborting the experiment.

The retained corpus, internal knowledge, and golden set are valid UTF-8; mojibake observed in some Windows console output is a display-layer issue. `data/security-evidence-manifest.json` supplies semantic aliases for spelling and terminology variants. Retrieval greedily builds a role-local bundle from existing evidence IDs. Label-based coverage is measured on that source bundle, while runtime-proxy coverage is measured again on the transformed HTTP response. No manual query-to-evidence label is used.

```bash
pnpm eval:security-evidence -- --quick
pnpm eval:security-evidence -- --routing-comparison --quick
pnpm eval:security-evidence -- --full --concurrency=24 --ablation-repetitions=3 --run-id=paper-full-v4-20260806
pnpm eval:security-evidence -- --dataset=data/evaluation/ax-golden-set-40.jsonl --max-queries=40 --repetitions=1 --profile-seeds=17,29,43 --concurrency=24 --no-ablation --run-id=paper-validation-40-20260806
pnpm eval:security-evidence:analyze -- data/evaluation/security-evidence/<run-id>
pnpm eval:security-evidence:validate -- data/evaluation/security-evidence/<run-id>
pnpm paper:security-evidence -- data/evaluation/security-evidence/paper-full-v4-20260806 data/evaluation/security-evidence/paper-validation-40-20260806
```
