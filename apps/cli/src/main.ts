#!/usr/bin/env -S npx tsx
import { scanWorkspace } from "@stl/context";
import {
  decodePlan,
  hasErrors,
  lintSpec,
  type Plan,
  planToMarkdown,
  renderContext,
  renderFindings,
  specTemplate,
  validatePlan,
} from "@stl/core";
import {
  emptyWorkspace,
  LinearInMemory,
  LinearLive,
  renderReport,
  syncPlan,
} from "@stl/linear";
import { AnthropicModel, decomposeSpec, reviewSpec } from "@stl/planner";
import { Console, Effect } from "effect";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const HELP = `stl: spec -> tickets -> Linear

  stl context                         print the architecture context the agent sees
  stl spec new <slug> "<title>"       write specs/<slug>.md from the template
  stl spec lint <spec.md>             is the spec ready to decompose?
  stl spec review <spec.md>           LLM spec review: blocking questions, packages, boundary risks
  stl plan <spec.md> [--out file]     LLM decomposition with validator repair loop -> plan JSON
  stl validate <plan.json>            run the deterministic plan checks
  stl preview <plan.json>             print the ticket tree
  stl sync <plan.json> [--apply]      diff (default) or write the plan to Linear
        [--team KEY] [--offline]      --offline syncs into an in-memory Linear workspace

  --root <dir>    monorepo root (default: STL_ROOT or cwd)
`;

if (existsSync(".env")) process.loadEnvFile(".env");

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  argv.splice(i, value && !value.startsWith("--") ? 2 : 1);
  return value && !value.startsWith("--") ? value : "true";
};
const root = resolve(flag("root") ?? process.env.STL_ROOT ?? ".");
const out = flag("out");
const team = flag("team") ?? process.env.LINEAR_TEAM_KEY;
const apply = flag("apply") === "true";
const offline = flag("offline") === "true";
const [cmd, sub, ...rest] = argv;

const fail = (message: string) => Effect.fail(new Error(message));
const read = (path: string) => readFileSync(resolve(path), "utf8");
const context = scanWorkspace(root);

const loadPlan = (path: string) =>
  decodePlan(JSON.parse(read(path))).pipe(
    Effect.mapError((e) => new Error(`Invalid plan file: ${e.message}`)),
  );

const specIdOf = (path: string) => basename(path).replace(/\.md$/, "");

const commands: Record<string, () => Effect.Effect<void, unknown>> = {
  context: () =>
    context.pipe(Effect.flatMap((ctx) => Console.log(renderContext(ctx)))),

  spec: () => {
    if (sub === "new") {
      const [slug, title] = rest;
      if (!slug || !title) return fail('Usage: stl spec new <slug> "<title>"');
      const path = join(root, "specs", `${slug}.md`);
      if (existsSync(path)) return fail(`${path} already exists`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, specTemplate(title));
      return Console.log(
        `Wrote ${path}. Co-author it, then run: stl spec lint ${path}`,
      );
    }
    const file = rest[0];
    if (!file) return fail("Missing <spec.md>");
    if (sub === "lint") {
      return Effect.gen(function* () {
        const ctx = yield* context;
        const r = lintSpec(
          read(file),
          ctx.packages.map((p) => p.name),
        );
        yield* Console.log(JSON.stringify(r, null, 2));
        if (!r.ready) process.exitCode = 1;
      });
    }
    if (sub === "review") {
      return Effect.gen(function* () {
        const ctx = yield* context;
        const { review } = yield* reviewSpec({
          spec: read(file),
          context: ctx,
        });
        yield* Console.log(`${review.summary}\n`);
        for (const q of review.questions)
          yield* Console.log(
            `? [${q.section}] ${q.question}\n    why: ${q.why}`,
          );
        yield* Console.log(`\nPackages: ${review.affectedPackages.join(", ")}`);
        for (const r of review.boundaryRisks) yield* Console.log(`! ${r}`);
      }).pipe(Effect.provide(AnthropicModel()));
    }
    return fail(`Unknown: stl spec ${sub ?? ""}`);
  },

  plan: () => {
    const file = sub;
    if (!file) return fail("Missing <spec.md>");
    return Effect.gen(function* () {
      const ctx = yield* context;
      const specId = specIdOf(file);
      const result = yield* decomposeSpec({
        specId,
        spec: read(file),
        context: ctx,
      });
      result.rounds.forEach((r, i) =>
        console.error(
          `round ${i + 1}: ${r.findings.filter((f) => f.severity === "error").length} errors, ${r.findings.length} findings`,
        ),
      );
      if (!result.plan) return yield* fail(renderFindings(result.findings));
      const target = out ?? join(root, "plans", `${specId}.plan.json`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(result.plan, null, 2)}\n`);
      yield* Console.log(planToMarkdown(result.plan));
      yield* Console.log(
        `\n${renderFindings(result.findings)}\n\nWrote ${target}`,
      );
      if (hasErrors(result.findings)) process.exitCode = 1;
    }).pipe(Effect.provide(AnthropicModel()));
  },

  validate: () =>
    Effect.gen(function* () {
      if (!sub) return yield* fail("Missing <plan.json>");
      const [plan, ctx] = yield* Effect.all([loadPlan(sub), context]);
      const findings = validatePlan(plan, ctx);
      yield* Console.log(renderFindings(findings));
      if (hasErrors(findings)) process.exitCode = 1;
    }),

  preview: () =>
    Effect.gen(function* () {
      if (!sub) return yield* fail("Missing <plan.json>");
      yield* Console.log(planToMarkdown(yield* loadPlan(sub)));
    }),

  sync: () =>
    Effect.gen(function* () {
      if (!sub) return yield* fail("Missing <plan.json>");
      const [plan, ctx] = yield* Effect.all([loadPlan(sub), context]);
      const findings = validatePlan(plan, ctx);
      if (hasErrors(findings))
        return yield* fail(
          `Plan has errors; fix them before syncing.\n${renderFindings(findings)}`,
        );
      const layer = offline
        ? LinearInMemory(emptyWorkspace({ key: team ?? "ENG" }))
        : liveLinear();
      const report = yield* syncPlan(plan as Plan, {
        teamKey: team ?? "ENG",
        apply,
      }).pipe(Effect.provide(layer));
      yield* Console.log(renderReport(report));
      if (!apply)
        yield* Console.log(
          "\nNothing was written. Re-run with --apply to create and update these in Linear.",
        );
    }),
};

const liveLinear = () => {
  const key = process.env.LINEAR_API_KEY;
  if (!key)
    throw new Error(
      "LINEAR_API_KEY is not set. Use --offline to try the sync against an in-memory workspace.",
    );
  if (!team) throw new Error("Pass --team KEY or set LINEAR_TEAM_KEY.");
  return LinearLive(key);
};

const run = cmd ? commands[cmd] : undefined;
if (!run) {
  console.log(HELP);
  process.exit(cmd ? 1 : 0);
}

Effect.runPromise(Effect.suspend(run)).catch((e: unknown) => {
  const err = e as { message?: string; reason?: string; _tag?: string };
  console.error(`error: ${err.reason ?? err.message ?? String(e)}`);
  process.exit(1);
});
