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
