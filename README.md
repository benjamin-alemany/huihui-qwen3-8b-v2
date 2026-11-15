# Private Qwen chat

The credential-free chat controller and interface are now under
[`cloudflare-backup/`](cloudflare-backup/). Read the
[cloud handoff](docs/CLOUD-HANDOFF.md) and [agent boundaries](AGENTS.md) first.

V1 targets private browser chat on one Hyperstack RTX A6000 VM, with Cloudflare
login, durable chats, timed sessions and independent shutdown guards. The VM
bootstrap, offline-image layer and controller integration are prepared; exact
target GPU/browser/cleanup acceptance remains outstanding. Full workstation and
agent execution are phase two. See the [release record](release/README.md).

The controller is prepared with paid launches locked. This repository publication
and cloud-development setup do not authorize GPU resources, deployments, billing
changes, a ten-hour run, or Qwen agent/terminal tools. The public configs and budget
values are dummy development examples, not production configuration or ledgers.

For credential-free CPU development with Node 22.12+: install with
`bash .codex/setup.sh`, then run `bash .codex/test.sh` behind the required OS
network isolation. See [testing and recovery](docs/TESTING-AND-RECOVERY.md).
It installs the pinned npm dependencies and runs the local dummy-response suites.
No model weights, Docker image builds, cloud keys or GPU are needed.

## Existing inference image project

The original image recipes and manual image-publication workflows remain below.
These are legacy Runpod recipes, separate from V1's VM profile and reusable
offline model base. Descriptions of long-duration inference recipes do not grant approval to launch them.

### Legacy Qwen3 8B v2 Runpod container

The original credential-free recipe builds a pinned Huihui Qwen3 8B v2 service.
This legacy image contains the runtime and supervisor, not model weights or
credentials. Model weights download only when a separately authorized Runpod Pod starts.

The manual Build and publish workflow uses a standard GitHub-hosted Linux runner
and pushes to GitHub Container Registry. It does not create any Runpod resource.
No GitHub Actions cache or build artifact upload is configured.

The service enforces bearer authentication, disables remote model code, uses
Safetensors, and runs inference unprivileged. A supervisor requests Pod STOP ten
hours after provider creation. A self-stop is software, not a billing guarantee.
Runtime/GPU inference and actual stopping require separate acceptance tests.

Run local unit tests with: python3 -B -m unittest discover -s tests -v
