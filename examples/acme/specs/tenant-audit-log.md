# Tenant audit log

<!-- Status: ready. Co-authored with the spec agent; `stl spec lint` passes. -->

## Problem

Tenant admins cannot answer "who changed this?". When a member's role or the billing plan changes, the only trace is a Sentry breadcrumb that tenants cannot see. Support gets about 15 tickets a month asking us to dig through logs, and two enterprise prospects have made an audit log a condition of signing.

## Goals

- Every role change and billing plan change in a tenant is recorded with actor, action, target, before and after values, and timestamp.
- Tenant admins can browse and filter the log in the portal.
- Tenants can pull the log through the public API for their SIEM.
- When support staff open a tenant's data from the admin app, that access itself appears in the tenant's log.

## Non-goals

- Logging reads by tenant members (only writes, plus staff access).
- Retention policies and deletion. Entries are kept indefinitely for now.
- Real-time streaming or webhooks.

## User stories

- As a tenant admin, I want to see who changed a member's role and when, so that I can answer my security team without opening a support ticket.
- As a tenant admin, I want to filter the log by actor, action and date, so that I can find one change among thousands.
- As a tenant's security engineer, I want to fetch the log from `GET /v1/audit-events` with cursor pagination, so that I can load it into our SIEM.
- As a support engineer, I want my access to a tenant's data to be logged automatically, so that tenants trust our staff access.

## Affected packages

- New `@acme/audit-domain` (layer:domain): event schema, action catalogue, redaction policy.
- `@acme/db-schema`: new `audit_events` table and migration.
- `@acme/tenant-db`: an `AuditWriter` service that inserts into the current tenant's database.
- `@acme/feature-members`, `@acme/feature-billing`: emit events from existing use-cases.
- New `@acme/feature-audit` (layer:feature): list and export use-cases.
- `@acme/portal`: audit log page. `@acme/api`: `GET /v1/audit-events`.
- `@acme/feature-tenants`, `@acme/admin`: staff access logging.

## Data model

`audit_events` in every tenant database: `id uuid pk`, `occurred_at timestamptz`, `actor_type text` (member, staff, api_key), `actor_id text`, `action text`, `target_type text`, `target_id text`, `before jsonb`, `after jsonb`, `request_id text`. Index on `(occurred_at desc, id)` for cursor pagination and on `(actor_id, occurred_at desc)`.

The migration is additive, so it is safe to run across all tenant databases before any code writes to the table.

## Rollout

1. Ship the migration to all tenants.
2. Ship writers behind the `audit-log` feature flag, enabled per tenant; start with internal tenants for a week.
3. Enable the portal page and API endpoint for the two enterprise prospects, then for everyone.
4. Kill switch: turning the flag off stops writes; reads keep working.

## Open questions

- [x] Do we store before/after for billing changes that include card details? No. The redaction policy in `@acme/audit-domain` drops payment method fields before an event is written.
- [x] Does the admin app read the log through `@acme/feature-audit`? No. Admin is cross-tenant and may only use `@acme/feature-tenants` (dependency-cruiser rule `admin-no-tenant-scoped-features`). Staff views go through a new use-case in feature-tenants.
- [x] Page size for the API? 100 by default, 500 max, cursor based.
