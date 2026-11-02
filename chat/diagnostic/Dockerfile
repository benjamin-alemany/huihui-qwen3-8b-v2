# Fixed, names-only runtime probe. No model, command input, credentials or network code.
FROM ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:ad3f2961a994c6d2b55c104af2372641004f311ab760a75718d5abd5eb7ddf7c
COPY --link environment_names.py /opt/chat-probe/environment_names.py
USER 10004:10004
ENTRYPOINT ["python3", "-I", "-S", "-B", "/opt/chat-probe/environment_names.py"]
