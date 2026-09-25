import Anthropic from "@anthropic-ai/sdk"
import { Plan } from "@stl/core"
import { Context, Data, Effect, JSONSchema, Layer, Schema } from "effect"
import { COAUTHOR_SYSTEM, coauthorUser, DECOMPOSE_SYSTEM, decomposeUser, repairUser } from "./prompts.ts"

export class PlannerError extends Data.TaggedError("PlannerError")<{
  readonly reason: string
}> {}

export const SpecReview = Schema.Struct({
  summary: Schema.String,
  questions: Schema.Array(
    Schema.Struct({
      section: Schema.String,
      question: Schema.String,
      why: Schema.String
    })
  ),
  affectedPackages: Schema.Array(Schema.String),
  boundaryRisks: Schema.Array(Schema.String)
})
export type SpecReview = typeof SpecReview.Type

export interface DecomposeRequest {
  readonly specId: string
  readonly spec: string
  readonly context: string
  /** Prior attempts in this session: the raw plan the model returned and the findings it got back. */
  readonly attempts: ReadonlyArray<{ readonly output: string; readonly findings: string }>
}

/**
 * The model boundary. Returns raw JSON text; decoding and validation happen in
 * decompose.ts so a bad answer is a finding to repair, not a crash.
 */
export interface PlanModelShape {
  readonly decompose: (req: DecomposeRequest) => Effect.Effect<string, PlannerError>
  readonly review: (req: { spec: string; context: string; lint: string }) => Effect.Effect<SpecReview, PlannerError>
}

export class PlanModel extends Context.Tag("@stl/planner/PlanModel")<PlanModel, PlanModelShape>() {}

/** Structured-output schema derived from the same Effect Schema the validators use. */
export const jsonSchemaOf = <A, I>(schema: Schema.Schema<A, I>) => {
  const { $schema: _ignored, ...rest } = JSONSchema.make(schema) as unknown as Record<string, unknown>
  return rest
}

export const DEFAULT_MODEL = "claude-opus-5"

export const makeAnthropicModel = (client: Anthropic, model = DEFAULT_MODEL): PlanModelShape => {
  const call = (system: string, messages: Array<Anthropic.Beta.BetaMessageParam>, schema: Record<string, unknown>) =>
    Effect.tryPromise({
      try: async () => {
        const stream = client.beta.messages.stream({
          model,
          max_tokens: 64000,
          thinking: { type: "adaptive" },
          output_config: { effort: "high", format: { type: "json_schema", schema } },
          // Stable prefix (system + architecture context) is cached across the repair loop.
          cache_control: { type: "ephemeral" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system,
          messages
        })
        const message = await stream.finalMessage()
        if (message.stop_reason === "refusal") throw new Error("The model declined the request.")
        if (message.stop_reason === "max_tokens") throw new Error("The plan hit max_tokens; split the spec.")
        const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")
        if (!text) throw new Error("Empty response.")
        return text
      },
      catch: (e) => new PlannerError({ reason: e instanceof Error ? e.message : String(e) })
    })

  return {
    decompose: (req) => {
      const messages: Array<Anthropic.Beta.BetaMessageParam> = [{ role: "user", content: decomposeUser(req) }]
      for (const a of req.attempts) {
        messages.push({ role: "assistant", content: a.output }, { role: "user", content: repairUser(a.findings) })
      }
      return call(DECOMPOSE_SYSTEM, messages, jsonSchemaOf(Plan))
    },
    review: (req) =>
      call(COAUTHOR_SYSTEM, [{ role: "user", content: coauthorUser(req) }], jsonSchemaOf(SpecReview)).pipe(
        Effect.flatMap((text) =>
          Schema.decodeUnknown(Schema.parseJson(SpecReview))(text).pipe(
            Effect.mapError((e) => new PlannerError({ reason: `Review did not match the schema: ${e.message}` }))
          )
        )
      )
  }
}

export const AnthropicModel = (apiKey?: string, model?: string) =>
  Layer.sync(PlanModel, () => makeAnthropicModel(new Anthropic(apiKey ? { apiKey } : {}), model))

/** Replays canned responses in order. Used by tests and the offline demo. */
export const ScriptedModel = (
  responses: { decompose?: ReadonlyArray<string>; review?: SpecReview },
  calls: Array<DecomposeRequest> = [],
) => {
  let i = 0
  return Layer.succeed(PlanModel, {
    decompose: (req) =>
      Effect.suspend(() => {
        calls.push(req)
        const next = responses.decompose?.[i++]
        return next === undefined ? Effect.fail(new PlannerError({ reason: "Script exhausted" })) : Effect.succeed(next)
      }),
    review: () =>
      responses.review ? Effect.succeed(responses.review) : Effect.fail(new PlannerError({ reason: "No scripted review" }))
  })
}
