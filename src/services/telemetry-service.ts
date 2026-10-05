import { assertOrThrow, DomainError } from '../core/errors'; import { newId } from '../core/id'; import { TwinStore } from '../domain/store'; import { DomainEvent, Telemetry } from '../domain/types';

const BUSINESS_FIELDS = ['assetId','metric','value','unit','observedAt','quality'] as const;
const factView=(t:Telemetry)=>({assetId:t.assetId,metric:t.metric,value:t.value,unit:t.unit,observedAt:t.observedAt,quality:t.quality});

export class TelemetryService {
 constructor(private store:TwinStore){}
 ingest(input:Telemetry):{event:DomainEvent;created:boolean}{
  assertOrThrow(!!input&&typeof input.assetId==='string'&&input.assetId.length>0,'INVALID_TELEMETRY','assetId is required');
  assertOrThrow(typeof input.metric==='string'&&input.metric.length>0,'INVALID_TELEMETRY','metric is required');
  assertOrThrow(typeof input.value==='number'&&Number.isFinite(input.value),'INVALID_TELEMETRY','value must be a finite number');
  assertOrThrow(typeof input.observedAt==='number'&&Number.isFinite(input.observedAt),'INVALID_TELEMETRY','observedAt must be a finite number');
  assertOrThrow(input.eventId===undefined||(typeof input.eventId==='string'&&input.eventId.length>0),'INVALID_TELEMETRY','eventId must be a non-empty string when provided');
  const normalized:Telemetry={assetId:input.assetId,metric:input.metric,value:input.value,unit:input.unit??'',observedAt:input.observedAt,quality:input.quality??'good'};
  const eventId=input.eventId??newId('evt');
  // The check-and-commit below is fully synchronous, so sequential and
  // concurrent retries of the same eventId both resolve to exactly one fact.
  const existing=this.store.telemetryFacts.get(eventId);
  if(existing){
   const differences=BUSINESS_FIELDS.filter(f=>existing.telemetry[f]!==normalized[f]);
   if(!differences.length) return {event:existing.event,created:false};
   throw new DomainError('IDEMPOTENCY_CONFLICT',`eventId ${eventId} was already ingested with different content`,{eventId,differences:[...differences],existing:factView(existing.telemetry),incoming:factView(normalized)});
  }
  const telemetry:Telemetry={...normalized,eventId};
  const event:DomainEvent={id:eventId,type:'telemetry',assetId:telemetry.assetId,timestamp:telemetry.observedAt,sequence:this.store.events.length+1,payload:{metric:telemetry.metric,value:telemetry.value,unit:telemetry.unit,quality:telemetry.quality}};
  this.store.telemetry.push(telemetry); this.store.events.push(event); this.store.telemetryFacts.set(eventId,{eventId,telemetry,event});
  return {event,created:true};
 }
 history(assetId:string,metric?:string){return this.store.telemetry.filter(t=>t.assetId===assetId&&(!metric||t.metric===metric)).sort((a,b)=>a.observedAt-b.observedAt)}
 replay(from:number,to:number){return this.store.events.filter(e=>e.timestamp>=from&&e.timestamp<=to).sort((a,b)=>a.timestamp-b.timestamp||a.sequence-b.sequence)}
}
