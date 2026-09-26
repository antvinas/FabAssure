import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { verifyAuditChain } from '../src/domain/audit.mjs';
import {
    createChange, submitChange, classifyChange, approvePlan,
    startVerification, addMeasurementEvidence, recordAlignmentResult
} from '../src/domain/change-service.mjs';

const times = {
    created: '2026-08-05T12:00:00.000Z', submitted: '2026-08-05T12:10:00.000Z',
    classified: '2026-08-05T12:20:00.000Z', approved: '2026-08-05T12:30:00.000Z',
    started: '2026-08-06T08:00:00.000Z', evidence: '2026-08-06T10:01:00.000Z',
    result: '2026-08-06T10:02:00.000Z'
};
const riskInputs = {
    severity: 2, occurrence: 1, detectability: 2, scope: 1,
    criticalCharacteristic: true, safetyRelevance: false,
    bases: {
        severity: 'Synthetic alignment characteristic', occurrence: 'Three baseline lots below 1%',
        detectability: 'AOI and sampled alignment', scope: 'One module and recipe',
        criticalCharacteristic: 'ALIGN-X demo critical characteristic', safetyRelevance: 'No synthetic safety impact'
    }
};

function fixture(operation) {
    const db = openDatabase(':memory:');
    try {
        seedDatabase(db, { instanceId: 'DATASET-EVIDENCE' });
        createChange(db, {
            id: 'CHG-A', title: 'Synthetic alignment change', actorId: 'ACT-MFG',
            lineId: 'LINE-A', equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
            recipeRevisionId: 'REC-ALIGN-R2', baselineRef: 'AOI-A-001',
            reason: 'Improve synthetic alignment', at: times.created
        });
        submitChange(db, { changeId: 'CHG-A', actorId: 'ACT-MFG', expectedRevisionNo: 1, at: times.submitted });
        classifyChange(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
            assessmentId: 'RISK-A', riskInputs, at: times.classified });
        approvePlan(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
            planId: 'PLAN-A', at: times.approved });
        return operation(db);
    } finally {
        db.close();
    }
}

test('failed 0.10 mm source measurement is immutable and sends L3 change to Needs Rework', () => fixture(db => {
    startVerification(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1, at: times.started });
    const evidence = addMeasurementEvidence(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-FAIL', measurementId: 'MEAS-A-006-07', at: times.evidence
    });
    assert.equal(evidence.value, 0.10);
    assert.equal(evidence.lotId, 'LOT-A-006');
    const result = recordAlignmentResult(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        resultId: 'RESULT-FAIL', evidenceId: 'EVID-FAIL', at: times.result
    });
    assert.equal(result.passed, false);
    assert.equal(result.observedValue, 0.10);
    assert.equal(db.prepare("SELECT passed FROM criterion_results WHERE id='RESULT-FAIL'").get().passed, 0);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Needs Rework');
    assert.throws(() => db.prepare("UPDATE criterion_results SET passed=1 WHERE id='RESULT-FAIL'").run(), /immutable/i);
    assert.throws(() => db.prepare("DELETE FROM evidence_items WHERE id='EVID-FAIL'").run(), /immutable/i);
    assert.throws(() => addMeasurementEvidence(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-LATE', measurementId: 'MEAS-A-006-08', at: times.result }), /state|verification/i);
    const audit = verifyAuditChain(db);
    assert.equal(audit.count, 7);
    assert.deepEqual(db.prepare('SELECT action FROM audit_events ORDER BY sequence DESC LIMIT 3').all().map(row => row.action),
        ['criterion-failed', 'measurement-evidence-added', 'verification-started']);
}));

test('wrong actor, stale revision and wrong recipe measurement cannot add evidence', () => fixture(db => {
    assert.throws(() => startVerification(db, { changeId: 'CHG-A', actorId: 'ACT-MFG', expectedRevisionNo: 1, at: times.started }), /Verification Engineer/i);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Plan Approved');
    startVerification(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1, at: times.started });
    assert.throws(() => addMeasurementEvidence(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 2,
        evidenceId: 'EVID-STALE', measurementId: 'MEAS-A-006-07', at: times.evidence }), /stale|revision/i);
    assert.throws(() => addMeasurementEvidence(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
        evidenceId: 'EVID-ROLE', measurementId: 'MEAS-A-006-07', at: times.evidence }), /Verification Engineer/i);
    assert.throws(() => addMeasurementEvidence(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-WRONG', measurementId: 'MEAS-A-008-01', at: times.evidence }), /recipe|scope/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM evidence_items').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 5);
}));

test('evidence and criterion timestamps cannot precede their source or linked evidence', () => fixture(db => {
    startVerification(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1, at: times.started });
    assert.throws(() => addMeasurementEvidence(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-EARLY', measurementId: 'MEAS-A-006-07', at: '2026-08-06T09:59:00.000Z'
    }), /source|measurement|time/i);
    assert.throws(() => addMeasurementEvidence(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-EQUAL', measurementId: 'MEAS-A-006-07', at: '2026-08-06T10:00:00.000Z'
    }), /source|measurement|time/i);
    addMeasurementEvidence(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-FAIL', measurementId: 'MEAS-A-006-07', at: times.evidence
    });
    assert.throws(() => recordAlignmentResult(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        resultId: 'RESULT-EARLY', evidenceId: 'EVID-FAIL', at: '2026-08-06T10:00:30.000Z'
    }), /evidence|time/i);
    assert.throws(() => recordAlignmentResult(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        resultId: 'RESULT-EQUAL', evidenceId: 'EVID-FAIL', at: times.evidence
    }), /evidence|time/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM criterion_results').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 6);
}));

test('a second run in the same first lot does not consume a second consecutive-lot slot', () => fixture(db => {
    startVerification(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1, at: times.started });
    db.prepare(`
        INSERT INTO process_runs(id,lot_id,equipment_id,module_id,recipe_revision_id,
            start_at,end_at,processed_units) VALUES (?,?,?,?,?,?,?,?)
    `).run('RUN-A-006-CHECK', 'LOT-A-006', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'REC-ALIGN-R2',
        '2026-08-06T11:00:00.000Z', '2026-08-06T11:30:00.000Z', 0);
    db.prepare(`
        INSERT INTO aoi_inspections(id,lot_id,process_run_id,inspected_at,inspected_units,rejected_units)
        VALUES (?,?,?,?,?,?)
    `).run('AOI-A-006-CHECK', 'LOT-A-006', 'RUN-A-006-CHECK', '2026-08-06T11:01:00.000Z', 0, 0);
    addMeasurementEvidence(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-FAIL', measurementId: 'MEAS-A-006-07', at: times.evidence
    });
    const result = recordAlignmentResult(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        resultId: 'RESULT-FAIL', evidenceId: 'EVID-FAIL', at: '2026-08-06T11:02:00.000Z'
    });
    assert.equal(result.passed, false);
    assert.equal(result.lotCount, 1);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Needs Rework');
}));

test('one passing measurement cannot satisfy a five-lot, twenty-sample-per-lot L3 plan', () => fixture(db => {
    startVerification(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1, at: times.started });
    addMeasurementEvidence(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-ONE', measurementId: 'MEAS-A-007-01', at: '2026-08-07T10:01:00.000Z'
    });
    assert.throws(() => recordAlignmentResult(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        resultId: 'RESULT-ONE', evidenceId: 'EVID-ONE', at: '2026-08-07T10:02:00.000Z'
    }), /insufficient|lot|sample|evidence/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM criterion_results').get().n, 0);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Verification In Progress');
}));

test('passing ALIGN-X aggregates evidence from each required consecutive lot and all samples', () => fixture(db => {
    // A fresh synthetic R3 change starts after the R2 baseline, with five R3 post-change lots.
    createChange(db, {
        id: 'CHG-B', title: 'Synthetic R3 alignment change', actorId: 'ACT-MFG',
        lineId: 'LINE-A', equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
        recipeRevisionId: 'REC-ALIGN-R3', baselineRef: 'AOI-A-007',
        reason: 'Revised synthetic alignment recipe', at: '2026-08-07T12:00:00.000Z'
    });
    submitChange(db, { changeId: 'CHG-B', actorId: 'ACT-MFG', expectedRevisionNo: 1, at: '2026-08-07T12:10:00.000Z' });
    classifyChange(db, { changeId: 'CHG-B', actorId: 'ACT-Q1', expectedRevisionNo: 1,
        assessmentId: 'RISK-B', riskInputs, at: '2026-08-07T12:20:00.000Z' });
    approvePlan(db, { changeId: 'CHG-B', actorId: 'ACT-Q1', expectedRevisionNo: 1,
        planId: 'PLAN-B', at: '2026-08-07T12:30:00.000Z' });
    startVerification(db, { changeId: 'CHG-B', actorId: 'ACT-VER', expectedRevisionNo: 1,
        at: '2026-08-08T08:00:00.000Z' });
    for (let day = 8; day <= 12; day++) {
        const suffix = String(day).padStart(3, '0');
        for (let sample = 1; sample <= 20; sample++) {
            const sampleSuffix = String(sample).padStart(2, '0');
            addMeasurementEvidence(db, {
                changeId: 'CHG-B', actorId: 'ACT-VER', expectedRevisionNo: 1,
                evidenceId: `EVID-${suffix}-${sampleSuffix}`,
                measurementId: `MEAS-A-${suffix}-${sampleSuffix}`,
                at: `2026-08-${String(day).padStart(2, '0')}T10:01:00.000Z`
            });
        }
    }
    addMeasurementEvidence(db, {
        changeId: 'CHG-B', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-012-20-SECOND', measurementId: 'MEAS-A-012-20',
        at: '2026-08-12T10:01:30.000Z'
    });
    assert.throws(() => recordAlignmentResult(db, {
        changeId: 'CHG-B', actorId: 'ACT-VER', expectedRevisionNo: 1,
        resultId: 'RESULT-PREMATURE', evidenceId: 'EVID-012-20-SECOND',
        at: '2026-08-12T10:02:00.000Z'
    }), /lot|ended|complete/i);
    const result = recordAlignmentResult(db, {
        changeId: 'CHG-B', actorId: 'ACT-VER', expectedRevisionNo: 1,
        resultId: 'RESULT-B', evidenceId: 'EVID-012-20-SECOND', at: '2026-08-12T12:01:00.000Z'
    });
    assert.equal(result.passed, true);
    assert.equal(result.sampleCount, 100);
    assert.equal(result.lotCount, 5);
    assert.equal(db.prepare("SELECT passed FROM criterion_results WHERE id='RESULT-B'").get().passed, 1);
    assert.equal(db.prepare("SELECT evidence_id FROM criterion_results WHERE id='RESULT-B'").get().evidence_id,
        'EVID-012-20-SECOND');
    const auditPayload = JSON.parse(db.prepare("SELECT payload_json FROM audit_events WHERE action='criterion-passed'").get().payload_json);
    assert.ok(auditPayload.linkedEvidenceIds.includes('EVID-012-20-SECOND'));
    assert.equal(new Set(auditPayload.linkedEvidenceIds).size, 101);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-B'").get().state, 'Verification In Progress');
    assert.equal(verifyAuditChain(db).count, 111);
}));
