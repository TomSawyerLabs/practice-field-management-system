#!/bin/sh
# Real-kernel test of the team network lock (src/teamLock.ts), in network
# namespaces. Needs root, iptables, curl, python3 and bun. Nothing here touches
# the host's own network or any field hardware: run it on a dev box or in WSL
# (`wsl -u root sh scripts/test-team-lock-netns.sh`), never on the field server.
#   lap  (192.168.3.10) ─┐
#   lap2 (192.168.3.11) ─┤ br-guest ── fw (192.168.3.1, forwards) ── br-slot1 (10.12.34.254) ── rob (10.12.34.2)
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(dirname "$HERE")
BUN=$(command -v bun || echo /root/.bun/bin/bun)

cleanup() {
  for ns in lap lap2 rob fw; do ip netns pids $ns 2>/dev/null | xargs -r kill 2>/dev/null || true; ip netns del $ns 2>/dev/null || true; done
}
cleanup
trap cleanup EXIT

for ns in lap lap2 rob fw; do ip netns add $ns; ip -n $ns link set lo up; done

# Guest side: a bridge in fw that both laptops hang off.
ip -n fw link add br-guest type bridge
ip -n fw addr add 192.168.3.1/24 dev br-guest
ip -n fw link set br-guest up
for pair in "lap 192.168.3.10" "lap2 192.168.3.11"; do
  set -- $pair
  ip link add v-$1 type veth peer name e-$1
  ip link set v-$1 netns $1
  ip link set e-$1 netns fw
  ip -n fw link set e-$1 master br-guest up
  ip -n $1 addr add $2/24 dev v-$1
  ip -n $1 link set v-$1 up
  ip -n $1 route add default via 192.168.3.1
done

# Robot side: the station's bridge.
ip -n fw link add br-slot1 type bridge
ip -n fw addr add 10.12.34.254/24 dev br-slot1
ip -n fw link set br-slot1 up
ip link add v-rob type veth peer name e-rob
ip link set v-rob netns rob
ip link set e-rob netns fw
ip -n fw link set e-rob master br-slot1 up
ip -n rob addr add 10.12.34.2/24 dev v-rob
ip -n rob link set v-rob up
ip -n rob route add default via 10.12.34.254

ip netns exec fw sysctl -qw net.ipv4.ip_forward=1
# Bridged frames must not be run through iptables twice.
ip netns exec fw sysctl -qw net.bridge.bridge-nf-call-iptables=0 2>/dev/null || true
# What pFMS puts there for a configured station (src/networkManager.ts).
ip netns exec fw iptables -A FORWARD -i br-slot1 -j ACCEPT -m comment --comment pfms-fwd-slot1
ip netns exec fw iptables -A FORWARD -o br-slot1 -j ACCEPT -m comment --comment pfms-fwd-in-slot1
ip netns exec fw iptables -t nat -A POSTROUTING -o br-slot1 -m addrtype ! --src-type LOCAL -j MASQUERADE -m comment --comment pfms-nat-vlan-slot1

# A web server on the robot, and one on the first laptop (for robot-started flows).
(cd /tmp && ip netns exec rob python3 -m http.server 80 --bind 10.12.34.2 >/dev/null 2>&1 &)
(cd /tmp && ip netns exec rob python3 -m http.server 5800 --bind 10.12.34.2 >/dev/null 2>&1 &)
(cd /tmp && ip netns exec lap python3 -m http.server 9000 --bind 192.168.3.10 >/dev/null 2>&1 &)
sleep 1

# Python can be slow to start (from /mnt/c, say): wait until all three listen.
for i in $(seq 1 40); do
  n=$(( $(ip netns exec rob ss -ltn | grep -c 10.12.34.2) + $(ip netns exec lap ss -ltn | grep -c 192.168.3.10) ))
  [ "$n" -ge 3 ] && break
  sleep 0.5
done
ip netns exec rob ss -ltn; ip netns exec lap ss -ltn

cd "$REPO"
REPO="$REPO" ip netns exec fw "$BUN" "$HERE/test-team-lock-netns.ts"
