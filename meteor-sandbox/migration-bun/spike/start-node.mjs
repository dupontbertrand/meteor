#!/usr/bin/env node
// Start a Meteor bundle via ESM loader on Node.js
//
// Usage:
//   MONGO_URL=mongodb://localhost:27017/myapp ROOT_URL=http://localhost:3000 PORT=3000 \
//     node start-node.mjs /path/to/bundle/programs/server

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from './esm-loader.mjs';

const bundlePath = process.argv[2];
if (!bundlePath) {
  console.error('Usage: node start-node.mjs <path-to-bundle/programs/server>');
  process.exit(1);
}

const serverDir = path.resolve(bundlePath);
console.log(`[ESM] Booting Meteor on Node.js from ${serverDir}`);
await boot(serverDir);
console.log(`[ESM] Meteor running on port ${process.env.PORT || 3000}`);
