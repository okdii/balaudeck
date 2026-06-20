fn main() {
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
