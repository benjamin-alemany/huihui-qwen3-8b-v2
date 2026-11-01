# Official vLLM 0.32.0, linux/amd64 manifest digest verified 2026-10-31.
FROM vllm/vllm-openai@sha256:6ee133356d49ed24cee03dd0cda3d3980279a11c107ce3e752c89e76540f41c9
USER root
# COPY --link lets BuildKit reuse the base layers without unpacking the large
# CUDA runtime during a cloud build. Writable directories are prepared at boot.
COPY --link start.py secure_middleware.py watchdog.py supervisor.py /opt/qwen/
ENV PYTHONPATH=/opt/qwen HOME=/home/inference HF_HOME=/cache/huggingface \
    HF_HUB_DISABLE_TELEMETRY=1 DO_NOT_TRACK=1 VLLM_NO_USAGE_STATS=1 \
    VLLM_LOGGING_LEVEL=WARNING TOKENIZERS_PARALLELISM=false
# Only the timer/control supervisor stays root. It launches vLLM as UID 10001
# with an explicit environment that excludes all Runpod credentials.
EXPOSE 8000
ENTRYPOINT ["python3", "/opt/qwen/supervisor.py"]
