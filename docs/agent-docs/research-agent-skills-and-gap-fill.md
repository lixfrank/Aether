# Research Agent: Skills, Subagents, and Gap Fill Design

Branch: `feat/research-agent`

This document covers the gap analysis between Aether's current research agent and Feynman's research workflow, and the detailed implementation plan for filling those gaps. It builds on the foundation in `research-agent-implementation-plan.md` (Changes 0-7: Permission unification, env_scope, verifier/reviewer agents, scale decision, research workflow definition).

**Context for a fresh session**: The research agent infrastructure (Permission/Discipline unification, env_scope, verifier/reviewer subagents, scale decision, compileDiscipline, evaluateWithCommand) has been implemented in a previous session. This document addresses the remaining gaps discovered after comparing with the Feynman project.

---

## Gap Analysis Summary

| Gap                                                                           | Priority | Status                            |
| ----------------------------------------------------------------------------- | -------- | --------------------------------- |
| Researcher subagent (evidence-gathering, not codebase-exploring)              | High     | New — needs implementation        |
| alpha-research skill (paper search/read/Q&A/annotate via alpha CLI)           | High     | New — needs skill creation        |
| Docker skill (full Feynman content, not simplified)                           | High     | New — needs skill creation        |
| Research agent bash permission (change from deny to allow + allowed_commands) | High     | Config change in research.md      |
| Workflow too heavy for simple intents (quick-lookup goes through 6 phases)    | High     | Needs research.md prompt redesign |
| source-comparison skill (multi-source comparison matrix)                      | Medium   | New — needs skill creation        |
| paper-code-audit skill (paper vs code consistency)                            | Medium   | New — needs skill creation        |
| literature-review skill needs adaptation to Aether agent design               | Medium   | Needs skill rewrite               |
| skill_refs append semantics (config adds to base list, not replaces)          | Medium   | One-line code change in agent.ts  |
| Routing skill SKILL.md should be lean, not full workflow                      | Medium   | Skill design principle            |
| Autoresearch workflow (experiment loop)                                       | Low      | Future — needs experiment tools   |
| Replication workflow (paper reproduction)                                     | Low      | Future — needs experiment tools   |
| Modal/RunPod compute skills                                                   | Low      | Future — after docker is proven   |

---

## Change A: Researcher Subagent

### Problem

The research agent's `scale_decision` currently specifies `subagent_type: explore` for all scale rules. But `explore` is a codebase-exploration agent whose prompt says:

> "Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns..."

This is fundamentally wrong for research evidence gathering. Explore lacks:

- Integrity Commandments (never fabricate, URL or it didn't happen, read before summarize)
- Source quality evaluation (primary vs secondary vs self-reported)
- Evidence table output format (Source, URL, Quality, Key Takeaway)
- Search strategy guidance (start wide, progressively narrow, cross-source)
- ML recipe mode (for training/fine-tuning/benchmark tasks)
- Context hygiene (write to file, don't accumulate in memory)

### Design: base_agent inheritance in `.aether/agent/researcher.md`

Create a project-level agent definition (NOT in `packages/opencode/src/agent/agent.ts`). It inherits from `explore` to get search/read/bash/websearch/webfetch permissions, then overrides prompt and skill_refs.

**File**: `.aether/agent/researcher.md`

```yaml
---
description: Gather primary evidence across papers, web sources, repos, docs, and local artifacts with integrity constraints and source quality evaluation.
mode: subagent
base_agent: explore
prompt_append: |
  <system-reminder>

  You are Aether's evidence-gathering researcher subagent.

  ## Integrity Commandments
  1. **Never fabricate a source.** Every named tool, project, paper, or dataset must have a verifiable URL. If you cannot find a URL, do not mention it.
  2. **Never claim a project exists without checking.** Before citing a GitHub repo, search for it. Before citing a paper, find it. If a search returns zero results, the thing does not exist.
  3. **Never extrapolate details you haven't read.** If you haven't fetched and inspected a source, you may note its existence but must not describe its contents, metrics, or claims.
  4. **URL or it didn't happen.** Every entry in your evidence table must include a direct, checkable URL. No URL = not included.
  5. **Read before you summarize.** Do not infer paper contents from title, venue, abstract fragments, or memory when direct access is possible.
  6. **Mark status honestly.** Distinguish clearly between claims read directly, claims inferred from multiple sources, and unresolved questions.

  ## Search Strategy
  1. **Start wide.** Begin with short, broad queries to map the landscape. Use websearch with 2-4 varied-angle queries.
  2. **Evaluate availability.** After the first round, assess what source types exist and which are highest quality. Adjust strategy accordingly.
  3. **Progressively narrow.** Drill into specifics using terminology and names discovered in initial results. Refine queries, don't repeat them.
  4. **Cross-source.** When the topic spans current reality and academic literature, use both websearch and the alpha CLI (alpha-research skill).

  ## Source Quality
  - **Prefer:** academic papers, official documentation, primary datasets, verified benchmarks, government filings, reputable journalism, expert technical blogs, official vendor pages
  - **Accept with caveats:** well-cited secondary sources, established trade publications
  - **Deprioritize:** SEO-optimized listicles, undated blog posts, content aggregators, social media without primary links
  - **Reject:** sources with no author and no date, content that appears AI-generated with no primary backing

  When initial results skew toward low-quality sources, re-search targeting authoritative domains.

  ## ML Recipe Mode
  When the parent asks for ML training, fine-tuning, replication, benchmark, or implementation recipes, organize findings around result-backed recipes instead of a generic literature summary.

  For each candidate recipe, capture:
  - Paper or source, with date and URL
  - Exact reported result and benchmark
  - Dataset name, size, split, source URL, access/license constraints
  - Method and key hyperparameters: optimizer, learning rate, schedule, epochs/steps, batch size, model/checkpoint, loss/objective, evaluation metric
  - Compute assumptions: hardware, runtime, memory, or cost if stated
  - Implementation grounding: official docs, repo path, example script, class/function names, command pattern
  - Verification status: verified, unverified, blocked, or inferred

  Rank recipe candidates by practical feasibility and result quality. Do not describe a dataset as usable unless you directly checked availability and format, or clearly mark that check as missing.

  ## Output Format

  Assign each source a stable numeric ID. Use these IDs consistently so downstream agents can trace claims to exact sources.

  ### Evidence Table
  | # | Source | URL | Key claim | Type | Confidence |
  |---|--------|-----|-----------|------|------------|
  | 1 | ... | ... | ... | primary / secondary / self-reported | high / medium / low |

  ### Findings
  Write findings using inline source references: [1], [2], etc. Every factual claim must cite at least one source by number.
  When a claim is an inference rather than a directly stated source claim, label it as an inference.

  ### Sources
  Numbered list matching the evidence table:
  1. Author/Title — URL
  2. Author/Title — URL

  ### Coverage Status
  List what you checked directly, what remains uncertain, and any tasks you could not complete.

  ## Context Hygiene
  - Write findings to the output file progressively. Do not accumulate full page contents in your working memory — extract what you need, write it to file, move on.
  - When websearch returns large pages, extract relevant quotes and discard the rest immediately.
  - If your search produces 10+ results, triage by title/snippet first. Only fetch full content for the top candidates.
  - Return a one-line summary to the parent, not full findings. The parent reads the output file.
  - If assigned multiple questions, track them explicitly in the file and mark each as done, blocked, or needs follow-up. Do not silently skip questions.

  ## Output Contract
  - Save to the output path specified by the parent.
  - Minimum viable output: evidence table with >=5 numbered entries, findings with inline references, and a numbered Sources section.
  - Write to the file and pass a lightweight reference back — do not dump full content into the parent context.
  </system-reminder>
skill_refs:
  - alpha-research
  - arxiv-search
---
```

### Update: research.md scale_decision

Change `subagent_type` from `explore` to `researcher` in all scale rules:

```yaml
# In .aether/agent/research.md
scale_decision:
  direct_threshold: 10
  never_spawn_for:
    - quick-lookup
    - explainer
  rules:
    - condition: "2-3 item comparison"
      subagent_count: 2
      subagent_type: researcher # changed from explore
      mode: concurrent
    - condition: "broad survey or multi-faceted topic"
      subagent_count: 3
      subagent_type: researcher # changed from explore
      mode: concurrent
    - condition: "complex multi-domain research"
      subagent_count: 5
      subagent_type: researcher # changed from explore
      mode: background
```

Also update the Phase 2 (Gather) prompt in research.md to reference `researcher` instead of `explore`.

### base_agent inheritance mechanism

When `base_agent: explore` is specified, `agent.ts` resolves the base agent's permission and properties, then overlays the new agent's overrides on top. The key code path is in `packages/opencode/src/agent/agent.ts` around line 361:

```ts
const base = value.base_agent ? agents[value.base_agent] : undefined
// ...
const basePermissionLayers = [defaults]
if (agentDefaultsPermission) basePermissionLayers.push(agentDefaultsPermission)
if (base) basePermissionLayers.push(base.permission) // ← inherits explore's permission
basePermissionLayers.push(user)
// Then overlays the new agent's own permission on top
const newAgentPermission = Permission.merge(...basePermissionLayers, Permission.fromConfig(value.permission ?? {}))
```

So researcher inherits explore's permission (glob, grep, read, bash, websearch, webfetch, etc.), then applies any `permission` overrides from researcher.md. If researcher.md doesn't specify any `permission`, it gets explore's exact permission set — which is appropriate for an evidence-gathering agent.

The `prompt` and `prompt_append` fields overlay on top of explore's prompt. Since researcher.md specifies `prompt_append` (not `prompt`), the Integrity Commandments + output format + search strategy get appended after explore's base prompt. This is the correct behavior — researcher gets explore's "find files quickly" capability plus research-specific constraints.

The `skill_refs` field is independent — it's set explicitly in researcher.md to `[alpha-research, arxiv-search]`, regardless of what explore might have.

### Files Changed

| File                          | Change                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `.aether/agent/researcher.md` | New file — researcher subagent definition                                                                                      |
| `.aether/agent/research.md`   | Update `scale_decision.subagent_type` from `explore` to `researcher`; update Phase 2 prompt to reference `researcher` subagent |

---

## Change B: Research Agent Bash Permission + Docker

### Problem

Current research.md has `bash: deny`. This prevents:

- Running `alpha` CLI for paper search/Q&A
- Running `docker` for isolated experiment execution
- Running `curl` for URL verification
- Running `rg`/`grep` for on-disk verification checks

Research needs bash, but it should be restricted.

### Design: bash allow + env_scope.allowed_commands

```yaml
# .aether/agent/research.md (updated frontmatter)
permission:
  bash: allow # changed from deny
  edit: allow
  webfetch: allow
  websearch: allow
  knowledge_search: allow
  question: allow
  todowrite: allow
  research_exit: allow
  plan_enter: allow
  task: allow
  skill: allow
  read: allow
  glob: allow
  grep: allow
env_scope:
  path_prefix:
    - node_modules/.bin
  env_vars:
    AETHER_SESSION_DIR: "{{session_dir}}"
  allowed_commands: # compiles to bash permission rules via compileDiscipline()
    - alpha # alpha CLI for paper search/Q&A
    - curl # URL verification
    - rg # on-disk verification
    - grep # on-disk verification
    - git # read-only git operations
    - docker # isolated execution
```

The `allowed_commands` compiles via `compileDiscipline()` (already implemented) to:

```ts
;[
  { permission: "bash", pattern: "alpha*", action: "allow" },
  { permission: "bash", pattern: "curl*", action: "allow" },
  { permission: "bash", pattern: "rg*", action: "allow" },
  { permission: "bash", pattern: "grep*", action: "allow" },
  { permission: "bash", pattern: "git*", action: "allow" },
  { permission: "bash", pattern: "docker*", action: "allow" },
  { permission: "bash", pattern: "*", action: "deny" }, // blanket deny — only these commands allowed
]
```

This uses the Permission/Discipline unification model (Change 0 from the implementation plan). The blanket deny is added because `allowed_commands` is explicitly set — semantic: "restrict bash to only these commands".

**Docker permission for subagents**: When the research agent dispatches a researcher subagent that needs docker (for replication/autoresearch workflows), it passes `permission_override` in the task call:

```json
{
  "subagent_type": "researcher",
  "permission_override": { "bash": ["allow", "docker*"] },
  "prompt": "Run this experiment in Docker..."
}
```

This adds docker permission on top of researcher's existing allowed*commands, capped by Permission.intersection (parent's bash deny-* won't veto child's docker allow because parent itself has docker\_ allow).

### Update: Research Workflow Prompt

Remove the "FORBIDDEN: bash" line from the HARD CONSTRAINTS section in research.md's prompt_append. Replace with:

```
FORBIDDEN actions (NO EXCEPTIONS):
- edit/write/multiedit/apply_patch — any file OUTSIDE the notepad directory
- plan_exit, plan_enter — use research_exit to switch instead
- bash commands not in allowed_commands — only alpha, curl, rg, grep, git, docker are permitted
```

### Docker Skill (Full Feynman Content)

**File**: `.opencode/skills/docker/SKILL.md`

Do NOT simplify. Use Feynman's full docker skill content. It includes:

- GPU support (`--gpus all`)
- Persistent containers (`docker create --name` + `docker exec`, essential for autoresearch iterations)
- Base image selection guide (Python ML/general/Node/R/Julia/Multi-language)
- Network isolation option (`--network none`)
- Cleanup instructions (`docker stop && docker rm`)

Full skill content:

````yaml
---
name: docker
description: Execute research code inside isolated Docker containers for safe replication, experiments, and benchmarks. Use when the user selects Docker as the execution environment or asks to run code safely, in isolation, or in a sandbox.
---

# Docker Sandbox

Run research code inside Docker containers while the agent stays on the host. The container gets the project files, runs the commands, and results sync back.

## When to use

- User selects "Docker Sandbox" as the execution environment for replication or experiments
- Running untrusted code from a paper's repository
- Experiments that install packages or modify system state
- Any time the user asks to run something "safely" or "isolated"

## Running commands in a container

For Python research code (most common):

```bash
docker run --rm -v "$(pwd)":/workspace -w /workspace python:3.11 bash -c "
  pip install -r requirements.txt &&
  python train.py
"
````

For projects with a Dockerfile:

```bash
docker build -t experiment .
docker run --rm -v "$(pwd)/results":/workspace/results experiment
```

For GPU workloads:

```bash
docker run --rm --gpus all -v "$(pwd)":/workspace -w /workspace pytorch/pytorch:latest bash -c "
  pip install -r requirements.txt &&
  python train.py
"
```

## Choosing the base image

| Research type  | Base image                                                     |
| -------------- | -------------------------------------------------------------- |
| Python ML/DL   | `pytorch/pytorch:latest` or `tensorflow/tensorflow:latest-gpu` |
| Python general | `python:3.11`                                                  |
| Node.js        | `node:20`                                                      |
| R / statistics | `rocker/r-ver:4`                                               |
| Julia          | `julia:1.10`                                                   |
| Multi-language | `ubuntu:24.04` with manual installs                            |

## Persistent containers

For iterative experiments (like autoresearch), create a named container instead of --rm:

```bash
docker create --name <name> -v "$(pwd)":/workspace -w /workspace python:3.11 tail -f /dev/null
docker start <name>
docker exec <name> bash -c "pip install -r requirements.txt"
docker exec <name> bash -c "python train.py"
```

This preserves installed packages across iterations. Clean up with:

```bash
docker stop <name> && docker rm <name>
```

## Notes

- The mounted workspace syncs results back to the host automatically
- Containers are network-enabled by default — add `--network none` for full isolation
- For GPU access, Docker must be configured with the NVIDIA Container Toolkit

````

### Files Changed

| File | Change |
|---|---|
| `.aether/agent/research.md` | Change `bash: deny` to `bash: allow`; add `docker` to `env_scope.allowed_commands`; update FORBIDDEN section in prompt |
| `.opencode/skills/docker/SKILL.md` | New skill — full Feynman docker content (NOT simplified) |

---

## Change C: alpha-research Skill (Auth-First with Fallback)

### Design

The alpha CLI provides paper search, full-text reading, Q&A, code repository inspection, and persistent annotations — capabilities far beyond arxiv-search (which only searches titles/abstracts). alpha-research should be the primary paper tool, with arxiv-search as fallback only when the user explicitly declines alphaXiv account creation.

**File**: `.opencode/skills/alpha-research/SKILL.md`

```yaml
---
name: alpha-research
description: Search, read, and query research papers via the alpha CLI (alphaXiv-backed). Use for academic paper search, full-text reading, paper Q&A, code repository inspection, and annotation management.
---

# Alpha Research CLI

Use the `alpha` CLI via bash for all paper research operations.

## Auth Check (CRITICAL — do this FIRST)

Before using any alpha command, check authentication:

```bash
alpha status
````

If the response indicates no authentication (or the command fails with an auth error):

1. Tell the user: "The alpha CLI requires an alphaXiv account for paper search, reading, and Q&A. You can set up access by running `alpha login`, or I can guide you through the process."
2. Wait for the user's response before proceeding.
3. If the user explicitly declines ("I don't want to create an account" / "skip alpha" / "use arxiv instead" / "no"):
   → Fall back to the `arxiv-search` skill for paper search (limited: titles and abstracts only, no full text, no Q&A, no annotations).
   → For paper reading beyond abstracts, use `webfetch` on arxiv HTML pages where available.
4. If the user agrees:
   → Guide them through `alpha login` and then continue with alpha CLI.

Do NOT silently skip alpha and use arxiv-search without asking. Only fall back when the user explicitly declines.

## Commands

| Command                              | Description                                                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `alpha search "<query>"`             | Search papers. Prefer `--mode semantic` by default; use `--mode keyword` only for exact-term lookup and `--mode agentic` for broader retrieval. |
| `alpha get <arxiv-id-or-url>`        | Fetch paper content and any local annotation                                                                                                    |
| `alpha get --full-text <arxiv-id>`   | Get raw full text instead of AI report                                                                                                          |
| `alpha ask <arxiv-id> "<question>"`  | Ask a question about a paper's PDF                                                                                                              |
| `alpha code <github-url> [path]`     | Read files from a paper's GitHub repo. Use `/` for overview                                                                                     |
| `alpha annotate <paper-id> "<note>"` | Save a persistent annotation on a paper                                                                                                         |
| `alpha annotate --clear <paper-id>`  | Remove an annotation                                                                                                                            |
| `alpha annotate --list`              | List all annotations                                                                                                                            |

## Auth Setup

```bash
alpha login
```

This opens an authentication flow with alphaXiv. Once authenticated, `alpha status` will show the account info.

## Examples

```bash
alpha search "transformer scaling laws"
alpha search --mode agentic "efficient attention mechanisms for long context"
alpha get 2106.09685
alpha ask 2106.09685 "What optimizer did they use?"
alpha code https://github.com/karpathy/nanoGPT src/model.py
alpha annotate 2106.09685 "Key paper on LoRA - revisit for adapter comparison"
```

## When to use

- Academic paper search, reading, Q&A → `alpha` CLI
- Current topics (products, releases, docs) → `websearch`
- Mixed topics → combine both

## Fallback Behavior

When alpha is unavailable (user declined account):

- Paper search: use `/arxiv-search` skill
- Paper abstracts: `webfetch` on `https://arxiv.org/abs/<id>`
- Paper full text (HTML): `webfetch` on `https://arxiv.org/html/<id>` (available for many papers)
- Paper Q&A: NOT available without alpha — read the full text yourself and answer based on content
- Code inspection: `webfetch` on GitHub repo pages (limited, no file-level access)
- Annotations: NOT available without alpha

````

### Auth flow implementation

The auth check is done by the LLM itself (not by Aether's runtime). When the skill is loaded into the session via skill_refs, the LLM reads the "Auth Check (CRITICAL)" instruction and runs `alpha status` via bash. If it fails, the LLM uses the `question` tool to ask the user. This integrates naturally with Aether's existing permission-ask flow.

The fallback to arxiv-search is also LLM-driven — the LLM switches to calling the arxiv-search skill (which invokes a Python script) instead of alpha CLI commands. No runtime code changes needed.

### alpha CLI installation

The alpha CLI must be available in the execution environment. This is a prerequisite that should be documented in AGENTS.md or the skill itself. If `alpha` is not installed, the LLM should tell the user how to install it (similar to the auth flow).

### Files Changed

| File | Change |
|---|---|
| `.opencode/skills/alpha-research/SKILL.md` | New skill — alpha CLI with auth-first design |

---

## Change D: source-comparison Skill

### Feynman's Implementation

Feynman's source-comparison is a **skill that routes to a slash command prompt**. The architecture is three layers:

1. **SKILL.md** (routing entry): "Run the `/compare` workflow. Agents used: researcher, verifier. Output: comparison matrix."
2. **Slash command prompt** (`prompts/compare.md`): Detailed execution instructions — derive slug, plan comparison dimensions, use researcher subagent for gathering, verifier for citation anchoring, build comparison matrix (source, key claim, evidence type, caveats, confidence), generate charts for quantitative metrics, distinguish agreement/disagreement/uncertainty, save to `outputs/<slug>-comparison.md`.
3. **Agents**: researcher and verifier are invoked during the workflow.

### Aether's Adaptation

Aether has no slash command expansion system (Feynman's Pi runtime provides this). But Aether has the **Command system** (`packages/opencode/src/command/index.ts`) which automatically registers skills as `/skill-name` commands. When a user types `/source-comparison topic`, the skill content is injected into the session.

The key design decision: **the skill should work in any mode, not just research mode**. When in research mode, it triggers the full workflow (Phase 0 Intent Gate → methodology-comparison → researcher subagents → verifier → deliver). When in other modes, it does a lighter inline comparison.

**File**: `.opencode/skills/source-comparison/SKILL.md`

```yaml
---
name: source-comparison
description: Compare multiple sources on a topic and produce a grounded comparison matrix. Use when comparing papers, tools, approaches, or claims across sources.
---

# Source Comparison

Compare sources for: $@

Derive a short slug from the comparison topic (lowercase, hyphens, no filler words, ≤5 words). Use this slug for all output files.

## In Research Mode

If you are in research mode (the research agent), follow the full research workflow:
1. Classify intent as methodology-comparison in Phase 0 (Intent Gate).
2. Plan comparison dimensions and sources. Write plan to outputs/.plans/<slug>.md.
3. Dispatch researcher subagents to gather evidence for each source.
4. Build the comparison matrix covering: source, key claim, evidence type, caveats, confidence.
5. Dispatch verifier subagent for citation anchoring.
6. Deliver to outputs/<slug>-comparison.md with provenance sidecar.

## In Other Modes

If you are not in research mode (e.g., build or plan mode), do an inline comparison:
1. Use websearch/webfetch to gather source material directly.
2. If alpha CLI is available (alpha-research skill), use it for academic sources.
3. Build a comparison matrix: source, key claim, evidence type, caveats, confidence.
4. Distinguish agreement, disagreement, and uncertainty clearly.
5. Present the comparison inline. Optionally write to a file if the comparison is large.

## Comparison Matrix Format

| Source | Key Claim | Evidence Type | Caveats | Confidence |
|--------|-----------|---------------|---------|------------|
| [1] Paper A | ... | primary/secondary/self-reported | ... | high/medium/low |
| [2] Tool B docs | ... | ... | ... | ... |

For quantitative metrics, generate charts if possible.
For method/architecture comparisons, use Mermaid diagrams.

End with a Sources section containing direct URLs for every source used.
````

### Files Changed

| File                                          | Change                                                |
| --------------------------------------------- | ----------------------------------------------------- |
| `.opencode/skills/source-comparison/SKILL.md` | New skill — source comparison with mode-aware routing |

---

## Change E: paper-code-audit Skill

### Feynman's Implementation

Same three-layer pattern as source-comparison:

1. **SKILL.md** (routing): "Run the `/audit` workflow. Agents used: researcher, verifier."
2. **Slash command prompt** (`prompts/audit.md`): Plan audit (paper + repo + claims), use researcher for evidence gathering, verifier for citation anchoring, compare claimed methods/defaults/metrics/data handling against actual code, call out missing code/mismatches/ambiguous defaults/reproduction risks, deliver to `outputs/<slug>-audit.md`.
3. **Agents**: researcher + verifier.

### Aether's Adaptation

Same mode-aware design as source-comparison.

**File**: `.opencode/skills/paper-code-audit/SKILL.md`

```yaml
---
name: paper-code-audit
description: Compare a paper's claims against its public codebase and identify mismatches, omissions, and reproducibility risks. Use for auditing papers, checking code-claim consistency, and verifying reproducibility.
---

# Paper-Code Audit

Audit the paper and codebase for: $@

Derive a short slug from the audit target (lowercase, hyphens, no filler words, ≤5 words).

## In Research Mode

If you are in research mode (the research agent), follow the full research workflow:
1. Classify intent in Phase 0 (Intent Gate).
2. Plan audit: identify paper claims and corresponding code. Write plan to outputs/.plans/<slug>.md.
3. Dispatch researcher subagents to:
   - Read the paper (use alpha get / alpha ask for detailed Q&A)
   - Inspect the code repo (use alpha code for file-level inspection)
4. Compare claimed methods, defaults, metrics, and data handling against actual code.
5. Call out: missing code, mismatches, ambiguous defaults, reproduction risks.
6. Dispatch verifier subagent for citation anchoring.
7. Deliver to outputs/<slug>-audit.md with provenance sidecar.

## In Other Modes

If you are not in research mode:
1. Use webfetch to read the paper (arxiv HTML or PDF).
2. Use alpha code (if available) or webfetch to read the repo files.
3. Compare claims vs code inline.
4. Present findings inline or write to a file.

## Audit Dimensions

- **Method match**: Does the code implement what the paper describes?
- **Default divergence**: Do code defaults differ from paper-reported settings?
- **Metric consistency**: Are evaluation metrics computed the same way?
- **Data handling**: Is dataset processing consistent between paper description and code?
- **Missing code**: Are any claimed features or experiments not present in the repo?
- **Reproduction risk**: Can the results be reproduced from the code alone?

End with a Sources section containing paper URL and repository URL.
```

### Files Changed

| File                                         | Change                                               |
| -------------------------------------------- | ---------------------------------------------------- |
| `.opencode/skills/paper-code-audit/SKILL.md` | New skill — paper-code audit with mode-aware routing |

---

## Change F: Skill Isolation via skill_refs

### Problem

The research agent currently has no `skill_refs` field, so it sees ALL skills (filtered by permission). This means:

- `deep-research` skill (persona + 5-step workflow) is visible — conflicts with research agent's own 7-phase workflow
- `academic-researcher` skill (persona + 5-phase sequential analysis) is visible — conflicts with researcher subagent
- `peer-review` skill (7-stage systematic review) is visible — conflicts with reviewer subagent
- Non-research skills (docx, ppt-generation, Excel Analysis, etc.) are visible — irrelevant noise

### Design: Explicit skill_refs on research agent and researcher subagent

**Research agent** (`research.md`):

```yaml
skill_refs:
  - alpha-research # Paper search/read/Q&A/annotate
  - arxiv-search # Fallback for alpha (titles/abstracts only)
  - source-comparison # Multi-source comparison matrix
  - paper-code-audit # Paper vs code consistency
  - literature-review # Systematic literature review
  - docker # Isolated execution environment
```

Not included (and why):

- `deep-research` — persona skill, conflicts with research agent's own workflow
- `academic-researcher` — persona skill, conflicts with researcher subagent
- `peer-review` — conflicts with reviewer subagent (reviewer is dispatched as subagent, not as skill)
- `scientific-brainstorming` — not a research workflow skill
- `scientific-critical-thinking` — reviewer subagent covers this
- `writer-paper` — research agent writes in its own workflow, verifier/reviewer handle quality
- `docx`, `ppt-generation`, `Excel Analysis` — not research-relevant
- `skill-creator`, `skill-manager`, `skill-security-auditor` — meta skills, not research-relevant
- `brainstorming`, `code-reviewer`, `prepare-for-git-commit`, `static-check-for-git-commit` — not research-relevant

**Researcher subagent** (`researcher.md`):

```yaml
skill_refs:
  - alpha-research # Paper search/read/Q&A
  - arxiv-search # Fallback
```

Only search skills — researcher gathers evidence, doesn't do comparison/audit/review.

**Verifier subagent**: No skill_refs. It's a pure tool operator — behavior defined entirely by its prompt (verifier.txt). It only needs read, write, edit, glob, grep, websearch, webfetch, bash(curl/wget) — all granted by permission, no skill guidance needed.

**Reviewer subagent**: No skill_refs. Same rationale — pure tool operator, behavior defined by reviewer.txt.

**Feynman's approach for verifier/reviewer**: Same — Feynman's verifier and reviewer agents have no skill references. They only use base tools (read, bash, grep, write, edit, web_search, fetch_content). Skills are for lead agents and researcher, not for post-processing agents.

### skill_refs overlap is OK

alpha-research and arxiv-search appear in both research agent and researcher subagent skill_refs. This is correct — both roles need paper search capability, but use it differently:

- Research agent uses alpha directly in direct-search mode (0 subagents)
- Researcher subagent uses alpha when gathering evidence

skill_refs is a visibility list, not exclusive ownership. Overlap is fine.

### skill_refs enforcement mechanism

The skill filtering code in `packages/opencode/src/skill/index.ts` (line 1131-1134):

```ts
if (agent.skillRefs?.length) {
  const refs = new Set(agent.skillRefs)
  return list.filter((skill) => refs.has(skill.name))
}
```

If skill_refs is set, ONLY those skills are visible. If unset, ALL skills filtered by permission are visible. So setting skill_refs on research agent automatically hides all non-research skills.

For subagents: when the task tool creates a subagent session, the subagent inherits its agent definition's skill_refs. The system prompt builder (`packages/opencode/src/session/system.ts` line 60-71) reads skill_refs and only injects those skills into the subagent's system prompt. No runtime code changes needed.

### Files Changed

| File                          | Change                               |
| ----------------------------- | ------------------------------------ |
| `.aether/agent/research.md`   | Add `skill_refs` field with 6 skills |
| `.aether/agent/researcher.md` | Add `skill_refs` field with 2 skills |

---

## Change G: Autoresearch and Replication Skills (Future)

### Why this is "future" not "now"

Feynman's autoresearch and replication workflows depend on experiment management tools (`init_experiment`, `run_experiment`, `log_experiment`) from the `pi-autoresearch` package. Aether doesn't have equivalent tools. Implementing these requires:

1. Creating Aether-specific experiment management tools (or adapting pi-autoresearch)
2. Adding experiment state persistence (autoresearch.md, autoresearch.jsonl)
3. Building a commit/revert mechanism for experiment iterations
4. Adding resume/clear subcommands

This is a significant engineering effort beyond the current scope. For now, we create placeholder skill definitions that route to the research agent workflow, with the experiment execution deferred to manual user action or future tool support.

### Autoresearch Skill (Placeholder)

**File**: `.opencode/skills/autoresearch/SKILL.md`

```yaml
---
name: autoresearch
description: Autonomous experiment loop — try ideas, measure results, keep what works, discard what doesn't. Use when the user asks to optimize a metric, run an experiment loop, or automate benchmarking. Currently limited to planning and analysis; automated execution tools are pending.
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
```

### Replication Skill (Placeholder)

**File**: `.opencode/skills/replication/SKILL.md`

```yaml
---
name: replication
description: Plan or execute a replication of a paper, claim, or benchmark. Use when the user asks to replicate results, reproduce an experiment, or verify a claim empirically. Currently supports planning and partial execution; full automated replication is pending.
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
```

### Files Changed

| File                                     | Change                                      |
| ---------------------------------------- | ------------------------------------------- |
| `.opencode/skills/autoresearch/SKILL.md` | New skill — placeholder for experiment loop |
| `.opencode/skills/replication/SKILL.md`  | New skill — placeholder for replication     |

---

## Change H: Skill Conflict Resolution Design Principle

### Principle: Skills should NOT force mode-switching

The user explicitly disagrees with "recommend switching to research mode" in skill content. The correct approach:

| Mode            | Skill behavior                                   | Example                                                                                 |
| --------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Research mode   | Full workflow (Phase 0-6, subagents, provenance) | source-comparison → researcher subagents → verifier → provenance sidecar                |
| Build/Plan mode | Lightweight inline execution                     | source-comparison → direct websearch + manual comparison matrix                         |
| Any mode        | Same skill is visible, different behavior        | Skill content says "if in research mode, follow workflow; if in other modes, do inline" |

Skills like `deep-research` and `academic-researcher` are persona skills that work in any mode. They are NOT in the research agent's skill_refs because they conflict with the research agent's own workflow — but they remain visible to build/plan agents (which have no skill_refs restriction). Users can do lightweight research in build mode using these persona skills, and switch to research mode when they want the full workflow with subagents and provenance.

This is a **layered service** design, not a **blocking** design:

- Layer 1 (any mode): persona skills for lightweight inline research
- Layer 2 (research mode): full workflow with subagents, verifier, reviewer, provenance

### Files Changed

No file changes — this is a design principle documented here for reference. All skill content (source-comparison, paper-code-audit, etc.) already follows this pattern with "In Research Mode" / "In Other Modes" sections.

---

## Implementation Order

| Priority | Change                                           | Dependencies                                           | Effort                                                          |
| -------- | ------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------- |
| 1        | Change I: Two-tier workflow (lightweight + deep) | None — prompt redesign only                            | Medium — restructure research.md prompt_append                  |
| 2        | Change A: Researcher subagent                    | None (base_agent: explore already exists)              | Small — create .aether/agent/researcher.md + update research.md |
| 3        | Change B: Research agent bash + docker           | Change A (researcher also needs bash for alpha)        | Small — config change + docker skill creation                   |
| 4        | Change C: alpha-research skill                   | Change B (bash must be available for alpha CLI)        | Small — skill creation                                          |
| 5        | Change J: literature-review skill rewrite        | Change I (routing pattern aligns with two-tier design) | Medium — rewrite 585-line persona skill to lean routing skill   |
| 6        | Change K: skill_refs append semantics            | None (one-line code change)                            | Small — modify agent.ts line ~423                               |
| 7        | Change D: source-comparison skill                | None                                                   | Small — skill creation                                          |
| 8        | Change E: paper-code-audit skill                 | None                                                   | Small — skill creation                                          |
| 9        | Change F: Skill isolation (skill_refs)           | Change A, C, D, E, J (need all skills to exist first)  | Small — add skill_refs fields                                   |
| 10       | Change G: autoresearch/replication placeholders  | Change B (docker)                                      | Small — placeholder skills                                      |
| 11       | Change L: Lean routing skill principle           | None                                                   | Documentation only                                              |

**Recommended commit strategy**:

- Commit 1: Change I (two-tier workflow redesign of research.md prompt) — this is the most impactful change and should come first
- Commit 2: Change A (researcher subagent) + Change B (bash permission + docker skill)
- Commit 3: Change C (alpha-research) + Changes D+E (source-comparison + paper-code-audit)
- Commit 4: Change J (literature-review rewrite) + Change K (skill_refs append semantics)
- Commit 5: Change F (skill_refs on research.md + researcher.md) + Change G (placeholder skills)

Each commit must pass `bun typecheck` in `packages/opencode`.

---

## Testing Strategy

| Change   | Tests                                                                                                                                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change A | Verify researcher agent loads with base_agent: explore; verify prompt_append contains Integrity Commandments; verify skill_refs=[alpha-research, arxiv-search] filters correctly; verify researcher subagent is accessible via task tool            |
| Change B | Verify `bash: allow` + `env_scope.allowed_commands` compiles to correct bash Rules via compileDiscipline; verify docker commands are allowed, others denied; verify docker skill content is complete (GPU, persistent containers, base images)      |
| Change C | Verify alpha-research skill content contains auth-check-first instruction; verify fallback path mentions arxiv-search only on explicit user decline; verify skill registers as `/alpha-research` command                                            |
| Change D | Verify source-comparison skill has mode-aware sections; verify skill registers as `/source-comparison` command                                                                                                                                      |
| Change E | Verify paper-code-audit skill has mode-aware sections; verify skill registers as `/paper-code-audit` command                                                                                                                                        |
| Change F | Verify research.md skill_refs=[6 skills] filters Skill.available(); verify researcher.md skill_refs=[2 skills] filters correctly; verify verifier/reviewer have no skill_refs; verify build agent still sees ALL skills (no skill_refs restriction) |
| Change G | Verify placeholder skills exist and register as commands; verify they indicate current limitations clearly                                                                                                                                          |

---

## Complete File Inventory

### New files

| File                                          | Type             | Content                                                                                                                                                |
| --------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.aether/agent/researcher.md`                 | Agent definition | Researcher subagent with base_agent: explore, Integrity Commandments, Evidence Table format, ML Recipe mode, skill_refs=[alpha-research, arxiv-search] |
| `.opencode/skills/docker/SKILL.md`            | Skill            | Full Feynman docker content (GPU, persistent containers, base images, network isolation)                                                               |
| `.opencode/skills/alpha-research/SKILL.md`    | Skill            | alpha CLI with auth-check-first, explicit-decline fallback to arxiv-search                                                                             |
| `.opencode/skills/source-comparison/SKILL.md` | Skill            | Mode-aware comparison: full workflow in research mode, inline in other modes                                                                           |
| `.opencode/skills/paper-code-audit/SKILL.md`  | Skill            | Mode-aware audit: researcher+verifier in research mode, inline in other modes                                                                          |
| `.opencode/skills/autoresearch/SKILL.md`      | Skill            | Placeholder — experiment loop planning without automated execution tools                                                                               |
| `.opencode/skills/replication/SKILL.md`       | Skill            | Placeholder — replication planning with docker execution support                                                                                       |

### Modified files

| File                        | Change                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.aether/agent/research.md` | (1) `bash: allow` + `env_scope.allowed_commands` adding docker; (2) `scale_decision.subagent_type` from explore to researcher; (3) `skill_refs` field with 6+ skills; (4) Phase 2 prompt references researcher; (5) FORBIDDEN section updated; (6) **Two-tier workflow redesign** — add Lightweight Tier section before Deep Tier, add "Stop here" after lightweight |

### Unchanged files (verified correct)

| File                                              | Reason                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/opencode/src/agent/agent.ts`            | verifier and reviewer already defined as native subagents — no changes needed                |
| `packages/opencode/src/agent/prompt/verifier.txt` | Already complete — Integrity Rules, Citation Rules, Provenance Sidecar, Output Contract      |
| `packages/opencode/src/agent/prompt/reviewer.txt` | Already complete — Structured Review + Inline Annotations, Severity Grading, Integrity Rules |
| `.opencode/skills/arxiv-search/SKILL.md`          | Already exists — serves as alpha-research fallback, no changes needed                        |
| `.opencode/skills/literature-review/SKILL.md`     | **NEEDS REWRITE** — see Change J below                                                       |

---

## Change I: Two-Tier Workflow Design (Lightweight + Deep)

### Problem

The current research.md forces every request through the same 7-phase pipeline (Plan → Gather → Draft → Cite → Review → Deliver), regardless of intent complexity. A quick-lookup question like "what is CRISPR?" goes through:

1. Phase 0: Intent Gate → quick-lookup (correct)
2. Phase 1: Write plan file with 5 fields (task ledger, verification log, etc.) — **overkill for a simple question**
3. Phase 2: 3 searches + write research-direct.md — reasonable
4. Phase 3: Write formal draft.md (executive summary, findings, source refs, caveats, open questions) — **overkill**
5. Phase 4: Self-citation + URL verification + write cited.md — **overkill for a simple explanation**
6. Phase 5: Self-review + write review.md with FATAL/MAJOR/MINOR grading — **overkill**
7. Phase 6: Copy to final.md + provenance.md + disk verification — **overkill**

A simple question triggers **6+ files** (plan, research-direct, draft, cited, review, final, provenance) when it only needs a direct inline answer.

### Feynman's Approach

Feynman's deep-research workflow has an explicit fast lane:

> **Simple explainer** → just search (3-10 tool calls), answer directly. Do not write plan file, do not dispatch subagents, do not run verifier/reviewer.

The full 7-phase pipeline is only for "broad investigation" and "multi-domain complex research".

### Design: Two-Tier Workflow

Replace the current "always 6 phases" design with a conditional two-tier structure:

| Tier            | Intent Categories                                                           | Process                                                                                                                            | File Output                                        |
| --------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Lightweight** | quick-lookup, explainer, knowledge-survey                                   | Search → inline answer (3-10 tool calls). No plan file, no draft/cite/review pipeline, no provenance sidecar. Update notepad only. | 0 files (notepad updates)                          |
| **Deep**        | methodology-comparison, feasibility-study, literature-review, deep-research | Full Phase 1-6 pipeline with plan file, draft, verifier, reviewer, provenance                                                      | plan + draft + cited + review + final + provenance |

The Intent Gate (Phase 0) determines which tier. The lightweight tier skips Phases 1-6 entirely and answers directly. The deep tier runs the full pipeline.

### Updated prompt_append Structure

The research.md prompt_append should be restructured:

```
## Research Workflow

### Phase 0: Intent Gate

Classify intent → determines workflow tier:

| Intent | Tier | Strategy |
|--------|------|----------|
| quick-lookup | Lightweight | Direct search, inline answer |
| explainer | Lightweight | Direct search, structured answer |
| knowledge-survey | Lightweight | 2-4 searches, brief overview |
| methodology-comparison | Deep | Full pipeline (Plan → Gather → Draft → Cite → Review → Deliver) |
| feasibility-study | Deep | Full pipeline |
| literature-review | Deep | Full pipeline |
| deep-research | Deep | Full pipeline |

NEVER spawn subagents for Lightweight intents.

### Lightweight Tier (quick-lookup, explainer, knowledge-survey)

1. Search — use websearch/webfetch/alpha-research. Minimum 2-3 queries for explainer and knowledge-survey; 1-2 for quick-lookup.
2. Answer directly — respond inline to the user. No formal draft, no citation pipeline, no provenance.
3. Update notepad — record sources and findings in notepad files (sources.md, findings.md). This preserves context for future questions in the same session.
4. Integrity Commandments still apply — do not fabricate sources, cite URLs, mark inferences.

Stop here. Do not proceed to Deep Tier phases.

### Deep Tier (methodology-comparison, feasibility-study, literature-review, deep-research)

Derive a slug (lowercase, hyphens, ≤5 words). All files use this slug as prefix.

#### Phase 1: Plan
... [unchanged — write plan file, confirmation gate for deep-research/literature-review]

#### Phase 2: Gather
... [unchanged — dispatch researcher subagents]

#### Phase 3: Draft
... [unchanged — write formal draft.md]

#### Phase 4: Cite (Verifier)
... [unchanged — dispatch verifier subagent or self-cite]

#### Phase 5: Review (Reviewer)
... [unchanged — dispatch reviewer subagent or self-review]

#### Phase 6: Deliver
... [unchanged — copy final + provenance sidecar + disk verification]
```

### Why this won't cause problems

1. **Integrity Commandments still apply to lightweight tier** — the LLM still sees the Integrity Commandments in the prompt_append. It won't fabricate sources even in lightweight mode.

2. **Lightweight tier still updates notepad** — sources and findings are recorded, preserving context for follow-up questions. If the user later asks a deeper question, the research agent has prior context.

3. **Notepad-only output means the user gets an immediate answer** — no waiting for 6 phases of pipeline. This is what users expect for simple questions.

4. **Deep tier is unchanged** — the full pipeline with plan/cite/review/provenance still runs for complex intents. No quality loss for serious research.

5. **The tier decision is made once, at Phase 0** — no ambiguity about which path to follow. The LLM won't accidentally skip phases for a deep-research intent, because Phase 0 explicitly maps each intent to a tier.

### Files Changed

| File                        | Change                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.aether/agent/research.md` | Restructure prompt_append: add "Lightweight Tier" section before "Deep Tier" section; add "Stop here" instruction after lightweight tier; keep deep tier phases unchanged |

---

## Change J: literature-review Skill Adaptation

### Problem

The current `literature-review/SKILL.md` (585 lines) has several issues when used within the research agent's skill_refs:

1. **References non-existent skills**: `gget`, `bioservices`, `datacommons-client`, `scientific-schematics` — Aether doesn't have these. The LLM will try to follow instructions like "use `gget search pubmed`" and fail.

2. **Mandatory figure generation**: "⚠️ MANDATORY: Every literature review MUST include at least 1-2 AI-generated figures using the scientific-schematics skill" — scientific-schematics doesn't exist in Aether.

3. **No mode-aware routing**: The skill is a pure persona ("you are conducting a systematic review"), with its own 7-phase workflow. In research mode, this conflicts with the research agent's own Phase 0-6 workflow. If the user types `/literature-review topic` while in research mode, the LLM sees two conflicting workflows (research agent's + skill's).

4. **Feynman `allowed-tools` format**: `allowed-tools: [Read, Write, Edit, Bash]` — this is Feynman-specific syntax, not Aether's Permission system.

5. **References bundled scripts**: `scripts/search_databases.py`, `scripts/verify_citations.py`, `scripts/generate_pdf.py` — these scripts exist in the skill directory but may not work in Aether's environment.

### Design: Rewrite as Lean Routing Skill

The skill should be rewritten as a **routing skill** — lean SKILL.md that points to the research agent's workflow, not a self-contained persona with its own 7-phase process.

**Routing skill pattern** (same as source-comparison and paper-code-audit):

```
SKILL.md (lean, ~50 lines) → routes to research agent workflow
Full execution instructions → in research.md prompt_append (Deep Tier Phase 1-6)
In non-research modes → lightweight inline execution
```

**File**: `.opencode/skills/literature-review/SKILL.md` (rewrite)

```yaml
---
name: literature-review
description: Conduct systematic literature reviews with verified citations, PICO scoping, and PRISMA-style screening. Use when conducting systematic reviews, meta-analyses, scoping reviews, or comprehensive literature searches.
---

# Literature Review

Conduct a systematic literature review for: $@

Derive a short slug from the review topic (lowercase, hyphens, ≤5 words).

## In Research Mode

If you are in research mode (the research agent), follow the Deep Tier workflow:
1. Classify intent as literature-review in Phase 0 (Intent Gate).
2. Plan — define research question using PICO framework, set inclusion/exclusion criteria, choose databases.
   Write plan to outputs/.plans/<slug>.md. This intent REQUIRES user confirmation before proceeding.
3. Gather — dispatch researcher subagents for multi-database search.
4. Draft — write the review organized thematically (NOT study-by-study).
5. Cite — dispatch verifier subagent for citation anchoring and URL verification.
6. Review — dispatch reviewer subagent for quality check.
7. Deliver — final review + provenance sidecar to outputs/<slug>.md.

## In Other Modes

If you are not in research mode, do an inline literature review:
1. Define scope — PICO question, inclusion/exclusion criteria.
2. Search — use websearch, alpha-research (if available), and arxiv-search for academic sources.
3. Screen — filter results by inclusion/exclusion criteria. Track counts (similar to PRISMA).
4. Synthesize — organize findings thematically, not study-by-study.
5. Cite — verify key URLs with webfetch. Add inline citations [1], [2].
6. Present — inline response with numbered Sources section.

## Review Structure

- Abstract / Summary
- Introduction (research question, PICO, scope)
- Methods (search strategy, databases, screening criteria, PRISMA counts)
- Results (thematic synthesis, evidence tables)
- Discussion (agreements, disagreements, gaps, future directions)
- References (numbered, with URLs)

## Source Quality
- Prefer: peer-reviewed papers, official reports, primary datasets
- Accept with caveats: well-cited secondary sources, established trade publications
- Reject: no author/date, AI-generated without primary backing

End with a Sources section containing direct URLs for every source used.
```

**What to remove from the old SKILL.md**:

- All references to gget, bioservices, datacommons-client, scientific-schematics
- The mandatory figure generation requirement
- The `allowed-tools` frontmatter field
- The bundled scripts references (search_databases.py, verify_citations.py, generate_pdf.py)
- The 585-line self-contained 7-phase persona workflow

**What to keep from the old SKILL.md**:

- The PICO framework concept
- The PRISMA screening methodology
- The thematic synthesis principle (NOT study-by-study)
- The source quality hierarchy
- The inclusion/exclusion criteria guidance

These concepts are captured in the lean routing SKILL.md above, and the detailed methodology can be placed in a `references/` subdirectory that the LLM reads when needed:

**File**: `.opencode/skills/literature-review/references/methodology.md` (new)

This file contains the detailed PICO, PRISMA, screening, and citation verification methodology from the old SKILL.md — but stripped of external skill references. The LLM reads this file only when doing a literature review (the routing SKILL.md says "use PICO framework" and the LLM may naturally read the references file for detail).

The old bundled scripts (`scripts/search_databases.py`, `scripts/verify_citations.py`, `scripts/generate_pdf.py`) can be kept in the skill directory but should NOT be referenced in SKILL.md. They're available for advanced users who want to use them directly, but the LLM won't be instructed to call them.

### Files Changed

| File                                                           | Change                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `.opencode/skills/literature-review/SKILL.md`                  | Full rewrite — lean routing skill with mode-aware sections, remove all external skill references |
| `.opencode/skills/literature-review/references/methodology.md` | New file — PICO, PRISMA, screening, source quality methodology (extracted from old SKILL.md)     |

---

## Change K: skill_refs Append Semantics

### Problem

Current `skill_refs` in config uses nullish coalescing (`??`), meaning config **replaces** the entire list rather than appending to it. To add one new skill, the user must list all 6+ existing skills plus the new one.

```ts
// agent.ts line 423:
item.skillRefs = value.skill_refs ?? item.skillRefs // wholesale replacement
```

### Design: Append Semantics

Change to merge semantics — config entries are appended to the base list, not replacing it. This allows users to add project-specific skills without rewriting the entire list.

```ts
// agent.ts line 423 — change from:
item.skillRefs = value.skill_refs ?? item.skillRefs

// change to:
if (value.skill_refs) {
  const base = item.skillRefs ?? []
  const extras = value.skill_refs.filter((ref) => !base.includes(ref))
  item.skillRefs = [...base, ...extras]
}
```

**Example**: A quantum field theory researcher wants to add their custom skills:

```json
// opencode.json
{
  "agent": {
    "research": {
      "skill_refs": ["perturbative-qft", "lattice-gauge-theory"]
    }
  }
}
```

Result: research agent's skill_refs = [alpha-research, arxiv-search, source-comparison, paper-code-audit, literature-review, docker, perturbative-qft, lattice-gauge-theory]

The base 6 skills from `.aether/agent/research.md` are preserved, and the 2 project-specific skills are appended. No need to list the 6 base skills again.

**Deletion**: To remove a skill, the user can use a config override. But this is unlikely needed — if a skill is irrelevant, the LLM simply won't invoke it. If a skill is harmful (e.g., conflicts with workflow), it shouldn't be in the base list at all.

### Files Changed

| File                                   | Change                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/opencode/src/agent/agent.ts` | Change `skill_refs` merge from `??` (replacement) to append (filter + concat), line ~423 |

---

## Change L: Lean Routing Skill Design Principle

### Problem

Current skills like `deep-research` (5-step persona workflow), `academic-researcher` (5-phase sequential analysis), and `literature-review` (7-phase systematic review) are **persona skills** — they define their own complete workflow in SKILL.md. When these skills are invoked via `/command` in a session where the agent already has its own workflow (e.g., research agent's Phase 0-6), the LLM sees two conflicting workflows and may get confused.

Persona skills also have very long SKILL.md files (literature-review: 585 lines, academic-researcher: similar length), which consume context window space when injected via skill_refs.

### Design Principle: Routing Skills vs Persona Skills

| Skill type        | SKILL.md length | Content                                                                                                  | Works with agent workflow?       | Context cost |
| ----------------- | --------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------ |
| **Routing skill** | ~50 lines       | Mode-aware routing + brief instructions. "In research mode: follow workflow. In other modes: do inline." | ✅ Complements agent workflow    | Low          |
| **Persona skill** | 200-600 lines   | Complete self-contained workflow + output templates + examples                                           | ❌ Conflicts with agent workflow | High         |
| **Tool skill**    | ~30 lines       | CLI/API invocation instructions                                                                          | ✅ No workflow, just tool usage  | Low          |

For skills that are in a specialized agent's `skill_refs`, **only routing skills and tool skills should be used**. Persona skills belong to general agents (build, plan) where no specialized workflow exists.

**Specific rules**:

1. Skills in research agent's `skill_refs` must be routing skills or tool skills — NOT persona skills
2. Routing skill SKILL.md should be ≤100 lines — lean enough to not dominate the system prompt
3. Detailed methodology goes in `references/` subdirectory — the LLM reads it only when needed, not injected by default
4. Persona skills (deep-research, academic-researcher) remain available to build/plan agents (which have no skill_refs restriction) for lightweight inline research

### How this applies to existing skills

| Skill                 | Current type        | Should be                  | Action                          |
| --------------------- | ------------------- | -------------------------- | ------------------------------- |
| `source-comparison`   | Routing             | Routing                    | ✅ Already lean, ~60 lines      |
| `paper-code-audit`    | Routing             | Routing                    | ✅ Already lean, ~60 lines      |
| `alpha-research`      | Tool                | Tool                       | ✅ Already lean, ~60 lines      |
| `arxiv-search`        | Tool                | Tool                       | ✅ Already lean, ~30 lines      |
| `docker`              | Tool/Environment    | Tool/Environment           | ✅ Already lean, ~80 lines      |
| `literature-review`   | Persona (585 lines) | Routing                    | **Needs rewrite** — Change J    |
| `deep-research`       | Persona (long)      | NOT in research skill_refs | Keep for build/plan agents only |
| `academic-researcher` | Persona (long)      | NOT in research skill_refs | Keep for build/plan agents only |

### Files Changed

No code changes — this is a design principle. All new routing skills (source-comparison, paper-code-audit, literature-review rewrite) already follow this pattern.

---

1. **Should researcher subagent have `delegation_depth > 0`?** Currently the research workflow dispatches researcher with `delegation_depth: 0` (default in task tool). This means researcher cannot spawn its own subagents. For complex research tasks, a researcher might want to spawn explore subagents for codebase-specific searches while it focuses on web/paper searches. Recommendation: keep `delegation_depth: 0` for now — the lead agent can dispatch multiple researcher subagents for parallel searches instead of letting one researcher cascade. If this proves insufficient, increase to 1 in specific task calls.

2. **Should docker skill be in researcher subagent's skill_refs?** Currently researcher only has [alpha-research, arxiv-search]. Docker execution is typically done by the lead agent (research agent) or in a dedicated execution subagent. Recommendation: keep docker out of researcher's skill_refs. Researcher gathers evidence, doesn't run experiments. When autoresearch/replication workflows need docker, the lead agent handles it directly or dispatches a task with `permission_override: { bash: ["allow", "docker*"] }` to a general subagent.

3. **alpha CLI availability check**: The auth check in alpha-research skill checks `alpha status`. But what if `alpha` is not installed at all (command not found)? The skill should handle this: if `alpha status` fails with a "command not found" error, tell the user how to install alpha CLI, then fallback to arxiv-search only on explicit decline. This is a minor detail that the LLM will handle naturally.

4. **Should autoresearch/replication skills be in research agent's skill_refs now or later?** Recommendation: add them now as placeholders. They're visible in research mode but clearly state their limitations. When experiment management tools are implemented later, the skill content can be updated to include automated execution. Adding them now establishes the skill_refs intent and avoids needing a config change later.

5. **How does the `/command` triggering work for skills?** Aether's Command system (`packages/opencode/src/command/index.ts`) automatically registers skills as commands. When a user types `/alpha-research topic`, the Command system finds the skill by name and injects its content into the session. The `$@` placeholder in skill content gets replaced with the user's arguments. This is already implemented — no runtime changes needed for skill triggering.

6. **Should we add alpha CLI to env_scope.allowed_commands on researcher subagent?** The researcher inherits from explore, which has `bash: allow`. But explore's bash is unrestricted. If we want researcher's bash to be restricted (like the research agent), we need to add `env_scope.allowed_commands` to researcher.md. Recommendation: yes, add it for consistency:

   ```yaml
   env_scope:
     allowed_commands:
       - alpha
       - curl
       - rg
       - grep
       - git
   ```

   This ensures researcher's bash is also sandboxed, consistent with the research agent's approach.

7. **Modal and RunPod compute skills**: These are deferred to a future phase. When implemented, they should use Feynman's full content (not simplified) like the docker skill. They would be added to research agent's skill_refs only when GPU compute workflows (autoresearch with GPU benchmarks) are needed.

8. **Should skill content be injected at system prompt level instead of user message level?** Currently Aether's Command system injects skill content as a user message. Feynman injects at system prompt level, which gives stronger LLM compliance. Recommendation: do not change now — observe LLM behavior first. If the LLM frequently ignores skill routing instructions, consider changing injection level later. This requires modifying the Command system (`packages/opencode/src/session/prompt.ts` around line 2460).

9. **Lightweight tier intent classification reliability**: The LLM must correctly classify intents into lightweight vs deep. If it misclassifies a deep-research question as quick-lookup, it skips the full pipeline and delivers a shallow answer. Recommendation: monitor this in practice. The Intent Gate table is explicit (7 categories with clear criteria), and the LLM tends to follow tabular instructions well. If misclassification is frequent, add a safety net: "If after searching you discover the topic is more complex than initially assessed, reclassify and switch to Deep Tier."

10. **Should knowledge-survey be lightweight or deep?** Currently it's classified as lightweight (2-4 searches, brief overview). But some knowledge-surveys could be broad enough to warrant subagents. Recommendation: keep it lightweight with an escape clause: "If the survey reveals significant complexity, reclassify to deep-research and restart the full pipeline."
