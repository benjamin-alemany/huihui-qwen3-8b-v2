# syntax=docker/dockerfile:1
# Same pinned inference base planned for the workstation; no model weights loaded.
FROM ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:ad3f2961a994c6d2b55c104af2372641004f311ab760a75718d5abd5eb7ddf7c AS build
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc meson ninja-build pkg-config libcap-dev libseccomp2 python3-minimal curl ca-certificates xz-utils \
    && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -fsSL \
    https://github.com/containers/bubblewrap/releases/download/v0.13.1/bubblewrap-0.13.1.tar.xz -o /tmp/bubblewrap.tar.xz \
    && printf '%s  %s\n' '0e85c8702248b8dd64144f594147553650cdd0e4c951690345faace79c217c4d' /tmp/bubblewrap.tar.xz | sha256sum -c - \
    && mkdir /tmp/bwrap-source && tar -xJf /tmp/bubblewrap.tar.xz -C /tmp/bwrap-source --strip-components=1 \
    && meson setup /tmp/bwrap-source/build /tmp/bwrap-source --prefix=/usr/lib/qwen-sandbox-tools \
      --buildtype=release -Dman=disabled -Dtests=false -Dbash_completion=disabled -Dzsh_completion=disabled -Dselinux=disabled \
    && ninja -C /tmp/bwrap-source/build && ninja -C /tmp/bwrap-source/build install
COPY . /opt/workstation/isolation/
WORKDIR /opt/workstation
RUN /usr/bin/python3 -B -m isolation.prepare_runtime /usr/lib/qwen-isolation-runtime

FROM ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:ad3f2961a994c6d2b55c104af2372641004f311ab760a75718d5abd5eb7ddf7c AS probe
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libcap2 libseccomp2 python3-minimal \
    && rm -rf /var/lib/apt/lists/* \
    && ! getent passwd 10004 && ! getent group 10004 \
    && groupadd -g 10004 qwen-executor \
    && useradd -u 10004 -g 10004 -M -s /usr/sbin/nologin qwen-executor
COPY --from=build /usr/lib/qwen-sandbox-tools/ /usr/lib/qwen-sandbox-tools/
COPY --from=build /usr/lib/qwen-isolation-runtime/ /usr/lib/qwen-isolation-runtime/
COPY . /opt/workstation/isolation/
RUN chown -R root:root /opt/workstation && chmod -R go-w /opt/workstation
ENV PYTHONPATH=/opt/workstation PYTHONUNBUFFERED=1
WORKDIR /tmp
USER 10004:10004
# Deliberately override inference-only root supervisor. No billing key in the Pod.
ENTRYPOINT ["/usr/bin/python3","-B","-m","isolation.runpod_probe"]
CMD []
