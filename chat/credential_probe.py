"""Fixed CPU-only check of the production credential boundary. No model/tools."""
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import credential_boundary as boundary


def main():
    if sys.argv[1:] == ["--child"]:
        receipt = boundary.verify_child()
        # Adversarial privilege-regain attempts must be denied by the real kernel.
        import os
        for regain in (lambda: os.setuid(0), lambda: os.setgid(0), lambda: os.setgroups([0])):
            try:
                regain()
            except PermissionError:
                continue
            raise ValueError("Privilege regain succeeded")
        import ctypes
        if ctypes.CDLL(None).prctl(38, 0, 0, 0, 0) != -1:
            raise ValueError("No-new-privileges was reversible")
        receipt.update(privilege_regain_denied=True, model_loaded=False, network_used=False, agent_tools=False)
        print("CHAT_CREDENTIAL_BOUNDARY " + json.dumps(receipt), flush=True)
        return
    if sys.argv[1:]:
        raise ValueError("Fixed probe only")
    boundary.assert_clean_boot()
    boundary.prepare_filesystem()
    subprocess.run([sys.executable, "-I", "-S", "-B", str(HERE / "credential_probe.py"), "--child"],
                   env=boundary.model_environment(__import__("os").environ), cwd=HERE,
                   stdin=subprocess.DEVNULL, close_fds=True, preexec_fn=boundary.drop_privileges,
                   check=True, timeout=15)


if __name__ == "__main__":
    try:
        main()
    except boundary.BoundaryError as exc:
        sys.exit("Credential boundary verification failed: " + str(exc))
    except Exception:
        sys.exit("Credential boundary verification failed; no model started")
