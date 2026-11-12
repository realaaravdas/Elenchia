//! Renders assets/elenchia-logo.svg into the icon set Tauri expects.
//! Usage: cargo run --manifest-path tools/icongen/Cargo.toml
use resvg::{tiny_skia, usvg};
use std::{fs, path::Path};

fn render(tree: &usvg::Tree, size: u32) -> Vec<u8> {
    let mut pm = tiny_skia::Pixmap::new(size, size).unwrap();
    let s = size as f32 / tree.size().width();
    resvg::render(tree, tiny_skia::Transform::from_scale(s, s), &mut pm.as_mut());
    pm.encode_png().unwrap()
}

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let svg = fs::read(root.join("assets/elenchia-logo.svg")).expect("logo svg");
    let tree = usvg::Tree::from_data(&svg, &usvg::Options::default()).expect("parse svg");
    let out = root.join("src-tauri/icons");
    fs::create_dir_all(&out).unwrap();
    for (name, size) in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256), ("icon.png", 512)] {
        fs::write(out.join(name), render(&tree, size)).unwrap();
    }
    // PNG-compressed ICO (supported since Vista).
    let sizes = [16u32, 32, 48, 64, 128, 256];
    let pngs: Vec<Vec<u8>> = sizes.iter().map(|&s| render(&tree, s)).collect();
    let mut ico = Vec::new();
    ico.extend_from_slice(&[0, 0, 1, 0]);
    ico.extend_from_slice(&(sizes.len() as u16).to_le_bytes());
    let mut offset = 6 + 16 * sizes.len() as u32;
    for (s, p) in sizes.iter().zip(&pngs) {
        ico.push(if *s >= 256 { 0 } else { *s as u8 });
        ico.push(if *s >= 256 { 0 } else { *s as u8 });
        ico.extend_from_slice(&[0, 0, 1, 0, 32, 0]);
        ico.extend_from_slice(&(p.len() as u32).to_le_bytes());
        ico.extend_from_slice(&offset.to_le_bytes());
        offset += p.len() as u32;
    }
    for p in &pngs { ico.extend_from_slice(p); }
    fs::write(out.join("icon.ico"), ico).unwrap();
    println!("icons written to {}", out.display());
}
