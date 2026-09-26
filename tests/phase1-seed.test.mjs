import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDatabase, assertDataIntegrity } from '../src/data/db.mjs';
import { seedDatabase, getDemoMetrics } from '../src/data/seed.mjs';

const sourceTables = [
    'lines', 'equipment', 'modules', 'recipe_revisions', 'product_families',
    'characteristics', 'defect_codes', 'lots', 'process_runs',
    'inspection_samples', 'measurements', 'aoi_inspections', 'aoi_defects',
    'equipment_events', 'maintenance_actions'
];

function sourceDigest(db) {
    const rows = sourceTables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]);
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

test('synthetic source rows reproduce across distinct dataset instances', () => {
    const first = openDatabase(':memory:');
    const second = openDatabase(':memory:');
    try {
        seedDatabase(first, { instanceId: 'DATASET-ONE' });
        seedDatabase(second, { instanceId: 'DATASET-TWO' });
        assert.equal(sourceDigest(first), sourceDigest(second));
        assert.equal(first.prepare('SELECT id FROM dataset_instances').get().id, 'DATASET-ONE');
        assert.equal(second.prepare('SELECT id FROM dataset_instances').get().id, 'DATASET-TWO');
        assert.deepEqual(first.prepare('PRAGMA foreign_key_check').all(), []);
        assert.doesNotThrow(() => assertDataIntegrity(first));
        assert.equal(first.prepare('SELECT COUNT(*) AS n FROM lots').get().n, 45);
        assert.equal(first.prepare('SELECT COUNT(*) AS n FROM process_runs').get().n, 45);
        assert.equal(first.prepare('SELECT COUNT(*) AS n FROM aoi_inspections').get().n, 45);
        assert.equal(first.prepare('SELECT COUNT(*) AS n FROM measurements').get().n, 825);
        assert.equal(first.prepare('SELECT COUNT(*) AS n FROM (SELECT s.id FROM inspection_samples s LEFT JOIN measurements m ON m.inspection_sample_id=s.id GROUP BY s.id HAVING COUNT(m.id)<>s.sample_size)').get().n, 0);
    } finally {
        first.close();
        second.close();
    }
});

test('Scenario A, B, C and low-risk contrast are present as source evidence', () => {
    const db = openDatabase(':memory:');
    try {
        seedDatabase(db, { instanceId: 'DATASET-STORY' });
        const recipe = (lotId) => db.prepare('SELECT recipe_revision_id AS id FROM process_runs WHERE lot_id = ?').get(lotId).id;
        assert.equal(recipe('LOT-A-005'), 'REC-ALIGN-R1');
        assert.equal(recipe('LOT-A-006'), 'REC-ALIGN-R2');
        assert.equal(recipe('LOT-A-008'), 'REC-ALIGN-R3');
        assert.equal(recipe('LOT-B-004'), 'REC-B-R2');
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM measurements m JOIN inspection_samples s ON s.id=m.inspection_sample_id WHERE s.lot_id='LOT-A-006' AND m.value=0.10").get().n, 1);
        const fiducial = (lotId) => db.prepare("SELECT COALESCE(SUM(d.defect_count),0) AS n FROM aoi_defects d JOIN defect_codes c ON c.id=d.defect_code_id JOIN aoi_inspections a ON a.id=d.aoi_inspection_id WHERE a.lot_id=? AND c.code='DC-FIDUCIAL'").get(lotId).n;
        assert.equal(fiducial('LOT-A-024'), 0);
        assert.equal(fiducial('LOT-A-026'), 5);
        assert.equal(fiducial('LOT-A-027'), 4);
        assert.equal(fiducial('LOT-A-039'), 1);
        assert.equal(db.prepare("SELECT start_at FROM maintenance_actions WHERE id='MA-VISION-2'").get().start_at, '2026-08-24T18:00:00.000Z');
        const run25 = db.prepare("SELECT start_at,end_at FROM process_runs WHERE lot_id='LOT-A-025'").get();
        const run27 = db.prepare("SELECT start_at,end_at FROM process_runs WHERE lot_id='LOT-A-027'").get();
        assert.equal(run25.start_at, '2026-08-25T09:00:00.000Z');
        assert.equal(run27.end_at, '2026-08-27T11:00:00.000Z');
        const eventTime = (id) => db.prepare('SELECT occurred_at FROM equipment_events WHERE id=?').get(id)?.occurred_at;
        assert.equal(eventTime('EV-LKG-EARLIEST'), '2026-08-25T08:00:00.000Z');
        assert.equal(eventTime('EV-LKG-LATEST'), '2026-08-25T12:00:00.000Z');
        assert.equal(eventTime('EV-DETECTION'), '2026-08-27T10:00:00.000Z');
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM aoi_defects d JOIN aoi_inspections a ON a.id=d.aoi_inspection_id JOIN process_runs r ON r.id=a.process_run_id JOIN maintenance_actions m ON m.id='MA-VISION-2' AND m.equipment_id=r.equipment_id AND m.module_id=r.module_id WHERE a.lot_id='LOT-A-026' AND d.defect_code_id='DEF-FIDUCIAL'").get().n, 1);
        const moduleFor = (lotId) => db.prepare('SELECT module_id FROM process_runs WHERE lot_id=?').get(lotId).module_id;
        assert.equal(moduleFor('LOT-B-002'), 'MOD-ALIGN-B');
        assert.equal(moduleFor('LOT-B-003'), 'MOD-ALIGN-B-R2');
        assert.equal(eventTime('EV-B-MODULE'), '2026-08-05T00:00:00.000Z');
    } finally {
        db.close();
    }
});

test('all displayed seed metrics reconcile to source rows and reseed is atomic', () => {
    const db = openDatabase(':memory:');
    try {
        seedDatabase(db, { instanceId: 'DATASET-METRICS' });
        const metrics = getDemoMetrics(db);
        assert.equal(metrics.inspectedUnits, 4500);
        assert.equal(metrics.rejectedUnits, db.prepare('SELECT SUM(rejected_units) AS n FROM aoi_inspections').get().n);
        assert.equal(metrics.rejectRate, metrics.rejectedUnits / metrics.inspectedUnits);
        assert.equal(metrics.rejectDppm, 1_000_000 * metrics.rejectRate);
        assert.equal(metrics.mttrHours, 1.5);
        assert.equal(metrics.mtbfHours, 478.5);
        db.prepare("INSERT INTO maintenance_actions(id,equipment_id,module_id,code,summary,start_at,end_at) VALUES ('MA-UNRELATED','EQ-ALIGN-A','MOD-ALIGN-A','REPAIR','Unrelated synthetic repair','2026-08-19T01:00:00.000Z','2026-08-19T05:00:00.000Z')").run();
        db.prepare("INSERT INTO equipment_events(id,equipment_id,module_id,event_type,occurred_at,duration_seconds) VALUES ('EV-OUTSIDE','EQ-ALIGN-A','MOD-ALIGN-A','failure','2026-09-12T01:00:00.000Z',3600)").run();
        assert.equal(getDemoMetrics(db).mttrHours, 1.5);
        assert.equal(getDemoMetrics(db).mtbfHours, 478.5);
        const before = sourceDigest(db);
        assert.throws(() => seedDatabase(db, { instanceId: 'DATASET-SECOND' }));
        assert.equal(sourceDigest(db), before);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dataset_instances').get().n, 1);
    } finally {
        db.close();
    }
});

test('seed rolls back source rows after a late insertion failure', () => {
    const db = openDatabase(':memory:');
    try {
        db.exec("CREATE TRIGGER test_seed_failure BEFORE INSERT ON process_runs WHEN NEW.id='RUN-A-010' BEGIN SELECT RAISE(ABORT,'injected late seed failure'); END");
        assert.throws(() => seedDatabase(db, { instanceId: 'DATASET-ROLLBACK' }), /injected late seed failure/i);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dataset_instances').get().n, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lots').get().n, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM measurements').get().n, 0);
    } finally {
        db.close();
    }
});
