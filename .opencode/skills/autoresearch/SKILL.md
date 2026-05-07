---
name: autoresearch
description: Autonomous experiment loop — try ideas, measure results, keep what works, discard what doesn't. Use when the user asks to optimize a metric, run an experiment loop, or automate benchmarking. Currently limited to planning and analysis; automated execution tools are pending.
category: Research
---

# Autoresearch

Start an autoresearch optimization loop for: $@

## Current Limitations

Aether does not yet have experiment management tools (`init_experiment`, `run_experiment`, `log_experiment`). This skill can:

- Plan the experiment (what to optimize, benchmark command, metric, files in scope)
- Analyze results the user provides manually
- Suggest modifications based on analysis
- Track progress in a CHANGELOG.md

Automated edit → commit → run → log → keep/revert loops are NOT yet available.

## Workflow

1. **Gather** — Collect from the user:
   - What to optimize (metric name, unit, direction)
   - The benchmark command
   - Files in scope for changes
   - Maximum iterations (default: 20)

2. **Environment** — Ask where to run:
   - Local (current directory)
   - New git branch
   - Docker container (see docker skill)
   - Plan only (no execution)

   Do not proceed without a clear answer.

3. **Plan** — Write the experiment plan to outputs/.plans/<slug>.md. Confirm with user.

4. **Execute** — If execution environment chosen:
   - For Docker: use the docker skill to run benchmark in container
   - For Local: guide user to run benchmark manually, or run via bash if in allowed_commands
   - Log each iteration to autoresearch.md and CHANGELOG.md

5. **Report** — Summary of results, best configuration found, and next steps.
