import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, withValidatedTransaction } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { appendAuditEvent, verifyAuditChain } from '../src/domain/audit.mjs';
import {
    createChange, submitChange, classifyChange, approvePlan, startVerification,
    recordBaselineSet, addMeasurementEvidence, recordAlignmentResult,
    addAoiEvidence, recordAoiResults, markEvidenceReady
} from '../src/domain/change-service.mjs';

const riskInputs = {
    severity: 2, occurrence: 1, detectability: 2, scope: 1,
    criticalCharacteristic: true, safetyRelevance: false,
    bases: {
        severity: 'Synthetic alignment characteristic', occurrence: 'Three baseline lots below 1%',
        detectability: 'AOI and sampled alignment', scope: 'One module and recipe',
        criticalCharacteristic: 'ALIGN-X demo critical characteristic', safetyRelevance: 'No synthetic safety impact'
    }
};
const at = (day, time) => `2026-08-${String(day).padStart(2, '0')}T${time}.000Z`;
const suffix = day => String(day).padStart(3, '0');

function fixture(options, operation) {
    const db = openDatabase(':memory:');
    try {
        seedDatabase(db, { instanceId: 'DATASET-READY' });
        createChange(db, {
            id: 'CHG-A', title: 'Synthetic R3 verification', actorId: 'ACT-MFG',
            lineId: 'LINE-A', equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
            recipeRevisionId: 'REC-ALIGN-R3', baselineRef: 'AOI-A-001',
            reason: 'Verify synthetic alignment improvement', at: at(7, '12:00:00')
        });
        submitChange(db, { changeId: 'CHG-A', actorId: 'ACT-MFG', expectedRevisionNo: 1,
            at: at(7, '12:10:00') });
        classifyChange(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
            assessmentId: 'RISK-A', riskInputs, at: at(7, '12:20:00') });
        approvePlan(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
            planId: 'PLAN-A', at: at(7, '12:30:00') });
        startVerification(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
            at: at(8, options.delayedStart ? '08:15:00' : '08:00:00') });
        if (options.baseline !== false) {
            recordBaselineSet(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
                evidenceId: 'EVID-BASE', at: at(8, options.delayedStart ? '08:16:00' : '08:01:00') });
        }
        for (let day = 8; day <= 12; day++) {
            for (let unit = 1; unit <= 20; unit++) {
                const id = `MEAS-A-${suffix(day)}-${String(unit).padStart(2, '0')}`;
                addMeasurementEvidence(db, {
                    changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
                    evidenceId: `EVID-${suffix(day)}-${String(unit).padStart(2, '0')}`,
                    measurementId: id, at: at(day, '10:01:00')
                });
            }
            if (options.aoiEvidence !== false) {
                addAoiEvidence(db, {
                    changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
                    evidenceId: `EVID-AOI-${suffix(day)}`, inspectionId: `AOI-A-${suffix(day)}`,
                    at: at(day, '10:31:00')
                });
            }
        }
        recordAlignmentResult(db, {
            changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
            resultId: 'RESULT-ALIGN', evidenceId: 'EVID-012-20', at: at(12, '12:01:00')
        });
        if (options.aoiResults !== false) {
            recordAoiResults(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
                resultPrefix: 'RESULT-AOI', at: at(12, '12:02:00') });
        }
        return operation(db);
    } finally {
        db.close();
    }
}

const ready = { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
    at: at(12, '12:03:00') };

test('Evidence Ready freezes plan, source evidence and all three passed criteria with a reconstructible digest', () => fixture({}, db => {
    const result = markEvidenceReady(db, ready);
    assert.equal(result.state, 'Evidence Ready');
    assert.match(result.packageDigest, /^[0-9a-f]{64}$/);
    assert.equal(result.evidenceCount, 106);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Evidence Ready');
    const audit = db.prepare("SELECT payload_json FROM audit_events WHERE action='evidence-ready'").get();
    assert.equal(JSON.parse(audit.payload_json).packageDigest, result.packageDigest);
    assert.equal(verifyAuditChain(db).count, 114);
}));

test('missing baseline or incomplete AOI criteria cannot enter Evidence Ready', () => fixture({ baseline: false }, db => {
    assert.throws(() => markEvidenceReady(db, ready), /baseline/i);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Verification In Progress');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='evidence-ready'").get().n, 0);
}));

test('one passed dimensional criterion cannot substitute for both AOI criteria', () => fixture({ aoiEvidence: false, aoiResults: false }, db => {
    assert.throws(() => markEvidenceReady(db, ready), /criterion|AOI|missing/i);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Verification In Progress');
}));

test('an unaudited extra evidence row cannot silently enter the frozen package', () => fixture({}, db => {
    const payloadJson = JSON.stringify({ text: 'Synthetic unaudited note' });
    db.prepare(`
        INSERT INTO evidence_items(id,change_revision_id,source_table,source_id,evidence_type,
            payload_json,sha256,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)
    `).run('EVID-UNAUDITED', 'CHG-A-R1', 'embedded_note', 'EVID-UNAUDITED', 'note',
        payloadJson, createHash('sha256').update(payloadJson).digest('hex'),
        'ACT-VER', at(12, '12:02:30'));
    assert.throws(() => markEvidenceReady(db, ready), /audit|evidence/i);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Verification In Progress');
}));

test('a later source measurement cannot hide behind an earlier passing sampled result', () => fixture({}, db => {
    db.prepare(`
        INSERT INTO measurements(id,inspection_sample_id,characteristic_id,value,unit,method,recorded_at)
        VALUES (?,?,?,?,?,?,?)
    `).run('MEAS-A-008-LATE', 'SAMPLE-A-008', 'CHAR-ALIGN-X', 0.10,
        'mm', 'synthetic vision gauge', at(8, '10:00:00'));
    assert.throws(() => markEvidenceReady(db, ready), /source|measurement|sample|evidence|criterion/i);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Verification In Progress');
}));

test('baseline proof is rechecked against its full original sample set before freezing', () => fixture({}, db => {
    db.prepare(`
        INSERT INTO measurements(id,inspection_sample_id,characteristic_id,value,unit,method,recorded_at)
        VALUES (?,?,?,?,?,?,?)
    `).run('MEAS-A-001-LATE', 'SAMPLE-A-001', 'CHAR-ALIGN-X', 0.02,
        'mm', 'synthetic vision gauge', at(1, '10:00:00'));
    assert.throws(() => markEvidenceReady(db, ready), /baseline|source|sample|measurement/i);
}));

test('a changed AOI defect snapshot invalidates previously linked evidence at readiness', () => fixture({}, db => {
    db.prepare(`
        INSERT INTO aoi_defects(id,aoi_inspection_id,defect_code_id,defect_count,location)
        VALUES (?,?,?,?,?)
    `).run('AOIDEF-ZERO-LATE', 'AOI-A-008', 'DEF-COSMETIC', 0, 'synthetic later code');
    assert.throws(() => markEvidenceReady(db, ready), /source|AOI|defect|evidence/i);
}));

test('audited but forged AOI criterion values cannot replace a source-derived reject rate', () => fixture({ aoiResults: false }, db => {
    withValidatedTransaction(db, tx => {
        const insert = tx.prepare(`
            INSERT INTO criterion_results(id,plan_id,criterion_code,evidence_id,verifier_actor_id,
                passed,observed_value,unit,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)
        `);
        insert.run('FORGED-RATE', 'PLAN-A', 'AOI-RATE', 'EVID-AOI-008', 'ACT-VER',
            1, 0, 'fraction', at(12, '12:02:00'));
        insert.run('FORGED-CRIT', 'PLAN-A', 'CRITICAL-DEFECTS', 'EVID-AOI-008', 'ACT-VER',
            1, 0, 'count', at(12, '12:02:00'));
        appendAuditEvent(tx, {
            actorId: 'ACT-VER', recordedAt: at(12, '12:02:00'),
            entityType: 'change', entityId: 'CHG-A', entityRevisionId: 'CHG-A-R1',
            action: 'aoi-criteria-passed', linkedEvidenceIds: ['EVID-AOI-008'],
            payload: { planId: 'PLAN-A', reportedCodes: ['AOI-RATE', 'CRITICAL-DEFECTS'] }
        });
    });
    assert.throws(() => markEvidenceReady(db, ready), /source|AOI|rate|result|criterion/i);
}));

test('closed deviations still need auditable disposition and chronology before readiness', () => fixture({}, db => {
    db.prepare(`
        INSERT INTO deviations(id,plan_id,description,blocking,disposition,recorded_by,recorded_at)
        VALUES (?,?,?,?,?,?,?)
    `).run('DEV-LATE', 'PLAN-A', 'Synthetic closed but unaudited deviation', 1,
        'Closed', 'ACT-Q1', at(12, '12:04:00'));
    assert.throws(() => markEvidenceReady(db, ready), /deviation|audit|time/i);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Verification In Progress');
}));

test('an advance audit link cannot certify evidence written later under the same ID', () => fixture({}, db => {
    const original = db.prepare("SELECT * FROM evidence_items WHERE id='EVID-008-01'").get();
    withValidatedTransaction(db, tx => {
        appendAuditEvent(tx, {
            actorId: 'ACT-VER', recordedAt: at(12, '11:00:00'),
            entityType: 'change', entityId: 'CHG-A', entityRevisionId: 'CHG-A-R1',
            action: 'measurement-evidence-added', linkedEvidenceIds: ['EVID-FUTURE'],
            payload: { evidenceId: 'EVID-FUTURE', measurementId: original.source_id,
                lotId: 'LOT-A-008', sha256: original.sha256 }
        });
        tx.prepare(`
            INSERT INTO evidence_items(id,change_revision_id,source_table,source_id,evidence_type,
                payload_json,sha256,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)
        `).run('EVID-FUTURE', original.change_revision_id, original.source_table,
            original.source_id, original.evidence_type, original.payload_json,
            original.sha256, 'ACT-VER', at(12, '11:01:00'));
    });
    assert.throws(() => markEvidenceReady(db, ready), /audit|provenance|evidence|time/i);
}));

test('a selected post-change lot cannot hide a run before verification start', () => fixture({ delayedStart: true }, db => {
    db.prepare(`
        INSERT INTO process_runs(id,lot_id,equipment_id,module_id,recipe_revision_id,
            start_at,end_at,processed_units) VALUES (?,?,?,?,?,?,?,?)
    `).run('RUN-A-008-EARLY', 'LOT-A-008', 'EQ-ALIGN-A', 'MOD-ALIGN-A',
        'REC-ALIGN-R3', at(8, '08:05:00'), at(8, '08:10:00'), 1);
    db.prepare(`
        INSERT INTO aoi_inspections(id,lot_id,process_run_id,inspected_at,inspected_units,rejected_units)
        VALUES (?,?,?,?,?,?)
    `).run('AOI-A-008-EARLY', 'LOT-A-008', 'RUN-A-008-EARLY',
        at(8, '08:09:00'), 1, 0);
    assert.throws(() => markEvidenceReady(db, ready), /selected post-change lot began before verification/i);
}));

test('criterion verifier identity must match the actor in its audited decision', () => fixture({}, db => {
    db.prepare('INSERT INTO demo_actors(id,role,display_name) VALUES (?,?,?)')
        .run('ACT-VER2', 'Verification Engineer', 'Synthetic second verifier');
    shiftSyntheticSourceFact(db, 'immutable_criterion_result_update',
        "UPDATE criterion_results SET verifier_actor_id=? WHERE id='RESULT-AOI-AOI-RATE'",
        'ACT-VER2');
    assert.throws(() => markEvidenceReady(db, ready), /criterion|verifier|audit|actor/i);
}));

function shiftSyntheticSourceFact(db, triggerName, statement, value) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
        .get(triggerName);
    assert.ok(row);
    db.exec(`DROP TRIGGER ${triggerName}`);
    db.prepare(statement).run(value);
    db.exec(row.sql);
}

test('the frozen digest includes source eligibility times rather than only aggregate values', () => {
    fixture({}, db => {
        const tempDir = mkdtempSync(join(tmpdir(), 'fabassure-ready-'));
        const snapshotPath = join(tempDir, 'before.sqlite');
        try {
            db.exec(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`);
            const original = markEvidenceReady(db, ready).packageDigest;
            const variants = [
                ['immutable_lot_update', "UPDATE lots SET end_at=? WHERE id='LOT-A-008'", at(8, '12:00:30')],
                ['immutable_run_update', "UPDATE process_runs SET end_at=? WHERE id='RUN-A-008'", at(8, '11:00:30')],
                ['immutable_sample_update', "UPDATE inspection_samples SET sampled_at=? WHERE id='SAMPLE-A-008'", at(8, '09:59:30')]
            ];
            for (const [index, [trigger, statement, value]] of variants.entries()) {
                const clonePath = join(tempDir, `variant-${index}.sqlite`);
                copyFileSync(snapshotPath, clonePath);
                const clone = openDatabase(clonePath);
                try {
                    shiftSyntheticSourceFact(clone, trigger, statement, value);
                    assert.notEqual(original, markEvidenceReady(clone, ready).packageDigest);
                } finally {
                    clone.close();
                }
            }
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
