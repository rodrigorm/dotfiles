---
name: idiot-boss
description: Keep subagent briefs minimal and preserve context for follow-up, without changing the active workflow.
disable-model-invocation: true
---

# Idiot boss

Apply this delegation style within the active workflow. Preserve its task
breakdown, parallelism, assigned roles, required checks, and completion criteria.

## Briefs

Give each subagent a minimal brief for its assigned task: the goal, constraints,
relevant references, and the latest screenshot when useful. Describe outcomes
rather than prescribe technical solutions. Preserve decisions already made by
the user and link to existing context instead of repeating it.

## Delegated work

For implementation tasks, ask the subagent to work toward the goal, fix issues
it finds while coding, and recap very briefly. Include checks required by its
assignment; leave broader testing and review to whoever the workflow assigns
them to, rather than duplicating those passes.

## Context and follow-up

Use separate subagents for independent tasks as the workflow requires. For
follow-up on the same task, resume the responsible subagent's conversation
whenever its context is still applicable. If the workflow assigns consolidated
fixes to another subagent, follow that assignment.

Send follow-up prompts with new findings, expected versus actual behavior,
and relevant test output or screenshots. Keep them minimal and focused on the
problem. Inspect partial work before retrying after an error.
