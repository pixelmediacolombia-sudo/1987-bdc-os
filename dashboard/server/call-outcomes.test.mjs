import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyCallOutcomes,excludeCallsAlreadyWorked,AGENT} from './bdc-domain.mjs';
const call=(id,contactId,dateAdded='2026-10-26T19:00:00Z',status='completed')=>({id,contactId,dateAdded,status});
const note=(contactId,text,at='2026-10-26T19:02:00Z',authorId=AGENT)=>({contactId,latestInternal:{text,at,authorId}});
test('Completed stays unconfirmed; fresh note can confirm no answer',()=>{
 const q=classifyCallOutcomes({rows:[call('a','a'),call('b','b')]},[note('b','no contesta , busca HRV')]);
 assert.equal(q.rows[0].outcome,'unverified');assert.equal(q.rows[1].outcome,'no-answer');assert.equal(q.outcomes.noAnswer,1);assert.equal(q.outcomes.humanConfirmed,0);
});
test('only latest call, same agent and close timestamp can use note',()=>{
 const q=classifyCallOutcomes({rows:[call('old','a','2026-10-26T18:50:00Z'),call('new','a'),call('b','b'),call('c','c')]},[note('a','no contesta'),note('b','no contesta','2026-10-26T18:00:00Z'),note('c','me contestó','2026-10-26T19:01:00Z','other')]);
 assert.deepEqual(q.rows.map(c=>c.outcome),['unverified','no-answer','unverified','unverified']);
});
test('explicit human answer and provider busy remain separate',()=>{
 const q=classifyCallOutcomes({rows:[call('a','a'),call('b','b',undefined,'busy')]},[note('a','Hablé con el cliente, queda pendiente de opciones')]);
 assert.equal(q.outcomes.humanConfirmed,1);assert.equal(q.outcomes.busy,1);
});
test('called contacts leave initial buckets; a verified new retry action remains',()=>{
 const q={fresh:[{id:'a'},{id:'b'}],october:[{id:'c'}],september:[{id:'d'}],retry:[{id:'e',result:'NO CONTESTÓ'},{id:'f',result:'',cycle:'REINTENTO DÍA 1'}]};
 const filtered=excludeCallsAlreadyWorked(q,{rows:['a','c','d','e','f'].map(id=>call(id,id))});
 assert.deepEqual(filtered.fresh,[{id:'b'}]);assert.equal(filtered.october.length+filtered.september.length,0);assert.deepEqual(filtered.retry.map(c=>c.id),['f']);
});
test('live ringing is in progress, not an outcome requiring confirmation',()=>{
 const q=classifyCallOutcomes({rows:[call('a','a',undefined,'ringing')]},[]);assert.equal(q.outcomes.inProgress,1);assert.equal(q.outcomes.unverified,0);
});
test('a WhatsApp-only comment does not classify a phone call',()=>{
 const q=classifyCallOutcomes({rows:[call('a','a')]},[note('a','No contesta por WhatsApp')]);assert.equal(q.rows[0].outcome,'unverified');
});
