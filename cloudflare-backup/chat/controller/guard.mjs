import {DurableObject,WorkerEntrypoint} from 'cloudflare:workers';
import {queryFrom,checkChatStop} from '../validation/stop.mjs';
import {runpodClient} from './runpod.mjs';
import {podMatches,validatePod} from './session-policy.mjs';
const stub=env=>env.STOP_RESERVATION.getByName('one-active-chat-v1');
// One independent namespace per stop Worker. No controller service is needed
// to read a live reservation, stop its Pod, or clean up its temporary disk.
export class StopReservation extends DurableObject {
  async arm(input){
    if(this.env.GUARD_ARM_ENABLED!=='true')throw Error('Guard arming is locked');
    const q=input?.reservation;queryFrom(JSON.stringify(q));
    if(q.kind!=='chat'||Object.keys(q).sort().join()!=='image,kind,name,windowEnd,windowStart'||typeof input.key!=='string'||input.key.length<16)throw Error('Invalid guard arm');
    await this.ctx.storage.transaction(async tx=>{
      const prior=await tx.get('active');
      if(prior){if(prior.reservation.name===q.name)return;throw Error('Another reservation is armed');}
      await tx.put('active',{reservation:q,key:input.key,seen:[],deleted:[],leaseUntil:0});await tx.setAlarm(Date.now()+100);
    });return {armed:true,name:q.name};
  }
  async shorten(name,at){
    if(!Number.isFinite(at)||at>Date.now()+1000)throw Error('Invalid early stop');
    await this.ctx.storage.transaction(async tx=>{const s=await tx.get('active');if(!s||s.reservation.name!==name)throw Error('Reservation changed');s.reservation.earlyStopAt=new Date(Math.min(Date.parse(s.reservation.earlyStopAt??'9999-01-01T00:00:00Z'),at)).toISOString();await tx.put('active',s);await tx.setAlarm(Date.now()+100);});return {shortened:true};
  }
  async report(){const s=await this.ctx.storage.get('active'),r=await this.ctx.storage.get('lastReport');return {armed:!!s,name:s?.reservation.name??r?.name??null,deleted:s?.deleted??r?.deleted??[]};}
  async disarm(name){
    // Only the creating controller can call this facade. It calls disarm after
    // no-create or fresh absence verification; a different nonce cannot clear it.
    await this.ctx.storage.transaction(async tx=>{const s=await tx.get('active');if(!s)return;if(s.reservation.name!==name)throw Error('Reservation changed');await tx.delete('active');await tx.deleteAlarm();});return {unarmed:true};
  }
  async alarm(){await this.tick();}
  async tick(){
    const op=crypto.randomUUID(),now=Date.now();
    const s=await this.ctx.storage.transaction(async tx=>{const v=await tx.get('active');if(!v||v.leaseUntil>now)return null;v.lease=op;v.leaseUntil=now+180000;await tx.put('active',v);await tx.setAlarm(now+181000);return v;});
    if(!s)return {status:(await this.ctx.storage.get('active'))?'busy':'unarmed'};
    try{
      const provider=runpodClient(s.key),pods=(await provider.list()).filter(p=>podMatches(p,s.reservation));
      for(const p of pods)validatePod(p,s.reservation,Infinity);
      await this.ctx.storage.transaction(async tx=>{const current=await tx.get('active');if(current?.lease!==op)return;for(const p of pods)if(!current.seen.some(x=>x.id===p.id))current.seen.push(p);await tx.put('active',current);});
      const result=await checkChatStop({ARMED_CHAT:JSON.stringify(s.reservation),RUNPOD_API_KEY:s.key,CHAT_STOP_ROLE:this.env.CHAT_STOP_ROLE});
      // Preserve the tested STOP/GET core. Add only fresh verified deletion.
      for(const r of result.results??[]){
        if(!['stopped_verified','gone'].includes(r.status))continue;
        const p=pods.find(p=>p.id===r.id)??s.seen.find(p=>p.id===r.id);
        if(p&&await provider.cleanup(p,s.reservation,Infinity))await this.ctx.storage.transaction(async tx=>{const current=await tx.get('active');if(current?.lease===op&&!current.deleted.some(x=>x.id===p.id)){current.deleted.push(p);await tx.put('active',current);}});
      }
      const current=await this.ctx.storage.get('active');
      if(current?.deleted.length&&!(await provider.list()).some(p=>podMatches(p,s.reservation))){
        await this.ctx.storage.transaction(async tx=>{const live=await tx.get('active');if(live?.lease!==op)return;await tx.put('lastReport',{name:live.reservation.name,deleted:live.deleted});await tx.delete('active');await tx.deleteAlarm();});
      }
      return result;
    }finally{
      await this.ctx.storage.transaction(async tx=>{const live=await tx.get('active');if(live?.lease!==op)return;live.leaseUntil=0;await tx.put('active',live);await tx.setAlarm(Date.now()+30000);});
    }
  }
}
export class GuardAdmin extends WorkerEntrypoint {
  arm(reservation,key){return stub(this.env).arm({reservation,key});}
  shorten(name,at){return stub(this.env).shorten(name,at);}
  disarm(name){return stub(this.env).disarm(name);}
  report(){return stub(this.env).report();}
}
export default {
  fetch(){return new Response('Not found',{status:404});},
  async scheduled(_,env){
    const state=stub(env),result=await state.tick(),report=await state.report();
    // Only the cron handler emits guard_tick, never an alarm or owner RPC.
    console.log(JSON.stringify({event:'guard_tick',role:env.CHAT_STOP_ROLE,reservationName:report.armed?report.name:undefined,image:report.armed?'ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:f4fda4da17fe00a8188527d3a774dcc487529b63fe2e10359912d24d4ee83761':undefined,...result,at:new Date().toISOString()}));
    if(result.results?.some(r=>r.status==='stop_requested_retrying'))throw Error('STOP pending');
  }
};
