import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, withValidatedTransaction } from '../src/data/db.mjs';
import { appendAuditEvent, verifyAuditChain } from '../src/domain/audit.mjs';

function withDataset(operation) {
    const db = openDatabase(':memory:');
    try {
        withValidatedTransaction(db, handle => {
            handle.prepare("INSERT INTO dataset_instances(id,code,version,seed,generated_at) VALUES ('DATASET-AUD','camera-demo',1,'fixed','2026-09-01T00:00:00.000Z')").run();
        });
        return operation(db);
    } finally {
        db.close();
    }
}

test('audit events chain canonical payloads, actor role and UTC metadata', () => withDataset(db => {
    const first = withValidatedTransaction(db, handle => appendAuditEvent(handle, {
        id: 'AUD-ONE', actorId: 'ACT-MFG', recordedAt: '2026-09-01T01:00:00.000Z',
        entityType: 'change', entityId: 'CHG-A', action: 'created', newState: 'Draft',
        payload: { z: 2, a: { b: 1, a: 0 } }
    }));
    const second = withValidatedTransaction(db, handle => appendAuditEvent(handle, {
        id: 'AUD-TWO', actorId: 'ACT-Q1', recordedAt: '2026-09-01T02:00:00.000Z',
        entityType: 'change', entityId: 'CHG-A', action: 'classified',
        priorState: 'Submitted', newState: 'Risk Classified', ruleVersion: 'FA-DEMO-RISK-1.0',
        linkedEvidenceIds: ['EVID-1'], payload: { level: 'L3', rule: 'R02' }
    }));
    const rows = db.prepare('SELECT * FROM audit_events ORDER BY sequence').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].simulated_role, 'Manufacturing Engineer');
    assert.equal(rows[1].simulated_role, 'Quality Engineer');
    assert.equal(rows[0].payload_json, '{"a":{"a":0,"b":1},"z":2}');
    assert.equal(rows[1].previous_digest, first.digest);
    assert.equal(rows[1].digest, second.digest);
    assert.deepEqual(verifyAuditChain(db), { valid: true, count: 2, lastDigest: second.digest, anchored: false });
}));

test('audit append requires a transaction and rolls back with a failed domain write', () => withDataset(db => {
    const event = {
        id: 'AUD-ROLLBACK', actorId: 'ACT-MFG', recordedAt: '2026-09-01T01:00:00.000Z',
        entityType: 'change', entityId: 'CHG-A', action: 'created', payload: { reason: 'Synthetic' }
    };
    assert.throws(() => appendAuditEvent(db, event), /transaction/i);
    db.exec('BEGIN IMMEDIATE');
    try {
        assert.throws(() => appendAuditEvent(db, event), /validated transaction/i);
    } finally {
        db.exec('ROLLBACK');
    }
    assert.throws(() => withValidatedTransaction(db, handle => {
        appendAuditEvent(handle, event);
        throw new Error('domain failure');
    }), /domain failure/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 0);
    assert.throws(() => withValidatedTransaction(db, handle => appendAuditEvent(handle, {
        ...event, actorId: 'ACT-MISSING'
    })), /actor/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 0);
}));

test('audit payload preserves special JSON keys and rejects lossy inputs', () => withDataset(db => {
    const base = {
        actorId: 'ACT-MFG', recordedAt: '2026-09-01T01:00:00.000Z',
        entityType: 'change', entityId: 'CHG-A', action: 'created'
    };
    withValidatedTransaction(db, handle => appendAuditEvent(handle, {
        ...base, id: 'AUD-PROTO', payload: JSON.parse('{"__proto__":null,"text":"Synthetic"}')
    }));
    assert.equal(db.prepare("SELECT payload_json FROM audit_events WHERE id='AUD-PROTO'").get().payload_json,
        '{"__proto__":null,"text":"Synthetic"}');
    assert.throws(() => withValidatedTransaction(db, handle => appendAuditEvent(handle, {
        ...base, id: 'AUD-NULL', payload: null
    })), /payload/i);
    const sparse = [];
    sparse[1] = 'value';
    assert.throws(() => withValidatedTransaction(db, handle => appendAuditEvent(handle, {
        ...base, id: 'AUD-SPARSE', payload: { sparse }
    })), /sparse|payload|array/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 1);
}));

test('trusted local head detects a deleted audit tail', () => withDataset(db => {
    withValidatedTransaction(db, handle => appendAuditEvent(handle, {
        id: 'AUD-ANCHOR', actorId: 'ACT-MFG', recordedAt: '2026-09-01T01:00:00.000Z',
        entityType: 'change', entityId: 'CHG-A', action: 'created', payload: { note: 'Synthetic' }
    }));
    const head = verifyAuditChain(db);
    db.exec('DROP TRIGGER immutable_audit_delete');
    db.prepare("DELETE FROM audit_events WHERE id='AUD-ANCHOR'").run();
    assert.deepEqual(verifyAuditChain(db), { valid: true, count: 0, lastDigest: null, anchored: false });
    assert.throws(() => verifyAuditChain(db, { count: head.count, lastDigest: head.lastDigest }), /anchor|head|count/i);
}));

test('local chain verification reports payload tampering even after SQL guard removal', () => withDataset(db => {
    withValidatedTransaction(db, handle => appendAuditEvent(handle, {
        id: 'AUD-TAMPER', actorId: 'ACT-Q1', recordedAt: '2026-09-01T01:00:00.000Z',
        entityType: 'change', entityId: 'CHG-A', action: 'classified', payload: { level: 'L3' }
    }));
    assert.throws(() => db.prepare("UPDATE audit_events SET payload_json='{}' WHERE id='AUD-TAMPER'").run(), /immutable/i);
    db.exec('DROP TRIGGER immutable_audit_update');
    db.prepare("UPDATE audit_events SET payload_json='{}' WHERE id='AUD-TAMPER'").run();
    assert.throws(() => verifyAuditChain(db), /digest|tamper|integrity/i);
}));
