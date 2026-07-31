// Stage 1 of the test-runner platform (#12162): opt-in parallel test workers.
// The app is built ONCE by the normal AppRunner path; this module then spawns
// N AppProcess children from that same bundle — each with its own port, its
// own Mongo database (meteor_w<i> on the shared dev mongod) and a shard
// descriptor — and aggregates their exit codes and TEST_IN_NODE_RESULT lines.
// It is only reached behind --parallel-workers; the single-run path never
// touches this file.

const { AppProcess } = require('./run-app.js');
const runLog = require('./run-log.js');
const utils = require('../utils/utils.js');
const { loadIsopackage } = require('../tool-env/isopackets.js');
const files = require('../fs/files');

const RESULT_PREFIX = 'TEST_IN_NODE_RESULT ';
const TIMINGS_PREFIX = 'TEST_IN_NODE_TIMINGS ';
const TIMINGS_STATE_FILENAME = 'test-in-node-timings.json';
const MAX_INJECTED_TIMINGS_JSON_LENGTH = 50000;
const WORKER_TIMEOUT_MS =
  (+process.env.METEOR_TEST_WORKER_TIMEOUT_SECS || 900) * 1000;
const KILL_GRACE_MS = Math.min(5000, WORKER_TIMEOUT_MS);

function parseMongoUrl(url) {
  const m = /^(mongodb(?:\+srv)?:\/\/[^/]+)(?:\/([^?]*))?(\?.*)?$/.exec(url || '');
  if (!m) {
    throw new Error('MONGO_URL not supported with parallel workers: ' + url);
  }
  const db = (m[2] || '').replace(/\/+$/, '') || 'meteor';
  return { base: m[1], db, query: m[3] || '' };
}

function workerMongoUrl(baseUrl, index) {
  const { base, db, query } = parseMongoUrl(baseUrl);
  return `${base}/${db}_w${index}${query}`;
}

// Worker databases persist in the dev mongod between runs — drop them first so
// a previous parallel run's data never leaks into this one.
async function dropWorkerDatabases(baseUrl, count) {
  const { MongoClient } = (await loadIsopackage(
    'npm-mongo'
  )).NpmModuleMongodb;
  const client = new MongoClient(baseUrl);
  try {
    await client.connect();
    for (let i = 0; i < count; i++) {
      await client.db(parseMongoUrl(workerMongoUrl(baseUrl, i)).db).dropDatabase();
    }
  } finally {
    await client.close();
  }
}

async function runTestWorkers(options) {
  const {
    projectContext, bundlePath, mongoUrl, listenHost,
    settings, testMetadata, nodeOptions, workerCount,
  } = options;

  // Packages that don't depend on `mongo-dev-server` never get a real Mongo
  // (run-all.js sets the 'no-mongo-server' sentinel instead of starting one).
  // There's nothing to shard or drop in that case — pass the sentinel through
  // to every worker unchanged, mirroring the single-process path.
  const hasMongo = !!mongoUrl && mongoUrl !== 'no-mongo-server';

  const mongoPerWorker = hasMongo && process.env.METEOR_TEST_MONGO_PER_WORKER === '1';
  let workerMongoRunners = [];

  if (mongoPerWorker) {
    // Experimental: one dedicated mongod per worker (RFC §6 fallback). Removes
    // shared-mongod contention at the cost of N mongod boots + N replSet inits.
    // The dev mongod started by run-all keeps running, unused by the workers.
    // dbPath ends in /db on purpose: findMongoPids (run-mongo.js:241) only
    // recognizes such paths, and each runner gets its own port + dbPath so
    // its startup findMongoAndKillItDead cannot touch the shared mongod.
    const { MongoRunner } = require('./run-mongo.js');
    const baseDir = projectContext.getProjectLocalDirectory('test-worker-dbs');
    const mongoBasePort = utils.randomPort();
    workerMongoRunners = Array.from({ length: workerCount }, (_, i) => new MongoRunner({
      projectLocalDir: `${baseDir}/w${i}`,
      port: mongoBasePort + i,
      onFailure: () => {},
    }));
    await Promise.all(workerMongoRunners.map((r) => r.start()));
  } else if (hasMongo) {
    try {
      await dropWorkerDatabases(mongoUrl, workerCount);
    } catch (err) {
      runLog.log(
        `test-in-node: could not drop worker databases (${err.message}) — continuing; stale data may leak between runs.`
      );
    }
  }

  // Duration-aware sharding (LPT, packages/test-in-node/driver.js): read back
  // the per-unit timings persisted by the previous parallel run, if any. A
  // missing/corrupt/foreign-shaped file is treated as absent — round-robin
  // sharding is always a safe fallback, never a hard failure.
  const timingsStatePath = files.pathJoin(projectContext.projectLocalDir, TIMINGS_STATE_FILENAME);
  const filterActive = !!process.env.TINYTEST_FILTER;
  let savedTimings = null;
  // --filter runs see (and would persist) only a subset of units: injecting full-map timings would
  // concentrate the survivors onto one bucket, and persisting the subset would clobber the full-suite
  // map. Skip both.
  if (!filterActive) {
    try {
      const parsed = JSON.parse(files.readFile(timingsStatePath, 'utf8'));
      if (parsed && parsed.version === 1 && parsed.timings && typeof parsed.timings === 'object') {
        savedTimings = parsed.timings;
      }
    } catch (err) { /* no state file yet, or unreadable/invalid — round-robin fallback */ }
  }

  // Bound the payload re-injected into every worker's TEST_METADATA env var:
  // an unbounded timings map would grow with the suite forever and eventually
  // blow past OS argv/env size limits.
  let timingsToInject = null;
  if (savedTimings) {
    const serialized = JSON.stringify(savedTimings);
    if (serialized.length <= MAX_INJECTED_TIMINGS_JSON_LENGTH) {
      timingsToInject = savedTimings;
    } else {
      runLog.log(`test-in-node: timings map too large (${serialized.length} bytes) — falling back to round-robin sharding.`);
    }
  }

  // Deterministic ports: one random base, then +i — N independent random draws
  // would just multiply birthday collisions. A busy port most likely fails the
  // worker (exit != 0) with no retry — rare in the 20000-29999 range, and it
  // fails loudly; the timeout below is the backstop.
  const basePort = utils.randomPort();

  const collectedTimings = {};
  const workers = [];
  const runs = [];
  for (let i = 0; i < workerCount; i++) {
    const worker = { index: i, code: null, signal: null, result: null, durationMs: null };
    workers.push(worker);
    runs.push(new Promise((resolve) => {
      let timer;
      const startedAt = Date.now();
      const proc = new AppProcess({
        projectContext,
        bundlePath,
        port: basePort + i,
        listenHost,
        // Workers listen on their own ports without the proxy in front of
        // them; self-connecting tests (DDP.connect(Meteor.absoluteUrl()))
        // must reach their own server — the shared proxy rootUrl would
        // point at a port no worker actually serves in parallel mode.
        rootUrl: `http://${listenHost || 'localhost'}:${basePort + i}/`,
        mongoUrl: mongoPerWorker
          ? workerMongoRunners[i].mongoUrl()
          : (hasMongo ? workerMongoUrl(mongoUrl, i) : mongoUrl),
        oplogUrl: null, // no per-worker oplog tailing; reactivity probes the server
        settings,
        nodeOptions,
        testMetadata: {
          ...testMetadata,
          shard: { index: i, total: workerCount },
          ...(timingsToInject ? { timings: timingsToInject } : {}),
        },
        isTestWorker: true,
        onOutput: async (line, isStderr) => {
          if (!isStderr && line.startsWith(RESULT_PREFIX)) {
            try { worker.result = JSON.parse(line.slice(RESULT_PREFIX.length)); }
            catch (err) { /* malformed line — leave result null, code decides */ }
            return;
          }
          if (!isStderr && line.startsWith(TIMINGS_PREFIX)) {
            try { Object.assign(collectedTimings, JSON.parse(line.slice(TIMINGS_PREFIX.length))); }
            catch (err) { /* malformed line — this worker's units just miss next run's timings */ }
            return;
          }
          await runLog.logAppOutput(`[w${i}] ${line}`, isStderr);
        },
        onListen: () => {},
        onExit: (code, signal) => {
          clearTimeout(timer);
          worker.durationMs = Date.now() - startedAt;
          worker.code = code;
          worker.signal = signal || null;
          resolve();
        },
      });
      timer = setTimeout(() => {
        worker.signal = worker.signal || 'TIMEOUT';
        try { proc.proc && proc.proc.kill('SIGKILL'); } catch (err) { /* already gone */ }
        // If the child never spawned (start() wedged pre-spawn) or the kill
        // cannot be delivered, onExit never fires — resolve after a short
        // grace so the backstop itself can never hang the run.
        const grace = setTimeout(() => {
          if (worker.durationMs == null) worker.durationMs = Date.now() - startedAt;
          resolve();
        }, KILL_GRACE_MS);
        grace.unref();
      }, WORKER_TIMEOUT_MS);
      timer.unref();
      proc.start().catch((err) => {
        clearTimeout(timer);
        // Pre-spawn failure (post-spawn errors already flow through onExit).
        runLog.log(`[w${i}] failed to start: ${err.message}`, { arrow: false });
        worker.code = worker.code === null ? 1 : worker.code;
        if (worker.durationMs == null) worker.durationMs = Date.now() - startedAt;
        resolve();
      });
    }));
  }

  try {
    await Promise.all(runs);

    // Persist this run's merged timings for the next parallel run's LPT
    // sharding. Best-effort: a write failure here must never fail the test
    // run itself — it only means the next run falls back to round-robin.
    if (!filterActive && Object.keys(collectedTimings).length > 0) {
      try {
        await files.writeFileAtomically(timingsStatePath, JSON.stringify({ version: 1, timings: collectedTimings }));
      } catch (err) {
        runLog.log(`test-in-node: could not persist timings (${err.message}) — next run will use round-robin sharding.`);
      }
    }

    // Combined report (per-worker lines were already streamed with [wN] prefixes).
    const totals = { tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };
    let failedWorkers = 0;
    for (const w of workers) {
      if (w.result) {
        for (const k of Object.keys(totals)) totals[k] += w.result[k] || 0;
      }
      const ok = w.code === 0 && !w.signal;
      if (!ok) failedWorkers++;
      runLog.log(
        `  w${w.index}  ` +
        (w.result
          ? `${w.result.passed} passed${w.result.failed ? `, ${w.result.failed} failed` : ''} (${w.result.tests} tests)`
          : 'no result') +
        `  exit ${w.signal ? w.signal : w.code}` +
        (w.durationMs != null ? ` [${(w.durationMs / 1000).toFixed(1)}s]` : ''),
        { arrow: false },
      );
    }
    runLog.log(
      `test-in-node · ${workerCount} workers — ` +
      `${totals.passed} passed, ${totals.failed} failed, ` +
      `${totals.skipped} skipped, ${totals.todo} todo (${totals.tests} tests)` +
      (failedWorkers ? ` — ${failedWorkers} worker(s) failed` : ''),
      { arrow: true },
    );

    // Exit-code contract, mirroring run-all.js:480-494 semantics:
    // any signal/timeout → 255; any non-zero (or missing result) → 1; else 0.
    let exitCode = 0;
    for (const w of workers) {
      if (w.signal) { exitCode = 255; break; }
      if (w.code !== 0 || !w.result) exitCode = 1;
    }
    return { exitCode, workers };
  } finally {
    // MongoRunner#stop (run-mongo.js:1038) is synchronous and does not return
    // a promise — wrap the call itself so a sync throw is caught the same way
    // as a rejected promise, instead of calling .catch() on its return value.
    await Promise.all(workerMongoRunners.map((r) =>
      Promise.resolve().then(() => r.stop()).catch(() => {})
    ));
  }
}

exports.workerMongoUrl = workerMongoUrl;
exports.runTestWorkers = runTestWorkers;
