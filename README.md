# BalauDeck

All-in-one SSH + database client (Tauri 2). SSH terminal, SFTP, SSH tunneling,
and a MySQL/MariaDB client — one codebase for **iPad/iOS, macOS, and Windows**
(Android planned).

> Status: **iPad MVP + desktop (Fasa 0–7).** SSH terminal, SFTP, SSH tunneling,
> MySQL/MariaDB client, saved profiles + keychain, biometric app lock. Runs on
> iPad (verified in simulator) and macOS (verified). Windows target is configured
> (keyring uses Credential Manager) but not yet built/verified on this machine.

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
- `src-tauri/src/db.rs` — `db_query` (streamed columns/rows), `db_exec_batch`
  (transactional row edits), schema objects, dump/import over mysql_async.
- `src-tauri/src/sftp.rs` — SFTP transfers and file ops (incl. `sftp_chmod`).
- `src/SshPanel.tsx` — xterm terminal wired to the SSH commands.
- `src/DbPanel.tsx` — schema sidebar, SQL editor, results grid, data editing,
  and the table designer.

## Features
- **Saved profiles** (SSH / SFTP / tunnel / database) in the sidebar, organized
  into folders; secrets live in the OS keychain, never on disk. Selecting a
  profile connects without retyping.
- **SSH terminal** — interactive PTY shell (xterm.js), password & public-key
  auth, TOFU host-key verification, iPad keyboard accessory bar.
- **SFTP browser** — browse, streamed upload/download (native file dialog),
  rename, delete, mkdir, and **change permissions** (chmod, rwx grid + octal).
  Connect using a saved SSH host, and optionally **run the server elevated**
  (`sudo /usr/lib/openssh/sftp-server`, with a stored sudo password or NOPASSWD)
  to browse as root. The title bar shows the effective `user@host`.
- **SSH tunnels** — local port forwarding; databases can connect through a tunnel.
- **MySQL/MariaDB client**
  - Schema sidebar (databases → tables / views / functions / saved queries) with
    a **search** box; connection-pool reuse.
  - SQL editor with **syntax highlighting**, beautify/minify, adjustable height,
    saved queries, and a virtualized results grid with a row cap.
  - **Edit data inline** — double-click a cell to edit; changes are written back
    as parameterized, transactional `UPDATE`s keyed on the primary key.
  - **Table designer** — create/alter columns, types, indexes, and foreign keys;
    plus **Show DDL**, create database, and **export / import SQL** with progress.
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

## Desktop bundles (macOS / Windows)
```bash
npm run tauri build            # current OS bundle
# macOS: .app + .dmg (notarize separately for distribution)
# Windows (run on Windows): .msi / NSIS .exe
```
The keychain backend is selected per OS at compile time (macOS/iOS Keychain,
Windows Credential Manager, Linux Secret Service).

See the full roadmap (Fasa 0–8) in the plan file referenced in the project notes.

## License

BalauDeck is open source under the [MIT License](LICENSE) — © 2026 Okdii
Solutions. You're free to use, modify, and distribute it; the software is
provided "as is", without warranty.
