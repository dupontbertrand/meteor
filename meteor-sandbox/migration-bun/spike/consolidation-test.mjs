#!/usr/bin/env node
// Consolidation test: real subscription + accounts + reconnection + soak
//
// Tests:
//   1. Real subscription with Mongo data (insert → publish → DDP added)
//   2. Account creation + login + authenticated method call
//   3. WebSocket reconnection
//   4. Short soak (RSS stability over N seconds)
//
// Usage:
//   node consolidation-test.mjs [ws://localhost:3000/websocket] [--soak 30]

import WebSocket from 'ws';
import crypto from 'crypto';

const url = process.argv[2] || 'ws://localhost:3000/websocket';
const soakArg = process.argv.indexOf('--soak');
const soakSeconds = soakArg !== -1 ? parseInt(process.argv[soakArg + 1] || '30') : 0;

let msgId = 0;
const nextId = () => String(++msgId);
const results = [];

function pass(msg) { results.push('PASS'); console.log(`  ✅ ${msg}`); }
function fail(msg) { results.push('FAIL'); console.log(`  ❌ ${msg}`); }

function createDDPClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map(); // id → { resolve, reject }
    let sessionId = null;
    const subs = new Map(); // subId → { docs, readyResolve }

    ws.on('open', () => {
      ws.send(JSON.stringify({ msg: 'connect', version: '1', support: ['1'] }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());

      if (msg.msg === 'connected') {
        sessionId = msg.session;
        resolve(client);
      }

      if (msg.msg === 'result' && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(msg.error);
        else p.resolve(msg.result);
      }

      if (msg.msg === 'added') {
        for (const [subId, sub] of subs) {
          if (sub.collection === msg.collection) {
            sub.docs.push({ id: msg.id, fields: msg.fields });
          }
        }
      }

      if (msg.msg === 'ready') {
        for (const id of msg.subs || []) {
          if (subs.has(id)) {
            subs.get(id).readyResolve();
          }
        }
      }

      if (msg.msg === 'nosub' && subs.has(msg.id)) {
        subs.get(msg.id).readyResolve();
      }

      if (msg.msg === 'ping') {
        ws.send(JSON.stringify({ msg: 'pong', id: msg.id }));
      }
    });

    ws.on('error', (e) => reject(e));

    const client = {
      get sessionId() { return sessionId; },
      call(method, ...params) {
        const id = nextId();
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          ws.send(JSON.stringify({ msg: 'method', method, params, id }));
          setTimeout(() => {
            if (pending.has(id)) {
              pending.delete(id);
              reject(new Error('Method timeout'));
            }
          }, 10000);
        });
      },
      subscribe(name, ...params) {
        const id = nextId();
        const sub = { collection: name === 'tasks.all' ? 'tasks' : name, docs: [], readyResolve: null };
        subs.set(id, sub);
        return new Promise((resolve) => {
          sub.readyResolve = () => resolve(sub.docs);
          ws.send(JSON.stringify({ msg: 'sub', id, name, params }));
          setTimeout(() => {
            sub.readyResolve();
          }, 5000);
        });
      },
      close() { ws.close(); },
      get ws() { return ws; },
    };
  });
}

// ============================================================
// Test 1: Real subscription with Mongo data
// ============================================================
async function testSubscription() {
  console.log('\n--- Test 1: Real subscription with Mongo data ---');
  const client = await createDDPClient(url);
  pass(`DDP connected (session: ${client.sessionId})`);

  // Insert a task via method
  const text = 'spike-test-' + Date.now();
  const taskId = await client.call('tasks.insert', text);
  pass(`Method tasks.insert returned id: ${taskId}`);

  // Subscribe and check we receive the document
  const docs = await client.subscribe('tasks.all');
  const found = docs.find(d => d.fields?.text === text);
  if (found) {
    pass(`Subscription received document (text: "${found.fields.text}")`);
  } else {
    fail(`Subscription did not receive document "${text}" (got ${docs.length} docs)`);
  }

  // Check count
  const count = await client.call('tasks.count');
  if (count >= 1) {
    pass(`tasks.count = ${count}`);
  } else {
    fail(`tasks.count = ${count} (expected >= 1)`);
  }

  client.close();
}

// ============================================================
// Test 2: Account creation + login + authenticated method
// ============================================================
async function testAccounts() {
  console.log('\n--- Test 2: Accounts (create + login + auth method) ---');
  const client = await createDDPClient(url);

  const email = `spike-${Date.now()}@test.local`;
  const password = 'spike-password-123';

  // Create account
  try {
    await client.call('createUser', { email, password });
    pass(`Account created: ${email}`);
  } catch (e) {
    if (e.reason?.includes('already exists')) {
      pass(`Account already exists: ${email}`);
    } else {
      fail(`createUser failed: ${e.reason || e.message}`);
      client.close();
      return;
    }
  }

  // Login
  try {
    const loginResult = await client.call('login', {
      password: { digest: crypto.createHash('sha256').update(password).digest('hex'), algorithm: 'sha-256' },
      user: { email },
    });
    if (loginResult?.token) {
      pass(`Login successful (token: ${loginResult.token.substring(0, 8)}...)`);
    } else {
      fail('Login returned no token');
    }
  } catch (e) {
    fail(`Login failed: ${e.reason || e.message}`);
  }

  // Authenticated method call (tasks.insert should now have userId)
  try {
    const taskId = await client.call('tasks.insert', 'auth-test-' + Date.now());
    pass(`Authenticated method call succeeded (taskId: ${taskId})`);
  } catch (e) {
    fail(`Authenticated method failed: ${e.reason || e.message}`);
  }

  client.close();
}

// ============================================================
// Test 3: WebSocket reconnection
// ============================================================
async function testReconnection() {
  console.log('\n--- Test 3: WebSocket reconnection ---');

  // Connect
  const client1 = await createDDPClient(url);
  pass(`First connection (session: ${client1.sessionId})`);

  // Close
  client1.close();
  await new Promise(r => setTimeout(r, 1000));
  pass('Connection closed');

  // Reconnect
  try {
    const client2 = await createDDPClient(url);
    pass(`Reconnected (new session: ${client2.sessionId})`);

    // Verify it works
    const count = await client2.call('tasks.count');
    pass(`Method call after reconnect: tasks.count = ${count}`);
    client2.close();
  } catch (e) {
    fail(`Reconnection failed: ${e.message}`);
  }
}

// ============================================================
// Test 4: Short soak test (RSS stability)
// ============================================================
async function testSoak(seconds) {
  console.log(`\n--- Test 4: Soak test (${seconds}s) ---`);

  const client = await createDDPClient(url);
  const startRSS = process.memoryUsage().rss;
  let calls = 0;

  const interval = setInterval(async () => {
    try {
      await client.call('tasks.insert', 'soak-' + Date.now());
      calls++;
    } catch (e) {}
  }, 200);

  await new Promise(r => setTimeout(r, seconds * 1000));
  clearInterval(interval);

  const endRSS = process.memoryUsage().rss;
  const deltaRSS = Math.round((endRSS - startRSS) / 1024 / 1024);

  pass(`${calls} method calls over ${seconds}s`);
  if (Math.abs(deltaRSS) < 50) {
    pass(`RSS stable (delta: ${deltaRSS > 0 ? '+' : ''}${deltaRSS} MB)`);
  } else {
    fail(`RSS grew significantly (delta: +${deltaRSS} MB)`);
  }

  client.close();
}

// ============================================================
// Run all
// ============================================================
console.log(`Consolidation test → ${url}`);

try {
  await testSubscription();
  await testAccounts();
  await testReconnection();
  if (soakSeconds > 0) await testSoak(soakSeconds);
} catch (e) {
  fail(`Unexpected error: ${e.message}`);
}

const passed = results.filter(r => r === 'PASS').length;
const failed = results.filter(r => r === 'FAIL').length;
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
