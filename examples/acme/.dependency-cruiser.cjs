/** Rules turbo tags cannot express on their own. */
module.exports = {
  forbidden: [
    {
      name: "apps-no-direct-db",
      severity: "error",
      comment: "Apps never touch tenant databases directly. Go through a feature package so tenant resolution and audit hooks always run.",
      from: { path: "^apps/" },
      to: { path: "^packages/(tenant-db|db-schema)/" }
    },
    {
      name: "admin-no-tenant-scoped-features",
      severity: "error",
      comment: "apps/admin is cross-tenant. It may only use feature-tenants, which opens tenant databases explicitly and logs why.",
      from: { path: "^apps/admin/" },
      to: { path: "^packages/feature-(?!tenants/)" }
    }
  ]
}
