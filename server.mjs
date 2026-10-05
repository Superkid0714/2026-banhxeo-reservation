import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendAligo } from './aligo.mjs';
import { sendSolapi } from './solapi.mjs';
import { sendSendon } from './sendon.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const production = process.env.NODE_ENV === 'production';
const adminUser = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'banhxeo-local-2026';
const smsMode = process.env.SMS_MODE || 'mock';
if (production && (adminPassword.length < 16 || ['banhxeo-local-2026','change-this-before-deploying'].includes(adminPassword))) throw new Error('운영 환경의 관리자 비밀번호를 설정하세요.');
if (production && smsMode === 'aligo' && (!process.env.ALIGO_USER_ID || !process.env.ALIGO_API_KEY || !/^\d{8,16}$/.test(process.env.ALIGO_SENDER || '') || process.env.ALIGO_TEST_MODE === 'Y')) throw new Error('운영 환경의 알리고 계정, API 키, 등록된 발신번호를 설정하세요.');
if (production && smsMode === 'solapi' && (!process.env.SOLAPI_API_KEY || !process.env.SOLAPI_API_SECRET || !/^\d{8,16}$/.test(process.env.SOLAPI_SENDER || ''))) throw new Error('운영 환경의 SOLAPI API 키, 시크릿, 등록된 발신번호를 설정하세요.');
if (production && smsMode === 'sendon' && (!process.env.SENDON_USER_ID || !process.env.SENDON_API_KEY || !/^\d{8,16}$/.test(process.env.SENDON_SENDER || ''))) throw new Error('운영 환경의 센드온 계정 ID, API 키, 등록된 발신번호를 설정하세요.');
if (production && smsMode === 'webhook' && !process.env.SMS_WEBHOOK_URL?.startsWith('https://')) throw new Error('운영 환경의 HTTPS SMS 어댑터를 설정하세요.');
if (production && !['aligo','solapi','sendon','webhook'].includes(smsMode)) throw new Error('운영 환경의 실제 문자 발송 방식을 설정하세요.');
const numeric = (key, fallback) => { const v = Number(process.env[key] || fallback); if (!Number.isSafeInteger(v) || v < 1) throw new Error(`Invalid ${key}`); return v; };
const price = numeric('RESERVATION_UNIT_PRICE', 5500), maxQuantity = numeric('MAX_ORDER_QUANTITY', 5), timeout = numeric('PAYMENT_TIMEOUT_MINUTES', 1440);
const dates = ['2026-10-06', '2026-10-07'], slots = ['17:30-19:00', '19:00-20:30', '20:30-22:00'];
const preorderCloseAt = Date.parse(process.env.PREORDER_CLOSE_AT || '2026-10-06T00:00:00+09:00');
if (!Number.isFinite(preorderCloseAt)) throw new Error('Invalid PREORDER_CLOSE_AT');
const bank = { bankName: process.env.BANK_NAME || '토스뱅크', accountNumber: process.env.BANK_ACCOUNT || '1002-7788-0098', accountHolder: process.env.BANK_ACCOUNT_HOLDER || '이요셉' };
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'reservations.sqlite'));
// reservation_limit is a legacy SQLite column retained for existing deployments; no cap is enforced.
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS inventory (event_date TEXT PRIMARY KEY, reservation_limit INTEGER NOT NULL, reserved_quantity INTEGER NOT NULL DEFAULT 0, paid_quantity INTEGER NOT NULL DEFAULT 0, sequence INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS reservations (id INTEGER PRIMARY KEY, reservation_code TEXT UNIQUE NOT NULL, access_token TEXT UNIQUE NOT NULL, customer_name TEXT NOT NULL, phone TEXT NOT NULL, depositor_name TEXT NOT NULL, pickup_date TEXT NOT NULL REFERENCES inventory(event_date), pickup_slot TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price INTEGER NOT NULL, expected_amount INTEGER NOT NULL, status TEXT NOT NULL, pickup_code TEXT UNIQUE, privacy_agreed INTEGER NOT NULL, refund_agreed INTEGER NOT NULL, created_at INTEGER NOT NULL, paid_at INTEGER, expired_at INTEGER);
CREATE TABLE IF NOT EXISTS sms_jobs (id INTEGER PRIMARY KEY, reservation_id INTEGER NOT NULL REFERENCES reservations(id), phone TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, next_attempt INTEGER NOT NULL, sent_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sms_pending ON sms_jobs(status,next_attempt);
CREATE INDEX IF NOT EXISTS reservations_phone ON reservations(phone);`);
if (!db.prepare('PRAGMA table_info(sms_jobs)').all().some(column => column.name === 'provider_message_id')) db.exec('ALTER TABLE sms_jobs ADD COLUMN provider_message_id TEXT');
for (const date of dates) db.prepare('INSERT INTO inventory(event_date,reservation_limit) VALUES (?,0) ON CONFLICT(event_date) DO NOTHING').run(date);
if (['aligo','solapi','sendon'].includes(smsMode)) db.prepare("UPDATE sms_jobs SET status='FAILED',last_error='서버 재시작 전 문자 접수 여부를 알 수 없습니다. 문자 업체의 발송 내역을 확인하세요.' WHERE status='SENDING'").run();
else db.prepare("UPDATE sms_jobs SET status='PENDING' WHERE status='SENDING'").run();
const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const fail = (status, message, fields) => { throw Object.assign(new Error(message), { status, fields }); };
function expire() {
  transaction(() => {
    const expired = db.prepare("SELECT * FROM reservations WHERE status='WAITING_PAYMENT' AND created_at < ?").all(Date.now() - timeout * 60000);
    for (const r of expired) {
      db.prepare("UPDATE reservations SET status='EXPIRED',expired_at=? WHERE id=?").run(Date.now(), r.id);
      db.prepare('UPDATE inventory SET reserved_quantity=reserved_quantity-? WHERE event_date=?').run(r.quantity, r.pickup_date);
    }
  });
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}
function serialize(r, admin = false) {
  const job = db.prepare('SELECT * FROM sms_jobs WHERE reservation_id=? ORDER BY id DESC LIMIT 1').get(r.id);
  const result = { reservationCode: r.reservation_code, accessToken: r.access_token, customerName: r.customer_name, depositorName: r.depositor_name, pickupDate: r.pickup_date, pickupSlot: r.pickup_slot, quantity: r.quantity, unitPrice: r.unit_price, expectedAmount: r.expected_amount, status: r.status, pickupCode: r.pickup_code, createdAt: r.created_at, expiresAt: r.created_at + timeout * 60000, bank, smsStatus: job?.status || null, smsMode, smsTestMode: smsMode === 'aligo' && !production && process.env.ALIGO_TEST_MODE === 'Y' };
  if (admin) Object.assign(result, { id: r.id, phone: r.phone, smsMessage: job?.message, smsSentAt: job?.sent_at, smsAttemptAt: job?.created_at, smsHistory: db.prepare('SELECT id,status,retry_count AS retryCount,last_error AS lastError,provider_message_id AS providerMessageId,created_at AS createdAt,sent_at AS sentAt FROM sms_jobs WHERE reservation_id=? ORDER BY id DESC').all(r.id) });
  return result;
}
function enqueue(r) {
  const message = `[반쎄오갱기데스까]\n${r.customer_name}님, 예약이 확정됐어요.\n\n행사: 전남대 용봉대동풀이\n수령 장소: 후문 야간부스 15번\n메뉴: 치즈 불닭 반쎄오 ${r.quantity}개\n수령: 10월 ${Number(r.pickup_date.slice(-2))}일 ${r.pickup_slot.replace('-', '~')}\n수령코드: ${r.pickup_code}\n\n현장에서 수령코드를 입력해 주세요.\n감사합니다.`;
  db.prepare("INSERT INTO sms_jobs(reservation_id,phone,message,status,created_at,next_attempt) VALUES (?,?,?,'PENDING',?,?)").run(r.id, r.phone, message, Date.now(), Date.now());
}
let working = false;
async function worker() {
  if (working) return; working = true;
  try {
    const job = transaction(() => {
      const j = db.prepare("SELECT * FROM sms_jobs WHERE status='PENDING' AND next_attempt<=? ORDER BY id LIMIT 1").get(Date.now());
      if (j) db.prepare("UPDATE sms_jobs SET status='SENDING',retry_count=retry_count+1 WHERE id=?").run(j.id);
      return j;
    });
    if (!job) return;
    try {
      let providerMessageId = null;
      if (smsMode === 'aligo') {
        providerMessageId = await sendAligo({
          phone: job.phone, message: job.message,
          userId: process.env.ALIGO_USER_ID, apiKey: process.env.ALIGO_API_KEY,
          sender: process.env.ALIGO_SENDER,
          testMode: !production && process.env.ALIGO_TEST_MODE === 'Y',
          url: !production && process.env.ALIGO_API_URL || undefined
        });
      } else if (smsMode === 'solapi') {
        providerMessageId = await sendSolapi({
          phone: job.phone, message: job.message,
          apiKey: process.env.SOLAPI_API_KEY, apiSecret: process.env.SOLAPI_API_SECRET,
          sender: process.env.SOLAPI_SENDER,
          imageId: process.env.SOLAPI_IMAGE_ID || undefined,
          url: !production && process.env.SOLAPI_API_URL || undefined
        });
      } else if (smsMode === 'sendon') {
        providerMessageId = await sendSendon({
          phone: job.phone, message: job.message,
          userId: process.env.SENDON_USER_ID, apiKey: process.env.SENDON_API_KEY,
          sender: process.env.SENDON_SENDER,
          url: !production && process.env.SENDON_API_URL || undefined
        });
      } else if (smsMode === 'webhook') {
        const response = await fetch(process.env.SMS_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SMS_API_KEY || ''}` }, body: JSON.stringify({ phone: job.phone, message: job.message, idempotencyKey: `sms-${job.id}` }), signal: AbortSignal.timeout(10000) });
        const result = await response.json();
        if (!response.ok || result.success !== true) throw new Error(result.error || 'SMS 어댑터 오류');
      } else if (smsMode === 'mock-fail') throw new Error('개발용 문자 실패 시뮬레이션');
      else if (smsMode !== 'mock') throw new Error('지원하지 않는 SMS_MODE');
      db.prepare("UPDATE sms_jobs SET status='SENT',sent_at=?,last_error=NULL,provider_message_id=? WHERE id=?").run(Date.now(), providerMessageId, job.id);
    } catch (error) {
      const attempts = job.retry_count + 1;
      db.prepare('UPDATE sms_jobs SET status=?,last_error=?,next_attempt=? WHERE id=?').run(['aligo','solapi','sendon'].includes(smsMode) || attempts >= 3 ? 'FAILED' : 'PENDING', String(error.message).slice(0,300), Date.now() + attempts * 3000, job.id);
    }
  } finally { working = false; }
}
const loginAttempts = new Map();
const equal = (a,b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x,y); };
function authenticate(req) {
  const token = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (!token || !db.prepare('SELECT token FROM sessions WHERE token=? AND expires_at>?').get(token, Date.now())) fail(401, '관리자 로그인이 필요합니다.');
}
async function body(req) {
  let value = ''; for await (const chunk of req) { value += chunk; if (value.length > 16384) fail(413, '요청이 너무 큽니다.'); }
  let parsed;
  try { parsed = JSON.parse(value || '{}'); } catch { fail(400, '올바른 JSON을 입력해주세요.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, 'JSON 객체를 입력해주세요.');
  return parsed;
}
const server = http.createServer(async (req,res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  const json = (data,status=200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  try {
    const url = new URL(req.url, `http://${req.headers.host}`), route = url.pathname;
    if (route.startsWith('/api/')) {
      if (!['GET','POST'].includes(req.method)) fail(405,'허용되지 않는 요청입니다.');
      if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) fail(403,'허용되지 않는 출처입니다.');
      expire();
      if (route === '/api/v1/config' && req.method === 'GET') return json({ unitPrice: price, maxQuantity, dates, slots, preorderClosed: Date.now() >= preorderCloseAt, bank, timeoutMinutes: timeout, smsMode, smsTestMode: smsMode === 'aligo' && !production && process.env.ALIGO_TEST_MODE === 'Y' });
      if (route === '/api/v1/admin/login' && req.method === 'POST') {
        const key = req.socket.remoteAddress, attempt = loginAttempts.get(key);
        if (attempt && attempt.until > Date.now() && attempt.count >= 5) fail(429,'잠시 후 다시 로그인해주세요.');
        const b = await body(req);
        if (!equal(b.username,adminUser) || !equal(b.password,adminPassword)) { loginAttempts.set(key,{count: (attempt?.until > Date.now() ? attempt.count : 0)+1,until:Date.now()+60000}); fail(401,'관리자 ID 또는 비밀번호를 확인해주세요.'); }
        loginAttempts.delete(key); const token = randomBytes(32).toString('hex');
        db.prepare('INSERT INTO sessions VALUES (?,?)').run(token,Date.now()+8*3600000);
        res.setHeader('Set-Cookie',`session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${production ? '; Secure' : ''}`); return json({ok:true});
      }
      if (route.startsWith('/api/v1/admin/')) authenticate(req);
      if (route === '/api/v1/admin/logout' && req.method === 'POST') {
        const token = /session=([^;]+)/.exec(req.headers.cookie || '')?.[1]; db.prepare('DELETE FROM sessions WHERE token=?').run(token);
        res.setHeader('Set-Cookie','session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json({ok:true});
      }
      if (route === '/api/v1/reservations' && req.method === 'POST') {
        const b = await body(req), fields = {}, phone = String(b.phone || '').replace(/[-\s]/g,'');
        for (const [key,label] of [['customerName','예약자 이름'],['depositorName','입금자명']]) if (typeof b[key] !== 'string' || !b[key].trim() || b[key].trim().length > 50) fields[key] = `${label}을 입력해주세요. (최대 50자)`;
        if (!/^010\d{8}$/.test(phone)) fields.phone='올바른 휴대전화번호를 입력해주세요.';
        if (!dates.includes(b.pickupDate)) fields.pickupDate='수령 날짜를 선택해주세요.';
        if (!slots.includes(b.pickupSlot)) fields.pickupSlot='예상 방문 시간을 선택해주세요.';
        if (!Number.isInteger(b.quantity) || b.quantity<1 || b.quantity>maxQuantity) fields.quantity=`수량은 1~${maxQuantity}개까지 선택할 수 있습니다.`;
        if (b.privacyAgreed!==true) fields.privacyAgreed='개인정보 수집 및 이용에 동의해주세요.';
        if (b.refundPolicyAgreed!==true) fields.refundPolicyAgreed='사전예약 및 환불 안내에 동의해주세요.';
        if (Object.keys(fields).length) fail(422,'입력 내용을 확인해주세요.',fields);
        const r = transaction(() => {
          if (Date.now() >= preorderCloseAt) fail(409,'사전예약 접수가 종료되었습니다.');
          if (db.prepare('SELECT count(*) AS count FROM reservations WHERE phone=?').get(phone).count >= 2) {
            const message='같은 전화번호로는 최대 2회까지 예약할 수 있습니다.';
            fail(409,message,{phone:message});
          }
          const inv = db.prepare('SELECT * FROM inventory WHERE event_date=?').get(b.pickupDate);
          db.prepare('UPDATE inventory SET reserved_quantity=reserved_quantity+?,sequence=sequence+1 WHERE event_date=?').run(b.quantity,b.pickupDate);
          const code=`BANH-${b.pickupDate.slice(5).replace('-','')}-${String(inv.sequence+1).padStart(4,'0')}`;
          const inserted = db.prepare("INSERT INTO reservations(reservation_code,access_token,customer_name,phone,depositor_name,pickup_date,pickup_slot,quantity,unit_price,expected_amount,status,privacy_agreed,refund_agreed,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'WAITING_PAYMENT',1,1,?)").run(code,randomBytes(24).toString('hex'),b.customerName.trim(),phone,b.depositorName.trim(),b.pickupDate,b.pickupSlot,b.quantity,price,price*b.quantity,Date.now());
          return db.prepare('SELECT * FROM reservations WHERE id=?').get(inserted.lastInsertRowid);
        }); return json(serialize(r),201);
      }
      if (route.startsWith('/api/v1/reservations/') && req.method==='GET') {
        const token=route.split('/').at(-1); const r=db.prepare('SELECT * FROM reservations WHERE access_token=?').get(token);
        if (!r) fail(404,'예약을 찾을 수 없습니다. 예약 링크를 확인해주세요.'); return json(serialize(r));
      }
      if (route === '/api/v1/admin/reservations' && req.method==='GET') {
        const all=db.prepare('SELECT * FROM reservations ORDER BY created_at DESC').all().map(r=>serialize(r,true));
        const q=(url.searchParams.get('q')||'').trim().toLowerCase(), filter=url.searchParams.get('status')||'WAITING_PAYMENT';
        const dailyQuantities=dates.map(date=>{
          const dayReservations=all.filter(r=>r.pickupDate===date);
          const waitingQuantity=dayReservations.filter(r=>r.status==='WAITING_PAYMENT').reduce((sum,r)=>sum+r.quantity,0);
          const paidQuantity=dayReservations.filter(r=>r.status==='PAID').reduce((sum,r)=>sum+r.quantity,0);
          return {date,totalQuantity:waitingQuantity+paidQuantity,waitingQuantity,paidQuantity};
        });
        return json({ counts:{ waiting:all.filter(r=>r.status==='WAITING_PAYMENT').length,expired:all.filter(r=>r.status==='EXPIRED').length,paid:all.filter(r=>r.status==='PAID').length,failed:all.filter(r=>r.smsStatus==='FAILED').length }, dailyQuantities, reservations:all.filter(r=>(filter==='ALL'||(filter==='SMS_FAILED'?r.smsStatus==='FAILED':r.status===filter))&&(!q||[r.customerName,r.depositorName,r.phone,r.reservationCode].some(v=>v.toLowerCase().includes(q.replace(/-/g, v===r.phone?'':'-'))))) });
      }
      const adminDetail=/^\/api\/v1\/admin\/reservations\/(\d+)$/.exec(route);
      if (adminDetail && req.method==='GET') {
        const r=db.prepare('SELECT * FROM reservations WHERE id=?').get(Number(adminDetail[1]));
        if(!r) fail(404,'예약을 찾을 수 없습니다.');
        return json(serialize(r,true));
      }
      const deletion=/^\/api\/v1\/admin\/reservations\/(\d+)\/delete$/.exec(route);
      if (deletion && req.method==='POST') {
        const b=await body(req);
        transaction(()=>{
          const r=db.prepare('SELECT * FROM reservations WHERE id=?').get(Number(deletion[1]));
          if(!r) fail(404,'예약을 찾을 수 없습니다.');
          if(typeof b.confirmationName!=='string' || b.confirmationName.trim()!==r.customer_name) fail(422,'예약자 이름이 일치하지 않습니다.');
          if(r.status==='PAID' && b.paymentReviewed!==true) fail(422,'입금·환불 처리 여부를 확인해 주세요.');
          if(db.prepare("SELECT id FROM sms_jobs WHERE reservation_id=? AND status='SENDING'").get(r.id)) fail(409,'문자 발송이 진행 중입니다. 잠시 후 다시 시도해 주세요.');
          db.prepare('DELETE FROM sms_jobs WHERE reservation_id=?').run(r.id);
          db.prepare('DELETE FROM reservations WHERE id=?').run(r.id);
          if(r.status==='WAITING_PAYMENT') db.prepare('UPDATE inventory SET reserved_quantity=reserved_quantity-? WHERE event_date=?').run(r.quantity,r.pickup_date);
          if(r.status==='PAID') db.prepare('UPDATE inventory SET reserved_quantity=reserved_quantity-?,paid_quantity=paid_quantity-? WHERE event_date=?').run(r.quantity,r.quantity,r.pickup_date);
        });
        return json({ok:true});
      }
      const action=/^\/api\/v1\/admin\/reservations\/(\d+)\/(confirm-payment|sms\/retry)$/.exec(route);
      if (action && req.method==='POST') {
        const b=await body(req); const r=transaction(()=>{
          let r=db.prepare('SELECT * FROM reservations WHERE id=?').get(Number(action[1])); if(!r) fail(404,'예약을 찾을 수 없습니다.');
          if(action[2]==='confirm-payment') {
            if(!['WAITING_PAYMENT','EXPIRED'].includes(r.status)) fail(409,'이미 처리된 예약입니다.');
            if(b.confirmedAmount!==r.expected_amount) fail(422,'입금 금액이 예약 금액과 다릅니다.');
            if(r.status==='EXPIRED') {
              db.prepare('UPDATE inventory SET reserved_quantity=reserved_quantity+? WHERE event_date=?').run(r.quantity,r.pickup_date);
            }
            let code; do { code=String(randomInt(100000,1000000)); } while(db.prepare('SELECT id FROM reservations WHERE pickup_code=?').get(code));
            db.prepare("UPDATE reservations SET status='PAID',pickup_code=?,paid_at=?,expired_at=NULL WHERE id=?").run(code,Date.now(),r.id);
            db.prepare('UPDATE inventory SET paid_quantity=paid_quantity+? WHERE event_date=?').run(r.quantity,r.pickup_date);
            r=db.prepare('SELECT * FROM reservations WHERE id=?').get(r.id);
          } else {
            if(r.status!=='PAID') fail(409,'결제완료 예약만 재발송할 수 있습니다.');
            if(db.prepare("SELECT id FROM sms_jobs WHERE reservation_id=? AND status IN ('PENDING','SENDING')").get(r.id)) fail(409,'문자 발송이 진행 중입니다.');
          }
          enqueue(r); return r;
        }); return json(serialize(r,true));
      }
      fail(404,'요청을 찾을 수 없습니다.');
    }
    if(req.method!=='GET') fail(405,'허용되지 않는 요청입니다.');
    const assets = { '/app.js':['app.js','text/javascript'], '/style.css':['style.css','text/css'], '/food.png':['food.png','image/png'] };
    const asset=assets[route] || ['index.html','text/html'];
    res.writeHead(200,{'Content-Type':`${asset[1]}; charset=utf-8`,'Cache-Control':'no-cache'}); res.end(readFileSync(path.join(root,'public',asset[0])));
  } catch(error) { json({message:error.status ? error.message : '서버 오류가 발생했습니다.',fields:error.fields},error.status||500); if(!error.status) console.error(error); }
});
const interval=setInterval(()=>{expire(); void worker();},1000);
server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log(`예약 시스템: http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT||3000} / SMS: ${smsMode}`));
process.on('SIGTERM',()=>{clearInterval(interval);server.close(()=>{db.close();process.exit(0);});});


