"""Chat inference credential boundary. Linux checks fail closed; no API client.

This is a process/UID boundary for tool-free inference, not an execution sandbox
or network firewall. No function logs environment values or reads key files.
"""
import ctypes
import os
from pathlib import Path
import resource
import stat
import sys

class BoundaryError(ValueError):
    """Only fixed, non-secret operator diagnostics may use this exception."""


UID = GID = 10001
PARTS = ("API_KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL")
INERT_NAMES = {"TOKENIZERS_PARALLELISM", "HF_HUB_DISABLE_IMPLICIT_TOKEN"}
BOOT_KEYS = {"VLLM_API_KEY", "CHAT_CLOUD_GUARDS_VERIFIED", "CHAT_RESERVED_AT", "CHAT_DEADLINE_UTC",
             "CUDA_HOME", "CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES", "NVIDIA_DRIVER_CAPABILITIES",
             "LD_LIBRARY_PATH"}
MODEL_KEYS = BOOT_KEYS - {"CHAT_CLOUD_GUARDS_VERIFIED", "CHAT_RESERVED_AT", "CHAT_DEADLINE_UTC"}
MODEL_KEYS |= {"PATH", "LANG", "LC_ALL", "HOME", "HF_HOME", "TMPDIR", "PYTHONPATH", "HF_HUB_DISABLE_TELEMETRY",
               "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "VLLM_HOST_IP", "VLLM_LOOPBACK_IP", "VLLM_RPC_BASE_PATH", "DO_NOT_TRACK", "VLLM_NO_USAGE_STATS", "VLLM_LOGGING_LEVEL", "TOKENIZERS_PARALLELISM"}
FORBIDDEN_PATHS = ("/root", "/run/secrets", "/.runpod", "/etc/runpod", "/opt/qwen/.env",
                   "/home/inference/.runpod", "/home/inference/.aws", "/home/inference/.config/runpod",
                   "/cache/.runpod", "/tmp/.runpod", "/var/run/docker.sock", "/run/containerd/containerd.sock")


def check_names(names):
    for name in names:
        upper = name.upper()
        if name != "VLLM_API_KEY" and name not in INERT_NAMES and any(p in upper for p in PARTS):
            raise BoundaryError("Unexpected credential-like environment name; inference withheld")


def boot_environment(source):
    # Only this exact provider-added name is discarded. Never copy its value.
    check_names(name for name in source if name != "RUNPOD_API_KEY")
    result = {name: source[name] for name in BOOT_KEYS if name in source}
    result["PATH"] = str(Path(sys.executable).parent) + ":/usr/local/bin:/usr/bin:/bin"
    result.update(LANG="C.UTF-8", LC_ALL="C.UTF-8")
    return result


def initial_environment_names(path="/proc/self/environ"):
    # Parse names only, discarding each value without accumulating/printing it.
    names, name, in_value = [], bytearray(), False
    with open(path, "rb") as stream:
        while chunk := stream.read(4096):
            for byte in chunk:
                if byte == 0:
                    if name:
                        names.append(name.decode("ascii", errors="strict"))
                    name.clear()
                    in_value = False
                elif byte == 61 and not in_value:
                    in_value = True
                elif not in_value:
                    if len(name) >= 256:
                        raise BoundaryError("Invalid environment name")
                    name.append(byte)
    if name:
        raise BoundaryError("Unterminated process environment")
    return names


def prctl(option, value):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(option, value, 0, 0, 0) != 0:
        raise OSError("Required Linux process protection unavailable")


def protect_process():
    if sys.platform != "linux":
        raise BoundaryError("Linux process boundary required")
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    prctl(4, 0)  # PR_SET_DUMPABLE; exec resets it, so apply at every stage.
    os.umask(0o077)


def assert_clean_boot():
    if os.geteuid() != 0:
        raise BoundaryError("Trusted bootstrap must run as root")
    check_names(os.environ)
    check_names(initial_environment_names())
    if set(os.environ) - (BOOT_KEYS | {"PATH", "LANG", "LC_ALL"}):
        raise BoundaryError("Clean exec bootstrap required")
    protect_process()


def assert_trusted_application(directory):
    directory = Path(directory)
    for path in [directory, *directory.parents, *directory.glob("*.py")]:
        info = path.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise BoundaryError("Application code or parent directory is writable or untrusted")


def close_inherited_fds():
    for name in os.listdir("/proc/self/fd"):
        if name.isdigit() and int(name) > 2:
            try:
                os.close(int(name))
            except OSError:
                pass  # The listdir descriptor is already closed.
    null = os.open("/dev/null", os.O_RDONLY)
    os.dup2(null, 0, inheritable=True)
    if null > 2:
        os.close(null)


def prepare_filesystem():
    for name in ("/cache", "/home/inference", "/tmp/qwen-inference"):
        path = Path(name)
        if path.is_symlink():
            raise BoundaryError("Private runtime directory must not be a symlink")
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chown(path, UID, GID)
        os.chmod(path, 0o700)
    # Libraries may resolve this numeric identity through NSS. Never reuse an
    # unrelated base-image account with our dedicated inference UID/GID.
    for filename, number, entry in (
        ("/etc/passwd", UID, "inference:x:10001:10001:Inference:/home/inference:/usr/sbin/nologin"),
        ("/etc/group", GID, "inference:x:10001:"),
    ):
        path = Path(filename)
        text = path.read_text()
        existing = [line for line in text.splitlines() if len(line.split(":")) > 2 and line.split(":")[2] == str(number)]
        if existing and existing != [entry]:
            raise BoundaryError("Dedicated inference identity already occupied")
        if not existing:
            with path.open("a") as stream:
                stream.write(("" if text.endswith("\n") else "\n") + entry + "\n")


def model_environment(source):
    check_names(source)
    result = {name: source[name] for name in MODEL_KEYS if name in source}
    result.update(PATH=source["PATH"], HOME="/home/inference", HF_HOME="/cache/huggingface",
                  LANG="C.UTF-8", LC_ALL="C.UTF-8",
                  TMPDIR="/tmp/qwen-inference", PYTHONPATH="/opt/qwen", HF_HUB_DISABLE_TELEMETRY="1",
                  HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", DO_NOT_TRACK="1", VLLM_NO_USAGE_STATS="1", VLLM_LOGGING_LEVEL="WARNING",
                  TOKENIZERS_PARALLELISM="false", VLLM_HOST_IP="127.0.0.1",
                  VLLM_LOOPBACK_IP="127.0.0.1", VLLM_RPC_BASE_PATH="/tmp/qwen-inference")
    return result


def drop_privileges():
    prctl(38, 1)  # PR_SET_NO_NEW_PRIVS, inherited across exec/fork.
    os.setgroups([])
    os.setresgid(GID, GID, GID)
    os.setresuid(UID, UID, UID)
    protect_process()


def status_fields(path="/proc/self/status"):
    return dict(line.split(":", 1) for line in Path(path).read_text().splitlines() if ":" in line)


def assert_unreadable_process(pid):
    for name in ("environ", "mem"):
        try:
            fd = os.open(f"/proc/{pid}/{name}", os.O_RDONLY)
        except PermissionError:
            continue
        except FileNotFoundError:
            raise BoundaryError("Protected parent disappeared") from None
        else:
            os.close(fd)
            raise BoundaryError("Inference can open protected process data")
    try:
        os.listdir(f"/proc/{pid}/fd")
    except PermissionError:
        pass
    else:
        raise BoundaryError("Inference can inspect protected process descriptors")


def verify_child():
    if sys.platform != "linux" or os.getresuid() != (UID,) * 3 or os.getresgid() != (GID,) * 3 or os.getgroups():
        raise BoundaryError("Unexpected inference credentials")
    check_names(os.environ)
    names = initial_environment_names()
    check_names(names)
    if set(os.environ) - MODEL_KEYS or set(names) - MODEL_KEYS:
        raise BoundaryError("Unexpected child environment")
    fields = status_fields()
    if fields.get("NoNewPrivs", "").strip() != "1" or any(
            int(fields.get(key, "1"), 16) for key in ("CapEff", "CapPrm", "CapInh", "CapAmb")):
        raise BoundaryError("Inference retained privileges")
    if resource.getrlimit(resource.RLIMIT_CORE) != (0, 0):
        raise BoundaryError("Core dumps must be disabled")
    assert_unreadable_process(os.getppid())
    if os.getppid() != 1:
        assert_unreadable_process(1)
    for name in os.listdir("/proc/self/fd"):
        if name.isdigit() and int(name) > 2:
            try:
                os.fstat(int(name))
            except OSError:
                continue
            raise BoundaryError("Unexpected inherited descriptor")
    for name in FORBIDDEN_PATHS:
        if os.access(name, os.R_OK) or os.access(name, os.W_OK):
            raise BoundaryError("Protected credential location or control socket is accessible")
    # Only this dedicated UID may be used; stale/sibling processes fail preflight.
    for path in Path("/proc").iterdir():
        if path.name.isdigit() and int(path.name) != os.getpid():
            try:
                # Non-dumpable /proc directories can appear root-owned; use
                # kernel Uid metadata rather than directory ownership.
                ids = status_fields(path / "status").get("Uid", "").split()
                if str(UID) in ids:
                    raise BoundaryError("Inference UID is shared with another process")
            except FileNotFoundError:
                continue
    # Seal after inspecting our own /proc entries: non-dumpable non-root tasks
    # can lose DAC access to their own environ/fd directory. No model ran yet.
    protect_process()
    if ctypes.CDLL(None).prctl(3, 0, 0, 0, 0) != 0:
        raise BoundaryError("Inference process is dumpable")
    return {"uid": UID, "gid": GID, "credential_environment_clean": True,
            "parent_process_data_denied": True, "inherited_fds_closed": True,
            "no_new_privileges": True, "capabilities_empty": True, "core_dumps_disabled": True,
            "known_credential_paths_denied": True, "dedicated_uid": True}
