import os from "node:os";
import { startApiServer } from "./api/server.js";
import { createDiscoveryService } from "./discovery/index.js";

const PORT = Number(process.env.ENGINE_PORT ?? 4021);
const DISPLAY_NAME = os.hostname();

const discovery = createDiscoveryService(DISPLAY_NAME, PORT);
startApiServer(PORT, { discovery });
discovery.start().catch((err) => console.error("[discovery] failed to start:", err));

process.on("SIGINT", async () => {
  await discovery.stop();
  process.exit(0);
});
