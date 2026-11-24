//! "Before connecting" steps of a saved SSH/SFTP profile, run on every
//! connect of that profile (shell, SFTP, tunnels, and when it is used as a
//! jump host):
//!
//!  1. a local command — bring a VPN up, `wg-quick up`, `tailscale up`,
//!     `knock …`, open a cloud firewall — waited for, with a timeout; a
//!     non-zero exit aborts the connect with its output;
//!  2. a port-knock sequence — a TCP SYN (or UDP datagram) to each port in
//!     order, `delay` apart, so a knockd/fwknop-style firewall opens SSH.
//!
//! Knocking only happens when the host is dialled directly; behind a jump
//! host the target isn't reachable from here, so the sequence is skipped.

use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct PreConnect {
    /// "7000, 8000/udp 9000" — ports in knock order, TCP unless "/udp".
    #[serde(default)]
    pub knock_ports: Option<String>,
    /// Pause after each knock (ms); default 300.
    #[serde(default)]
    pub knock_delay_ms: Option<u32>,
    /// Local command run (via the login shell) before connecting.
    #[serde(default)]
    pub pre_connect: Option<String>,
    /// Seconds to wait for the command; default 30.
    #[serde(default)]
    pub pre_connect_timeout: Option<u32>,
}

impl PreConnect {
    pub fn is_empty(&self) -> bool {
        self.knock_ports.as_deref().map(str::trim).unwrap_or("").is_empty()
            && self.pre_connect.as_deref().map(str::trim).unwrap_or("").is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Knock {
    pub port: u16,
    pub udp: bool,
}

/// Parse "7000, 8000/udp 9000/tcp" (commas and/or spaces).
pub fn parse_knock(spec: &str) -> Result<Vec<Knock>, String> {
    let mut out = Vec::new();
    for tok in spec.split(|c: char| c == ',' || c.is_whitespace()).filter(|t| !t.is_empty()) {
        let (num, proto) = match tok.split_once('/') {
            Some((n, p)) => (n, p.to_ascii_lowercase()),
            None => (tok, "tcp".to_string()),
        };
        let port: u16 = num
            .parse()
            .ok()
            .filter(|p| *p > 0)
            .ok_or_else(|| format!("Knock sequence: \"{tok}\" is not a port (1–65535)."))?;
        let udp = match proto.as_str() {
            "tcp" => false,
            "udp" => true,
            _ => return Err(format!("Knock sequence: \"{tok}\" — use /tcp or /udp.")),
        };
        out.push(Knock { port, udp });
    }
    Ok(out)
}

/// Run the steps for `host:port`. `direct` = no jump host in front of it.
pub async fn run(pc: &PreConnect, host: &str, port: u16, user: &str, direct: bool) -> Result<(), String> {
    if let Some(cmd) = pc.pre_connect.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        let secs = pc.pre_connect_timeout.unwrap_or(30).clamp(1, 600);
        run_command(cmd, host, port, user, Duration::from_secs(secs as u64)).await?;
    }
    if direct {
        if let Some(spec) = pc.knock_ports.as_deref().filter(|s| !s.trim().is_empty()) {
            let seq = parse_knock(spec)?;
            let delay = Duration::from_millis(pc.knock_delay_ms.unwrap_or(300).min(10_000) as u64);
            knock(host, &seq, delay).await?;
        }
    }
    Ok(())
}

/// Send the knock sequence. Each knock is fire-and-forget: a knock port is
/// normally closed/filtered, so a refused or timed-out connect is expected.
pub async fn knock(host: &str, seq: &[Knock], delay: Duration) -> Result<(), String> {
    let addr = tokio::net::lookup_host((host, 0))
        .await
        .map_err(|e| format!("Port knock: can't resolve {host}: {e}"))?
        .next()
        .ok_or_else(|| format!("Port knock: can't resolve {host}"))?
        .ip();
    for k in seq {
        let target = std::net::SocketAddr::new(addr, k.port);
        if k.udp {
            let bind = if addr.is_ipv6() { "[::]:0" } else { "0.0.0.0:0" };
            if let Ok(sock) = tokio::net::UdpSocket::bind(bind).await {
                let _ = sock.send_to(b"knock", target).await;
            }
        } else {
            let _ = tokio::time::timeout(Duration::from_millis(400), tokio::net::TcpStream::connect(target)).await;
        }
        tokio::time::sleep(delay).await;
    }
    Ok(())
}

#[cfg(any(target_os = "ios", target_os = "android"))]
async fn run_command(_cmd: &str, _host: &str, _port: u16, _user: &str, _t: Duration) -> Result<(), String> {
    Err("This profile runs a local command before connecting, which isn't possible on this device. Remove it in the profile (Before connecting) to connect from here.".into())
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
async fn run_command(cmd: &str, host: &str, port: u16, user: &str, timeout: Duration) -> Result<(), String> {
    if option_env!("BALAUDECK_STORE_BUILD") == Some("1") {
        return Err("Running a local command before connecting isn't available in the App Store version. Remove it in the profile (Before connecting).".into());
    }
    #[cfg(windows)]
    let mut c = {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(cmd);
        c
    };
    #[cfg(not(windows))]
    let mut c = {
        // Login shell, so PATH matches the user's terminal (Homebrew, etc.).
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
        let mut c = tokio::process::Command::new(shell);
        c.arg("-lc").arg(cmd);
        c
    };
    c.env("BD_HOST", host)
        .env("BD_PORT", port.to_string())
        .env("BD_USER", user)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let child = c.spawn().map_err(|e| format!("Before-connect command couldn't start: {e}"))?;
    let out = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(r) => r.map_err(|e| format!("Before-connect command failed: {e}"))?,
        Err(_) => {
            return Err(format!(
                "Before-connect command didn't finish within {}s (stopped). Raise the wait time, or make the command return once it's done (e.g. don't run a VPN client in the foreground).",
                timeout.as_secs()
            ))
        }
    };
    if !out.status.success() {
        let mut msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if msg.is_empty() {
            msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
        }
        let tail: String = {
            let chars: Vec<char> = msg.chars().collect();
            let start = chars.len().saturating_sub(800);
            chars[start..].iter().collect()
        };
        let code = out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
        return Err(format!(
            "Before-connect command failed (exit {code}){}",
            if tail.is_empty() { String::new() } else { format!(":\n{tail}") }
        ));
    }
    Ok(())
}

/// Try the steps from the profile editor ("Test"), without connecting.
#[tauri::command]
pub async fn preconnect_test(pc: PreConnect, host: String, port: u16, user: String) -> Result<(), String> {
    if let Some(s) = pc.knock_ports.as_deref() {
        parse_knock(s)?;
    }
    run(&pc, &host, port, &user, true).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knock_parse() {
        assert_eq!(
            parse_knock("7000, 8000/udp 9000/TCP").unwrap(),
            vec![
                Knock { port: 7000, udp: false },
                Knock { port: 8000, udp: true },
                Knock { port: 9000, udp: false }
            ]
        );
        assert!(parse_knock("").unwrap().is_empty());
        assert!(parse_knock("70000").is_err());
        assert!(parse_knock("0").is_err());
        assert!(parse_knock("22/sctp").is_err());
        assert!(parse_knock("abc").is_err());
    }

    #[tokio::test]
    async fn knock_reaches_listener_in_order() {
        // Two local listeners record the order they were hit in.
        let a = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let b = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (pa, pb) = (a.local_addr().unwrap().port(), b.local_addr().unwrap().port());
        let order = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        for (l, tag) in [(a, 'a'), (b, 'b')] {
            let o = order.clone();
            tokio::spawn(async move {
                if l.accept().await.is_ok() {
                    o.lock().unwrap().push(tag);
                }
            });
        }
        let seq = parse_knock(&format!("{pb} {pa}")).unwrap();
        knock("127.0.0.1", &seq, Duration::from_millis(50)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(*order.lock().unwrap(), vec!['b', 'a']);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_success_failure_timeout_env() {
        let pc = |c: &str, t: u32| PreConnect {
            pre_connect: Some(c.into()),
            pre_connect_timeout: Some(t),
            ..Default::default()
        };
        assert!(run(&pc("test \"$BD_HOST:$BD_PORT:$BD_USER\" = h:2222:u", 5), "h", 2222, "u", true).await.is_ok());
        let e = run(&pc("echo nope >&2; exit 3", 5), "h", 22, "u", true).await.unwrap_err();
        assert!(e.contains("exit 3") && e.contains("nope"), "{e}");
        let e = run(&pc("sleep 5", 1), "h", 22, "u", true).await.unwrap_err();
        assert!(e.contains("within 1s"), "{e}");
    }
}
