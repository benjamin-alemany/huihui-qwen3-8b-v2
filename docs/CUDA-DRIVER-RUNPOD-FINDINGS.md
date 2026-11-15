# Native driver diagnostic: serving remains locked

The immutable small driver-only image `sha256:6f652142fdbe0f7b824865781a35858dbf2a49d802d87ce9b469b8763afa09c3` was tested on a Secure RTX PRO 4500 Blackwell host advertising CUDA 13.2. This is a native driver test on a different base/Python patch version from the full serving image, not model acceptance.

The container started roughly five seconds after allocation. The fixed child passed credential checks at UID/GID 10001 with empty capabilities, no-new-privileges, disabled core dumps, closed inherited descriptors, denied known credential paths and protected parent process data. The unchanged network policy installed with Landlock ABI 4 and denied all connect calls and named UNIX sockets. Every fixed proc metadata open check succeeded. NVIDIA control/UVM device nodes were readable/writable. `/dev/nvidia0` was absent, but the probe did not enumerate other numeric device nodes; that absence does not establish that the assigned GPU was missing.

The driver version call succeeded with value 13020. During `cuInit(0)`, the observer recorded two denied `socket` calls with family 1 (AF_UNIX), type 524293 (SOCK_SEQPACKET | SOCK_CLOEXEC), protocol 0 and errno 1 (EPERM). `cuInit` then returned CUDA 304. No model, tokenizer, vLLM server or agent was started. The operator stopped and deleted the test Pod, verified fresh absence, and restored both guards to keyless standby.

This strongly implicates the current IPC restriction as the compatibility blocker. It is not a complete syscall trace or a controlled causal comparison: direct syscalls, hidden symbols and ioctls are not observed. Do not claim that allowing the observed socket alone fixes CUDA, or that a full model has passed.

## Release decision

Keep `APPROVED_NETWORK_IMAGE=null`, production paid Start disabled and agent execution disabled. Do not spend another full-model cold start on the unchanged failing boundary. Do not allow named UNIX sockets on an unverified shared network namespace, grant privileges, remove the connect/egress restriction, or warm CUDA unrestricted and inherit live descriptors as a workaround.

The next design review must establish an equivalent enforced boundary for legitimate driver-local IPC. A GPU VM with trusted host namespace/firewall controls and an external provider firewall is a candidate. Keep billing keys and stop controls in the existing cloud controller. That design requires its own dummy-data adversarial tests and provider runtime validation; VM documentation or free-runner success alone is not proof. A provider migration is not authorized by the Runpod validation allowance.

The existing interface, owner login, saved-chat state and reviewed controller remain reusable. No data migration, agent execution or paid deployment is part of this finding.
