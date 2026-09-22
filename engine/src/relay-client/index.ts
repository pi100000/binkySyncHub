// Relay client — NOT YET IMPLEMENTED. Fallback for friends not on the
// same LAN (small always-on WebSocket relay that just pairs and pipes
// bytes between two peers, per our architecture discussion).

export interface RelayClient {
  connect(relayUrl: string, roomCode: string): Promise<void>;
  disconnect(): Promise<void>;
}

export function createRelayClient(): RelayClient {
  return {
    async connect(relayUrl, roomCode) {
      console.log(`[relay-client] stub — would connect to ${relayUrl} room ${roomCode}`);
    },
    async disconnect() {},
  };
}
