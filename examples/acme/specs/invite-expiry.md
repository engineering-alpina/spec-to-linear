# Member invite expiry

<!-- Status: ready. -->

## Problem

Member invites never expire. Security reviews at two enterprise tenants flagged 400+ invites older than 90 days that still grant access to whoever holds the link.

## Goals

- Invites expire after a per-tenant TTL (default 7 days, range 1 to 30).
- Tenant admins can see pending invites with their expiry and resend or revoke them in the portal.
- Existing invites older than the tenant TTL are expired by a one-off backfill.

## Non-goals

- Changing the invite email template beyond adding the expiry date.
- Domain-restricted invites.

## User stories

- As a tenant admin, I want invites to expire automatically so that old links cannot be used to join my workspace.
- As a tenant admin, I want to set the invite TTL for my tenant so that it matches our security policy.
- As an invitee with an expired link, I want a clear message and a way to request a new invite.

## Affected packages

- `@acme/members-domain`: expiry policy and TTL bounds.
- `@acme/db-schema`: `expires_at` on `member_invites`, `invite_ttl_days` on `tenant_settings`.
- `@acme/feature-members`: accept, resend, revoke, list with expiry; backfill job.
- `@acme/portal`: pending invites table and TTL setting.
- `@acme/api`: `POST /v1/invites` returns `expires_at`.

## Data model

`member_invites.expires_at timestamptz null` (nullable during rollout, backfilled, then made not null in a later migration). `tenant_settings.invite_ttl_days int not null default 7`. Both migrations are additive and idempotent across tenant databases.

## Rollout

Ship the schema, then code that writes `expires_at` on new invites, then the backfill per tenant, then enforcement on accept behind the `invite-expiry` flag.

## Open questions

- [x] Does an expired invite get deleted? No, it stays with status `expired` for audit.
- [x] Can admins set TTL through the API? Not in this spec.
