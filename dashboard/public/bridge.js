// Loaded by the existing GHL app's Custom JS module, never through native srcdoc.
(()=>{
 const locationId='cd9Slb2Fk2vNY3l4ukG9',origin='https://bdc.1987marketing.com';
 if(window.location.origin!=='https://app.1987marketing.com')return;
 window.addEventListener('message',async event=>{
  if(!window.location.pathname.startsWith('/v2/location/'+locationId+'/')||event.origin!==origin||event.data?.message!=='REQUEST_USER_DATA')return;
  const frame=[...document.querySelectorAll('iframe')].find(frame=>frame.contentWindow===event.source&&frame.src.startsWith(origin+'/mi-dia/'));
  if(!frame||typeof window.exposeSessionDetails!=='function')return;
  try{const payload=await window.exposeSessionDetails('6a84ce51032e61130732e5cd');if(typeof payload==='string')frame.contentWindow.postMessage({message:'REQUEST_USER_DATA_RESPONSE',payload},origin);}catch{/* The panel remains locked. */}
 });
})();
