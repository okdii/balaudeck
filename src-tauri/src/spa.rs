//! fwknop Single Packet Authorization (SPA), built in — no `fwknop` binary
//! needed, so it works on iOS, Android and the sandboxed store builds too.
//!
//! Wire format (libfko, protocol 3.0.0), Rijndael + HMAC mode — the setup
//! `fwknop --key-gen` produces and every current fwknopd expects:
//!
//!   encoded  = rand16 ":" b64(user) ":" unix_time ":" "3.0.0" ":" msg_type
//!              ":" b64("<allow_ip>,<proto/port>[,…]") [":" client_timeout]
//!   plain    = encoded ":" b64(sha256(encoded))
//!   blob     = "Salted__" ‖ salt8 ‖ AES-256-CBC/PKCS7(plain)
//!              key‖iv = OpenSSL EVP_BytesToKey(MD5, passphrase, salt8)
//!   full     = b64(blob)                 (starts "U2FsdGVkX1" = "Salted__")
//!   packet   = full[10..] ‖ b64(HMAC(hmac_key, full)) — one UDP datagram
//!
//! The HMAC covers the FULL base64 text; libfko only drops the "Salted__"
//! prefix when it hands the data out (fko_get_spa_data), and fwknopd puts it
//! back before verifying.
//!
//! Every b64 here is the standard alphabet with the trailing '=' stripped.
//! Verified against fwknopd 2.6.10 (see the ignored live test).

use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
use base64::Engine as _;
use hmac::{Hmac, Mac};
use md5::{Digest as _, Md5};
use sha2::{Sha256, Sha384, Sha512};

pub const DEFAULT_PORT: u16 = 62201;
const PROTOCOL_VERSION: &str = "3.0.0";
const ACCESS_MSG: u8 = 1;
const CLIENT_TIMEOUT_ACCESS_MSG: u8 = 2;
/// base64 of "Salted__" — fwknop strips it from Rijndael messages.
const SALTED_B64_PREFIX: &str = "U2FsdGVkX1";

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HmacType {
    Sha256,
    Sha384,
    Sha512,
    Sha1,
}

impl HmacType {
    pub fn parse(s: Option<&str>) -> Result<Self, String> {
        match s.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
            None | Some("") | Some("sha256") => Ok(Self::Sha256),
            Some("sha384") => Ok(Self::Sha384),
            Some("sha512") => Ok(Self::Sha512),
            Some("sha1") => Ok(Self::Sha1),
            Some(o) => Err(format!("SPA: unknown HMAC digest \"{o}\" (use sha256, sha384, sha512 or sha1).")),
        }
    }
}

/// Everything that goes into one SPA packet.
pub struct SpaRequest<'a> {
    pub user: &'a str,
    /// IP the server should open the ports for; "0.0.0.0" = the packet's
    /// source address (works behind NAT unless REQUIRE_SOURCE_ADDRESS is on).
    pub allow_ip: &'a str,
    /// "tcp/22" or "tcp/22,udp/53".
    pub access: &'a str,
    /// Ask the server to close the ports after this many seconds (0 = its default).
    pub client_timeout: u32,
    pub enc_key: &'a [u8],
    pub hmac_key: &'a [u8],
    pub hmac: HmacType,
}

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD_NO_PAD.encode(data)
}

/// Decode a key the way `fwknop --key-base64-*` does, or take it as text.
pub fn key_bytes(value: &str, is_base64: bool, what: &str) -> Result<Vec<u8>, String> {
    let v = value.trim();
    if v.is_empty() {
        return Err(format!("SPA: the {what} is empty."));
    }
    if !is_base64 {
        return Ok(v.as_bytes().to_vec());
    }
    let cleaned = v.trim_end_matches('=');
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(cleaned)
        .map_err(|_| format!("SPA: the {what} isn't valid base64 (untick \"base64\" if it's a plain passphrase)."))
}

/// Validate "tcp/22, udp/53" and normalise it to "tcp/22,udp/53".
pub fn normalize_access(spec: &str) -> Result<String, String> {
    let mut out = Vec::new();
    for tok in spec.split(|c: char| c == ',' || c.is_whitespace()).filter(|t| !t.is_empty()) {
        let (proto, port) = tok
            .split_once('/')
            .ok_or_else(|| format!("SPA access: \"{tok}\" — write it as tcp/22 or udp/53."))?;
        let proto = proto.to_ascii_lowercase();
        if proto != "tcp" && proto != "udp" {
            return Err(format!("SPA access: \"{tok}\" — the protocol must be tcp or udp."));
        }
        let port: u16 = port
            .parse()
            .ok()
            .filter(|p| *p > 0)
            .ok_or_else(|| format!("SPA access: \"{tok}\" — the port must be 1–65535."))?;
        out.push(format!("{proto}/{port}"));
    }
    if out.is_empty() {
        return Err("SPA access: list at least one port, e.g. tcp/22.".into());
    }
    Ok(out.join(","))
}

/// The plaintext SPA message (fields + digest), before encryption.
fn encode_message(req: &SpaRequest, rand16: &str, now: u64) -> String {
    let msg = format!("{},{}", req.allow_ip, req.access);
    let mut encoded = format!(
        "{rand16}:{}:{now}:{PROTOCOL_VERSION}:{}:{}",
        b64(req.user.as_bytes()),
        if req.client_timeout > 0 { CLIENT_TIMEOUT_ACCESS_MSG } else { ACCESS_MSG },
        b64(msg.as_bytes()),
    );
    if req.client_timeout > 0 {
        encoded.push_str(&format!(":{}", req.client_timeout));
    }
    let digest = b64(&Sha256::digest(encoded.as_bytes()));
    format!("{encoded}:{digest}")
}

/// OpenSSL EVP_BytesToKey(MD5, count = 1) → 32-byte key + 16-byte IV.
fn bytes_to_key(pass: &[u8], salt: &[u8; 8]) -> ([u8; 32], [u8; 16]) {
    let mut kiv = Vec::with_capacity(48);
    let mut prev: Vec<u8> = Vec::new();
    while kiv.len() < 48 {
        let mut h = Md5::new();
        h.update(&prev);
        h.update(pass);
        h.update(salt);
        prev = h.finalize().to_vec();
        kiv.extend_from_slice(&prev);
    }
    let mut key = [0u8; 32];
    let mut iv = [0u8; 16];
    key.copy_from_slice(&kiv[..32]);
    iv.copy_from_slice(&kiv[32..48]);
    (key, iv)
}

fn hmac_b64(kind: HmacType, key: &[u8], data: &[u8]) -> Result<String, String> {
    macro_rules! mac {
        ($d:ty) => {{
            let mut m = <Hmac<$d> as Mac>::new_from_slice(key).map_err(|e| format!("SPA HMAC: {e}"))?;
            m.update(data);
            b64(&m.finalize().into_bytes())
        }};
    }
    Ok(match kind {
        HmacType::Sha256 => mac!(Sha256),
        HmacType::Sha384 => mac!(Sha384),
        HmacType::Sha512 => mac!(Sha512),
        HmacType::Sha1 => mac!(sha1::Sha1),
    })
}

/// Build the packet with explicit randomness/time (deterministic for tests).
pub fn build_packet_with(req: &SpaRequest, rand16: &str, now: u64, salt: [u8; 8]) -> Result<String, String> {
    if req.hmac_key.is_empty() {
        return Err("SPA: the HMAC key is empty.".into());
    }
    let plain = encode_message(req, rand16, now);
    let (key, iv) = bytes_to_key(req.enc_key, &salt);
    let ct = cbc::Encryptor::<aes::Aes256>::new(&key.into(), &iv.into())
        .encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes());
    let mut blob = Vec::with_capacity(16 + ct.len());
    blob.extend_from_slice(b"Salted__");
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&ct);
    let full = b64(&blob);
    let enc = full
        .strip_prefix(SALTED_B64_PREFIX)
        .ok_or("SPA: unexpected cipher output")?
        .to_string();
    let mac = hmac_b64(req.hmac, req.hmac_key, full.as_bytes())?;
    Ok(format!("{enc}{mac}"))
}

/// 16 random decimal digits (libfko's rand_val), no leading zero.
fn random_digits() -> Result<String, String> {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).map_err(|e| format!("SPA random: {e}"))?;
    Ok(buf
        .iter()
        .enumerate()
        .map(|(i, b)| {
            let d = if i == 0 { 1 + b % 9 } else { b % 10 };
            char::from(b'0' + d)
        })
        .collect())
}

pub fn build_packet(req: &SpaRequest) -> Result<String, String> {
    let mut salt = [0u8; 8];
    getrandom::getrandom(&mut salt).map_err(|e| format!("SPA random: {e}"))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("SPA clock: {e}"))?
        .as_secs();
    build_packet_with(req, &random_digits()?, now, salt)
}

/// Send one SPA datagram to `host:port`.
pub async fn send(host: &str, port: u16, packet: &str) -> Result<(), String> {
    let addr = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("SPA: can't resolve {host}: {e}"))?
        .next()
        .ok_or_else(|| format!("SPA: can't resolve {host}"))?;
    let bind = if addr.is_ipv6() { "[::]:0" } else { "0.0.0.0:0" };
    let sock = tokio::net::UdpSocket::bind(bind)
        .await
        .map_err(|e| format!("SPA: can't open a UDP socket: {e}"))?;
    sock.send_to(packet.as_bytes(), addr)
        .await
        .map_err(|e| format!("SPA: sending to {addr} failed: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockDecryptMut;

    fn req<'a>(enc: &'a [u8], hk: &'a [u8], timeout: u32) -> SpaRequest<'a> {
        SpaRequest {
            user: "root",
            allow_ip: "10.1.2.3",
            access: "tcp/22",
            client_timeout: timeout,
            enc_key: enc,
            hmac_key: hk,
            hmac: HmacType::Sha256,
        }
    }

    /// Reverse the packet the way fwknopd does and check every field.
    fn decode(packet: &str, enc: &[u8], hk: &[u8]) -> String {
        let mac_len = 43; // b64(sha256) without '='
        let (body, mac) = packet.split_at(packet.len() - mac_len);
        let full = format!("{SALTED_B64_PREFIX}{body}");
        assert_eq!(hmac_b64(HmacType::Sha256, hk, full.as_bytes()).unwrap(), mac, "HMAC");
        let blob = base64::engine::general_purpose::STANDARD_NO_PAD.decode(full).unwrap();
        assert_eq!(&blob[..8], b"Salted__");
        let salt: [u8; 8] = blob[8..16].try_into().unwrap();
        let (key, iv) = bytes_to_key(enc, &salt);
        let pt = cbc::Decryptor::<aes::Aes256>::new(&key.into(), &iv.into())
            .decrypt_padded_vec_mut::<Pkcs7>(&blob[16..])
            .unwrap();
        String::from_utf8(pt).unwrap()
    }

    #[test]
    fn encodes_like_libfko() {
        // Matches the "Encoded Data" fwknop 2.6.10 printed for the same inputs.
        let r = req(b"k", b"h", 0);
        let m = encode_message(&r, "1783183895990108", 1795869086);
        assert!(m.starts_with("1783183895990108:cm9vdA:1795869086:3.0.0:1:MTAuMS4yLjMsdGNwLzIy:"), "{m}");
        let digest = m.rsplit(':').next().unwrap();
        assert_eq!(digest.len(), 43);
    }

    #[test]
    fn roundtrip_and_timeout() {
        let enc = key_bytes("E0pJZbU4r6TOa2VX/6i60LrirhI23HEdd9/NGcj9cfU=", true, "key").unwrap();
        let hk = key_bytes("c2VjcmV0LWhtYWMta2V5", true, "hmac").unwrap();
        let p = build_packet_with(&req(&enc, &hk, 0), "1234567890123456", 1700000000, [7; 8]).unwrap();
        assert!(!p.starts_with(SALTED_B64_PREFIX));
        assert!(!p.contains('='));
        let plain = decode(&p, &enc, &hk);
        assert!(plain.starts_with("1234567890123456:cm9vdA:1700000000:3.0.0:1:"), "{plain}");

        let p = build_packet_with(&req(&enc, &hk, 45), "1234567890123456", 1700000000, [9; 8]).unwrap();
        let plain = decode(&p, &enc, &hk);
        assert!(plain.contains(":3.0.0:2:") && plain.contains(":45:"), "{plain}");
    }

    #[test]
    fn evp_bytes_to_key_matches_openssl() {
        // `openssl enc -aes-256-cbc -md md5 -S 0102030405060708 -k password -P`
        let (key, iv) = bytes_to_key(b"password", &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(hex(&key), "e7b0971e52ca5cc8d0539fb3412f6316f7ba2e6ee293d9f3457b99436b51ce02");
        assert_eq!(hex(&iv), "8d450e2ed75a84a923d4eac9fe49226b");
    }
    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn access_and_keys() {
        assert_eq!(normalize_access("TCP/22, udp/53").unwrap(), "tcp/22,udp/53");
        assert!(normalize_access("22").is_err());
        assert!(normalize_access("icmp/1").is_err());
        assert!(normalize_access("tcp/0").is_err());
        assert!(normalize_access("  ").is_err());
        assert!(key_bytes("not base64!", true, "key").is_err());
        assert_eq!(key_bytes("pass", false, "key").unwrap(), b"pass");
        assert!(HmacType::parse(Some("md5")).is_err());
        assert_eq!(random_digits().unwrap().len(), 16);
    }

    /// Against a real fwknopd: BD_FWKNOP="host:port:KEY_BASE64:HMAC_KEY_BASE64".
    #[tokio::test]
    #[ignore]
    async fn fwknopd_live() {
        let spec = std::env::var("BD_FWKNOP").expect("BD_FWKNOP");
        let mut it = spec.splitn(4, ':');
        let (host, port, k, h) = (it.next().unwrap(), it.next().unwrap(), it.next().unwrap(), it.next().unwrap());
        let enc = key_bytes(k, true, "key").unwrap();
        let hk = key_bytes(h, true, "hmac").unwrap();
        let mut r = req(&enc, &hk, 0);
        r.allow_ip = "0.0.0.0";
        let p = build_packet(&r).unwrap();
        send(host, port.parse().unwrap(), &p).await.unwrap();
    }
}
