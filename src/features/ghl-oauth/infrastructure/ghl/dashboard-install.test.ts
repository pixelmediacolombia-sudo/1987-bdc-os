import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import express from "express";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { GhlOAuthClientAdapter } from "./ghl-oauth.client";
import type { AppConfig } from "../config/env.config";
import { GhlOAuthController } from "../../presentation/http/ghl-oauth.controller";
import { createGhlOAuthRouter } from "../../presentation/http/ghl-oauth.routes";
import type { GhlOAuthPresentationService } from "../../presentation/services/ghl-oauth.presentation.service";

const lucki="cd9Slb2Fk2vNY3l4ukG9",redirectUri="https://one987-bdc-os.onrender.com/oauth/callback";
const config={ghlTokenUrl:"https://services.leadconnectorhq.com/oauth/token",ghlClientId:"synthetic-client",ghlClientSecret:"synthetic-secret"} as AppConfig;

test("Marketplace receipt verifies provider code, exact read scope and only Lucki",async()=>{
 const original=axios.defaults.adapter;let payload:Record<string,unknown>={access_token:"synthetic-token",scope:"users.readonly",locationId:lucki};let posts=0;
 axios.defaults.adapter=async request=>{posts++;const body=new URLSearchParams(request.data);assert.equal(body.get("redirect_uri"),redirectUri);assert.equal(body.get("grant_type"),"authorization_code");return {data:payload,status:200,statusText:"OK",headers:{},config:request};};
 try{
  const client=new GhlOAuthClientAdapter(config);
  assert.equal(await client.verifyDashboardInstall("synthetic-code",redirectUri),undefined);
  payload={access_token:"synthetic-token",scope:"users.readonly",userType:"Company",approvedLocations:[lucki]};await client.verifyDashboardInstall("synthetic-code",redirectUri);
  for(const invalid of [
   {scope:"users.readonly conversations/message.write",locationId:lucki},
   {scope:"users.readonly",locationId:"other-dealer"},
   {scope:"users.readonly",userType:"Company",approvedLocations:[lucki,"other-dealer"]},
   {scope:"users.readonly",locationId:lucki,installToFutureLocations:true},
  ]){payload={access_token:"synthetic-token",...invalid};await assert.rejects(client.verifyDashboardInstall("synthetic-code",redirectUri));}
  assert.equal(posts,6);
  payload={access_token:"synthetic-company-token",scope:"users.readonly",userType:"Company",companyId:"synthetic-company"};
  axios.defaults.adapter=async request=>{
   assert.equal(request.url,config.ghlTokenUrl,"installation receipt must not request location tokens or expanded permissions");
   return {data:payload,status:200,statusText:"OK",headers:{},config:request};
  };
  await client.verifyDashboardInstall("synthetic-code",redirectUri);
  payload={...payload,approvedLocations:[]};await client.verifyDashboardInstall("synthetic-code",redirectUri);
 }finally{axios.defaults.adapter=original;}
});

test("code-only callback is a receipt, not a login or a state-validation fallback",async()=>{
 let receipts=0,legacy=0;
 const service={complete:async()=>{legacy++;throw Error("invalid state");}} as unknown as GhlOAuthPresentationService;
 const controller=new GhlOAuthController(service,async(code,url)=>{receipts++;assert.equal(code,"synthetic-code");assert.equal(url,redirectUri);});
 const app=express();app.use("/oauth",createGhlOAuthRouter(controller));const server=app.listen(0,"127.0.0.1");await once(server,"listening");
 const address=server.address();if(!address||typeof address==="string")throw Error("test server failed");const base="http://127.0.0.1:"+address.port;
 const call=(query:string,host="one987-bdc-os.onrender.com")=>new Promise<Response>((resolve,reject)=>{
  const request=httpRequest(base+"/oauth/callback"+query,{headers:{Host:host}},response=>{
   const chunks:Buffer[]=[];response.on("data",part=>chunks.push(Buffer.from(part)));response.on("end",()=>{
    const headers:Record<string,string>={};for(const[key,value]of Object.entries(response.headers))if(value!==undefined)headers[key]=Array.isArray(value)?value.join(","):value;
    resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers}));
   });
  });request.on("error",reject);request.end();
 });
 try{
  const receipt=await call("?code=synthetic-code");assert.equal(receipt.status,303);assert.equal(receipt.headers.get("set-cookie"),null);assert.match(receipt.headers.get("location")!,/\/location\/cd9Slb2Fk2vNY3l4ukG9\/dashboard\//);assert.equal(receipts,1);assert.equal(legacy,0);
  assert.equal((await call("?code=synthetic-code","untrusted.example")).status,400);
  assert.equal((await call("?code=synthetic-code&state=")).status,400);
  assert.equal((await call("?code=synthetic-code&state=invalid")).status,500);assert.equal(legacy,1);assert.equal(receipts,1);
  assert.equal((await call("")).status,400);
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
