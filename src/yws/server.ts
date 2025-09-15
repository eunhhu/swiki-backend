// src/yws/server.ts
// Minimal Yjs-compatible WebSocket server using ws + y-protocols.
// Compatible with y-websocket client protocol used by BlockNote's WebsocketProvider.

import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import { Awareness } from "y-protocols/awareness";
import * as awarenessProtocol from "y-protocols/awareness";

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

  // In-memory rooms
  const docs = new Map<string, Y.Doc>();
  const awarenessMap = new Map<string, Awareness>();
  const connections = new Map<string, Set<WebSocket>>();

  const MessageSync = 0;
  const MessageAwareness = 1;

  function getRoom(room: string) {
    let doc = docs.get(room);
    if (!doc) {
      doc = new Y.Doc();
      docs.set(room, doc);
      // Broadcast CRDT updates to all clients in this room
      doc.on("update", (update: Uint8Array, origin: any) => {
        const conns = connections.get(room);
        if (!conns || conns.size === 0) return;
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MessageSync);
        syncProtocol.writeUpdate(enc, update);
        const msg = encoding.toUint8Array(enc);
        for (const c of conns) {
          if (c.readyState === c.OPEN && c !== origin) {
            try { c.send(msg); } catch {}
          }
        }
      });
    }
    let awareness = awarenessMap.get(room);
    if (!awareness) {
      awareness = new Awareness(doc);
      awarenessMap.set(room, awareness);
    }
    let conns = connections.get(room);
    if (!conns) {
      conns = new Set();
      connections.set(room, conns);
    }
    return { doc, awareness, conns };
  }

  function sendReply(ws: WebSocket, encoder: encoding.Encoder) {
    try { ws.send(encoding.toUint8Array(encoder)); } catch {}
  }

  function broadcastAwareness(room: string, except?: WebSocket) {
    const { awareness, conns } = getRoom(room);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MessageAwareness);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(awareness.getStates().keys())));
    const msg = encoding.toUint8Array(enc);
    for (const c of conns) {
      if (c !== except && c.readyState === c.OPEN) {
        try { c.send(msg); } catch {}
      }
    }
  }

  server.on("upgrade", (request, socket, head) => {
    // Accept all upgrades on this port; y-websocket utils will parse request.url for room name
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    // Optionally strip a base path from URL so that '/yws/room' becomes '/room'
    if (basePath && url.pathname.startsWith(basePath + "/")) {
      (request as any).url = url.pathname.slice(basePath.length); // keep leading '/'
    }
    wss.handleUpgrade(request as any, socket as any, head, (ws: WebSocket) => {
      const pathname = (request as any).url as string;
      const room = (pathname || "/").split("/").filter(Boolean)[0] || "default";
      const { doc, awareness, conns } = getRoom(room);
      conns.add(ws);

      // On connect: send Sync Step 1 and current awareness states
      {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MessageSync);
        syncProtocol.writeSyncStep1(enc, doc);
        sendReply(ws, enc);
      }
      {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MessageAwareness);
        encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(awareness.getStates().keys())));
        sendReply(ws, enc);
      }

      const pingInterval = setInterval(() => {
        try { ws.ping(); } catch {}
      }, 30000);

      ws.on("close", () => {
        clearInterval(pingInterval);
        conns.delete(ws);
        // Remove awareness for closed client
        try {
          const states = awareness.getStates();
          // find client ids associated with this ws via meta
          const toRemove: number[] = [];
          states.forEach((v, k) => { if ((v as any)?._ws === ws) toRemove.push(k); });
          if (toRemove.length) {
            awarenessProtocol.removeAwarenessStates(awareness, toRemove, ws);
            broadcastAwareness(room);
          }
        } catch {}
      });

      ws.on("message", (data: any) => {
        try {
          const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
          const decoder = decoding.createDecoder(u8);
          const type = decoding.readVarUint(decoder);
          if (type === MessageSync) {
            const enc = encoding.createEncoder();
            encoding.writeVarUint(enc, MessageSync);
            syncProtocol.readSyncMessage(decoder, enc, doc, ws);
            sendReply(ws, enc);
          } else if (type === MessageAwareness) {
            const update = decoding.readVarUint8Array(decoder);
            awarenessProtocol.applyAwarenessUpdate(awareness, update, ws);
            // mark ws on states so we can remove on close
            try {
              const states = awareness.getStates();
              states.forEach((v) => { (v as any)._ws = ws; });
            } catch {}
            broadcastAwareness(room, ws);
          }
        } catch {}
      });
    });
  });

  server.listen(port, () => {
    console.log(`[yws] y-websocket listening on ws://localhost:${port}${basePath || ""}/:room`);
  });

  return server;
}
