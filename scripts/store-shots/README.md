# Store screenshots (sample data only)

Renders the real React UI headlessly with a fake Tauri IPC (`mock.js` — invented
"shop" data, documentation IPs 203.0.113.x / 198.51.100.x), then frames each shot.

1. Start Vite on :5299 (`npx vite --port 5299`).
2. `export NODE_PATH=<any dir>/node_modules` that has `playwright` (uses system Chrome).
3. From this folder:
   - `node batch.cjs mac|ipad db,ai,ssh,schema,xfer,sftp,tunnel,s3,redis`
   - `node batch.cjs iphone|android db,ai,ssh,conn,redis,s3`
   - `node frame.cjs <device> <same scenes>` → `out/<device>/NN_<scene>.png`
4. Copy into fastlane: iPhone/iPad → `fastlane/screenshots/en-US/ios_{iphone,ipad}_NN_*.png`,
   Mac → `fastlane/screenshots-mac/en-US/`, Android → `fastlane/metadata/android/en-US/images/phoneScreenshots/`.

Sizes: Mac 2880×1800, iPad 13" 2064×2752, iPhone 6.9" 1320×2868, Play 1080×1920 (≤2:1).
