/**
 * Specs are markdown files with a fixed set of sections. The template is the
 * co-authoring contract: the agent fills it with the team, `lintSpec` says when
 * it is ready to be decomposed.
 */

export const REQUIRED_SECTIONS = [
  "Problem",
  "Goals",
  "Non-goals",
  "User stories",
  "Affected packages",
  "Data model",
  "Rollout",
  "Open questions"
] as const

export interface SpecLintResult {
  readonly ready: boolean
  readonly missingSections: ReadonlyArray<string>
  readonly emptySections: ReadonlyArray<string>
  readonly openQuestions: ReadonlyArray<string>
  readonly mentionedPackages: ReadonlyArray<string>
}

const sections = (md: string): Map<string, string> => {
  const out = new Map<string, string>()
  const parts = md.split(/^##\s+/m).slice(1)
  for (const part of parts) {
    const [head = "", ...body] = part.split("\n")
    out.set(head.trim(), body.join("\n").trim())
  }
  return out
}

/** Open questions are unchecked task-list items: "- [ ] ...". Checked ones ("- [x]") count as answered. */
export const lintSpec = (md: string, knownPackages: ReadonlyArray<string> = []): SpecLintResult => {
  const s = sections(md)
  const missingSections = REQUIRED_SECTIONS.filter((name) => !s.has(name))
  const emptySections = REQUIRED_SECTIONS.filter((name) => {
    const body = s.get(name)
    return body !== undefined && body.replace(/<!--[\s\S]*?-->/g, "").trim() === "" && name !== "Open questions"
  })
  const openQuestions = (s.get("Open questions") ?? "")
    .split("\n")
    .filter((line) => /^\s*-\s\[\s\]\s+/.test(line))
    .map((line) => line.replace(/^\s*-\s\[\s\]\s+/, "").trim())
  const mentionedPackages = knownPackages.filter((name) => md.includes(name))
  return {
    ready: missingSections.length === 0 && emptySections.length === 0 && openQuestions.length === 0,
    missingSections,
    emptySections,
    openQuestions,
    mentionedPackages
  }
}

export const specTemplate = (title: string): string => `# ${title}

<!-- Status: draft. Co-author this with the spec agent, then run \`stl spec lint\` before decomposing. -->

## Problem

<!-- Who hurts today, how often, and what it costs. -->

## Goals

## Non-goals

## User stories

<!-- As a <role>, I want <capability> so that <outcome>. -->

## Affected packages

<!-- Exact workspace package names. The agent proposes these from the architecture context. -->

## Data model

<!-- Tables, columns, migrations. Remember one Neon database per tenant: every migration runs N times. -->

## Rollout

<!-- Feature flag, tenant-by-tenant order, backfill, kill switch. -->

## Open questions

<!-- Unchecked items block decomposition. Tick them when answered and write the answer inline. -->
`
