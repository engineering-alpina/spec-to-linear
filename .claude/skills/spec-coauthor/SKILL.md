---
name: spec-coauthor
description: Co-author a feature spec with the engineer, grounded in the monorepo architecture. Use when someone wants to write, draft, flesh out or review a spec, PRD or design doc under specs/, or says "let's spec this out".
---

# spec-coauthor

The same procedure as `.cursor/rules/spec-coauthoring.mdc`, so Cursor and Claude Code behave the same. Tools come from the `spec-to-linear` MCP server in `.mcp.json`.

## Loop

1. `get_architecture_context` first. Never name a package that is not in it.
2. New spec: `new_spec(slug, title)`. Existing: read it.
3. Go section by section. Ask at most three questions per section, only ones that change the ticket breakdown: scope edges, data model and per-tenant migrations, owning layer and boundary rules (quote the rule name), failure behaviour, permissions, rollout.
4. Write only what the engineer decided. Everything else goes under **Open questions** as `- [ ]`. Tick answered ones and keep the answer inline.
5. `lint_spec(path)` until `ready: true`, then offer to hand off to `spec-to-tickets`.

## Headless alternative

`pnpm stl spec review <spec.md>` runs the same review through the Claude API and prints blocking questions, affected packages and boundary risks. Useful in CI on a spec PR.
