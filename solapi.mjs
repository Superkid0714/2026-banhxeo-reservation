import { createHmac, randomBytes } from 'node:crypto';

const endpoint = 'https://api.solapi.com/messages/v4/send-many/detail';

export async function sendSolapi({ phone, message, apiKey, apiSecret, sender, imageId, fetcher = fetch, url = endpoint, now = () => new Date(), salt = () => randomBytes(16).toString('hex') }) {
  const date = now().toISOString();
  const nonce = salt();
  const signature = createHmac('sha256', apiSecret).update(date + nonce).digest('hex');
  const response = await fetcher(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${nonce}, signature=${signature}`
    },
    body: JSON.stringify({ messages: [{ to: phone, from: sender, text: message, subject: '용봉대동풀이 예약 확정', ...(imageId ? { imageId } : {}) }] }),
    signal: AbortSignal.timeout(10000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`SOLAPI HTTP ${response.status}: ${String(result.errorMessage || result.message || '요청 오류').slice(0, 150)}`);
  if (result.failedMessageList?.length || result.groupInfo?.count?.registeredSuccess !== 1 || !result.groupInfo?.groupId) {
    throw new Error(`SOLAPI 발송 접수 실패: ${String(result.failedMessageList?.[0]?.statusMessage || '응답 오류').slice(0, 150)}`);
  }
  return String(result.messageList?.[0]?.messageId || result.groupInfo.groupId);
}
