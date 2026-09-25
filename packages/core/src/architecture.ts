import { Schema } from "effect";

/**
 * What the agent knows about the codebase before it writes a single ticket.
 * Built by @stl/context from the real repo (package.json, turbo.json tags and
 * boundaries, dependency-cruiser rules, package READMEs).
 */

export const WorkspacePackage = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  kind: Schema.Literal("app", "package"),
  tags: Schema.Array(Schema.String),
  description: Schema.String,
  dependsOn: Schema.Array(Schema.String),
});
export type WorkspacePackage = typeof WorkspacePackage.Type;

/**
 * One "these packages must not import those packages" rule. Turborepo tag rules
 * and dependency-cruiser path rules are normalised to selectors:
 *   "tag:layer:domain"  matches packages carrying that turbo tag
 *   "path:^apps/"       matches packages whose repo-relative path matches the regex
 * Selectors (not resolved package lists) keep the rules valid for packages a plan creates.
 */
export const BoundaryRule = Schema.Struct({
  source: Schema.Literal("turbo", "dependency-cruiser"),
  name: Schema.String,
  comment: Schema.String,
  from: Schema.String,
  deny: Schema.Array(Schema.String),
})
export type BoundaryRule = typeof BoundaryRule.Type

export const matchesSelector = (pkg: Pick<WorkspacePackage, "tags" | "path">, selector: string): boolean => {
  if (selector.startsWith("tag:")) return pkg.tags.includes(selector.slice(4))
  if (selector.startsWith("path:")) return new RegExp(selector.slice(5)).test(pkg.path.endsWith("/") ? pkg.path : `${pkg.path}/`)
  return false
}

export const ruleSummary = (rule: BoundaryRule) => `${rule.from} must not depend on ${rule.deny.join(", ")}`

export const ArchitectureContext = Schema.Struct({
  root: Schema.String,
  packages: Schema.Array(WorkspacePackage),
  rules: Schema.Array(BoundaryRule),
  /** Free-form architecture notes (docs/architecture.md or similar), passed to the agent verbatim. */
  notes: Schema.String,
});
export type ArchitectureContext = typeof ArchitectureContext.Type;

export const findPackage = (ctx: ArchitectureContext, name: string) =>
  ctx.packages.find((p) => p.name === name);

/**
 * Returns the rule a new edge from -> to would break, if any.
 * `extra` lets callers include packages that do not exist yet (created by the plan).
 */
export const violatedRule = (
  ctx: ArchitectureContext,
  from: string,
  to: string,
  extra: ReadonlyArray<WorkspacePackage> = [],
): BoundaryRule | undefined => {
  const all = [...ctx.packages, ...extra]
  const src = all.find((p) => p.name === from)
  const dst = all.find((p) => p.name === to)
  if (!src || !dst) return undefined
  return ctx.rules.find((rule) => matchesSelector(src, rule.from) && rule.deny.some((d) => matchesSelector(dst, d)))
}

/** Compact text rendering for prompts and MCP responses. Tokens matter; keep it dense. */
export const renderContext = (ctx: ArchitectureContext): string => {
  const pkgs = ctx.packages
    .map(
      (p) =>
        `- ${p.name} [${p.tags.join(", ")}] ${p.path}\n  ${p.description}\n  deps: ${p.dependsOn.join(", ") || "none"}`,
    )
    .join("\n");
  const rules = ctx.rules
    .map(
      (r) =>
        `- (${r.source}) ${r.name}: ${ruleSummary(r)}. ${r.comment}`,
    )
    .join("\n");
  return `## Workspace packages\n${pkgs}\n\n## Boundary rules\n${rules}\n\n## Architecture notes\n${ctx.notes}`.trim();
};
