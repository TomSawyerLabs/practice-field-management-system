"""Does a Chrome-style mDNS socket (bound 0.0.0.0:5353 with SO_REUSEADDR)
receive multicast answers on this Windows box, or does another 5353 owner
(e.g. Bonjour's per-address sockets) swallow them?

Usage: python scripts/mdns-port-share-test.py <iface-ip> [<iface-ip> ...]

For each interface IP it runs two probes for _googlecast._tcp:
  A) legacy: ephemeral source port -> responders reply UNICAST to us (works
     regardless of who owns 5353). Baseline.
  B) chrome-style: socket bound 0.0.0.0:5353, joined 224.0.0.251 on the
     interface, query sent from port 5353 -> responders reply MULTICAST to
     224.0.0.251:5353. If A sees the TV and B sees nothing, port 5353 is
     effectively owned by someone else on this host.
"""

import socket
import struct
import sys
import time

SVC = "_googlecast._tcp.local"
GROUP = "224.0.0.251"


def lab(n):
    return b"".join(bytes([len(p)]) + p.encode() for p in n.split(".")) + b"\x00"


def query(name):
    return struct.pack(">HHHHHH", 0, 0, 1, 0, 0, 0) + lab(name) + struct.pack(">HH", 12, 1)


def collect(sock, seconds):
    seen = set()
    sock.settimeout(0.5)
    t0 = time.time()
    while time.time() - t0 < seconds:
        try:
            d, a = sock.recvfrom(9000)
        except socket.timeout:
            continue
        if b"_googlecast" in d and (d[2] & 0x80):  # response flag
            seen.add(a[0])
    return seen


def probe_legacy(iface):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind((iface, 0))
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(iface))
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
    s.sendto(query(SVC), (GROUP, 5353))
    r = collect(s, 2.5)
    s.close()
    return r


def probe_chrome_style(iface):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("0.0.0.0", 5353))
    except OSError as e:
        return f"bind 0.0.0.0:5353 failed: {e}"
    s.setsockopt(
        socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, socket.inet_aton(GROUP) + socket.inet_aton(iface)
    )
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(iface))
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 0)
    s.sendto(query(SVC), (GROUP, 5353))
    r = collect(s, 2.5)
    s.close()
    return r


for iface in sys.argv[1:]:
    a = probe_legacy(iface)
    b = probe_chrome_style(iface)
    print(f"{iface:15}  legacy/unicast answers from: {sorted(a) or 'none'}")
    print(f"{'':15}  chrome-style 5353 answers from: {sorted(b) if isinstance(b, set) else b}")
