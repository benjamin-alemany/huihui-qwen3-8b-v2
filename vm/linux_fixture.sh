#!/bin/bash
# Standard disposable Linux CPU runner only. No package installation, image pull,
# credentials, model, GPU or provider API here. Root must approve CI invocation.
set -euo pipefail
if [[ "${1:-}" != --inside ]]; then
  test "$(id -u)" = 0
  exec env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin unshare --mount --net --pid --fork --mount-proc /bin/bash "$0" --inside
fi
cd "$(dirname "$0")/.."
mount --make-rprivate /
mkdir -p /run/netns
mount -t tmpfs tmpfs /run/netns
work=$(mktemp -d)
mkdir -m 0755 "$work/src"
cp vm/linux_fixture.py vm/inference_policy.py "$work/src/"
chmod 0644 "$work/src/"*.py
trap 'kill $(jobs -pr) 2>/dev/null || true; rm -rf "$work"' EXIT
ip link set lo up
ip netns add model
ip netns add outside
ip link add uj-m-host type veth peer name uj-model
ip link set uj-model netns model
ip addr add 10.203.0.1/24 dev uj-m-host
ip -6 addr add fd42:203::1/64 nodad dev uj-m-host
ip link set uj-m-host up
ip -n model link set lo up
ip -n model addr add 10.203.0.2/24 dev uj-model
ip -n model -6 addr add fd42:203::2/64 nodad dev uj-model
ip -n model link set uj-model up
ip link add fixture-wan type veth peer name fixture-outside
ip link set fixture-outside netns outside
ip addr add 172.30.0.1/24 dev fixture-wan
ip -6 addr add fd42:99::1/64 nodad dev fixture-wan
ip link set fixture-wan up
ip -n outside link set lo up
ip -n outside addr add 172.30.0.2/24 dev fixture-outside
ip -n outside -6 addr add fd42:99::2/64 nodad dev fixture-outside
ip -n outside link set fixture-outside up
ip -n outside addr add 1.1.1.1/32 dev lo
ip -n outside addr add 198.41.192.1/32 dev lo
ip -n outside -6 addr add 2606:4700:a0::1/128 nodad dev lo
ip -n outside addr add 169.254.169.254/32 dev lo
ip route add 1.1.1.1/32 via 172.30.0.2
ip route add 198.41.192.1/32 via 172.30.0.2
ip -6 route add 2606:4700:a0::1/128 via fd42:99::2
ip route add 169.254.169.254/32 via 172.30.0.2
# Routes deliberately exist in the hostile fixture: nft denial must do the work.
ip -n model route add default via 10.203.0.1
ip -n model -6 route add default via fd42:203::1
ip -n outside route add 10.203.0.0/24 via 172.30.0.1
ip -n outside -6 route add fd42:203::/64 via fd42:99::1
sysctl -q -w net.ipv4.ip_forward=1 net.ipv6.conf.all.forwarding=1 >/dev/null
python3 -c 'import sys;sys.path.insert(0,"vm");from host_policy import nftables;print(nftables())' > "$work/policy.nft"
nft --check --file "$work/policy.nft"
# Controlled endpoints prove that routes/services exist, and count DNS reaches.
ip netns exec outside python3 -I -B "$work/src/linux_fixture.py" outside "$work" &
ip netns exec model python3 -I -B "$work/src/linux_fixture.py" model-server "$work" &
python3 -I -B "$work/src/linux_fixture.py" host-server "$work" &
for i in $(seq 1 50); do [[ -f "$work/outside.ready" && -f "$work/model.ready" && -f "$work/host.ready" ]] && break; sleep .1; done
test -f "$work/outside.ready"; test -f "$work/model.ready"; test -f "$work/host.ready"
ip netns exec model setpriv --reuid 10001 --regid 10001 --clear-groups python3 -I -B "$work/src/linux_fixture.py" baseline "$work"
: > "$work/dns.received"
: > "$work/host-dns.received"
nft --file "$work/policy.nft"
setpriv --reuid 10002 --regid 10002 --clear-groups python3 -I -B "$work/src/linux_fixture.py" positive "$work"
# This test intentionally has NO child seccomp policy. Host nft must block it.
ip netns exec model setpriv --reuid 10001 --regid 10001 --clear-groups --no-new-privs --bounding-set=-all python3 -I -B "$work/src/linux_fixture.py" hostile "$work"
# Policy is tested independently, after host denial; namespace failure is fatal.
ip netns exec model setpriv --reuid 10001 --regid 10001 --clear-groups --no-new-privs --bounding-set=-all python3 -I -B "$work/src/linux_fixture.py" child-policy "$work"
nft list chain inet unjailed forward | grep -Eq 'counter packets [1-9][0-9]*'
python3 -I -B "$work/src/linux_fixture.py" check-counters "$work"
printf '%s\n' 'LINUX_CPU_HOST_EGRESS_PRIVATE_IPC_FIXTURE_PASSED_NOT_VM_OR_GPU_ACCEPTANCE'
