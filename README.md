# termdb

All-in-one SSH + database client (Tauri 2). SSH terminal, SFTP, SSH tunneling,
and a MySQL/MariaDB client — one codebase for **iPad/iOS, macOS, and Windows**
(Android planned).

> Status: **iPad MVP complete (Fasa 0–6).** SSH terminal, SFTP, SSH tunneling,
> MySQL/MariaDB client, saved profiles + keychain, and biometric app lock — all
> cross-compiling for iOS. Desktop (macOS/Windows) is Fasa 7.

## Stack
- **Core (Rust):** `russh` (SSH/PTY/tunnel), `russh-sftp`, `mysql_async` (DB),
  `keyring` (secrets), `tokio`.
- **Frontend:** React + TypeScript + Vite, `xterm.js` terminal.
- **Shell:** Tauri 2.

## Prerequisites
- **Node 22** via nvm — `nvm use` (an `.nvmrc` pins it). Node 16 is too old.
- Rust stable, Xcode (for iOS), CocoaPods.

## Run
```bash
nvm use
npm install

# Desktop (macOS/Windows/Linux)
npm run tauri dev

# iPad / iOS simulator
npm run tauri ios dev "iPad Pro 13-inch (M5)"
```

## Test target (local)
The `docker-webstack-baru` stack runs MariaDB for testing:
- host: `127.0.0.1` (simulator reaches the host via localhost), port `3306`
- user `root`, password `12345` (dev default) — or `webstack`/`webstack`, db `webstack`

## Layout
- `src-tauri/src/ssh.rs` — SSH connect + interactive shell, streamed via
  `ssh://data/<id>` events. Commands: `ssh_open_shell`, `ssh_write`,
  `ssh_resize`, `ssh_close`.
- `src-tauri/src/db.rs` — `db_query` (dynamic columns/rows) over mysql_async.
- `src/SshPanel.tsx` — xterm terminal wired to the SSH commands.
- `src/DbPanel.tsx` — query editor + results grid.

## Features (iPad MVP)
- **Saved profiles** (SSH hosts + databases) in the sidebar; secrets in the OS
  keychain, never on disk. Selecting a profile connects without retyping.
- **SSH terminal** — interactive PTY shell (xterm.js), password & public-key
  auth, TOFU host-key verification, iPad keyboard accessory bar.
- **SFTP** — browse, upload/download (native file dialog), rename, delete, mkdir.
- **SSH tunnels** — local port forwarding; databases can connect through a tunnel.
- **MySQL/MariaDB** — schema browser, ad-hoc query editor, paged results grid.
- **Biometric app lock** (Face ID / Touch ID) on launch and on resume (mobile).

## Releasing to TestFlight / App Store (iOS)
Requires an Apple Developer account and a signing team.
```bash
# Build a signed release archive (set your team)
npm run tauri ios build -- --export-method app-store-connect
```
Then upload the resulting `.ipa` via Xcode Organizer or `xcrun altool`/Transporter.
Notes:
- `NSFaceIDUsageDescription` is set in `gen/apple/termdb_iOS/Info.plist`.
- `gen/apple/termdb_iOS/PrivacyInfo.xcprivacy` declares the privacy manifest;
  ensure it is a member of the app target's *Copy Bundle Resources* in Xcode.
- Raw SSH/MySQL sockets are not HTTP, so ATS exceptions are not required.

See the full roadmap (Fasa 0–8) in the plan file referenced in the project notes.
