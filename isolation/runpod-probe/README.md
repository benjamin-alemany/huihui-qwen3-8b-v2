# Early Runpod compatibility gate — not launched

This finite dummy-only check must pass on the intended Runpod container/image and UID/GID **10004:10004** before any model/harness tool execution. CI host results do not establish this. The probe imports no vLLM/torch/OpenCode, downloads no model, has no cloud credentials, opens no ports and mounts no persistent user data. Inherited inference supervisor is overridden explicitly.

Build context: `isolation/`. Recipe: `isolation/runpod-probe/Dockerfile`. Linux/amd64 only. Both stages extend the exact planned inference image digest. The original heavy base layers remain; this is not a tiny image and cold-pull time is billable once a Pod is allocated. The source records the bubblewrap release hash and seals a minimal Python runtime and seccomp policies. Package versions/digests must be recorded from the eventual image before target acceptance.

Build command (recipe only; not executed yet):

```
docker build --platform linux/amd64 -f isolation/runpod-probe/Dockerfile -t qwen-isolation-probe:local isolation
```

No image has been built or published by this preparation file. Do not create a Pod with an unresolved image tag. After an authorized free build, record and use the immutable image digest. The eventual workstation must reuse this verified isolation layer; changing image/runtime/policy/user/kernel invalidates the target gate.

Target settings, **not launch authorization**:

- One Secure RTX 4090, host CUDA >=13.0, total provider hourly rate <=$1 including disposable disk; preserve intended GPU-container environment even though the probe does not use CUDA.
- Ephemeral container disk 60 GB; no volume disk, network volume, saved projects, backups or personal files.
- No public HTTP/TCP ports; no SSH/Jupyter/startup overrides; exact USER and ENTRYPOINT from image.
- No secrets except explicitly fake `DUMMY-` test values. No Runpod/Cloudflare/R2/model API keys.
- Ordinary provider isolation only. No privileged mode, capability grants, seccomp/AppArmor disabling or sysctl changes. If the provider blocks namespaces, record blocked and stop.
- Before allocation, an independent cloud controller must have an identity-bound absolute deadline and bounded test budget. Keep stop credentials outside Pod. Use createdAt, not app-ready time, as the billing timer origin. This probe contains no provider STOP key and its process cannot end billing.

Expected log: one JSON result, then an idle foreground process to avoid restart loops. Capture report while the Pod is running, then STOP/DELETE and verify fresh provider state. The `--once` option is for trusted CPU/container checks only; exit is not evidence of stopped billing. Both success and failure remain idle until the external controller stops the Pod.

Checks: mandatory user/mount/PID/network/IPC/UTS namespace creation and differing namespace identity; capability/no_new_privs/seccomp state; read-only runtime/project; no model/GPU/control/persistent/backup visibility; socket/DNS/fork/exec/namespace/ptrace denials; resource/output/time limits; real broken-test/edit/fixed-test cycle. File-broker tests verify no-follow access/quotas/schema rejection. Probe status alone never enables tools. Operator must bind result to provider Pod ID, exact image digest, source/policy identity, intended user, kernel and outer container restrictions, and verify cleanup.

Fail-closed tests include an unavailable runtime refusal before Popen and a second-filter failure before project discovery. There is no root/shell/network fallback. A namespace denial is a failed architecture gate, not permission to bypass it.
