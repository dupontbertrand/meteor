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
  });

  afterEach(() => {
    // Exception-safe: an inline `delete` after the assertions would be
    // skipped if an expect() throws, leaking the value into process.env for
    // the rest of the Jest worker (resetModules doesn't reset env vars).
    delete process.env.METEOR_TEST_WORKER_TIMEOUT_SECS;
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
});
