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

interface Peer {
  id: string;
  displayName: string;
  reachability: "lan" | "relay";
  address?: string;
}

const statusEl = document.querySelector<HTMLParagraphElement>("#engine-status")!;

const pickShareButton = document.querySelector<HTMLButtonElement>("#pick-share-folder")!;
const sharePathEl = document.querySelector<HTMLParagraphElement>("#share-path")!;
const shareFileListEl = document.querySelector<HTMLUListElement>("#share-file-list")!;

const peerListEl = document.querySelector<HTMLUListElement>("#peer-list")!;

const peerUrlInput = document.querySelector<HTMLInputElement>("#peer-url-input")!;
const pickSyncButton = document.querySelector<HTMLButtonElement>("#pick-sync-folder")!;
const syncPathEl = document.querySelector<HTMLParagraphElement>("#sync-path")!;
const syncButton = document.querySelector<HTMLButtonElement>("#sync-button")!;
const syncStatusEl = document.querySelector<HTMLParagraphElement>("#sync-status")!;

let syncDestPath: string | null = null;

// ---- engine health ----

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

// ---- sharing ----

function renderManifest(listEl: HTMLUListElement, manifest: Manifest) {
  listEl.innerHTML = "";
  for (const entry of manifest.entries) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = entry.path;
    const hash = document.createElement("span");
    hash.className = "hash";
    hash.textContent = entry.hash.slice(0, 14) + "…";
    li.append(name, hash);
    listEl.append(li);
  }
}

pickShareButton.addEventListener("click", async () => {
  const selected = await open({ directory: true, multiple: false });
  if (!selected || Array.isArray(selected)) return;

  sharePathEl.textContent = `Sharing: ${selected}`;
  shareFileListEl.innerHTML = "<li>hashing…</li>";

  try {
    const res = await fetch(`${ENGINE_URL}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderPath: selected }),
    });
    if (!res.ok) throw new Error(`share failed: ${res.status}`);
    const { manifest } = (await res.json()) as { manifest: Manifest };
    renderManifest(shareFileListEl, manifest);
  } catch (err) {
    shareFileListEl.innerHTML = `<li>Error: ${(err as Error).message}</li>`;
  }
});

// ---- peer discovery ----

function renderPeers(peers: Peer[]) {
  peerListEl.innerHTML = "";

  if (peers.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No one else found on this network yet…";
    peerListEl.append(li);
    return;
  }

  for (const peer of peers) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = peer.displayName;
    const address = document.createElement("span");
    address.className = "peer-address";
    address.textContent = peer.address ?? "";
    li.append(name, address);
    li.addEventListener("click", () => {
      if (peer.address) peerUrlInput.value = peer.address;
      updateSyncButtonState();
    });
    peerListEl.append(li);
  }
}

async function pollPeers() {
  try {
    const res = await fetch(`${ENGINE_URL}/peers`);
    if (!res.ok) return;
    const { peers } = (await res.json()) as { peers: Peer[] };
    renderPeers(peers);
  } catch {
    // Engine's probably just not up yet — the health check above already
    // surfaces that, no need to duplicate the error here.
  }
}

// ---- syncing ----

function updateSyncButtonState() {
  syncButton.disabled = !(peerUrlInput.value.trim() && syncDestPath);
}

peerUrlInput.addEventListener("input", updateSyncButtonState);

pickSyncButton.addEventListener("click", async () => {
  const selected = await open({ directory: true, multiple: false });
  if (!selected || Array.isArray(selected)) return;
  syncDestPath = selected;
  syncPathEl.textContent = `Destination: ${selected}`;
  updateSyncButtonState();
});

syncButton.addEventListener("click", async () => {
  const peerUrl = peerUrlInput.value.trim();
  if (!peerUrl || !syncDestPath) return;

  syncButton.disabled = true;
  syncStatusEl.textContent = "syncing…";

  try {
    const res = await fetch(`${ENGINE_URL}/sync/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerUrl, localFolderPath: syncDestPath }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `sync failed: ${res.status}`);

    syncStatusEl.textContent = `Done — ${body.applied} file(s) updated, ${body.unchanged} already up to date.`;
  } catch (err) {
    syncStatusEl.textContent = `Error: ${(err as Error).message}`;
  } finally {
    updateSyncButtonState();
  }
});

// ---- boot ----

checkEngineHealth();
pollPeers();
setInterval(pollPeers, 2000);
