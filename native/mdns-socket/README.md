# mdns-socket

A Node native addon (Rust, [napi-rs](https://napi.rs)) that opens an mDNS
socket pinned to one network interface. pFMS uses it for the robot side of
its mDNS reflector, for the team checks' mDNS lookups, and for the unicast
query that identifies a SystemCore.

The interface has to be picked by name: when one team runs two robots, two
station bridges hold the same address (`10.TE.AM.254`), and Node's `dgram`
can only choose an IPv4 multicast interface by address. The socket is bound
to its interface (`SO_BINDTODEVICE`), joins `224.0.0.251` and sends by
interface index (`ip_mreqn`), and has `IP_MULTICAST_ALL` off. So a query
leaves by that bridge only, and only that bridge's answers arrive.

```ts
import { openInterfaceSocket } from './mdnsSocket.js'; // src/mdnsSocket.ts
const s = openInterfaceSocket('br-slot1', 5353, (data, address, port) => {});
s.send(query); // to 224.0.0.251:5353, out of br-slot1
s.sendTo(query, '10.19.67.2', 5353); // unicast, out of br-slot1
s.close();
```

Linux only. On other systems, opening a socket throws.

## How pFMS gets it

CI (`.github/workflows/mdns-socket.yml`) builds `linux-x64` and `linux-arm64`
binaries and attaches them to the GitHub release `mdns-socket-v<version>`.
`bun run build` runs `scripts/fetch-mdns-socket.ts`, which downloads the
binary for the crate's `version` into `prebuilt/`. So a pFMS install needs
no Rust toolchain. If the release is missing, the build fails.

## Releasing a new version

1. Bump `version` in `Cargo.toml`, run `cargo build` (updates `Cargo.lock`),
   and commit both.
2. `git tag mdns-socket-v<version> && git push origin mdns-socket-v<version>`
3. Wait for the workflow to publish the release, then deploy pFMS.

## Building locally

On Linux, or in WSL on Windows:

```sh
cargo build --release
cp target/release/libmdns_socket.so prebuilt/mdns-socket.linux-x64-gnu.node
```

Or point pFMS at any build with `MDNS_SOCKET_NODE=/path/to/file.node`.
