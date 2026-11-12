/** Isolated scripted authority/model, never an image payload entrypoint.
 * Limits are explicit fixture operator pins, not provider capacity evidence. */
export const authorityScript = String.raw`
let minted=0,revoked=false,inference=0,toolObserved=false;
const reservation=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){return new Response(null,{status:503})}});
const controlPort=reservation.port;
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
 const path=new URL(request.url).pathname,auth=request.headers.get("authorization");
 if(path==="/fixture-stats")return Response.json({minted,revoked,inference,toolObserved});
 if(path==="/fixture-release-control"){reservation.stop(true);return Response.json({ok:true})}
 if(path==="/v1/fleet/whoami"){
  const scopes=auth==="Bearer fixture-mint"?["buckle:admin:WRITE_","buckle:proxy:READ_"]:
   auth==="Bearer fixture-owner"?["buckle:runner:WRITE_"]:auth==="Bearer fixture-reader"?["buckle:runner:READ_"]:[];
  return scopes.length?Response.json({authenticated:true,kind:"api_key",key_id:auth.slice(7),team:null,actor:null,scopes}):new Response(null,{status:401});
 }
 if(path==="/v1/models"&&auth==="Bearer fixture-mint")return Response.json({object:"list",data:[{
  id:"fixture",object:"model",owned_by:"fixture",context_length:16384,max_output_tokens:1024,reasoning:false,capability_source:"operator-pinned"}]});
 if(path==="/v1/admin/keys"&&request.method==="POST"&&auth==="Bearer fixture-mint"){
  minted++;return Response.json({key_id:"fixture-run",key:"fixture-model-key",name:"fixture",scopes:["buckle:proxy:WRITE_"],expires_at:Date.now()+3600000},{status:201});
 }
 if(path==="/v1/admin/keys/fixture-run/revoke"&&request.method==="POST"&&auth==="Bearer fixture-mint"){
  revoked=true;return Response.json({revoked:"fixture-run"});
 }
 if(path==="/v1/chat/completions"&&request.method==="POST"&&auth==="Bearer fixture-model-key"&&!revoked){
  const body=await request.json();inference++;
  if(inference===2)toolObserved=JSON.stringify(body.messages).includes("HOST_FIXTURE_SEED_MARKER");
  const delta=inference===1?{tool_calls:[{index:0,id:"call-fixture",type:"function",function:{name:"desktop_sandbox_exec",arguments:JSON.stringify({argv:["cat","/seed/marker"]})}}]}:{content:"done"};
  const chunks=[{choices:[{index:0,delta,finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:inference===1?"tool_calls":"stop"}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}}];
  return new Response(chunks.map(c=>"data: "+JSON.stringify({id:"fixture-"+inference,object:"chat.completion.chunk",created:1,model:"fixture",...c})+"\n\n").join("")+"data: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}});
 }
 return new Response(null,{status:403});
}});console.log(JSON.stringify({port:server.port,controlPort}));
`;
