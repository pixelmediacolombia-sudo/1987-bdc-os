// Loaded by the existing GHL app's Custom JS module, never through native srcdoc.
(()=>{
 const locationId='cd9Slb2Fk2vNY3l4ukG9',origin='https://bdc.1987marketing.com';
 if(window.location.origin!=='https://app.1987marketing.com')return;
 const openDay=async()=>{
  const base='/v2/location/'+locationId,path=window.location.pathname;
  if(![base,base+'/',base+'/launchpad',base+'/dashboard'].includes(path)||typeof window.exposeSessionDetails!=='function')return;
  try{const encryptedData=await window.exposeSessionDetails('6a84ce51032e61130732e5cd');const response=await fetch(origin+'/mi-dia/entry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({encryptedData}),credentials:'omit'});if(!response.ok)return;const {entry}=await response.json();if(entry===base+'/dashboard/6add8337dc4b01c8b1e5bd51')window.location.replace(entry);}catch{/* Other users keep their normal landing page. */}
 };
 void openDay();
 window.addEventListener('message',async event=>{
  if(!window.location.pathname.startsWith('/v2/location/'+locationId+'/')||event.origin!==origin||event.data?.message!=='REQUEST_USER_DATA')return;
  const frame=[...document.querySelectorAll('iframe')].find(frame=>frame.contentWindow===event.source&&frame.src.startsWith(origin+'/mi-dia/'));
  if(!frame||typeof window.exposeSessionDetails!=='function')return;
  try{const payload=await window.exposeSessionDetails('6a84ce51032e61130732e5cd');if(typeof payload==='string')frame.contentWindow.postMessage({message:'REQUEST_USER_DATA_RESPONSE',payload},origin);}catch{/* The panel remains locked. */}
 });
})();
