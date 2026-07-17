fn main() {
    // gdrive.rs bakes these with option_env!, which cargo reads at COMPILE time —
    // and cargo does NOT rebuild when an env var changes unless it's declared
    // here. Without this, setting them and rebuilding silently keeps whatever
    // was baked (usually nothing), so the build ships with Drive "not
    // configured" and the mistake is invisible until it's in a user's hands.
    println!("cargo:rerun-if-env-changed=BALAUDECK_GOOGLE_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=BALAUDECK_GOOGLE_CLIENT_SECRET");
    println!("cargo:rerun-if-env-changed=BALAUDECK_GOOGLE_IOS_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=BALAUDECK_GOOGLE_ANDROID_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=BALAUDECK_STORE_BUILD");

    // 16 KB page-size support for Android: align the native library's LOAD
    // segments to 16384 bytes so it loads on Android 15+ devices with 16 KB
    // memory pages (Google Play flags 4 KB-only native libs). A build-script
    // link arg is applied regardless of RUSTFLAGS (which Tauri sets), unlike a
    // .cargo/config.toml rustflags entry.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }
    tauri_build::build()
}
