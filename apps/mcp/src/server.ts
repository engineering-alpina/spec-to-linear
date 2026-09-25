#!/usr/bin/env -S npx tsx
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { scanWorkspace } from "@stl/context";
import {
  decodePlan,
  hasErrors,
  lintSpec,
  planToMarkdown,
  renderContext,
  renderFindings,
  specTemplate,
  validatePlan,
} from "@stl/core";
import { LinearLive, renderReport, syncPlan } from "@stl/linear";
import { Effect } from "effect";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

/**
 * MCP server for Cursor and Claude Code. The IDE agent is the LLM here: it
 * co-authors the spec with the engineer and drafts the plan. This server gives
 * it the codebase context and the deterministic gates (lint, validate, dry run)
 * so the agent cannot push a plan that breaks the architecture.
 *
 * No tool calls an LLM, so no model API key is needed inside the IDE.
 */

const ROOT = resolve(process.env.STL_ROOT ?? process.cwd());
for (const dir of new Set([process.cwd(), ROOT])) {
  if (existsSync(join(dir, ".env"))) process.loadEnvFile(join(dir, ".env"));
}

const inRoot = (path: string) => {
  const abs = isAbsolute(path) ? path : join(ROOT, path);
  if (relative(ROOT, abs).startsWith(".."))
    throw new Error(`${path} is outside the workspace root`);
  return abs;
};

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const error = (t: string) => ({ ...text(t), isError: true });
const context = () => Effect.runPromise(scanWorkspace(ROOT));

const server = new McpServer({ name: "spec-to-linear", version: "0.1.0" });

server.registerTool(
  "get_architecture_context",
  {
    description:
      "Workspace packages with layer tags, purpose and internal deps, plus every boundary rule from Turborepo boundaries and dependency-cruiser, plus architecture notes. Call this before discussing or decomposing any spec.",
    inputSchema: {},
  },
  async () => text(renderContext(await context())),
);

server.registerTool(
  "new_spec",
  {
    description:
      "Create specs/<slug>.md from the team spec template and return its path and content.",
    inputSchema: { slug: z.string().regex(/^[a-z0-9-]+$/), title: z.string() },
  },
  async ({ slug, title }) => {
    const path = inRoot(`specs/${slug}.md`);
    if (existsSync(path))
      return error(`${relative(ROOT, path)} already exists`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, specTemplate(title));
    return text(
      `Created ${relative(ROOT, path)}\n\n${readFileSync(path, "utf8")}`,
    );
  },
);

server.registerTool(
  "lint_spec",
  {
    description:
      "Check a spec is ready to decompose: all template sections present and filled, no unchecked open questions. Also lists which workspace packages it mentions.",
    inputSchema: {
      path: z
        .string()
        .describe("Path to the spec markdown, relative to the repo root"),
    },
  },
  async ({ path }) => {
    const ctx = await context();
    return text(
      JSON.stringify(
        lintSpec(
          readFileSync(inRoot(path), "utf8"),
          ctx.packages.map((p) => p.name),
        ),
        null,
        2,
      ),
    );
  },
);

server.registerTool(
  "validate_plan",
  {
    description:
      "Validate a ticket plan (JSON matching the plan schema in packages/core/src/schema.ts) against the codebase: boundary rules on every new import, dependency cycles, creator-before-consumer order for new packages, Fibonacci estimates up to 8, at least two testable acceptance criteria. Fix every error and re-validate before saving.",
    inputSchema: { plan: z.string().describe("The plan as a JSON string") },
  },
  async ({ plan }) => {
    const ctx = await context();
    const decoded = await Effect.runPromise(
      Effect.either(decodePlan(JSON.parse(plan))),
    );
    if (decoded._tag === "Left")
      return error(`Plan does not match the schema: ${decoded.left.message}`);
    const findings = validatePlan(decoded.right, ctx);
    return text(
      `${renderFindings(findings)}\n\n${planToMarkdown(decoded.right)}`,
    );
  },
);

server.registerTool(
  "save_plan",
  {
    description:
      "Validate and write the plan to plans/<spec id>.plan.json. Refuses to save a plan with errors.",
    inputSchema: { plan: z.string().describe("The plan as a JSON string") },
  },
  async ({ plan }) => {
    const ctx = await context();
    const decoded = await Effect.runPromise(
      Effect.either(decodePlan(JSON.parse(plan))),
    );
    if (decoded._tag === "Left")
      return error(`Plan does not match the schema: ${decoded.left.message}`);
    const findings = validatePlan(decoded.right, ctx);
    if (hasErrors(findings))
      return error(`Not saved.\n${renderFindings(findings)}`);
    const path = inRoot(`plans/${decoded.right.spec.id}.plan.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(decoded.right, null, 2)}\n`);
    return text(`Saved ${relative(ROOT, path)}\n${renderFindings(findings)}`);
  },
);

const syncTool =
  (apply: boolean) =>
  async ({ path, team }: { path: string; team?: string | undefined }) => {
    const key = process.env.LINEAR_API_KEY;
    const teamKey = team ?? process.env.LINEAR_TEAM_KEY;
    if (!key || !teamKey)
      return error(
        "Set LINEAR_API_KEY and LINEAR_TEAM_KEY (or pass team) in the MCP server env.",
      );
    const ctx = await context();
    const plan = await Effect.runPromise(
      decodePlan(JSON.parse(readFileSync(inRoot(path), "utf8"))),
    );
    const findings = validatePlan(plan, ctx);
    if (hasErrors(findings))
      return error(
        `Plan has errors; not syncing.\n${renderFindings(findings)}`,
      );
    const exit = await Effect.runPromiseExit(
      syncPlan(plan, { teamKey, apply }).pipe(Effect.provide(LinearLive(key))),
    );
    if (exit._tag === "Failure")
      return error(`Linear sync failed: ${JSON.stringify(exit.cause)}`);
    return text(renderReport(exit.value));
  };

server.registerTool(
  "preview_linear_sync",
  {
    description:
      "Dry run: show exactly which Linear projects, labels, epics, sub-issues and blocking relations would be created or updated for a saved plan. Writes nothing. Always show this to the engineer before applying.",
    inputSchema: { path: z.string(), team: z.string().optional() },
  },
  syncTool(false),
);

server.registerTool(
  "apply_linear_sync",
  {
    description:
      "Write a saved plan to Linear. Idempotent: re-running updates changed tickets and never duplicates. Only call after the engineer has seen preview_linear_sync and said yes.",
    inputSchema: { path: z.string(), team: z.string().optional() },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  syncTool(true),
);

await server.connect(new StdioServerTransport());
