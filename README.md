# termdb

All-in-one SSH + database client (Tauri 2). SSH terminal, SFTP, SSH tunneling,
and a MySQL/MariaDB client — one codebase for **iPad/iOS, macOS, and Windows**
(Android planned).

> Status: **Fasa 0 (spike)** — SSH shell (PTY) and MySQL/MariaDB query paths are
> wired end-to-end (Rust + xterm.js) and verified to cross-compile for iOS.

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

See the full roadmap (Fasa 0–8) in the plan file referenced in the project notes.
