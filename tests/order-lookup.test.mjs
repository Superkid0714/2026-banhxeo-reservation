import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('주문 서버 수령코드 조회: 전용 인증, 최소 정보, 읽기 전용, 지속되는 실패 제한', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'banhxeo-order-test-'));
  const key = 'test-order-key-012345678901234567890123';
  const base = 'http://127.0.0.1:3104/api/v1';
  let child, db;
  const start = async (apiKey = key) => {
    child = spawn(process.execPath, ['server.mjs'], { env: {
      ...process.env, HOST: '127.0.0.1', NODE_ENV: 'development', PORT: '3104', DATA_DIR: dir,
      ADMIN_USERNAME: 'tester', ADMIN_PASSWORD: 'test-secret', SMS_MODE: 'mock',
      PREORDER_CLOSE_AT: '2099-10-06T00:00:00+09:00', ORDER_API_KEY: apiKey,
      ORDER_LOOKUP_MAX_FAILURES: '5', ORDER_LOOKUP_WINDOW_SECONDS: '60'
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve); child.once('error', reject);
      child.once('exit', code => reject(new Error(`server exited ${code}`)));
    });
  };
  const stop = async () => {
    const stopped = new Promise(resolve => child.once('exit', resolve));
    child.kill(); await stopped; child = null;
  };
  const lookup = async (pickupCode, headers = { Authorization: `Bearer ${key}` }, raw) => {
    const response = await fetch(`${base}/orders/reservations/lookup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: raw ?? JSON.stringify({ pickupCode })
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  try {
    await start();
    const input = { customerName: '예약자', depositorName: '입금자', phone: '01012345678',
      pickupDate: '2026-10-07', pickupSlot: '19:00-20:30', quantity: 2,
      privacyAgreed: true, refundPolicyAgreed: true };
    const created = await fetch(`${base}/reservations`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(created.status, 201);
    const login = await fetch(`${base}/admin/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'tester', password: 'test-secret' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    db = new DatabaseSync(path.join(dir, 'reservations.sqlite'));
    const id = db.prepare('SELECT id FROM reservations').get().id;
    const confirmation = await fetch(`${base}/admin/reservations/${id}/confirm-payment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ confirmedAmount: 11000 })
    });
    assert.equal(confirmation.status, 200);
    const paid = await confirmation.json();
    assert.match(paid.pickupCode, /^[0-9]{6}$/);
    const snapshot = () => ({
      reservations: db.prepare('SELECT * FROM reservations').all(),
      inventory: db.prepare('SELECT * FROM inventory').all(),
      jobs: db.prepare('SELECT id,reservation_id,phone,message FROM sms_jobs').all()
    });
    const before = snapshot();
    assert.equal((await lookup(paid.pickupCode, {})).status, 401);
    assert.equal((await lookup(paid.pickupCode, { Cookie: cookie })).status, 401);
    assert.equal((await lookup(paid.pickupCode, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal(db.prepare('SELECT count(*) AS count FROM order_lookup_failures').get().count, 0);
    const get = await fetch(`${base}/orders/reservations/lookup?pickupCode=${paid.pickupCode}`, { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(get.status, 405);
    const result = await lookup(paid.pickupCode);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(result.data, { reservationId: id, quantity: 2, pickupDate: '2026-10-07', paymentConfirmed: true });
    assert.equal((await lookup('000000')).status, 404);
    assert.equal((await lookup(123456)).status, 422);
    assert.equal((await lookup('12345')).status, 422);
    assert.equal((await lookup(null, undefined, '{')).status, 400);
    assert.equal((await lookup(paid.pickupCode)).status, 200);
    // Success must not reset failures; concurrent bodies cannot pass the budget.
    const failures = await Promise.all(Array.from({ length: 4 }, (_, i) => lookup('000000', {
      Authorization: `Bearer ${key}`, 'X-Forwarded-For': `192.0.2.${i + 1}`
    })));
    assert.deepEqual(failures.map(r => r.status).sort(), [404, 429, 429, 429]);
    const blocked = await lookup(paid.pickupCode);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal(db.prepare('SELECT count FROM order_lookup_failures').get().count, 5);
    assert.deepEqual(snapshot(), before);
    await stop(); await start();
    assert.equal((await lookup(paid.pickupCode)).status, 429);
    db.prepare('UPDATE order_lookup_failures SET expires_at=?').run(Date.now() - 1);
    assert.equal((await lookup(paid.pickupCode)).status, 200);
    assert.equal((await lookup('000000')).status, 404);
    assert.equal(db.prepare('SELECT count FROM order_lookup_failures').get().count, 1);
    assert.deepEqual(snapshot(), before);
    // Unconfigured integrations fail closed without changing existing routes.
    await stop(); await start('');
    assert.equal((await lookup(paid.pickupCode)).status, 503);
    assert.equal((await fetch(`${base}/config`)).status, 200);
    assert.deepEqual(snapshot(), before);
  } finally {
    db?.close(); if (child) await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
