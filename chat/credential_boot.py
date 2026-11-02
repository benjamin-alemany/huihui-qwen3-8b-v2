"""Fixed credential-discarding entrypoint, before model or application imports."""
import os
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import credential_boundary as boundary


def main():
    if os.geteuid() != 0 or sys.argv[1:] not in ([], ["--probe"]):
        raise ValueError("Root fixed bootstrap required; arbitrary commands are forbidden")
    boundary.protect_process()
    boundary.assert_trusted_application(HERE)
    clean = boundary.boot_environment(os.environ)
    # exec replaces the original address space AND /proc initial environment.
    # pop()/unsetenv() alone does neither reliably. No key values are logged.
    boundary.close_inherited_fds()
    stage = "credential_probe.py" if sys.argv[1:] else "inference_only.py"
    os.execve(sys.executable, [sys.executable, "-I", "-S", "-B", str(HERE / stage)], clean)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit("Credential bootstrap refused; no model started")
