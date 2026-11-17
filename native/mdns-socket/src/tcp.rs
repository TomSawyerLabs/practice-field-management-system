//! A TCP connection pinned to one network interface.
//!
//! The same reason as the mDNS sockets: a team on two stations has
//! 10.TE.AM.2 behind two bridges, so the routing table can't choose the robot.
//! This socket is bound to the interface (SO_BINDTODEVICE) before it connects,
//! so it leaves by that bridge and only that bridge's robot answers.
//!
//! JS sees `InterfaceTcp(ifname, address, port, timeoutMs, onEvent)` with
//! `write(data)` and `close()`. Events arrive from a thread as
//! `onEvent(kind, data, message)`: "connect", "data" (with `data`), "end" (the
//! robot closed), "error" (with `message`). After "end" or "error" nothing
//! more arrives. close() sends no event.

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
  ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi::{Env, JsFunction};
use napi_derive::napi;

/// kind, data, message
type Event = (&'static str, Option<Vec<u8>>, String);

#[napi]
pub struct InterfaceTcp {
  #[cfg(target_os = "linux")]
  shared: std::sync::Arc<linux::Shared>,
}

#[napi]
impl InterfaceTcp {
  /// Connect to `address:port` out of `ifname`, giving up after `timeoutMs`.
  /// Returns at once; the connection is made on a thread.
  #[napi(constructor)]
  pub fn new(
    env: Env,
    ifname: String,
    address: String,
    port: u32,
    timeout_ms: u32,
    on_event: JsFunction,
  ) -> Result<Self> {
    let target: std::net::Ipv4Addr =
      address.parse().map_err(|_| Error::from_reason(format!("bad IPv4 address {address}")))?;
    let port = u16::try_from(port).map_err(|_| Error::from_reason(format!("bad port {port}")))?;
    let mut tsfn: ThreadsafeFunction<Event, ErrorStrategy::Fatal> =
      on_event.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<Event>| {
        let (kind, data, message) = ctx.value;
        let data = match data {
          Some(d) => ctx.env.create_buffer_with_data(d)?.into_raw().into_unknown(),
          None => ctx.env.get_undefined()?.into_unknown(),
        };
        Ok(vec![ctx.env.create_string(kind)?.into_unknown(), data, ctx.env.create_string(&message)?.into_unknown()])
      })?;
    tsfn.unref(&env)?;
    open(ifname, target, port, timeout_ms, tsfn)
  }

  /// Send `data`. Throws when not connected or the connection broke.
  #[napi]
  pub fn write(&self, data: Buffer) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
      self.shared.write(&data).map_err(|e| Error::from_reason(format!("write: {e}")))
    }
    #[cfg(not(target_os = "linux"))]
    {
      let _ = data;
      Err(super::unsupported())
    }
  }

  /// Close the connection. Idempotent; no event follows.
  #[napi]
  pub fn close(&self) {
    #[cfg(target_os = "linux")]
    self.shared.close();
  }
}

#[cfg(target_os = "linux")]
fn open(
  ifname: String,
  target: std::net::Ipv4Addr,
  port: u16,
  timeout_ms: u32,
  tsfn: ThreadsafeFunction<Event, ErrorStrategy::Fatal>,
) -> Result<InterfaceTcp> {
  let shared = std::sync::Arc::new(linux::Shared::default());
  let worker = shared.clone();
  std::thread::Builder::new()
    .name(format!("tcp-{ifname}"))
    .spawn(move || {
      worker.run(&ifname, target, port, timeout_ms, |kind, data, message| {
        tsfn.call((kind, data, message), ThreadsafeFunctionCallMode::NonBlocking);
      })
    })
    .map_err(|e| Error::from_reason(format!("spawn connection thread: {e}")))?;
  Ok(InterfaceTcp { shared })
}

#[cfg(not(target_os = "linux"))]
fn open(
  _ifname: String,
  _target: std::net::Ipv4Addr,
  _port: u16,
  _timeout_ms: u32,
  _tsfn: ThreadsafeFunction<Event, ErrorStrategy::Fatal>,
) -> Result<InterfaceTcp> {
  Err(super::unsupported())
}

#[cfg(target_os = "linux")]
mod linux {
  use std::ffi::CString;
  use std::io::{self, Read, Write};
  use std::mem::{size_of, zeroed};
  use std::net::{Ipv4Addr, Shutdown, TcpStream};
  use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd};
  use std::sync::atomic::{AtomicBool, Ordering};
  use std::sync::Mutex;

  #[derive(Default)]
  pub struct Shared {
    /// The writer's copy, once connected.
    stream: Mutex<Option<TcpStream>>,
    closed: AtomicBool,
  }

  fn check(ret: libc::c_int) -> io::Result<()> {
    if ret < 0 {
      Err(io::Error::last_os_error())
    } else {
      Ok(())
    }
  }

  fn connect(ifname: &str, target: Ipv4Addr, port: u16, timeout_ms: u32) -> io::Result<TcpStream> {
    let cname = CString::new(ifname).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "bad name"))?;
    // SAFETY: plain FFI; the descriptor is owned right away.
    let raw = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    check(raw)?;
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    // The pin, before connect, so the SYN leaves by this interface.
    check(unsafe {
      libc::setsockopt(
        fd.as_raw_fd(),
        libc::SOL_SOCKET,
        libc::SO_BINDTODEVICE,
        cname.as_ptr().cast(),
        cname.as_bytes_with_nul().len() as libc::socklen_t,
      )
    })?;
    // A blocking connect gives up after SO_SNDTIMEO (EINPROGRESS).
    let timeout = libc::timeval {
      tv_sec: (timeout_ms / 1000) as libc::time_t,
      tv_usec: ((timeout_ms % 1000) * 1000) as libc::suseconds_t,
    };
    check(unsafe {
      libc::setsockopt(
        fd.as_raw_fd(),
        libc::SOL_SOCKET,
        libc::SO_SNDTIMEO,
        (&timeout as *const libc::timeval).cast(),
        size_of::<libc::timeval>() as libc::socklen_t,
      )
    })?;
    let mut addr: libc::sockaddr_in = unsafe { zeroed() };
    addr.sin_family = libc::AF_INET as libc::sa_family_t;
    addr.sin_port = port.to_be();
    addr.sin_addr = libc::in_addr { s_addr: u32::from(target).to_be() };
    let ret = unsafe {
      libc::connect(
        fd.as_raw_fd(),
        (&addr as *const libc::sockaddr_in).cast(),
        size_of::<libc::sockaddr_in>() as libc::socklen_t,
      )
    };
    if ret < 0 {
      let err = io::Error::last_os_error();
      return Err(if err.raw_os_error() == Some(libc::EINPROGRESS) {
        io::Error::new(io::ErrorKind::TimedOut, format!("no answer within {timeout_ms} ms"))
      } else {
        err
      });
    }
    // SAFETY: a connected stream socket we own.
    let stream = unsafe { TcpStream::from_raw_fd(fd.into_raw_fd()) };
    stream.set_write_timeout(Some(std::time::Duration::from_secs(2)))?;
    stream.set_nodelay(true)?;
    Ok(stream)
  }

  impl Shared {
    pub fn run(
      &self,
      ifname: &str,
      target: Ipv4Addr,
      port: u16,
      timeout_ms: u32,
      emit: impl Fn(&'static str, Option<Vec<u8>>, String),
    ) {
      let mut reader = match connect(ifname, target, port, timeout_ms).and_then(|s| Ok((s.try_clone()?, s))) {
        Ok((reader, writer)) => {
          let mut slot = self.stream.lock().unwrap();
          if self.closed.load(Ordering::Acquire) {
            let _ = writer.shutdown(Shutdown::Both);
            return;
          }
          *slot = Some(writer);
          reader
        }
        Err(e) => {
          if !self.closed.load(Ordering::Acquire) {
            emit("error", None, e.to_string());
          }
          return;
        }
      };
      emit("connect", None, String::new());
      let mut buf = vec![0u8; 64 * 1024];
      loop {
        match reader.read(&mut buf) {
          Ok(0) => {
            if !self.closed.load(Ordering::Acquire) {
              emit("end", None, String::new());
            }
            break;
          }
          Ok(n) => {
            if self.closed.load(Ordering::Acquire) {
              break;
            }
            emit("data", Some(buf[..n].to_vec()), String::new());
          }
          Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
          Err(e) => {
            if !self.closed.load(Ordering::Acquire) {
              emit("error", None, e.to_string());
            }
            break;
          }
        }
      }
    }

    pub fn write(&self, data: &[u8]) -> io::Result<()> {
      let slot = self.stream.lock().unwrap();
      match slot.as_ref() {
        Some(mut stream) if !self.closed.load(Ordering::Acquire) => stream.write_all(data),
        _ => Err(io::Error::new(io::ErrorKind::NotConnected, "not connected")),
      }
    }

    pub fn close(&self) {
      let slot = self.stream.lock().unwrap();
      self.closed.store(true, Ordering::Release);
      // Wakes the reader: its read returns 0 and the thread ends.
      if let Some(stream) = slot.as_ref() {
        let _ = stream.shutdown(Shutdown::Both);
      }
    }
  }
}
