# Run: invite-expiry, Claude Code driving the MCP server

Recorded 2026-09-25. The agent is Claude (Opus 5.5) in Claude Code; every tool call below went through `apps/mcp/src/server.ts` over stdio and is shown with its real output. The plan JSON arguments are elided by size.

### → `lint_spec` {"path":"specs/invite-expiry.md"}

```text
{
  "ready": true,
  "missingSections": [],
  "emptySections": [],
  "openQuestions": [],
  "mentionedPackages": [
    "@acme/api",
    "@acme/portal",
    "@acme/db-schema",
    "@acme/feature-members",
    "@acme/members-domain"
  ]
}
```

### → `get_architecture_context` {}

```text
## Workspace packages
- @acme/admin [layer:app] apps/admin
  Internal back-office Next.js app for support and ops staff. Cross-tenant views go through feature-tenants.
  deps: @acme/feature-tenants, @acme/ui, @acme/effect-kit
- @acme/api [layer:app] apps/api
  Public REST API as Next.js route handlers. Versioned under /v1, API-key auth per tenant.
  deps: @acme/feature-members, @acme/effect-kit
- @acme/docs [layer:app] apps/docs
  Next.js docs site for customers. Static, no tenant data.
  deps: @acme/ui
- @acme/portal [layer:app] apps/portal
  Tenant-admin Next.js app: members, roles, billing settings for one tenant.
  deps: @acme/feature-members, @acme/feature-billing, @acme/ui
- @acme/web [layer:app] apps/web
  Customer-facing Next.js App Router app. Server components call feature packages; no direct DB access.
  deps: @acme/feature-dashboard, @acme/feature-billing, @acme/ui, @acme/effect-kit
- @acme/billing-domain [layer:domain] packages/billing-domain
  Pure billing rules: plan limits, proration, invoice math. No IO.
  deps: @acme/effect-kit
- @acme/db-schema [layer:infra] packages/db-schema
  Drizzle table definitions and SQL migrations. Migrations are applied to every tenant database by the migrate runner.
  deps: none
- @acme/effect-kit [layer:shared] packages/effect-kit
  Shared Effect helpers: runtime, tagged errors, config, test layers.
  deps: none
- @acme/feature-billing [layer:feature] packages/feature-billing
  Billing use-cases: plans, invoices, Stripe webhooks wiring.
  deps: @acme/billing-domain, @acme/tenant-db, @acme/ui, @acme/effect-kit
- @acme/feature-dashboard [layer:feature] packages/feature-dashboard
  Dashboard use-cases and server actions for apps/web.
  deps: @acme/members-domain, @acme/tenant-db, @acme/ui, @acme/effect-kit
- @acme/feature-members [layer:feature] packages/feature-members
  Member and role management use-cases, shared by portal and api.
  deps: @acme/members-domain, @acme/tenant-db, @acme/effect-kit
- @acme/feature-tenants [layer:feature] packages/feature-tenants
  Tenant lifecycle for admin: provisioning a Neon database, suspending, deleting.
  deps: @acme/tenant-db, @acme/effect-kit
- @acme/members-domain [layer:domain] packages/members-domain
  Pure domain model for members and roles: Effect Schema types, policies, errors. No IO.
  deps: @acme/effect-kit
- @acme/observability [layer:infra] packages/observability
  Sentry and OpenTelemetry wiring as Effect Layers.
  deps: @acme/effect-kit
- @acme/tenant-db [layer:infra] packages/tenant-db
  Effect Layer that resolves the current tenant and hands out a Drizzle client bound to that tenant's Neon database.
  deps: @acme/db-schema, @acme/effect-kit, @acme/observability
- @acme/ui [layer:ui] packages/ui
  Shared React component library (shadcn based). Presentational only.
  deps: none

## Boundary rules
- (turbo) turbo-boundaries:layer:feature: tag:layer:feature must not depend on tag:layer:app. 
- (turbo) turbo-boundaries:layer:domain: tag:layer:domain must not depend on tag:layer:app, tag:layer:feature, tag:layer:infra, tag:layer:ui. 
- (turbo) turbo-boundaries:layer:infra: tag:layer:infra must not depend on tag:layer:app, tag:layer:feature, tag:layer:ui. 
- (turbo) turbo-boundaries:layer:ui: tag:layer:ui must not depend on tag:layer:app, tag:layer:feature, tag:layer:domain, tag:layer:infra. 
- (turbo) turbo-boundaries:layer:shared: tag:layer:shared must not depend on tag:layer:app, tag:layer:feature, tag:layer:domain, tag:layer:infra, tag:layer:ui. 
- (dependency-cruiser) apps-no-direct-db: path:^apps/ must not depend on path:^packages/(tenant-db|db-schema)/. Apps never touch tenant databases directly. Go through a feature package so tenant resolution and audit hooks always run.
- (dependency-cruiser) admin-no-tenant-scoped-features: path:^apps/admin/ must not depend on path:^packages/feature-(?!tenants/). apps/admin is cross-tenant. It may only use feature-tenants, which opens tenant databases explicitly and logs why.

## Architecture notes
# Acme architecture notes

- Multi-tenant SaaS. One Neon Postgres database per tenant. A schema migration is applied to every tenant database by the migrate runner, so migrations must be backwards compatible and idempotent.
- Layers: app -> feature -> domain / infra -> shared. Domain packages are pure (Effect Schema + policies, no IO). Infra packages own IO (databases, Sentry). Features compose domain and infra into use-cases and expose server actions.
- Every service is an Effect `Context.Tag` with a live Layer and a test Layer in the same package. Tests use Vitest with the test Layer; no real database in unit tests.
- Errors are `Data.TaggedError` classes. Sentry captures them through the observability Layer.
- New package = new folder under packages/ with package.json, turbo.json tags and a README. A new package is its own ticket because it needs tags and boundary review.
```

### → `validate_plan` {"plan":"<6816 chars>"}

```text
- [error] boundary-violation @ INV-9: INV-9 adds @acme/portal -> @acme/db-schema, which breaks rule "apps-no-direct-db" (path:^apps/ must not depend on path:^packages/(tenant-db|db-schema)/). Apps never touch tenant databases directly. Go through a feature package so tenant resolution and audit hooks always run. Route the call through an allowed layer instead.

# Member invite expiry

Invites expire after a per-tenant TTL, admins manage pending invites in the portal, old invites are backfilled. Spec: specs/invite-expiry.md

## INV-E1 · Expiry model and schema (4 pts)

Policy and columns everything else builds on.

- **INV-1** Invite expiry policy in members-domain · 2 pts · @acme/members-domain
- **INV-2** Add expires_at and invite_ttl_days columns · 2 pts · @acme/db-schema

## INV-E2 · Write and enforce expiry (11 pts)

New invites carry an expiry, old ones are backfilled, accept enforces it.

- **INV-3** Set expires_at on invite create and resend · 3 pts · @acme/feature-members · blocked by INV-1, INV-2
- **INV-4** Backfill expiry for existing invites · 3 pts · @acme/feature-members · blocked by INV-3
- **INV-5** Enforce expiry on accept behind invite-expiry flag · 3 pts · @acme/feature-members · blocked by INV-3
- **INV-6** Make expires_at not null · 2 pts · @acme/db-schema · blocked by INV-4

## INV-E3 · Admin and invitee surfaces (14 pts)

Portal management, TTL setting, expired-link page and API field.

- **INV-7** List, resend and revoke pending invites use-cases · 3 pts · @acme/feature-members · blocked by INV-3
- **INV-8** Pending invites table in the portal · 5 pts · @acme/portal · blocked by INV-7
- **INV-9** Invite TTL setting in portal settings · 3 pts · @acme/portal · blocked by INV-1, INV-2
- **INV-10** Expired invite page · 2 pts · @acme/portal · blocked by INV-5
- **INV-11** Return expires_at from POST /v1/invites · 1 pts · @acme/api · blocked by INV-3

```

### → `validate_plan` {"plan":"<7458 chars>"}

```text
No findings. The plan is valid.

# Member invite expiry

Invites expire after a per-tenant TTL, admins manage pending invites in the portal, old invites are backfilled. Spec: specs/invite-expiry.md

## INV-E1 · Expiry model and schema (4 pts)

Policy and columns everything else builds on.

- **INV-1** Invite expiry policy in members-domain · 2 pts · @acme/members-domain
- **INV-2** Add expires_at and invite_ttl_days columns · 2 pts · @acme/db-schema

## INV-E2 · Write and enforce expiry (11 pts)

New invites carry an expiry, old ones are backfilled, accept enforces it.

- **INV-3** Set expires_at on invite create and resend · 3 pts · @acme/feature-members · blocked by INV-1, INV-2
- **INV-4** Backfill expiry for existing invites · 3 pts · @acme/feature-members · blocked by INV-3
- **INV-5** Enforce expiry on accept behind invite-expiry flag · 3 pts · @acme/feature-members · blocked by INV-3
- **INV-6** Make expires_at not null · 2 pts · @acme/db-schema · blocked by INV-4

## INV-E3 · Admin and invitee surfaces (16 pts)

Portal management, TTL setting, expired-link page and API field.

- **INV-7** List, resend and revoke pending invites use-cases · 3 pts · @acme/feature-members · blocked by INV-3
- **INV-8** Pending invites table in the portal · 5 pts · @acme/portal · blocked by INV-7
- **INV-12** Read and update invite TTL use-cases · 2 pts · @acme/feature-members · blocked by INV-1, INV-2
- **INV-9** Invite TTL setting in portal settings · 3 pts · @acme/portal · blocked by INV-12
- **INV-10** Expired invite page · 2 pts · @acme/portal · blocked by INV-5
- **INV-11** Return expires_at from POST /v1/invites · 1 pts · @acme/api · blocked by INV-3

```

### → `save_plan` {"plan":"<7458 chars>"}

```text
Saved plans/invite-expiry.plan.json
No findings. The plan is valid.
```

### What happened

The first draft routed the portal's TTL setting straight to `@acme/db-schema`. `validate_plan` rejected it under the dependency-cruiser rule `apps-no-direct-db`. The agent moved the read and update logic into a new ticket in `@acme/feature-members` (INV-12), made the portal ticket depend on it and dropped the illegal edge. The second draft validated clean and was saved. INV-12 got a new key rather than renumbering, so the other keys stay stable for Linear sync.
