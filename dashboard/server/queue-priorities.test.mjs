import test from 'node:test';
import assert from 'node:assert/strict';
import {buildQueues,BDC_FIELDS as F} from './bdc-queues.mjs';
import {LOCATION,AGENT} from './bdc-domain.mjs';
const now=new Date('2026-10-26T19:00:00Z');
const make=(id,date,fields={},extra={})=>({id,locationId:LOCATION,assignedTo:AGENT,type:'lead',firstName:id,phone:'+12025550123',dateAdded:date,customFields:Object.entries({state:'NUEVO POR LLAMAR',...fields}).map(([k,value])=>({id:F[k],value})),...extra});
test('48h is rolling and historical months do not disappear',()=>{
const recent=make('new','2026-10-26T18:00:00Z'),boundary=make('boundary','2026-10-24T19:00:00Z'),old=make('oct','2026-10-24T18:59:59Z'),sep=make('sep','2026-09-30T16:00:00Z');
const q=buildQueues([old,sep,boundary,recent,recent],now);
assert.deepEqual(q.fresh.map(x=>x.id),['new','boundary']);assert.deepEqual(q.october.map(x=>x.id),['oct']);assert.deepEqual(q.september.map(x=>x.id),['sep']);assert.equal(q.historicalLoaded,false);
});
test('actual retry overrides age and unclassified contacts never become fresh',()=>{
const q=buildQueues([make('retry','2026-10-26T17:00:00Z',{state:'REINTENTO PROGRAMADO',last:'2026-10-26 12:00:00',result:'NO CONTESTÓ',next:'2026-10-26'}),make('unknown','2026-10-26T17:00:00Z',{state:''}),make('paused','2026-10-26T17:00:00Z',{state:'PAUSA'})],now);
assert.equal(q.fresh.length,0);assert.deepEqual(q.retry.map(x=>x.id),['retry']);assert.deepEqual(q.review.map(x=>x.id),['unknown']);
});
test('native GHL epoch dates keep their calendar day and future retries stay out',()=>{
 const current=new Date('2026-10-28T17:00:00Z');
 const fields={state:'REINTENTO PROGRAMADO',last:'2026-10-27 14:38:42',result:'NO CONTESTÓ'};
 const q=buildQueues([
  make('today','2026-10-27T17:46:00Z',{...fields,next:1793145600000}),
  make('future','2026-10-27T17:46:00Z',{...fields,next:String(Date.UTC(2026,9,29))}),
  make('invalid','2026-10-27T17:46:00Z',{...fields,next:'not-a-date'}),
 ],current);
 assert.deepEqual(q.retry.map(x=>[x.id,x.next]),[['today','2026-10-28']]);
 assert.deepEqual(q.review.map(x=>x.id),['invalid']);
});
test('DND, other owners and non-US +1 numbers do not enter ready queues',()=>{
const q=buildQueues([make('canada','2026-10-26T17:00:00Z',{}, {phone:'+14165550123'}),make('mexico','2026-10-26T17:00:00Z',{}, {phone:'+525555550123'}),make('dnd','2026-10-26T17:00:00Z',{}, {dnd:true}),make('other','2026-10-26T17:00:00Z',{}, {assignedTo:'other'})],now);
assert.equal(q.fresh.length+q.retry.length+q.october.length+q.september.length,0);assert.deepEqual(q.review.map(x=>x.id),['canada','mexico']);
});
