import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('예약 수량 무제한, 인증, 결제, SMS 실패·재발송, 만료와 삭제', async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'banhxeo-test-'));
  const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'3101',DATA_DIR:dir,ADMIN_USERNAME:'tester',ADMIN_PASSWORD:'test-secret',RESERVATION_LIMIT:'1',SMS_MODE:'mock-fail',PREORDER_CLOSE_AT:'2099-10-06T00:00:00+09:00'},stdio:['ignore','pipe','pipe']});
  let db;
  try {
    await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error(`server exited ${code}`)));});
    let cookie='';
    const request=async(route,data,authenticated=false)=>{const response=await fetch(`http://127.0.0.1:3101/api/v1${route}`,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',...(authenticated?{Cookie:cookie}:{})},...(data?{body:JSON.stringify(data)}:{})});return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')};};
    const input={customerName:'안성준',depositorName:'안성준',phone:'010-1234-5678',pickupDate:'2026-10-06',pickupSlot:'19:00-20:30',quantity:2,privacyAgreed:true,refundPolicyAgreed:true,expectedAmount:1};
    assert.equal((await request('/admin/reservations')).status,401);
    for (const route of ['/reservations', '/admin/login']) {
      for (const payload of ['null', '[]', '"text"', '42', 'true', '{']) {
        const response = await fetch(`http://127.0.0.1:3101/api/v1${route}`, {method:'POST',headers:{'Content-Type':'application/json'},body:payload});
        assert.equal(response.status,400,`${route}: ${payload}`);
      }
    }
    assert.equal((await request('/reservations',{...input,phone:'010-1234',privacyAgreed:false})).status,422);
    const created=await request('/reservations',input);assert.equal(created.status,201);assert.equal(created.data.expectedAmount,11000);assert.equal(created.data.pickupCode,null);
    assert.equal((await request(`/reservations/${created.data.reservationCode}`)).status,404);
    assert.equal((await request(`/reservations/${created.data.accessToken}`)).status,200);
    const login=await request('/admin/login',{username:'tester',password:'test-secret'});assert.equal(login.status,200);cookie=login.cookie.split(';')[0];assert.ok(login.cookie.includes('HttpOnly'));
    const list=await request('/admin/reservations',null,true);const id=list.data.reservations[0].id;
    assert.equal((await request(`/admin/reservations/${id}/confirm-payment`,{confirmedAmount:1},true)).status,422);
    const confirmations=await Promise.all([request(`/admin/reservations/${id}/confirm-payment`,{confirmedAmount:11000},true),request(`/admin/reservations/${id}/confirm-payment`,{confirmedAmount:11000},true)]);
    assert.deepEqual(confirmations.map(x=>x.status).sort(),[200,409]);assert.match(confirmations.find(x=>x.status===200).data.pickupCode,/^[1-9]\d{5}$/);
    const orders=await Promise.all([request('/reservations',{...input,phone:'01012340001'}),request('/reservations',{...input,phone:'01012340002'})]);assert.deepEqual(orders.map(x=>x.status).sort(),[201,201]);
    db=new DatabaseSync(path.join(dir,'reservations.sqlite'));
    assert.equal(db.prepare('SELECT paid_quantity FROM inventory WHERE event_date=?').get(input.pickupDate).paid_quantity,2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM sms_jobs').get().count,1);
    const waiting=orders[0].data;
    const timeoutMinutes=(await request('/config')).data.timeoutMinutes;
    db.prepare('UPDATE reservations SET created_at=? WHERE access_token=?').run(Date.now()-(timeoutMinutes+1)*60000,waiting.accessToken);
    assert.equal((await request(`/reservations/${waiting.accessToken}`)).data.status,'EXPIRED');
    let daily=(await request('/admin/reservations',null,true)).data.dailyQuantities[0];
    assert.equal(daily.totalQuantity,4);assert.equal(daily.paidQuantity,2);assert.equal(daily.waitingQuantity,2);
    const expiredId=db.prepare('SELECT id FROM reservations WHERE access_token=?').get(waiting.accessToken).id;
    const recovered=await request(`/admin/reservations/${expiredId}/confirm-payment`,{confirmedAmount:waiting.expectedAmount},true);
    assert.equal(recovered.status,200);assert.equal(recovered.data.status,'PAID');
    assert.match(recovered.data.pickupCode,/^[1-9]\d{5}$/);
    assert.equal((await request(`/admin/reservations/${expiredId}/confirm-payment`,{confirmedAmount:waiting.expectedAmount},true)).status,409);
    daily=(await request('/admin/reservations',null,true)).data.dailyQuantities[0];
    assert.equal(daily.totalQuantity,6);assert.equal(daily.paidQuantity,4);assert.equal(daily.waitingQuantity,2);
    const deadline=Date.now()+18000;let paid;
    do { await new Promise(resolve=>setTimeout(resolve,1000));paid=(await request('/admin/reservations?status=PAID',null,true)).data.reservations.find(r=>r.id===id); } while(paid.smsStatus!=='FAILED'&&Date.now()<deadline);
    assert.equal(paid.status,'PAID');assert.equal(paid.smsStatus,'FAILED');assert.equal(paid.smsHistory[0].retryCount,3);
    const retry=await request(`/admin/reservations/${id}/sms/retry`,{},true);assert.equal(retry.status,200);assert.equal(retry.data.smsHistory.length,2);assert.equal(retry.data.pickupCode,paid.pickupCode);
    assert.equal((await request(`/admin/reservations/${id}/sms/retry`,{},true)).status,409);
    assert.equal((await request('/admin/reservations?status=ALL&q=010-1234',null,true)).data.reservations.length,3);
    assert.equal((await request(`/admin/reservations/${id}/delete`,{confirmationName:input.customerName,paymentReviewed:true})).status,401);
    assert.equal((await request(`/admin/reservations/${id}/delete`,{confirmationName:'wrong',paymentReviewed:true},true)).status,422);
    assert.equal((await request(`/admin/reservations/${id}/delete`,{confirmationName:input.customerName},true)).status,422);
    assert.equal((await request(`/admin/reservations/${id}/delete`,{confirmationName:` ${input.customerName} `,paymentReviewed:true},true)).status,200);
    assert.equal((await request(`/reservations/${created.data.accessToken}`)).status,404);
    assert.equal(db.prepare('SELECT count(*) AS count FROM sms_jobs WHERE reservation_id=?').get(id).count,0);
    const stockAfterDelete=db.prepare('SELECT reserved_quantity,paid_quantity FROM inventory WHERE event_date=?').get(input.pickupDate);
    assert.equal(stockAfterDelete.reserved_quantity,4);assert.equal(stockAfterDelete.paid_quantity,2);
    const removable=await request('/reservations',{...input,quantity:1});assert.equal(removable.status,201);
    const removableId=db.prepare('SELECT id FROM reservations WHERE access_token=?').get(removable.data.accessToken).id;
    assert.equal((await request(`/admin/reservations/${removableId}/delete`,{confirmationName:input.customerName},true)).status,200);
    assert.equal(db.prepare('SELECT reserved_quantity FROM inventory WHERE event_date=?').get(input.pickupDate).reserved_quantity,4);
    const expiredToDelete=await request('/reservations',{...input,quantity:1});assert.equal(expiredToDelete.status,201);
    const expiredDeleteId=db.prepare('SELECT id FROM reservations WHERE access_token=?').get(expiredToDelete.data.accessToken).id;
    db.prepare('UPDATE reservations SET created_at=? WHERE id=?').run(Date.now()-(timeoutMinutes+1)*60000,expiredDeleteId);
    assert.equal((await request(`/reservations/${expiredToDelete.data.accessToken}`)).data.status,'EXPIRED');
    assert.equal((await request(`/admin/reservations/${expiredDeleteId}/delete`,{confirmationName:input.customerName},true)).status,200);
    assert.equal(db.prepare('SELECT reserved_quantity FROM inventory WHERE event_date=?').get(input.pickupDate).reserved_quantity,4);
    await request('/admin/logout',{},true);assert.equal((await request('/admin/reservations',null,true)).status,401);
  } finally { db?.close();child.kill();await new Promise(resolve=>child.once('exit',resolve));rmSync(dir,{recursive:true,force:true}); }
});

test('동일 전화번호는 날짜·표기와 관계없이 2건까지 허용하고 삭제 후 다시 예약할 수 있다', async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'banhxeo-phone-test-'));
  const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'3103',DATA_DIR:dir,ADMIN_USERNAME:'tester',ADMIN_PASSWORD:'test-secret',SMS_MODE:'mock',PREORDER_CLOSE_AT:'2099-10-06T00:00:00+09:00'},stdio:['ignore','pipe','pipe']});
  let db;
  try {
    await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error(`server exited ${code}`)));});
    const base='http://127.0.0.1:3103/api/v1';
    let cookie='';
    const request=async(route,data)=>{const response=await fetch(`${base}${route}`,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',Cookie:cookie},...(data?{body:JSON.stringify(data)}:{})});return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')};};
    const input={customerName:'예약자',depositorName:'다른입금자',phone:'010-9999-8888',pickupDate:'2026-10-06',pickupSlot:'19:00-20:30',quantity:1,privacyAgreed:true,refundPolicyAgreed:true};
    const results=await Promise.all([request('/reservations',input),request('/reservations',{...input,phone:'01099998888',pickupDate:'2026-10-07'}),request('/reservations',{...input,phone:'010 9999 8888'})]);
    assert.deepEqual(results.map(r=>r.status).sort(),[201,201,409]);
    assert.match(results.find(r=>r.status===409).data.fields.phone,/최대 2회/);
    db=new DatabaseSync(path.join(dir,'reservations.sqlite'));
    assert.equal(db.prepare('SELECT count(*) AS count FROM reservations').get().count,2);
    assert.equal(db.prepare('SELECT sum(reserved_quantity) AS quantity FROM inventory').get().quantity,2);
    assert.equal(db.prepare('SELECT sum(sequence) AS sequence FROM inventory').get().sequence,2);
    db.prepare('UPDATE reservations SET created_at=?').run(0);
    assert.equal((await request('/reservations',input)).status,409);
    const login=await request('/admin/login',{username:'tester',password:'test-secret'});cookie=login.cookie.split(';')[0];
    const id=db.prepare('SELECT id FROM reservations LIMIT 1').get().id;
    assert.equal((await request(`/admin/reservations/${id}/delete`,{confirmationName:input.depositorName})).status,422);
    assert.equal((await request(`/admin/reservations/${id}/delete`,{confirmationName:input.customerName})).status,200);
    assert.equal((await request('/reservations',input)).status,201);
    assert.equal((await request('/reservations',input)).status,409);
    assert.equal((await request('/reservations',{...input,phone:'01099998887'})).status,201);
  } finally { db?.close();child.kill();await new Promise(resolve=>child.once('exit',resolve));rmSync(dir,{recursive:true,force:true}); }
});

test('사전예약 마감 후에는 화면 설정과 API 모두 신규 예약을 막는다', async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'banhxeo-closed-test-'));
  const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'3102',DATA_DIR:dir,SMS_MODE:'mock',PREORDER_CLOSE_AT:'2020-10-06T00:00:00+09:00'},stdio:['ignore','pipe','pipe']});
  try {
    await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error(`server exited ${code}`)));});
    const base='http://127.0.0.1:3102/api/v1';
    assert.equal((await (await fetch(`${base}/config`)).json()).preorderClosed,true);
    const response=await fetch(`${base}/reservations`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customerName:'안성준',depositorName:'안성준',phone:'01012345678',pickupDate:'2026-10-06',pickupSlot:'19:00-20:30',quantity:1,privacyAgreed:true,refundPolicyAgreed:true})});
    assert.equal(response.status,409);
    assert.match((await response.json()).message,/사전예약 접수가 종료/);
  } finally { child.kill();await new Promise(resolve=>child.once('exit',resolve));rmSync(dir,{recursive:true,force:true}); }
});
