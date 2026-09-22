import { open } from "@tauri-apps/plugin-dialog";

const ENGINE_URL = "http://127.0.0.1:4021";

interface SharedItem {
  id: string;
  name: string;
  kind: "file" | "folder";
  fileCount: number;
  totalSize: number;
}

interface BrowseEntry extends SharedItem {
  peerId: string;
  peerName: string;
  peerAddress: string;
}

interface SyncJob {
  id: string;
  status: "running" | "done" | "error";
  total: number;
  completed: number;
  currentFile: string;
  destination: string;
  error?: string;
}

const statusEl = document.querySelector<HTMLParagraphElement>("#engine-status")!;
const shareFolderBtn = document.querySelector<HTMLButtonElement>("#share-folder-btn")!;
const shareFilesBtn = document.querySelector<HTMLButtonElement>("#share-files-btn")!;
const sharedListEl = document.querySelector<HTMLUListElement>("#shared-list")!;
const browseListEl = document.querySelector<HTMLUListElement>("#browse-list")!;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function kindIcon(kind: "file" | "folder"): string {
  return kind === "folder" ? "📁" : "📄";
}

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

// ---- your shared items ----

async function refreshSharedList() {
  try {
    const res = await fetch(`${ENGINE_URL}/share/list`);
    if (!res.ok) return;
    const { items } = (await res.json()) as { items: SharedItem[] };

    sharedListEl.innerHTML = "";
    if (items.length === 0) {
      sharedListEl.innerHTML = '<li class="empty">Nothing shared yet.</li>';
      return;
    }

    for (const item of items) {
      const li = document.createElement("li");
      li.className = "row";

      const icon = document.createElement("span");
      icon.className = "kind-icon";
      icon.textContent = kindIcon(item.kind);

      const meta = document.createElement("div");
      meta.className = "meta";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = item.name;
      const sub = document.createElement("span");
      sub.className = "sub";
      sub.textContent = `${item.fileCount} file(s) · ${formatSize(item.totalSize)}`;
      meta.append(name, sub);

      const removeBtn = document.createElement("button");
      removeBtn.className = "icon-button remove-button";
      removeBtn.textContent = "✕";
      removeBtn.title = "Stop sharing";
      removeBtn.addEventListener("click", async () => {
        await fetch(`${ENGINE_URL}/share/remove`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: item.id }),
        });
        refreshSharedList();
      });

      li.append(icon, meta, removeBtn);
      sharedListEl.append(li);
    }
  } catch {
    // Health indicator already covers "engine's not up" — no need to
    // duplicate that error here.
  }
}

shareFolderBtn.addEventListener("click", async () => {
  const selected = await open({ directory: true, multiple: false });
  if (!selected || Array.isArray(selected)) return;
  await fetch(`${ENGINE_URL}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderPath: selected }),
  });
  refreshSharedList();
});

shareFilesBtn.addEventListener("click", async () => {
  const selected = await open({ directory: false, multiple: true });
  if (!selected) return;
  const filePaths = Array.isArray(selected) ? selected : [selected];
  if (filePaths.length === 0) return;
  await fetch(`${ENGINE_URL}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filePaths }),
  });
  refreshSharedList();
});

// ---- browsing + one-click download ----

type DownloadState =
  | { status: "idle" }
  | { status: "downloading"; jobId: string; completed: number; total: number }
  | { status: "done"; destination: string }
  | { status: "error"; message: string };

const downloadStates = new Map<string, DownloadState>();
const entryKey = (entry: BrowseEntry) => `${entry.peerAddress}::${entry.id}`;

async function pollJob(key: string, jobId: string) {
  while (true) {
    const res = await fetch(`${ENGINE_URL}/sync/jobs/${jobId}`);
    if (!res.ok) {
      downloadStates.set(key, { status: "error", message: "Lost track of the download." });
      renderBrowseList(lastBrowseEntries);
      return;
    }
    const job = (await res.json()) as SyncJob;

    if (job.status === "running") {
      downloadStates.set(key, {
        status: "downloading",
        jobId,
        completed: job.completed,
        total: job.total,
      });
    } else if (job.status === "done") {
      downloadStates.set(key, { status: "done", destination: job.destination });
    } else {
      downloadStates.set(key, { status: "error", message: job.error ?? "Download failed." });
    }
    renderBrowseList(lastBrowseEntries);

    if (job.status !== "running") return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function startDownload(entry: BrowseEntry) {
  const key = entryKey(entry);
  downloadStates.set(key, { status: "downloading", jobId: "", completed: 0, total: entry.fileCount });
  renderBrowseList(lastBrowseEntries);

  try {
    const res = await fetch(`${ENGINE_URL}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        peerAddress: entry.peerAddress,
        peerName: entry.peerName,
        itemId: entry.id,
        itemName: entry.name,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `download failed: ${res.status}`);
    await pollJob(key, body.jobId);
  } catch (err) {
    downloadStates.set(key, { status: "error", message: (err as Error).message });
    renderBrowseList(lastBrowseEntries);
  }
}

let lastBrowseEntries: BrowseEntry[] = [];

function renderBrowseList(entries: BrowseEntry[]) {
  lastBrowseEntries = entries;
  browseListEl.innerHTML = "";

  if (entries.length === 0) {
    browseListEl.innerHTML = '<li class="empty">Nothing shared by anyone nearby yet.</li>';
    return;
  }

  for (const entry of entries) {
    const key = entryKey(entry);
    const state = downloadStates.get(key) ?? { status: "idle" };

    const li = document.createElement("li");
    li.className = "row";

    const icon = document.createElement("span");
    icon.className = "kind-icon";
    icon.textContent = kindIcon(entry.kind);

    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.name;
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = `from ${entry.peerName} · ${entry.fileCount} file(s) · ${formatSize(entry.totalSize)}`;
    meta.append(name, sub);
    li.append(icon, meta);

    if (state.status === "idle") {
      const btn = document.createElement("button");
      btn.className = "icon-button";
      btn.textContent = "⬇";
      btn.title = "Download";
      btn.addEventListener("click", () => startDownload(entry));
      li.append(btn);
    } else if (state.status === "downloading") {
      const wrap = document.createElement("div");
      wrap.className = "download-progress";
      const bar = document.createElement("progress");
      bar.max = 100;
      bar.value = state.total === 0 ? 100 : Math.round((state.completed / state.total) * 100);
      const pct = document.createElement("span");
      pct.className = "pct";
      pct.textContent = `${state.completed}/${state.total}`;
      wrap.append(bar, pct);
      li.append(wrap);
    } else if (state.status === "done") {
      const badge = document.createElement("span");
      badge.className = "status-badge done";
      badge.title = state.destination;
      badge.textContent = "✓ Downloaded";
      const btn = document.createElement("button");
      btn.className = "icon-button";
      btn.textContent = "⬇";
      btn.title = "Check for updates";
      btn.addEventListener("click", () => startDownload(entry));
      li.append(badge, btn);
    } else {
      const badge = document.createElement("span");
      badge.className = "status-badge error";
      badge.title = state.message;
      badge.textContent = "⚠ Failed";
      const btn = document.createElement("button");
      btn.className = "icon-button";
      btn.textContent = "⬇";
      btn.title = "Retry";
      btn.addEventListener("click", () => startDownload(entry));
      li.append(badge, btn);
    }

    browseListEl.append(li);
  }
}

async function pollBrowse() {
  try {
    const res = await fetch(`${ENGINE_URL}/browse`);
    if (!res.ok) return;
    const { items, peersOnline } = (await res.json()) as {
      items: BrowseEntry[];
      peersOnline: number;
    };
    if (items.length === 0) {
      browseListEl.innerHTML =
        peersOnline > 0
          ? `<li class="empty">${peersOnline} friend(s) online, nothing shared yet.</li>`
          : '<li class="empty">Looking for friends on your network…</li>';
      lastBrowseEntries = [];
      return;
    }
    renderBrowseList(items);
  } catch {
    // Health indicator covers this.
  }
}

// ---- boot ----

checkEngineHealth();
refreshSharedList();
pollBrowse();
setInterval(refreshSharedList, 3000);
setInterval(pollBrowse, 2000);
