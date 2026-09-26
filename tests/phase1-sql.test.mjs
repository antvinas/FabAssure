import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const schemaPath = fileURLToPath(new URL('../src/data/schema.sql', import.meta.url));
const schema = readFileSync(schemaPath, 'utf8');
const insertInstance = (db) => db.prepare("INSERT INTO dataset_instances(id,code,version,seed,generated_at) VALUES ('DATA-1','camera-demo',1,'fixed-seed','2026-09-01T00:00:00.000Z')").run();

test('core SQL schema creates the required manufacturing source tables', () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('PRAGMA foreign_keys = ON');
        db.exec(schema);
        const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
        for (const name of [
            'schema_migrations', 'dataset_instances', 'lines', 'equipment', 'modules',
            'recipe_revisions', 'product_families', 'characteristics', 'defect_codes',
            'lots', 'process_runs', 'inspection_samples', 'measurements',
            'aoi_inspections', 'aoi_defects', 'equipment_events', 'maintenance_actions'
        ]) {
            assert.ok(names.has(name), `missing table ${name}`);
        }
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
        db.close();
    }
});

test('core SQL rejects missing parents, null IDs, and invalid processing intervals', () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('PRAGMA foreign_keys = ON');
        db.exec(schema);
        assert.throws(() => db.prepare("INSERT INTO lines(id,code,name) VALUES ('EARLY','E','No dataset')").run());
        insertInstance(db);
        assert.throws(() => db.prepare("INSERT INTO dataset_instances(id,code,version,seed,generated_at) VALUES ('DATA-2','second',1,'other','2026-09-01T00:00:00.000Z')").run());
        assert.throws(() => db.prepare("INSERT INTO equipment(id,line_id,code,name) VALUES ('EQ-X','NO-LINE','X','X')").run());
        assert.throws(() => db.prepare("INSERT INTO lines(id,code,name) VALUES (NULL,'X','X')").run());
        db.prepare("INSERT INTO lines(id,code,name) VALUES ('LINE-1','L1','Demo line')").run();
        db.prepare("INSERT INTO equipment(id,line_id,code,name) VALUES ('EQ-1','LINE-1','E1','Aligner')").run();
        db.prepare("INSERT INTO modules(id,equipment_id,code,name) VALUES ('MOD-1','EQ-1','M1','Vision')").run();
        db.prepare("INSERT INTO recipe_revisions(id,recipe_code,revision,effective_at) VALUES ('REC-1','RCP-A',1,'2026-09-01T00:00:00.000Z')").run();
        db.prepare("INSERT INTO product_families(id,code,name) VALUES ('PF-1','CAM','Camera module')").run();
        db.prepare("INSERT INTO lots(id,product_family_id,code,quantity,start_at,end_at) VALUES ('LOT-1','PF-1','L-001',100,'2026-09-02T00:00:00.000Z','2026-09-03T00:00:00.000Z')").run();
        const insertRun = db.prepare('INSERT INTO process_runs(id,lot_id,equipment_id,module_id,recipe_revision_id,start_at,end_at,processed_units) VALUES (?,?,?,?,?,?,?,?)');
        assert.throws(() => insertRun.run('RUN-EQUAL', 'LOT-1', 'EQ-1', 'MOD-1', 'REC-1', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z', 100));
        assert.throws(() => insertRun.run('RUN-REVERSE', 'LOT-1', 'EQ-1', 'MOD-1', 'REC-1', '2026-09-03T00:00:00.000Z', '2026-09-02T00:00:00.000Z', 100));
        insertRun.run('RUN-1', 'LOT-1', 'EQ-1', 'MOD-1', 'REC-1', '2026-09-02T00:00:00.000Z', '2026-09-03T00:00:00.000Z', 100);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM process_runs').get().n, 1);
    } finally {
        db.close();
    }
});

test('cross-entity, UTC, AOI, and immutable-history rules reject invalid source rows', () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec('PRAGMA foreign_keys = ON');
        db.exec(schema);
        insertInstance(db);
        db.exec("INSERT INTO lines(id,code,name) VALUES ('LINE-1','L1','Demo line')");
        db.exec("INSERT INTO equipment(id,line_id,code,name) VALUES ('EQ-1','LINE-1','E1','Aligner'),('EQ-2','LINE-1','E2','Other')");
        db.exec("INSERT INTO modules(id,equipment_id,code,name) VALUES ('MOD-1','EQ-1','M1','Vision'),('MOD-2','EQ-2','M2','Other')");
        assert.throws(() => db.prepare("INSERT INTO recipe_revisions(id,recipe_code,revision,effective_at) VALUES ('BAD-DATE','RCP',1,'2026-02-30T00:00:00.000Z')").run());
        assert.throws(() => db.prepare("INSERT INTO recipe_revisions(id,recipe_code,revision,effective_at) VALUES ('BAD-HOUR','RCP',2,'2026-09-01T24:00:00.000Z')").run());
        db.exec("INSERT INTO recipe_revisions(id,recipe_code,revision,effective_at) VALUES ('REC-1','RCP',1,'2026-09-01T00:00:00.000Z')");
        db.exec("INSERT INTO product_families(id,code,name) VALUES ('PF-1','CAM','Camera'),('PF-2','OTHER','Other')");
        db.exec("INSERT INTO characteristics(id,product_family_id,code,name,unit) VALUES ('CHAR-1','PF-1','ALIGN','Alignment','mm'),('CHAR-2','PF-2','OTHER','Other','mm')");
        db.exec("INSERT INTO defect_codes(id,code,name,severity) VALUES ('DEF-1','AOI-D1','Synthetic defect','minor')");
        db.exec("INSERT INTO lots(id,product_family_id,code,quantity,start_at,end_at) VALUES ('LOT-1','PF-1','L-1',100,'2026-09-02T00:00:00.000Z','2026-09-03T00:00:00.000Z'),('LOT-2','PF-1','L-2',100,'2026-09-02T00:00:00.000Z','2026-09-03T00:00:00.000Z')");
        const run = db.prepare('INSERT INTO process_runs(id,lot_id,equipment_id,module_id,recipe_revision_id,start_at,end_at,processed_units) VALUES (?,?,?,?,?,?,?,?)');
        assert.throws(() => run.run('WRONG-MODULE','LOT-1','EQ-1','MOD-2','REC-1','2026-09-02T00:00:00.000Z','2026-09-03T00:00:00.000Z',100));
        assert.throws(() => run.run('OUTSIDE-LOT','LOT-1','EQ-1','MOD-1','REC-1','2026-09-01T00:00:00.000Z','2026-09-03T00:00:00.000Z',100));
        run.run('RUN-1','LOT-1','EQ-1','MOD-1','REC-1','2026-09-02T00:00:00.000Z','2026-09-03T00:00:00.000Z',100);
        assert.deepEqual(db.prepare('SELECT issue FROM aoi_integrity_gaps').all().map((row) => row.issue), ['missing-aoi']);
        const sample = db.prepare('INSERT INTO inspection_samples(id,lot_id,process_run_id,sampled_at,sample_size) VALUES (?,?,?,?,?)');
        assert.throws(() => sample.run('S-WRONG','LOT-2','RUN-1','2026-09-02T12:00:00.000Z',5));
        assert.throws(() => sample.run('S-LATE','LOT-1','RUN-1','2026-09-03T00:00:00.000Z',5));
        sample.run('S-1','LOT-1','RUN-1','2026-09-02T12:00:00.000Z',5);
        const measurement = db.prepare('INSERT INTO measurements(id,inspection_sample_id,characteristic_id,value,unit,method,recorded_at) VALUES (?,?,?,?,?,?,?)');
        assert.throws(() => measurement.run('M-WRONG','S-1','CHAR-2',0.01,'mm','vision','2026-09-02T12:01:00.000Z'));
        measurement.run('M-1','S-1','CHAR-1',0.01,'mm','vision','2026-09-02T12:01:00.000Z');
        const aoi = db.prepare('INSERT INTO aoi_inspections(id,lot_id,process_run_id,inspected_at,inspected_units,rejected_units) VALUES (?,?,?,?,?,?)');
        assert.throws(() => aoi.run('A-WRONG','LOT-2','RUN-1','2026-09-02T12:00:00.000Z',100,1));
        assert.throws(() => aoi.run('A-INCOMPLETE','LOT-1','RUN-1','2026-09-02T12:00:00.000Z',99,1));
        assert.throws(() => aoi.run('A-COUNT','LOT-1','RUN-1','2026-09-02T12:00:00.000Z',100,101));
        aoi.run('A-1','LOT-1','RUN-1','2026-09-02T12:00:00.000Z',100,1);
        assert.deepEqual(db.prepare('SELECT issue FROM aoi_integrity_gaps').all().map((row) => row.issue), ['reject-count-mismatch']);
        db.exec("INSERT INTO aoi_defects(id,aoi_inspection_id,defect_code_id,defect_count) VALUES ('AD-1','A-1','DEF-1',1)");
        assert.deepEqual(db.prepare('SELECT issue FROM aoi_integrity_gaps').all(), []);
        assert.throws(() => db.prepare("UPDATE recipe_revisions SET revision=2 WHERE id='REC-1'").run());
        assert.throws(() => db.prepare("UPDATE characteristics SET product_family_id='PF-2' WHERE id='CHAR-1'").run());
        assert.throws(() => db.prepare("DELETE FROM defect_codes WHERE id='DEF-1'").run());
        assert.throws(() => db.prepare("DELETE FROM measurements WHERE id='M-1'").run());
        assert.throws(() => db.prepare("DELETE FROM dataset_instances WHERE id='DATA-1'").run());
        assert.equal(db.prepare('SELECT rejected_units FROM aoi_inspections WHERE id=?').get('A-1').rejected_units, 1);
    } finally {
        db.close();
    }
});
