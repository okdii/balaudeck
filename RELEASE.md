# Releasing BalauDeck

Four channels ship from this repo: **GitHub** (direct download + self-updater),
**Mac App Store**, **iOS App Store**, **Google Play**.

Every checkbox below is enforced by `scripts/release-check.sh`. Run it — reading
this file and nodding is how the last four bugs shipped. Each check exists
because it has already let a broken release reach users at least once; the
incidents are listed at the bottom so nobody "cleans up" a check that looks
paranoid.

The gate blocks on failure. **If a check fails, do not release.** If you think a
check is wrong, prove it against ground truth first — half the failures during
its own development were the *check* being broken, not the build.

---

## 0. Decide the version

Patch bump for fixes; the Android **versionCode** must always increase
(`0.3.4` → `3004`). Check what each channel actually last shipped, because they
diverge — a version live on Play may never have shipped on Apple:

```bash
fastlane ios appstatus      # iOS + macOS: version, state, ATTACHED BUILD
fastlane android tracks     # Play: version, status, what's-new text
gh release list --limit 3   # GitHub
```

## 1. Bump every version source (6 files + 2 Fastfile constants)

```
package.json + package-lock.json          npm version <v> --no-git-tag-version
src-tauri/Cargo.toml + Cargo.lock         (balaudeck crate)
src-tauri/tauri.conf.json
src-tauri/gen/apple/project.yml           CFBundleShortVersionString + CFBundleVersion
src-tauri/gen/apple/balaudeck_iOS/Info.plist   (both strings)
src-tauri/gen/android/app/tauri.properties     versionName + versionCode ← must increase
fastlane/Fastfile                         MAC_VERSION + submit_now's default ver
```

## 2. Write release notes — **one per channel, and they differ**

- [ ] `fastlane/metadata-mac/en-US/release_notes.txt` — macOS
- [ ] `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt` — Play
- [ ] the `notes` heredoc in `submit_now` (fastlane/Fastfile) — iOS

Don't copy one text into all three. If macOS never shipped the last version, its
notes must still list those features. A MAS-only fix belongs only in the macOS
notes.

## 3. Preflight — **blocks the release**

```bash
./scripts/release-check.sh preflight
```

Verifies: all 6 version sources agree · versionCode beats what's live on Play ·
notes exist for every channel · tree clean, pushed, authored `abukamila`, no
throwaway lanes · OAuth client present locally **and** as CI secrets · the
store-build flag compiles the update pill in for store builds and out for the
direct download.

## 4. Commit + tag

```bash
git -c user.name='abukamila' -c user.email='abukamila@users.noreply.github.com' commit
git push origin main && git tag v<version> && git push origin v<version>
```

CI builds the **tag**, so unpushed work silently doesn't ship. No
`Co-Authored-By` trailer.

## 5. Build + verify each artifact — **before uploading anything**

```bash
./scripts/mas-build.sh                 && ./scripts/release-check.sh artifact mac
fastlane ios build                     && ./scripts/release-check.sh artifact ios
fastlane android build                 && ./scripts/release-check.sh artifact android
```

Each checks freshness (the artifact paths persist across releases — a failed
export leaves the *previous* version sitting there and fastlane will happily
upload it), the version inside the artifact, signing, and that the OAuth client
is really baked in.

## 6. Upload + submit

```bash
fastlane ios masupload                             # macOS pkg
fastlane ios massubmit                             # pinned to MAC_VERSION
fastlane ios beta && fastlane ios submit_now v:<v> # iOS
fastlane android production status:completed       # Play (uploads the changelog)
```

## 7. Verify what actually shipped — **the release is not done until this passes**

```bash
./scripts/release-check.sh submitted          # attached build == version?
./scripts/release-check.sh artifact github    # OAuth baked in the published .dmg?
fastlane android tracks                       # is the what's-new really there?
```

Then publish GitHub (the draft is deliberate — a tag never auto-publishes):

```bash
gh release edit v<version> --draft=false --latest
curl -sL https://github.com/okdii/balaudeck/releases/latest/download/latest.json
# ^ must report the new version: this is what the desktop self-updater serves
```

## 8. Clean up

Throwaway diagnostic lanes (`cancelreview`, `macbuilds`, `*draft`) must not be
committed: `git checkout fastlane/Fastfile fastlane/README.md`.

---

## Why each check exists

Every one of these shipped. None were caught by a human reading a log.

| Check | The incident |
|---|---|
| OAuth client baked | **0.3.1 + 0.3.2 reached the Mac App Store with Google Drive sync dead.** `mas-build.sh` only *warned* when the client was missing and the warning scrolled past. It now hard-fails and greps the built binary. `option_env!` bakes at compile time, so a stale object file ships the old empty value — `build.rs` declares `rerun-if-env-changed` for exactly that. |
| Play changelog exists | **0.3.2 went live on Play with an empty "What's new".** Every supply lane passed `skip_upload_changelogs`, and the notes were gitignored along with the screenshots, so `3002.txt` was never in git and never reached anyone. |
| Store-build flag | **The store-update pill never worked on iOS or Play.** `BALAUDECK_STORE_BUILD` was only ever set by `mas-build.sh`, so `storeUpdateEnabled` was false and vite dead-code-eliminated the whole check — on the two platforms the feature was written for. |
| Attached build == version | **macOS 0.3.4 went into review with the 0.3.3 binary.** deliver attaches "the newest VALID build" and the just-uploaded pkg was still processing. Every log line said success. `massubmit` now pins `app_version`/`build_number`; `appstatus` prints the attachment and flags a mismatch. |
| Artifact freshness | `IPA_PATH`/`MAC_PKG`/`AAB_PATH` persist across releases. A failed export leaves the previous version there; fastlane uploads it without complaint. |
| Version sources agree | Six files plus two Fastfile constants. Any one left behind ships a mislabelled build. |

## Verifying a build: two traps that produce false results

Both bit during the 0.3.3 audit and cost real time.

1. **Always run a control.** Grep for something that *must* be present (the
   deep-link client id is in every binary). If the control reads 0, your
   **method** is broken, not the build. A `.msi` payload is MSZip-compressed, so
   `strings` on the raw installer finds nothing — extract it with `7z x` first.
2. **The shared project number `1026513342801-` is a false positive.** The
   iOS/Android client ids live in `tauri.conf.json` deep-link schemes, so they're
   in *every* binary. Match the full desktop id, or count `GOCSPX`.
3. **Don't grep the binary for frontend strings** — Tauri compresses the embedded
   frontend. Build `dist/` and grep that instead.

## Things that cannot be fixed

- **Local terminals can't work in the Mac App Store build.** The sandbox allows
  `/dev/ptmx` but gates the PTY slave behind a `com.apple.sandbox.pty` extension
  only a broker like Terminal.app can issue, so `openpty()` returns EPERM. No
  entitlement lifts it — see `/System/Library/Sandbox/Profiles/application.sb`.
  The tab is hidden in store builds. SSH is unaffected (a socket, not a tty).
- **Secrets are never committed.** The repo is public and Google auto-disables
  leaked client secrets. They live in `~/Library/Application Support/com.okdii.balaudeck/gdrive_client.json`
  and in CI secrets, and are only ever counted, never printed.
