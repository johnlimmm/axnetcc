# Multi-family LLM judge validation

## Purpose

This experiment tests whether the repository's provisional role labels remain stable when the annotator family changes. It is a robustness check for model-family sensitivity, not a claim that LLM consensus is human ground truth.

## Protocol

- Input: the first fixed candidate from each of 40 semantic families in `ax-candidate-set-240.jsonl`; the source file is read-only.
- Blind inputs: query, organization, domain, task angle, and the eight allowed role IDs. Existing role labels, AXNetCC outputs, and method names are not shown.
- Judges: `qwen2.5:3b` (Qwen2, 3.1B), `llama3.1:8b` (Llama, 8.0B), and `gemma3:4b` (Gemma3, 4.3B), all Q4_K_M through local Ollama, plus the configured `gpt-5.4-mini-2026-03-17` OpenAI blind judge.
- Determinism controls: temperature 0, seed 20260806, fixed prompt version, model digest capture, and a deterministic rotation of the displayed role order for every query/model pair.
- Execution: 120/120 aligned local calls and 40/40 OpenAI calls produced valid schema-checked labels. One OpenAI response violated the 1-4 role constraint and was retained before a strict-schema repair. Model responses, timing, configuration, consensus, and SHA-256 manifests are retained under the aligned local and OpenAI run directories.
- Consensus: a role is included when at least two of three local model families select it. Agreement is also reported without collapsing to consensus.

## Results

- Three-way exact-set agreement: 0.000 (0/40).
- Mean local-model pairwise Jaccard: 0.267; query-cluster bootstrap 95% CI [0.230, 0.309].
- Pairwise exact agreement: Qwen/Llama 0.000, Qwen/Gemma 0.050, Llama/Gemma 0.000.
- Local-model macro Fleiss' kappa across eight binary role decisions: 0.041.
- Local consensus versus author-provisional labels: exact agreement 0.100, mean Jaccard 0.524 (95% CI [0.456, 0.593]), and micro-F1 0.667.
- OpenAI versus author-provisional labels: exact agreement 0.200, mean Jaccard 0.694, micro-precision 0.732, micro-recall 0.918, and micro-F1 0.815.
- OpenAI versus aligned local consensus: exact agreement 0.000, mean Jaccard 0.427, and micro-F1 0.586.
- Four-model macro Fleiss' kappa: 0.123.
- Mean fan-out: Qwen 2.300, Llama 2.150, Gemma 2.950, and OpenAI 3.825. OpenAI selected `tech` for every query, indicating high-recall over-selection.
- OpenAI used 14,307 tokens across 40 finalized labels. Self-reported confidence remained high despite low cross-family agreement.

## Interpretation

Changing the LLM family does not independently confirm the current role labels. The stronger OpenAI judge recovers author-labelled roles with high recall but over-selects roles; the smaller local consensus is more precise but misses more roles. This is a core-versus-supporting-role definition problem as well as a model-capacity problem. Replacing the existing labels with either source would change the benchmark target.

The defensible paper statement is that a preregistered three-family local-LLM robustness check and a stronger configured OpenAI cross-check were executed and found material label sensitivity. Acquisition results based on fixed author roles remain reproducible, but broad routing-superiority claims are label-sensitive. Independent domain review is still required for a genuine gold set.

## Reproduction

```bash
pnpm eval:annotate-multillm -- --sampling=semantic-family --limit=40 --max-attempts=1 --run-id=paper-multillm-aligned-40-20260806
pnpm eval:analyze-multillm -- data/evaluation/multi-llm-annotation/paper-multillm-aligned-40-20260806
pnpm eval:annotate-openai-blind -- --sampling=semantic-family --limit=40 --run-id=paper-openai-blind-40-20260806
pnpm eval:analyze-openai-blind -- data/evaluation/openai-blind-role/paper-openai-blind-40-20260806 data/evaluation/multi-llm-annotation/paper-multillm-aligned-40-20260806
```
