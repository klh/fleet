/** Fixed, dependency-free guest program. No model text is evaluated as code.
 * Under setsid --wait it owns its live process group and signals only itself.
 * The host validates the same bounded control values through named Zod schemas. */
export const GUARDIAN = String.raw`
const {spawn}=require('node:child_process');
const {readFileSync}=require('node:fs');
const {StringDecoder}=require('node:string_decoder');
const fields=readFileSync('/proc/self/stat','utf8').replace(/^.*\) /,'').trim().split(' ');
const pid=process.pid;
if(Number(fields[2])!==pid || Number(fields[3])!==pid || pid<=1) process.exit(125);
let child, started=false, ending=false, pending='';
const decoder=new StringDecoder('utf8');
function reap(){process.kill(-pid,'SIGKILL');}
function frame(value, done){process.stdout.write(JSON.stringify(value)+'\n',done);}
function refuse(){if(!ending){ending=true;frame({type:'error',code:'invalid-control'},reap);}}
function output(stream, bytes){
 for(let i=0;i<bytes.length;i+=16384){
  if(!process.stdout.write(JSON.stringify({type:'output',stream,data:bytes.subarray(i,i+16384).toString('base64')})+'\n')){
   child?.stdout.pause();child?.stderr.pause();
   process.stdout.once('drain',()=>{child?.stdout.resume();child?.stderr.resume();});
  }
 }
}
function message(value){
 if(!value || typeof value!=='object' || Array.isArray(value)) return refuse();
 if(value.type==='cancel' && Object.keys(value).length===1) return reap();
 if(started || value.type!=='start' || Object.keys(value).sort().join(',')!=='argv,stdin,type') return refuse();
 if(!Array.isArray(value.argv)||!value.argv.length||value.argv.length>256||value.argv.some(x=>typeof x!=='string'||x.includes('\0')||Buffer.byteLength(x)>8192)||value.argv.reduce((n,x)=>n+Buffer.byteLength(x),0)>65536||!value.argv[0]) return refuse();
 if(typeof value.stdin!=='string'||Buffer.byteLength(value.stdin)>65536) return refuse();
 started=true;
 child=spawn(value.argv[0],value.argv.slice(1),{stdio:['pipe','pipe','pipe'],detached:false});
 child.stdin.on('error',()=>{});child.stdin.end(value.stdin);
 child.stdout.on('data',b=>output('stdout',b));child.stderr.on('data',b=>output('stderr',b));
 child.once('error',()=>{if(!ending){ending=true;frame({type:'exit',code:127},reap);}});
 child.once('close',(code)=>{if(!ending){ending=true;frame({type:'exit',code:code??1},reap);}});
}
process.stdin.on('data',bytes=>{pending+=decoder.write(bytes);if(Buffer.byteLength(pending)>524288)return refuse();let n;while((n=pending.indexOf('\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);try{message(JSON.parse(line));}catch{return refuse();}}});
process.stdin.once('end',reap);process.stdin.once('error',reap);
frame({type:'ready',pid,pgrp:Number(fields[2]),session:Number(fields[3]),startTime:fields[19]});
`;
