// Relay client module — NOT YET IMPLEMENTED.
//
// Plan: a small always-on relay server (you'd run this once, cheaply —
// think a $5 VPS) that peers connect OUT to over a plain WebSocket.
// The relay never stores files; it just pairs two sockets by a room
// code and pipes bytes between them. This is the fallback path for
// friends who aren't on the same wifi. LAN peers (via discovery/)
// should always be preferred when available — only fall back to this
// when a peer has reachability: "relay".

export interface RelayClient {
  connect(relayUrl: string, roomCode: string): Promise<void>;
  disconnect(): Promise<void>;
}

export function createRelayClient(): RelayClient {
  return {
    async connect(relayUrl, roomCode) {
      // TODO: open a WebSocket to relayUrl, join roomCode, and expose
      // a duplex stream that transfer/index.ts can read/write through
      // exactly like a direct LAN connection.
      console.log(`[relay-client] stub — would connect to ${relayUrl} room ${roomCode}`);
    },
    async disconnect() {
      // TODO: close the socket.
    },
  };
}
