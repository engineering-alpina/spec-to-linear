#!/usr/bin/env -S npx tsx
/**
 * Minimal MCP client: `pnpm mcp:call <tool> [args.json]`. Spawns the stdio server,
 * calls one tool and prints the result. Every call is appended to
 * docs/runs/<STL_RUN>.md when STL_RUN is set, which is how the demo transcripts were recorded.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { appendFileSync, readFileSync } from "node:fs"

const [tool, argsFile] = process.argv.slice(2)
if (!tool) {
  console.error("usage: mcp:call <tool> [args.json]")
  process.exit(1)
}
const args = argsFile ? (JSON.parse(readFileSync(argsFile, "utf8")) as Record<string, unknown>) : {}

const client = new Client({ name: "stl-call", version: "0.1.0" })
await client.connect(
  new StdioClientTransport({ command: "npx", args: ["tsx", "apps/mcp/src/server.ts"], env: { ...process.env } as Record<string, string> })
)
const res = (await client.callTool({ name: tool, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean }
const text = res.content.map((c) => c.text).join("\n")
console.log(text)

if (process.env.STL_RUN) {
  const shown = Object.fromEntries(
    Object.entries(args).map(([k, v]) => [k, typeof v === "string" && v.length > 200 ? `<${v.length} chars>` : v])
  )
  appendFileSync(
    `docs/runs/${process.env.STL_RUN}.md`,
    `\n### ${res.isError ? "✗" : "→"} \`${tool}\` ${JSON.stringify(shown)}\n\n\`\`\`text\n${text}\n\`\`\`\n`
  )
}
await client.close()
