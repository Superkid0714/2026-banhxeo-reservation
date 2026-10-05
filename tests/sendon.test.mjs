import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendSendon } from '../sendon.mjs';

const details = { phone: '01012345678', message: '예약 확정', userId: 'account', apiKey: 'test-key', sender: '0212345678' };

test('센드온 LMS 접수에 인증과 정보성 메시지를 보내고 그룹 ID를 저장한다', async () => {
  let request;
  const fetcher = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ code: 200, data: { groupId: 'group-1' } }) };
  };
  assert.equal(await sendSendon({ ...details, fetcher }), 'group-1');
  assert.equal(request.url, 'https://api.sendon.io/v2/messages/sms');
  assert.equal(request.options.headers.Authorization, `Basic ${Buffer.from('account:test-key').toString('base64')}`);
  assert.deepEqual(JSON.parse(request.options.body), { type: 'LMS', from: details.sender, to: [details.phone], title: '예약 확정 안내', message: details.message, isAd: false });
});

test('HTTP 200이어도 센드온 접수 오류는 실패로 처리한다', async () => {
  const fetcher = async () => ({ ok: true, json: async () => ({ code: 403, message: '허용되지 않은 IP' }) });
  await assert.rejects(sendSendon({ ...details, fetcher }), /허용되지 않은 IP/);
});
