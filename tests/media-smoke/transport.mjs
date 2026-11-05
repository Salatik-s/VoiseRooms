// PCM is generated and consumed in memory. No microphone or speaker is opened.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { Room, RoomEvent, AudioSource, AudioFrame, AudioStream, LocalAudioTrack,
  TrackPublishOptions, TrackSource, EncryptionType, IceServer, IceTransportType,
  ContinualGatheringPolicy, dispose } from '@livekit/rtc-node';

const encrypted=process.argv[2]==='e2ee', mode=encrypted?'e2ee':'plain';
const output=process.env.SMOKE_RESULT;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deadline=async(promise,label,ms=15000)=>{
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(Error(label+': timeout after '+ms+'ms')),ms);
  })]);}finally{clearTimeout(timer);}
};
assert.equal(process.env.GITHUB_ACTIONS,'true','Use only the isolated CI runner');
assert.equal(process.platform,'linux');assert.ok(output);
const service=new RoomServiceClient('http://127.0.0.1:7898',process.env.SMOKE_KEY,process.env.SMOKE_SECRET);
const roomName='synthetic-'+mode+'-'+randomBytes(8).toString('hex');
const rooms=[new Room(),new Room()],readers=[],sources=[],tracks=[];
const stats=[0,1].map(()=>({frames:0,samples:0,sumSquares:0,toneFrames:0,data:0}));
const result={mode,sdk:'@livekit/rtc-node@1.2.1',syntheticOnly:true,connected:0,
  encryptedPublications:[],cryptors:[],wrongKeyControl:null,pass:false};
const sharedKey=randomBytes(32),wrongKey=randomBytes(32),marker=randomBytes(16).toString('hex');
const frequencies=[440,660];
let phase='wrong-key',wrongKeyLoudFrames=0;
const receive=(index,remote,publication)=>{
  result.encryptedPublications.push(publication.encryptionType);
  const reader=new AudioStream(remote,{sampleRate:48000,numChannels:1,frameSizeMs:20}).getReader();
  readers.push({reader,index});
  (async()=>{try{for(;;){
    const {done,value}=await reader.read();if(done)break;
    let sumSquares=0,sine=0,cosine=0;
    for(let i=0;i<value.data.length;i++){
      const sample=value.data[i],angle=2*Math.PI*frequencies[1-index]*i/48000;
      sumSquares+=sample*sample;sine+=sample*Math.sin(angle);cosine+=sample*Math.cos(angle);
    }
    const rms=Math.sqrt(sumSquares/value.data.length);
    if(phase==='wrong-key'){if(index===1&&rms>1000)wrongKeyLoudFrames++;continue;}
    const s=stats[index];s.frames++;s.samples+=value.data.length;s.sumSquares+=sumSquares;
    if(2*Math.hypot(sine,cosine)/value.data.length>5000)s.toneFrames++;
  }}catch(error){if(phase!=='cleanup')result.readError=error.message;}})();
};
const feed=async(index,count)=>{
  for(let n=0;n<count;n++){
    const pcm=new Int16Array(960);
    for(let i=0;i<960;i++)pcm[i]=Math.round(10000*Math.sin(2*Math.PI*frequencies[index]*(n*960+i)/48000));
    await sources[index].captureFrame(new AudioFrame(pcm,48000,1,960));
  }
  await sources[index].waitForPlayout();
};
const publish=async index=>{
  sources[index]=new AudioSource(48000,1,200);
  tracks[index]=LocalAudioTrack.createAudioTrack('synthetic-'+frequencies[index]+'Hz',sources[index]);
  const pub=await deadline(rooms[index].localParticipant.publishTrack(tracks[index],
    new TrackPublishOptions({source:TrackSource.SOURCE_MICROPHONE,dtx:false})),'publish');
  assert.equal(pub.encryptionType,encrypted?EncryptionType.GCM:EncryptionType.NONE);
};
const connectClient=async(i,receiverKey)=>{
    const token=new AccessToken(process.env.SMOKE_KEY,process.env.SMOKE_SECRET,{identity:'synthetic-'+i,ttl:120});
    token.addGrant({roomJoin:true,room:roomName,canPublish:true,canSubscribe:true,canPublishData:true});
    await deadline(rooms[i].connect('ws://127.0.0.1:7898',await token.toJwt(),{autoSubscribe:true,dynacast:false,
      // Explicit local STUN avoids the SDK's external STUN fallback.
      rtcConfig:{iceTransportType:IceTransportType.TRANSPORT_ALL,
        continualGatheringPolicy:ContinualGatheringPolicy.GATHER_ONCE,
        iceServers:[new IceServer({urls:['stun:127.0.0.1:7899']})]},
      ...(encrypted?{encryption:{keyProviderOptions:{sharedKey:receiverKey},
        encryptionType:EncryptionType.GCM}}:{})}),'connect');
};
const started=Date.now();
const watchdog=setTimeout(()=>{
  writeFileSync(output,JSON.stringify({...result,error:'Global native media timeout',elapsedMs:Date.now()-started},null,2));
  process.exit(1);
},90000);
try{
  await service.createRoom({name:roomName,maxParticipants:2,emptyTimeout:60});
  for(let i=0;i<2;i++){
    rooms[i].on(RoomEvent.TrackSubscribed,(remote,pub)=>receive(i,remote,pub));
    rooms[i].on(RoomEvent.DataReceived,(payload,_,__,topic)=>{
      if(topic==='synthetic-only'&&new TextDecoder().decode(payload)===marker+'-'+(1-i))stats[i].data++;
    });
    await connectClient(i,encrypted&&i===1?wrongKey:sharedKey);
    result.connected++;
  }
  await publish(0);await sleep(700);
  if(encrypted){
    await deadline(feed(0,70),'wrong-key audio');await sleep(500);
    result.wrongKeyControl={loudFrames:wrongKeyLoudFrames,pass:wrongKeyLoudFrames===0};
    assert.equal(wrongKeyLoudFrames,0,'Wrong E2EE key decoded audible synthetic frames');
    // Reconnect through the public SDK API with the correct key. No private SDK fields.
    for(const entry of readers.filter(entry=>entry.index===1))await entry.reader.cancel();
    await deadline(rooms[1].disconnect(),'wrong-key disconnect');
    await connectClient(1,sharedKey);
    result.reconnectedWithCorrectKey=true;
    await sleep(700);
  }
  await publish(1);await sleep(700);phase='correct-key';
  await Promise.all(rooms.map((room,index)=>deadline(room.localParticipant.publishData(
    new TextEncoder().encode(marker+'-'+index),{reliable:true,topic:'synthetic-only'}),'data')));
  await deadline(Promise.all([feed(0,200),feed(1,200)]),'bidirectional audio',12000);
  await sleep(700);
  result.receivers=stats.map(s=>({frames:s.frames,samples:s.samples,toneFrames:s.toneFrames,
    rms:Math.round(Math.sqrt(s.sumSquares/Math.max(1,s.samples))),data:s.data}));
  result.cryptors=rooms.map(room=>room.e2eeManager?.frameCryptors().map(c=>({enabled:c.enabled,keyIndex:c.keyIndex}))??[]);
  for(const receiver of result.receivers){
    assert.ok(receiver.frames>=100,'Too few received audio frames');
    assert.ok(receiver.toneFrames>=100,'Expected synthetic frequency was not decoded');
    assert.ok(receiver.rms>1000,'Received audio is silent');
    assert.equal(receiver.data,1,'Reliable data did not arrive exactly once');
  }
  if(encrypted){
    assert.ok(result.encryptedPublications.length>=2);
    assert.ok(result.encryptedPublications.every(type=>type===EncryptionType.GCM));
    assert.ok(result.cryptors.every(list=>list.length>=2&&list.every(c=>c.enabled)));
  }
  assert.equal(result.readError,undefined);result.pass=true;
}catch(error){result.error=error.message;}
finally{
  phase='cleanup';
  for(const {reader} of readers)try{await deadline(reader.cancel(),'cancel',2000);}catch{}
  for(const track of tracks)try{await track?.close();}catch{}
  for(const source of sources)try{await source?.close();}catch{}
  for(const room of rooms)try{await deadline(room.disconnect(),'disconnect',3000);}catch{}
  try{await service.deleteRoom(roomName);result.roomDeleted=true;}catch(error){result.cleanupError=error.message;result.pass=false;}
  try{await dispose();}catch{}
  clearTimeout(watchdog);result.elapsedMs=Date.now()-started;
  writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  process.exit(result.pass?0:1);
}

