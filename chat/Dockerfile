# Prepared only. No build, publication or Pod launch is performed by this file.
FROM ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:ad3f2961a994c6d2b55c104af2372641004f311ab760a75718d5abd5eb7ddf7c
USER root
COPY --link inference_only.py model_boot.py /opt/qwen/
ENTRYPOINT ["python3", "/opt/qwen/inference_only.py"]
