// Tauri shell entry point.
//
// For now, in dev, this spawns the engine via `npx tsx` as a plain
// child process — simplest thing that works. For real distribution to
// non-technical friends, the engine should be compiled to a standalone
// binary (e.g. `bun build --compile`) and bundled as a Tauri "sidecar"
// so friends never need Node/Bun installed at all — only you, the
// developer, need that. That packaging step is a TODO, tracked in the
// README, and doesn't change anything else in this file's shape.

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

struct EngineProcess(Mutex<Option<Child>>);

fn spawn_engine() -> Option<Child> {
    // Assumes this binary runs with its working directory at
    // src-tauri/, so ../engine points at the engine package.
    Command::new("npx")
        .args(["tsx", "src/index.ts"])
        .current_dir("../engine")
        .spawn()
        .map_err(|err| {
            eprintln!("[tauri] failed to spawn engine: {err}");
            err
        })
        .ok()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(EngineProcess(Mutex::new(spawn_engine())))
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app_handle.state::<EngineProcess>();
                let mut guard = match state.0.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                if let Some(mut child) = guard.take() {
                    let _ = child.kill();
                }
            }
        });
}
