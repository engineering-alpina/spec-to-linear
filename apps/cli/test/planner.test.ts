import { scanWorkspace } from "@stl/context"
import { type DecomposeRequest, decomposeSpec, ScriptedModel } from "@stl/planner"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const ACME = join(import.meta.dirname, "../../../examples/acme")
const ctx = Effect.runSync(scanWorkspace(ACME))
const spec = readFileSync(join(ACME, "specs/tenant-audit-log.md"), "utf8")
const golden = readFileSync(join(ACME, "plans/tenant-audit-log.plan.json"), "utf8")

/** A realistic first draft: admin imports feature-audit directly and one ticket is too big. */
const firstDraft = (() => {
  const p = JSON.parse(golden)
  const aud10 = p.epics[3].tickets[1]
  aud10.newDependencies = [{ from: "@acme/admin", to: "@acme/feature-audit" }]
  aud10.packages = ["@acme/admin"]
  p.epics[2].tickets[1].estimate = 13
  return JSON.stringify(p)
})()

describe("decomposeSpec repair loop", () => {
  it("feeds validator findings back until the plan is clean", async () => {
    const calls: Array<DecomposeRequest> = []
    const result = await Effect.runPromise(
      decomposeSpec({ specId: "tenant-audit-log", spec, context: ctx }).pipe(
        Effect.provide(ScriptedModel({ decompose: [firstDraft, golden] }, calls))
      )
    )
    expect(result.rounds).toHaveLength(2)
    expect(result.rounds[0]!.findings.map((f) => f.code).sort()).toEqual(["boundary-violation", "too-big"])
    expect(result.findings).toEqual([])
    expect(result.plan?.epics).toHaveLength(4)

    // The second call carried the first answer and the findings as repair instructions.
    expect(calls[1]!.attempts[0]!.findings).toMatch(/admin-no-tenant-scoped-features/)
    expect(calls[1]!.context).toMatch(/@acme\/feature-tenants \[layer:feature\]/)
  })

  it("turns malformed model output into a schema finding instead of crashing", async () => {
    const result = await Effect.runPromise(
      decomposeSpec({ specId: "tenant-audit-log", spec, context: ctx, maxRounds: 2 }).pipe(
        Effect.provide(ScriptedModel({ decompose: ['{"spec": {}}', golden] }))
      )
    )
    expect(result.rounds[0]!.findings[0]!.code).toBe("schema")
    expect(result.findings).toEqual([])
  })

  it("refuses to decompose a spec with open questions", async () => {
    const draft = spec.replace("- [x] Page size", "- [ ] Page size")
    const exit = await Effect.runPromiseExit(
      decomposeSpec({ specId: "tenant-audit-log", spec: draft, context: ctx }).pipe(
        Effect.provide(ScriptedModel({ decompose: [golden] }))
      )
    )
    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toMatch(/Open questions: 1/)
  })
})
