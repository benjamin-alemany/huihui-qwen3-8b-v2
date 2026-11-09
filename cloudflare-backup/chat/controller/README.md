# Private chat controller — public development copy

See `docs/CLOUD-HANDOFF.md` at the repository root for current state, the source
map and the bounded cloud-review assignment. See root `AGENTS.md` for execution
and spending boundaries.

The controller implements quote/consent/Start/Stop, durable single-flight state,
an immutable short session deadline, budget reservations, exact-reservation cron
receipts, independent stop stores, cleanup verification and inference revocation.
Production's paid acceptance remains pending and is not authorized here.

Cleanup retains every observed reservation Pod ID across retries and restarts,
including the legacy session Pod. Budget settlement and guard disarming require
explicit absence for those IDs and a fresh inventory without matching Pods.
Partial guard deletion reports do not resolve an unknown create outcome. Changed
identities and failed reads keep the hold and remaining guards in place.

This copy contains dummy account/budget/configuration/receipt values. It has no
credentials, real routes, private billing state or saved chats. Never deploy the
examples or apply their seeds to a production ledger. Source changes require
review and a separately authorized private deployment.

Run `bash .codex/setup.sh` from the repository root for the local dummy test suite.
The existing model-serving image is unchanged; there is no model/GPU work in setup.
