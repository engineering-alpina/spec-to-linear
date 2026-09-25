import type { Epic, Plan, Ticket } from "./schema.ts"

/**
 * Markers make Linear sync idempotent: every issue we create carries one line
 * that ties it back to (spec id, key). A re-run finds the issue by that line
 * and updates it instead of creating a duplicate.
 */
export const marker = (specId: string, key: string) => `stl:${specId}/${key}`

export const ticketDescription = (plan: Plan, ticket: Ticket): string => {
  const ac = ticket.acceptanceCriteria.map((a) => `- [ ] ${a}`).join("\n")
  const pkgs = ticket.packages.map((p) => `\`${p}\``).join(", ")
  const deps = ticket.dependsOn.length ? `\n\n**Blocked by:** ${ticket.dependsOn.join(", ")}` : ""
  const edges = ticket.newDependencies.length
    ? `\n\n**New imports:** ${ticket.newDependencies.map((e) => `\`${e.from}\` → \`${e.to}\``).join(", ")}`
    : ""
  return `${ticket.description}

**Packages:** ${pkgs}${edges}${deps}

### Acceptance criteria
${ac}

---
Generated from spec \`${plan.spec.id}\` · ${marker(plan.spec.id, ticket.key)}`
}

export const epicDescription = (plan: Plan, epic: Epic): string => `${epic.summary}

Tickets: ${epic.tickets.map((t) => t.key).join(", ")}

---
Generated from spec \`${plan.spec.id}\` · ${marker(plan.spec.id, epic.key)}`

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
