import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { verifyAuditChain } from '../src/domain/audit.mjs';
import {
    createChange, submitChange, classifyChange, approvePlan, startVerification,
    addAoiEvidence, recordAoiResults
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
        seedDatabase(db, { instanceId: `DATASET-AOI-${options.startDay}` });
        createChange(db, {
            id: 'CHG-A', title: 'Synthetic AOI verification change', actorId: 'ACT-MFG',
            lineId: 'LINE-A', equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
            recipeRevisionId: options.recipeId, baselineRef: options.baselineRef,
            reason: 'Verify the synthetic alignment cell', at: at(options.startDay - 1, '12:00:00')
        });
        submitChange(db, { changeId: 'CHG-A', actorId: 'ACT-MFG', expectedRevisionNo: 1,
            at: at(options.startDay - 1, '12:10:00') });
        classifyChange(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
            assessmentId: 'RISK-A', riskInputs, at: at(options.startDay - 1, '12:20:00') });
        approvePlan(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
            planId: 'PLAN-A', at: at(options.startDay - 1, '12:30:00') });
        startVerification(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
            at: at(options.startDay, '08:00:00') });
        return operation(db);
    } finally {
        db.close();
    }
}

const r3 = { startDay: 8, recipeId: 'REC-ALIGN-R3', baselineRef: 'AOI-A-007' };
const r2 = { startDay: 6, recipeId: 'REC-ALIGN-R2', baselineRef: 'AOI-A-005' };

function attach(db, day) {
    return addAoiEvidence(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: `EVID-AOI-${suffix(day)}`, inspectionId: `AOI-A-${suffix(day)}`,
        at: at(day, '10:31:00')
    });
}

test('five consecutive R3 lots link full AOI coverage and pass rate/critical criteria with 500-unit denominator', () => fixture(r3, db => {
    db.prepare(`
        INSERT INTO evidence_items(id,change_revision_id,source_table,source_id,evidence_type,
            payload_json,sha256,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)
    `).run('EVID-FORGED', 'CHG-A-R1', 'aoi_inspections', 'AOI-A-008', 'aoi',
        '{"bogus":true}', 'a'.repeat(64), 'ACT-VER', at(8, '10:30:30'));
    for (let day = 8; day <= 12; day++) attach(db, day);
    assert.throws(() => recordAoiResults(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        resultPrefix: 'RESULT-PREMATURE', at: at(12, '10:32:00')
    }), /lot|ended|complete/i);
    const result = recordAoiResults(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        resultPrefix: 'RESULT-AOI', at: at(12, '12:01:00')
    });
    assert.equal(result.passed, true);
    assert.equal(result.lotCount, 5);
    assert.equal(result.inspectedUnits, 500);
    assert.equal(result.rejectedUnits, 1);
    assert.equal(result.rejectRate, 1 / 500);
    assert.equal(result.criticalDefects, 0);
    const rows = db.prepare("SELECT criterion_code,passed,observed_value,evidence_id FROM criterion_results WHERE plan_id='PLAN-A' ORDER BY criterion_code").all();
    assert.deepEqual(rows.map(row => [row.criterion_code, row.passed, row.observed_value]), [
        ['AOI-RATE', 1, 1 / 500], ['CRITICAL-DEFECTS', 1, 0]
    ]);
    const audit = JSON.parse(db.prepare("SELECT payload_json FROM audit_events WHERE action='aoi-criteria-passed'").get().payload_json);
    assert.equal(audit.linkedEvidenceIds.length, 5);
    assert.ok(!audit.linkedEvidenceIds.includes('EVID-FORGED'));
    assert.ok(rows.every(row => audit.linkedEvidenceIds.includes(row.evidence_id)));
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Verification In Progress');
    assert.equal(verifyAuditChain(db).count, 11);
}));

test('one passing AOI lot and missing source evidence cannot complete the approved L3 window', () => fixture(r3, db => {
    assert.throws(() => addAoiEvidence(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-EARLY', inspectionId: 'AOI-A-008', at: at(8, '10:30:00') }), /source|time/i);
    attach(db, 8);
    assert.throws(() => recordAoiResults(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        resultPrefix: 'RESULT-ONE', at: at(8, '10:32:00') }), /insufficient|lot/i);
    for (let day = 9; day <= 11; day++) attach(db, day);
    assert.throws(() => recordAoiResults(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        resultPrefix: 'RESULT-FOUR', at: at(12, '12:01:00') }), /evidence|coverage/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM criterion_results').get().n, 0);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Verification In Progress');
}));

test('critical AOI defect fails early without claiming a passing rate for an incomplete cohort', () => fixture(r2, db => {
    attach(db, 6);
    const result = recordAoiResults(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        resultPrefix: 'RESULT-CRIT', at: at(6, '10:32:00') });
    assert.equal(result.passed, false);
    assert.deepEqual(result.failedCodes, ['CRITICAL-DEFECTS']);
    assert.equal(result.criticalDefects, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM criterion_results WHERE criterion_code='AOI-RATE'").get().n, 0);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Needs Rework');
    assert.equal(verifyAuditChain(db).count, 7);
}));

test('AOI reject rate above 2% fails early using inspected units as denominator', () => fixture({
    startDay: 26, recipeId: 'REC-ALIGN-R3', baselineRef: 'AOI-A-025'
}, db => {
    attach(db, 26);
    const result = recordAoiResults(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        resultPrefix: 'RESULT-RATE', at: at(26, '10:32:00') });
    assert.equal(result.passed, false);
    assert.deepEqual(result.failedCodes, ['AOI-RATE']);
    assert.equal(result.rejectRate, 5 / 100);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Needs Rework');
}));
