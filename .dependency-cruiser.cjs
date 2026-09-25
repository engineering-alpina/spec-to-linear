/**
 * This repo follows the same rule it enforces on others: libraries point
 * inward to @stl/core, only apps compose them.
 */
module.exports = {
  forbidden: [
    {
      name: "core-is-a-leaf",
      severity: "error",
      comment: "@stl/core holds the schema and validators. It must not know about IO, Linear or LLMs.",
      from: { path: "^packages/core/" },
      to: { path: "^packages/", pathNot: "^packages/core/" }
    },
    {
      name: "libraries-only-depend-on-core",
      severity: "error",
      comment: "context, planner and linear are siblings. They share types through core, never through each other.",
      from: { path: "^packages/(context|planner|linear)/" },
      to: { path: "^packages/", pathNot: ["^packages/core/", "^packages/$1/"] }
    },
    {
      name: "no-apps-from-packages",
      severity: "error",
      comment: "Packages never import app code.",
      from: { path: "^packages/" },
      to: { path: "^apps/" }
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true }
    }
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "examples/" },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "default"], extensions: [".ts", ".js"] }
  }
}
