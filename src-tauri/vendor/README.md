# Vendored crates

## mysql_async 0.37.0

Copied from crates.io and patched to support the `sha256_password`
authentication plugin (search for "BalauDeck patch" in `src/conn/mod.rs`).
Upstream added it in blackbeam/mysql_async#397 (Aug 2026) but no release
includes it yet. Drop this copy and the `[patch.crates-io]` entry in
`src-tauri/Cargo.toml` once a released mysql_async supports `sha256_password`.
