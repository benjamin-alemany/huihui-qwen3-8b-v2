# Trusted budget reconciliation before paid Start

The controller now requires trusted deployment variable `OPERATOR_BUDGET_RECONCILIATION` in addition to the existing Start and network release gates. No HTTP endpoint accepts this setting. Its exact JSON fields are `id` (operator-budget- followed by 16 lowercase hex characters), `capUnits`, and `spentFloorUnits`. Dollar amounts use the existing 10^10 scale. Populate these only from the existing approval and reconciled cumulative operational ledger; do not use the synthetic public test seed as production spending evidence.

Reconciliation raises the stored spent figure to the greater of the existing amount and the operator floor. It preserves approvals, sessions, quotes and previous reconciliation history. A new ID cannot apply during active or uncertain sessions, held funds, or unresolved creation. Replaying the same ID/values is idempotent; changing values under an existing ID fails closed. Invalid settings lock Start while status, Stop and cleanup remain usable. The original separate acceptance ledger is never changed.

Use an additional unique reconciliation only when actual spending or approval changes. A pending provider invoice must retain a conservative hold in the operational ledger. Neither absent invoices nor a redeploy authorizes resetting spending or repeating a used approval. Production Start remains disabled and the network-approved image pin remains null until actual serving validation passes.

Validation: six pure reconciliation tests, two engine lifecycle tests and the six Worker controller tests use dummy providers and credentials. The full OS-isolated suite passed before the final controller fixture update; the controller suite then passed separately. No paid resources were created by these tests.

The cold-start cutoff is now minute 17 within the same immutable 18-minute session. The former minute-12 cutoff could reject a model still starting. Tests cover never-ready cleanup at minute 17, health at minute 13, and unchanged automatic expiry at minute 18. No paid runtime or cloud reservation was extended.
