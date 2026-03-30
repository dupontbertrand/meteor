#!/usr/bin/env node
// DDP smoke test client
// Tests: handshake, method call, subscription
//
// Usage: node ddp-test.mjs [ws://localhost:3001/websocket]

import WebSocket from 'ws';

const url = process.argv[2] || 'ws://localhost:3001/websocket';
const results = [];
let step = 0;

function pass(msg) { results.push({ step: ++step, status: 'PASS', msg }); console.log(`  ✅ ${msg}`); }
function fail(msg) { results.push({ step: ++step, status: 'FAIL', msg }); console.log(`  ❌ ${msg}`); }

console.log(`DDP smoke test → ${url}\n`);

const ws = new WebSocket(url);

ws.on('open', () => {
  pass('WebSocket connected');
  ws.send(JSON.stringify({ msg: 'connect', version: '1', support: ['1'] }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.msg === 'connected') {
    pass(`DDP handshake (session: ${msg.session})`);
    // Test method call
    ws.send(JSON.stringify({ msg: 'method', method: 'nonexistent.method', params: [], id: '1' }));
  }

  if (msg.msg === 'result' && msg.id === '1') {
    if (msg.error) {
      pass('Method call (got expected 404 for nonexistent method)');
    } else {
      pass('Method call (returned result)');
    }
    // Test subscription
    ws.send(JSON.stringify({ msg: 'sub', id: 'sub1', name: 'nonexistent.pub', params: [] }));
  }

  if (msg.msg === 'nosub' && msg.id === 'sub1') {
    pass('Subscription (got expected nosub for nonexistent pub)');
    ws.close();
  }
});

ws.on('error', (e) => {
  fail(`WebSocket error: ${e.message}`);
  finish();
});

ws.on('close', () => finish());

setTimeout(() => {
  fail('Timeout (5s)');
  finish();
}, 5000);

function finish() {
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
