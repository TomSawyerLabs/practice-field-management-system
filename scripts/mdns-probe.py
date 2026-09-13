import socket, struct, sys, time

SVC = "_googlecast._tcp.local"


def lab(n):
    return b"".join(bytes([len(p)]) + p.encode() for p in n.split(".")) + b"\x00"


def query(name):
    return struct.pack(">HHHHHH", 0, 0, 1, 0, 0, 0) + lab(name) + struct.pack(">HH", 12, 1)


def rdname(d, o):
    parts = []
    jumped = False
    end = None
    guard = 0
    while guard < 64:
        guard += 1
        l = d[o]
        if l == 0:
            o += 1
            break
        if l & 0xC0 == 0xC0:
            p = struct.unpack(">H", d[o : o + 2])[0] & 0x3FFF
            if not jumped:
                end = o + 2
            jumped = True
            o = p
            continue
        parts.append(d[o + 1 : o + 1 + l].decode(errors="replace"))
        o += 1 + l
    return ".".join(parts), (end if jumped and end is not None else o)


def parse(d):
    out = []
    try:
        qd, an, ns, ar = struct.unpack(">HHHH", d[4:12])
        o = 12
        for _ in range(qd):
            _, o = rdname(d, o)
            o += 4
        for _ in range(an + ns + ar):
            n, o = rdname(d, o)
            t, c, ttl, rl = struct.unpack(">HHIH", d[o : o + 10])
            o += 10
            rd = d[o : o + rl]
            if t == 1:
                out.append(("A", n, ".".join(map(str, rd)), ttl))
            elif t == 12:
                out.append(("PTR", n, rdname(d, o)[0], ttl))
            elif t == 33:
                pr, w, port = struct.unpack(">HHH", rd[:6])
                out.append(("SRV", n, f"{rdname(d, o + 6)[0]}:{port}", ttl))
            elif t == 16:
                txt = []
                i = 0
                while i < len(rd):
                    L = rd[i]
                    txt.append(rd[i + 1 : i + 1 + L].decode(errors="replace"))
                    i += 1 + L
                keep = [x for x in txt if x.split("=")[0] in ("fn", "md", "rs", "id")]
                out.append(("TXT", n, " ".join(keep), ttl))
            o += rl
    except Exception as e:
        out.append(("ERR", str(e), "", 0))
    return out


ifaces = sys.argv[1:] or ["0.0.0.0"]
for iface in ifaces:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind((iface, 0))
        s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(iface))
    except OSError as e:
        print(iface, "bind failed:", e)
        continue
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
    seen = set()
    for attempt in range(2):
        s.sendto(query(SVC), ("224.0.0.251", 5353))
        s.settimeout(1.5)
        t0 = time.time()
        while time.time() - t0 < 1.5:
            try:
                d, a = s.recvfrom(9000)
            except socket.timeout:
                break
            for rec in parse(d):
                key = (a[0],) + rec[:3]
                if key not in seen and (SVC in rec[1] or rec[0] in ("A", "SRV", "ERR")):
                    seen.add(key)
                    print(f"{iface} <- {a[0]:15} {rec[0]:4} {rec[1][:60]:60} {rec[2]} ttl={rec[3]}")
    print(f"{iface}: {len(seen)} records")
