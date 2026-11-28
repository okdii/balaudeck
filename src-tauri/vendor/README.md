# Vendored crates

## mysql_async 0.37.0

Copied from crates.io and patched (search for "BalauDeck patch"):

- `src/conn/mod.rs`: the `sha256_password` authentication plugin. Upstream
  added it in blackbeam/mysql_async#397 (Aug 2026), not in a release yet.
- `src/io/tls/rustls_io.rs`: `skip_domain_validation` (our "verify-ca" mode)
  matched rustls' error text, which rustls 0.23 changed, so it never applied.

Drop this copy and the `[patch.crates-io]` entry in `src-tauri/Cargo.toml`
once a released mysql_async has both fixes.
