import type {
  ArchitectureContext,
  BoundaryRule,
  WorkspacePackage,
} from "@stl/core";
import { Data, Effect } from "effect";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

/**
 * Reads the monorepo the way a senior engineer would before writing tickets:
 * which packages exist, what each is for, who depends on whom, and which
 * imports the boundary tooling forbids. No LLM involved; the output is the
 * grounding every later step gets.
 */

export class ContextScanError extends Data.TaggedError("ContextScanError")<{
  readonly path: string;
  readonly reason: string;
}> {}

const readJson = (path: string) =>
  Effect.try({
    try: () =>
      JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>,
    catch: (e) => new ContextScanError({ path, reason: String(e) }),
  });

const workspaceGlobs = (root: string): ReadonlyArray<string> => {
  const pnpm = join(root, "pnpm-workspace.yaml");
  if (existsSync(pnpm)) {
    return readFileSync(pnpm, "utf8")
      .split("\n")
      .map((l) => l.match(/^\s*-\s*["']?([^"'\s]+)["']?/)?.[1])
      .filter((g): g is string => Boolean(g));
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    workspaces?: ReadonlyArray<string>;
  };
  return pkg.workspaces ?? [];
};

/** Only supports the "dir/*" form, which is what nearly every Turborepo uses. */
const expandGlob = (root: string, glob: string): ReadonlyArray<string> => {
  if (!glob.endsWith("/*"))
    return existsSync(join(root, glob, "package.json")) ? [glob] : [];
  const base = glob.slice(0, -2);
  const dir = join(root, base);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (d) => d.isDirectory() && existsSync(join(dir, d.name, "package.json")),
    )
    .map((d) => `${base}/${d.name}`)
    .sort();
};

const firstParagraph = (readme: string) =>
  readme
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#")) ?? "";

const scanPackage = (root: string, rel: string) =>
  Effect.gen(function* () {
    const dir = join(root, rel);
    const pkg = yield* readJson(join(dir, "package.json"));
    const turbo = existsSync(join(dir, "turbo.json"))
      ? yield* readJson(join(dir, "turbo.json"))
      : {};
    const readme = existsSync(join(dir, "README.md"))
      ? readFileSync(join(dir, "README.md"), "utf8")
      : "";
    const deps = {
      ...(pkg.dependencies as object | undefined),
      ...(pkg.devDependencies as object | undefined),
    };
    return {
      name: String(pkg.name),
      path: rel,
      kind: rel.startsWith("apps/") ? "app" : "package",
      tags: (turbo.tags as ReadonlyArray<string> | undefined) ?? [],
      description: firstParagraph(readme) || String(pkg.description ?? ""),
      dependsOn: Object.keys(deps),
    } satisfies WorkspacePackage;
  });

interface TurboBoundaries {
  readonly tags?: Record<
    string,
    { readonly dependencies?: { readonly deny?: ReadonlyArray<string> } }
  >;
}

const turboRules = (root: string) =>
  Effect.gen(function* () {
    const path = join(root, "turbo.json");
    if (!existsSync(path)) return [];
    const turbo = yield* readJson(path);
    const tags = (turbo.boundaries as TurboBoundaries | undefined)?.tags ?? {};
    return Object.entries(tags)
      .filter(([, rule]) => rule.dependencies?.deny?.length)
      .map(
        ([tag, rule]): BoundaryRule => ({
          source: "turbo",
          name: `turbo-boundaries:${tag}`,
          comment: "",
          from: `tag:${tag}`,
          deny: (rule.dependencies?.deny ?? []).map((t) => `tag:${t}`),
        }),
      );
  });

interface CruiserRule {
  readonly name: string;
  readonly comment?: string;
  readonly from?: { readonly path?: string };
  readonly to?: { readonly path?: string };
}

const cruiserRules = (root: string) =>
  Effect.gen(function* () {
    const file = [".dependency-cruiser.cjs", ".dependency-cruiser.js"]
      .map((f) => join(root, f))
      .find(existsSync);
    if (!file) return [];
    const config = yield* Effect.try({
      try: () =>
        createRequire(import.meta.url)(file) as {
          forbidden?: ReadonlyArray<CruiserRule>;
        },
      catch: (e) => new ContextScanError({ path: file, reason: String(e) }),
    });
    return (config.forbidden ?? [])
      .filter((r) => r.from?.path && r.to?.path)
      .map(
        (r): BoundaryRule => ({
          source: "dependency-cruiser",
          name: r.name,
          comment: r.comment ?? "",
          from: `path:${r.from!.path}`,
          deny: [`path:${r.to!.path}`],
        }),
      );
  });

const NOTES_CANDIDATES = [
  "docs/architecture.md",
  "ARCHITECTURE.md",
  "docs/ARCHITECTURE.md",
];

export const scanWorkspace = (
  root: string,
): Effect.Effect<ArchitectureContext, ContextScanError> =>
  Effect.gen(function* () {
    const dirs = workspaceGlobs(root).flatMap((g) => expandGlob(root, g));
    const packages = yield* Effect.forEach(dirs, (rel) =>
      scanPackage(root, rel),
    );
    const internal = new Set(packages.map((p) => p.name));
    const rules = [
      ...(yield* turboRules(root)),
      ...(yield* cruiserRules(root)),
    ];
    const notesFile = NOTES_CANDIDATES.map((f) => join(root, f)).find(
      existsSync,
    );
    return {
      root: relative(process.cwd(), root) || ".",
      // External deps are noise for planning; keep only workspace edges.
      packages: packages.map((p) => ({
        ...p,
        dependsOn: p.dependsOn.filter((d) => internal.has(d)),
      })),
      rules,
      notes: notesFile ? readFileSync(notesFile, "utf8").trim() : "",
    };
  });
