import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { verifyAuditChain } from '../src/domain/audit.mjs';
import {
    createChange, submitChange, classifyChange, approvePlan,
    startVerification, recordBaselineSet
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

function fixture(baselineRef, operation, timing = {}) {
    const db = openDatabase(':memory:');
    try {
        seedDatabase(db, { instanceId: `DATASET-BASE-${baselineRef}` });
        createChange(db, {
            id: 'CHG-A', title: 'Synthetic R3 alignment change', actorId: 'ACT-MFG',
            lineId: 'LINE-A', equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
            recipeRevisionId: 'REC-ALIGN-R3', baselineRef,
            reason: 'Verify synthetic R3 change', at: timing.created ?? '2026-08-07T12:00:00.000Z'
        });
        submitChange(db, { changeId: 'CHG-A', actorId: 'ACT-MFG', expectedRevisionNo: 1,
            at: timing.submitted ?? '2026-08-07T12:10:00.000Z' });
        classifyChange(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
            assessmentId: 'RISK-A', riskInputs,
            at: timing.classified ?? '2026-08-07T12:20:00.000Z' });
        approvePlan(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
            planId: 'PLAN-A', at: timing.approved ?? '2026-08-07T12:30:00.000Z' });
        startVerification(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
            at: timing.started ?? '2026-08-08T08:00:00.000Z' });
        return operation(db);
    } finally {
        db.close();
    }
}

test('L3 baseline evidence references three pre-change same-recipe lots, 60 sampled units and AOI denominator', () => fixture('AOI-A-001', db => {
    assert.throws(() => recordBaselineSet(db, {
        changeId: 'CHG-A', actorId: 'ACT-MFG', expectedRevisionNo: 1,
        evidenceId: 'EVID-ROLE', at: '2026-08-08T08:01:00.000Z'
    }), /Verification Engineer/i);
    assert.throws(() => recordBaselineSet(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 2,
        evidenceId: 'EVID-STALE', at: '2026-08-08T08:01:00.000Z'
    }), /stale/i);
    const result = recordBaselineSet(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-BASE', at: '2026-08-08T08:01:00.000Z'
    });
    assert.deepEqual(result.lotIds, ['LOT-A-001', 'LOT-A-002', 'LOT-A-003']);
    assert.equal(result.sampledUnits, 60);
    assert.equal(result.inspectedUnits, 300);
    assert.equal(result.rejectedUnits, 0);
    const evidence = db.prepare("SELECT * FROM evidence_items WHERE id='EVID-BASE'").get();
    assert.equal(evidence.source_table, 'aoi_inspections');
    assert.equal(evidence.source_id, 'AOI-A-001');
    assert.equal(evidence.evidence_type, 'baseline-set');
    const payload = JSON.parse(evidence.payload_json);
    assert.equal(payload.measurements.length, 60);
    assert.equal(payload.aoiInspections.length, 3);
    assert.equal(payload.sampledUnits, 60);
    assert.equal(payload.inspectedUnits, 300);
    assert.equal(verifyAuditChain(db).count, 6);
    assert.throws(() => recordBaselineSet(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-BASE-2', at: '2026-08-08T08:02:00.000Z'
    }), /already|baseline/i);
}));

test('same target recipe revision cannot serve as an earlier baseline', () => fixture('AOI-A-008', db => {
    assert.throws(() => recordBaselineSet(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-SAME', at: '2026-08-14T08:01:00.000Z'
    }), /earlier|revision|baseline/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM evidence_items').get().n, 0);
}, {
    created: '2026-08-13T12:00:00.000Z', submitted: '2026-08-13T12:10:00.000Z',
    classified: '2026-08-13T12:20:00.000Z', approved: '2026-08-13T12:30:00.000Z',
    started: '2026-08-14T08:00:00.000Z'
}));

test('a selected baseline lot cannot hide an earlier different-recipe run before its AOI anchor', () => fixture('AOI-A-001', db => {
    db.prepare('INSERT INTO recipe_revisions(id,recipe_code,revision,effective_at) VALUES (?,?,?,?)')
        .run('REC-ALIGN-R0', 'ALIGN-A', 0, '2026-07-31T00:00:00.000Z');
    db.prepare(`
        INSERT INTO process_runs(id,lot_id,equipment_id,module_id,recipe_revision_id,
            start_at,end_at,processed_units) VALUES (?,?,?,?,?,?,?,?)
    `).run('RUN-A-001-PRE', 'LOT-A-001', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'REC-ALIGN-R0',
        '2026-08-01T08:30:00.000Z', '2026-08-01T08:50:00.000Z', 20);
    db.prepare(`
        INSERT INTO aoi_inspections(id,lot_id,process_run_id,inspected_at,inspected_units,rejected_units)
        VALUES (?,?,?,?,?,?)
    `).run('AOI-A-001-PRE', 'LOT-A-001', 'RUN-A-001-PRE', '2026-08-01T08:45:00.000Z', 20, 0);
    assert.throws(() => recordBaselineSet(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-MIXED', at: '2026-08-08T08:01:00.000Z'
    }), /mixed|different.recipe|baseline/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM evidence_items').get().n, 0);
}));

test('baseline measurement cannot be recorded before its declared sample time', () => fixture('AOI-A-001', db => {
    db.prepare(`
        INSERT INTO inspection_samples(id,lot_id,process_run_id,sampled_at,sample_size)
        VALUES (?,?,?,?,?)
    `).run('SAMPLE-A-001-EXTRA', 'LOT-A-001', 'RUN-A-001', '2026-08-01T10:05:00.000Z', 1);
    db.prepare(`
        INSERT INTO measurements(id,inspection_sample_id,characteristic_id,value,unit,method,recorded_at)
        VALUES (?,?,?,?,?,?,?)
    `).run('MEAS-A-001-EXTRA', 'SAMPLE-A-001-EXTRA', 'CHAR-ALIGN-X', 0.02,
        'mm', 'synthetic vision gauge', '2026-08-01T10:04:00.000Z');
    assert.throws(() => recordBaselineSet(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-EARLY', at: '2026-08-08T08:01:00.000Z'
    }), /measurement|sample|time/i);
}));

test('an intervening baseline lot with only ten measured units fails the twenty-per-lot gate', () => fixture('AOI-A-001', db => {
    db.prepare('INSERT INTO lots(id,product_family_id,code,quantity,start_at,end_at) VALUES (?,?,?,?,?,?)')
        .run('LOT-A-001B', 'PF-CAMERA', 'LOT-A-001B', 100,
            '2026-08-01T13:00:00.000Z', '2026-08-01T15:00:00.000Z');
    db.prepare(`
        INSERT INTO process_runs(id,lot_id,equipment_id,module_id,recipe_revision_id,
            start_at,end_at,processed_units) VALUES (?,?,?,?,?,?,?,?)
    `).run('RUN-A-001B', 'LOT-A-001B', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'REC-ALIGN-R1',
        '2026-08-01T13:30:00.000Z', '2026-08-01T14:30:00.000Z', 100);
    db.prepare('INSERT INTO inspection_samples(id,lot_id,process_run_id,sampled_at,sample_size) VALUES (?,?,?,?,?)')
        .run('SAMPLE-A-001B', 'LOT-A-001B', 'RUN-A-001B', '2026-08-01T14:00:00.000Z', 10);
    const insert = db.prepare(`
        INSERT INTO measurements(id,inspection_sample_id,characteristic_id,value,unit,method,recorded_at)
        VALUES (?,?,?,?,?,?,?)
    `);
    for (let n = 1; n <= 10; n++) {
        insert.run(`MEAS-A-001B-${n}`, 'SAMPLE-A-001B', 'CHAR-ALIGN-X', 0.02,
            'mm', 'synthetic vision gauge', '2026-08-01T14:00:00.000Z');
    }
    db.prepare(`
        INSERT INTO aoi_inspections(id,lot_id,process_run_id,inspected_at,inspected_units,rejected_units)
        VALUES (?,?,?,?,?,?)
    `).run('AOI-A-001B', 'LOT-A-001B', 'RUN-A-001B', '2026-08-01T14:15:00.000Z', 100, 0);
    assert.throws(() => recordBaselineSet(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-UNDER', at: '2026-08-08T08:01:00.000Z'
    }), /insufficient baseline sampled units/i);
}));

test('an earlier same-recipe run in a selected lot enters the AOI denominator', () => fixture('AOI-A-001', db => {
    db.prepare(`
        INSERT INTO process_runs(id,lot_id,equipment_id,module_id,recipe_revision_id,
            start_at,end_at,processed_units) VALUES (?,?,?,?,?,?,?,?)
    `).run('RUN-A-001-PRE', 'LOT-A-001', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'REC-ALIGN-R1',
        '2026-08-01T08:30:00.000Z', '2026-08-01T08:50:00.000Z', 20);
    db.prepare(`
        INSERT INTO aoi_inspections(id,lot_id,process_run_id,inspected_at,inspected_units,rejected_units)
        VALUES (?,?,?,?,?,?)
    `).run('AOI-A-001-PRE', 'LOT-A-001', 'RUN-A-001-PRE', '2026-08-01T08:45:00.000Z', 20, 0);
    const result = recordBaselineSet(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-FOUR-RUNS', at: '2026-08-08T08:01:00.000Z'
    });
    assert.equal(result.inspectedUnits, 320);
    assert.equal(result.sampledUnits, 60);
    const payload = JSON.parse(db.prepare("SELECT payload_json FROM evidence_items WHERE id='EVID-FOUR-RUNS'").get().payload_json);
    assert.equal(payload.aoiInspections.length, 4);
    assert.ok(payload.aoiInspections.some(row => row.id === 'AOI-A-001-PRE'));
}));

test('a lot continuing after change creation cannot be counted as a completed baseline lot', () => fixture('AOI-A-001', db => {
    assert.throws(() => recordBaselineSet(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-UNFINISHED', at: '2026-08-08T08:01:00.000Z'
    }), /lot|completed|baseline/i);
}, {
    created: '2026-08-03T11:00:00.000Z', submitted: '2026-08-03T11:10:00.000Z',
    classified: '2026-08-03T11:20:00.000Z', approved: '2026-08-03T11:30:00.000Z',
    started: '2026-08-08T08:00:00.000Z'
}));

test('two R2 baseline lots cannot be counted as a three-lot L3 baseline or mixed with post-change R3', () => fixture('AOI-A-006', db => {
    assert.throws(() => recordBaselineSet(db, {
        changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
        evidenceId: 'EVID-BAD', at: '2026-08-08T08:01:00.000Z'
    }), /insufficient|baseline|lot/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM evidence_items').get().n, 0);
    assert.equal(verifyAuditChain(db).count, 5);
}));
