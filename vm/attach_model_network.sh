#!/bin/sh
# Root-only compatibility wrapper. Namespace FD is pinned by the Python helper.
set -eu
[ "$#" = 0 ]
exec /usr/bin/python3 -I -B /opt/unjailed/vm/attach_model_network.py
