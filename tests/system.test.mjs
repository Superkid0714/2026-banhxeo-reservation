import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('예약, 인증, 재고 동시성, 결제, SMS 실패·재발송, 만료', async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'banhxeo-test-'));
  const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'3101',DATA_DIR:dir,ADMIN_USERNAME:'tester',ADMIN_PASSWORD:'test-secret',RESERVATION_LIMIT:'5',SMS_MODE:'mock-fail'},stdio:['ignore','pipe','pipe']});
  try {
    await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error(`server exited ${code}`)));});
    let cookie='';
    const request=async(route,data,authenticated=false)=>{const response=await fetch(`http://127.0.0.1:3101/api/v1${route}`,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',...(authenticated?{Cookie:cookie}:{})},...(data?{body:JSON.stringify(data)}:{})});return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')};};
    const input={customerName:'안성준',depositorName:'안성준',phone:'010-1234-5678',pickupDate:'2026-10-06',pickupSlot:'19:00-20:30',quantity:2,privacyAgreed:true,refundPolicyAgreed:true,expectedAmount:1};
    assert.equal((await request('/admin/reservations')).status,401);
    assert.equal((await request('/reservations',{...input,phone:'010-1234',privacyAgreed:false})).status,422);
    const created=await request('/reservations',input);assert.equal(created.status,201);assert.equal(created.data.expectedAmount,11000);assert.equal(created.data.pickupCode,null);
    assert.equal((await request(`/reservations/${created.data.reservationCode}`)).status,404);
    assert.equal((await request(`/reservations/${created.data.accessToken}`)).status,200);
    const login=await request('/admin/login',{username:'tester',password:'test-secret'});assert.equal(login.status,200);cookie=login.cookie.split(';')[0];assert.ok(login.cookie.includes('HttpOnly'));
    const list=await request('/admin/reservations',null,true);const id=list.data.reservations[0].id;
    assert.equal((await request(`/admin/reservations/${id}/confirm-payment`,{confirmedAmount:1},true)).status,422);
    const confirmations=await Promise.all([request(`/admin/reservations/${id}/confirm-payment`,{confirmedAmount:11000},true),request(`/admin/reservations/${id}/confirm-payment`,{confirmedAmount:11000},true)]);
    assert.deepEqual(confirmations.map(x=>x.status).sort(),[200,409]);assert.match(confirmations.find(x=>x.status===200).data.pickupCode,/^[1-9]\d{5}$/);
    const orders=await Promise.all([request('/reservations',input),request('/reservations',input)]);assert.deepEqual(orders.map(x=>x.status).sort(),[201,409]);
    const db=new DatabaseSync(path.join(dir,'reservations.sqlite'));
    assert.equal(db.prepare('SELECT paid_quantity FROM inventory WHERE event_date=?').get(input.pickupDate).paid_quantity,2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM sms_jobs').get().count,1);
    const waiting=orders.find(x=>x.status===201).data;
    db.prepare('UPDATE reservations SET created_at=? WHERE access_token=?').run(Date.now()-61*60000,waiting.accessToken);
    assert.equal((await request(`/reservations/${waiting.accessToken}`)).data.status,'EXPIRED');
    assert.equal((await request('/config')).data.inventory[0].remaining,3);
    const deadline=Date.now()+18000;let paid;
    do { await new Promise(resolve=>setTimeout(resolve,1000));paid=(await request('/admin/reservations?status=PAID',null,true)).data.reservations[0]; } while(paid.smsStatus!=='FAILED'&&Date.now()<deadline);
    assert.equal(paid.status,'PAID');assert.equal(paid.smsStatus,'FAILED');assert.equal(paid.smsHistory[0].retryCount,3);
    const retry=await request(`/admin/reservations/${id}/sms/retry`,{},true);assert.equal(retry.status,200);assert.equal(retry.data.smsHistory.length,2);assert.equal(retry.data.pickupCode,paid.pickupCode);
    assert.equal((await request(`/admin/reservations/${id}/sms/retry`,{},true)).status,409);
    assert.equal((await request('/admin/reservations?status=ALL&q=010-1234',null,true)).data.reservations.length,2);
    await request('/admin/logout',{},true);assert.equal((await request('/admin/reservations',null,true)).status,401);db.close();
  } finally { child.kill();await new Promise(resolve=>child.once('exit',resolve));rmSync(dir,{recursive:true,force:true}); }
});
