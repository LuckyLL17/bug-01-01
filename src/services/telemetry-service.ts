import { DomainError } from '../core/errors'; import { newId } from '../core/id'; import { TwinStore } from '../domain/store'; import { DomainEvent, TelemetryIngest, TelemetrySample } from '../domain/types';
const FACT_FIELDS=['assetId','metric','value','unit','observedAt','quality'] as const;
export class TelemetryService {
 constructor(private store:TwinStore){}
 // 幂等接入：同一 eventId 的重试只落一条事实；内容冲突则拒绝并给出字段级差异。检查与写入在同一个同步区间内完成，并发重试在事件循环中串行化，不会交错。
 ingest(input:TelemetryIngest){ const eventId=input.eventId||newId('evt'); const sample:TelemetrySample={assetId:input.assetId,metric:input.metric,value:input.value,unit:input.unit,observedAt:input.observedAt,quality:input.quality,eventId}; const existing=this.store.facts.get(eventId);
  if(existing){ const conflicts=FACT_FIELDS.filter(f=>!Object.is(existing.sample[f],sample[f])).map(f=>({field:f,expected:existing.sample[f],received:sample[f]})); if(conflicts.length) throw new DomainError('EVENT_CONFLICT',`event ${eventId} already recorded with different content`,{eventId,conflicts}); return {event:existing.event,created:false}; }
  const event:DomainEvent={id:eventId,type:'telemetry',assetId:sample.assetId,timestamp:sample.observedAt,sequence:this.store.events.length+1,payload:{metric:sample.metric,value:sample.value,quality:sample.quality}}; this.store.events.push(event); this.store.telemetry.push(sample); this.store.facts.set(eventId,{event,sample}); return {event,created:true}; }
 history(assetId:string,metric?:string){return this.store.telemetry.filter(t=>t.assetId===assetId&&(!metric||t.metric===metric)).sort((a,b)=>a.observedAt-b.observedAt)}
 replay(from:number,to:number){return this.store.events.filter(e=>e.timestamp>=from&&e.timestamp<=to).sort((a,b)=>a.timestamp-b.timestamp||a.sequence-b.sequence)}
}
