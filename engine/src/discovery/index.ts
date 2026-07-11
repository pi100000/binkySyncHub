// Discovery module — NOT YET IMPLEMENTED.
//
// Plan: use mDNS (via the `bonjour-service` package) to broadcast this
// peer's presence on the LAN and listen for others. Peers found this
// way get reachability: "lan" and can connect directly, no relay
// needed. This is the "free bonus fast path" from the architecture
// discussion.
//
// The interface below is the contract — build() must return something
// that emits peer-found / peer-lost events. Fill in the mDNS
// implementation without needing to touch api/server.ts, which only
// depends on this interface.

import type { Peer } from "../types.js";

export interface DiscoveryService {
  start(): Promise<void>;
  stop(): Promise<void>;
  onPeerFound(callback: (peer: Peer) => void): void;
  onPeerLost(callback: (peerId: string) => void): void;
  getKnownPeers(): Peer[];
}

export function createDiscoveryService(): DiscoveryService {
  const knownPeers = new Map<string, Peer>();
  let foundCallback: ((peer: Peer) => void) | null = null;
  let lostCallback: ((peerId: string) => void) | null = null;

  return {
    async start() {
      // TODO: bind mDNS advertise + browse via bonjour-service here.
      console.log("[discovery] stub started — no real LAN discovery yet");
    },
    async stop() {
      // TODO: tear down mDNS.
    },
    onPeerFound(callback) {
      foundCallback = callback;
    },
    onPeerLost(callback) {
      lostCallback = callback;
    },
    getKnownPeers() {
      return [...knownPeers.values()];
    },
  };
}
