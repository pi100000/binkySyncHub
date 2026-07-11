import { startApiServer } from "./api/server.js";

const PORT = Number(process.env.ENGINE_PORT ?? 4021);

startApiServer(PORT);
