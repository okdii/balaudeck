<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="88" height="88" alt="BalauDeck icon" />
</p>

<h1 align="center">BalauDeck</h1>

<p align="center">
  <a href="https://apps.apple.com/my/app/balaudeck/id6782116564"><img alt="App Store" src="https://img.shields.io/badge/App_Store-0D96F6?logo=apple&logoColor=white"></a>
  <a href="https://play.google.com/store/apps/details?id=com.okdii.balaudeck"><img alt="Google Play" src="https://img.shields.io/badge/Google_Play-414141?logo=googleplay&logoColor=white"></a>
  <a href="https://github.com/okdii/balaudeck/releases/latest"><img alt="GitHub release" src="https://img.shields.io/github/v/release/okdii/balaudeck?label=Download&logo=github"></a>
  <a href="https://github.com/sponsors/okdii"><img alt="Sponsor" src="https://img.shields.io/badge/Sponsor-%E2%9D%A4-db61a2?logo=githubsponsors&logoColor=white"></a>
</p>

All-in-one SSH + database + object-storage client (Tauri 2). SSH terminal, SFTP,
SSH tunneling, a multi-engine SQL/NoSQL database client, and an S3-compatible
object-storage browser — one codebase for **iPad/iOS, macOS, Windows, and
Android**.

> Status: **shipping.** SSH terminal (fish-style autosuggestions, broadcast
> input, tmux persistence), SFTP with in-app file preview, SSH tunneling
> (local / dynamic SOCKS / remote), a database client for **MySQL · MariaDB ·
> PostgreSQL · SQL Server · SQLite · MongoDB · Redis**, an **S3 / MinIO / RustFS**
> object-storage browser, a background transfer queue, saved profiles + keychain,
> a **privacy mode** that blurs sensitive text, biometric app lock, encrypted
> cross-device sync, and **Google Drive sync**. Live on the **App Store**
> (iPhone · iPad · Mac), rolling out on **Google Play** (Android), with
> **Windows · macOS · Linux** installers on every
> [GitHub Release](https://github.com/okdii/balaudeck/releases/latest).

## Download

### App stores

<p align="center">
  <a href="https://apps.apple.com/my/app/balaudeck/id6782116564"><img alt="Download on the App Store" src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" height="40"></a>
  <a href="https://play.google.com/store/apps/details?id=com.okdii.balaudeck"><img alt="Get it on Google Play" src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png" height="58"></a>
</p>

- **iPhone · iPad · Mac** — [App Store](https://apps.apple.com/my/app/balaudeck/id6782116564)
- **Android** — [Google Play](https://play.google.com/store/apps/details?id=com.okdii.balaudeck)

### Desktop installers

Built by GitHub Actions ([`release.yml`](.github/workflows/release.yml)) and attached to every
**[GitHub Release](https://github.com/okdii/balaudeck/releases/latest)** — pick the file for your
platform from the latest release assets:

| Platform | Installer |
|---|---|
| 🪟 **Windows** | [`.msi`](https://github.com/okdii/balaudeck/releases/latest) · [NSIS `-setup.exe`](https://github.com/okdii/balaudeck/releases/latest) |
| 🍎 **macOS** (Apple Silicon) | [`.dmg`](https://github.com/okdii/balaudeck/releases/latest) |
| 🐧 **Linux** | [`.deb`](https://github.com/okdii/balaudeck/releases/latest) · [`.rpm`](https://github.com/okdii/balaudeck/releases/latest) · [`.AppImage`](https://github.com/okdii/balaudeck/releases/latest) |
| 🤖 **Android** | [Google Play](https://play.google.com/store/apps/details?id=com.okdii.balaudeck) · `.apk` for sideloading is attached to tagged [releases](https://github.com/okdii/balaudeck/releases) |

Desktop and APK builds are **not code-signed** — on first launch choose **Windows SmartScreen →
More info → Run anyway**, **macOS right-click → Open**, or enable “install unknown apps” on Android.
iOS/iPadOS build from source (see [Run](#run)).

## Preview

> All screenshots run with **privacy mode on** — hostnames, IPs and other
> sensitive text are blurred by the app itself (see [Privacy mode](#features)).

A real session — split panes running an SSH terminal (`htop`), a local shell,
and the database client, with tabs and per-pane tools (the sidebar shows saved
connections across every engine — SSH, tunnel, SQL, Mongo, Redis, S3):

![BalauDeck — multi-pane SSH + database workspace](docs/preview.png)

More screens:

**SSH terminal** — interactive PTY shell (here running `htop`); on iPad it adds a
keyboard accessory bar

![BalauDeck SSH terminal](docs/preview-ssh.png)

**SFTP browser** — browse remote files with sizes and permissions; upload,
download, rename, chmod, and preview text/images/PDFs in-app

![BalauDeck SFTP browser](docs/preview-sftp.png)

**SSH tunnels** — forward a local port and manage active tunnels

![BalauDeck SSH tunnels](docs/preview-tunnel.png)

## Stack
- **Core (Rust):** `russh` (SSH / PTY / tunnel), `russh-sftp`, database drivers
  `mysql_async` · `tokio-postgres` · `tiberius` (SQL Server) · `rusqlite` ·
  `mongodb` · `redis`, `aws-sdk-s3` (object storage), `keyring` (secrets;
  encrypted file-backed store on Android), `aes-gcm` + `argon2` (encrypted
  backup bundle), `tokio`. All drivers are **rustls-only** so the whole tree
  cross-compiles for iOS/Android.
- **Frontend:** React + TypeScript + Vite, `xterm.js` terminal, CodeMirror SQL
  editor, `pdfjs-dist` for in-app PDF preview.
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

# iOS device (signed): build a debug .ipa, then install with devicectl
npm run tauri -- ios build --export-method debugging

# Android device over Wi-Fi: build + install + launch in one step
npm run android:wifi -- --build   # omit --build to reinstall the last APK
```

`scripts/android-wifi-install.sh` connects to the phone over Wi-Fi (no USB),
auto-discovering the current wireless-debugging port via mDNS if it changed.
Set `BALAUDECK_ANDROID_IP` if DHCP moved the device.

## Test targets (local)
The `docker-webstack-baru` stack runs MariaDB for testing:
- host: `127.0.0.1` (simulator reaches the host via localhost), port `3306`
- user `root`, password `12345` (dev default) — or `webstack`/`webstack`, db `webstack`

For the object-storage browser, any S3-compatible server works — e.g. MinIO or
RustFS:
```bash
docker run -d --name minio -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio server /data --console-address ":9001"
```
Add it as an **Object storage** connection (access key `minioadmin`, path-style
addressing on, HTTPS off).

## Layout
- `src-tauri/src/ssh.rs` — SSH connect + interactive shell, streamed via
  `ssh://data/<id>` events. Commands: `ssh_open_shell`, `ssh_write`,
  `ssh_resize`, `ssh_close`.
- `src-tauri/src/sftp.rs` — SFTP transfers and file ops (incl. `sftp_chmod` and
  `sftp_preview`).
- `src-tauri/src/tunnel.rs` — local / dynamic SOCKS / remote port forwarding.
- `src-tauri/src/db.rs` — dialect-neutral SQL client (`db_query`, transactional
  `db_exec_batch`, schema objects, dump/import) over mysql_async / tokio-postgres
  / tiberius / rusqlite.
- `src-tauri/src/mongo.rs`, `src-tauri/src/rediskv.rs` — MongoDB and Redis.
- `src-tauri/src/s3.rs` — S3-compatible object storage (buckets, browse, upload/
  download, rename/copy/move, recursive delete, preview) via aws-sdk-s3.
- `src-tauri/src/transfers.rs` — shared background transfer queue (progress,
  cancel) used by SFTP and S3.
- `src-tauri/src/profiles.rs`, `src-tauri/src/gdrive.rs` — profiles + keychain,
  encrypted backup bundle, and Google Drive sync.
- `src/DbPanel.tsx` / `src/MongoPanel.tsx` / `src/RedisPanel.tsx` /
  `src/S3Panel.tsx` — the engine panels; `src/SshPanel.tsx` / `src/SftpPanel.tsx`
  — terminal and file browser; `src/FilePreview.tsx` — shared text/image/PDF
  preview reused by SFTP and S3.

## Features
- **Saved profiles** (SSH / SFTP / tunnel / database / object storage) in the
  sidebar, organized into folders; secrets live in the OS keychain, never on
  disk. Selecting a profile connects without retyping. **Right-click** a folder
  to add a connection straight into it (or a subfolder), and **duplicate** any
  connection — secrets included.
- **SSH terminal** — interactive PTY shell (xterm.js), password & public-key
  auth, TOFU host-key verification, iPad keyboard accessory bar.
  - **Autosuggestions** — fish-style inline ghost-text + a dropdown of choices
    from per-host command history and **real directory listings** (passively
    indexed from your own `ls`/`ll` output); → or ↑/↓ + → to accept.
  - **Broadcast input** — tick terminals to sync a group; typing in any member
    fans the keystrokes out to all (tmux `synchronize-panes` / iTerm broadcast).
  - **tmux integration** — optional tmux-backed sessions that survive reconnects,
    with a toggle to enable mouse mode (scroll/select) when tmux is on.
  - **Resilience** — keepalive, reconnect, and auto-reconnect on a dropped link.
- **SFTP browser** — browse, streamed upload/download (native file dialog),
  rename, delete, mkdir, and **change permissions** (chmod, rwx grid + octal).
  **Preview files in-app** — text, images and PDFs render in the panel (tap the
  eye or a file name), with a Download button for anything else. Connect using a
  saved SSH host, and optionally **run the server elevated**
  (`sudo /usr/lib/openssh/sftp-server`, with a stored sudo password or NOPASSWD)
  to browse as root. The title bar shows the effective `user@host`.
- **SSH tunnels** — **local (`-L`), dynamic SOCKS (`-D`), and remote (`-R`)**
  forwarding, with the equivalent `ssh` command shown to copy into a terminal;
  databases and the object-storage browser can connect through a tunnel. Pick the
  jump host from a searchable dropdown.
- **Database client** — one client for **MySQL, MariaDB, PostgreSQL, SQL Server,
  SQLite, MongoDB, and Redis**; the “New connection” dialog picks the engine and
  shows only the fields that engine needs.
  - **SQL engines** — schema sidebar (databases → tables / views / functions /
    saved queries) with a **search** box and connection-pool reuse; a SQL editor
    with **syntax highlighting**, **autocomplete**, beautify/minify, adjustable
    height and saved queries; and a virtualized results grid with a row cap.
    **Edit data inline** — double-click a cell to edit; changes are written back
    as parameterized, transactional `UPDATE`s keyed on the primary key. **Table
    designer** — create/alter columns, types, indexes and foreign keys, plus
    **Show DDL**, create database, and **export / import SQL** (with progress,
    and the dump can go straight to an S3 bucket).
  - **MongoDB** — browse databases and collections, run find queries, and page
    through documents.
  - **Redis** — browse keys, inspect values, and run commands.
- **Object storage (S3 / MinIO / RustFS)** — an S3-compatible browser: list /
  create / delete **buckets**; browse by prefix with a folder illusion +
  breadcrumb + pagination; **upload / download**, **rename / copy / move**,
  create folders, delete objects, and **recursive prefix delete** (type-the-name
  confirm); **preview** text, images and PDFs in the panel. Works with AWS S3 and
  self-hosted MinIO / RustFS (path-style addressing, checksum-compatible).
- **Background transfer queue** — SFTP and S3 uploads/downloads run in the
  background with a **progress bar and cancel**; large S3 objects use multipart.
- **Privacy mode** — a one-tap toggle that **blurs sensitive text** (hostnames,
  IPs, database and object names, and preview contents) via user-defined glob
  patterns (e.g. `*.*.*.*` for IPs). Matches blur wherever they appear as
  labels; hover to reveal. Ideal for screen-sharing, demos and screenshots.
- **Full-screen panes** — maximize any pane (SSH / SFTP / tunnel / DB / S3) to
  fill the whole display (the OS window goes fullscreen on desktop); the header
  toolbar stays visible so you can restore the original split layout.
- **Split-pane tabs & Markdown notes** — tile several sessions side by side in a
  tab, and keep per-workspace Markdown notes in the sidebar.
- **Cross-device sync** — export all profiles **and their secrets** as one
  encrypted, passphrase-protected bundle (AES-256-GCM, key derived via Argon2id)
  and import it on another device, so Mac, iPhone, iPad and Android share the same
  connections. Move it via AirDrop / Universal Clipboard / Files; desktop also
  saves/loads a `.balaudeck` file. Import merges by id and prunes dangling
  references.
- **Google Drive sync** — push/pull that same encrypted bundle through your own
  Google Drive (OAuth `drive.file` scope), with manual sync plus auto-sync
  (throttled pull on launch, debounced push after edits). Desktop uses a loopback
  redirect; iOS/Android use a deep-link redirect. Only ciphertext ever reaches
  Drive; the passphrase stays on-device in the keychain.
- **Touch-first** — resize handles, toolbars and row actions work with touch
  (Pointer Events) on iPad and Android tablets, with larger touch targets.
- **Biometric app lock** (Face ID / Touch ID / device credential) on launch and
  after the app has been backgrounded past a short grace period (mobile). Quick
  interruptions (file picker, app switch) don't re-prompt.

## Releasing to TestFlight / App Store (iOS)
Requires an Apple Developer account and a signing team.
```bash
# Build a signed release archive (set your team)
npm run tauri ios build -- --export-method app-store-connect
```
Then upload the resulting `.ipa` via Xcode Organizer or `xcrun altool`/Transporter.
Notes:
- `NSFaceIDUsageDescription` is set in `gen/apple/balaudeck_iOS/Info.plist`.
- `gen/apple/balaudeck_iOS/PrivacyInfo.xcprivacy` declares the privacy manifest;
  ensure it is a member of the app target's *Copy Bundle Resources* in Xcode.
- Raw SSH/database sockets are not HTTP, so ATS exceptions are not required.
- Encryption: the app uses only standard AES (backup bundle) + TLS/SSH, so set
  `ITSAppUsesNonExemptEncryption` and claim the standard-crypto exemption.

## Desktop bundles (macOS / Windows)
```bash
npm run tauri build            # current OS bundle
# macOS: .app + .dmg (notarize separately for distribution)
# Windows (run on Windows): .msi / NSIS .exe
```
The keychain backend is selected per OS at compile time (macOS/iOS Keychain,
Windows Credential Manager, Linux Secret Service). Android has no keyring backend,
so secrets are kept in the app's private storage (`allowBackup="false"`),
encrypted with a hardware-backed Android Keystore key.

## Sponsor

BalauDeck is free and open source, built and maintained by
[Okdii Solutions](https://github.com/okdii). If it saves you time, consider
sponsoring — it funds new features, platform releases, and ongoing maintenance.

<p align="center">
  <a href="https://github.com/sponsors/okdii"><img alt="Sponsor BalauDeck on GitHub Sponsors" src="https://img.shields.io/badge/GitHub_Sponsors-%E2%9D%A4-db61a2?logo=githubsponsors&logoColor=white&style=for-the-badge"></a>
</p>

💚 **[github.com/sponsors/okdii](https://github.com/sponsors/okdii)**

## License

BalauDeck is open source under the [MIT License](LICENSE) — © 2026 Okdii
Solutions. You're free to use, modify, and distribute it; the software is
provided "as is", without warranty.
