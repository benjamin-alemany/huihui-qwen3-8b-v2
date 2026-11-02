# Candidate chat credential boundary

This replacement is prepared for tool-free inference. It has not been verified
on Runpod and must not be deployed by CPU verification alone. Agent/terminal
execution and the ten-hour run remain disabled. All workflows are manual.

The fixed `credential_boot.py` entrypoint discards the exact provider-injected
`RUNPOD_API_KEY` name without fetching/copying its value. Other unexpected
credential-like names, including case variants, refuse startup. An allowlisted
`execve` replaces the original process address space and initial `/proc`
environment. Just calling `unsetenv`/`pop` would leave the old `/proc` view.
The root continuation validates both its Python and initial kernel environment.
No Runpod client, billing key or shutdown API is imported by the new chat boot.

The model is launched as real/effective/saved UID/GID10001 with empty groups,
no-new-privileges, zero effective/permitted/inheritable/ambient capabilities,
no core dumps, a non-dumpable process and closed inherited descriptors. Before
importing PyTorch, the child checks its initial environment, parent/PID1 process
data permissions, known credential locations/control sockets and dedicated UID.
Failure stops startup; no unrestricted fallback exists. The inference bearer
key deliberately remains available to inference; account/control keys do not.

`--probe` runs a fixed CPU-only verification child through the same clean exec,
environment, UID and filesystem preparation. It cannot accept a shell command,
download weights, invoke agent tools or call Runpod. It does not stop billing;
both external cloud guards and operator cleanup are still required for any
separately approved paid probe. Do not reset either spending ledger.

## Boundaries and remaining checks

This is Linux process/UID separation for a chat-only container, **not** an
arbitrary-code execution sandbox, network firewall, VM boundary or proof of model
safety. Known-path checks do not establish the absence of credential copies in
arbitrary files. No project/backup mount or cloud billing credential may be added
to the Pod. Actual provider-generated files, peers, injected environment and
managed services must still be reviewed on the intended Runpod image/host. The
provider and container kernel remain trusted. Do not enable agent tools based
on these checks, or claim the injected key's scope was proved by its name.

CPU tests use a pinned official Python3.12 image, dummy keys and a disconnected
container; no CUDA/model layers or personal directories are used. Mac x86
emulation adds Rosetta descriptors and fails the strict descriptor gate. Do not
allowlist them in production to force the test to pass. Use the native x86 Linux
manual workflow `chat-boundary-cpu.yml` on a standard public-repository runner.
It publishes no image/artifact/cache and uses no cloud key. The separate manual
chat image build now requires these tests before any registry publication.

```sh
python3 -B chat/test_boot.py
python3 -B chat/test_credential_boundary.py
docker build --platform linux/amd64 -t qwen-chat-boundary-cpu:ci -f chat/boundary_tests/Dockerfile chat
docker run --rm --network none --cpus 1 --memory 256m --pids-limit 64 qwen-chat-boundary-cpu:ci
```
