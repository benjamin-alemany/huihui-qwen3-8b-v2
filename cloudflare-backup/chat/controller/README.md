# Private chat controller — public development copy

See `docs/CLOUD-HANDOFF.md` at the repository root for current state, the source
map and the bounded cloud-review assignment. See root `AGENTS.md` for execution
and spending boundaries.

The controller implements quote/consent/Start/Stop, durable single-flight state,
an immutable short session deadline, budget reservations, exact-reservation cron
receipts, independent stop stores, cleanup verification and inference revocation.
Production's paid acceptance remains pending and is not authorized here.

This copy contains dummy account/budget/configuration/receipt values. It has no
credentials, real routes, private billing state or saved chats. Never deploy the
examples or apply their seeds to a production ledger. Source changes require
review and a separately authorized private deployment.

Run `bash .codex/setup.sh` from the repository root to install without lifecycle
scripts, then `bash .codex/test.sh` for the OS-isolated dummy suite. See
`docs/TESTING-AND-RECOVERY.md` for the boundary and backup/restore behavior.
The existing model-serving image is unchanged; there is no model/GPU work in setup.
