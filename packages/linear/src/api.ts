import { Context, Data, Effect, Layer } from "effect";

/**
 * The slice of Linear this tool needs, as an Effect service. Two layers:
 * `LinearLive` talks GraphQL to api.linear.app, `LinearInMemory` is a fake
 * workspace for tests and offline dry runs. Sync code only sees the interface.
 */

export class LinearError extends Data.TaggedError("LinearError")<{
  readonly operation: string;
  readonly message: string;
}> {}

export type EstimationType =
  | "notUsed"
  | "exponential"
  | "fibonacci"
  | "linear"
  | "tShirt";

export interface LinearTeam {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly issueEstimationType: EstimationType;
}

export interface RemoteProject {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

export interface RemoteLabel {
  readonly id: string;
  readonly name: string;
}

export interface RemoteIssue {
  readonly id: string;
  readonly identifier: string;
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly estimate: number | null;
  readonly parentId: string | null;
  readonly projectId: string | null;
  readonly labelIds: ReadonlyArray<string>;
}

export interface IssueInput {
  readonly title: string;
  readonly description: string;
  readonly estimate: number | null;
  readonly parentId: string | null;
  readonly projectId: string;
  readonly labelIds: ReadonlyArray<string>;
}

export interface LinearApiShape {
  readonly team: (key: string) => Effect.Effect<LinearTeam, LinearError>;
  readonly findProject: (
    name: string,
  ) => Effect.Effect<RemoteProject | undefined, LinearError>;
  readonly createProject: (input: {
    readonly name: string;
    readonly description: string;
    readonly content: string;
    readonly teamId: string;
  }) => Effect.Effect<RemoteProject, LinearError>;
  /** Labels usable by the team: the team's own plus workspace-level ones. */
  readonly labels: (
    teamId: string,
  ) => Effect.Effect<ReadonlyArray<RemoteLabel>, LinearError>;
  readonly createLabel: (input: {
    readonly name: string;
    readonly color: string;
    readonly teamId: string;
  }) => Effect.Effect<RemoteLabel, LinearError>;
  readonly findIssueByMarker: (
    teamId: string,
    marker: string,
  ) => Effect.Effect<RemoteIssue | undefined, LinearError>;
  readonly createIssue: (
    teamId: string,
    input: IssueInput,
  ) => Effect.Effect<RemoteIssue, LinearError>;
  readonly updateIssue: (
    id: string,
    input: IssueInput,
  ) => Effect.Effect<RemoteIssue, LinearError>;
  /** All team issues whose description contains `text`. Used to find orphans from earlier runs. */
  readonly searchIssues: (
    teamId: string,
    text: string,
  ) => Effect.Effect<ReadonlyArray<RemoteIssue>, LinearError>;
  /** Ids of issues that block `issueId`. */
  readonly blockers: (
    issueId: string,
  ) => Effect.Effect<ReadonlyArray<string>, LinearError>;
  readonly createBlocks: (
    blockerId: string,
    blockedId: string,
  ) => Effect.Effect<void, LinearError>;
}

export class LinearApi extends Context.Tag("@stl/linear/LinearApi")<
  LinearApi,
  LinearApiShape
>() {}

// ---------------------------------------------------------------- live

const ENDPOINT = "https://api.linear.app/graphql";

const ISSUE_FIELDS = `id identifier url title description estimate parent { id } project { id } labels(first: 50) { nodes { id } } `;

interface IssueNode {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  estimate: number | null;
  parent: { id: string } | null;
  project: { id: string } | null;
  labels: { nodes: Array<{ id: string }> };
}

const toIssue = (n: IssueNode): RemoteIssue => ({
  id: n.id,
  identifier: n.identifier,
  url: n.url,
  title: n.title,
  description: n.description ?? "",
  estimate: n.estimate,
  parentId: n.parent?.id ?? null,
  projectId: n.project?.id ?? null,
  labelIds: n.labels.nodes.map((l) => l.id),
});

const issueInput = (input: IssueInput) => ({
  title: input.title,
  description: input.description,
  parentId: input.parentId,
  projectId: input.projectId,
  labelIds: input.labelIds,
  ...(input.estimate === null ? {} : { estimate: input.estimate }),
});

export const makeLinearLive = (apiKey: string): LinearApiShape => {
  const gql = <T>(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: apiKey,
          },
          body: JSON.stringify({ query, variables }),
        });
        const body = (await res.json()) as {
          data?: T;
          errors?: Array<{ message: string }>;
        };
        if (!res.ok || body.errors?.length) {
          throw new Error(
            body.errors?.map((e) => e.message).join("; ") ||
              `HTTP ${res.status}`,
          );
        }
        return body.data as T;
      },
      catch: (e) =>
        new LinearError({
          operation,
          message: e instanceof Error ? e.message : String(e),
        }),
    });

  return {
    team: (key) =>
      gql<{ teams: { nodes: Array<LinearTeam> } }>(
        "team",
        `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key name issueEstimationType } } }`,
        { key },
      ).pipe(
        Effect.flatMap(({ teams }) =>
          teams.nodes[0]
            ? Effect.succeed(teams.nodes[0])
            : Effect.fail(
                new LinearError({
                  operation: "team",
                  message: `No team with key ${key}`,
                }),
              ),
        ),
      ),

    findProject: (name) =>
      gql<{ projects: { nodes: Array<RemoteProject> } }>(
        "findProject",
        `query($name: String!) { projects(filter: { name: { eq: $name } }, first: 1) { nodes { id name url } } }`,
        { name },
      ).pipe(Effect.map(({ projects }) => projects.nodes[0])),

    createProject: ({ name, description, content, teamId }) =>
      gql<{ projectCreate: { project: RemoteProject } }>(
        "createProject",
        `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name url } } }`,
        // Linear caps the project description at 255 chars; the full text goes into content.
        {
          input: {
            name,
            description: description.slice(0, 255),
            content,
            teamIds: [teamId],
          },
        },
      ).pipe(Effect.map((d) => d.projectCreate.project)),

    labels: (teamId) =>
      gql<{
        issueLabels: {
          nodes: Array<{
            id: string;
            name: string;
            team: { id: string } | null;
          }>;
        };
      }>(
        "labels",
        `query { issueLabels(first: 250) { nodes { id name team { id } } } }`,
        {},
      ).pipe(
        Effect.map(({ issueLabels }) =>
          issueLabels.nodes
            .filter((l) => l.team === null || l.team.id === teamId)
            .map(({ id, name }) => ({ id, name })),
        ),
      ),

    createLabel: (input) =>
      gql<{ issueLabelCreate: { issueLabel: RemoteLabel } }>(
        "createLabel",
        `mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name } } }`,
        { input },
      ).pipe(Effect.map((d) => d.issueLabelCreate.issueLabel)),

    findIssueByMarker: (teamId, marker) =>
      gql<{ issues: { nodes: Array<IssueNode> } }>(
        "findIssueByMarker",
        `query($teamId: ID!, $marker: String!) {
          issues(filter: { team: { id: { eq: $teamId } }, description: { contains: $marker } }, first: 5) { nodes { ${ISSUE_FIELDS} } }
        }`,
        { teamId, marker },
      ).pipe(
        // "contains" would also match stl:spec/AUD-1 inside stl:spec/AUD-10; require the marker as a whole token.
        Effect.map(({ issues }) =>
          issues.nodes
            .map(toIssue)
            .find((i) => hasMarker(i.description, marker)),
        ),
      ),

    searchIssues: (teamId, text) =>
      gql<{ issues: { nodes: Array<IssueNode> } }>(
        "searchIssues",
        `query($teamId: ID!, $text: String!) {
          issues(filter: { team: { id: { eq: $teamId } }, description: { contains: $text } }, first: 250) { nodes { ${ISSUE_FIELDS} } }
        }`,
        { teamId, text },
      ).pipe(Effect.map(({ issues }) => issues.nodes.map(toIssue))),

    createIssue: (teamId, input) =>
      gql<{ issueCreate: { issue: IssueNode } }>(
        "createIssue",
        `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
        { input: { teamId, ...issueInput(input) } },
      ).pipe(Effect.map((d) => toIssue(d.issueCreate.issue))),

    updateIssue: (id, input) =>
      gql<{ issueUpdate: { issue: IssueNode } }>(
        "updateIssue",
        `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
        { id, input: issueInput(input) },
      ).pipe(Effect.map((d) => toIssue(d.issueUpdate.issue))),

    blockers: (issueId) =>
      gql<{
        issue: {
          inverseRelations: {
            nodes: Array<{ type: string; issue: { id: string } }>;
          };
        };
      }>(
        "blockers",
        `query($id: String!) { issue(id: $id) { inverseRelations(first: 100) { nodes { type issue { id } } } } }`,
        { id: issueId },
      ).pipe(
        Effect.map((d) =>
          d.issue.inverseRelations.nodes
            .filter((r) => r.type === "blocks")
            .map((r) => r.issue.id),
        ),
      ),

    createBlocks: (blockerId, blockedId) =>
      gql(
        "createBlocks",
        `mutation($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }`,
        {
          input: {
            issueId: blockerId,
            relatedIssueId: blockedId,
            type: "blocks",
          },
        },
      ).pipe(Effect.asVoid),
  };
};

export const LinearLive = (apiKey: string) =>
  Layer.succeed(LinearApi, makeLinearLive(apiKey));

export const hasMarker = (description: string, marker: string) =>
  new RegExp(
    `${marker.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![\\w-])`,
  ).test(description);

// ---------------------------------------------------------------- in-memory

export interface InMemoryState {
  readonly team: LinearTeam;
  readonly projects: Array<RemoteProject>;
  readonly labels: Array<RemoteLabel>;
  readonly issues: Array<RemoteIssue>;
  readonly relations: Array<{ blockerId: string; blockedId: string }>;
  /** Every mutation, in order. Tests assert on this to prove idempotency. */
  readonly writes: Array<string>;
}

export const emptyWorkspace = (
  team: Partial<LinearTeam> = {},
): InMemoryState => ({
  team: {
    id: "team-1",
    key: "ENG",
    name: "Engineering",
    issueEstimationType: "fibonacci",
    ...team,
  },
  projects: [],
  labels: [],
  issues: [],
  relations: [],
  writes: [],
});

export const makeLinearInMemory = (state: InMemoryState): LinearApiShape => {
  let seq = 0;
  const id = (prefix: string) => `${prefix}-${++seq}`;
  return {
    team: (key) =>
      key === state.team.key
        ? Effect.succeed(state.team)
        : Effect.fail(
            new LinearError({
              operation: "team",
              message: `No team with key ${key}`,
            }),
          ),
    findProject: (name) =>
      Effect.sync(() => state.projects.find((p) => p.name === name)),
    createProject: ({ name }) =>
      Effect.sync(() => {
        const p = {
          id: id("project"),
          name,
          url: `https://linear.app/acme/project/${seq}`,
        };
        state.projects.push(p);
        state.writes.push(`createProject ${name}`);
        return p;
      }),
    labels: () => Effect.sync(() => [...state.labels]),
    createLabel: ({ name }) =>
      Effect.sync(() => {
        const l = { id: id("label"), name };
        state.labels.push(l);
        state.writes.push(`createLabel ${name}`);
        return l;
      }),
    findIssueByMarker: (_teamId, marker) =>
      Effect.sync(() =>
        state.issues.find((i) => hasMarker(i.description, marker)),
      ),
    searchIssues: (_teamId, text) =>
      Effect.sync(() => state.issues.filter((i) => i.description.includes(text))),
    createIssue: (_teamId, input) =>
      Effect.sync(() => {
        const n = state.issues.length + 1;
        const issue: RemoteIssue = {
          id: id("issue"),
          identifier: `${state.team.key}-${n}`,
          url: `https://linear.app/acme/issue/${state.team.key}-${n}`,
          ...input,
          labelIds: [...input.labelIds],
        };
        state.issues.push(issue);
        state.writes.push(`createIssue ${input.title}`);
        return issue;
      }),
    updateIssue: (issueId, input) =>
      Effect.sync(() => {
        const i = state.issues.findIndex((x) => x.id === issueId);
        const next = {
          ...state.issues[i]!,
          ...input,
          labelIds: [...input.labelIds],
        };
        state.issues[i] = next;
        state.writes.push(`updateIssue ${next.identifier}`);
        return next;
      }),
    blockers: (issueId) =>
      Effect.sync(() =>
        state.relations
          .filter((r) => r.blockedId === issueId)
          .map((r) => r.blockerId),
      ),
    createBlocks: (blockerId, blockedId) =>
      Effect.sync(() => {
        state.relations.push({ blockerId, blockedId });
        state.writes.push(`createBlocks ${blockerId} -> ${blockedId}`);
      }),
  };
};

export const LinearInMemory = (state: InMemoryState) =>
  Layer.succeed(LinearApi, makeLinearInMemory(state));
