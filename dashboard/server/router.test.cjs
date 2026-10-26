const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const path=require('node:path');
const {createDashboardRouter}=require('../compiled/router.cjs');
test('embedded HTTP surface is private, rejects forged identities and cannot write to GHL',async()=>{
 const app=express();let queries=0;app.use('/mi-dia',createDashboardRouter({pool:{query(){queries++;throw Error('must not reach storage');}},publicDirectory:path.resolve(__dirname,'../public'),config:{GHL_APP_SHARED_SECRET:'test-only'}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const asset=await fetch(base+'/mi-dia/');assert.equal(asset.status,200);assert.match(asset.headers.get('content-security-policy'),/frame-ancestors https:\/\/app\.1987marketing\.com/);assert.equal(asset.headers.get('cache-control'),'private, no-store');
  const anonymous=await fetch(base+'/mi-dia/api/dashboard');assert.equal(anonymous.status,401);
  const forged=await fetch(base+'/mi-dia/session',{method:'POST',headers:{Origin:'https://bdc.1987marketing.com','Content-Type':'application/json'},body:JSON.stringify({userId:'bNf6DGx9F0ZWT8pYbIro',activeLocation:'cd9Slb2Fk2vNY3l4ukG9',encryptedData:'fake'})});assert.equal(forged.status,403);
  const wrongOrigin=await fetch(base+'/mi-dia/session',{method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:'{}'});assert.equal(wrongOrigin.status,403);
  const write=await fetch(base+'/mi-dia/api/send',{method:'POST'});assert.equal(write.status,401);assert.equal(queries,0);
 }finally{await new Promise(r=>server.close(r));}
});
