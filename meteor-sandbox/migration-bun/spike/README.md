# ESM Bundle Spike — Running Meteor on Node & Bun via ESM imports

Proof of concept: a standard Meteor server bundle (`meteor build --directory`) boots via ESM `import()` instead of the legacy `boot.js` + `runtime.js` + `vm.runInThisContext` chain.

## What this proves

- A Meteor server bundle **is importable via ESM** without any source code changes
- **67 packages** load and register correctly on both Node.js and Bun
- HTTP, DDP (WebSocket), and MongoDB work on both runtimes
- `boot.js` (510 lines) + `runtime.js` (152 lines) + `npm-require.js` (~200 lines) are replaced by `esm-loader.mjs` (~100 lines)

## What this does NOT prove

- Production readiness (no long-running tests, no load testing)
- That the proxy architecture (Bun.serve → webapp) is the right final design
- That the virtual path resolver is complete for all edge cases
- That accounts, publications with data, or complex apps work (only tested with `--full` skeleton)

## Quick start

### 1. Build a Meteor app

```bash
meteor create --full my-app
cd my-app
meteor build ../my-output --directory
cd ../my-output/bundle/programs/server
npm install
```

### 2. Install the DDP test client dependency

```bash
cd /path/to/this/spike/directory
npm install ws
```

### 3. Start MongoDB

```bash
mongod --dbpath /tmp/mongo-esm --port 27017 --fork --logpath /tmp/mongod.log
```

### 4. Run on Node.js

```bash
MONGO_URL=mongodb://localhost:27017/my-app \
ROOT_URL=http://localhost:3000 \
PORT=3000 \
node start-node.mjs /path/to/my-output/bundle/programs/server
```

### 5. Run on Bun

```bash
MONGO_URL=mongodb://localhost:27017/my-app \
ROOT_URL=http://localhost:3001 \
PORT=3000 \
bun start-bun.mjs /path/to/my-output/bundle/programs/server
# HTTP+WS available on port 3001 (Bun.serve proxy)
# webapp internal on port 3000
```

### 6. Run full validation

```bash
./run.sh /path/to/my-output/bundle/programs/server test
```

## Files

| File | Purpose |
|---|---|
| `esm-loader.mjs` | Core ESM loader — replaces boot.js/runtime.js/npm-require.js |
| `start-node.mjs` | Node.js entrypoint |
| `start-bun.mjs` | Bun entrypoint with Bun.serve() WebSocket bridge |
| `ddp-test.mjs` | DDP smoke test client (handshake + method + subscription) |
| `run.sh` | Orchestration script (start, test, validate) |

## Architecture

### Node path

```
node start-node.mjs
  └── esm-loader.mjs
        ├── Setup globals (__meteor_bootstrap__, Npm, Assets, etc.)
        ├── import() each package in program.json order
        ├── core-runtime.queue() executes packages sequentially
        ├── Run startup hooks
        └── Run main() → webapp listens on PORT
```

### Bun path

```
bun start-bun.mjs
  └── esm-loader.mjs (same as Node)
        └── webapp listens on PORT (http.createServer, no WS)
  └── Bun.serve() on PORT+1
        ├── HTTP → proxy to webapp on PORT
        └── WebSocket → EventEmitter bridge to Meteor StreamServer
              └── DDP protocol handled by livedata_server.js
```

Why the proxy? Bun's `http.createServer` does not support the `upgrade` event that SockJS/ws use for WebSocket. `Bun.serve()` has native WebSocket support, so it acts as a frontend.

## Known limitations

1. **Bun strict mode**: Meteor's bundler generates implicit global assignments (`Mongo = Package.mongo.Mongo`). The loader pre-declares these on `globalThis` before imports.

2. **Virtual path resolver**: `meteorInstall` uses virtual paths (`/node_modules/meteor/X/node_modules/Y`). The resolver maps these to disk paths via `program.json`. Edge cases may exist.

3. **Assets API**: Currently stubbed. Apps using `Assets.getText()` / `Assets.getBinary()` with real private files need the full implementation.

4. **Profile**: Boot profiling is a no-op. Does not affect functionality.

5. **Bun WebSocket**: Uses a proxy pattern (Bun.serve on PORT+1). The destination design would have Bun.serve as the primary server, not a proxy.

## Results

| | Node (ESM) | Bun (ESM + Bun.serve) |
|---|---|---|
| Package import | 67/67 ✅ | 67/67 ✅ |
| HTTP 200 | ✅ | ✅ |
| DDP handshake | ✅ | ✅ |
| DDP method call | ✅ | ✅ |
| DDP subscription | ✅ | ✅ |
| MongoDB | ✅ | ✅ |
