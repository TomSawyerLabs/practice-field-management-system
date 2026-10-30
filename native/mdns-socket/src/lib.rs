//! An mDNS socket pinned to one network interface, for pFMS.
//!
//! Two stations of one team carry the same address (10.TE.AM.254) on two
//! bridges. Node's dgram can only choose an IPv4 multicast interface by
//! address, so it can't tell those bridges apart. This socket is bound to
//! the interface itself (SO_BINDTODEVICE) and picks the multicast interface
//! by index (ip_mreqn): queries leave by that bridge alone, and only answers
//! that arrive on it are received. IP_MULTICAST_ALL is off, so it doesn't
//! also get groups joined by other sockets on the host.
//!
//! JS sees one class, `InterfaceSocket(ifname, port, onPacket)`, with
//! `send(packet)` (to 224.0.0.251:5353), `sendTo(packet, address, port)`
//! (unicast, for a host on this interface's subnet) and `close()`. Packets
//! are delivered as `onPacket(data, address, port)` from a receive thread.
//! Linux only; on other systems the constructor throws.

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
  ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi::{Env, JsFunction};
use napi_derive::napi;

/// A received packet: payload, sender address and sender port.
type Received = (Vec<u8>, String, u16);

#[napi]
pub struct InterfaceSocket {
  #[cfg(target_os = "linux")]
  inner: std::sync::Arc<linux::Socket>,
  ifname: String,
  ifindex: u32,
}

#[napi]
impl InterfaceSocket {
  /// Open an mDNS socket on `ifname` (e.g. "br-slot1"), bound to `port`
  /// (5353 for a responder-style socket, 0 for any free port, so that a
  /// unicast query is answered to that port). `onPacket(data, address, port)` is
  /// called for every datagram that arrives on that interface.
  #[napi(constructor)]
  pub fn new(env: Env, ifname: String, port: u32, on_packet: JsFunction) -> Result<Self> {
    let port = u16::try_from(port).map_err(|_| Error::from_reason(format!("bad port {port}")))?;
    let mut tsfn: ThreadsafeFunction<Received, ErrorStrategy::Fatal> =
      on_packet.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<Received>| {
        let (data, address, port) = ctx.value;
        Ok(vec![
          ctx.env.create_buffer_with_data(data)?.into_raw().into_unknown(),
          ctx.env.create_string(&address)?.into_unknown(),
          ctx.env.create_uint32(u32::from(port))?.into_unknown(),
        ])
      })?;
    // Don't hold the event loop open: pFMS closes these sockets itself.
    tsfn.unref(&env)?;
    open(ifname, port, tsfn)
  }

  /// The interface index the socket is pinned to.
  #[napi(getter)]
  pub fn ifindex(&self) -> u32 {
    self.ifindex
  }

  /// The interface name the socket is pinned to.
  #[napi(getter)]
  pub fn ifname(&self) -> String {
    self.ifname.clone()
  }

  /// Multicast `packet` to 224.0.0.251:5353 out of this interface.
  #[napi]
  pub fn send(&self, packet: Buffer) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
      self.inner.send(&packet).map_err(|e| Error::from_reason(format!("send on {}: {e}", self.ifname)))
    }
    #[cfg(not(target_os = "linux"))]
    {
      let _ = packet;
      Err(unsupported())
    }
  }

  /// Unicast `packet` to `address:port` out of this interface. Two bridges
  /// can hold the same subnet, so the routing table can't choose the robot.
  #[napi]
  pub fn send_to(&self, packet: Buffer, address: String, port: u32) -> Result<()> {
    let target: std::net::Ipv4Addr =
      address.parse().map_err(|_| Error::from_reason(format!("bad IPv4 address {address}")))?;
    let port = u16::try_from(port).map_err(|_| Error::from_reason(format!("bad port {port}")))?;
    #[cfg(target_os = "linux")]
    {
      self
        .inner
        .send_to(&packet, target, port)
        .map_err(|e| Error::from_reason(format!("send to {address} on {}: {e}", self.ifname)))
    }
    #[cfg(not(target_os = "linux"))]
    {
      let _ = (packet, target, port);
      Err(unsupported())
    }
  }

  /// Stop receiving and close the socket. Idempotent.
  #[napi]
  pub fn close(&self) {
    #[cfg(target_os = "linux")]
    self.inner.close();
  }
}

#[cfg(target_os = "linux")]
fn open(
  ifname: String,
  port: u16,
  tsfn: ThreadsafeFunction<Received, ErrorStrategy::Fatal>,
) -> Result<InterfaceSocket> {
  let socket = linux::Socket::open(&ifname, port)
    .map_err(|e| Error::from_reason(format!("open mDNS socket on {ifname}: {e}")))?;
  let ifindex = socket.ifindex;
  let inner = std::sync::Arc::new(socket);
  let rx = inner.clone();
  std::thread::Builder::new()
    .name(format!("mdns-{ifname}"))
    .spawn(move || {
      rx.receive_loop(|data, address, port| {
        tsfn.call((data, address, port), ThreadsafeFunctionCallMode::NonBlocking);
      })
    })
    .map_err(|e| Error::from_reason(format!("spawn receive thread: {e}")))?;
  Ok(InterfaceSocket { inner, ifname, ifindex })
}

#[cfg(not(target_os = "linux"))]
fn open(
  _ifname: String,
  _port: u16,
  _tsfn: ThreadsafeFunction<Received, ErrorStrategy::Fatal>,
) -> Result<InterfaceSocket> {
  Err(unsupported())
}

#[cfg(not(target_os = "linux"))]
fn unsupported() -> Error {
  Error::from_reason("mdns-socket: interface-pinned sockets need Linux")
}

#[cfg(target_os = "linux")]
mod linux {
  use std::ffi::CString;
  use std::io;
  use std::mem::{size_of, zeroed};
  use std::net::Ipv4Addr;
  use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
  use std::sync::atomic::{AtomicBool, Ordering};

  const MDNS_GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 251);
  const MDNS_PORT: u16 = 5353;
  /// How often the receive loop wakes to check for close().
  const RECV_TIMEOUT_MS: libc::suseconds_t = 250;

  pub struct Socket {
    fd: OwnedFd,
    pub ifindex: u32,
    closed: AtomicBool,
  }

  fn check(ret: libc::c_int) -> io::Result<()> {
    if ret < 0 {
      Err(io::Error::last_os_error())
    } else {
      Ok(())
    }
  }

  fn setsockopt<T>(fd: &OwnedFd, level: libc::c_int, name: libc::c_int, value: &T) -> io::Result<()> {
    // SAFETY: `value` is a live reference for the call; the size matches its type.
    check(unsafe {
      libc::setsockopt(
        fd.as_raw_fd(),
        level,
        name,
        (value as *const T).cast(),
        size_of::<T>() as libc::socklen_t,
      )
    })
  }

  fn in_addr(ip: Ipv4Addr) -> libc::in_addr {
    libc::in_addr { s_addr: u32::from(ip).to_be() }
  }

  impl Socket {
    pub fn open(ifname: &str, port: u16) -> io::Result<Self> {
      let cname = CString::new(ifname).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "bad name"))?;
      // SAFETY: plain FFI calls; the returned fd is owned below.
      let ifindex = unsafe { libc::if_nametoindex(cname.as_ptr()) };
      if ifindex == 0 {
        return Err(io::Error::last_os_error());
      }
      let raw = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
      check(raw)?;
      // SAFETY: `raw` is a fresh, valid descriptor nothing else owns.
      let fd = unsafe { OwnedFd::from_raw_fd(raw) };

      // Shares :5353 with pFMS's other mDNS sockets (the reflector's own,
      // the other bridges'); SO_REUSEADDR is enough for multicast on Linux.
      setsockopt(&fd, libc::SOL_SOCKET, libc::SO_REUSEADDR, &1 as &libc::c_int)?;
      // The pin: receive only what arrives on this interface, send out of it.
      check(unsafe {
        libc::setsockopt(
          fd.as_raw_fd(),
          libc::SOL_SOCKET,
          libc::SO_BINDTODEVICE,
          cname.as_ptr().cast(),
          cname.as_bytes_with_nul().len() as libc::socklen_t,
        )
      })?;

      let mut addr: libc::sockaddr_in = unsafe { zeroed() };
      addr.sin_family = libc::AF_INET as libc::sa_family_t;
      addr.sin_port = port.to_be();
      addr.sin_addr = in_addr(Ipv4Addr::UNSPECIFIED);
      check(unsafe {
        libc::bind(
          fd.as_raw_fd(),
          (&addr as *const libc::sockaddr_in).cast(),
          size_of::<libc::sockaddr_in>() as libc::socklen_t,
        )
      })?;

      // Group membership and outgoing interface by index, not address: two
      // bridges can hold the same address.
      let mreqn = libc::ip_mreqn {
        imr_multiaddr: in_addr(MDNS_GROUP),
        imr_address: in_addr(Ipv4Addr::UNSPECIFIED),
        imr_ifindex: ifindex as libc::c_int,
      };
      setsockopt(&fd, libc::IPPROTO_IP, libc::IP_ADD_MEMBERSHIP, &mreqn)?;
      setsockopt(&fd, libc::IPPROTO_IP, libc::IP_MULTICAST_IF, &mreqn)?;
      // Only this socket's own memberships, not every group on the host.
      setsockopt(&fd, libc::IPPROTO_IP, libc::IP_MULTICAST_ALL, &0 as &libc::c_int)?;
      // mDNS requires TTL 255; our own queries must not loop back to us.
      setsockopt(&fd, libc::IPPROTO_IP, libc::IP_MULTICAST_TTL, &255 as &libc::c_int)?;
      setsockopt(&fd, libc::IPPROTO_IP, libc::IP_TTL, &255 as &libc::c_int)?;
      setsockopt(&fd, libc::IPPROTO_IP, libc::IP_MULTICAST_LOOP, &0 as &libc::c_int)?;
      let timeout = libc::timeval { tv_sec: 0, tv_usec: RECV_TIMEOUT_MS * 1000 };
      setsockopt(&fd, libc::SOL_SOCKET, libc::SO_RCVTIMEO, &timeout)?;

      Ok(Socket { fd, ifindex, closed: AtomicBool::new(false) })
    }

    pub fn send(&self, packet: &[u8]) -> io::Result<()> {
      self.send_to(packet, MDNS_GROUP, MDNS_PORT)
    }

    pub fn send_to(&self, packet: &[u8], address: Ipv4Addr, port: u16) -> io::Result<()> {
      if self.closed.load(Ordering::Acquire) {
        return Err(io::Error::new(io::ErrorKind::NotConnected, "closed"));
      }
      let mut to: libc::sockaddr_in = unsafe { zeroed() };
      to.sin_family = libc::AF_INET as libc::sa_family_t;
      to.sin_port = port.to_be();
      to.sin_addr = in_addr(address);
      // SAFETY: `packet` and `to` are live for the call.
      let sent = unsafe {
        libc::sendto(
          self.fd.as_raw_fd(),
          packet.as_ptr().cast(),
          packet.len(),
          0,
          (&to as *const libc::sockaddr_in).cast(),
          size_of::<libc::sockaddr_in>() as libc::socklen_t,
        )
      };
      if sent < 0 {
        Err(io::Error::last_os_error())
      } else {
        Ok(())
      }
    }

    pub fn close(&self) {
      self.closed.store(true, Ordering::Release);
    }

    /// Deliver datagrams until close(). The fd itself is closed when the
    /// last reference (this thread's, or the JS object's) goes away.
    pub fn receive_loop(&self, mut deliver: impl FnMut(Vec<u8>, String, u16)) {
      let mut buf = vec![0u8; 9000];
      while !self.closed.load(Ordering::Acquire) {
        let mut from: libc::sockaddr_in = unsafe { zeroed() };
        let mut len = size_of::<libc::sockaddr_in>() as libc::socklen_t;
        // SAFETY: `buf`, `from` and `len` are live and sized for the call.
        let n = unsafe {
          libc::recvfrom(
            self.fd.as_raw_fd(),
            buf.as_mut_ptr().cast(),
            buf.len(),
            0,
            (&mut from as *mut libc::sockaddr_in).cast(),
            &mut len,
          )
        };
        if n < 0 {
          let err = io::Error::last_os_error();
          match err.kind() {
            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted => continue,
            // The interface went away, or similar: nothing more will arrive.
            _ => break,
          }
        }
        if self.closed.load(Ordering::Acquire) {
          break;
        }
        let address = Ipv4Addr::from(u32::from_be(from.sin_addr.s_addr)).to_string();
        deliver(buf[..n as usize].to_vec(), address, u16::from_be(from.sin_port));
      }
    }
  }
}
