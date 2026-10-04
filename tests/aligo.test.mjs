import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendAligo } from '../aligo.mjs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const details = { phone: '01012345678', message: '예약 확정\n수령코드 123456', userId: 'operator', apiKey: 'test-key', sender: '0212345678' };

test('알리고 LMS 요청은 등록된 발신번호와 문자 내용을 폼으로 전송한다', async () => {
  let request;
  const fetcher = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ result_code: 1, success_cnt: 1, error_cnt: 0, msg_id: 12345 }) };
  };
  const id = await sendAligo({ ...details, testMode: true, fetcher });
  assert.equal(id, '12345');
  assert.equal(request.url, 'https://apis.aligo.in/send/');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Content-Type'], 'application/x-www-form-urlencoded; charset=utf-8');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(request.options.body)), {
    key: 'test-key', user_id: 'operator', sender: '0212345678', receiver: '01012345678',
    msg: details.message, msg_type: 'LMS', testmode_yn: 'Y'
  });
});

test('알리고가 HTTP 200으로 보낸 거부 응답도 실패로 처리한다', async () => {
  const fetcher = async () => ({ ok: true, json: async () => ({ result_code: -101, message: '인증오류입니다.' }) });
  await assert.rejects(sendAligo({ ...details, fetcher }), /인증오류입니다/);
});

test('입금 확정 후 알리고에 한 건을 접수하고 메시지 ID를 기록한다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'banhxeo-aligo-'));
  const requests = [];
  const provider = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(Object.fromEntries(new URLSearchParams(body)));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result_code: 1, success_cnt: 1, error_cnt: 0, msg_id: 98765 }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const port = provider.address().port;
  const appPort = 3102;
  const child = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, PORT: String(appPort), DATA_DIR: dir, ADMIN_USERNAME: 'tester', ADMIN_PASSWORD: 'test-secret',
      SMS_MODE: 'aligo', ALIGO_USER_ID: 'operator', ALIGO_API_KEY: 'test-key', ALIGO_SENDER: '0212345678',
      ALIGO_API_URL: `http://127.0.0.1:${port}/send/` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`server exited ${code}`))); });
    const base = `http://127.0.0.1:${appPort}/api/v1`;
    const post = async (route, data, cookie) => fetch(base + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data)
    });
    const created = await post('/reservations', {
      customerName: '예약자', depositorName: '입금자', phone: '01012345678', pickupDate: '2026-10-06',
      pickupSlot: '19:00-20:30', quantity: 1, privacyAgreed: true, refundPolicyAgreed: true
    });
    assert.equal(created.status, 201);
    const login = await post('/admin/login', { username: 'tester', password: 'test-secret' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const list = await (await fetch(base + '/admin/reservations', { headers: { Cookie: cookie } })).json();
    const id = list.reservations[0].id;
    assert.equal((await post(`/admin/reservations/${id}/confirm-payment`, { confirmedAmount: 5500 }, cookie)).status, 200);
    const deadline = Date.now() + 5000;
    let detail;
    do {
      await new Promise(resolve => setTimeout(resolve, 250));
      detail = await (await fetch(base + `/admin/reservations/${id}`, { headers: { Cookie: cookie } })).json();
    } while (detail.smsStatus !== 'SENT' && Date.now() < deadline);
    assert.equal(detail.smsStatus, 'SENT');
    assert.equal(detail.smsHistory[0].providerMessageId, '98765');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].msg_type, 'LMS');
    assert.equal(requests[0].receiver, '01012345678');
    assert.equal(requests[0].sender, '0212345678');
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => provider.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
