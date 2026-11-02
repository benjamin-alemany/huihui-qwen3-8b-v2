# Fixed, names-only runtime probe. No model, command input, credentials or network code.
FROM docker.io/library/python@sha256:623674a14ef93d052bb9b0de4dbf5f28eb578a35263838941cc8aa43213c1487
COPY --link environment_names.py /opt/chat-probe/environment_names.py
USER 10004:10004
ENTRYPOINT ["python3", "-I", "-S", "-B", "/opt/chat-probe/environment_names.py"]
