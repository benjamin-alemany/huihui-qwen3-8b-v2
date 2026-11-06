# Disposable local CPU verification; no cloud key, CUDA, weights or cloud API.
FROM docker.io/library/python@sha256:623674a14ef93d052bb9b0de4dbf5f28eb578a35263838941cc8aa43213c1487
WORKDIR /opt/qwen
COPY credential_boot.py credential_boundary.py credential_probe.py inference_only.py model_boot.py network_boundary.py /opt/qwen/
COPY boundary_tests/linux_tests.py /opt/qwen/linux_tests.py
USER root
ENTRYPOINT ["python3", "-I", "-S", "-B", "/opt/qwen/linux_tests.py"]
