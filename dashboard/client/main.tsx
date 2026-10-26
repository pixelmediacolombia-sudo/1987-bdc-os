/// <reference path="./vite-env.d.ts" />
import React from 'react';
import {createRoot} from 'react-dom/client';
import Home from './page';
import './globals.css';
const HOST='https://app.1987marketing.com';
const nativeFetch=window.fetch.bind(window);let token='',mounted=false,authPending:Promise<void>|null=null;
async function authenticate(){
 if(authPending)return authPending;
 authPending=new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>{window.removeEventListener('message',receive);reject(Error('Abre el panel desde el dashboard de Lucki para validar tu acceso.'));},15000);
  async function receive(event:MessageEvent){
   if(event.origin!==HOST||event.source!==window.parent||event.data?.message!=='REQUEST_USER_DATA_RESPONSE'||typeof event.data.payload!=='string')return;
   clearTimeout(timer);window.removeEventListener('message',receive);
   try{const r=await nativeFetch('/mi-dia/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({encryptedData:event.data.payload})});if(!r.ok)throw Error('Tu usuario no tiene acceso autorizado al panel de Lucki.');token=(await r.json()).token;resolve();}catch(e){reject(e);}
  }
  window.addEventListener('message',receive);window.parent.postMessage({message:'REQUEST_USER_DATA'},HOST);
 }).finally(()=>{authPending=null;});return authPending;
}
window.fetch=async(input,init)=>{
 const raw=typeof input==='string'?input:input instanceof URL?input.href:input.url;
 if(!raw.startsWith('/api/'))return nativeFetch(input,init);
 const call=()=>nativeFetch('/mi-dia'+raw,{...init,headers:{...init?.headers,Authorization:'Bearer '+token}});
 let r=await call();if(r.status===401){await authenticate();r=await call();}return r;
};
authenticate().then(()=>{if(!mounted){mounted=true;createRoot(document.getElementById('root')!).render(<Home/>);}}).catch(e=>{const target=document.getElementById('access-status');if(target)target.textContent=e.message;});
