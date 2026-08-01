# Peer Sync

Sync mods, configs, and (eventually) any folder with your friends, over LAN — no cloud
storage, no accounts, no port-forwarding.

## How it's built

```
peer-sync/
├── engine/            The sync engine. Plain Node + TypeScript.
│   └── src/
│       ├── types.ts          Shared types — the contract everything else speaks
│       ├── hashing/          Content hashing (SHA-256 for now, BLAKE3-ready)
│       ├── manifest/         Walk a folder, hash it, diff two manifests
│       ├── discovery/        LAN peer discovery — UDP broadcast beacon, working
│       ├── transfer/         Whole-file transfer — HTTP, working
│       ├── relay-client/     Internet fallback transport — STUB, not built yet
│       └── api/server.ts     Local HTTP API — the ONLY thing the UI talks to
├── src/               The UI. Plain TypeScript + Vite, running inside Tauri's webview.
├── src-tauri/         The Rust shell. Spawns the engine, shows the window.
└── package.json       Root — manages the frontend + Tauri CLI
```

## What's actually working right now

- **Discovery** — every engine instance broadcasts itself over UDP and listens for
  others on the same LAN. No setup, no config — open the app and friends on the same
  wifi just appear in the list.
- **Sharing** — pick a folder, click share, and the engine hashes it, caches the
  manifest, and starts answering file requests from peers.
- **Syncing** — pick a peer (or paste their address) and a destination folder, hit sync,
  and the engine fetches that peer's manifest, diffs it against your local folder, and
  pulls only what's missing or changed — deleting anything you have that they don't.
  This is one-way sync, on purpose (per our earlier design decision): the peer's copy is
  the truth, your folder ends up matching it exactly.

I tested this end-to-end before handing it over: two engine instances on different
ports, one sharing a folder, the other syncing from it — new files got added, stale
files got removed, and identical files were correctly left alone.

**One thing worth knowing:** the engine now listens on `0.0.0.0` instead of just
`127.0.0.1`, since other machines on your LAN need to reach it to pull files. That means
anyone on your network can hit its API while the app is running — fine for a tool you're
running with friends on trusted networks, but worth keeping in mind if you're ever on a
network you don't trust.

## What's stubbed, on purpose

`relay-client/` is still just a typed interface with TODOs — that's the piece needed for
friends who *aren't* on the same network. LAN sync (the common case if you're at a LAN
party or hosting locally) is fully functional without it.

## Running it locally

You'll need Node.js and the Rust toolchain (`rustup.rs`) plus your OS's Tauri
prerequisites — see https://v2.tauri.app/start/prerequisites/ for your platform. Your
friends **won't** need any of this — they'll just get a normal installer once this is
packaged for release.

```bash
# 1. Install engine deps and try it standalone (no GUI needed for this part)
cd engine && npm install && npm run dev

# 2. Install frontend deps and run the full desktop app
cd ..
npm install
npm run tauri dev
```

To test syncing with just one machine (before you've got a friend online to test with),
run a second engine instance on a different port:

```bash
cd engine
ENGINE_PORT=4022 npm run dev
```

Then in the app, use `http://127.0.0.1:4022` as the peer address.

## Next steps, roughly in order

1. **Relay fallback**, for friends not on the same network — a small WebSocket relay
   server, per our architecture discussion.
2. **Live sync status in the UI** — right now `/sync/pull` is a single blocking call;
   for big folders you'll want progress feedback (e.g. via Server-Sent Events or
   WebSocket instead of a plain POST).
3. **Auto re-sync** — currently you have to click "Sync now" manually. Watching the
   shared folder for changes and re-announcing would make this closer to "set and
   forget."
4. **Package the engine as a Tauri sidecar binary** so friends get one installer with
   zero dependencies, instead of relying on `npx` in dev.
5. **Real design pass** once the aesthetic direction is decided — right now `src/style.css`
   is intentionally plain.
