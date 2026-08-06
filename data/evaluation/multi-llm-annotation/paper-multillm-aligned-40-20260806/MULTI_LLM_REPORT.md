# Multi-family LLM blind annotation report

- Run: paper-multillm-aligned-40-20260806
- Complete cases: 40/40
- Three-way exact agreement: 0.000
- Mean pairwise Jaccard: 0.267
- Macro Fleiss' kappa across roles: 0.041
- Consensus vs author provisional micro-F1: 0.667
- Consensus vs author provisional exact agreement: 0.100
- Consensus review rate: 0.000

## Pairwise

- qwen2.5:3b vs llama3.1:8b: exact 0.000, Jaccard 0.208
- qwen2.5:3b vs gemma3:4b: exact 0.050, Jaccard 0.329
- llama3.1:8b vs gemma3:4b: exact 0.000, Jaccard 0.264

## Interpretation

Multi-family local LLM consensus is an independent-model robustness check, not independent human ground truth.
