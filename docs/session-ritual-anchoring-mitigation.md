# Session Ritual Anchoring Mitigation Plan

## 1. Problem Description

### 1.1 Observed Behavior

When a user sends a new message after a completed agentic loop (the previous assistant finishes with `reason: "stop"`), the model may **ignore the new instruction** and instead replicate the "closing ritual" pattern from the previous turn — specifically, calling `todowrite` to re-affirm all previous todos as completed, then outputting a text summary identical to the previous turn's final step.

### 1.2 Concrete Incident

In session `ses_1cf7e3870ffd93taCA6KehR43z`, the user sent two messages:

1. **First message**: "很好，请你一并检查一下刚才提供给我的Subagent 加载测试方案，如果是你能直接在终端中进行测试的内容，请你测试无误"

   The agent responded with a 20-step agentic loop: `todowrite → bash → todowrite → bash → ... → todowrite(all completed) → text(summary) → stop`.

2. **Second message**: "我认可你的发现，用户更容易编辑jsonc而非 .aether/agent/.md 文件，因此我们应该要求jsonc覆盖 .md ，而非现在反过来的情况，请你修复"

   The agent responded with only 2 steps: `todowrite(all completed + "Update test plan" completed) → text(repeated summary) → stop`. It completely ignored the "请你修复" (please fix) instruction.

### 1.3 Root Cause Analysis

The root cause is **ritual anchoring** — a combination of three factors:

#### Factor 1: Cached Context Dominance

The first turn's 20 steps consumed ~103K tokens, all cached via prompt caching. When the second user message arrived, only ~1024 new tokens were added beyond the 103K cache. The model's attention was overwhelmingly weighted toward the cached context, making the ~50-80 token new instruction barely visible.

Token breakdown from the incident:

| Step                            | input     | output | cache.read  | total   |
| ------------------------------- | --------- | ------ | ----------- | ------- |
| First turn, final step          | 486       | 465    | **103,040** | 103,991 |
| Second turn, step 1 (todowrite) | **1,024** | 187    | **103,040** | 104,251 |
| Second turn, step 2 (text)      | 536       | 438    | **103,936** | 104,910 |

The second turn's model call re-used 103,040 cached tokens from the first turn verbatim. The new user message (~50-80 tokens) was less than 0.05% of the total context.

#### Factor 2: Closing Ritual Pattern Replication

The first turn ended with a two-step "closing ritual":

```
Step 19: todowrite(mark all completed, title="0 todos") → finish="tool-calls"
Step 20: text(summary of testing results)                → finish="stop"
```

The model replicated this exact arc in the second turn:

```
Step 1:  todowrite(mark all completed + "Update test plan" completed, title="0 todos") → finish="tool-calls"
Step 2:  text(repeated summary of testing results)                                       → finish="stop"
```

The model treated `todowrite(completed) → text(summary) → stop` as a **reproducible closing template** triggered by the user's "我认可你的发现" (I acknowledge your finding) — interpreting it as confirmation rather than a new instruction.

#### Factor 3: Misinterpretation of User Intent

The model interpreted "我认可你的发现" as "the user confirms the task is done" (a closing signal), and then entered **finalization mode** — re-affirming completion via todowrite and summarizing again. The second half of the message ("请你修复") was drowned out because the model was already on the "finalization" track.

### 1.4 Why "0 todos" Didn't Help

The `todowrite` tool returns `title: "0 todos"` when all items are completed. This signals "no remaining tasks" — which should logically tell the model to move on. However, "0 todos" reinforced the **finalization mode** rather than prompting a transition. The model interpreted it as: "previous task is fully done → user confirms it → I should re-affirm the completion one more time" instead of "previous task is done → new instruction requires new todos."

### 1.5 Why the Model Reopened todowrite Instead of Responding Directly

There was already a `text(summary)` at the end of the first turn. The model didn't "skip over" it — it **replicated the full closing arc** (todowrite → text). In the first turn's 20 steps, the model learned the pattern: "before outputting a final summary, always call todowrite to mark the task as completed." When it saw the second user message, it followed this pattern by starting with todowrite — but since it was in finalization mode, it made a "finalization todowrite" instead of an "initialization todowrite" with new tasks for the fix.

---

## 2. Current Architecture Constraints

### 2.1 Compaction Trigger

Compaction is currently triggered only when `SessionCompaction.isOverflow()` returns true — i.e., when total tokens exceed the model's usable context limit. In the incident, total tokens were ~104K, which was within the model's 128K context window, so **no compaction was triggered**.

```typescript
// compaction.ts:34-50
export async function isOverflow(input: { tokens; model }) {
  const count = input.tokens.total || input.tokens.input + ...
  const usable = input.model.limit.input
    ? input.model.limit.input - reserved
    : context - maxOutputTokens
  return count >= usable  // only triggers when context is FULL
}
```

### 2.2 Prune Mechanism

The `prune` function marks old tool outputs as `compacted` (replacing them with "[Old tool result content cleared]") but only for tool outputs more than 40K tokens away from the conversation end. The closing ritual steps (todowrite, bash, edit) are within the 40K protection window and are **never pruned**.

```typescript
// compaction.ts:60-105
// Goes backwards through parts until there are 40_000 tokens worth of tool calls.
// Then erases output of PREVIOUS (older) tool calls.
// The recent tool calls (including the closing ritual) are protected.
```

### 2.3 filterCompacted Stream

The `filterCompacted` function streams all messages from oldest to newest, stopping when it encounters a compaction boundary. The `filterCompacted` function streams all messages from oldest to newest, stopping when it encounters a compaction boundary. Since no compaction was triggered in the incident, **all 76 messages** (8 user + 68 assistant) were included in the model context verbatim.

---

## 3. Mitigation Strategy: todowrite Ritual Output Pruning

### Single Approach: Precise todowrite Output Compaction

This is a refined version of the previous "Layer B" — with a strictly narrowed trigger condition. Layers A and C from the previous design are **removed**:

- **Layer A (new turn reminder)** is dropped because injecting a blanket `<system-reminder>` on every new turn adds unnecessary context noise for models that handle turn transitions correctly, and the reminder's effectiveness on strong pattern-following models (like glm-5.1) is questionable.
- **Layer C (proactive compaction at 70% threshold)** is dropped because compaction should follow the existing overflow-based trigger uniformly. Adding a separate ratio-based trigger creates redundant compaction logic that diverges from the established architecture.

### Trigger Condition

**Only** prune todowrite tool outputs from the previous turn when:

1. The previous turn is completed (`lastAssistant.finish` is NOT `"tool-calls"`), AND
2. A new user message starts a new turn (`userMessage.id > lastAssistant.id`), AND
3. The previous turn's response contains **multiple todowrite tool calls** (≥ `minTodowriteCalls`), AND
4. The todowrite tool outputs occupy a **significant ratio** of the previous turn's total tool output token space (≥ `minTodowriteRatio`)

Condition 3 + 4 together ensure we only intervene when todowrite ritual anchoring is a concrete risk — not on every new turn, and not on turns where todowrite is a minor or single-use tool.

### Detection Logic

```typescript
interface RitualDetectionResult {
  shouldPrune: boolean
  todowriteParts: MessageV2.ToolPart[]
}

function detectTodowriteRitual(input: {
  messages: MessageV2.WithParts[]
  previousUserMsgID: MessageID
  minCalls: number // minimum todowrite call count to trigger pruning (default: 3)
  minRatio: number // minimum todowrite output token ratio to trigger pruning (default: 0.15)
}): RitualDetectionResult {
  const previousTurnAssistants = input.messages.filter(
    (msg) => msg.info.role === "assistant" && msg.info.parentID === input.previousUserMsgID && !msg.info.summary,
  )

  // Collect all todowrite tool parts from the previous turn
  const todowriteParts: MessageV2.ToolPart[] = []
  let totalToolOutputTokens = 0

  for (const msg of previousTurnAssistants) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.state.status === "completed" && !part.state.time.compacted) {
        totalToolOutputTokens += Token.estimate(part.state.output)
        if (part.tool === "todowrite") {
          todowriteParts.push(part)
        }
      }
    }
  }

  // Condition 3: enough todowrite calls
  const callCountMet = todowriteParts.length >= input.minCalls

  // Condition 4: todowrite output occupies significant ratio of tool output space
  const todowriteOutputTokens = todowriteParts.reduce((sum, p) => sum + Token.estimate(p.state.output), 0)
  const ratio = totalToolOutputTokens > 0 ? todowriteOutputTokens / totalToolOutputTokens : 0
  const ratioMet = ratio >= input.minRatio

  return {
    shouldPrune: callCountMet && ratioMet,
    todowriteParts,
  }
}
```

**Why both conditions are needed**:

- `minCalls` alone would trigger on any turn that uses todowrite ≥3 times, even if todowrite outputs are tiny (e.g., 3 × 50-token todowrite calls among 20 × 1000-token bash calls). The ratio check prevents this.
- `minRatio` alone would trigger on a turn with 1 todowrite call that happens to be large relative to a small total. The call count check prevents this.
- Together, they ensure pruning only happens when todowrite is used **repeatedly** AND its outputs form a **pattern-dominating portion** of the tool output space — which is exactly the ritual anchoring scenario.

### Incident Validation

In the incident session, the previous turn had:

- **7 todowrite calls** (steps 1, 3, 12, 19 + 2 from earlier sessions) → `minCalls=3` ✓
- todowrite output tokens: ~7 × 500 = ~3,500 tokens
- Total tool output tokens: ~19 tool calls × ~2,000 avg = ~38,000 tokens
- todowrite ratio: ~3,500 / ~38,000 ≈ 0.09 → below `minRatio=0.15` ✗

Wait — this seems like the ratio wouldn't meet the threshold. Let me re-examine. The key insight is that **todowrite's anchoring effect comes not from its raw output token size, but from its structural pattern repetition**. The JSON array output (listing todos with status fields) creates a recognizable template that the model replicates. Even if todowrite outputs are only 9% of total tool output tokens, 7 repetitions of the same structure create a strong pattern.

**Revised ratio calculation**: Instead of using raw output token count, use **todowrite call count / total tool call count** as the ratio metric. This captures the structural repetition frequency rather than byte size.

In the incident:

- 7 todowrite calls / 19 total tool calls ≈ 0.37 → `minRatio=0.15` ✓ (with call-count-based ratio)

Updated detection logic:

```typescript
function detectTodowriteRitual(input: {
  messages: MessageV2.WithParts[]
  previousUserMsgID: MessageID
  minCalls: number // minimum todowrite call count (default: 3)
  minRatio: number // minimum todowrite-call / total-tool-call ratio (default: 0.15)
}): RitualDetectionResult {
  const previousTurnAssistants = input.messages.filter(
    (msg) => msg.info.role === "assistant" && msg.info.parentID === input.previousUserMsgID && !msg.info.summary,
  )

  const todowriteParts: MessageV2.ToolPart[] = []
  let totalToolCalls = 0

  for (const msg of previousTurnAssistants) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.state.status === "completed" && !part.state.time.compacted) {
        totalToolCalls++
        if (part.tool === "todowrite") {
          todowriteParts.push(part)
        }
      }
    }
  }

  const callCountMet = todowriteParts.length >= input.minCalls
  const ratio = totalToolCalls > 0 ? todowriteParts.length / totalToolCalls : 0
  const ratioMet = ratio >= input.minRatio

  return {
    shouldPrune: callCountMet && ratioMet,
    todowriteParts,
  }
}
```

### Pruning Implementation

When `shouldPrune` is true, compact **only todowrite tool outputs** — not bash, read, edit, grep outputs. This is the most targeted intervention: it removes the repeated JSON-array pattern that creates ritual anchoring, while preserving all other tool outputs that contain useful context (file contents, command results, search matches).

```typescript
export async function pruneTodowriteRitual(input: { sessionID: SessionID; todowriteParts: MessageV2.ToolPart[] }) {
  let count = 0
  for (const part of input.todowriteParts) {
    if (part.state.status === "completed" && !part.state.time.compacted) {
      part.state.time.compacted = Date.now()
      await Session.updatePart(part)
      count++
    }
  }
  if (count > 0) log.info("pruned todowrite ritual outputs", { count })
  return count
}
```

After pruning, the model sees todowrite tool outputs replaced with `"[Old tool result content cleared]"`. The todowrite **inputs** remain visible (the model can see which todos were tracked), but the repeated `"0 todos"` / `"5 todos"` JSON output pattern is erased. This directly breaks the closing ritual's structural anchor while preserving all substantive context.

### Loop Integration

In `prompt.ts` — `loop` function, at step 1, after `isNewTurn` detection:

```typescript
const isNewTurn =
  lastAssistant?.finish && !["tool-calls"].includes(lastAssistant.finish) && lastUser.id > lastAssistant.id

if (step === 1 && isNewTurn) {
  const detection = detectTodowriteRitual({
    messages: msgs,
    previousUserMsgID: lastFinished.parentID,
    minCalls: ritualConfig.minCalls, // default: 3
    minRatio: ritualConfig.minRatio, // default: 0.15
  })
  if (detection.shouldPrune) {
    await SessionCompaction.pruneTodowriteRitual({
      sessionID,
      todowriteParts: detection.todowriteParts,
    })
    msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
  }
}
```

### What Gets Pruned vs. What Stays Intact

| Category                                              | Pruned? | Reason                                                                              |
| ----------------------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| todowrite tool outputs (JSON arrays, "0 todos" title) | **YES** | These create the ritual anchoring pattern                                           |
| todowrite tool inputs (todo item lists)               | **NO**  | Inputs are embedded in the assistant message's tool-use part, not a separate output |
| bash tool outputs (command results)                   | **NO**  | Contains substantive context (test results, file contents)                          |
| read tool outputs (file contents)                     | **NO**  | Contains substantive context                                                        |
| edit tool outputs (diff summaries)                    | **NO**  | Contains substantive context                                                        |
| grep tool outputs (search results)                    | **NO**  | Contains substantive context                                                        |
| All text parts (summaries, explanations)              | **NO**  | Contains the model's reasoning and conclusions                                      |

---

## 4. Configuration

Add `ritual` config under the existing `compaction` section in `aether.jsonc`:

```jsonc
{
  "compaction": {
    "auto": true,
    "prune": true,
    "reserved": 20000,
    "ritual": {
      "minCalls": 3, // minimum todowrite call count to trigger pruning
      "minRatio": 0.15, // minimum todowrite/total tool call ratio to trigger pruning
    },
  },
}
```

Setting `minCalls: 0` or `minRatio: 0` effectively disables the pruning.

---

## 5. Files to Modify

| File                                                | Change                                                                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/opencode/src/session/compaction.ts`       | Add `detectTodowriteRitual` function (exported for testing); add `pruneTodowriteRitual` export function                                |
| `packages/opencode/src/session/prompt.ts`           | Add `isNewTurn` detection + `detectTodowriteRitual` call + `pruneTodowriteRitual` invocation at step 1 in `loop`; read `ritual` config |
| `packages/opencode/src/config/config.ts`            | Add `ritual` config schema (`minCalls`, `minRatio`) under `compaction`                                                                 |
| `packages/opencode/src/util/token.ts`               | Ensure `Token.estimate` is exported and usable from compaction (may already be)                                                        |
| `packages/opencode/test/session/compaction.test.ts` | Add tests for `detectTodowriteRitual` and `pruneTodowriteRitual`                                                                       |

---

## 6. Testing Plan

### 6.1 Unit Tests

- **`detectTodowriteRitual`**:
  - Verify `shouldPrune=true` when todowrite calls ≥ `minCalls` AND ratio ≥ `minRatio`.
  - Verify `shouldPrune=false` when todowrite calls < `minCalls` (e.g., 2 calls with default minCalls=3).
  - Verify `shouldPrune=false` when ratio < `minRatio` (e.g., 3 todowrite among 30 total calls = 0.10 < 0.15).
  - Verify `shouldPrune=false` when previous turn has no tool calls at all.
  - Verify `shouldPrune=false` when all todowrite outputs are already compacted.
  - Verify correct `todowriteParts` collection (only todowrite, only completed, only non-compacted).

- **`pruneTodowriteRitual`**:
  - Verify that only todowrite tool parts are marked as compacted.
  - Verify that bash/read/edit/grep parts are NOT affected.
  - Verify that already-compacted todowrite parts are skipped.
  - Verify that text parts in the same messages are NOT affected.

### 6.2 Integration Test (Reproduction Scenario)

1. Create a session with a multi-step agentic loop that includes ≥3 todowrite calls among ≥15 total tool calls (ratio ≥ 0.15).
2. Let the turn complete with `finish="stop"`.
3. Send a second user message with a new instruction.
4. Verify `detectTodowriteRitual` returns `shouldPrune=true`.
5. Verify `pruneTodowriteRitual` marks the todowrite outputs as compacted.
6. Verify the model context no longer contains todowrite output patterns.
7. Verify the model responds to the new instruction instead of replicating the closing ritual.

### 6.3 Regression Tests

- Verify that a turn with only 1-2 todowrite calls does NOT trigger pruning.
- Verify that a turn with ≥3 todowrite calls but low ratio (< 0.15) does NOT trigger pruning.
- Verify that ongoing turns (tool-calls finish reason) are NOT affected.
- Verify that single-message sessions (no previous turn) are NOT affected.
- Verify that compaction continues to work via the existing overflow-based trigger, unaffected by the new ritual pruning.
- Verify `minCalls: 0` disables the detection entirely.
- Verify `minRatio: 0` disables the ratio check (only call count matters).

---

## 7. Risk Assessment

| Risk                                                                             | Mitigation                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pruning todowrite outputs loses todo status information                          | todowrite **inputs** remain visible (the model can see what todos existed); only the echoed JSON **output** is removed. The output is a redundant echo of the input plus a `title` field — low informational value                                                    |
| False positive: pruning when todowrite was used legitimately but not as a ritual | Dual threshold (minCalls + minRatio) ensures only repeated, pattern-dominating todowrite usage triggers pruning. A turn with 1-2 todowrite calls or low ratio is never pruned                                                                                         |
| Pruning is permanent (compacted outputs cannot be restored)                      | Consistent with existing `prune` behavior. todowrite outputs are state-tracking echoes, not substantive results. Their loss is acceptable for future turns                                                                                                            |
| todowrite call-count ratio might not capture all ritual anchoring scenarios      | The ratio metric uses call frequency (not byte size), which directly captures structural repetition. If future incidents involve other tools (not todowrite) creating ritual patterns, the detection function can be extended to accept a configurable tool name list |
| Compaction may still be needed for very large contexts                           | Existing overflow-based compaction continues to work as-is. No new compaction trigger is added. When context exceeds the model's usable limit, compaction fires normally                                                                                              |
