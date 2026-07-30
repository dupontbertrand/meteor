// run-test-workers.js pulls in AppProcess (run-app.js) and runLog.
// For testing workerMongoUrl alone, stub these out.
jest.mock('../fs/files', () => ({}));
jest.mock('../fs/watch', () => ({}));
jest.mock('../isobuild/bundler.js', () => ({}));
jest.mock('../utils/buildmessage.js', () => ({}));
jest.mock('./run-log.js', () => ({}));
jest.mock('../meteor-services/stats.js', () => ({}));
jest.mock('../console/console.js', () => ({ Console: {} }));
jest.mock('../packaging/catalog/catalog.js', () => ({}));
jest.mock('../tool-env/profile', () => ({ Profile: {} }));
jest.mock('../packaging/release.js', () => ({}));
jest.mock('../cordova/index.js', () => ({ pluginVersionsFromStarManifest: () => {} }));
jest.mock('../fs/safe-watcher', () => ({ closeAllWatchers: () => {} }));
jest.mock('../tool-env/isopackets.js', () => ({ loadIsopackage: () => {} }));
jest.mock('../utils/eachline', () => ({ eachline: () => {} }));
jest.mock('../utils/utils.js', () => ({ randomPort: () => 3100 }));

const { workerMongoUrl } = require('./run-test-workers.js');

describe('workerMongoUrl', () => {
  test('replaces the db segment of the dev-server url', () => {
    expect(workerMongoUrl('mongodb://127.0.0.1:3001/meteor', 0))
      .toBe('mongodb://127.0.0.1:3001/meteor_w0');
    expect(workerMongoUrl('mongodb://127.0.0.1:3001/meteor', 3))
      .toBe('mongodb://127.0.0.1:3001/meteor_w3');
  });

  test('preserves query params (external MONGO_URL)', () => {
    expect(workerMongoUrl('mongodb://db.example.com:27017/app?replicaSet=rs0&tls=true', 1))
      .toBe('mongodb://db.example.com:27017/app_w1?replicaSet=rs0&tls=true');
  });

  test('defaults the db name when the url has none', () => {
    expect(workerMongoUrl('mongodb://127.0.0.1:3001', 2))
      .toBe('mongodb://127.0.0.1:3001/meteor_w2');
    expect(workerMongoUrl('mongodb://127.0.0.1:3001/', 2))
      .toBe('mongodb://127.0.0.1:3001/meteor_w2');
  });

  test('keeps multi-host urls intact', () => {
    expect(workerMongoUrl('mongodb://a:1,b:2,c:3/meteor', 1))
      .toBe('mongodb://a:1,b:2,c:3/meteor_w1');
  });

  test('rejects urls it cannot parse', () => {
    expect(() => workerMongoUrl('no-mongo-server', 0)).toThrow(/parallel workers/);
  });
});

describe('runTestWorkers (mocked workers)', () => {
  // AppProcess mock: behavior-parameterized via `mockBehavior`, so individual
  // tests can simulate a worker that never exits, never spawns, etc. The
  // default (set fresh each beforeEach) reproduces the original inline mock:
  // "spawns" a worker that immediately emits its result line through
  // onOutput and exits via onExit — no real meteor involved.
  let spawnedOptions;
  let loadIsopackageCalls;
  let mockBehavior;
  let mongoRunnersStarted;
  let mongoRunnersStopped;

  beforeEach(() => {
    jest.resetModules();
    spawnedOptions = [];
    loadIsopackageCalls = 0;
    mockBehavior = async (options) => {
      const i = options.testMetadata.shard.index;
      await options.onOutput(
        `TEST_IN_NODE_RESULT {"tests":2,"passed":${i === 0 ? 2 : 1},"failed":${i === 0 ? 0 : 1},"skipped":0,"todo":0}`,
        false,
      );
      options.onExit(i === 0 ? 0 : 1, null);
    };
    jest.doMock('./run-app.js', () => ({
      AppProcess: class {
        constructor(options) { this.options = options; spawnedOptions.push(options); }
        async start() { return mockBehavior(this.options); }
      },
    }));
    jest.doMock('./run-log.js', () => ({ log: jest.fn(), logAppOutput: jest.fn() }));
    jest.doMock('../tool-env/isopackets.js', () => ({
      loadIsopackage: jest.fn(() => { loadIsopackageCalls++; throw new Error('should not be called for no-mongo'); }),
    }));
    mongoRunnersStarted = [];
    mongoRunnersStopped = 0;
    jest.doMock('./run-mongo.js', () => ({
      MongoRunner: class {
        constructor(opts) { this.opts = opts; mongoRunnersStarted.push(opts); }
        async start() {}
        mongoUrl() { return `mock://w${mongoRunnersStarted.indexOf(this.opts)}/meteor`; }
        oplogUrl() { return null; }
        async stop() { mongoRunnersStopped++; }
      },
    }));
  });

  afterEach(() => {
    // Exception-safe: an inline `delete` after the assertions would be
    // skipped if an expect() throws, leaking the value into process.env for
    // the rest of the Jest worker (resetModules doesn't reset env vars).
    delete process.env.METEOR_TEST_WORKER_TIMEOUT_SECS;
    delete process.env.METEOR_TEST_MONGO_PER_WORKER;
  });

  test('no-mongo sentinel skips db work and aggregates a failing worker to exit 1', async () => {
    const { runTestWorkers } = require('./run-test-workers.js');
    const { exitCode, workers } = await runTestWorkers({
      projectContext: {}, bundlePath: '/x', mongoUrl: 'no-mongo-server',
      rootUrl: 'http://localhost/', listenHost: undefined, settings: null,
      testMetadata: { driverPackage: 'test-in-node' }, nodeOptions: [], workerCount: 2,
    });
    expect(exitCode).toBe(1);                       // one worker failed
    expect(loadIsopackageCalls).toBe(0);            // dropWorkerDatabases skipped
    expect(spawnedOptions[0].mongoUrl).toBe('no-mongo-server'); // sentinel passed through
    expect(spawnedOptions[1].testMetadata.shard).toEqual({ index: 1, total: 2 });
    expect(workers[0].result.passed).toBe(2);
    expect(workers[1].code).toBe(1);
  });

  test('a worker that never exits is timed out to 255', async () => {
    process.env.METEOR_TEST_WORKER_TIMEOUT_SECS = '0.05'; // 50ms, module reloaded per resetModules
    mockBehavior = async () => { /* spawn "succeeds" but nothing ever happens: no result, no onExit */ };
    const { runTestWorkers } = require('./run-test-workers.js');
    const { exitCode, workers } = await runTestWorkers({
      projectContext: {}, bundlePath: '/x', mongoUrl: 'no-mongo-server',
      rootUrl: 'http://localhost/', listenHost: undefined, settings: null,
      testMetadata: {}, nodeOptions: [], workerCount: 1,
    });
    expect(exitCode).toBe(255);
    expect(workers[0].signal).toBe('TIMEOUT');
  });

  test('a worker that exits 0 without a result line yields exit 1', async () => {
    mockBehavior = async (options) => { options.onExit(0, null); };
    const { runTestWorkers } = require('./run-test-workers.js');
    const { exitCode, workers } = await runTestWorkers({
      projectContext: {}, bundlePath: '/x', mongoUrl: 'no-mongo-server',
      rootUrl: 'http://localhost/', listenHost: undefined, settings: null,
      testMetadata: {}, nodeOptions: [], workerCount: 1,
    });
    expect(exitCode).toBe(1);
    expect(workers[0].result).toBeNull();
  });

  test('a start() that hangs forever is still resolved by the timeout', async () => {
    process.env.METEOR_TEST_WORKER_TIMEOUT_SECS = '0.05';
    mockBehavior = () => new Promise(() => {}); // start() never settles, proc.proc never exists
    const { runTestWorkers } = require('./run-test-workers.js');
    const { exitCode } = await runTestWorkers({
      projectContext: {}, bundlePath: '/x', mongoUrl: 'no-mongo-server',
      rootUrl: 'http://localhost/', listenHost: undefined, settings: null,
      testMetadata: {}, nodeOptions: [], workerCount: 1,
    });
    expect(exitCode).toBe(255);
  }, 10000);

  test('METEOR_TEST_MONGO_PER_WORKER spawns one MongoRunner per worker and stops them', async () => {
    process.env.METEOR_TEST_MONGO_PER_WORKER = '1';
    // Override the default mockBehavior (which fails worker index >= 1 on
    // purpose, for the sentinel/aggregation test above): this test asserts a
    // clean exitCode 0 so it needs both workers to succeed.
    mockBehavior = async (options) => {
      await options.onOutput(
        'TEST_IN_NODE_RESULT {"tests":1,"passed":1,"failed":0,"skipped":0,"todo":0}',
        false,
      );
      options.onExit(0, null);
    };
    const { runTestWorkers } = require('./run-test-workers.js');
    const { exitCode } = await runTestWorkers({
      projectContext: { getProjectLocalDirectory: (s) => `/fake/local/${s}` },
      bundlePath: '/x', mongoUrl: 'mongodb://127.0.0.1:4301/meteor',
      rootUrl: 'http://localhost/', listenHost: undefined, settings: null,
      testMetadata: {}, nodeOptions: [], workerCount: 2,
    });
    expect(exitCode).toBe(0);
    expect(mongoRunnersStarted).toHaveLength(2);              // one per worker
    expect(mongoRunnersStarted[0].projectLocalDir).toMatch(/test-worker-dbs\/w0$/);
    expect(new Set(mongoRunnersStarted.map(r => r.port)).size).toBe(2); // distinct ports
    expect(spawnedOptions[0].mongoUrl).toBe('mock://w0/meteor'); // runner's own URL, not the shared _w0
    expect(mongoRunnersStopped).toBe(2);                      // torn down in finally
    delete process.env.METEOR_TEST_MONGO_PER_WORKER;
  });

  test('per-worker mongod is ignored under the no-mongo sentinel', async () => {
    process.env.METEOR_TEST_MONGO_PER_WORKER = '1';
    const { runTestWorkers } = require('./run-test-workers.js');
    await runTestWorkers({
      projectContext: {}, bundlePath: '/x', mongoUrl: 'no-mongo-server',
      rootUrl: 'http://localhost/', listenHost: undefined, settings: null,
      testMetadata: {}, nodeOptions: [], workerCount: 2,
    });
    expect(mongoRunnersStarted).toHaveLength(0);
    delete process.env.METEOR_TEST_MONGO_PER_WORKER;
  });
});
