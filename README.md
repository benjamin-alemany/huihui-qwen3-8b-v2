# Private Qwen chat and Runpod inference image

The credential-free chat controller and interface are now under
[`cloudflare-backup/`](cloudflare-backup/). Read the
[cloud handoff](docs/CLOUD-HANDOFF.md) and [agent boundaries](AGENTS.md) first.

The controller is prepared with paid launches locked. This repository publication
and cloud-development setup do not authorize GPU resources, deployments, billing
changes, a ten-hour run, or Qwen agent/terminal tools. The public configs and budget
values are dummy development examples, not production configuration or ledgers.

For credential-free CPU development with Node 22.12+: `bash .codex/setup.sh`.
It installs the pinned npm dependencies and runs the local dummy-response suites.
No model weights, Docker image builds, cloud keys or GPU are needed.

## Existing inference image project

The original image recipes and manual image-publication workflows remain below.
They are separate from the cloud-controller development setup. Descriptions of
long-duration inference recipes do not grant approval to launch them.

### Qwen3 8B v2 Runpod container

Credential-free build recipe for a pinned Huihui Qwen3 8B v2 inference service.
The image contains the runtime and supervisor, not model weights or credentials.
Model weights download only when a separately authorized Runpod Pod starts.

The manual Build and publish workflow uses a standard GitHub-hosted Linux runner
and pushes to GitHub Container Registry. It does not create any Runpod resource.
No GitHub Actions cache or build artifact upload is configured.

The service enforces bearer authentication, disables remote model code, uses
Safetensors, and runs inference unprivileged. A supervisor requests Pod STOP ten
hours after provider creation. A self-stop is software, not a billing guarantee.
Runtime/GPU inference and actual stopping require separate acceptance tests.

Run local unit tests with: python3 -B -m unittest discover -s tests -v
