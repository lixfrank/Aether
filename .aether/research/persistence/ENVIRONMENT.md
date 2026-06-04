# Environment Profile

> This file stores host system probe results and isolation strategy decisions.
> Written by research-worker at execution_cycle start, updated at each cycle.
> Read by sandbox-executor and local-executor to determine execution strategy.
> The coordinator reads gaps section to report missing software to the user.

---

```yaml
probe_timestamp: ""
cycle: null

host_system:
  os: ""
  python: { available: false, versions: [], default: "" }
  docker: { available: false, desktop: false, version: "" }
  wolframscript: { available: false, version: "" }
  uv: { available: false, version: "" }
  gpu: { available: false }

plan_requirements: []

isolation_strategy: []

venv_state:
  path: ".aether/research/.venv"
  installed_packages: []
  last_cycle: null

gaps: []
```
