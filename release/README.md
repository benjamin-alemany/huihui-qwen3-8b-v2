# Chat release record

`manifest.json` is the shared model, artifact, hosting and duration record.
It remains `status: unverified`. The bootstrap package lock, bundle digest,
compressed size, source commit and runtime orchestrator are pinned. The VM serving
artifact and native acceptance still require their release gates; both source
approval pins in `approval.mjs` remain null. Account catalog IDs and passing CPU
tests do not prove driver, toolkit, container or model compatibility.

Use the reviewed GitHub branch for code. Keep account environment/key names,
provider keys, Cloudflare connector secrets, existing resource/data identities,
owner identity and financial ledgers in the separate private deployment overlay.
The old private source tree is not a second deployment source. Staging must copy
both `cloudflare-backup/` and `release/` so their relative imports retain meaning.

The controller loads the reviewed bundle and renderer from canonical source.
The host downloads that bundle from the fixed public GitHub commit/path and
checks its pinned size and hash before installation. This does not authorize a VM.

A pinned candidate is only preparation for a separately approved, one-allocation
acceptance. It must not unlock ordinary sessions. Production promotion requires
the exact accepted image/bootstrap/host profile and native/browser/cleanup
receipts. Ordinary allowance starts at zero, independently of the test ledger.

No environment variable, owner browser input, inference output or passing CPU
check may substitute for native release acceptance. All new provider execution
remains explicitly selected; uncertain legacy resources must be reconciled before
migration rather than silently reassigned to another provider client.
