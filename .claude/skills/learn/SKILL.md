---
name: learn
description: Extract reusable patterns and lessons from the current session and save to memory
user_invocable: true
---

# Learn from Session

Review the current conversation and extract patterns worth remembering for future sessions.
Saves to **two systems**: project memory (project-specific) and Brainiac knowledge graph (cross-project).

## What to Extract

1. **Feedback corrections** — anything the user corrected about my approach
2. **Project discoveries** — architectural decisions, gotchas, or context not in CLAUDE.md
3. **User preferences** — communication style, tool preferences, workflow patterns
4. **Common pitfalls** — things that went wrong and how they were fixed
5. **Reusable patterns** — approaches that worked well and apply to other projects
6. **Anti-patterns** — approaches that failed and should be avoided

## Process

### Step 1: Check existing knowledge (avoid duplicates)

Search the Brainiac graph first:
```bash
cd ~/.claude/knowledge && python -m brainiac search "TOPIC"
```

Also check existing project memories in the project's memory directory (auto-memory system).

### Step 2: Analyze the session

Review the conversation for learnable moments. For each finding, classify:

| Scope | Target | Examples |
|-------|--------|----------|
| **Project-specific** | Project memory only | KB gotchas, user prefs for this project, architectural context |
| **Cross-project** | Project memory + Brainiac graph | Patterns, antipatterns, workflows, solutions, decisions |

### Step 3: Save to project memory

For all findings, determine the memory type: `user`, `feedback`, `project`, or `reference`.

Either update an existing memory file or create a new one with proper frontmatter:
```markdown
---
name: [descriptive name]
description: [one-line description for relevance matching]
type: [user|feedback|project|reference]
---
[memory content]
```

Update `MEMORY.md` index if a new file was created.

### Step 4: Save cross-project learnings to Brainiac

For findings that generalize beyond this project, also add to the knowledge graph:

```bash
cd ~/.claude/knowledge && python -m brainiac add <type> "<content>"
```

Node types: `pattern`, `antipattern`, `workflow`, `hypothesis`, `solution`, `decision`

For causal relationships (X led to discovering Y):
```bash
cd ~/.claude/knowledge && python -m brainiac link <id1> <id2> causal
```

### Step 5: Report

Tell the user what was saved, where, and why. Include node IDs for any brainiac entries.

## Rules

- Don't save ephemeral task details (current bugs, WIP state)
- Don't duplicate what's already in CLAUDE.md or git history
- Convert relative dates to absolute dates
- Keep memories actionable and specific
- Quality over quantity: 1-3 high-value entries per session
- Search brainiac BEFORE adding — avoid duplicates across projects
