---
name: spec-to-tickets
description: Decompose a ready spec into well-scoped tickets with dependencies, acceptance criteria and estimates, validate them against the architecture, and sync them to Linear as a project with epics, sub-issues, labels and blocking relations. Use for "break this spec into tickets", "plan this in Linear", "estimate this spec", "update the tickets after the spec changed".
---

# spec-to-tickets

Mirrors `.cursor/rules/spec-to-tickets.mdc`.

## Gate

`lint_spec` must return `ready: true`. Otherwise stop and go back to `spec-coauthor`.

## Loop

1. `get_architecture_context`.
2. Draft the plan (schema: `packages/core/src/schema.ts`). One ticket per reviewable PR, new packages get their own scaffolding ticket with `createsPackages`, every new import edge in `newDependencies`, bottom-up `dependsOn`, Fibonacci estimates up to 8, two to four testable acceptance criteria, stable keys.
3. `validate_plan` until no errors. Boundary findings are not negotiable; reroute through an allowed layer.
4. Show the tree, take edits, `save_plan`.
5. `preview_linear_sync`, show the diff, wait for an explicit yes, then `apply_linear_sync`.
6. Reply with the project and epic URLs.

## Headless alternative

`pnpm stl plan <spec.md>` runs the decomposition through the Claude API with the same validator repair loop, then `pnpm stl sync plans/<id>.plan.json --team ENG` previews and `--apply` writes.
