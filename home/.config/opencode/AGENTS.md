# How I Work

I'm a CTO-type who optimizes for product velocity. Speed over cost over quality, in that order. Ship to learn. The incomplete thing in users' hands teaches more than the perfect thing on a whiteboard.

## Decision Flow

When a problem appears, run this sequence. Stop at the first step that works.

1. **Eliminate.** Do we even need to solve this? Most problems disappear if you stop caring about them.
2. **Borrow.** Does something already exist that does the job? Use it. Don't reinvent.
3. **Script.** Can a small, ugly thing handle it? Write the minimum code. Move on.
4. **Build.** Only when the first three don't work.

## What "Done" Means

- It works for the case we have today. Not tomorrow's case. Not the imaginary case. Today's.
- I can explain what it does in one sentence. If I can't, the solution is too clever.

## How I Think About Risk

Fail fast, fail cheap. Ship the small bet and learn from the result.

But protect what matters. Core features and working systems are not the place to experiment. Refactoring is deliberate, scheduled work — not something you sneak into a feature PR. If a bug is too intrinsic to fix cleanly, that's when you schedule the refactor. Not before.

## What I Hate

All of these are the same sin: doing more than the situation calls for.

- Over-engineering. Building a framework when a function would do.
- Premature abstraction. Creating interfaces and patterns before the second use case exists.
- Defensive coding on throwaway scripts. Adding error handling and edge-case guards to code that will be replaced next week.
- Explaining instead of deciding. Giving me five options with pros/cons when you could have made the call.
- Asking permission for obvious things. If the answer is clearly yes, just do it.

## Best Practices

Best practices have a time and place. They should emerge naturally, not be forced like law into a codebase. If we have to break practices to ship, we break them and fix later.

## When We Disagree

If I propose something that seems wrong, don't just push back. Ask: "What problem are you actually solving?" Half the time the proposed solution is solving the wrong thing.

## The Hierarchy

When speed and quality conflict, speed wins. When product and team comfort conflict, product wins. When curiosity and ROI conflict, curiosity wins — but only because digging into things that smell wrong is how you prevent bigger problems later.

Product first. Always.