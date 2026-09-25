import { decodePlanSync, type Plan } from "@stl/core"
import { emptyWorkspace, type InMemoryState, LinearInMemory, syncPlan } from "@stl/linear"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const raw = JSON.parse(readFileSync(join(import.meta.dirname, "../../../examples/acme/plans/tenant-audit-log.plan.json"), "utf8"))
const golden = decodePlanSync(raw)
const edited = (edit: (p: typeof raw) => void): Plan => {
  const copy = JSON.parse(JSON.stringify(raw))
  edit(copy)
  return decodePlanSync(copy)
}

const run = (state: InMemoryState, plan: Plan, apply: boolean) =>
  Effect.runSync(syncPlan(plan, { teamKey: "ENG", apply }).pipe(Effect.provide(LinearInMemory(state))))

const count = (r: ReturnType<typeof run>, kind: string, entity?: string) =>
  r.actions.filter((a) => a.kind === kind && (!entity || a.entity === entity)).length

describe("syncPlan", () => {
  it("dry run writes nothing and previews exactly what apply creates", () => {
    const state = emptyWorkspace()
    const preview = run(state, golden, false)
    expect(state.writes).toEqual([])
    const applied = run(state, golden, true)
    expect(applied.actions.map((a) => `${a.kind} ${a.entity} ${a.key}`)).toEqual(
      preview.actions.map((a) => `${a.kind} ${a.entity} ${a.key}`)
    )
  })

  it("creates the project, epics as parents, tickets as sub-issues and blocking relations", () => {
    const state = emptyWorkspace()
    const r = run(state, golden, true)
    expect(count(r, "create", "project")).toBe(1)
    expect(count(r, "create", "epic")).toBe(4)
    expect(count(r, "create", "ticket")).toBe(11)
    const deps = golden.epics.flatMap((e) => e.tickets).reduce((n, t) => n + t.dependsOn.length, 0)
    expect(state.relations).toHaveLength(deps)

    const byTitle = (prefix: string) => state.issues.find((i) => i.title.startsWith(prefix))!
    const epic = byTitle("Audit foundations")
    const aud3 = byTitle("[AUD-3]")
    expect(aud3.parentId).toBe(epic.id)
    expect(aud3.estimate).toBe(5)
    expect(state.relations).toContainEqual({ blockerId: byTitle("[AUD-1]").id, blockedId: aud3.id })
    expect(state.issues.every((i) => i.projectId === state.projects[0]!.id)).toBe(true)
  })

  it("is idempotent: a second apply performs zero writes", () => {
    const state = emptyWorkspace()
    run(state, golden, true)
    const before = state.writes.length
    const r = run(state, golden, true)
    expect(state.writes.length).toBe(before)
    expect(r.actions.every((a) => a.kind === "noop")).toBe(true)
  })

  it("updates only what changed after re-planning", () => {
    const state = emptyWorkspace()
    run(state, golden, true)
    const plan = edited((p) => {
      p.epics[2].tickets[1].estimate = 8
      p.epics[2].tickets[1].acceptanceCriteria.push("Keyboard navigation reaches every filter")
      p.epics[2].tickets[2].dependsOn.push("AUD-9")
    })
    const r = run(state, plan, true)
    expect(r.actions.filter((a) => a.kind !== "noop").map((a) => `${a.kind} ${a.key} ${a.changes.join("|")}`)).toEqual([
      "update AUD-7 description|estimate 5 -> 8",
      // the "Blocked by" line in AUD-8's description changed too
      "update AUD-8 description",
      "create AUD-9 blocks AUD-8 "
    ])
  })

  it("reports tickets dropped from the plan instead of deleting them", () => {
    const state = emptyWorkspace()
    run(state, golden, true)
    const plan = edited((p) => {
      p.epics[3].tickets = p.epics[3].tickets.filter((t: { key: string }) => t.key !== "AUD-11")
    })
    const r = run(state, plan, true)
    expect(r.notes.join("\n")).toMatch(/\(AUD-11\) is no longer in the plan/)
    expect(state.issues).toHaveLength(15)
  })

  it("leaves estimates off for teams that do not use them", () => {
    const state = emptyWorkspace({ issueEstimationType: "notUsed" })
    const r = run(state, golden, true)
    expect(state.issues.every((i) => i.estimate === null)).toBe(true)
    expect(r.notes[0]).toMatch(/estimates turned off/)
  })
})
