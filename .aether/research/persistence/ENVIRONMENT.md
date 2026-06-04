# Environment Profile

> This file stores host system probe results and isolation strategy decisions.
> Written by research-worker at execution_cycle start, updated at each cycle.
> Read by local-executor to determine execution strategy.
> The coordinator reads gaps section to report missing software to the user.
> HARD CONSTRAINT: This file MUST be written BEFORE dispatching any executor.

---

```yaml
probe_timestamp: ""
cycle: null

host_system:
  os: ""
  uv: { available: false, version: "" }
  uv_python: { available: false, versions: [] }
  wolframscript: { available: false, version: "" }
  tools: {}
  gpu:
    available: false
    info: ""

plan_requirements: []

isolation_strategy: []

venv_state:
  path: ".aether/research/.venv"
  installed_packages: []
  last_cycle: null

gaps: []
```
