# Peer Sync

Share files/folders with your friends on the same network. Click share, they see it
appear in their app, they click download, it downloads. That's the whole interaction.

## How it works

```
peer-sync/
├── engine/            The sync engine. Plain Node + TypeScript.
│   └── src/
│       ├── hashing/      Content hashing (SHA-256)
│       ├── manifest/     Walk a folder/file list, hash it, diff two manifests
│       ├── discovery/    LAN peer discovery — UDP broadcast beacon
│       ├── transfer/     Whole-file HTTP transfer
│       ├── relay-client/ Internet fallback transport — STUB, not built yet
│       └── api/server.ts Local HTTP API — the ONLY thing the UI talks to
├── src/               The UI. Two lists: what you're sharing, what's available.
├── src-tauri/         The Rust shell. Spawns the engine, shows the window.
└── package.json
```

## The model

Each engine instance holds a small **catalog** — a list of things you're sharing (add
folders or files to it any time, they stay listed until you remove them). Peers discover
each other over LAN and ask each other "what's in your catalog?" (`GET /share/list`).
Every engine's `/browse` endpoint merges all of that into one list: everything available
from everyone currently visible, tagged with who it's from.

**Downloads always land in an app-managed folder**:
`~/PeerSyncDownloads/<friend's name>/<item name>/`. This is the thing that makes "just
click download" safe — since that folder only ever contains what was downloaded from
that specific friend/item, a download can freely mirror the source exactly (adding,
updating, *and removing* stale files) without any risk of touching something unrelated.
No folder picker, no "are you sure" — the destination is never ambiguous because you
never chose it.

Clicking download again on something you already have re-checks it against the source
and only pulls what's actually changed (or does nothing if it's already up to date) —
the hashing/diffing underneath is exactly the "only send what's different" system from
our original design discussion, just now hidden behind a single button.

## Running it locally

```bash
cd engine && npm install && npm run dev    # engine standalone, no GUI needed
# in another terminal:
cd .. && npm install && npm run tauri dev  # full desktop app
```

To test with just one machine, run a second engine on another port and use curl to
drive it (see the API routes in `engine/src/api/server.ts` — `/share`, `/browse`,
`/download`, `/sync/jobs/:id`), or run a full second Tauri window once port-configurability
is added (currently hardcoded to 4021 — ask if you want that changed).

## What's stubbed, on purpose

`relay-client/` — needed for friends who aren't on the same LAN. Not built yet; LAN
discovery/download is fully functional without it.

## Next steps

1. Relay fallback for non-LAN friends.
2. Package the engine as a Tauri sidecar binary so friends don't need Node installed.
3. Real design pass on the UI once the aesthetic direction is decided.
