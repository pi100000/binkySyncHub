// Tauri shell entry point.
//
// In dev, this spawns the engine via `npx tsx` as a plain child
// process. For real distribution to non-technical friends, the engine
// should be compiled to a standalone binary and bundled as a Tauri
// "sidecar" so friends never need Node installed — only the developer
// does. That packaging step is tracked as a TODO in the README.

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

struct EngineProcess(Mutex<Option<Child>>);

fn spawn_engine() -> Option<Child> {
    // On Windows, `npx` is actually `npx.cmd` — a batch-file shim, not
    // a real .exe. Rust's Command talks to CreateProcess directly,
    // which (unlike a shell prompt) doesn't auto-resolve .cmd/.bat
    // files, so Command::new("npx") silently fails to find anything
    // on Windows. Unix doesn't have this problem.
    let npx = if cfg!(target_os = "windows") { "npx.cmd" } else { "npx" };

    // Assumes this binary runs with its working directory at
    // src-tauri/, so ../engine points at the engine package.
    Command::new(npx)
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
