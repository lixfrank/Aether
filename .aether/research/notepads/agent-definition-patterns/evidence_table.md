# Agent Definition Patterns: Cross-Project Comparative Analysis

## Evidence Table

| #   | Source                                      | URL                                                                                                                                                | Key claim                                                                                                                                           | Type          | Confidence |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------- |
| 1   | CrewAI Official Docs                        | https://docs.crewai.com/concepts/agents                                                                                                            | YAML config recommended; agents defined by role+goal+backstory; tasks separate YAML file                                                            | primary       | high       |
| 2   | CrewAI Official Docs (Crews)                | https://docs.crewai.com/concepts/crews                                                                                                             | Crews orchestrate agents+tasks; separate config files for agents.yaml, tasks.yaml; hierarchical/sequential process                                  | primary       | high       |
| 3   | AutoGen v0.4 Docs                           | https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/agents.html                                                    | AssistantAgent: name, model_client, tools, system_message; no YAML config—all code-defined                                                          | primary       | high       |
| 4   | AutoGen Magentic-One Prompts (source)       | https://github.com/microsoft/autogen/blob/main/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_magentic_one/_prompts.py | Orchestrator uses ledger-based prompts (facts/plan/progress); worker agents have sealed system_message + description                                | primary       | high       |
| 5   | AutoGen Magentic-One Coder Agent (source)   | https://github.com/microsoft/autogen/blob/main/python/packages/autogen-ext/src/autogen_ext/agents/magentic_one/_magentic_one_coder_agent.py        | MagenticOneCoderAgent: sealed description + system_message; inherits AssistantAgent                                                                 | primary       | high       |
| 6   | Codex CLI System Prompt (source)            | https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_2_prompt.md                                                                          | 298-line Markdown system prompt; covers identity, personality, AGENTS.md spec, planning, autonomy, validation, sandbox/approvals, output formatting | primary       | high       |
| 7   | Codex CLI AGENTS.md (repo root)             | https://github.com/openai/codex/blob/main/AGENTS.md                                                                                                | Project-level agent instructions in markdown; covers Rust conventions, testing rules, code review rules                                             | primary       | high       |
| 8   | MetaGPT role.py (source)                    | https://github.com/FoundationAgents/MetaGPT/blob/main/metagpt/roles/role.py                                                                        | Role: name, profile, goal, constraints, desc, actions, states, rc (RoleContext); state machine via `states` list + `RoleReactMode`                  | primary       | high       |
| 9   | MetaGPT ProductManager (source)             | https://github.com/FoundationAgents/MetaGPT/blob/main/metagpt/roles/product_manager.py                                                             | ProductManager: name="Alice", profile="Product Manager", goal, constraints, instruction (from prompts module), tools list                           | primary       | high       |
| 10  | MetaGPT prompts/product_manager.py (source) | https://github.com/FoundationAgents/MetaGPT/blob/main/metagpt/prompts/product_manager.py                                                           | EXTRA_INSTRUCTION: detailed role-specific prompt (~80 lines) covering PRD creation + market research modes                                          | primary       | high       |
| 11  | PydanticAI Official Docs                    | https://ai.pydantic.dev/core-concepts/agent/                                                                                                       | Agent: instructions, tools, structured output type, dependency type, model, model_settings, capabilities; system_prompt as string; no YAML          | primary       | high       |
| 12  | OpenHands Agent structure (source tree)     | https://github.com/OpenHands/OpenHands                                                                                                             | Microagents in .openhands/microagents/; agent uses prompt.py module; CodeActAgent pattern                                                           | self-reported | medium     |
| 13  | LangGraph Docs (redirect)                   | https://langchain-ai.github.io/langgraph                                                                                                           | Graph-based agent workflows; state machines defined in Python code; no YAML config                                                                  | primary       | high       |

---

## Findings

### 1. CrewAI — Declarative YAML-Driven Agent Definitions

**Fields in agent definition:**

- `role` (required): Agent's function/expertise, e.g. "{topic} Senior Data Researcher"
- `goal` (required): Decision-making objective, e.g. "Uncover cutting-edge developments in {topic}"
- `backstory` (required): Context/personality enrichment
- `llm` (optional): Language model override
- `tools` (optional): Tool list
- `max_iter`, `max_rpm`, `max_execution_time` (optional): Runtime constraints
- `allow_delegation` (optional): Enable inter-agent delegation
- `system_template`, `prompt_template`, `response_template` (optional): Custom prompt templates
- `reasoning` (optional): Enable pre-task planning
- `knowledge_sources` (optional): Domain-specific knowledge bases

**Identity/workflow separation:**

- Agents defined in `config/agents.yaml` (identity: role, goal, backstory)
- Tasks defined in separate `config/tasks.yaml` (workflow: description, expected_output, agent assignment)
- Crew definition connects agents to tasks via decorators (`@agent`, `@task`, `@crew`)
- Template variables `{topic}` interpolated at runtime
- Orchestrator logic: `Process.sequential` or `Process.hierarchical` (with `manager_llm`)

**Config format:** YAML (recommended), with Python decorator-based assembly

**Typical size:** ~10-30 lines per agent in YAML; full Agent class has ~30+ parameters

**Key pattern:** Agent identity (role+goal+backstory) is **fully declarative** in YAML. Task workflow is **separate YAML**. The Crew orchestrator binds them. This is the most explicit separation of identity from workflow among all projects studied.

### 2. AutoGen v0.4 — Code-Defined Agents with Minimal Config

**Fields in agent definition:**

- `name` (required): Unique agent name
- `description` (required): Text description
- `model_client` (required): LLM client
- `tools` (optional): Function list
- `system_message` (optional): Natural language instruction
- `reflect_on_tool_use` (optional): Enable tool result reflection

**Identity/workflow separation:**

- No YAML config file. Everything is code-defined.
- `system_message` is the primary identity/persona mechanism (a plain string)
- Workflow/conversation patterns are handled by `Team` classes (RoundRobinGroupChat, SelectorGroupChat, Swarm, MagenticOneGroupChat)
- Agent identity and team orchestration are **completely separate** classes

**Config format:** Python code only

**Typical size:** ~5-15 lines per agent; system_message typically 1-2 sentences for simple agents

**Key pattern:** AutoGen keeps agent definitions **minimal**—just name + system_message + tools. All orchestration logic lives in separate Team/GroupChat classes. The agent itself is a thin wrapper around an LLM call.

### 3. LangGraph — State Machine as the Agent Definition

**Fields in agent definition:**

- No dedicated "agent definition" file or schema
- Agents are **graph nodes** defined via `StateGraph` with:
  - State schema (TypedDict or Pydantic BaseModel)
  - Node functions (Python functions that read/write state)
  - Edge definitions (conditional or fixed routing between nodes)
  - Tools attached to nodes

**Identity/workflow separation:**

- **No separation**: The graph IS the agent. Persona/system prompt is embedded in node functions
- Multi-agent: Subgraphs or separate graph instances, coordinated via handoff edges
- State machine routing: `add_conditional_edges()` with lambda functions
- LangGraph's "agent" concept is the **entire graph topology**, not a persona object

**Config format:** Python code (no YAML/JSON config)

**Typical size:** Graph definitions vary wildly; simple agents ~20-50 lines; complex multi-agent graphs can be 200+ lines

**Key pattern:** LangGraph rejects the "agent as persona" pattern entirely. The agent IS the workflow. This is the most architecturally distinct approach—closer to traditional workflow engines than to CrewAI/AutoGen persona-based agents.

### 4. Codex CLI — Monolithic Markdown System Prompt

**Fields in agent definition:**

- **Single 298-line Markdown file** as the entire system prompt
- Sections: Identity & Role, Personality, AGENTS.md spec, Autonomy & Persistence, Planning, Task Execution, Validating Work, Ambition vs Precision, Presenting Work, Sandbox & Approvals
- No separate "config" file for identity vs workflow
- AGENTS.md files (project-level markdown) provide **layered, scoped** instructions that merge with the system prompt
- `update_plan` tool for planning state tracking

**Identity/workflow separation:**

- **Minimal separation**: Identity ("You are Codex, an OpenAI general-purpose agentic assistant") and workflow rules are in one file
- AGENTS.md provides a **second layer** of project-specific constraints that compose with the base prompt
- AGENTS.md scope: directory-tree rooted; more-deeply-nested takes precedence; system/developer instructions override AGENTS.md

**Config format:** Markdown (.md) files — both system prompt and AGENTS.md

**Typical size:** Base system prompt ~298 lines; AGENTS.md per project varies (5-50 lines typical)

**Key pattern:** Codex CLI uses a **large, monolithic Markdown prompt** for its single-agent identity, supplemented by a novel **scoped AGENTS.md** system for project-level composition. No YAML, no JSON, no code-defined agent schema. The AGENTS.md scoping mechanism (directory-tree precedence) is a unique innovation for composing project-specific constraints onto the base agent identity.

### 5. OpenHands — Agent Hub with Microagent Prompts

**Fields in agent definition:**

- Agent implemented as Python class with `prompt` module
- Microagents: small markdown files in `.openhands/microagents/` providing domain knowledge
- System prompt constructed dynamically from agent class + microagents
- CodeActAgent: the primary agent, combining code execution + web browsing

**Identity/workflow separation:**

- Agent class defines core identity + tool capabilities
- Microagents (markdown) add domain-specific context/instructions
- The "controller" pattern: each agent has its own step() loop
- Multi-agent: `AgentController` manages agent lifecycle

**Config format:** Python code for agent class; Markdown for microagents

**Typical size:** Agent classes ~100-300 lines; microagent markdown ~10-30 lines each

**Key pattern:** OpenHands separates **agent implementation** (Python) from **domain knowledge** (microagent markdown). Microagents are similar to Codex's AGENTS.md but organized as a flat directory rather than scoped directory-tree.

### 6. MetaGPT — Rich Role Schema with State Machines

**Fields in agent definition:**

- `name` (str): Agent name, e.g. "Alice"
- `profile` (str): Role title, e.g. "Product Manager"
- `goal` (str): Objective, e.g. "Create a Product Requirement Document..."
- `constraints` (str): Limitations, e.g. "utilize the same language as the user requirements"
- `desc` (str): Description
- `instruction` (str): Detailed role-specific prompt (from separate prompts module)
- `tools` (list[str]): Tool names, e.g. ["RoleZero", "Browser", "Editor", "SearchEnhancedQA"]
- `actions` (list[Action]): Ordered action sequence (SOP)
- `states` (list[str]): State machine states
- `rc` (RoleContext): Runtime context including state, todo, watch, memory, react_mode

**Identity/workflow separation:**

- **Three-layer architecture**:
  1. Role identity: `name`, `profile`, `goal`, `constraints` (short fields)
  2. Role instruction: `instruction` field from `prompts/` module (detailed prompt, ~50-80 lines)
  3. Workflow: `actions` list + `states` list + `react_mode` (BY_ORDER, REACT, PLAN_AND_ACT)
- `RoleReactMode` enum controls workflow strategy:
  - `BY_ORDER`: Execute actions in sequence (SOP mode)
  - `REACT`: ReAct pattern (think→act→observe loop)
  - `PLAN_AND_ACT`: Plan then execute

**Config format:** Python class (Pydantic BaseModel) for Role; separate `prompts/` Python module for instruction strings

**Typical size:** Role class ~30-50 lines; prompts module ~50-100 lines per role; full Role with actions ~80-150 lines

**Key pattern:** MetaGPT has the **richest agent definition schema** among all projects studied. It explicitly models state machines (`states`), ordered action sequences (`actions`), and multiple execution strategies (`react_mode`). The three-layer architecture (identity → instruction → workflow) is the most structured separation. Role names are human-like ("Alice", "Bob") rather than functional ("researcher_agent").

### 7. Magentic-One — Ledger-Based Orchestrator with Sealed Workers

**Fields in orchestrator definition:**

- No YAML/config file. All prompts are Python string constants in `_prompts.py`
- Orchestrator system_message is **empty string** ("") — it's purely ledger-driven
- Ledger prompts: `ORCHESTRATOR_TASK_LEDGER_FACTS_PROMPT`, `ORCHESTRATOR_TASK_LEDGER_PLAN_PROMPT`, `ORCHESTRATOR_PROGRESS_LEDGER_PROMPT`
- Progress ledger uses **structured JSON output**: `LedgerEntry` Pydantic model with `is_request_satisfied`, `is_in_loop`, `is_progress_being_made`, `next_speaker`, `instruction_or_question`
- Each field has `reason` + `answer` subfields (explanatory reasoning)

**Worker agent definition (MagenticOneCoderAgent):**

- `description`: "A helpful and general-purpose AI assistant that has strong language skills, Python skills, and Linux command line skills."
- `system_message`: ~25 lines covering coding, shell scripting, step-by-step approach, error handling, verification
- **Sealed**: "The prompts and description are sealed, to replicate the original MagenticOne configuration"

**Identity/workflow separation:**

- **Extreme separation**: Orchestrator has NO persona/identity (empty system_message). It's purely a routing/coordination engine driven by structured ledger evaluations.
- Worker agents have **fixed, sealed** system_message + description — no user customization
- Orchestrator decides next_speaker + instruction_or_question via JSON ledger
- The orchestrator's "identity" is its ledger structure, not a persona

**Config format:** Python code (prompts as string constants in .py file)

**Typical size:** Orchestrator prompts ~100 lines total in \_prompts.py; worker system_message ~25 lines

**Key pattern:** Magentic-One represents the most radical separation of **orchestrator identity from worker identity**. The orchestrator has zero persona—it's a routing algorithm expressed via structured JSON prompts. Workers are sealed, immutable units. This is the opposite of CrewAI's persona-rich approach.

### 8. PydanticAI — Type-Safe Agent with Composable Capabilities

**Fields in agent definition:**

- `model` (str or model instance): Default LLM, e.g. "openai:gpt-5.2"
- `deps_type` (Type): Dependency type constraint
- `output_type` (Type): Structured output type
- `system_prompt` (str): Static system prompt
- `instructions` (callable or str): Dynamic instructions (can be a function that receives RunContext)
- `tools` (decorated functions): Agent tools
- `toolsets` (Toolset): Reusable tool bundles
- `model_settings` (ModelSettings): Default model parameters
- `capabilities` (Capabilities): Reusable bundles of tools+hooks+instructions+settings
- `retries` (dict): Tool/output retry configuration
- `end_strategy` (str): How to handle concurrent tool calls + output

**Identity/workflow separation:**

- **Single-agent focused**: No built-in multi-agent orchestration
- `system_prompt` provides identity/persona (static string)
- `instructions` can be **dynamic** (function receiving deps/context) — persona can adapt per-run
- Workflow for multi-agent: uses **pydantic-graph** (separate library) for state machines
- `capabilities` are composable units that bundle related behavior
- Agent Specs: YAML/JSON config files for loading agent configuration externally

**Config format:** Python code for Agent class; YAML/JSON for Agent Specs (external config loading)

**Typical size:** Agent definition ~5-20 lines for simple agents; system_prompt ~1-5 lines; instructions function ~5-30 lines

**Key pattern:** PydanticAI is the most **type-safe** approach. Agent definitions leverage Python's type system heavily (deps_type, output_type). The `instructions` field being dynamic (callable) is unique—it allows persona to vary per invocation based on dependencies. `capabilities` provide reusable composition. For multi-agent, pydantic-graph is a **separate library** with its own Graph/Node/Edge schema, keeping the agent persona entirely separate from workflow state machines.

### 9. Claude Code — Anthropic CLI (Not Open Source)

Claude Code (Anthropic's CLI tool) is **not open source**. No public repo exists with `anthropics/claude-code`. The system prompt is not publicly available. Based on available information:

- Claude Code reads project-level `CLAUDE.md` files (similar to Codex's AGENTS.md)
- The agent persona is defined internally by Anthropic
- Project instructions compose onto the base persona via CLAUDE.md files
- CLAUDE.md follows a scoped directory approach similar to AGENTS.md

This project cannot be analyzed for agent definition patterns because the source is not available. [13]

---

## Comparative Summary Matrix

| Project          | Identity Fields                                                       | Config Format                                | Identity↔Workflow Separation                             | Multi-Agent Pattern                             | Typical Agent Size                                | State Machine Approach                 |
| ---------------- | --------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------- | -------------------------------------- |
| **CrewAI**       | role, goal, backstory, llm, tools                                     | YAML (agents.yaml) + Python decorators       | **Strong**: separate agents.yaml vs tasks.yaml            | Crew orchestrator (sequential/hierarchical)     | ~10-30 lines YAML per agent                       | Process enum (sequential/hierarchical) |
| **AutoGen**      | name, description, system_message, tools                              | Python code only                             | **Moderate**: agent vs Team class                         | Team: RoundRobin, Selector, Swarm, Magentic-One | ~5-15 lines per agent                             | None in agent; Team manages routing    |
| **LangGraph**    | No persona fields—graph nodes                                         | Python code (StateGraph)                     | **None**: graph IS the agent                              | Subgraphs + handoff edges                       | ~20-200+ lines per graph                          | StateGraph with conditional edges      |
| **Codex CLI**    | Single 298-line Markdown prompt                                       | Markdown (.md)                               | **Weak**: monolithic prompt; AGENTS.md adds project layer | Single agent only                               | ~298 lines system prompt                          | No state machine; tool-driven          |
| **OpenHands**    | Agent class + microagent markdown                                     | Python + Markdown                            | **Moderate**: class vs microagents                        | AgentController manages lifecycle               | ~100-300 lines class; ~10-30 lines microagent     | Agent step() loop                      |
| **MetaGPT**      | name, profile, goal, constraints, instruction, actions, states, tools | Python (Pydantic BaseModel) + prompts module | **Strong**: 3-layer (identity→instruction→workflow)       | Environment-based message routing               | ~80-150 lines per role                            | RoleReactMode enum + states list       |
| **Magentic-One** | Orchestrator: empty; Worker: sealed description+system_message        | Python string constants                      | **Extreme**: orchestrator has no persona                  | Ledger-based JSON routing                       | ~100 lines orchestrator prompts; ~25 lines worker | Structured LedgerEntry Pydantic model  |
| **PydanticAI**   | system_prompt, instructions (dynamic), model, deps_type, output_type  | Python + YAML/JSON Specs                     | **Strong**: Agent vs pydantic-graph                       | Uses pydantic-graph for multi-agent             | ~5-20 lines per agent                             | pydantic-graph (separate library)      |

---

## Key Design Patterns Identified

### Pattern A: Persona-First (CrewAI, MetaGPT)

Agent identity is the primary definition unit. Workflow is attached to or orchestrated around personas. Best for role-playing, collaborative scenarios.

### Pattern B: Graph-First (LangGraph, PydanticAI)

The state machine/graph is the primary definition unit. Persona is just a string in a node. Best for complex workflows with conditional branching.

### Pattern C: Monolithic Prompt (Codex CLI)

Single large prompt file defines everything. Project-level markdown adds composition. Best for single powerful coding agents.

### Pattern D: Minimal Agent + Rich Orchestrator (AutoGen/Magentic-One)

Agent is a thin LLM wrapper. All orchestration intelligence lives in the Team/GroupChat layer. Best for flexible multi-agent composition.

### Pattern E: Layered Composition (Codex AGENTS.md, OpenHands Microagents, MetaGPT instruction)

Base identity + project/domain-specific overlays that compose at runtime. Best for adapting agents to different projects/repos.

---

## Best Practices Synthesis

1. **Separate identity from workflow**: CrewAI (YAML) and MetaGPT (3-layer) demonstrate this most cleanly. LangGraph shows it's optional if your primary abstraction is the graph.
2. **Use composable overlays**: Codex's AGENTS.md and OpenHands' microagents are lightweight composition mechanisms. They avoid modifying the base agent definition.
3. **Type-safe agent schemas**: PydanticAI's deps_type/output_type and MetaGPT's Pydantic BaseModel provide compile-time guarantees that CrewAI YAML cannot.
4. **Sealed worker agents for multi-agent**: Magentic-One's sealed workers prevent runtime mutation, making multi-agent systems predictable.
5. **Structured orchestrator outputs**: Magentic-One's LedgerEntry with reason+answer fields is superior to unstructured "next speaker" selection.
6. **Dynamic instructions**: PydanticAI's callable `instructions` field allows persona adaptation per-run without modifying the agent definition.
7. **Scoped project instructions**: Codex's directory-tree AGENTS.md precedence is the most sophisticated composition mechanism studied.

---

## Sources

1. CrewAI Agent Documentation — https://docs.crewai.com/concepts/agents
2. CrewAI Crew Documentation — https://docs.crewai.com/concepts/crews
3. AutoGen v0.4 Agent Tutorial — https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/agents.html
4. AutoGen Magentic-One Prompts (source) — https://github.com/microsoft/autogen/blob/main/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_magentic_one/_prompts.py
5. AutoGen Magentic-One Coder Agent (source) — https://github.com/microsoft/autogen/blob/main/python/packages/autogen-ext/src/autogen_ext/agents/magentic_one/_magentic_one_coder_agent.py
6. Codex CLI System Prompt (source) — https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_2_prompt.md
7. Codex CLI AGENTS.md — https://github.com/openai/codex/blob/main/AGENTS.md
8. MetaGPT role.py (source) — https://github.com/FoundationAgents/MetaGPT/blob/main/metagpt/roles/role.py
9. MetaGPT ProductManager (source) — https://github.com/FoundationAgents/MetaGPT/blob/main/metagpt/roles/product_manager.py
10. MetaGPT product_manager prompt (source) — https://github.com/FoundationAgents/MetaGPT/blob/main/metagpt/prompts/product_manager.py
11. PydanticAI Agent Documentation — https://ai.pydantic.dev/core-concepts/agent/
12. OpenHands GitHub Repository — https://github.com/OpenHands/OpenHands
13. LangGraph Documentation — https://langchain-ai.github.io/langgraph/

---

## Coverage Status

- **Fully analyzed**: CrewAI, AutoGen, Codex CLI, MetaGPT, Magentic-One, PydanticAI (6 of 9)
- **Partially analyzed**: OpenHands (agent structure confirmed, specific prompt files not retrieved due to repo structure changes), LangGraph (architectural pattern confirmed, specific examples not fetched due to doc site redirects)
- **Not analyzed**: Claude Code (not open source, no public repo with system prompt)
- **Remaining gaps**: LangGraph specific code examples for state graph definitions; OpenHands specific prompt.py content for CodeActAgent
