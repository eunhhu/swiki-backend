// src/yws/server.ts
// Lightweight y-websocket compatible server using ws. In-memory only.
// Purpose: provide real-time collaboration for BlockNote via Yjs.

import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { setupWSConnection } from "y-websocket/bin/utils.js";

export interface StartYwsOptions {
  port?: number; // default: 8001
  path?: string; // default: '/yws'
}

export function startYWebsocketServer(opts: StartYwsOptions = {}) {
  const port = Number(opts.port ?? process.env.YWS_PORT ?? 8001);
  const basePath = (opts.path ?? process.env.YWS_PATH ?? "/").replace(/\/$/, "");

  // Single HTTP server dedicated to websocket upgrades
  const server = http.createServer((_, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.end("Y WebSocket server running\n");
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    // Accept all upgrades on this port; y-websocket utils will parse request.url for room name
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    // Optionally strip a base path from URL so that '/yws/room' becomes '/room'
    if (basePath && url.pathname.startsWith(basePath + "/")) {
      (request as any).url = url.pathname.slice(basePath.length); // keep leading '/'
    }
    wss.handleUpgrade(request as any, socket as any, head, (ws: WebSocket) => {
      setupWSConnection(ws as any, request as any, { pingTimeout: 30000 });
    });
  });

  server.listen(port, () => {
    console.log(`[yws] y-websocket listening on ws://localhost:${port}${basePath || ""}/:room`);
  });

  return server;
}
