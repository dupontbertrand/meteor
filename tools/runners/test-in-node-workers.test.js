const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPORTER = path.resolve(__dirname, 'test-in-node-reporter.mjs');
const DRIVER = path.resolve(__dirname, '../../packages/test-in-node/driver.js');

function runFixture(name, extraEnv = {}) {
  const res = spawnSync(
    process.execPath,
    [`--test-reporter=${REPORTER}`,
     path.resolve(__dirname, '__fixtures__', 'test-in-node', name)],
    {
      env: { ...process.env, TIN_DRIVER_PATH: DRIVER, ...extraEnv },
      encoding: 'utf8',
      timeout: 8000,
    },
  );
  const m = res.stdout.match(/^TEST_IN_NODE_RESULT (.*)$/m);
  return { status: res.status, stdout: res.stdout, result: m ? JSON.parse(m[1]) : null };
}

describe('test-in-node driver contract', () => {
  test('passing run emits machine result and exits 0', () => {
    const r = runFixture('keepalive-tests.cjs');
    expect(r.status).toBe(0);
    expect(r.result).toMatchObject({ tests: 5, passed: 5, failed: 0, skipped: 0, todo: 0 });
  });

  test('failing run exits 1 and counts the failure', () => {
    const r = runFixture('keepalive-tests.cjs', { FIXTURE_FAIL: '1' });
    expect(r.status).toBe(1);
    expect(r.result).toMatchObject({ tests: 5, passed: 4, failed: 1 });
  });
});
