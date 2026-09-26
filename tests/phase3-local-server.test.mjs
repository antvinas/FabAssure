import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { openDatabase, withValidatedTransaction } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { appendAuditEvent } from '../src/domain/audit.mjs';
import { createLocalServer, listenLocal } from '../src/server/http.mjs';
import { createChange, submitChange, classifyChange, approvePlan, startVerification,
    addMeasurementEvidence, recordAlignmentResult, reviseFailedChange
} from '../src/domain/change-service.mjs';

async function fixture(operation) {
    const db = openDatabase(':memory:');
    const assetsDir = mkdtempSync(join(tmpdir(), 'fabassure-http-'));
    writeFileSync(join(assetsDir, 'index.html'), '<!doctype html><title>FabAssure synthetic demo</title>');
    writeFileSync(join(assetsDir, 'app.js'), 'window.fabAssureDemo = true;');
    writeFileSync(join(assetsDir, 'styles.css'), 'body { color: #123; }');
    let server;
    try {
        seedDatabase(db, { instanceId: 'DATASET-HTTP' });
        server = createLocalServer(db, { assetsDir });
        const local = await listenLocal(server, 0);
        return await operation({ db, server, local, assetsDir });
    } finally {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        db.close();
        rmSync(assetsDir, { recursive: true, force: true });
    }
}

test('local server binds loopback and serves bundled assets plus synthetic bootstrap', () => fixture(async ({ local }) => {
    assert.equal(local.host, '127.0.0.1');
    const health = await fetch(`${local.url}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).offline, true);
    const bootstrap = await fetch(`${local.url}/api/bootstrap`);
    assert.equal(bootstrap.status, 200);
    const data = await bootstrap.json();
    assert.equal(data.datasetInstanceId, 'DATASET-HTTP');
    assert.equal(data.metrics.inspectedUnits, 4500);
    assert.ok(data.actors.some(actor => actor.id === 'ACT-REV' && actor.role === 'Reviewer'));
    const page = await fetch(local.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /FabAssure synthetic demo/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal((await fetch(`${local.url}/app.js`)).status, 200);
    assert.equal((await fetch(`${local.url}/styles.css`)).status, 200);
    assert.equal((await fetch(`${local.url}/%2e%2e/secret`)).status, 404);
}));

test('bundled static bytes remain fixed if an asset path changes after startup', () => fixture(async ({ local, assetsDir }) => {
    writeFileSync(join(assetsDir, 'index.html'), '<title>Replaced after startup</title>');
    const page = await (await fetch(local.url)).text();
    assert.match(page, /FabAssure synthetic demo/);
    assert.doesNotMatch(page, /Replaced after startup/);
}));

test('same-origin local action records a synthetic change and exposes its audit history', () => fixture(async ({ local }) => {
    const action = await fetch(`${local.url}/api/actions`, {
        method: 'POST', headers: {
            'content-type': 'application/json',
            'x-fabassure-local': '1', origin: local.url
        }, body: JSON.stringify({ action: 'createChange', input: {
            id: 'CHG-HTTP', title: 'Synthetic HTTP change', actorId: 'ACT-MFG',
            lineId: 'LINE-A', equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
            recipeRevisionId: 'REC-ALIGN-R3', baselineRef: 'AOI-A-001',
            reason: 'Synthetic demonstration', at: '2026-08-07T12:00:00.000Z'
        } })
    });
    assert.equal(action.status, 200);
    assert.equal((await action.json()).result.state, 'Draft');
    const detail = await fetch(`${local.url}/api/changes/CHG-HTTP`);
    assert.equal(detail.status, 200);
    const record = await detail.json();
    assert.equal(record.change.state, 'Draft');
    assert.equal(record.audit.length, 1);
    assert.equal(record.audit[0].action, 'change-created');
    assert.equal(record.audit[0].entity_revision_id, 'CHG-HTTP-R1');
    assert.equal(record.audit[0].payload_sha256.length, 64);
    assert.equal(record.audit[0].previous_digest, null);
}));

test('foreign browser origin, missing local header and unsupported action cannot mutate state', () => fixture(async ({ db, local }) => {
    const body = JSON.stringify({ action: 'createChange', input: { id: 'CHG-BLOCKED' } });
    const foreign = await fetch(`${local.url}/api/actions`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fabassure-local': '1',
            origin: 'https://unrelated.invalid' }, body });
    assert.equal(foreign.status, 403);
    const missingHeader = await fetch(`${local.url}/api/actions`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: local.url }, body });
    assert.equal(missingHeader.status, 403);
    const unsupported = await fetch(`${local.url}/api/actions`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fabassure-local': '1',
            origin: local.url }, body: JSON.stringify({ action: 'deleteAudit', input: {} }) });
    assert.equal(unsupported.status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM changes').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 0);
}));

test('change detail retains failed revision and exposes linked source observations after rework', () => fixture(async ({ db, local }) => {
    const riskInputs = { severity: 2, occurrence: 1, detectability: 2, scope: 1,
        criticalCharacteristic: true, safetyRelevance: false,
        bases: { severity: 'Synthetic alignment', occurrence: 'Synthetic baseline',
            detectability: 'Inspection', scope: 'One module',
            criticalCharacteristic: 'ALIGN-X', safetyRelevance: 'None' } };
    createChange(db, { id: 'CHG-HISTORY', title: 'Synthetic rework', actorId: 'ACT-MFG',
        lineId: 'LINE-A', equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
        recipeRevisionId: 'REC-ALIGN-R2', baselineRef: 'AOI-A-001',
        reason: 'Synthetic improvement', at: '2026-08-05T12:00:00.000Z' });
    submitChange(db, { changeId: 'CHG-HISTORY', actorId: 'ACT-MFG', expectedRevisionNo: 1,
        at: '2026-08-05T12:10:00.000Z' });
    classifyChange(db, { changeId: 'CHG-HISTORY', actorId: 'ACT-Q1', expectedRevisionNo: 1,
        assessmentId: 'RISK-HISTORY', riskInputs, at: '2026-08-05T12:20:00.000Z' });
    approvePlan(db, { changeId: 'CHG-HISTORY', actorId: 'ACT-Q1', expectedRevisionNo: 1,
        planId: 'PLAN-HISTORY', at: '2026-08-05T12:30:00.000Z' });
    startVerification(db, { changeId: 'CHG-HISTORY', actorId: 'ACT-VER', expectedRevisionNo: 1,
        at: '2026-08-06T08:00:00.000Z' });
    addMeasurementEvidence(db, { changeId: 'CHG-HISTORY', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-HISTORY', measurementId: 'MEAS-A-006-07',
        at: '2026-08-06T10:01:00.000Z' });
    recordAlignmentResult(db, { changeId: 'CHG-HISTORY', actorId: 'ACT-VER', expectedRevisionNo: 1,
        resultId: 'RESULT-HISTORY', evidenceId: 'EVID-HISTORY',
        at: '2026-08-06T10:02:00.000Z' });
    reviseFailedChange(db, { changeId: 'CHG-HISTORY', actorId: 'ACT-MFG',
        expectedRevisionNo: 1, failedResultId: 'RESULT-HISTORY',
        newRecipeRevisionId: 'REC-ALIGN-R3', reason: 'Correct synthetic offset',
        at: '2026-08-07T12:00:00.000Z' });
    const detail = await (await fetch(`${local.url}/api/changes/CHG-HISTORY`)).json();
    assert.equal(detail.change.current_revision_no, 2);
    assert.deepEqual(detail.revisions.map(item => item.revision.revision_no), [1, 2]);
    assert.equal(detail.revisions[0].results[0].id, 'RESULT-HISTORY');
    assert.equal(detail.revisions[0].results[0].passed, 0);
    const evidence = detail.revisions[0].evidence.find(item => item.id === 'EVID-HISTORY');
    assert.equal(evidence.payload.value, 0.1);
    assert.equal(evidence.source.id, 'MEAS-A-006-07');
    assert.equal(evidence.source.value, 0.1);
    assert.equal(evidence.source.lot_id, 'LOT-A-006');
    assert.equal(detail.revisions[1].evidence.length, 0);
    assert.equal(detail.audit[1].previous_digest, detail.audit[0].digest);
    assert.equal(detail.audit[0].entity_revision_id, 'CHG-HISTORY-R1');
}));

test('change detail includes persisted risk override rationale and decision actors', () => fixture(async ({ db, local }) => {
    createChange(db, { id: 'CHG-OVERRIDE', title: 'Synthetic risk override', actorId: 'ACT-MFG',
        lineId: 'LINE-A', equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
        recipeRevisionId: 'REC-ALIGN-R2', baselineRef: 'AOI-A-001',
        reason: 'Synthetic risk demonstration', at: '2026-08-05T12:00:00.000Z' });
    submitChange(db, { changeId: 'CHG-OVERRIDE', actorId: 'ACT-MFG', expectedRevisionNo: 1,
        at: '2026-08-05T12:10:00.000Z' });
    classifyChange(db, { changeId: 'CHG-OVERRIDE', actorId: 'ACT-Q1', expectedRevisionNo: 1,
        assessmentId: 'RISK-OVERRIDE', riskInputs: {
            severity: 2, occurrence: 1, detectability: 2, scope: 1,
            criticalCharacteristic: false, safetyRelevance: false,
            bases: { severity: 'Synthetic impact', occurrence: 'Synthetic baseline',
                detectability: 'Inspection', scope: 'One module',
                criticalCharacteristic: 'No critical characteristic', safetyRelevance: 'None' }
        }, at: '2026-08-05T12:20:00.000Z' });
    db.prepare(`INSERT INTO evidence_items
        (id,change_revision_id,source_table,source_id,evidence_type,payload_json,sha256,recorded_by,recorded_at)
        VALUES ('EVID-OVERRIDE','CHG-OVERRIDE-R1','embedded_note','EVID-OVERRIDE','note',
            '{"text":"Synthetic risk rationale"}',?,'ACT-Q1','2026-08-05T12:21:00.000Z')`)
        .run('a'.repeat(64));
    db.prepare(`INSERT INTO risk_overrides
        (id,assessment_id,from_level,to_level,rationale,evidence_id,requester_actor_id,approver_actor_id,recorded_at)
        VALUES ('OVR-LOCAL','RISK-OVERRIDE','L2','L3','Synthetic conservative escalation',
            'EVID-OVERRIDE','ACT-Q1',NULL,'2026-08-05T12:22:00.000Z')`).run();
    withValidatedTransaction(db, handle => appendAuditEvent(handle, {
        actorId: 'ACT-Q1', recordedAt: '2026-08-05T12:22:00.000Z',
        entityType: 'change', entityId: 'CHG-OVERRIDE', entityRevisionId: 'CHG-OVERRIDE-R1',
        action: 'risk-override', payload: { overrideId: 'OVR-LOCAL', fromLevel: 'L2', toLevel: 'L3' }
    }));
    const detail = await (await fetch(`${local.url}/api/changes/CHG-OVERRIDE`)).json();
    assert.equal(detail.revisions[0].overrides.length, 1);
    assert.equal(detail.revisions[0].overrides[0].rationale, 'Synthetic conservative escalation');
    assert.equal(detail.revisions[0].overrides[0].requester_actor_id, 'ACT-Q1');
    assert.equal(detail.revisions[0].overrides[0].approver_actor_id, null);
}));

test('duplicate action does not disclose SQLite internals and raw encoded traversal stays outside assets', () => fixture(async ({ local }) => {
    const input = { id: 'CHG-DUPLICATE', title: 'Synthetic duplicate', actorId: 'ACT-MFG',
        lineId: 'LINE-A', equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
        recipeRevisionId: 'REC-ALIGN-R3', baselineRef: 'AOI-A-001',
        reason: 'Synthetic check', at: '2026-08-07T12:00:00.000Z' };
    const headers = { 'content-type': 'application/json', 'x-fabassure-local': '1', origin: local.url };
    const body = JSON.stringify({ action: 'createChange', input });
    assert.equal((await fetch(`${local.url}/api/actions`, { method: 'POST', headers, body })).status, 200);
    const duplicate = await fetch(`${local.url}/api/actions`, { method: 'POST', headers, body });
    assert.ok(duplicate.status >= 400);
    assert.doesNotMatch(JSON.stringify(await duplicate.json()), /SQLITE|UNIQUE constraint|INSERT INTO|src\\|src\//i);
    const rawStatus = await new Promise((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: local.port,
            path: '/%2e%2e/%2e%2e/schema.sql' }, res => {
            res.resume(); res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject); req.end();
    });
    assert.equal(rawStatus, 404);
}));
