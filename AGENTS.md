# Repository engineering rules

- This is an AdonisJS 7 / Node.js 24 data integration and reconciliation platform.
- Preserve separation between provider HTTP clients, Connectors, SyncEngine,
  Queue jobs, persistence, normalization, and reconciliation.
- Preserve complete external provider raw payloads in SourceRecord as historical
  observations; business normalization must not replace or mutate them.
- Never expose provider credentials, sensitive response bodies, database connection
  details, Redis details, or stack traces in public errors or audit messages.
- Add generic abstractions only after at least two concrete cases justify them.
- Add dependencies only for a concrete technical reason.
- Use database constraints where appropriate to protect important persistent data
  invariants; TypeScript types alone are insufficient.
- Tests must never write into the development database. Preserve the guarded,
  separate test database configuration and existing milestone regression tests.
- For milestone implementation, read the selected file in `docs/milestones/` and
  directly relevant architecture documents, rather than every historical document.
- Preserve existing milestone validation documents as historical evidence; do not
  delete, rewrite, or consolidate them.
- Before declaring a milestone complete, validate lint, typecheck, formatting,
  tests, build, and relevant Docker behavior. Follow the commands and test isolation
  instructions in `README.md`.
- Record observed validation evidence, including failures or checks not run.
  Never claim a command passed unless it was executed.
- Do not automatically start the next milestone.
- Do not commit unrelated dependency upgrades or refactors with a milestone.
- Do not rewrite existing Git history unless explicitly requested.
