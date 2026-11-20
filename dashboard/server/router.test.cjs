const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const path=require('node:path');
const {createDashboardRouter}=require('../compiled/router.cjs');
test('internal dashboard requires a BDC session and serves its private shell',async()=>{
 let queries=0;const pool={query(){queries++;throw Error('anonymous request must not query storage');}};
 const app=express();app.use('/mi-dia',createDashboardRouter({pool,publicDirectory:path.resolve(__dirname,'../public')}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const asset=await fetch(base+'/mi-dia/');assert.equal(asset.status,200);assert.match(asset.headers.get('content-security-policy'),/frame-ancestors 'self'/);assert.equal(asset.headers.get('cache-control'),'private, no-store');
  const anonymous=await fetch(base+'/mi-dia/api/dashboard');assert.equal(anonymous.status,401);
  const write=await fetch(base+'/mi-dia/api/conversations/00000000-0000-4000-8000-000000000001/messages',{method:'POST'});assert.equal(write.status,401);assert.equal(queries,0);
 }finally{await new Promise(r=>server.close(r));}
});

test('authorized user sees internal conversations and can send through Meta with tenant scope',async()=>{
 const token='local-test-session';let sendInput;let currentTenant='';
 const row={id:'00000000-0000-4000-8000-000000000001',contact_id:'00000000-0000-4000-8000-000000000002',phone:'+15715550134',email:null,channel:'whatsapp',state:'open',last_activity:new Date(),preview:'Hola',direction:'inbound',last_message_at:new Date(),lead_level:'B',qualification:{vehicle_category:'suv',down_payment_declared:2500}};
 const client={query:async(sql,values=[])=>{if(sql.includes("set_config('app.tenant_id'")){currentTenant=values[0];return{rows:[]}}if(sql.includes('BEGIN')||sql.includes('COMMIT')||sql.includes('ROLLBACK'))return{rows:[]};if(sql.includes('SELECT dealer_id::text AS id, dealer_name AS name'))return{rows:[{id:'00000000-0000-4000-8000-000000000010',name:'Dealer local'}]};if(sql.includes('FROM public.conversations conversation')&&sql.includes('JOIN public.contacts contact'))return{rows:[row]};if(sql.includes('FROM public.messages message'))return{rows:[{id:'message-1',direction:'inbound',sender_type:'client',content:'Hola',created_at:new Date()}]};if(sql.includes('FROM public.tenants WHERE dealer_id'))return{rows:[{id:'00000000-0000-4000-8000-000000000010',name:'Dealer local'}]};if(sql.includes('FROM public.conversations conversation'))return{rows:[row]};return{rows:[]}},release(){}};
 const pool={query:async(sql,values=[])=>{if(sql.includes('FROM public.app_sessions'))return{rows:[{id:'00000000-0000-4000-8000-000000000020',email:'dealer@example.test',name:'Dealer User',role:'user'}]};if(sql.includes('FROM public.user_tenant_memberships'))return{rows:[{id:'00000000-0000-4000-8000-000000000010',name:'Dealer local'}]};throw Error('Unexpected query '+sql)},connect:async()=>client};
 const outboundSender={send:async input=>{sendInput=input;return{providerMessageId:'meta-message-1'}}};
 const app=express();app.use('/mi-dia',createDashboardRouter({pool,publicDirectory:path.resolve(__dirname,'../public'),outboundSender}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;const headers={Cookie:`bdc_os_session=${token}`,'Content-Type':'application/json'};
 try{
  const dashboard=await fetch(base+'/mi-dia/api/dashboard',{headers});assert.equal(dashboard.status,200);const body=await dashboard.json();assert.equal(body.conversations[0].leadLevel,'B');assert.equal(body.conversations[0].channel,'whatsapp');
  const messages=await fetch(base+'/mi-dia/api/conversations/00000000-0000-4000-8000-000000000001/messages',{headers});assert.equal(messages.status,200);assert.equal((await messages.json()).messages[0].content,'Hola');
  const sent=await fetch(base+'/mi-dia/api/conversations/00000000-0000-4000-8000-000000000001/messages',{method:'POST',headers:{...headers,Origin:'http://127.0.0.1:'+server.address().port},body:JSON.stringify({content:'Respuesta de prueba'})});assert.equal(sent.status,202);assert.equal(sendInput.tenantId,'00000000-0000-4000-8000-000000000010');assert.equal(sendInput.channel,'WhatsApp');assert.equal(currentTenant,sendInput.tenantId);
 }finally{await new Promise(r=>server.close(r));}
});
