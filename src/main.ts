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

type DiffAction = "add" | "update" | "remove";

interface DiffEntry {
  path: string;
  action: DiffAction;
  entry?: ManifestEntry;
}

interface DiffResult {
  changes: DiffEntry[];
  unchangedCount: number;
}

interface SyncJob {
  id: string;
  status: "running" | "done" | "error";
  total: number;
  completed: number;
  currentFile: string;
  applied: number;
  unchanged: number;
  error?: string;
}

const statusEl = document.querySelector<HTMLParagraphElement>("#engine-status")!;

const pickShareFolderButton = document.querySelector<HTMLButtonElement>("#pick-share-folder")!;
const pickShareFilesButton = document.querySelector<HTMLButtonElement>("#pick-share-files")!;
const sharePathEl = document.querySelector<HTMLParagraphElement>("#share-path")!;
const shareFileListEl = document.querySelector<HTMLUListElement>("#share-file-list")!;

const peerListEl = document.querySelector<HTMLUListElement>("#peer-list")!;

const peerUrlInput = document.querySelector<HTMLInputElement>("#peer-url-input")!;
const pickSyncButton = document.querySelector<HTMLButtonElement>("#pick-sync-folder")!;
const syncPathEl = document.querySelector<HTMLParagraphElement>("#sync-path")!;
const previewButton = document.querySelector<HTMLButtonElement>("#preview-button")!;

const previewPanelEl = document.querySelector<HTMLDivElement>("#preview-panel")!;
const previewSummaryEl = document.querySelector<HTMLParagraphElement>("#preview-summary")!;
const checklistsEl = document.querySelector<HTMLDivElement>("#preview-checklists")!;
const incomingGroupEl = document.querySelector<HTMLDivElement>("#incoming-group")!;
const incomingListEl = document.querySelector<HTMLUListElement>("#incoming-list")!;
const extraGroupEl = document.querySelector<HTMLDivElement>("#extra-group")!;
const extraListEl = document.querySelector<HTMLUListElement>("#extra-list")!;
const selectAllButton = document.querySelector<HTMLButtonElement>("#select-all-button")!;
const selectNoneButton = document.querySelector<HTMLButtonElement>("#select-none-button")!;
const applyButton = document.querySelector<HTMLButtonElement>("#apply-button")!;

const progressPanelEl = document.querySelector<HTMLDivElement>("#progress-panel")!;
const progressBarEl = document.querySelector<HTMLProgressElement>("#sync-progress")!;
const progressLabelEl = document.querySelector<HTMLParagraphElement>("#sync-progress-label")!;

const syncStatusEl = document.querySelector<HTMLParagraphElement>("#sync-status")!;

let syncDestPath: string | null = null;
let lastPreview: DiffEntry[] = [];

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

function renderShareManifest(manifest: Manifest) {
  shareFileListEl.innerHTML = "";
  for (const entry of manifest.entries) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = entry.path;
    const hash = document.createElement("span");
    hash.className = "hash";
    hash.textContent = entry.hash.slice(0, 14) + "…";
    li.append(name, hash);
    shareFileListEl.append(li);
  }
}

async function shareRequest(body: { folderPath?: string; filePaths?: string[] }) {
  shareFileListEl.innerHTML = "<li>hashing…</li>";
  try {
    const res = await fetch(`${ENGINE_URL}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`share failed: ${res.status}`);
    const { manifest } = (await res.json()) as { manifest: Manifest };
    renderShareManifest(manifest);
  } catch (err) {
    shareFileListEl.innerHTML = `<li>Error: ${(err as Error).message}</li>`;
  }
}

pickShareFolderButton.addEventListener("click", async () => {
  const selected = await open({ directory: true, multiple: false });
  if (!selected || Array.isArray(selected)) return;
  sharePathEl.textContent = `Sharing folder: ${selected}`;
  await shareRequest({ folderPath: selected });
});

pickShareFilesButton.addEventListener("click", async () => {
  const selected = await open({ directory: false, multiple: true });
  if (!selected) return;
  const filePaths = Array.isArray(selected) ? selected : [selected];
  if (filePaths.length === 0) return;
  sharePathEl.textContent = `Sharing ${filePaths.length} file(s)`;
  await shareRequest({ filePaths });
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
      updatePreviewButtonState();
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

// ---- preview ----

const ACTION_LABEL: Record<DiffAction, string> = { add: "+", update: "~", remove: "−" };

function updatePreviewButtonState() {
  previewButton.disabled = !(peerUrlInput.value.trim() && syncDestPath);
}

function renderChecklistItem(listEl: HTMLUListElement, change: DiffEntry, checkedByDefault: boolean) {
  const li = document.createElement("li");

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = checkedByDefault;
  checkbox.dataset.path = change.path;

  const action = document.createElement("span");
  action.className = `action action-${change.action}`;
  action.textContent = ACTION_LABEL[change.action];
  action.title = change.action;

  const path = document.createElement("span");
  path.className = "path";
  path.textContent = change.path;

  li.append(checkbox, action, path);
  listEl.append(li);
}

function renderPreview(diff: DiffResult) {
  lastPreview = diff.changes;
  previewPanelEl.classList.remove("hidden");
  progressPanelEl.classList.add("hidden");
  syncStatusEl.textContent = "";

  // "remove" means "exists in your folder, not in your friend's" — these
  // are YOUR files, not incoming ones, so they get their own group and
  // are unchecked by default. Nothing of yours is touched unless you
  // explicitly opt in.
  const incoming = diff.changes.filter((c) => c.action === "add" || c.action === "update");
  const extra = diff.changes.filter((c) => c.action === "remove");

  const parts: string[] = [];
  parts.push(
    incoming.length > 0
      ? `${incoming.length} file(s) to receive from your friend`
      : "Nothing new to receive from your friend",
  );
  if (extra.length > 0) parts.push(`${extra.length} file(s) only in your folder`);
  parts.push(`${diff.unchangedCount} already match`);
  previewSummaryEl.textContent = parts.join(" · ");

  incomingListEl.innerHTML = "";
  for (const change of incoming) renderChecklistItem(incomingListEl, change, true);
  incomingGroupEl.classList.toggle("hidden", incoming.length === 0);

  extraListEl.innerHTML = "";
  for (const change of extra) renderChecklistItem(extraListEl, change, false);
  extraGroupEl.classList.toggle("hidden", extra.length === 0);

  applyButton.disabled = incoming.length === 0 && extra.length === 0;
}

previewButton.addEventListener("click", async () => {
  const peerUrl = peerUrlInput.value.trim();
  if (!peerUrl || !syncDestPath) return;

  previewButton.disabled = true;
  previewSummaryEl.textContent = "comparing…";
  incomingGroupEl.classList.add("hidden");
  extraGroupEl.classList.add("hidden");
  previewPanelEl.classList.remove("hidden");

  try {
    const res = await fetch(`${ENGINE_URL}/sync/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerUrl, localFolderPath: syncDestPath }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `preview failed: ${res.status}`);
    renderPreview(body as DiffResult);
  } catch (err) {
    previewSummaryEl.textContent = `Error: ${(err as Error).message}`;
  } finally {
    updatePreviewButtonState();
  }
});

selectAllButton.addEventListener("click", () => {
  checklistsEl
    .querySelectorAll<HTMLInputElement>("input[type=checkbox]")
    .forEach((cb) => (cb.checked = true));
});

selectNoneButton.addEventListener("click", () => {
  checklistsEl
    .querySelectorAll<HTMLInputElement>("input[type=checkbox]")
    .forEach((cb) => (cb.checked = false));
});

// ---- apply + progress ----

function selectedChanges(): DiffEntry[] {
  const checkedPaths = new Set(
    [...checklistsEl.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked")].map(
      (cb) => cb.dataset.path,
    ),
  );
  return lastPreview.filter((change) => checkedPaths.has(change.path));
}

async function pollJob(jobId: string) {
  while (true) {
    const res = await fetch(`${ENGINE_URL}/sync/jobs/${jobId}`);
    if (!res.ok) {
      syncStatusEl.textContent = "Lost track of the sync job — try again.";
      return;
    }
    const job = (await res.json()) as SyncJob;

    const pct = job.total === 0 ? 100 : Math.round((job.completed / job.total) * 100);
    progressBarEl.value = pct;
    progressLabelEl.textContent =
      job.status === "running"
        ? `${job.completed} / ${job.total} — ${job.currentFile}`
        : `${job.completed} / ${job.total}`;

    if (job.status === "done") {
      syncStatusEl.textContent = `Done — ${job.applied} file(s) synced.`;
      progressPanelEl.classList.add("hidden");
      return;
    }
    if (job.status === "error") {
      syncStatusEl.textContent = `Error: ${job.error}`;
      progressPanelEl.classList.add("hidden");
      return;
    }

    await new Promise((r) => setTimeout(r, 300));
  }
}

applyButton.addEventListener("click", async () => {
  const peerUrl = peerUrlInput.value.trim();
  if (!peerUrl || !syncDestPath) return;

  const changes = selectedChanges();
  if (changes.length === 0) {
    syncStatusEl.textContent = "Nothing selected.";
    return;
  }

  applyButton.disabled = true;
  syncStatusEl.textContent = "";
  progressPanelEl.classList.remove("hidden");
  progressBarEl.value = 0;
  progressLabelEl.textContent = `0 / ${changes.length}`;

  try {
    const res = await fetch(`${ENGINE_URL}/sync/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerUrl, localFolderPath: syncDestPath, changes }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `sync failed: ${res.status}`);
    await pollJob(body.jobId);
  } catch (err) {
    syncStatusEl.textContent = `Error: ${(err as Error).message}`;
    progressPanelEl.classList.add("hidden");
  } finally {
    applyButton.disabled = false;
  }
});

// ---- destination folder ----

peerUrlInput.addEventListener("input", updatePreviewButtonState);

pickSyncButton.addEventListener("click", async () => {
  const selected = await open({ directory: true, multiple: false });
  if (!selected || Array.isArray(selected)) return;
  syncDestPath = selected;
  syncPathEl.textContent = `Destination: ${selected}`;
  previewPanelEl.classList.add("hidden");
  updatePreviewButtonState();
});

// ---- boot ----

checkEngineHealth();
pollPeers();
setInterval(pollPeers, 2000);
