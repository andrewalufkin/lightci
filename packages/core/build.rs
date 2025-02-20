use std::env;
use std::fs;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    println!("OUT_DIR is {}", out_dir.display());

    // Create proto directory if it doesn't exist
    let proto_dir = PathBuf::from("src/proto");
    fs::create_dir_all(&proto_dir)?;

    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        .file_descriptor_set_path(out_dir.join("lightci_descriptor.bin"))
        .compile(&["proto/engine.proto"], &["proto"])?;

    println!("Proto compilation completed");
    Ok(())
} 