import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { sendSolapi } from '../solapi.mjs';

const details = { phone: '01012345678', message: '예약 확정', apiKey: 'test-key', apiSecret: 'test-secret', sender: '0212345678', now: () => new Date('2026-10-04T00:00:00.000Z'), salt: () => '1234567890abcdef1234567890abcdef' };

test('SOLAPI 요청에 문자 한 건과 HMAC 인증을 담고 접수 ID를 저장한다', async () => {
  let request;
  const fetcher = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ groupInfo: { groupId: 'group-1', count: { registeredSuccess: 1 } }, failedMessageList: [], messageList: [{ messageId: 'message-1' }] }) };
  };
  assert.equal(await sendSolapi({ ...details, fetcher }), 'message-1');
  assert.equal(request.url, 'https://api.solapi.com/messages/v4/send-many/detail');
  assert.deepEqual(JSON.parse(request.options.body), { messages: [{ to: details.phone, from: details.sender, text: details.message }] });
  const signature = createHmac('sha256', details.apiSecret).update('2026-10-04T00:00:00.000Z' + details.salt()).digest('hex');
  assert.equal(request.options.headers.Authorization, `HMAC-SHA256 apiKey=test-key, date=2026-10-04T00:00:00.000Z, salt=${details.salt()}, signature=${signature}`);
});

test('HTTP 성공이어도 접수 거부 또는 접수 건수 오류는 실패로 처리한다', async () => {
  const fetcher = async () => ({ ok: true, json: async () => ({ groupInfo: { groupId: 'group-1', count: { registeredSuccess: 0 } }, failedMessageList: [{ statusMessage: '발신번호 미등록' }] }) });
  await assert.rejects(sendSolapi({ ...details, fetcher }), /발신번호 미등록/);
});
