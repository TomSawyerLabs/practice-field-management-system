"""Log every change in a Cast TV's discoverability, to time when its
Chromecast-built-in service goes dark relative to TV idle/standby timers.

Polls every 20 s and appends a line to the log ONLY when something changes:
  cast-mdns   TV answers a unicast _googlecast._tcp query (Cast service alive)
  atv-mdns    TV answers _androidtvremote2._tcp (its mDNS responder as a whole)
  8009        Cast control socket accepts TCP (closed in standby / when the
              Cast service is down)
  8008http    Cast HTTP (eureka_info) actually answers, not just accepts
  6466        Android TV Remote protocol port open (OS awake)

Usage (on steamboat):
  nohup python3 tv-cast-monitor.py 10.255.11.11 10.255.0.5 /tmp/tv-cast-monitor.log &

Investigation: plans/cast-reliability.md
"""

import datetime
import socket
import struct
import sys
import time
import urllib.request

TV = sys.argv[1] if len(sys.argv) > 1 else "10.255.11.11"
IFACE = sys.argv[2] if len(sys.argv) > 2 else "10.255.0.5"
LOG = sys.argv[3] if len(sys.argv) > 3 else "/tmp/tv-cast-monitor.log"


def lab(n):
    return b"".join(bytes([len(p)]) + p.encode() for p in n.split(".")) + b"\x00"


def query(name):
    return struct.pack(">HHHHHH", 0, 0, 1, 0, 0, 0) + lab(name) + struct.pack(">HH", 12, 1)


def mdns_unicast(name):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind((IFACE, 0))
    s.sendto(query(name), (TV, 5353))
    s.settimeout(0.5)
    t0 = time.time()
    ok = False
    while time.time() - t0 < 1.5:
        try:
            d, a = s.recvfrom(9000)
        except socket.timeout:
            continue
        if a[0] == TV and (d[2] & 0x80):
            ok = True
    s.close()
    return ok


def tcp(port):
    s = socket.socket()
    s.settimeout(1.5)
    try:
        s.connect((TV, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def http8008():
    try:
        urllib.request.urlopen(f"http://{TV}:8008/setup/eureka_info", timeout=3).read()
        return True
    except Exception:
        return False


last = None
while True:
    st = (
        mdns_unicast("_googlecast._tcp.local"),
        mdns_unicast("_androidtvremote2._tcp.local"),
        tcp(8009),
        http8008(),
        tcp(6466),
    )
    line = "cast-mdns={} atv-mdns={} 8009={} 8008http={} 6466={}".format(*(int(x) for x in st))
    if line != last:
        with open(LOG, "a") as f:
            f.write(datetime.datetime.now().strftime("%m-%d %H:%M:%S ") + line + "\n")
        last = line
    time.sleep(20)
