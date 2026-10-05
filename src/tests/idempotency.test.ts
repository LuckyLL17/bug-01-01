import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app';

const REPLAY_URL='/telemetry/replay?from=0&to=1800000000000';
const makeEvent=(overrides:Record<string,unknown>={})=>({eventId:'evt-gw-1',assetId:'pump-1',metric:'temperature',value:42.5,unit:'C',observedAt:1700000000000,quality:'good',...overrides});
const post=(app:any,payload:unknown)=>app.inject({method:'POST',url:'/telemetry',payload:payload as any});
const replay=(app:any)=>app.inject({method:'GET',url:REPLAY_URL}).then((r:any)=>r.json());

test('顺序重复：同一事件重试多次只保留一条可重放事实，返回结果一致',async()=>{
  const app=buildApp();
  const body=makeEvent();
  const first=await post(app,body);
  assert.equal(first.statusCode,200);
  const second=await post(app,body);
  const third=await post(app,body);
  assert.deepEqual(second.json(),first.json());
  assert.deepEqual(third.json(),first.json());
  assert.equal(first.json().id,'evt-gw-1');

  const events=await replay(app);
  assert.equal(events.length,1);
  assert.equal(events[0].id,'evt-gw-1');
  assert.equal(events[0].payload.value,42.5);

  const audit=await app.inject({method:'GET',url:'/audit?entityId=evt-gw-1'}).then(r=>r.json());
  assert.equal(audit.length,1);
  assert.equal(audit[0].entityId,'evt-gw-1');
});

test('并发重复：并发提交同一事件被原子去重，事实与审计均只有一条',async()=>{
  const app=buildApp();
  const body=makeEvent({eventId:'evt-conc'});
  const responses=await Promise.all(Array.from({length:8},()=>post(app,body)));
  assert.ok(responses.every(r=>r.statusCode===200));
  assert.equal(new Set(responses.map(r=>r.json().id)).size,1);
  for(const r of responses) assert.deepEqual(r.json(),responses[0].json());

  const events=await replay(app);
  assert.equal(events.length,1);
  assert.equal(events[0].sequence,1);

  const audit=await app.inject({method:'GET',url:'/audit'}).then(r=>r.json());
  assert.equal(audit.filter((a:any)=>a.entityId==='evt-conc').length,1);
});

test('冲突重试：相同 eventId 携带不同内容被拒绝并保留可诊断信息，原事实不变',async()=>{
  const app=buildApp();
  await post(app,makeEvent());
  const conflict=await post(app,makeEvent({value:99,observedAt:1700000000001}));
  assert.equal(conflict.statusCode,409);
  const body=conflict.json();
  assert.equal(body.code,'EVENT_CONFLICT');
  assert.equal(body.details.eventId,'evt-gw-1');
  const byField=Object.fromEntries(body.details.conflicts.map((c:any)=>[c.field,c]));
  assert.deepEqual(byField.value,{field:'value',expected:42.5,received:99});
  assert.deepEqual(byField.observedAt,{field:'observedAt',expected:1700000000000,received:1700000000001});

  const events=await replay(app);
  assert.equal(events.length,1);
  assert.equal(events[0].payload.value,42.5);
  assert.equal(events[0].timestamp,1700000000000);

  const audit=await app.inject({method:'GET',url:'/audit?entityId=evt-gw-1'}).then(r=>r.json());
  assert.equal(audit.length,1);
});

test('不同事件混合写入：不同 eventId 互不覆盖，重试穿插后各自保留最终事实',async()=>{
  const app=buildApp();
  const a=makeEvent({eventId:'evt-a',observedAt:1000,value:1});
  const b=makeEvent({eventId:'evt-b',observedAt:2000,value:2});
  const c=makeEvent({eventId:'evt-c',observedAt:3000,value:3});
  for(const body of [a,b,a,c,b,a]) assert.equal((await post(app,body)).statusCode,200);
  const concurrent=await Promise.all([makeEvent({eventId:'evt-d',observedAt:4000,value:4}),makeEvent({eventId:'evt-e',observedAt:5000,value:5}),makeEvent({eventId:'evt-d',observedAt:4000,value:4})].map(p=>post(app,p)));
  assert.ok(concurrent.every(r=>r.statusCode===200));

  const events=await replay(app);
  assert.deepEqual(events.map((e:any)=>e.id),['evt-a','evt-b','evt-c','evt-d','evt-e']);
  assert.deepEqual(events.map((e:any)=>e.payload.value),[1,2,3,4,5]);
  assert.deepEqual(events.map((e:any)=>e.sequence),[1,2,3,4,5]);

  const audit=await app.inject({method:'GET',url:'/audit'}).then(r=>r.json());
  assert.equal(audit.filter((x:any)=>x.action==='telemetry.ingest').length,5);
});

test('重复回放：同一窗口多次回放结果一致，重复写入后仍只有一条事实',async()=>{
  const app=buildApp();
  await post(app,makeEvent({eventId:'evt-r1',observedAt:1000,value:10}));
  await post(app,makeEvent({eventId:'evt-r2',observedAt:1000,value:20}));
  await post(app,makeEvent({eventId:'evt-r1',observedAt:1000,value:10}));
  const first=await replay(app);
  const second=await replay(app);
  assert.deepEqual(first,second);
  assert.equal(first.length,2);
  assert.deepEqual(first.map((e:any)=>e.id),['evt-r1','evt-r2']);
});

test('异常检测与审计引用同一条最终事实，重复遥测不放大异常次数',async()=>{
  const app=buildApp();
  const hot=makeEvent({eventId:'evt-hot',value:150,observedAt:5000});
  for(let i=0;i<5;i++) await post(app,hot);
  const res=await app.inject({method:'POST',url:'/anomalies/detect',payload:{assetId:'pump-1',metric:'temperature',threshold:100}});
  const incident=res.json();
  assert.equal(incident.evidence.length,1);
  assert.ok(incident.evidence[0].includes('#evt-hot'));
  assert.equal(incident.severity,'high');

  const audit=await app.inject({method:'GET',url:'/audit?entityId=evt-hot'}).then(r=>r.json());
  assert.equal(audit.length,1);
});
