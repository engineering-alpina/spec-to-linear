# Agent instructions

This repo turns specs into Linear tickets. Agents in Cursor and Claude Code use the `spec-to-linear` MCP server (`.cursor/mcp.json`, `.mcp.json`).

- Writing or reviewing a spec: follow `.cursor/rules/spec-coauthoring.mdc` (Claude Code: skill `spec-coauthor`).
- Turning a ready spec into tickets: follow `.cursor/rules/spec-to-tickets.mdc` (Claude Code: skill `spec-to-tickets`).
- Never write to Linear without showing `preview_linear_sync` output and getting an explicit yes.

Working on this repo's code: `pnpm check` runs typecheck, dependency-cruiser boundaries and Vitest. `packages/core` must stay free of IO; libraries depend only on core.
