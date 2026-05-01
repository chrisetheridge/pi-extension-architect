---
name: architect-mode
description: Classify a task, force a Socratic architecture pass for ambiguous or architectural work, critique the design, generate options, and record the chosen approach before implementation.
---

# Architect Mode

Use this skill when the request looks architectural, ambiguous, or the user explicitly asks for a design pass before implementation.

## Gate

First classify the request:

- `trivial` - explanation, reading, typo, tiny mechanical edit
- `implementation` - straightforward code change with local scope
- `architectural` - system design, tradeoffs, data flow, reliability, scalability, security, migration, or from-scratch planning
- `ambiguous` - not enough information to choose safely

If the task is `architectural` or `ambiguous`, do not jump to code. Run the full Architect Mode flow first. If the user explicitly invokes this skill, always run the full flow.

## Flow

1. Restate the task in one or two sentences.
2. Collect concise answers to these questions, in order:
   - What problem are we solving, and what is the user-facing goal?
   - What is the core flow end to end?
   - What constraints matter: scale, latency, reliability, security, compatibility?
   - What major components are involved, and what does each own?
   - What risks, unknowns, or failure modes worry you?
   - What tradeoffs are you already seeing?
3. Critique the design Socratically.
   - Call out missing constraints, hidden complexity, bad assumptions, and failure modes.
   - Ask the follow-up questions that would change the design.
   - Do not write implementation code yet.
4. Generate 2 to 3 architecture options.
   - Keep one option simple and fast.
   - Keep one option conservative and maintainable.
   - Add a more scalable option only if the problem warrants it.
5. Ask the user to pick an option or provide a custom approach.
6. Summarize the decision in implementation-ready terms:
   - chosen approach
   - key constraints
   - important tradeoffs
   - risks to preserve or avoid

## Decision Record

When working in a repo and the user wants persistence, write the decision note to:

`./.pi/architect/PLAN-<slug>-<yyyy-mm-dd>.md`

Use a short slug from the task title or prompt. Include:

- original prompt
- Socratic answers
- critique and follow-up answers
- options considered
- selected approach

## Implementation Handoff

After the architecture pass, only then proceed with implementation. Keep the chosen approach visible in the working context so follow-up code stays aligned with the design decision.
