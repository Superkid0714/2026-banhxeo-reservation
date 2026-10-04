const endpoint = 'https://apis.aligo.in/send/';

export async function sendAligo({ phone, message, userId, apiKey, sender, testMode = false, fetcher = fetch, url = endpoint }) {
  const form = new URLSearchParams({ key: apiKey, user_id: userId, sender, receiver: phone, msg: message, msg_type: 'LMS' });
  if (testMode) form.set('testmode_yn', 'Y');
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: form,
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`알리고 HTTP ${response.status}`);
  const result = await response.json();
  if (result.result_code !== 1 || result.success_cnt !== 1 || result.error_cnt !== 0 || !result.msg_id) {
    throw new Error(`알리고 발송 접수 실패: ${String(result.message || result.result_code || '응답 오류').slice(0, 150)}`);
  }
  return String(result.msg_id);
}
