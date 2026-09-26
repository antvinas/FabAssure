import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { getEquipmentRegister, getEquipmentTimeline } from '../src/domain/equipment-timeline.mjs';

function fixture(run) {
    const db = openDatabase(':memory:');
    try {
        seedDatabase(db, { instanceId: 'DATASET-EQUIPMENT' });
        return run(db);
    } finally {
        db.close();
    }
}

test('equipment register identifies synthetic line and module without implying live connection', () => fixture(db => {
    const records = getEquipmentRegister(db);
    assert.ok(records.some(item => item.id === 'EQ-ALIGN-A' && item.lineId === 'LINE-A' &&
        item.modules.some(module => module.id === 'MOD-ALIGN-A')));
    assert.ok(records.some(item => item.id === 'EQ-ALIGN-B' && item.lineId === 'LINE-B'));
    assert.equal(records.some(item => 'host' in item || 'endpoint' in item), false);
}));

test('equipment timeline reconciles event and repair sources in its explicit window', () => fixture(db => {
    const detail = getEquipmentTimeline(db, 'EQ-ALIGN-A');
    assert.equal(detail.equipment.id, 'EQ-ALIGN-A');
    assert.deepEqual(detail.observationWindow, {
        startAt: '2026-08-01T00:00:00.000Z', endExclusiveAt: '2026-09-10T00:00:00.000Z',
        hours: 960
    });
    assert.equal(detail.reliability.failureCount, 2);
    assert.equal(detail.reliability.downtimeHours, 3);
    assert.equal(detail.reliability.mttrHours, 1.5);
    assert.equal(detail.reliability.mtbfHours, 478.5);
    assert.deepEqual(detail.reliability.failureEventIds, ['EV-VISION-1', 'EV-VISION-2']);
    assert.deepEqual(detail.reliability.repairActionIds, ['MA-VISION-1', 'MA-VISION-2']);
    const event = detail.timeline.find(item => item.id === 'EV-VISION-2');
    const repair = detail.timeline.find(item => item.id === 'MA-VISION-2');
    assert.equal(event.kind, 'equipment-event');
    assert.equal(event.moduleId, 'MOD-ALIGN-A');
    assert.equal(repair.kind, 'maintenance-action');
    assert.equal(repair.startAt, event.at);
    assert.equal(repair.endAt, '2026-08-24T20:00:00.000Z');
    assert.ok(detail.timeline.every((item, index, rows) => index === 0 || rows[index - 1].at <= item.at));
    assert.ok(detail.processRunCount > 0);
    assert.ok(detail.aoi.inspectedUnits > 0);
    assert.equal(detail.aoi.inspectionCount, 40);
    const excursion = detail.aoiInspections.find(item => item.id === 'AOI-A-026');
    assert.equal(excursion.processRunId, 'RUN-A-026');
    assert.ok(excursion.defects.some(item => item.defectCodeId === 'DEF-FIDUCIAL'));
    assert.ok(excursion.defects.some(item => item.id === 'AOIDEF-A-026-1'));
    assert.ok(detail.timeline.some(item => item.id === 'AOI-A-026' &&
        item.kind === 'aoi-defect-signal'));
    assert.equal(detail.synthetic, true);
}));

test('a tool with no failure has no MTBF or MTTR and does not inherit another tool metric', () => fixture(db => {
    const detail = getEquipmentTimeline(db, 'EQ-ALIGN-B');
    assert.equal(detail.reliability.failureCount, 0);
    assert.equal(detail.reliability.mtbfHours, null);
    assert.equal(detail.reliability.mttrHours, null);
    assert.ok(detail.timeline.some(item => item.id === 'EV-B-MODULE'));
    assert.equal(detail.timeline.some(item => item.id === 'EV-VISION-2'), false);
}));

test('unreconciled failure is rejected rather than silently changing reliability figures', () => fixture(db => {
    db.prepare(`INSERT INTO equipment_events(id,equipment_id,module_id,event_type,occurred_at,duration_seconds)
        VALUES ('EV-UNMATCHED','EQ-ALIGN-A','MOD-ALIGN-A','failure','2026-08-30T01:00:00.000Z',3600)`).run();
    assert.throws(() => getEquipmentTimeline(db, 'EQ-ALIGN-A'), /Unreconciled failure.*EV-UNMATCHED/);
}));

test('a repair cannot be reused by two failures or omitted from reliability reconciliation', () => fixture(db => {
    db.prepare(`INSERT INTO equipment_events(id,equipment_id,module_id,event_type,occurred_at,duration_seconds)
        VALUES ('EV-DUPLICATE','EQ-ALIGN-A','MOD-ALIGN-A','failure','2026-08-24T18:00:00.000Z',7200)`).run();
    assert.throws(() => getEquipmentTimeline(db, 'EQ-ALIGN-A'), /Unreconciled failure.*EV-VISION-2/);
}));

test('an unmatched repair is not silently excluded from the downtime denominator', () => fixture(db => {
    db.prepare(`INSERT INTO maintenance_actions(id,equipment_id,module_id,code,summary,start_at,end_at)
        VALUES ('MA-ORPHAN','EQ-ALIGN-A','MOD-ALIGN-A','REPAIR','Synthetic unmatched repair',
        '2026-08-30T03:00:00.000Z','2026-08-30T04:00:00.000Z')`).run();
    assert.throws(() => getEquipmentTimeline(db, 'EQ-ALIGN-A'), /Unreconciled repair.*MA-ORPHAN/);
}));

test('AOI totals use the same in-window process-run cohort as the run count', () => fixture(db => {
    const before = getEquipmentTimeline(db, 'EQ-ALIGN-A');
    db.prepare(`INSERT INTO recipe_revisions(id,recipe_code,revision,effective_at)
        VALUES ('REC-BOUNDARY','BOUNDARY',1,'2026-07-31T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO lots(id,product_family_id,code,quantity,start_at,end_at)
        VALUES ('LOT-BOUNDARY','PF-CAMERA','LOT-BOUNDARY',100,
        '2026-07-31T22:00:00.000Z','2026-08-01T02:00:00.000Z')`).run();
    db.prepare(`INSERT INTO process_runs(id,lot_id,equipment_id,module_id,recipe_revision_id,
        start_at,end_at,processed_units) VALUES ('RUN-BOUNDARY','LOT-BOUNDARY',
        'EQ-ALIGN-A','MOD-ALIGN-A','REC-BOUNDARY',
        '2026-07-31T23:00:00.000Z','2026-08-01T01:00:00.000Z',100)`).run();
    db.prepare(`INSERT INTO aoi_inspections(id,lot_id,process_run_id,inspected_at,
        inspected_units,rejected_units) VALUES ('AOI-BOUNDARY','LOT-BOUNDARY',
        'RUN-BOUNDARY','2026-08-01T00:30:00.000Z',100,0)`).run();
    const after = getEquipmentTimeline(db, 'EQ-ALIGN-A');
    assert.equal(after.processRunCount, before.processRunCount);
    assert.equal(after.aoi.inspectedUnits, before.aoi.inspectedUnits);
    assert.equal(after.aoiInspections.some(item => item.id === 'AOI-BOUNDARY'), false);
    assert.match(after.aoiCohort, /inspections timestamped inside.*runs starting inside/i);
}));

test('repair crossing either observation edge leaves reliability uncalculated without losing source detail', () => fixture(db => {
    db.prepare(`INSERT INTO equipment_events(id,equipment_id,module_id,event_type,occurred_at,duration_seconds)
        VALUES ('EV-LATE','EQ-ALIGN-A','MOD-ALIGN-A','failure','2026-09-09T23:00:00.000Z',7200)`).run();
    db.prepare(`INSERT INTO maintenance_actions(id,equipment_id,module_id,code,summary,start_at,end_at)
        VALUES ('MA-LATE','EQ-ALIGN-A','MOD-ALIGN-A','REPAIR','Synthetic edge repair',
        '2026-09-09T23:00:00.000Z','2026-09-10T01:00:00.000Z')`).run();
    const late = getEquipmentTimeline(db, 'EQ-ALIGN-A');
    assert.equal(late.reliability.failureCount, 3);
    assert.equal(late.reliability.mtbfHours, null);
    assert.equal(late.reliability.mttrHours, null);
    assert.deepEqual(late.reliability.boundaryRepairActionIds, ['MA-LATE']);
    assert.match(late.reliability.notCalculatedReason, /observation boundary/);
    assert.ok(late.timeline.some(item => item.id === 'MA-LATE'));
    db.prepare(`INSERT INTO equipment_events(id,equipment_id,module_id,event_type,occurred_at,duration_seconds)
        VALUES ('EV-EARLY','EQ-ALIGN-A','MOD-ALIGN-A','failure','2026-07-31T23:00:00.000Z',7200)`).run();
    db.prepare(`INSERT INTO maintenance_actions(id,equipment_id,module_id,code,summary,start_at,end_at)
        VALUES ('MA-EARLY','EQ-ALIGN-A','MOD-ALIGN-A','REPAIR','Synthetic pre-window repair',
        '2026-07-31T23:00:00.000Z','2026-08-01T01:00:00.000Z')`).run();
    const both = getEquipmentTimeline(db, 'EQ-ALIGN-A');
    assert.deepEqual(both.reliability.boundaryRepairActionIds, ['MA-EARLY', 'MA-LATE']);
    assert.equal(both.reliability.mtbfHours, null);
}));

test('unknown equipment yields no detail and source reads do not mutate the database', () => fixture(db => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
    assert.equal(getEquipmentTimeline(db, 'EQ-NOT-SEEDED'), null);
    getEquipmentTimeline(db, 'EQ-ALIGN-A');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, before);
}));
