import { open } from "@tauri-apps/plugin-dialog";

// The engine always runs on this local port (see src-tauri/src/main.rs,
// which spawns it on app startup). Everything the UI does goes through
// this HTTP API — swap the engine's implementation later and this file
// never needs to change.
const ENGINE_URL = "http://127.0.0.1:4021";

interface ManifestEntry {
  path: string;
  hash: string;
  size: number;
}

interface Manifest {
  rootPath: string;
  builtAt: number;
  entries: ManifestEntry[];
}

const statusEl = document.querySelector<HTMLParagraphElement>("#engine-status")!;
const pickButton = document.querySelector<HTMLButtonElement>("#pick-folder")!;
const folderPathEl = document.querySelector<HTMLParagraphElement>("#folder-path")!;
const fileListEl = document.querySelector<HTMLUListElement>("#file-list")!;

async function checkEngineHealth() {
  try {
    const res = await fetch(`${ENGINE_URL}/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    statusEl.textContent = "engine connected";
    statusEl.className = "status ok";
  } catch {
    statusEl.textContent = "engine not reachable — is it running?";
    statusEl.className = "status error";
  }
}

async function buildManifest(folderPath: string): Promise<Manifest> {
  const res = await fetch(`${ENGINE_URL}/manifest/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderPath }),
  });
  if (!res.ok) throw new Error(`manifest build failed: ${res.status}`);
  return res.json();
}

function renderManifest(manifest: Manifest) {
  fileListEl.innerHTML = "";
  for (const entry of manifest.entries) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = entry.path;
    const hash = document.createElement("span");
    hash.className = "hash";
    hash.textContent = entry.hash.slice(0, 14) + "…";
    li.append(name, hash);
    fileListEl.append(li);
  }
}

pickButton.addEventListener("click", async () => {
  const selected = await open({ directory: true, multiple: false });
  if (!selected || Array.isArray(selected)) return;

  folderPathEl.textContent = selected;
  fileListEl.innerHTML = "<li>hashing…</li>";

  try {
    const manifest = await buildManifest(selected);
    renderManifest(manifest);
  } catch (err) {
    fileListEl.innerHTML = `<li>Error: ${(err as Error).message}</li>`;
  }
});

checkEngineHealth();
