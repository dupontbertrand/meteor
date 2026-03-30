#!/usr/bin/env bun
// Start a Meteor bundle via ESM loader on Bun with native WebSocket DDP
//
// Architecture:
//   Meteor (webapp/Express) listens on PORT via http.createServer
//   Bun.serve() listens on BUN_PORT (PORT+1):
//     - HTTP requests → proxied to webapp on PORT
//     - WebSocket → bridged to Meteor's StreamServer for DDP
//
// Usage:
//   MONGO_URL=mongodb://localhost:27017/myapp ROOT_URL=http://localhost:3001 PORT=3000 \
//     bun start-bun.mjs /path/to/bundle/programs/server

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { boot } from './esm-loader.mjs';

const bundlePath = process.argv[2];
if (!bundlePath) {
  console.error('Usage: bun start-bun.mjs <path-to-bundle/programs/server>');
  process.exit(1);
}

const serverDir = path.resolve(bundlePath);
console.log(`[ESM] Booting Meteor on Bun from ${serverDir}`);
await boot(serverDir);

// ============================================================
// Bun.serve() — native WebSocket bridge for DDP
//
// Bun's http.createServer does not support the 'upgrade' event
// that SockJS/ws use for WebSocket. Bun.serve() has native
// WebSocket support, so we use it as a frontend that proxies
// HTTP to webapp and bridges WebSocket to Meteor's DDP server.
// ============================================================

const METEOR_PORT = parseInt(process.env.PORT || '3000');
const BUN_PORT = METEOR_PORT + 1;
const streamServer = Package.meteor.Meteor.server.stream_server;

const bunServer = Bun.serve({
  port: BUN_PORT,

  async fetch(req, server) {
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const ok = server.upgrade(req);
      return ok ? undefined : new Response('WebSocket upgrade failed', { status: 400 });
    }

    // Proxy HTTP to Meteor webapp
    const url = new URL(req.url);
    url.port = String(METEOR_PORT);
    try {
      return await fetch(url.toString(), {
        method: req.method,
        headers: req.headers,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      });
    } catch (e) {
      return new Response('Proxy error: ' + e.message, { status: 502 });
    }
  },

  websocket: {
    open(ws) {
      // Create a socket compatible with Meteor's StreamServer interface
      // (EventEmitter with .send/.write/.on('data')/.on('close'))
      const socket = new EventEmitter();
      socket.send = (data) => { try { ws.send(data); } catch (e) {} };
      socket.write = socket.send;
      socket.close = () => ws.close();
      socket.remoteAddress = 'bun-ws';
      socket.headers = {};
      socket._meteorSession = null;
      socket.setWebsocketTimeout = () => {};

      ws._socket = socket;

      streamServer.open_sockets.push(socket);
      streamServer.registration_callbacks.forEach(cb => cb(socket));
    },

    message(ws, message) {
      const data = typeof message === 'string' ? message : new TextDecoder().decode(message);
      ws._socket.emit('data', data);
    },

    close(ws) {
      if (ws._socket) {
        streamServer.open_sockets = streamServer.open_sockets.filter(s => s !== ws._socket);
        ws._socket.emit('close');
      }
    },
  },
});

console.log(`[ESM] Meteor running on Bun`);
console.log(`[ESM]   HTTP (webapp): port ${METEOR_PORT}`);
console.log(`[ESM]   HTTP+WS (Bun.serve): port ${BUN_PORT} ← connect clients here`);
