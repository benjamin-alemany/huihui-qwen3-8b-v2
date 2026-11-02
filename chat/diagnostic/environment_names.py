"""Fixed names-only report; no values, files, model, child process or network."""
import json
import os
import re
import sys


def report(env, uid, gid):
    # Only standard names can leave the process. Do not serialize env or values.
    names = sorted(name for name in env if re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", name)
                   and any(word in name for word in ("API_KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL")))
    if len(names) > 64:
        raise ValueError("Excessive credential-like environment names")
    return {"uid": uid, "gid": gid, "credential_like_variable_names": names,
            "values_reported": False, "model_loaded": False, "network_used": False}


def main():
    if os.getuid() != 10004 or os.getgid() != 10004 or "torch" in sys.modules:
        raise ValueError("Unexpected diagnostic runtime")
    print("CHAT_ENV_NAMES " + json.dumps(report(os.environ, os.getuid(), os.getgid())), flush=True)
    # Exit immediately. The external one-minute cloud STOP is still mandatory:
    # process exit or provider restart loops do not end GPU billing.


if __name__ == "__main__":
    main()
