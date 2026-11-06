# Prepared only. No build, publication or Pod launch is performed by this file.
FROM ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:ad3f2961a994c6d2b55c104af2372641004f311ab760a75718d5abd5eb7ddf7c
USER root
COPY --link credential_boot.py credential_boundary.py credential_probe.py inference_only.py model_boot.py network_boundary.py offline_cache.py model-manifest.json /opt/qwen/
ENTRYPOINT ["python3", "-I", "-S", "-B", "/opt/qwen/credential_boot.py"]
