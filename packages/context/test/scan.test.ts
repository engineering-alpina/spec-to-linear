import { violatedRule } from "@stl/core"
import { Effect } from "effect"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { scanWorkspace } from "../src/index.ts"

const ACME = join(import.meta.dirname, "../../../examples/acme")
const ctx = Effect.runSync(scanWorkspace(ACME))

describe("scanWorkspace on the acme fixture", () => {
  it("finds every app and package with tags and descriptions", () => {
    expect(ctx.packages).toHaveLength(16)
    expect(ctx.packages.filter((p) => p.kind === "app")).toHaveLength(5)
    const tenantDb = ctx.packages.find((p) => p.name === "@acme/tenant-db")!
    expect(tenantDb.tags).toEqual(["layer:infra"])
    expect(tenantDb.description).toMatch(/Neon database/)
  })

  it("reads both turbo boundaries and dependency-cruiser rules", () => {
    expect(ctx.rules.filter((r) => r.source === "turbo")).toHaveLength(5)
    expect(ctx.rules.map((r) => r.name)).toContain("apps-no-direct-db")
    expect(ctx.notes).toMatch(/One Neon Postgres database per tenant/)
  })

  it("the fixture's current edges are all legal", () => {
    const broken = ctx.packages.flatMap((p) =>
      p.dependsOn.filter((d) => violatedRule(ctx, p.name, d)).map((d) => `${p.name} -> ${d}`)
    )
    expect(broken).toEqual([])
  })

  it("flags the edges the rules exist to stop", () => {
    expect(violatedRule(ctx, "@acme/admin", "@acme/tenant-db")?.name).toBe("apps-no-direct-db")
    expect(violatedRule(ctx, "@acme/members-domain", "@acme/tenant-db")?.name).toBe("turbo-boundaries:layer:domain")
    expect(violatedRule(ctx, "@acme/admin", "@acme/feature-billing")?.name).toBe("admin-no-tenant-scoped-features")
    expect(violatedRule(ctx, "@acme/web", "@acme/feature-billing")).toBeUndefined()
  })
})
