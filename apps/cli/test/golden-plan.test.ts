import { scanWorkspace } from "@stl/context"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { decodePlanSync, lintSpec, type Plan, specTemplate, topologicalOrder, validatePlan } from "@stl/core"

const ACME = join(import.meta.dirname, "../../../examples/acme")
const ctx = Effect.runSync(scanWorkspace(ACME))
const golden = decodePlanSync(JSON.parse(readFileSync(join(ACME, "plans/tenant-audit-log.plan.json"), "utf8")))

/** Deep-clone the golden plan and edit one ticket. */
const mutate = (key: string, edit: (t: Record<string, unknown>) => void): Plan => {
  const raw = JSON.parse(JSON.stringify(golden))
  for (const e of raw.epics) for (const t of e.tickets) if (t.key === key) edit(t)
  return decodePlanSync(raw)
}
const codes = (plan: Plan) => validatePlan(plan, ctx).map((f) => f.code)

describe("validatePlan", () => {
  it("accepts the golden plan with no findings", () => {
    expect(validatePlan(golden, ctx)).toEqual([])
  })

  it("rejects an admin -> feature-audit import (dependency-cruiser rule)", () => {
    const plan = mutate("AUD-10", (t) => {
      t.newDependencies = [{ from: "@acme/admin", to: "@acme/feature-audit" }]
    })
    const f = validatePlan(plan, ctx).find((x) => x.code === "boundary-violation")!
    expect(f.message).toMatch(/admin-no-tenant-scoped-features/)
  })

  it("applies turbo tag rules to packages the plan creates", () => {
    const plan = mutate("AUD-1", (t) => {
      t.newDependencies = [{ from: "@acme/audit-domain", to: "@acme/tenant-db" }]
    })
    expect(codes(plan)).toContain("boundary-violation")
  })

  it("requires tickets touching a new package to depend on its creator", () => {
    const plan = mutate("AUD-8", (t) => {
      t.packages = ["@acme/api", "@acme/feature-audit"]
      t.dependsOn = []
    })
    expect(codes(plan)).toContain("missing-creator-dependency")
  })

  it("catches cycles, oversized and off-scale estimates, thin and vague criteria", () => {
    expect(codes(mutate("AUD-3", (t) => void (t.dependsOn = ["AUD-11"])))).toContain("dependency-cycle")
    expect(codes(mutate("AUD-7", (t) => void (t.estimate = 13)))).toContain("too-big")
    expect(codes(mutate("AUD-7", (t) => void (t.estimate = 4)))).toContain("off-scale-estimate")
    expect(codes(mutate("AUD-8", (t) => void (t.acceptanceCriteria = ["Endpoint works correctly"])))).toEqual([
      "thin-acceptance-criteria",
      "vague-acceptance-criterion"
    ])
  })

  it("rejects unknown packages and dependencies", () => {
    expect(codes(mutate("AUD-4", (t) => void (t.packages = ["@acme/members"])))).toContain("unknown-package")
    expect(codes(mutate("AUD-4", (t) => void (t.dependsOn = ["AUD-99"])))).toContain("unknown-dependency")
  })

  it("orders tickets so dependencies come first", () => {
    const order = topologicalOrder(golden.epics.flatMap((e) => e.tickets)).map((t) => t.key)
    for (const t of golden.epics.flatMap((e) => e.tickets)) {
      for (const d of t.dependsOn) expect(order.indexOf(d)).toBeLessThan(order.indexOf(t.key))
    }
  })
})

describe("lintSpec", () => {
  it("passes the co-authored example spec", () => {
    const md = readFileSync(join(ACME, "specs/tenant-audit-log.md"), "utf8")
    const r = lintSpec(md, ctx.packages.map((p) => p.name))
    expect(r.ready).toBe(true)
    expect(r.mentionedPackages).toContain("@acme/feature-tenants")
  })

  it("blocks a fresh template and an unanswered question", () => {
    expect(lintSpec(specTemplate("X")).ready).toBe(false)
    const md = readFileSync(join(ACME, "specs/tenant-audit-log.md"), "utf8").replace("- [x] Page size", "- [ ] Page size")
    expect(lintSpec(md).openQuestions).toEqual([expect.stringMatching(/^Page size/)])
  })
})
