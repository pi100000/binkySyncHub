# Peer Sync

Sync mods, configs, and (eventually) any folder with your friends, over LAN or the internet — no cloud storage, no accounts, no port-forwarding.

## How it's built

```
peer-sync/
├── engine/            The sync engine. Plain Node + TypeScript.
│   └── src/
│       ├── types.ts          Shared types — the contract everything else speaks
│       ├── hashing/          Content hashing (SHA-256 for now, BLAKE3-ready)
│       ├── manifest/         Walk a folder, hash it, diff two manifests
│       ├── discovery/        LAN peer discovery — STUB, not built yet
│       ├── transfer/         Whole-file transfer — STUB, not built yet
│       ├── relay-client/     Internet fallback transport — STUB, not built yet
│       └── api/server.ts     Local HTTP API — the ONLY thing the UI talks to
├── src/               The UI. Plain TypeScript + Vite, running inside Tauri's webview.
├── src-tauri/         The Rust shell. Spawns the engine, shows the window.
└── package.json       Root — manages the frontend + Tauri CLI
```

**Why it's split this way:** the UI never touches the engine's internals — it only calls
`http://127.0.0.1:4021` (see `engine/src/api/server.ts`). That means the engine can be
rewritten later — Node → Bun → a compiled Rust or Go binary — without touching a single
line of frontend code, as long as the replacement answers the same routes. This was the
whole point of the "future speed rewrite" requirement from the start.

## What's actually working right now

- `engine/src/hashing` and `engine/src/manifest` are real, tested code — walk a folder,
  hash every file, compare two manifests, get back exactly what changed.
- `engine/src/api/server.ts` exposes that over HTTP (`POST /manifest/build`,
  `POST /manifest/diff`).
- The Tauri UI can pick a folder and show you its manifest.

I ran this end-to-end already (two fake mod folders, one with a changed file and one new
file) — the diff correctly caught both and left the two unchanged files alone.

## What's stubbed, on purpose

`discovery/`, `transfer/`, and `relay-client/` are typed interfaces with TODOs, not real
implementations yet. They're scaffolded so the shape is right, but building real mDNS
discovery, actual file transfer, and the relay fallback is real work — better to do that
as focused next steps than rush it into this first pass. Each file explains what it needs
to do in its comments.

## Running it locally

You'll need Node.js (already have it) and, for the desktop shell, the Rust toolchain
(`rustup.rs`) plus your OS's Tauri prerequisites — see
https://v2.tauri.app/start/prerequisites/ for your platform. Your friends **won't** need
any of this — they'll just get a normal installer once this is packaged for release.

```bash
# 1. Install engine deps and try it standalone (no GUI needed for this part)
cd engine && npm install && npm run dev
# in another terminal:
curl -X POST http://127.0.0.1:4021/manifest/build \
  -H "Content-Type: application/json" \
  -d '{"folderPath": "/path/to/some/folder"}'

# 2. Install frontend deps and run the full desktop app
cd ..
npm install
npm run tauri dev
```

## Next steps, roughly in order

1. **Transfer** — implement `serveFiles`/`pullChanges` in `engine/src/transfer` (a plain
   HTTP file server + client is enough for v1, per our whole-file-transfer decision).
2. **Discovery** — implement LAN auto-detection in `engine/src/discovery` (the
   `bonjour-service` npm package is a solid choice).
3. **Wire the UI up to actually sync**, not just preview a manifest.
4. **Relay fallback**, for friends not on the same network.
5. **Package the engine as a Tauri sidecar binary** so friends get one installer with
   zero dependencies, instead of relying on `npx` in dev.
6. **Real design pass** once the aesthetic direction is decided — right now `src/style.css`
   is intentionally plain.
