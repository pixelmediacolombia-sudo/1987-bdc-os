import {createHash,createDecipheriv,randomBytes} from 'node:crypto';
export const LOCATION='cd9Slb2Fk2vNY3l4ukG9';
export const AGENT='bNf6DGx9F0ZWT8pYbIro';
export const ORIGIN='https://app.1987marketing.com';
export function decryptContext(encoded,secret){
 if(typeof encoded!=='string'||encoded.length>16384||!secret)throw Error('invalid_context');
 const data=Buffer.from(encoded,'base64');
 if(data.length<32||data.subarray(0,8).toString()!=='Salted__')throw Error('invalid_context');
 const salt=data.subarray(8,16),password=Buffer.from(secret);let out=Buffer.alloc(0),previous=Buffer.alloc(0);
 while(out.length<48){previous=createHash('md5').update(Buffer.concat([previous,password,salt])).digest();out=Buffer.concat([out,previous]);}
 const decipher=createDecipheriv('aes-256-cbc',out.subarray(0,32),out.subarray(32,48));
 const user=JSON.parse(Buffer.concat([decipher.update(data.subarray(16)),decipher.final()]).toString('utf8'));
 if(user.activeLocation!==LOCATION||typeof user.userId!=='string')throw Error('scope');
 // Identity comes only from the app-specific encrypted GHL context, never URL parameters.
 const owner=user.isAgencyOwner===true&&String(user.email).toLowerCase()==='pixelmediacolombia@gmail.com';
 if(user.userId!==AGENT&&!owner)throw Error('scope');
 return {userId:user.userId,locationId:LOCATION};
}
export function createSessions(now=Date.now){
 const sessions=new Map();
 return {
  issue(user){for(const [k,v]of sessions)if(v.expires<=now())sessions.delete(k);if(sessions.size>=200)throw Error('capacity');const token=randomBytes(32).toString('base64url');sessions.set(token,{...user,expires:now()+1800000});return token;},
  verify(token){const s=sessions.get(token);if(!s||s.expires<=now()){sessions.delete(token);return null;}return s;}
 };
}
