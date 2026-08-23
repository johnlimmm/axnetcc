# Evaluation artifact policy

Generated evaluation output is ignored by default. A report may be committed only when every
file is explicitly allowlisted in the repository `.gitignore`, can be reproduced by a checked-in
script, and contains no raw query, private corpus text, credentials, or unredacted trace payloads.

The `primary-routing-benchmark` directory is the current allowlist. Its JSON, CSV, and chart files
are generated from the versioned 40-query golden set by `npm run benchmark:routing`.

`scheduler-benchmark-v1.json` and `scheduler-benchmark-v1.svg` are also allowlisted. They are
reproduced by `npm run benchmark:scheduler` from a deterministic 1/3/8-Agent mock workload; the
JSON is the accessible data-table counterpart to the chart and records seed, endpoint count,
capacity, policy thresholds, runtime, and workload provenance.

Artifacts larger than 5 MiB, model files, raw traces, completed job dumps, rendered papers, and
corpus/index snapshots must remain outside Git (release storage or an approved artifact store).
If a future review requires a large binary in Git, Git LFS must be configured before the file is
added; ordinary Git blobs are not accepted.
