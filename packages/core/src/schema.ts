import { Schema } from "effect";

/**
 * The ticket plan is the contract between the agent that decomposes a spec
 * and everything downstream (validators, Linear sync, humans reviewing the diff).
 * Keep it flat and boring: the LLM fills it, deterministic code checks it.
 */

export const TicketType = Schema.Literal(
  "feature",
  "migration",
  "infra",
  "test",
  "chore",
  "docs",
);
export type TicketType = typeof TicketType.Type;

/** A package-to-package import edge a ticket will introduce. Checked against boundary rules. */
export const NewDependency = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
});
export type NewDependency = typeof NewDependency.Type;

/** A workspace package the plan introduces. Tags and path are needed so boundary rules apply to it too. */
export const NewPackage = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  tags: Schema.Array(Schema.String),
  description: Schema.String,
})
export type NewPackage = typeof NewPackage.Type

export const Ticket = Schema.Struct({
  /** Stable key inside the plan, e.g. "AUD-3". Survives re-planning and is how Linear sync stays idempotent. */
  key: Schema.String,
  title: Schema.String,
  type: TicketType,
  /** Why this ticket exists and how to approach it. Markdown. */
  description: Schema.String,
  /** Workspace package names this ticket changes, e.g. ["@acme/audit-domain"]. */
  packages: Schema.Array(Schema.String),
  /** New workspace packages this ticket scaffolds. Any other ticket touching them must depend on this one. */
  createsPackages: Schema.Array(NewPackage),
  newDependencies: Schema.Array(NewDependency),
  acceptanceCriteria: Schema.Array(Schema.String),
  /** Story points on the Fibonacci scale (1, 2, 3, 5, 8). Anything larger must be split. */
  estimate: Schema.Number,
  /** Keys of tickets that must land first. Rendered as Linear "blocked by" relations. */
  dependsOn: Schema.Array(Schema.String),
  labels: Schema.Array(Schema.String),
});
export type Ticket = typeof Ticket.Type;

export const Epic = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  labels: Schema.Array(Schema.String),
  tickets: Schema.Array(Ticket),
});
export type Epic = typeof Epic.Type;

export const Plan = Schema.Struct({
  spec: Schema.Struct({
    /** Slug of the spec file, e.g. "tenant-audit-log". Namespaces every Linear marker. */
    id: Schema.String,
    title: Schema.String,
  }),
  project: Schema.Struct({
    name: Schema.String,
    description: Schema.String,
  }),
  epics: Schema.Array(Epic),
});
export type Plan = typeof Plan.Type;

export const decodePlan = Schema.decodeUnknown(Plan);
export const decodePlanSync = Schema.decodeUnknownSync(Plan);

/** Every ticket in plan order, with the epic it belongs to. */
export const allTickets = (
  plan: Plan,
): ReadonlyArray<{ readonly epic: Epic; readonly ticket: Ticket }> =>
  plan.epics.flatMap((epic) =>
    epic.tickets.map((ticket) => ({ epic, ticket })),
  );
