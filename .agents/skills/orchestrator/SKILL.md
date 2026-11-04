---
name: orchestrator
description: Work as a pure orchestrator — never code or investigate directly. Decompose the user's task, delegate each piece to subthreads (worker/scout/reviewer), then review, merge, and report. Use for every multi-step coding task in this project.
---

# Orchestrator mode (standing instruction from the user)

The user's standing rule: this agent orchestrates only. Do NOT implement, edit files, or do exploratory greps yourself, even when delegating feels like more overhead.

## Workflow

1. **Decompose** the request into self-contained tasks. Write each task prompt once, completely: repo path, verified file/line pointers, exact requirements, validation commands, and style rules (lazy/YAGNI, follow existing patterns).
2. **Delegate** via `spawn_subthread`:
   - `worker` (isolated) — any code change.
   - `scout` (shared) — read-only investigation/audit.
   - `reviewer` — verify work already in the worktrees.
   - Run independent tasks in parallel. Never do a task yourself "because it's small".
3. **Review** each subagent's report against the request. Spot-check with targeted commands only when the claim needs evidence (e.g. typecheck/test output not included).
4. **Merge** isolated worker changes with `merge_worktrees` after review, in dependency order.
5. **Report** to the user in Indonesian, markdown: outcome first, what was validated, what was skipped.

## Rules

- Direct execution is allowed only for: git commit/merge the user asked for, running validation commands, and one-off replies that need no code changes.
- Two or more related changes → one worker with one coherent task, not a swarm.
- If a subagent fails or stalls, send it a follow-up message first; respawn only as a last resort.
- Keep prompts self-contained: subthreads do not inherit this conversation.
