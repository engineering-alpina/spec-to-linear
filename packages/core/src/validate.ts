import {
  type ArchitectureContext,
  findPackage,
  ruleSummary,
  violatedRule,
  type WorkspacePackage,
} from "./architecture.ts";
import { allTickets, type Plan, type Ticket } from "./schema.ts";

/**
 * Deterministic plan checks. The LLM proposes, these decide.
 * Every finding carries a machine code, a JSON-ish path and a message written
 * so it can be pasted straight back to the model as repair instructions.
 */

export type Severity = "error" | "warning";

export interface Finding {
  readonly code: string;
  readonly severity: Severity;
  readonly path: string;
  readonly message: string;
}

export const ESTIMATE_SCALE = [1, 2, 3, 5, 8] as const;
const MAX_ESTIMATE = 8;
const MIN_AC = 2;
const MAX_PACKAGES_PER_TICKET = 2;
const VAGUE_AC =
  /\b(works?( correctly| properly| as expected)?|properly|correctly|as expected|etc\.?|and so on|user[- ]friendly|fast|robust|seamless(ly)?)\s*\.?$/i;

export const validatePlan = (
  plan: Plan,
  ctx: ArchitectureContext,
): ReadonlyArray<Finding> => {
  const findings: Array<Finding> = [];
  const add = (
    severity: Severity,
    code: string,
    path: string,
    message: string,
  ) => findings.push({ severity, code, path, message });

  const rows = allTickets(plan);
  const creators = new Map<string, string>();
  for (const { ticket } of rows)
    for (const p of ticket.createsPackages) creators.set(p.name, ticket.key);
  const planned: Array<WorkspacePackage> = rows.flatMap(({ ticket }) =>
    ticket.createsPackages.map((p) => ({ ...p, kind: "package" as const, dependsOn: [] })),
  );
  const deps = new Map(
    rows.map(({ ticket }) => [ticket.key, ticket.dependsOn]),
  );
  const keys = new Map<string, number>();
  for (const { ticket } of rows)
    keys.set(ticket.key, (keys.get(ticket.key) ?? 0) + 1);
  for (const epic of plan.epics)
    keys.set(epic.key, (keys.get(epic.key) ?? 0) + 1);
  for (const [key, count] of keys) {
    if (count > 1)
      add(
        "error",
        "duplicate-key",
        key,
        `Key "${key}" is used ${count} times. Keys must be unique across epics and tickets.`,
      );
  }

  if (plan.epics.length === 0)
    add("error", "empty-plan", "epics", "The plan has no epics.");

  for (const epic of plan.epics) {
    if (epic.tickets.length === 0)
      add("error", "empty-epic", epic.key, `Epic ${epic.key} has no tickets.`);
  }

  for (const { ticket: t } of rows) {
    const at = t.key;
    checkEstimate(t, add);
    checkAcceptanceCriteria(t, add);

    if (t.packages.length === 0) {
      add(
        "error",
        "no-packages",
        at,
        `${at} does not name the workspace packages it changes. Name at least one from the package list.`,
      );
    }
    for (const { name } of t.createsPackages) {
      if (findPackage(ctx, name))
        add(
          "error",
          "package-exists",
          at,
          `${at} creates "${name}", but that package already exists.`,
        );
      if (!t.packages.includes(name))
        add(
          "warning",
          "created-package-not-listed",
          at,
          `${at} creates "${name}" but does not list it in packages.`,
        );
    }
    for (const name of t.packages) {
      if (findPackage(ctx, name)) continue;
      const creator = creators.get(name);
      if (!creator) {
        add(
          "error",
          "unknown-package",
          at,
          `${at} touches "${name}", which is not a workspace package. Use an existing name or add a ticket whose createsPackages includes it.`,
        );
      } else if (creator !== at && !reaches(deps, at, creator)) {
        add(
          "error",
          "missing-creator-dependency",
          at,
          `${at} touches "${name}", which ${creator} creates, but ${at} does not depend on ${creator} (directly or transitively).`,
        );
      }
    }
    if (t.packages.length > MAX_PACKAGES_PER_TICKET) {
      add(
        "warning",
        "wide-ticket",
        at,
        `${at} touches ${t.packages.length} packages (${t.packages.join(", ")}). Tickets that cross more than ${MAX_PACKAGES_PER_TICKET} packages are hard to review; consider splitting by package.`,
      );
    }

    for (const edge of t.newDependencies) {
      const rule = violatedRule(ctx, edge.from, edge.to, planned);
      if (rule) {
        add(
          "error",
          "boundary-violation",
          at,
          `${at} adds ${edge.from} -> ${edge.to}, which breaks rule "${rule.name}" (${ruleSummary(rule)}). ${rule.comment} Route the call through an allowed layer instead.`,
        );
      }
      if (!t.packages.includes(edge.from)) {
        add(
          "warning",
          "edge-outside-ticket",
          at,
          `${at} declares an import from ${edge.from} but does not list ${edge.from} in its packages.`,
        );
      }
    }

    for (const dep of t.dependsOn) {
      if (dep === t.key)
        add("error", "self-dependency", at, `${at} depends on itself.`);
      else if (!keys.has(dep))
        add(
          "error",
          "unknown-dependency",
          at,
          `${at} depends on "${dep}", which is not a ticket key in this plan.`,
        );
    }
  }

  for (const cycle of findCycles(rows.map((r) => r.ticket))) {
    add(
      "error",
      "dependency-cycle",
      cycle[0] ?? "",
      `Dependency cycle: ${cycle.join(" -> ")}. Break it by splitting one ticket or dropping an edge.`,
    );
  }

  return findings;
};

const reaches = (
  deps: ReadonlyMap<string, ReadonlyArray<string>>,
  from: string,
  target: string,
): boolean => {
  const seen = new Set<string>();
  const stack = [...(deps.get(from) ?? [])];
  while (stack.length) {
    const k = stack.pop()!;
    if (k === target) return true;
    if (seen.has(k)) continue;
    seen.add(k);
    stack.push(...(deps.get(k) ?? []));
  }
  return false;
};

const checkEstimate = (
  t: Ticket,
  add: (s: Severity, c: string, p: string, m: string) => void,
) => {
  if (t.estimate > MAX_ESTIMATE) {
    add(
      "error",
      "too-big",
      t.key,
      `${t.key} is estimated at ${t.estimate} points. Anything above ${MAX_ESTIMATE} must be split into smaller tickets.`,
    );
  } else if (!(ESTIMATE_SCALE as ReadonlyArray<number>).includes(t.estimate)) {
    add(
      "error",
      "off-scale-estimate",
      t.key,
      `${t.key} has estimate ${t.estimate}. Use the Fibonacci scale: ${ESTIMATE_SCALE.join(", ")}.`,
    );
  }
};

const checkAcceptanceCriteria = (
  t: Ticket,
  add: (s: Severity, c: string, p: string, m: string) => void,
) => {
  if (t.acceptanceCriteria.length < MIN_AC) {
    add(
      "error",
      "thin-acceptance-criteria",
      t.key,
      `${t.key} has ${t.acceptanceCriteria.length} acceptance criteria. Write at least ${MIN_AC} observable, testable outcomes.`,
    );
  }
  t.acceptanceCriteria.forEach((ac, i) => {
    if (VAGUE_AC.test(ac.trim())) {
      add(
        "warning",
        "vague-acceptance-criterion",
        `${t.key}.acceptanceCriteria[${i}]`,
        `"${ac}" is not testable. State the observable result (value, status code, UI state, test name).`,
      );
    }
  });
};

/** Tarjan-free DFS: fine for plans with tens of tickets. Returns each cycle once. */
export const findCycles = (
  tickets: ReadonlyArray<Ticket>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const graph = new Map(tickets.map((t) => [t.key, t.dependsOn]));
  const state = new Map<string, "visiting" | "done">();
  const stack: Array<string> = [];
  const cycles: Array<Array<string>> = [];
  const seen = new Set<string>();

  const visit = (key: string) => {
    state.set(key, "visiting");
    stack.push(key);
    for (const next of graph.get(key) ?? []) {
      if (!graph.has(next)) continue;
      if (state.get(next) === "visiting") {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        const id = [...cycle].slice(0, -1).sort().join("|");
        if (!seen.has(id)) {
          seen.add(id);
          cycles.push(cycle);
        }
      } else if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(key, "done");
  };

  for (const key of graph.keys()) if (!state.has(key)) visit(key);
  return cycles;
};

/** Tickets in an order where every dependency comes first. Assumes no cycles. */
export const topologicalOrder = (
  tickets: ReadonlyArray<Ticket>,
): ReadonlyArray<Ticket> => {
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const out: Array<Ticket> = [];
  const done = new Set<string>();
  const visit = (t: Ticket) => {
    if (done.has(t.key)) return;
    done.add(t.key);
    for (const dep of t.dependsOn) {
      const d = byKey.get(dep);
      if (d) visit(d);
    }
    out.push(t);
  };
  tickets.forEach(visit);
  return out;
};

export const hasErrors = (findings: ReadonlyArray<Finding>) =>
  findings.some((f) => f.severity === "error");

export const renderFindings = (findings: ReadonlyArray<Finding>): string =>
  findings.length === 0
    ? "No findings. The plan is valid."
    : findings
        .map((f) => `- [${f.severity}] ${f.code} @ ${f.path}: ${f.message}`)
        .join("\n");
