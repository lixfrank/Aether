---
name: replication
description: Plan or execute a replication of a paper, claim, or benchmark. Use when the user asks to replicate results, reproduce an experiment, or verify a claim empirically. Currently supports planning and partial execution; full automated replication is pending.
category: Research
---

# Replication

Design a replication plan for: $@

## Workflow

1. **Extract** — Use researcher subagent (or alpha CLI) to pull implementation details from the target paper and linked code.

2. **Recipe pass** — For ML tasks, extract: dataset, method, hyperparameters, compute assumptions, metric, and code path for each claimed result.

3. **Plan** — Determine code, datasets, metrics, and environment needed. Write to outputs/.plans/<slug>.md.

4. **Environment** — Ask where to execute:
   - Local
   - Docker (see docker skill)
   - Plan only (no execution)

5. **Execute** — If chosen:
   - Use docker skill for isolated execution
   - Use alpha code for repo file inspection
   - Save scripts, outputs, and results to outputs/<slug>-replication/

6. **Report** — Did the replication succeed? What checks passed? End with Sources section.
