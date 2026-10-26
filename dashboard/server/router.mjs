import express from 'express';
import path from 'node:path';
import {decryptContext,createSessions,ORIGIN,LOCATION} from './access.mjs';
import {loadDashboard} from './ghl-live.mjs';
import {updateContexts} from './conversation-context.mjs';
import {generateFocus} from './bdc-ai.mjs';

function contextStorage(pool){
 let ready;
 return {prepare(sql){let values=[];
  return {bind(...args){values=args;return this;},async all(){const r=await run();return {results:r.rows};},async run(){const r=await run();return {meta:{changes:r.rowCount}};}};
  async function run(){
   ready??=pool.query('CREATE TABLE IF NOT EXISTS public.lucki_bdc_dashboard_briefs (id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,generated_at BIGINT NOT NULL,expires_at BIGINT NOT NULL)').catch(e=>{ready=undefined;throw e;});await ready;
   let index=0;const text=sql.replaceAll('conversation_briefs','public.lucki_bdc_dashboard_briefs').replace(/\?/g,()=>'$'+(++index));
   return pool.query(text,values);
  }
 }};
}

export function createDashboardRouter({pool,publicDirectory,config=process.env}){
 const router=express.Router(),sessions=createSessions(),attempts=new Map(),db=contextStorage(pool);
 router.use((_req,res,next)=>{res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors ${ORIGIN}; object-src 'none'; base-uri 'self'; form-action 'none'`});next();});
 router.use(express.json({limit:'24kb'}));
 router.post('/session',(req,res)=>{
  if(req.get('origin')!=='https://bdc.1987marketing.com')return res.status(403).json({error:'origin'});
  const now=Date.now(),ip=req.ip||'unknown';for(const[k,v]of attempts)if(v.until<now)attempts.delete(k);
  const budget=attempts.get(ip)||{count:0,until:now+60000};budget.count++;attempts.set(ip,budget);
  if(budget.count>30||attempts.size>500)return res.status(429).json({error:'retry_later'});
  if(!config.GHL_APP_SHARED_SECRET)return res.status(503).json({error:'access_not_configured'});
  try{const user=decryptContext(req.body?.encryptedData,config.GHL_APP_SHARED_SECRET);return res.json({token:sessions.issue(user),expiresIn:1800});}catch{return res.status(403).json({error:'access_denied'});}
 });
 router.use('/api',(req,res,next)=>{
  const token=req.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if(!token||!sessions.verify(token))return res.status(401).json({error:'authentication_required'});
  if(req.method!=='GET'&&req.get('origin')!=='https://bdc.1987marketing.com')return res.status(403).json({error:'origin'});
  if(!config.BDC_GHL_READ_TOKEN)return res.status(503).json({error:'read_connection_not_configured'});
  next();
 });
 const dashboard=()=>loadDashboard(config.BDC_GHL_READ_TOKEN,LOCATION);
 router.get('/api/dashboard',async(_req,res)=>{try{res.json(await dashboard());}catch{res.status(502).json({error:'source_unavailable'});}});
 const context=readOnly=>async(_req,res)=>{try{
  const key=config.BDC_OPENAI_API_KEY||config.CONVERSATIONAL_MODEL_API_KEY;
  if(!key)return res.status(503).json({error:'needs_configuration'});
  const d=await dashboard();if(!d.conversations)return res.status(502).json({error:'source_unavailable'});
  res.json(await updateContexts({db,token:config.BDC_GHL_READ_TOKEN,key,d,readOnly}));
 }catch{res.status(502).json({error:'source_unavailable'});}};
 router.get('/api/context',context(true));router.post('/api/context',context(false));
 router.post('/api/focus',async(_req,res)=>{try{const key=config.BDC_OPENAI_API_KEY||config.CONVERSATIONAL_MODEL_API_KEY;if(!key)return res.status(503).json({error:'needs_configuration'});res.json(await generateFocus(key,await dashboard()));}catch{res.status(503).json({error:'unavailable'});}});
 router.use('/api',(_req,res)=>res.status(404).json({error:'not_found'}));
 router.use(express.static(publicDirectory,{index:'index.html',setHeaders:res=>res.set('Cache-Control','private, no-store')}));
 router.get('/',(_req,res)=>res.sendFile(path.join(publicDirectory,'index.html')));
 return router;
}
