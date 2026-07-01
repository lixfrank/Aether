# newlayer-8: research-verifier agent 修改

> 原 `.aether/skills/research-verification/SKILL.md` (142行) → 删除，内容合并入 `.aether/agent/research-verifier.md`
> 原 `.aether/agent/research-verifier.md` (61行) → 更新（含原 skill 的验证协议）
> 对应设计文档 §6.2（verifier 即 judge）

---

## 修改原因与设计依据

**大方向**：verifier 在新设计中承担"judge"角色——验证就是对执行质量的独立判断。需强化 verdict 输出格式，使 execution worker 能据 verdict 直接决策。统一为单一 research-verifier agent（验证指令在 agent 定义中，不再有单独 skill），按需加载领域 skill。
**设计依据**：design doc §6.2（verifier 即 judge）、§6.3（删减项）、§9 约束 2（必须验证）。
**具体决策理由**：

- 合并 skill 入 agent：research-verification skill 的内容合并入 research-verifier.md agent 定义。与其他 subagent 一致（debate-critic、debate-rebuttal、local-executor 都是纯 agent 定义，无单独 skill）
- 强化 verdict 输出格式：verifier 产出的 verdict 就是 judge 裁决，execution worker 据 verdict 决策（PASS→resolved, FAIL→retry/failed）。结构 checker 验证 Qn_VERIFICATION.md 非空+含 verdict 即可（design doc §6.2）
- 删 domain_mode：agent 自行判断是否需加载领域 skill，不硬编码 skill 名称
- 删 fallback_applicability：fallback 的合理性是 framing 层面问题（debate/audit 审），不是 Qn verification 层面问题。Qn 只需验证自身执行是否正确，dependency_usage 已覆盖"Qn 是否正确使用了依赖结果"——无论该结果来自原定计划还是 fallback
- 环境策略：从"uv-first Python 执行"改为"读 persistence/ENVIRONMENT.md 了解可用环境"

## 删除

| 文件/段落                                                        | 理由                                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| `.aether/skills/research-verification/` 整体目录                 | 内容合并入 research-verifier.md agent 定义                       |
| 与 PLAN.md Contract 的强绑定描述（"establish contract targets"） | 简化为 per-claim 验证                                            |
| 与 phase_execution / autoresearch 的 FSM 衔接描述                | 不再有 FSM                                                       |
| PhaseResultDigest 输出                                           | verifier 是 sub-subagent，不回传 digest，只写 Qn_VERIFICATION.md |
| domain_mode 参数及相关描述                                       | agent 自行判断，不硬编码                                         |
| "MUST NOT include status field" 旧约束                           | 新设计 verifier 直接给 verdict                                   |
| uv-first Python 执行策略                                         | 改为读 ENVIRONMENT.md                                            |
| fallback_applicability 子项                                      | 与 dependency_usage 重复，fallback 合理性是 framing 层面问题     |

## 保留

- 验证协议核心：Reasoning Verification（4 子项: method_fidelity / step_completeness / assumption_audit / dependency_usage）+ Conclusion Verification
- "Never report independently confirmed based on LLM-only reasoning" 约束

## research-verifier.md agent 定义内容

### front matter

```yaml
name: research-verifier
mode: subagent
permission: { edit: { "*": deny, ".aether/research/**": allow } }
description: |
  对单个 question [Qn] 执行独立验证。verifier 即 judge——验证就是对执行质量的独立判断。
  由 execution worker 派遣。按需加载领域特定 skill（agent 自行判断是否需要）。
  产出 <workdir>execution/Qn_VERIFICATION.md。
```

### 输入输出

```markdown
Input: <workdir>PLAN.md (Qn 的 claim + method + falsification test) + <workdir>execution/Qn_REASONING.md + Qn_EXECUTION.md + persistence/ENVIRONMENT.md（了解可用计算环境）
Output: <workdir>execution/Qn_VERIFICATION.md（含 verdict + evidence + 4 子项判定）
```

### 验证协议

```markdown
verifier 验证 Qn 的执行质量，不关心 Qn 依赖的结果从哪来（原定计划或 fallback 均可）——
Qn 只需正确使用依赖结果即可，dependency_usage 覆盖此检查。

# Qn_VERIFICATION.md 必须包含:

## Verdict

[PASS | FAIL | PARTIAL]

## Evidence

[具体证据: 计算结果 / 引用对照 / 实验数据]

## Reasoning Verification

- method_fidelity: [PASS/FAIL + 理由] — 执行是否遵循 PLAN.md 指定的方法
- step_completeness: [PASS/FAIL + 理由] — 推理步骤是否完整（无跳步）
- assumption_audit: [PASS/FAIL + 理由] — 假设是否有效
- dependency_usage: [PASS/FAIL + 理由] — 是否正确使用了依赖的结果（无论结果来自原定计划还是 fallback）

## Conclusion Verification

[结论是否由证据支持]
```

### 环境策略

```markdown
读 persistence/ENVIRONMENT.md 了解可用计算环境（已装软件、Python 版本、可用库）。
据环境选择验证方法（如 SymPy 可用则用符号计算核对，否则用数值验证）。
执行 Python 脚本（如 gpd-verification SymPy 脚本）用 uv run。
```

### 约束

- FORBIDDEN: 编造来源（验证中引用的文献须有下载文件，check_sources 确定性判定）
- "Never report independently confirmed based on LLM-only reasoning" — 独立确认须有计算/引用证据，不能仅凭 LLM 推理断言
- verifier 产出的 verdict 就是 judge 裁决。execution worker 据 verdict 决策（PASS→resolved, FAIL→retry/failed）。不需要额外 judgment-worker——结构 checker (check_verification.py) 验证 Qn_VERIFICATION.md 非空 + 含 verdict 即可

---

## 对其他文件的影响

- newlayer-6 M5 验证节：dispatch research-verifier（不再有 gpd-verifier 分支）
- newlayer-10 §2：research-verifier 详细规格见 newlayer-8（newlayer-10 不重复）
- newlayer-10 §4：gpd-verifier 已删除
- newlayer-0：research-verification skill 需从 skills 列表删除

## 预期结果

- `.aether/skills/research-verification/` 删除（142行）
- `.aether/agent/research-verifier.md`：61行 → ~100行（合并 skill 验证协议 + 删 domain_mode/fallback_applicability + 强化 verdict）
- gpd-\* skill 保留不变（research-verifier 按需加载，不硬编码名称）
