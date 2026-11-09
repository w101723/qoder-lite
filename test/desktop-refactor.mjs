import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CredentialManager, jobExpiry } from "../src/credentialManager.js";
import { sessionFor, taskFor } from "../src/session.js";
import { modelForRequest } from "../src/modelConfig.js";
import { normalizeToolTurns } from "../src/toolCalls.js";
import { ToolStreamParser } from "../src/toolStream.js";

const folder = await fs.mkdtemp(path.join(os.tmpdir(), "ql-auth-"));
try {
  let exchanges = 0, refreshes = 0;
  const api = async (url, options) => {
    if (url.endsWith("/api/v1/jobToken/exchange")) {
      exchanges++;
      return new Response(JSON.stringify({token: "jt-initial", refresh_token: "r1", expires_in: 3600000}));
    }
    if (url.endsWith("/api/v1/userinfo")) return new Response(JSON.stringify({id:"user-id", email:"u@example.com"}));
    if (url.endsWith("/api/v1/jobToken/refresh")) {
      refreshes++;
      assert.equal(JSON.parse(options.body).refresh_token,"r1");
      return new Response(JSON.stringify({token:"jt-renewed",refresh_token:"r2",expires_in:3600000}));
    }
    throw Error("unexpected endpoint " + url);
  };
  const file = path.join(folder, "auth.json");
  const manager = new CredentialManager({pat:"pt-test",authFile:file,fetchImpl:api,region:"INTL"});
  const first = await manager.resolve();
  assert.equal(first.accessToken,"jt-initial");
  assert.equal((await manager.resolve()).providerSpecificData.machineId,first.providerSpecificData.machineId);
  const restarted = new CredentialManager({pat:"pt-test",authFile:file,fetchImpl:api,region:"INTL"});
  const restored = await restarted.resolve();
  assert.equal(restored.accessToken,"jt-initial");
  assert.equal(restored.providerSpecificData.machineId,first.providerSpecificData.machineId);
  await restarted.resolve({forceRefresh:true});
  assert.equal((await restarted.resolve()).accessToken,"jt-renewed");
  assert.equal(exchanges,1);
  assert.equal(refreshes,1);
  assert.ok(jobExpiry({expires_in:1000}) > Date.now()+800);
  assert.equal((await fs.stat(file)).mode & 0o777,0o600);

  const messages=[{role:"user",content:"start"},{role:"assistant",tool_calls:[{type:"function",function:{name:"run",arguments:"{}"}}]},{role:"tool",content:"ok"}];
  const normalized=normalizeToolTurns(messages);
  assert.equal(normalized[1].tool_calls[0].id,normalized[2].tool_call_id);
  const sid=sessionFor({messages},first.providerSpecificData.userId);
  assert.equal(sid,sessionFor({messages},first.providerSpecificData.userId));
  assert.notEqual(sid,sessionFor({messages:[{role:"user",content:"other"}]},first.providerSpecificData.userId));
  const task=taskFor(sid,messages);
  assert.equal(task,taskFor(sid,messages));
  const raw={key:"dfmodel",display_name:"Flash",source:"system",is_reasoning:true,thinking_config:{enabled:{efforts:{low:{},high:{is_default:true}}},disabled:{}}};
  const low=modelForRequest(raw,{reasoning_effort:"low"});
  assert.equal(low.parameters.reasoning_effort,"low");
  assert.equal(low.parameters.enable_thinking,true);
  assert.equal(low.config.model,"");
  assert.equal(low.config.thinking_config,undefined);
  assert.equal(modelForRequest(raw,{reasoning_effort:"none"}).parameters.enable_thinking,false);
  const parser=new ToolStreamParser([{type:"function",function:{name:"ping",parameters:{type:"object",properties:{name:{type:"string"}}}}}]);
  assert.deepEqual(parser.feed("hi <tool_cal").map(x=>x.text),["hi "]);
  const p1=parser.feed('l>{"name":"ping","arguments":{"name":"foo"}}');
  assert.equal(p1.length,0);
  const p2=parser.feed("</tool_call>");
  assert.equal(p2[0].name,"ping");
  assert.equal(p2[0].args,'{"name":"foo"}');
  assert.equal(parser.calls,1);
  assert.deepEqual(parser.feed("",true),[]);
  const parser2=new ToolStreamParser([{type:"function",function:{name:"ping",parameters:{type:"object",properties:{name:{type:"string"}}}}}]);
  const got=parser2.feed('<function=ping><parameter=name>hello</parameter></function>');
  assert.equal(got[0].name,"ping");
  assert.equal(got[0].args,'{"name":"hello"}');


// Request identity and deterministic task lifetime: the same tool-loop
// must retain its request_set_id, even if the normalized reply has images.
{
  const source = [{role:"user",content:"review files"},{role:"assistant",tool_calls:[{type:"function",function:{name:"read",arguments:"{}"}}]},{role:"tool",content:"done"}];
  const session = sessionFor({messages:source},"u");
  const first = taskFor(session,source);
  const second = taskFor(session,source);
  assert.equal(first.id,second.id);
  assert.equal(modelForRequest({key:"abc",is_reasoning:true,context_config:{"200K":{token_count:200000,is_default:true},"400K":{token_count:400000}}},{messages:source}).parameters.context_length,200000);
  const credsFile = path.join(folder,"device.json");
  let oauthCalls=0;
  const userAPI=async (url)=>{
    if (url.endsWith("/api/v1/userinfo")) return new Response(JSON.stringify({id:"uid0",name:"Account"}));
    if (url.endsWith("/api/v1/me/jobToken")) return new Response(JSON.stringify({token:"jt-device",refresh_token:"jr-device",expires_in:3600000}));
    throw Error(url);
  };
  const dm=new CredentialManager({authFile:credsFile,fetchImpl:userAPI,region:"INTL",loginImpl:async()=>({accessToken:"dt-device",refreshToken:"dr-device",userId:"uid0"})});
  const before=process.env.QODER_OPEN_BROWSER;
  process.env.QODER_OPEN_BROWSER="0";
  try {
    await dm.initiate();
    const cred=await dm.resolve();
    assert.equal(cred.accessToken,"jt-device");
    assert.ok(cred.providerSpecificData.machineId);
    const reload = new CredentialManager({authFile:credsFile,fetchImpl:userAPI,region:"INTL"});
    assert.equal((await reload.resolve()).providerSpecificData.machineId, cred.providerSpecificData.machineId);
  } finally {
    if (before === undefined) delete process.env.QODER_OPEN_BROWSER;
    else process.env.QODER_OPEN_BROWSER=before;
  }
}



// Native OpenAI tool calls can send their id/argument fragments ahead of the
// function name. They must not be surfaced as unnamed tools.
{
  const { unwrapQoderSSEResponse } = await import("../src/chat.js");
  const tools=[{type:"function",function:{name:"ping",parameters:{type:"object",properties:{}}}}];
  const make = (delta,finish_reason=null) => {
    const body = JSON.stringify({choices:[{index:0,delta,finish_reason}]});
    return "data: " + JSON.stringify({statusCodeValue:200,body}) + "\n\n";
  };
  const parts=[
    make({tool_calls:[{index:0,id:"call-native",function:{arguments:'{"v":'}}]}),
    make({tool_calls:[{index:0,function:{name:"ping",arguments:"1}"}}]}),
    make({}, "tool_calls"),
    "data: "+JSON.stringify({statusCodeValue:200,body:"[DONE]"})+"\n\n",
  ];
  const result=await unwrapQoderSSEResponse(new Response(parts.join(""),{headers:{"Content-Type":"text/event-stream"}}),"dfmodel",tools);
  const data=(await result.text()).split("\n").filter((v)=>v.startsWith("data:")&&v.trim()!=="data: [DONE]").map((v)=>JSON.parse(v.slice(5)));
  const called=data.flatMap((v)=>v.choices?.[0]?.delta?.tool_calls||[]);
  assert.equal(called.length,1);
  assert.equal(called[0].function.name,"ping");
  assert.equal(called[0].function.arguments,'{"v":1}');
  assert.equal(called[0].id,"call-native");
}

  console.log("desktop refactor tests passed");
} finally {
  await fs.rm(folder,{recursive:true,force:true});
}
