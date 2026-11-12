/** Isolated scripted authority/model, never an image payload entrypoint.
 * Limits are explicit fixture operator pins, not provider capacity evidence. */
const authorityProgram = String.raw`
let minted=0,revoked=false,inference=0,toolObserved=false;
let sequence=0;const keys=new Map(),events=[],observations={};
const event=(kind,keyId)=>{const seq=++sequence;events.push({sequence:seq,kind,keyId});return seq};
const hash=value=>new Bun.CryptoHasher("sha256").update(value).digest("hex");
const normalized=messages=>messages.filter(message=>message.role!=="system"&&message.role!=="developer").map(({role,content,tool_calls,tool_call_id})=>({role,content,tool_calls,tool_call_id}));
let priorMessages=[];
function reply(delta,tool=false){
 const chunks=[{choices:[{index:0,delta,finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:tool?"tool_calls":"stop"}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}}];
 return new Response(chunks.map(c=>"data: "+JSON.stringify({id:"fixture-"+inference,object:"chat.completion.chunk",created:1,model:"fixture",...c})+"\n\n").join("")+"data: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}});
}
const tool=(id,argv)=>reply({tool_calls:[{index:0,id,type:"function",function:{name:"desktop_sandbox_exec",arguments:JSON.stringify({argv})}}]},true);
function continuity(body,key){
 const messages=Array.isArray(body.messages)?body.messages:[],user=[...messages].reverse().find(m=>m.role==="user");
 const text=JSON.stringify(user?.content??""),phase=text.includes(options.nextPrompt)?"after":text.includes(options.firstPrompt)?"before":null;
 if(!phase)return new Response(null,{status:400});
 const id=phase==="before"?"call-before-park":"call-after-resume",last=[...messages].reverse().find(m=>m.role==="tool");
 const current=normalized(messages);
 if(phase==="after"){
  observations.resumedPriorConversationSha256=hash(JSON.stringify(current.slice(0,priorMessages.length)));
  observations.continuedConversationSha256=hash(JSON.stringify(current));
  observations.priorJournalContent=JSON.stringify(messages).includes(options.firstPrompt)&&JSON.stringify(messages).includes("BEFORE_PARK_REPLY");
  observations.continuedConversation=JSON.stringify(messages).includes(options.nextPrompt);
 }
 if(last?.tool_call_id!==id)return phase==="before"?
  tool(id,["/usr/local/bin/bun","-e","await Bun.write('/workspace/continuity-marker',"+JSON.stringify(options.marker)+");console.log(await Bun.file('/workspace/continuity-marker').text())"]):
  tool(id,["cat","/workspace/continuity-marker"]);
 const marker=JSON.stringify(last.content).match(/WORKSPACE_WITNESS_[a-f0-9-]{36}/)?.[0]??"";
 observations[phase]={toolCallId:id,markerSha256:hash(marker),matched:marker===options.marker,keyId:key.id};
 if(phase==="before"&&!priorMessages.length){priorMessages=current;observations.priorConversationSha256=hash(JSON.stringify(current))}
 return reply({content:phase==="before"?"BEFORE_PARK_REPLY":"AFTER_RESUME_REPLY"});
}
const reservation=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){return new Response(null,{status:503})}});
const controlPort=reservation.port;
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
 const path=new URL(request.url).pathname,auth=request.headers.get("authorization");
 if(path==="/fixture-stats")return Response.json(options.mode==="basic"?{minted,revoked,inference,toolObserved}:
  {minted,inference,keys:[...keys.values()],events,observations});
 if(path==="/fixture-release-control"){reservation.stop(true);return Response.json({ok:true})}
 if(path==="/v1/fleet/whoami"){
  const scopes=auth==="Bearer fixture-mint"?["buckle:admin:WRITE_","buckle:proxy:READ_"]:
   auth==="Bearer fixture-owner"?["buckle:runner:WRITE_"]:auth==="Bearer fixture-reader"?["buckle:runner:READ_"]:[];
  return scopes.length?Response.json({authenticated:true,kind:"api_key",key_id:auth.slice(7),team:null,actor:null,scopes}):new Response(null,{status:401});
 }
 if(path==="/v1/models"&&auth==="Bearer fixture-mint")return Response.json({object:"list",data:[{
  id:"fixture",object:"model",owned_by:"fixture",context_length:16384,max_output_tokens:1024,reasoning:false,capability_source:"operator-pinned"}]});
 if(path==="/v1/admin/keys"&&request.method==="POST"&&auth==="Bearer fixture-mint"){
  minted++;const id=options.mode==="basic"?"fixture-run":"fixture-run-"+minted;
  const key=options.mode==="basic"?"fixture-model-key":"fixture-model-key-"+minted;
  keys.set(key,{id,active:true,issuedSequence:event("key-issued",id),revokedSequence:null});
  return Response.json({key_id:id,key,name:"fixture",scopes:["buckle:proxy:WRITE_"],expires_at:Date.now()+3600000},{status:201});
 }
 const revoke=/^\/v1\/admin\/keys\/([^/]+)\/revoke$/.exec(path);
 if(revoke&&request.method==="POST"&&auth==="Bearer fixture-mint"){
  const key=[...keys.values()].find(key=>key.id===revoke[1]);if(!key)return new Response(null,{status:404});
  if(key.active){key.active=false;key.revokedSequence=event("key-revoked",key.id)}
  else event("key-revoked-again",key.id);
  revoked=true;return Response.json({revoked:key.id});
 }
 if(path==="/v1/chat/completions"&&request.method==="POST"){
  const key=keys.get(auth?.startsWith("Bearer ")?auth.slice(7):"");
  if(!key?.active){if(key)event("model-denied",key.id);return new Response(null,{status:403})}
  const body=await request.json();inference++;event("model-used",key.id);
  if(options.mode==="continuity")return continuity(body,key);
  if(inference===2)toolObserved=JSON.stringify(body.messages).includes("HOST_FIXTURE_SEED_MARKER");
  return inference===1?tool("call-fixture",["cat","/seed/marker"]):reply({content:"done"});
 }
 return new Response(null,{status:403});
}});console.log(JSON.stringify({port:server.port,controlPort}));
`;

export interface ContinuityAuthorityOptions {
	marker: string;
	firstPrompt: string;
	nextPrompt: string;
}
function authority(
	options: {
		mode: "basic" | "continuity";
	} & Partial<ContinuityAuthorityOptions>,
) {
	return `const options=${JSON.stringify(options)};\n${authorityProgram}`;
}
export const authorityScript = authority({ mode: "basic" });
export const continuityAuthorityScript = (
	options: ContinuityAuthorityOptions,
) => authority({ ...options, mode: "continuity" });
