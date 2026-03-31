// ESM Loader for Meteor server bundles
//
// Replaces boot.js (510 lines) + runtime.js (152 lines) + npm-require.js (~200 lines)
// with ~100 lines of standard ESM code.
//
// Usage:
//   import { boot } from './esm-loader.mjs';
//   await boot('/path/to/bundle/programs/server');

import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================
// Resolver — maps meteorInstall virtual paths to real disk paths
// ============================================================

function createResolver(serverDir, programJson) {
  const require = createRequire(path.join(serverDir, '_virtual.js'));

  // Build map: package path → list of node_modules dirs on disk
  const packageNodeModulesMap = {};
  for (const item of programJson.load) {
    const dirs = [];
    if (typeof item.node_modules === 'string') {
      dirs.push(path.join(serverDir, item.node_modules));
    } else if (item.node_modules && typeof item.node_modules === 'object') {
      for (const p of Object.keys(item.node_modules)) {
        if (!item.node_modules[p].local) dirs.push(path.join(serverDir, p));
      }
    }
    dirs.push(path.join(serverDir, 'node_modules'));
    packageNodeModulesMap[item.path] = dirs;
  }

  let currentPackagePath = null;

  function resolveInDirs(name, dirs) {
    for (const dir of dirs) {
      try {
        return createRequire(path.join(dir, '_v.js')).resolve(name);
      } catch (e) { continue; }
    }
    return null;
  }

  function getDirs() {
    return currentPackagePath
      ? (packageNodeModulesMap[currentPackagePath] || [path.join(serverDir, 'node_modules')])
      : [path.join(serverDir, 'node_modules')];
  }

  // Main resolver — replaces npmRequire from boot.js
  function meteorNpmRequire(name, error) {
    const dirs = getDirs();

    // Virtual absolute paths: /node_modules/meteor/X/node_modules/Y
    if (name.startsWith('/node_modules/')) {
      const parts = name.split('/node_modules/');
      const lastPart = parts[parts.length - 1];
      const resolved = resolveInDirs(lastPart, dirs);
      if (resolved) return require(resolved);
      const diskPath = path.join(serverDir, 'npm' + name);
      if (fs.existsSync(diskPath)) return require(diskPath);
    }

    // Normal module names (express, denque, mongodb, etc.)
    const resolved = resolveInDirs(name, dirs);
    if (resolved) return require(resolved);

    // Node builtins
    try { return require(name); } catch (e) {}

    throw error || new Error('Cannot find module ' + JSON.stringify(name));
  }

  meteorNpmRequire.resolve = function (name) {
    const dirs = getDirs();
    if (name.startsWith('/node_modules/')) {
      const parts = name.split('/node_modules/');
      const lastPart = parts[parts.length - 1];
      const resolved = resolveInDirs(lastPart, dirs);
      if (resolved) return resolved;
      const diskPath = path.join(serverDir, 'npm' + name);
      if (fs.existsSync(diskPath)) return diskPath;
    }
    const resolved = resolveInDirs(name, dirs);
    if (resolved) return resolved;
    return require.resolve(name);
  };

  return { meteorNpmRequire, setCurrentPackage(p) { currentPackagePath = p; } };
}

// ============================================================
// Boot — loads all Meteor packages via ESM import
// ============================================================

export async function boot(serverDir) {
  const programJson = JSON.parse(fs.readFileSync(path.join(serverDir, 'program.json'), 'utf8'));
  const configJson = JSON.parse(fs.readFileSync(path.join(serverDir, 'config.json'), 'utf8'));
  const buildDir = path.dirname(path.dirname(serverDir));
  const starJson = JSON.parse(fs.readFileSync(path.join(buildDir, 'star.json'), 'utf8'));
  const programsDir = path.dirname(serverDir);

  const { meteorNpmRequire, setCurrentPackage } = createResolver(serverDir, programJson);

  // --- Setup globals (replaces boot.js:32-47) ---
  globalThis.__meteor_bootstrap__ = {
    startupHooks: [],
    serverDir,
    configJson,
    isFibersDisabled: true,
  };
  globalThis.__meteor_runtime_config__ = {
    meteorRelease: configJson.meteorRelease,
    gitCommitHash: starJson.gitCommitHash,
  };
  if (!process.env.APP_ID) process.env.APP_ID = configJson.appId;

  // Npm and Assets (replaces boot.js closure injection)
  globalThis.Npm = { require: meteorNpmRequire };
  globalThis.Assets = {
    getTextAsync() { return Promise.resolve(''); },
    getBinaryAsync() { return Promise.resolve(new Uint8Array()); },
    absoluteFilePath() { return ''; },
    getServerDir() { return serverDir; },
  };

  // Special args (replaces boot.js:197-222 specialArgPaths)
  globalThis.npmRequire = meteorNpmRequire;
  globalThis.Profile = function (name, fn) { return fn || function () {}; };
  globalThis.Profile.time = function (name, fn) { return fn(); };
  globalThis.Profile.run = async function (name, fn) { return fn(); };

  // AsyncLocalStorage (replaces boot.js:496-499)
  globalThis.__METEOR_ASYNC_LOCAL_STORAGE = new AsyncLocalStorage();

  // dynamicImportInfo (replaces boot.js:205-222 specialArgPaths for dynamic-import)
  globalThis.dynamicImportInfo = { server: { dynamicRoot: path.join(serverDir, 'dynamic') } };
  const clientArchs = configJson.clientArchs || Object.keys(configJson.clientPaths || {});
  clientArchs.forEach(arch => {
    globalThis.dynamicImportInfo[arch] = { dynamicRoot: path.join(programsDir, arch, 'dynamic') };
  });

  // --- Bun strict mode fix ---
  // Meteor bundler generates implicit global assignments (Mongo = Package.mongo.Mongo)
  // which are illegal in strict mode. Pre-declare them on globalThis.
  for (const dir of [path.join(serverDir, 'packages'), path.join(serverDir, 'app')]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const m of src.matchAll(/^(\w+)\s*=\s*Package/gm)) {
        if (!(m[1] in globalThis)) globalThis[m[1]] = undefined;
      }
    }
  }

  // --- Import all packages in dependency order ---
  for (const item of programJson.load) {
    setCurrentPackage(item.path);
    await import(path.join(serverDir, item.path));
  }

  // --- Wait for core-runtime async queue ---
  const ready = globalThis.Package['core-runtime'].waitUntilAllLoaded();
  if (ready) await ready;

  // --- Run startup hooks (replaces boot.js:448-457) ---
  while (globalThis.__meteor_bootstrap__.startupHooks.length) {
    await globalThis.__meteor_bootstrap__.startupHooks.shift()();
  }
  globalThis.__meteor_bootstrap__.startupHooks = null;

  // --- Run main() (replaces boot.js:459-493) ---
  const mains = [];
  if ('main' in globalThis) mains.push(globalThis.main);
  if (typeof Package !== 'undefined') {
    for (const name of Object.keys(Package)) {
      const { main } = Package[name];
      if (typeof main === 'function' && !mains.includes(main)) mains.push(main);
    }
  }

  if (mains.length === 1) {
    const exitCode = await mains[0].call({}, process.argv.slice(2));
    if (exitCode !== 'DAEMON') process.exit(exitCode);
  } else if (mains.length === 0) {
    console.error('No main() function found.');
    process.exit(1);
  }

  return { serverDir, programJson, configJson };
}
