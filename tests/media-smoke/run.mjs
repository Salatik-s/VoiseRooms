import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform,'linux','This fixture runs only in the ephemeral Linux CI runner');
assert.equal(process.env.GITHUB_ACTIONS,'true','No local or production server may be used');
assert.ok(process.env.LIVEKIT_BINARY,'Verified LiveKit binary path is required');
const directory=fileURLToPath(new URL('.',import.meta.url));
const evidence=join(directory,'evidence');mkdirSync(evidence,{recursive:true});
const temporary=mkdtempSync(join(tmpdir(),'voicerooms-media-ci-'));
const lan=Object.values(networkInterfaces()).flat().find(address=>address.family==='IPv4'&&!address.internal
  && /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(address.address))?.address;
assert.ok(lan,'A private runner interface is required for ICE; do not expose the user host');
const key='ci-'+randomBytes(12).toString('hex'),secret=randomBytes(40).toString('hex');
console.log('::add-mask::'+key);console.log('::add-mask::'+secret);
const configuration=join(temporary,'livekit.yaml');
writeFileSync(configuration,[
  'port: 7898','bind_addresses: ["0.0.0.0"]','rtc:',
  '  tcp_port: 7900','  udp_port: 7899','  use_external_ip: false',
  '  node_ip: '+lan,'keys:','  '+key+': '+secret,'logging:','  level: info','',
].join('\n'),{mode:0o600});
const serverLog=join(temporary,'server.log'),serverOutput=createWriteStream(serverLog);
const server=spawn(resolve(process.env.LIVEKIT_BINARY),['--config',configuration],{stdio:['ignore','pipe','pipe']});
server.stdout.pipe(serverOutput);server.stderr.pipe(serverOutput,{end:false});
let serverError;
server.on('error',error=>serverError=error);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const runClient=mode=>new Promise(resolvePromise=>{
  const log=createWriteStream(join(temporary,mode+'.log'));
  const child=spawn(process.execPath,[join(directory,'transport.mjs'),mode],{
    cwd:directory,env:{...process.env,NODE_ENV:'production',SMOKE_KEY:key,SMOKE_SECRET:secret,
      SMOKE_RESULT:join(evidence,mode+'.json')},stdio:['ignore','pipe','pipe'],
  });
  child.stdout.pipe(log);child.stderr.pipe(log,{end:false});
  const timer=setTimeout(()=>child.kill('SIGKILL'),100000);
  child.once('error',error=>{clearTimeout(timer);log.end();resolvePromise({code:null,error:error.message});});
  child.once('exit',(code,signal)=>{clearTimeout(timer);log.end();resolvePromise({code,signal});});
});
const report={serverVersion:'1.13.11',serverSha256:'1e9ee90ca301e1842b2887fc77cb122759756a9c8aeb4334ee91de3325ec43fb',
  sdkVersion:'1.2.1',syntheticOnly:true,environment:'ephemeral GitHub Linux runner',tests:[]};
let failed=false;
try{
  let ready=false;
  for(let i=0;i<60;i++){
    if(serverError)throw serverError;
    if(server.exitCode!==null)throw Error('Local LiveKit exited before readiness');
    try{const response=await fetch('http://127.0.0.1:7898/',{signal:AbortSignal.timeout(500)});ready=response.ok;}catch{}
    if(ready)break;await pause(250);
  }
  assert.ok(ready,'Local LiveKit did not become ready');
  for(const mode of ['plain','e2ee']){
    const execution=await runClient(mode);
    let result;
    try{result=JSON.parse(readFileSync(join(evidence,mode+'.json'),'utf8'));}
    catch{result={mode,pass:false,error:'Native child did not produce a result'};}
    result.childExit=execution.code;result.childSignal=execution.signal;
    if(execution.error)result.childError=execution.error;
    const pass=execution.code===0&&result.pass===true;
    report.tests.push(result);if(!pass)failed=true;
    console.log(mode+': '+(pass?'PASS':'FAIL')+' '+JSON.stringify(result.receivers??{error:result.error}));
  }
}catch(error){failed=true;report.error=error.message;}
finally{
  server.kill('SIGTERM');
  if(server.exitCode===null)await Promise.race([new Promise(r=>server.once('exit',r)),pause(3000)]);
  if(server.exitCode===null)server.kill('SIGKILL');
  serverOutput.end();
  // Artifacts deliberately omit raw SDP, ICE credentials, tokens and temporary configuration.
  try{
    const text=readFileSync(serverLog,'utf8');
    report.serverEvents={rtcSessions:(text.match(/starting RTC session/g)??[]).length,
      joined:(text.match(/participant active/g)??[]).length,
      connectionFailures:(text.match(/connection failed/g)??[]).length};
  }catch{}
  report.pass=!failed;writeFileSync(join(evidence,'summary.json'),JSON.stringify(report,null,2));
  rmSync(temporary,{recursive:true,force:true});
}
process.exitCode=failed?1:0;

