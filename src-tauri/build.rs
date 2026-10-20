fn main() {
    println!(
        "cargo:rustc-env=PHI_TARGET_TRIPLE={}",
        std::env::var("TARGET").expect("missing TARGET")
    );
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let sdk = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("ghostty-sdk");
        assert!(
            sdk.join("lib/libghostty.a").exists(),
            "Ghostty SDK missing: run python3 scripts/build_ghostty.py first"
        );
        cc::Build::new()
            .file("native/terminal.m")
            .include(sdk.join("include"))
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .flag("-mmacosx-version-min=13.0")
            .compile("phi_terminal_host");
        println!(
            "cargo:rustc-link-search=native={}",
            sdk.join("lib").display()
        );
        println!("cargo:rustc-link-lib=static=ghostty");
        println!("cargo:rustc-link-lib=c++");
        for framework in [
            "AppKit",
            "Metal",
            "QuartzCore",
            "CoreText",
            "CoreGraphics",
            "Carbon",
            "IOSurface",
            "IOKit",
            "CoreVideo",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
        println!("cargo:rerun-if-changed=native");
        println!("cargo:rerun-if-changed=ghostty-sdk/lib/libghostty.a");
    }
    tauri_build::build();

    // Windows: Embed Common Controls v6 manifest for test binaries
    //
    // When running `cargo test`, the generated test executables don't include
    // the standard Tauri application manifest. Without Common Controls v6,
    // `tauri::test` calls fail with STATUS_ENTRYPOINT_NOT_FOUND.
    //
    // This workaround:
    // 1. Embeds the manifest into test binaries via /MANIFEST:EMBED
    // 2. Uses /MANIFEST:NO for the main binary to avoid duplicate resources
    //    (Tauri already handles manifest embedding for the app binary)
    #[cfg(target_os = "windows")]
    {
        let manifest_path = std::path::PathBuf::from(
            std::env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR"),
        )
        .join("common-controls.manifest");
        let manifest_arg = format!("/MANIFESTINPUT:{}", manifest_path.display());

        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg={}", manifest_arg);
        // Avoid duplicate manifest resources in binary builds.
        println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
        println!("cargo:rerun-if-changed={}", manifest_path.display());
    }
}
