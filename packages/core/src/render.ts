import type { Epic, Plan, Ticket } from "./schema.ts"

/**
 * Markers make Linear sync idempotent: every issue we create carries one line
 * that ties it back to (spec id, key). A re-run finds the issue by that line
 * and updates it instead of creating a duplicate.
 */
export const marker = (specId: string, key: string) => `stl:${specId}/${key}`

/**
 * Linear rewrites markdown when it stores a description (list markers, escaping),
 * so comparing text would report a change on every run. Instead the footer carries
 * a short hash of the body we sent; a re-run compares hashes.
 */
export const revision = (text: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

export const readRevision = (description: string): string | undefined =>
  description.match(/\brev ([0-9a-f]{8})\b/)?.[1]

const footer = (specId: string, key: string, body: string) =>
  `\n\n---\nGenerated from spec \`${specId}\` · ${marker(specId, key)} · rev ${revision(body)}`

export const ticketDescription = (plan: Plan, ticket: Ticket): string => {
  const ac = ticket.acceptanceCriteria.map((a) => `- [ ] ${a}`).join("\n")
  const pkgs = ticket.packages.map((p) => `\`${p}\``).join(", ")
  const deps = ticket.dependsOn.length ? `\n\n**Blocked by:** ${ticket.dependsOn.join(", ")}` : ""
  const edges = ticket.newDependencies.length
    ? `\n\n**New imports:** ${ticket.newDependencies.map((e) => `\`${e.from}\` → \`${e.to}\``).join(", ")}`
    : ""
  const body = `${ticket.description}

**Packages:** ${pkgs}${edges}${deps}

### Acceptance criteria
${ac}`
  return body + footer(plan.spec.id, ticket.key, body)
}

export const epicDescription = (plan: Plan, epic: Epic): string => {
  const body = `${epic.summary}\n\nTickets: ${epic.tickets.map((t) => t.key).join(", ")}`
  return body + footer(plan.spec.id, epic.key, body)
}

/** Human-readable plan for PR descriptions, chat previews and the README. */
export const planToMarkdown = (plan: Plan): string => {
  const lines = [`# ${plan.project.name}`, "", plan.project.description, ""]
  for (const epic of plan.epics) {
    const points = epic.tickets.reduce((sum, t) => sum + t.estimate, 0)
    lines.push(`## ${epic.key} · ${epic.title} (${points} pts)`, "", epic.summary, "")
    for (const t of epic.tickets) {
      const deps = t.dependsOn.length ? ` · blocked by ${t.dependsOn.join(", ")}` : ""
      lines.push(`- **${t.key}** ${t.title} · ${t.estimate} pts · ${t.packages.join(", ")}${deps}`)
    }
    lines.push("")
  }
  return lines.join("\n")
}
