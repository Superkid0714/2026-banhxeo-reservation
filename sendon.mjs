const endpoint = 'https://api.sendon.io/v2/messages/sms';

export async function sendSendon({ phone, message, userId, apiKey, sender, fetcher = fetch, url = endpoint }) {
  const response = await fetcher(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${userId}:${apiKey}`).toString('base64')}`
    },
    body: JSON.stringify({ type: 'LMS', from: sender, to: [phone], title: '예약 확정 안내', message, isAd: false }),
    signal: AbortSignal.timeout(10000)
  });
  const result = await response.json();
  if (!response.ok || result.code !== 200 || !result.data?.groupId) {
    throw new Error(`센드온 발송 접수 실패: ${String(result.message || `HTTP ${response.status}`).slice(0, 150)}`);
  }
  return String(result.data.groupId);
}
