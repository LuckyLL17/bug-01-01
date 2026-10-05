import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../app';

const telemetry = (overrides: Record<string, unknown> = {}) => ({
  eventId: 'evt-1',
  assetId: 'pump-1',
  metric: 'temperature',
  value: 42,
  unit: 'C',
  observedAt: 1_700_000_000_000,
  quality: 'good',
  ...overrides,
});

const postTelemetry = (app: any, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/telemetry', payload });

const replay = (app: any, from = 0, to = 2_000_000_000_000) =>
  app.inject({ method: 'GET', url: `/telemetry/replay?from=${from}&to=${to}` });

const auditFor = (app: any, entityId: string) =>
  app.inject({ method: 'GET', url: `/audit?entityId=${entityId}` });

test('sequential duplicates keep a single replayable fact and a single audit entry', async () => {
  const app = buildApp();
  const first = await postTelemetry(app, telemetry());
  assert.equal(first.statusCode, 200);
  const second = await postTelemetry(app, telemetry());
  const third = await postTelemetry(app, telemetry());
  assert.equal(second.statusCode, 200);
  assert.equal(third.statusCode, 200);
  // duplicate requests get the identical result back
  assert.deepEqual(second.json(), first.json());
  assert.deepEqual(third.json(), first.json());

  const events = (await replay(app)).json();
  assert.equal(events.filter((e: any) => e.id === 'evt-1').length, 1);

  const audit = (await auditFor(app, 'evt-1')).json();
  assert.equal(audit.filter((a: any) => a.action === 'telemetry.ingest').length, 1);
});

test('concurrent duplicates resolve to exactly one fact', async () => {
  const app = buildApp();
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => postTelemetry(app, telemetry({ eventId: 'evt-concurrent' }))),
  );
  assert.ok(responses.every((r: any) => r.statusCode === 200));
  assert.equal(new Set(responses.map((r: any) => r.json().id)).size, 1);
  assert.equal(new Set(responses.map((r: any) => JSON.stringify(r.json()))).size, 1);

  const events = (await replay(app)).json();
  assert.equal(events.filter((e: any) => e.id === 'evt-concurrent').length, 1);

  const audit = (await auditFor(app, 'evt-concurrent')).json();
  assert.equal(audit.filter((a: any) => a.action === 'telemetry.ingest').length, 1);
});

test('conflicting retry is rejected with diagnosable info and the original fact is preserved', async () => {
  const app = buildApp();
  const ok = await postTelemetry(app, telemetry({ eventId: 'evt-conflict', value: 10 }));
  assert.equal(ok.statusCode, 200);

  const conflict = await postTelemetry(app, telemetry({ eventId: 'evt-conflict', value: 99 }));
  assert.equal(conflict.statusCode, 409);
  const body = conflict.json();
  assert.equal(body.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(body.eventId, 'evt-conflict');
  assert.ok(body.differences.includes('value'));
  assert.equal(body.existing.value, 10);
  assert.equal(body.incoming.value, 99);

  // the stored fact is untouched and replayable exactly once
  const events = (await replay(app)).json().filter((e: any) => e.id === 'evt-conflict');
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.value, 10);

  // conflict diagnostics are retained in the audit trail
  const audit = (await auditFor(app, 'evt-conflict')).json();
  const conflicts = audit.filter((a: any) => a.action === 'telemetry.conflict');
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].metadata.differences, ['value']);
  assert.equal(conflicts[0].metadata.existing.value, 10);
  assert.equal(conflicts[0].metadata.incoming.value, 99);

  // a later correct retry still returns the original fact
  const retry = await postTelemetry(app, telemetry({ eventId: 'evt-conflict', value: 10 }));
  assert.equal(retry.statusCode, 200);
  assert.deepEqual(retry.json(), ok.json());
});

test('conflict on observedAt is rejected as well', async () => {
  const app = buildApp();
  await postTelemetry(app, telemetry({ eventId: 'evt-time', observedAt: 1000 }));
  const conflict = await postTelemetry(app, telemetry({ eventId: 'evt-time', observedAt: 2000 }));
  assert.equal(conflict.statusCode, 409);
  assert.ok(conflict.json().differences.includes('observedAt'));
  assert.equal((await replay(app)).json().length, 1);
});

test('different eventIds write independently and never overwrite each other', async () => {
  const app = buildApp();
  const a = await postTelemetry(app, telemetry({ eventId: 'evt-a', value: 1, observedAt: 1000 }));
  const b = await postTelemetry(app, telemetry({ eventId: 'evt-b', value: 2, observedAt: 2000 }));
  // identical business content under a different eventId is a distinct fact
  const c = await postTelemetry(app, telemetry({ eventId: 'evt-c', value: 1, observedAt: 1000 }));
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(c.statusCode, 200);

  // retrying evt-a after other writes still returns evt-a's original fact
  const retryA = await postTelemetry(app, telemetry({ eventId: 'evt-a', value: 1, observedAt: 1000 }));
  assert.deepEqual(retryA.json(), a.json());

  const events = (await replay(app)).json();
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e: any) => e.id), ['evt-a', 'evt-c', 'evt-b']);
  assert.equal(events.find((e: any) => e.id === 'evt-a').payload.value, 1);
  assert.equal(events.find((e: any) => e.id === 'evt-b').payload.value, 2);
});

test('anomaly detection and audit reference the single deduplicated fact', async () => {
  const app = buildApp();
  const payload = telemetry({ eventId: 'evt-anomaly', value: 150, observedAt: 5000 });
  for (let i = 0; i < 3; i++) await postTelemetry(app, payload);

  const detect = await app.inject({
    method: 'POST',
    url: '/anomalies/detect',
    payload: { assetId: 'pump-1', metric: 'temperature', threshold: 100 },
  });
  assert.equal(detect.statusCode, 200);
  const incident = detect.json();
  // retries must not inflate the abnormal-sample evidence
  assert.equal(incident.evidence.length, 1);
  assert.ok(incident.evidence[0].includes('temperature=150'));
  assert.equal(incident.detectedAt, 5000);

  const audit = (await auditFor(app, 'evt-anomaly')).json();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].entityId, 'evt-anomaly');
});

test('repeated replay returns the same facts without side effects', async () => {
  const app = buildApp();
  await postTelemetry(app, telemetry({ eventId: 'evt-r1', observedAt: 1000 }));
  await postTelemetry(app, telemetry({ eventId: 'evt-r2', observedAt: 2000 }));
  await postTelemetry(app, telemetry({ eventId: 'evt-r1', observedAt: 1000 })); // duplicate retry

  const first = (await replay(app)).json();
  const second = (await replay(app)).json();
  assert.equal(first.length, 2);
  assert.deepEqual(second, first);

  // replay itself creates no new events or audit entries
  const audit = (await app.inject({ method: 'GET', url: '/audit' })).json();
  assert.equal(audit.filter((a: any) => a.action === 'telemetry.ingest').length, 2);
  assert.equal((await replay(app)).json().length, 2);
});
