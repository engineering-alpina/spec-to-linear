# Acme architecture notes

- Multi-tenant SaaS. One Neon Postgres database per tenant. A schema migration is applied to every tenant database by the migrate runner, so migrations must be backwards compatible and idempotent.
- Layers: app -> feature -> domain / infra -> shared. Domain packages are pure (Effect Schema + policies, no IO). Infra packages own IO (databases, Sentry). Features compose domain and infra into use-cases and expose server actions.
- Every service is an Effect `Context.Tag` with a live Layer and a test Layer in the same package. Tests use Vitest with the test Layer; no real database in unit tests.
- Errors are `Data.TaggedError` classes. Sentry captures them through the observability Layer.
- New package = new folder under packages/ with package.json, turbo.json tags and a README. A new package is its own ticket because it needs tags and boundary review.
