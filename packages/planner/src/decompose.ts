import {
  type ArchitectureContext,
  type Finding,
  hasErrors,
  lintSpec,
  Plan,
  renderContext,
  renderFindings,
  validatePlan
} from "@stl/core"
import { Effect, ParseResult, Schema } from "effect"
import { PlanModel, PlannerError, type SpecReview } from "./model.ts"

export interface DecomposeResult {
  readonly plan: Plan | undefined
  readonly findings: ReadonlyArray<Finding>
  /** One entry per model call: what it returned and what the validator said. */
  readonly rounds: ReadonlyArray<{ readonly findings: ReadonlyArray<Finding> }>
}

const decodeRaw = (text: string): Effect.Effect<Plan, ReadonlyArray<Finding>> =>
  Schema.decodeUnknown(Schema.parseJson(Plan))(text).pipe(
    Effect.mapError((e) => [
      {
        code: "schema",
        severity: "error" as const,
        path: "$",
        message: `Output did not match the plan schema: ${ParseResult.TreeFormatter.formatErrorSync(e)}`
      }
    ])
  )

/**
 * The agent loop: propose -> validate -> feed findings back -> propose again.
 * The model never has the last word; the deterministic validator does.
 */
export const decomposeSpec = (input: {
  readonly specId: string
  readonly spec: string
  readonly context: ArchitectureContext
  readonly maxRounds?: number
}): Effect.Effect<DecomposeResult, PlannerError, PlanModel> =>
  Effect.gen(function* () {
    const lint = lintSpec(input.spec, input.context.packages.map((p) => p.name))
    if (!lint.ready) {
      return yield* new PlannerError({
        reason: `Spec is not ready to decompose. Missing: ${lint.missingSections.join(", ") || "none"}. Empty: ${lint.emptySections.join(", ") || "none"}. Open questions: ${lint.openQuestions.length}.`
      })
    }

    const model = yield* PlanModel
    const context = renderContext(input.context)
    const attempts: Array<{ output: string; findings: string }> = []
    const rounds: Array<{ findings: ReadonlyArray<Finding> }> = []
    const maxRounds = input.maxRounds ?? 3

    for (let round = 1; round <= maxRounds; round++) {
      const output = yield* model.decompose({ specId: input.specId, spec: input.spec, context, attempts })
      const decoded = yield* Effect.either(decodeRaw(output))
      const plan = decoded._tag === "Right" ? decoded.right : undefined
      const findings = plan ? validatePlan(plan, input.context) : (decoded as { left: ReadonlyArray<Finding> }).left
      rounds.push({ findings })
      if (plan && !hasErrors(findings)) return { plan, findings, rounds }
      if (round === maxRounds) return { plan, findings, rounds }
      attempts.push({ output, findings: renderFindings(findings) })
    }
    return { plan: undefined, findings: [], rounds }
  })

export const reviewSpec = (input: {
  readonly spec: string
  readonly context: ArchitectureContext
}): Effect.Effect<{ readonly review: SpecReview; readonly lint: ReturnType<typeof lintSpec> }, PlannerError, PlanModel> =>
  Effect.gen(function* () {
    const model = yield* PlanModel
    const lint = lintSpec(input.spec, input.context.packages.map((p) => p.name))
    const lintText = [
      `ready: ${lint.ready}`,
      `missing sections: ${lint.missingSections.join(", ") || "none"}`,
      `empty sections: ${lint.emptySections.join(", ") || "none"}`,
      `open questions: ${lint.openQuestions.join(" | ") || "none"}`
    ].join("\n")
    const review = yield* model.review({ spec: input.spec, context: renderContext(input.context), lint: lintText })
    return { review, lint }
  })
