# Qwen3 8B v2 Runpod container

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
