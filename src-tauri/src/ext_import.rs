//! Import saved connections from other database clients:
//!
//!  • DBeaver   — `data-sources.json` (+ `credentials-config.json`, AES-128-CBC
//!                with DBeaver's fixed, publicly documented key).
//!  • Navicat   — an `.ncx` file from File → Export Connections (passwords
//!                AES-128-CBC with Navicat 12+'s fixed key/IV).
//!  • TablePlus — `Connections.plist` (macOS). Passwords live in the macOS
//!                keychain under TablePlus's own entry, so they're not imported.
//!
//! This only *reads* the other app's files and returns candidates; the UI
//! shows them, the user picks, and the regular profile-save commands store
//! them (secrets go to the OS keychain as usual).

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use serde::Serialize;
use serde_json::Value;

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

#[derive(Serialize, Default, Clone, Debug)]
pub struct ExtSsh {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    /// Path of a private key file, when the source used key auth.
    pub key_path: Option<String>,
}

#[derive(Serialize, Default, Clone, Debug)]
pub struct ExtConn {
    pub name: String,
    /// BalauDeck engine id (mysql / mariadb / postgres / mssql / sqlite /
    /// mongodb / redis), or the source's own name when unsupported.
    pub engine: String,
    pub supported: bool,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: Option<String>,
    /// SQLite file path.
    pub file: Option<String>,
    pub password: Option<String>,
    /// Folder / group name in the source app, if any.
    pub folder: Option<String>,
    pub ssh: Option<ExtSsh>,
    /// ssh config hosts: "password" | "key" | "agent".
    pub auth: Option<String>,
    /// ssh config hosts: the first ProxyJump hop (`alias` or `[user@]host[:port]`).
    pub jump: Option<String>,
}

#[derive(Serialize)]
pub struct ExtScan {
    pub source: String,
    pub path: String,
    pub connections: Vec<ExtConn>,
    /// Non-fatal notes for the UI (e.g. "passwords stay in TablePlus's keychain").
    pub notes: Vec<String>,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

fn default_engine_port(engine: &str) -> u16 {
    match engine {
        "mysql" | "mariadb" => 3306,
        "postgres" => 5432,
        "mssql" => 1433,
        "mongodb" => 27017,
        "redis" => 6379,
        _ => 0,
    }
}

fn parse_port(s: Option<&str>, engine: &str) -> u16 {
    s.and_then(|p| p.trim().parse().ok()).filter(|p: &u16| *p > 0).unwrap_or_else(|| default_engine_port(engine))
}

fn non_empty(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

fn aes_cbc_decrypt(key: &[u8; 16], iv: &[u8; 16], data: &[u8]) -> Option<Vec<u8>> {
    let mut buf = data.to_vec();
    let out = Aes128CbcDec::new(key.into(), iv.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .ok()?;
    Some(out.to_vec())
}

// ---- DBeaver --------------------------------------------------------------

fn dbeaver_dirs() -> Vec<PathBuf> {
    let h = home();
    let mut v = vec![
        h.join("Library/DBeaverData/workspace6/General/.dbeaver"),
        h.join(".local/share/DBeaverData/workspace6/General/.dbeaver"),
    ];
    if let Some(appdata) = std::env::var_os("APPDATA") {
        v.push(PathBuf::from(appdata).join("DBeaverData/workspace6/General/.dbeaver"));
    }
    v
}

/// DBeaver's fixed credentials key (public; same in every install).
const DBEAVER_KEY: [u8; 16] = [
    0xba, 0xbb, 0x4a, 0x9f, 0x77, 0x4a, 0xb8, 0x53, 0xc9, 0x6c, 0x2d, 0x65, 0x3d, 0xfe, 0x54, 0x4a,
];

fn dbeaver_credentials(dir: &PathBuf) -> HashMap<String, Value> {
    let Ok(raw) = fs::read(dir.join("credentials-config.json")) else {
        return HashMap::new();
    };
    if raw.len() < 32 {
        return HashMap::new();
    }
    let iv: [u8; 16] = raw[..16].try_into().unwrap();
    aes_cbc_decrypt(&DBEAVER_KEY, &iv, &raw[16..])
        .and_then(|plain| serde_json::from_slice::<HashMap<String, Value>>(&plain).ok())
        .unwrap_or_default()
}

fn dbeaver_engine(driver: &str, provider: &str) -> (&'static str, bool) {
    let d = format!("{driver} {provider}").to_lowercase();
    if d.contains("mariadb") {
        ("mariadb", true)
    } else if d.contains("mysql") {
        ("mysql", true)
    } else if d.contains("postgres") {
        ("postgres", true)
    } else if d.contains("sqlserver") || d.contains("mssql") || d.contains("jtds") {
        ("mssql", true)
    } else if d.contains("sqlite") {
        ("sqlite", true)
    } else if d.contains("mongo") {
        ("mongodb", true)
    } else if d.contains("redis") {
        ("redis", true)
    } else {
        ("", false)
    }
}

pub fn scan_dbeaver(path: Option<String>) -> Result<ExtScan, String> {
    let file = match path {
        Some(p) => PathBuf::from(p),
        None => dbeaver_dirs()
            .into_iter()
            .map(|d| d.join("data-sources.json"))
            .find(|p| p.exists())
            .ok_or("DBeaver's data-sources.json wasn't found — choose it manually.")?,
    };
    let dir = file.parent().map(PathBuf::from).unwrap_or_default();
    let raw = fs::read_to_string(&file).map_err(|e| format!("read {}: {e}", file.display()))?;
    let root: Value = serde_json::from_str(&raw).map_err(|e| format!("not a DBeaver data-sources.json: {e}"))?;
    let creds = dbeaver_credentials(&dir);

    let mut out = Vec::new();
    if let Some(conns) = root.get("connections").and_then(Value::as_object) {
        for (id, c) in conns {
            let cfg = c.get("configuration").cloned().unwrap_or(Value::Null);
            let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(String::from);
            let driver = s(c, "driver").unwrap_or_default();
            let provider = s(c, "provider").unwrap_or_default();
            let (engine, supported) = dbeaver_engine(&driver, &provider);
            let engine_name = if supported { engine.to_string() } else { driver.clone() };
            let cred = creds.get(id);
            let cred_conn = cred.and_then(|c| c.get("#connection"));
            let user = s(&cfg, "user")
                .or_else(|| cred_conn.and_then(|c| s(c, "user")))
                .unwrap_or_default();
            let password = cred_conn.and_then(|c| s(c, "password")).filter(|p| !p.is_empty());
            let host = s(&cfg, "host").unwrap_or_default();
            let mut conn = ExtConn {
                name: s(c, "name").unwrap_or_else(|| id.clone()),
                engine: engine_name,
                supported,
                port: parse_port(s(&cfg, "port").as_deref(), engine),
                host,
                user,
                database: non_empty(s(&cfg, "database").as_deref()),
                file: None,
                password,
                folder: non_empty(s(c, "folder").as_deref()),
                ssh: None,
                ..Default::default()
            };
            if engine == "sqlite" {
                conn.file = non_empty(s(&cfg, "database").as_deref()).or_else(|| non_empty(s(&cfg, "url").as_deref().map(|u| u.trim_start_matches("jdbc:sqlite:"))));
                conn.database = None;
            }
            // SSH tunnel handler.
            if let Some(handlers) = cfg.get("handlers").and_then(Value::as_object) {
                if let Some(h) = handlers.get("ssh_tunnel") {
                    if h.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
                        let props = h.get("properties").cloned().unwrap_or(Value::Null);
                        let cred_ssh = cred.and_then(|c| c.get("network/ssh_tunnel"));
                        conn.ssh = Some(ExtSsh {
                            host: s(&props, "host").unwrap_or_default(),
                            port: props
                                .get("port")
                                .and_then(|p| p.as_u64().map(|n| n as u16).or_else(|| p.as_str().and_then(|s| s.parse().ok())))
                                .unwrap_or(22),
                            user: s(h, "user")
                                .or_else(|| cred_ssh.and_then(|c| s(c, "user")))
                                .unwrap_or_default(),
                            password: cred_ssh.and_then(|c| s(c, "password")).filter(|p| !p.is_empty()),
                            key_path: non_empty(s(&props, "keyPath").as_deref()),
                        });
                    }
                }
            }
            out.push(conn);
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(ExtScan {
        source: "dbeaver".into(),
        path: file.display().to_string(),
        connections: out,
        notes: vec![],
    })
}

// ---- Navicat (.ncx) -------------------------------------------------------

const NAVICAT_KEY: &[u8; 16] = b"libcckeylibcckey";
const NAVICAT_IV: &[u8; 16] = b"libcciv libcciv ";

fn navicat_password(hex_str: &str) -> Option<String> {
    let bytes = hex::decode(hex_str.trim()).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let plain = aes_cbc_decrypt(NAVICAT_KEY, NAVICAT_IV, &bytes)?;
    String::from_utf8(plain).ok().filter(|s| !s.is_empty())
}

fn navicat_engine(t: &str) -> (&'static str, bool) {
    match t.to_uppercase().as_str() {
        "MYSQL" => ("mysql", true),
        "MARIADB" => ("mariadb", true),
        "POSTGRESQL" | "PGSQL" => ("postgres", true),
        "SQLSERVER" | "MSSQL" => ("mssql", true),
        "SQLITE" => ("sqlite", true),
        "MONGODB" => ("mongodb", true),
        "REDIS" => ("redis", true),
        _ => ("", false),
    }
}

pub fn scan_navicat(path: String) -> Result<ExtScan, String> {
    use quick_xml::events::Event;
    let raw = fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))?;
    let mut reader = quick_xml::Reader::from_str(&raw);
    let mut out = Vec::new();
    let mut saw_root = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let tag = e.name();
                if tag.as_ref() == b"Connections" {
                    saw_root = true;
                }
                if tag.as_ref() != b"Connection" {
                    continue;
                }
                let mut a: HashMap<String, String> = HashMap::new();
                for attr in e.attributes().flatten() {
                    let k = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                    let v = attr.decode_and_unescape_value(&reader).map(|v| v.to_string()).unwrap_or_default();
                    a.insert(k, v);
                }
                let g = |k: &str| a.get(k).map(String::as_str);
                let ctype = g("ConnType").unwrap_or("");
                let (engine, supported) = navicat_engine(ctype);
                let mut conn = ExtConn {
                    name: g("ConnectionName").unwrap_or("Navicat connection").to_string(),
                    engine: if supported { engine.into() } else { ctype.to_lowercase() },
                    supported,
                    host: g("Host").unwrap_or("").to_string(),
                    port: parse_port(g("Port"), engine),
                    user: g("UserName").unwrap_or("").to_string(),
                    database: non_empty(g("InitialDatabase").or(g("Database"))),
                    file: None,
                    password: g("Password").and_then(navicat_password),
                    folder: None,
                    ssh: None,
                    ..Default::default()
                };
                if engine == "sqlite" {
                    conn.file = non_empty(g("DatabaseFileName"));
                }
                if g("SSH").map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false) {
                    let key_auth = g("SSH_AuthenMethod").map(|m| m.to_uppercase().contains("PUBLIC")).unwrap_or(false);
                    conn.ssh = Some(ExtSsh {
                        host: g("SSH_Host").unwrap_or("").to_string(),
                        port: g("SSH_Port").and_then(|p| p.parse().ok()).unwrap_or(22),
                        user: g("SSH_UserName").unwrap_or("").to_string(),
                        password: if key_auth { None } else { g("SSH_Password").and_then(navicat_password) },
                        key_path: if key_auth { non_empty(g("SSH_PrivateKey")) } else { None },
                    });
                }
                out.push(conn);
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("not a valid Navicat .ncx file: {e}")),
            _ => {}
        }
    }
    if !saw_root {
        return Err("not a Navicat export (.ncx) — use File → Export Connections in Navicat.".into());
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    let mut notes = vec![];
    if out.iter().any(|c| c.password.is_none() && c.supported && c.engine != "sqlite") {
        notes.push("Some passwords weren't in the export — tick “Export password” in Navicat to include them.".into());
    }
    Ok(ExtScan { source: "navicat".into(), path, connections: out, notes })
}

// ---- TablePlus (macOS plist) ----------------------------------------------

fn tableplus_engine(d: &str) -> (&'static str, bool) {
    match d.to_lowercase().as_str() {
        "mysql" => ("mysql", true),
        "mariadb" => ("mariadb", true),
        "postgresql" | "postgres" | "redshift" | "cockroachdb" => ("postgres", true),
        "sqlserver" | "microsoft sql server" | "mssql" => ("mssql", true),
        "sqlite" => ("sqlite", true),
        "mongodb" => ("mongodb", true),
        "redis" => ("redis", true),
        _ => ("", false),
    }
}

pub fn scan_tableplus(path: Option<String>) -> Result<ExtScan, String> {
    let file = match path {
        Some(p) => PathBuf::from(p),
        None => {
            let p = home().join("Library/Application Support/com.tinyapp.TablePlus/Data/Connections.plist");
            if !p.exists() {
                return Err("TablePlus's Connections.plist wasn't found — choose it manually.".into());
            }
            p
        }
    };
    let v: plist::Value = plist::from_file(&file).map_err(|e| format!("not a TablePlus Connections.plist: {e}"))?;
    let arr = v.as_array().ok_or("unexpected TablePlus file layout")?;
    let mut out = Vec::new();
    for item in arr {
        let Some(d) = item.as_dictionary() else { continue };
        let s = |k: &str| d.get(k).and_then(|v| v.as_string().map(String::from).or_else(|| v.as_signed_integer().map(|n| n.to_string())));
        let b = |k: &str| d.get(k).and_then(plist::Value::as_boolean).unwrap_or(false);
        let driver = s("Driver").unwrap_or_default();
        let (engine, supported) = tableplus_engine(&driver);
        let mut conn = ExtConn {
            name: s("ConnectionName").unwrap_or_else(|| "TablePlus connection".into()),
            engine: if supported { engine.into() } else { driver.to_lowercase() },
            supported,
            host: s("DatabaseHost").unwrap_or_default(),
            port: parse_port(s("DatabasePort").as_deref(), engine),
            user: s("DatabaseUser").unwrap_or_default(),
            database: non_empty(s("DatabaseName").as_deref()),
            file: None,
            password: None,
            folder: None,
            ssh: None,
            ..Default::default()
        };
        if engine == "sqlite" {
            conn.file = non_empty(s("DatabasePath").as_deref()).or_else(|| conn.database.take());
        }
        if b("OverSSH") {
            conn.ssh = Some(ExtSsh {
                host: s("ServerAddress").unwrap_or_default(),
                port: s("ServerPort").and_then(|p| p.parse().ok()).unwrap_or(22),
                user: s("ServerUser").unwrap_or_default(),
                password: None,
                key_path: non_empty(s("ServerPrivateKeyName").as_deref()),
            });
        }
        out.push(conn);
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(ExtScan {
        source: "tableplus".into(),
        path: file.display().to_string(),
        connections: out,
        notes: vec!["TablePlus keeps passwords in its own keychain entry, so they aren't imported — enter them once on first connect.".into()],
    })
}

// ---------------------------------------------------------------------------
// OpenSSH client config (~/.ssh/config)
// ---------------------------------------------------------------------------

/// One `Host` block: its patterns and its key → value lines in file order.
struct SshBlock {
    patterns: Vec<String>,
    opts: Vec<(String, String)>,
}

/// `*` and `?` glob match (OpenSSH host patterns).
fn glob_match(pat: &str, s: &str) -> bool {
    let (p, t): (Vec<char>, Vec<char>) = (pat.chars().collect(), s.chars().collect());
    let (mut pi, mut ti, mut star, mut mark) = (0usize, 0usize, None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi].eq_ignore_ascii_case(&t[ti])) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(sp) = star {
            pi = sp + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// A block applies when some pattern matches and no negated (`!pat`) one does.
fn block_matches(patterns: &[String], alias: &str) -> bool {
    let mut hit = false;
    for p in patterns {
        if let Some(neg) = p.strip_prefix('!') {
            if glob_match(neg, alias) {
                return false;
            }
        } else if glob_match(p, alias) {
            hit = true;
        }
    }
    hit
}

/// Split a config line into (lowercased key, value); handles `Key=Value`,
/// `Key Value` and double-quoted values.
fn split_cfg_line(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let idx = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let key = line[..idx].to_ascii_lowercase();
    let rest = line[idx..].trim_start_matches(|c: char| c.is_whitespace() || c == '=').trim();
    let val = rest.strip_prefix('"').and_then(|r| r.strip_suffix('"')).unwrap_or(rest);
    Some((key, val.to_string()))
}

fn expand_tilde(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        home().join(rest)
    } else {
        PathBuf::from(p)
    }
}

/// Parse a config file into blocks, following `Include` (relative paths are
/// under ~/.ssh; `*` globs in the file name are expanded). Lines before the
/// first `Host` belong to an implicit `Host *`. `Match` blocks are skipped.
fn parse_ssh_config(path: &PathBuf, depth: usize, blocks: &mut Vec<SshBlock>) {
    let Ok(text) = fs::read_to_string(path) else { return };
    let mut skipping = false;
    if blocks.is_empty() {
        blocks.push(SshBlock { patterns: vec!["*".into()], opts: vec![] });
    }
    for line in text.lines() {
        let Some((key, val)) = split_cfg_line(line) else { continue };
        match key.as_str() {
            "host" => {
                skipping = false;
                blocks.push(SshBlock {
                    patterns: val.split_whitespace().map(|s| s.trim_matches('"').to_string()).collect(),
                    opts: vec![],
                });
            }
            "match" => skipping = true,
            "include" if depth < 8 => {
                for inc in val.split_whitespace() {
                    let p = if inc.starts_with('/') || inc.starts_with('~') {
                        expand_tilde(inc)
                    } else {
                        home().join(".ssh").join(inc)
                    };
                    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    if name.contains('*') || name.contains('?') {
                        if let (Some(dir), Ok(rd)) = (p.parent(), fs::read_dir(p.parent().unwrap_or(&p))) {
                            let mut files: Vec<PathBuf> = rd
                                .flatten()
                                .map(|e| e.path())
                                .filter(|f| {
                                    f.file_name()
                                        .map(|n| glob_match(&name, &n.to_string_lossy()))
                                        .unwrap_or(false)
                                })
                                .collect();
                            files.sort();
                            let _ = dir;
                            for f in files {
                                parse_ssh_config(&f, depth + 1, blocks);
                            }
                        }
                    } else {
                        parse_ssh_config(&p, depth + 1, blocks);
                    }
                }
            }
            _ if !skipping => {
                if let Some(b) = blocks.last_mut() {
                    b.opts.push((key, val));
                }
            }
            _ => {}
        }
    }
}

/// Effective options for `alias`: first value wins across matching blocks.
fn effective_opts(blocks: &[SshBlock], alias: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for b in blocks.iter().filter(|b| block_matches(&b.patterns, alias)) {
        for (k, v) in &b.opts {
            out.entry(k.clone()).or_insert_with(|| v.clone());
        }
    }
    out
}

/// Expand the `%h` / `%r` / `%p` / `%%` tokens OpenSSH allows in values.
fn ssh_tokens(v: &str, host: &str, user: &str, port: u16) -> String {
    v.replace("%%", "\u{0}")
        .replace("%h", host)
        .replace("%r", user)
        .replace("%p", &port.to_string())
        .replace("%d", &home().to_string_lossy())
        .replace('\u{0}', "%")
}

pub fn scan_ssh_config(path: Option<String>) -> Result<ExtScan, String> {
    let p = path.map(|p| expand_tilde(&p)).unwrap_or_else(|| home().join(".ssh").join("config"));
    if !p.exists() {
        return Err(format!("{} not found", p.display()));
    }
    let mut blocks = Vec::new();
    parse_ssh_config(&p, 0, &mut blocks);

    let local_user = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default();
    #[cfg(unix)]
    let has_agent = crate::ssh::agent_socket().is_some();
    #[cfg(not(unix))]
    let has_agent = false;
    let default_key = ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .map(|k| home().join(".ssh").join(k))
        .find(|k| k.exists())
        .map(|k| format!("~/.ssh/{}", k.file_name().unwrap().to_string_lossy()));

    let mut seen = std::collections::HashSet::new();
    let mut connections = Vec::new();
    let mut proxy_cmd = false;
    for b in &blocks {
        for alias in &b.patterns {
            if alias.contains('*') || alias.contains('?') || alias.starts_with('!') || !seen.insert(alias.clone()) {
                continue;
            }
            let o = effective_opts(&blocks, alias);
            let port = o.get("port").and_then(|p| p.parse().ok()).unwrap_or(22);
            let user = o.get("user").cloned().unwrap_or_else(|| local_user.clone());
            let host = o
                .get("hostname")
                .map(|h| ssh_tokens(h, alias, &user, port))
                .unwrap_or_else(|| alias.clone());
            let key_path = o.get("identityfile").map(|k| ssh_tokens(k, &host, &user, port));
            let jump = o
                .get("proxyjump")
                .filter(|j| !j.eq_ignore_ascii_case("none"))
                .map(|j| j.split(',').next().unwrap_or("").trim().to_string())
                .filter(|j| !j.is_empty());
            if o.contains_key("proxycommand") && jump.is_none() {
                proxy_cmd = true;
            }
            let auth = if key_path.is_some() {
                "key"
            } else if has_agent {
                "agent"
            } else if default_key.is_some() {
                "key"
            } else {
                "password"
            };
            connections.push(ExtConn {
                name: alias.clone(),
                engine: "ssh".into(),
                supported: true,
                host: host.clone(),
                port,
                user: user.clone(),
                ssh: Some(ExtSsh {
                    host,
                    port,
                    user,
                    password: None,
                    key_path: if auth == "key" { key_path.or_else(|| default_key.clone()) } else { None },
                }),
                auth: Some(auth.into()),
                jump,
                ..Default::default()
            });
        }
    }
    let mut notes = vec![
        "Hosts using a key with a passphrase: add the passphrase in the profile, or switch it to ssh-agent.".to_string(),
    ];
    if proxy_cmd {
        notes.push("ProxyCommand isn't supported — those hosts are imported without it (ProxyJump is).".into());
    }
    Ok(ExtScan {
        source: "sshconfig".into(),
        path: p.display().to_string(),
        connections,
        notes,
    })
}

/// Read another client's saved connections. `path` overrides the default
/// location (required for Navicat, whose connections come from an export).
#[tauri::command]
pub fn ext_import_scan(source: String, path: Option<String>) -> Result<ExtScan, String> {
    match source.as_str() {
        "dbeaver" => scan_dbeaver(path),
        "navicat" => scan_navicat(path.ok_or("choose the .ncx file exported from Navicat")?),
        "tableplus" => scan_tableplus(path),
        "sshconfig" => scan_ssh_config(path),
        _ => Err(format!("unknown source {source}")),
    }
}

/// Read a private key file referenced by an imported SSH config (so it can be
/// stored in the keychain like a pasted key). Refuses anything that doesn't
/// look like a key.
#[tauri::command]
pub fn ext_import_read_key(path: String) -> Result<String, String> {
    let p = if let Some(rest) = path.strip_prefix("~/") { home().join(rest) } else { PathBuf::from(&path) };
    let meta = fs::metadata(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    if meta.len() > 64 * 1024 {
        return Err("not a private key (too large)".into());
    }
    let text = fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    if !text.contains("PRIVATE KEY") {
        return Err(format!("{} doesn't look like a private key", p.display()));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockEncryptMut;

    type Enc = cbc::Encryptor<aes::Aes128>;

    #[test]
    fn navicat_password_roundtrip() {
        let mut buf = [0u8; 32];
        let ct = Enc::new(NAVICAT_KEY.into(), NAVICAT_IV.into())
            .encrypt_padded_b2b_mut::<Pkcs7>(b"s3cret", &mut buf)
            .unwrap();
        let hex_ct = hex::encode_upper(ct);
        assert_eq!(navicat_password(&hex_ct).as_deref(), Some("s3cret"));
        assert_eq!(navicat_password(""), None);
    }

    #[test]
    fn navicat_ncx_parses() {
        let mut buf = [0u8; 32];
        let ct = Enc::new(NAVICAT_KEY.into(), NAVICAT_IV.into())
            .encrypt_padded_b2b_mut::<Pkcs7>(b"pw1", &mut buf)
            .unwrap();
        let xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<Connections Ver="1.5">
  <Connection ConnectionName="Prod PG" ConnType="POSTGRESQL" Host="db.example" Port="5433" UserName="app" Password="{}" InitialDatabase="main" SSH="true" SSH_Host="bastion" SSH_Port="2200" SSH_UserName="ops" SSH_AuthenMethod="PUBLICKEY" SSH_PrivateKey="/k/id_ed25519"/>
  <Connection ConnectionName="Ora" ConnType="ORACLE" Host="o" Port="1521" UserName="x"/>
</Connections>"#,
            hex::encode_upper(ct)
        );
        let dir = std::env::temp_dir().join(format!("bd-ncx-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("c.ncx");
        fs::write(&f, xml).unwrap();
        let scan = scan_navicat(f.display().to_string()).unwrap();
        fs::remove_dir_all(&dir).ok();
        assert_eq!(scan.connections.len(), 2);
        let pg = scan.connections.iter().find(|c| c.name == "Prod PG").unwrap();
        assert_eq!(pg.engine, "postgres");
        assert_eq!(pg.port, 5433);
        assert_eq!(pg.password.as_deref(), Some("pw1"));
        assert_eq!(pg.database.as_deref(), Some("main"));
        let ssh = pg.ssh.as_ref().unwrap();
        assert_eq!((ssh.host.as_str(), ssh.port, ssh.user.as_str()), ("bastion", 2200, "ops"));
        assert_eq!(ssh.key_path.as_deref(), Some("/k/id_ed25519"));
        assert!(!scan.connections.iter().find(|c| c.name == "Ora").unwrap().supported);
    }

    #[test]
    fn dbeaver_parses_with_credentials() {
        let dir = std::env::temp_dir().join(format!("bd-dbv-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("data-sources.json"),
            r#"{"folders":{},"connections":{"mysql-1":{"provider":"mysql","driver":"mysql8","name":"Local MySQL","folder":"Dev",
              "configuration":{"host":"127.0.0.1","port":"3307","database":"shop","handlers":{"ssh_tunnel":{"enabled":true,"properties":{"host":"jump","port":22}}}}}}}"#,
        )
        .unwrap();
        // Encrypt a credentials file with DBeaver's key.
        let creds = br##"{"mysql-1":{"#connection":{"user":"root","password":"pw"},"network/ssh_tunnel":{"user":"ops","password":"sshpw"}}}"##;
        let iv = [7u8; 16];
        let mut buf = vec![0u8; creds.len() + 16];
        let ct = Enc::new(&DBEAVER_KEY.into(), &iv.into())
            .encrypt_padded_b2b_mut::<Pkcs7>(creds, &mut buf)
            .unwrap()
            .to_vec();
        let mut file = iv.to_vec();
        file.extend(ct);
        fs::write(dir.join("credentials-config.json"), file).unwrap();

        let scan = scan_dbeaver(Some(dir.join("data-sources.json").display().to_string())).unwrap();
        fs::remove_dir_all(&dir).ok();
        let c = &scan.connections[0];
        assert_eq!((c.engine.as_str(), c.port, c.user.as_str()), ("mysql", 3307, "root"));
        assert_eq!(c.password.as_deref(), Some("pw"));
        assert_eq!(c.folder.as_deref(), Some("Dev"));
        let s = c.ssh.as_ref().unwrap();
        assert_eq!((s.host.as_str(), s.user.as_str(), s.password.as_deref()), ("jump", "ops", Some("sshpw")));
    }

    #[test]
    fn ssh_config_effective_options() {
        let dir = std::env::temp_dir().join(format!("bd-sshcfg-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let inc = dir.join("extra.conf");
        fs::write(&inc, "Host db\n  HostName 10.0.0.5\n  ProxyJump bastion\n").unwrap();
        let cfg = dir.join("config");
        fs::write(
            &cfg,
            format!(
                "Include {}\n\nHost web-* !web-old\n  User deploy\n\nHost web-1 web-2\n  HostName %h.example.com\n  Port 2222\n\nHost bastion\n  HostName=1.2.3.4\n  User ops\n  IdentityFile ~/.ssh/ops_key\n\nHost *\n  User fallback\n  Port 22\n",
                inc.display()
            ),
        )
        .unwrap();
        let s = scan_ssh_config(Some(cfg.display().to_string())).unwrap();
        let by = |n: &str| s.connections.iter().find(|c| c.name == n).unwrap().clone();
        assert_eq!(s.connections.len(), 4);
        let w1 = by("web-1");
        assert_eq!((w1.host.as_str(), w1.port, w1.user.as_str()), ("web-1.example.com", 2222, "deploy"));
        let b = by("bastion");
        assert_eq!((b.host.as_str(), b.user.as_str(), b.auth.as_deref()), ("1.2.3.4", "ops", Some("key")));
        assert_eq!(b.ssh.unwrap().key_path.as_deref(), Some("~/.ssh/ops_key"));
        let d = by("db");
        assert_eq!((d.host.as_str(), d.user.as_str(), d.jump.as_deref()), ("10.0.0.5", "fallback", Some("bastion")));
        assert!(glob_match("web-*", "WEB-9") && !block_matches(&["web-*".into(), "!web-old".into()], "web-old"));
        let _ = fs::remove_dir_all(&dir);
    }
}
