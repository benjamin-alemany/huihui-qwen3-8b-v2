# Offline development and chat recovery

## Test boundary

Use a fresh, disposable, non-root development environment without credentials,
mounted personal files, SSH agent or Docker socket. This project does not supply
a general sandbox for arbitrary untrusted code or turn Qwen into a trusted model.

`bash .codex/setup.sh` checks for credential-bearing environment/local config,
checks registry URLs and lockfile integrity entries, and installs pinned npm
packages with lifecycle scripts disabled. It uses empty npm configuration and a
temporary cache. It does not run tests or deploy. Dependency code and native
binaries still execute later; skipped hooks and hashes are not a malware audit.

Then run `bash .codex/test.sh` separately. It clears the child environment, requires
OS external-network denial and verifies that denial before running any tests.
macOS uses sandbox-exec, loopback-only networking and denied known credential
directories. Linux uses a new user/network namespace with loopback brought up;
namespace/tool failure refuses execution. Only the macOS path has been validated
for this change. Neither adapter supplies a complete filesystem isolation boundary.
Use an appropriately isolated disposable machine when reviewing untrusted changes.

All npm test scripts use that same runner. The main Workers isolate refuses
unexpected fetch calls; auxiliary workers have a deny-only outbound service and
a recorded violation causes the runner to fail even if the exception is caught.
Node unexpected fetch also makes the process fail when caught. OS denial remains
the backstop for network APIs and processes outside those application mocks.
The controller tests explicitly blank the Runpod key and exercise the readiness
alarm with dummy Cloudflare responses. No live receipt or GPU test is run.

No restricted platform has an unrestricted fallback. A failed isolation gate is
a blocker to report, not a reason to remove protections or provision a machine.

## Draft protection

The editor tracks unsaved text in tab memory. New chat and opening another saved
snapshot offer Save and continue, Discard changes, or Cancel. Failed saving keeps
the current text and dialog open. Reload/close registers the browser's standard
unsaved-change warning; browsers/mobile termination may suppress it, so save
important work explicitly. There is no localStorage or automatic cloud save.

Export text includes the current unsent draft, labeled UNSENT DRAFT. Exporting
does not mark a chat saved or disable the warning: a download is not proof that
the user kept a usable copy. Save chat is a snapshot; editing it requires a new
manual save and consumes another of the existing 20 slots.

## Backup and restore

Back up saved chats downloads a version 1 JSON file containing only chat titles
and alternating plain-text messages. Save current unsaved text first. No Pod IDs,
session timers, controls, budgets, billing/inference keys or cloud identities are
in the backup. The file itself contains private text and is not encrypted by this
feature; choose where to keep it. No automatic/separate backup service is created.

Restore backup validates a file up to 2 MiB and previews its titles, duplicate
count and available slots. Nothing is written until Import chats is selected.
Only the authenticated owner can preview or import; POST requires same-origin
JSON and the existing CSRF header. A full batch is validated before any write,
quota is rechecked within a SQLite transaction, and a later write failure rolls
back earlier inserts. Unknown fields, system/tool messages and unsupported
versions are rejected. Identical title/message snapshots are skipped, including
duplicates in one file and repeated requests. A same-title snapshot with different
content becomes a separate record. Existing chats are never overwritten.

After importing, open Saved chats and choose Open. Saved drafts and recovery work
with the GPU off. Neither importing nor opening a chat starts a Pod, renews a
session or exposes tools to Qwen. Paid Start and guard arming remain disabled.

## Shutdown patch integration

This branch includes Dot's exact commit 4e289e2164daf66cdbeb8c9cbc0721a8184fc6a3
from PR #1. A known Pod omitted from matching inventory now requires an explicit
get-pod absence before settling/disarming; malformed successful payloads cannot
mean deletion. Identity uncertainty keeps the hold and guards and requires
operator reconciliation. The model-serving image and inference code are unchanged.

Production deployment must preserve private account configuration, current
versions and live ledger state. Public policy seeds/receipt fixtures remain dummy
data. Publishing or merging source does not deploy it or authorize paid tests.
