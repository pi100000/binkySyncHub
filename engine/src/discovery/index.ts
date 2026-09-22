// LAN discovery via a UDP broadcast beacon. Every instance announces
// itself every 3s; peers heard from in the last 10s are "known".

import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import type { Peer } from "../types.js";

const DISCOVERY_PORT = 41234;
const BROADCAST_ADDR = "255.255.255.255";
const ANNOUNCE_INTERVAL_MS = 3000;
const PEER_TIMEOUT_MS = 10000;

interface AnnouncePacket {
  type: "peer-announce";
  id: string;
  displayName: string;
  apiPort: number;
}

export interface DiscoveryService {
  start(): Promise<void>;
  stop(): Promise<void>;
  onPeerFound(callback: (peer: Peer) => void): void;
  onPeerLost(callback: (peerId: string) => void): void;
  getKnownPeers(): Peer[];
}

export function createDiscoveryService(displayName: string, apiPort: number): DiscoveryService {
  const selfId = randomUUID();
  const knownPeers = new Map<string, Peer & { lastSeen: number }>();
  let foundCallback: ((peer: Peer) => void) | null = null;
  let lostCallback: ((peerId: string) => void) | null = null;
  let socket: dgram.Socket | null = null;
  let announceTimer: ReturnType<typeof setInterval> | null = null;
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  function broadcastAnnounce() {
    if (!socket) return;
    const packet: AnnouncePacket = { type: "peer-announce", id: selfId, displayName, apiPort };
    socket.send(Buffer.from(JSON.stringify(packet)), DISCOVERY_PORT, BROADCAST_ADDR, (err) => {
      if (err) console.warn("[discovery] broadcast failed:", err.message);
    });
  }

  return {
    async start() {
      socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

      socket.on("message", (message, rinfo) => {
        try {
          const packet = JSON.parse(message.toString()) as AnnouncePacket;
          if (packet.type !== "peer-announce" || packet.id === selfId) return;
          const isNew = !knownPeers.has(packet.id);
          const peer: Peer & { lastSeen: number } = {
            id: packet.id,
            displayName: packet.displayName,
            reachability: "lan",
            address: `http://${rinfo.address}:${packet.apiPort}`,
            lastSeen: Date.now(),
          };
          knownPeers.set(packet.id, peer);
          if (isNew) {
            console.log(`[discovery] found peer: ${peer.displayName} (${peer.address})`);
            foundCallback?.(peer);
          }
        } catch {
          // Not one of our packets — ignore.
        }
      });

      socket.on("error", (err) => console.error("[discovery] socket error:", err.message));

      await new Promise<void>((resolve, reject) => {
        socket!.once("error", reject);
        socket!.bind(DISCOVERY_PORT, () => {
          socket!.setBroadcast(true);
          resolve();
        });
      });

      broadcastAnnounce();
      announceTimer = setInterval(broadcastAnnounce, ANNOUNCE_INTERVAL_MS);

      cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [id, peer] of knownPeers) {
          if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
            knownPeers.delete(id);
            lostCallback?.(id);
          }
        }
      }, ANNOUNCE_INTERVAL_MS);

      console.log(`[discovery] started, broadcasting as "${displayName}"`);
    },

    async stop() {
      if (announceTimer) clearInterval(announceTimer);
      if (cleanupTimer) clearInterval(cleanupTimer);
      socket?.close();
      socket = null;
    },

    onPeerFound(callback) {
      foundCallback = callback;
    },
    onPeerLost(callback) {
      lostCallback = callback;
    },
    getKnownPeers() {
      return [...knownPeers.values()].map(({ lastSeen: _lastSeen, ...peer }) => peer);
    },
  };
}
