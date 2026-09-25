import {
  allTickets,
  epicDescription,
  marker,
  type Plan,
  readRevision,
  ticketDescription,
  topologicalOrder,
} from "@stl/core";
import { Effect } from "effect";
import {
  type IssueInput,
  LinearApi,
  type LinearError,
  type RemoteIssue,
} from "./api.ts";

/**
 * Plan -> Linear. One code path for dry run and apply: in dry run every write
 * is replaced by a placeholder id, so the preview is exactly what apply does.
 *
 * Mapping:
 *   spec          -> Linear project
 *   epic          -> parent issue (label "epic")
 *   ticket        -> sub-issue of its epic, estimate, labels, in the project
 *   dependsOn     -> "blocks" relation from the dependency to the ticket
 *
 * Idempotency: every issue carries `stl:<spec>/<key>` in its description. A re-run
 * finds it by that marker and updates only the fields that differ. Nothing is ever
 * deleted; tickets dropped from the plan are reported as orphans for a human to close.
 */

export type ActionKind = "create" | "update" | "noop";

export interface SyncAction {
  readonly kind: ActionKind;
  readonly entity: "project" | "label" | "epic" | "ticket" | "relation";
  readonly key: string;
  readonly title: string;
  readonly changes: ReadonlyArray<string>;
  readonly url?: string;
}

export interface SyncReport {
  readonly mode: "dry-run" | "apply";
  readonly team: string;
  readonly actions: ReadonlyArray<SyncAction>;
  readonly notes: ReadonlyArray<string>;
}

export interface SyncOptions {
  readonly teamKey: string;
  readonly apply: boolean;
}

const LABEL_COLORS: Record<string, string> = {
  epic: "#5E6AD2",
  feature: "#4EA7FC",
  migration: "#F2994A",
  infra: "#9B51E0",
  test: "#27AE60",
  chore: "#95A2B3",
  docs: "#BB87FC",
};

const diffIssue = (
  remote: RemoteIssue,
  want: IssueInput,
): ReadonlyArray<string> => {
  const changes: Array<string> = [];
  if (remote.title !== want.title) changes.push("title");
  if (readRevision(remote.description) !== readRevision(want.description))
    changes.push("description");
  if (want.estimate !== null && remote.estimate !== want.estimate)
    changes.push(`estimate ${remote.estimate ?? "none"} -> ${want.estimate}`);
  if (remote.parentId !== want.parentId) changes.push("parent");
  if (remote.projectId !== want.projectId) changes.push("project");
  const a = [...remote.labelIds].sort().join();
  const b = [...want.labelIds].sort().join();
  if (a !== b) changes.push("labels");
  return changes;
};

export const syncPlan = (
  plan: Plan,
  opts: SyncOptions,
): Effect.Effect<SyncReport, LinearError, LinearApi> =>
  Effect.gen(function* () {
    const linear = yield* LinearApi;
    const actions: Array<SyncAction> = [];
    const notes: Array<string> = [];
    const pending = (key: string) => `pending:${key}`;

    const team = yield* linear.team(opts.teamKey);
    const useEstimates = team.issueEstimationType !== "notUsed";
    if (!useEstimates)
      notes.push(
        `Team ${team.key} has estimates turned off; points stay in the ticket description only.`,
      );
    if (useEstimates && team.issueEstimationType !== "fibonacci") {
      notes.push(
        `Team ${team.key} uses the ${team.issueEstimationType} scale; plan points (Fibonacci) are sent as-is.`,
      );
    }

    // Project
    const existingProject = yield* linear.findProject(plan.project.name);
    let projectId: string;
    if (existingProject) {
      projectId = existingProject.id;
      actions.push({
        kind: "noop",
        entity: "project",
        key: plan.spec.id,
        title: plan.project.name,
        changes: [],
        url: existingProject.url,
      });
    } else if (opts.apply) {
      const p = yield* linear.createProject({
        name: plan.project.name,
        description: plan.project.description,
        content: plan.project.description,
        teamId: team.id,
      });
      projectId = p.id;
      actions.push({
        kind: "create",
        entity: "project",
        key: plan.spec.id,
        title: plan.project.name,
        changes: [],
        url: p.url,
      });
    } else {
      projectId = pending(plan.spec.id);
      actions.push({
        kind: "create",
        entity: "project",
        key: plan.spec.id,
        title: plan.project.name,
        changes: [],
      });
    }

    // Labels
    const rows = allTickets(plan);
    const wanted = new Set<string>(["epic", `spec:${plan.spec.id}`]);
    for (const e of plan.epics) e.labels.forEach((l) => wanted.add(l));
    for (const { ticket } of rows) {
      wanted.add(ticket.type);
      ticket.labels.forEach((l) => wanted.add(l));
    }
    const remoteLabels = yield* linear.labels(team.id);
    const labelId = new Map(
      remoteLabels.map((l) => [l.name.toLowerCase(), l.id]),
    );
    for (const name of [...wanted].sort()) {
      if (labelId.has(name.toLowerCase())) continue;
      const id = opts.apply
        ? (yield* linear.createLabel({
            name,
            color: LABEL_COLORS[name] ?? "#95A2B3",
            teamId: team.id,
          })).id
        : pending(`label:${name}`);
      labelId.set(name.toLowerCase(), id);
      actions.push({
        kind: "create",
        entity: "label",
        key: name,
        title: name,
        changes: [],
      });
    }
    const ids = (names: ReadonlyArray<string>) => [
      ...new Set(names.map((n) => labelId.get(n.toLowerCase())!)),
    ];

    // Issues (epics first, then tickets in dependency order)
    const issueIds = new Map<string, string>();
    const upsert = (entity: "epic" | "ticket", key: string, want: IssueInput) =>
      Effect.gen(function* () {
        const found = yield* linear.findIssueByMarker(
          team.id,
          marker(plan.spec.id, key),
        );
        if (!found) {
          if (opts.apply) {
            const created = yield* linear.createIssue(team.id, want);
            issueIds.set(key, created.id);
            actions.push({
              kind: "create",
              entity,
              key,
              title: want.title,
              changes: [],
              url: created.url,
            });
          } else {
            issueIds.set(key, pending(key));
            actions.push({
              kind: "create",
              entity,
              key,
              title: want.title,
              changes: [],
            });
          }
          return;
        }
        issueIds.set(key, found.id);
        const changes = diffIssue(found, want);
        if (changes.length === 0) {
          actions.push({
            kind: "noop",
            entity,
            key,
            title: want.title,
            changes,
            url: found.url,
          });
          return;
        }
        if (opts.apply) yield* linear.updateIssue(found.id, want);
        actions.push({
          kind: "update",
          entity,
          key,
          title: want.title,
          changes,
          url: found.url,
        });
      });

    for (const epic of plan.epics) {
      yield* upsert("epic", epic.key, {
        title: epic.title,
        description: epicDescription(plan, epic),
        estimate: null,
        parentId: null,
        projectId,
        labelIds: ids(["epic", `spec:${plan.spec.id}`, ...epic.labels]),
      });
    }

    const epicOf = new Map(
      rows.map(({ epic, ticket }) => [ticket.key, epic.key]),
    );
    for (const ticket of topologicalOrder(rows.map((r) => r.ticket))) {
      yield* upsert("ticket", ticket.key, {
        title: `[${ticket.key}] ${ticket.title}`,
        description: ticketDescription(plan, ticket),
        estimate: useEstimates ? ticket.estimate : null,
        parentId: issueIds.get(epicOf.get(ticket.key)!)!,
        projectId,
        labelIds: ids([ticket.type, `spec:${plan.spec.id}`, ...ticket.labels]),
      });
    }

    // Blocking relations
    for (const { ticket } of rows) {
      const blockedId = issueIds.get(ticket.key)!;
      const existing = blockedId.startsWith("pending:")
        ? []
        : yield* linear.blockers(blockedId);
      for (const dep of ticket.dependsOn) {
        const blockerId = issueIds.get(dep)!;
        const key = `${dep} blocks ${ticket.key}`;
        if (existing.includes(blockerId)) {
          actions.push({
            kind: "noop",
            entity: "relation",
            key,
            title: key,
            changes: [],
          });
          continue;
        }
        if (opts.apply) yield* linear.createBlocks(blockerId, blockedId);
        actions.push({
          kind: "create",
          entity: "relation",
          key,
          title: key,
          changes: [],
        });
      }
    }

    // Orphans: issues from an earlier run of this spec whose key is no longer in the plan.
    const known = new Set([...plan.epics.map((e) => e.key), ...rows.map((r) => r.ticket.key)]);
    const prefix = `stl:${plan.spec.id}/`;
    for (const issue of yield* linear.searchIssues(team.id, prefix)) {
      const key = issue.description.match(new RegExp(`stl:${plan.spec.id}/([\\w-]+)`))?.[1];
      if (key && !known.has(key)) {
        notes.push(`${issue.identifier} (${key}) is no longer in the plan. Close or re-home it by hand: ${issue.url}`);
      }
    }

    return {
      mode: opts.apply ? "apply" : "dry-run",
      team: team.key,
      actions,
      notes,
    } satisfies SyncReport;
  });

export const renderReport = (r: SyncReport): string => {
  const icon = { create: "+", update: "~", noop: "=" } as const;
  const count = (k: ActionKind) => r.actions.filter((a) => a.kind === k).length;
  const lines = [
    `${r.mode === "apply" ? "Applied" : "Dry run"} against team ${r.team}: ${count("create")} to create, ${count("update")} to update, ${count("noop")} unchanged.`,
    "",
  ];
  for (const a of r.actions) {
    const changes = a.changes.length ? `  (${a.changes.join(", ")})` : "";
    const url = a.url ? `  ${a.url}` : "";
    lines.push(
      `${icon[a.kind]} ${a.entity.padEnd(8)} ${a.key.padEnd(18)} ${a.entity === "relation" ? "" : a.title}${changes}${url}`.trimEnd(),
    );
  }
  if (r.notes.length) lines.push("", ...r.notes.map((n) => `note: ${n}`));
  return lines.join("\n");
};
