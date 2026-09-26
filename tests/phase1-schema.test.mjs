import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, assertDataIntegrity, withValidatedTransaction, SCHEMA_VERSION } from '../src/data/db.mjs';

const utc = (day) => `2026-09-${day}T00:00:00.000Z`;

test('fresh database has the required core tables, version, and foreign keys', () => {
    const db = openDatabase(':memory:');
    try {
        assert.equal(SCHEMA_VERSION, 9);
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
        assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
        for (const name of [
            'schema_migrations', 'dataset_instances', 'lines', 'equipment', 'modules',
            'recipe_revisions', 'product_families', 'characteristics', 'defect_codes',
            'lots', 'process_runs', 'inspection_samples', 'measurements',
            'aoi_inspections', 'aoi_defects', 'equipment_events', 'maintenance_actions'
        ]) {
            assert.ok(tables.has(name), `missing table: ${name}`);
        }
    } finally {
        db.close();
    }
});

test('foreign keys, stable IDs, and half-open intervals are constrained', () => {
    const db = openDatabase(':memory:');
    try {
        db.prepare("INSERT INTO dataset_instances(id,code,version,seed,generated_at) VALUES ('DATA-1','camera-demo',1,'fixed-seed','2026-09-01T00:00:00.000Z')").run();
        assert.throws(() => db.prepare("INSERT INTO equipment(id,line_id,code,name) VALUES ('EQ-X','NO-LINE','X','X')").run());
        assert.throws(() => db.prepare("INSERT INTO lines(id,code,name) VALUES (NULL,'X','X')").run());
        db.prepare("INSERT INTO lines(id,code,name) VALUES ('LINE-1','L1','Demo line')").run();
        db.prepare("INSERT INTO equipment(id,line_id,code,name) VALUES ('EQ-1','LINE-1','E1','Aligner')").run();
        db.prepare("INSERT INTO modules(id,equipment_id,code,name) VALUES ('MOD-1','EQ-1','M1','Vision')").run();
        db.prepare('INSERT INTO recipe_revisions(id,recipe_code,revision,effective_at) VALUES (?,?,?,?)').run('REC-1', 'RCP-A', 1, utc('01'));
        db.prepare("INSERT INTO product_families(id,code,name) VALUES ('PF-1','CAM','Camera module')").run();
        db.prepare('INSERT INTO lots(id,product_family_id,code,quantity,start_at,end_at) VALUES (?,?,?,?,?,?)').run('LOT-1', 'PF-1', 'L-001', 100, utc('02'), utc('03'));
        const insertRun = db.prepare('INSERT INTO process_runs(id,lot_id,equipment_id,module_id,recipe_revision_id,start_at,end_at,processed_units) VALUES (?,?,?,?,?,?,?,?)');
        assert.throws(() => insertRun.run('RUN-BAD', 'LOT-1', 'EQ-1', 'MOD-1', 'REC-1', utc('03'), utc('02'), 100));
        assert.throws(() => insertRun.run('RUN-EQUAL', 'LOT-1', 'EQ-1', 'MOD-1', 'REC-1', utc('02'), utc('02'), 100));
        insertRun.run('RUN-1', 'LOT-1', 'EQ-1', 'MOD-1', 'REC-1', utc('02'), utc('03'), 100);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM process_runs').get().n, 1);
        assert.throws(() => assertDataIntegrity(db), /AOI|integrity|coverage/i);
        assert.throws(() => db.prepare(`INSERT INTO aoi_inspections
            (id,lot_id,process_run_id,inspected_at,inspected_units,rejected_units)
            VALUES ('AOI-RUN-END','LOT-1','RUN-1',?,100,0)`)
            .run(utc('03')), /AOI|run|inspection/i);
        db.prepare("INSERT INTO aoi_inspections(id,lot_id,process_run_id,inspected_at,inspected_units,rejected_units) VALUES ('AOI-1','LOT-1','RUN-1','2026-09-02T12:00:00.000Z',100,0)").run();
        assert.doesNotThrow(() => assertDataIntegrity(db));
        assert.throws(() => withValidatedTransaction(db, () => insertRun.run('RUN-ROLLBACK', 'LOT-1', 'EQ-1', 'MOD-1', 'REC-1', utc('02'), utc('03'), 100)), /AOI|integrity|coverage/i);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM process_runs').get().n, 1);
    } finally {
        db.close();
    }
});

test('reopen preserves data and incompatible existing databases are rejected', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-schema-'));
    const filename = join(directory, 'demo.sqlite');
    const unknown = join(directory, 'unknown.sqlite');
    const unversioned = join(directory, 'unversioned.sqlite');
    try {
        let db = openDatabase(filename);
        db.prepare("INSERT INTO dataset_instances(id,code,version,seed,generated_at) VALUES ('DATA-1','camera-demo',1,'fixed-seed','2026-09-01T00:00:00.000Z')").run();
        db.prepare("INSERT INTO lines(id,code,name) VALUES ('LINE-1','L1','Demo line')").run();
        db.close();
        db = openDatabase(filename);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lines').get().n, 1);
        db.close();

        const incompatible = new DatabaseSync(unknown);
        incompatible.exec('CREATE TABLE rogue (id TEXT); PRAGMA user_version = 99');
        incompatible.close();
        assert.throws(() => openDatabase(unknown), /version|schema|incompatible/i);
        const rogue = new DatabaseSync(unversioned);
        rogue.exec('CREATE TABLE rogue (id TEXT)');
        rogue.close();
        assert.throws(() => openDatabase(unversioned), /version|schema|incompatible/i);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('nested validated transaction is rejected without rolling back caller state', () => {
    const db = openDatabase(':memory:');
    try {
        db.prepare("INSERT INTO dataset_instances(id,code,version,seed,generated_at) VALUES ('DATA-1','camera-demo',1,'fixed-seed','2026-09-01T00:00:00.000Z')").run();
        db.exec('BEGIN IMMEDIATE');
        db.prepare("INSERT INTO lines(id,code,name) VALUES ('LINE-N','LN','Nested transaction line')").run();
        assert.throws(() => withValidatedTransaction(db, () => 1), /transaction|nested/i);
        assert.equal(db.isTransaction, true);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lines WHERE id = 'LINE-N'").get().n, 1);
        db.exec('ROLLBACK');
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lines WHERE id = 'LINE-N'").get().n, 0);
    } finally {
        if (db.isTransaction) db.exec('ROLLBACK');
        db.close();
    }
});

test('callback cannot commit or roll back the validated transaction', () => {
    const db = openDatabase(':memory:');
    try {
        db.prepare("INSERT INTO dataset_instances(id,code,version,seed,generated_at) VALUES ('DATA-1','camera-demo',1,'fixed-seed','2026-09-01T00:00:00.000Z')").run();
        const write = db.prepare('INSERT INTO lines(id,code,name) VALUES (?,?,?)');
        const preparedCommit = db.prepare('COMMIT');
        for (const [id, finish] of [
            ['LINE-C', () => db.exec('COMMIT')],
            ['LINE-P', () => preparedCommit.run()],
            ['LINE-R', () => db.exec('ROLLBACK')]
        ]) {
            assert.throws(() => withValidatedTransaction(db, () => {
                write.run(id, id, 'Escaped transaction');
                finish();
            }), /authoriz|transaction|rollback/i);
            assert.equal(db.isTransaction, false);
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lines WHERE id = ?').get(id).n, 0);
        }
    } finally {
        if (db.isTransaction) db.exec('ROLLBACK');
        db.close();
    }
});

test('callback cannot replace the transaction guard', () => {
    const db = openDatabase(':memory:');
    try {
        db.prepare("INSERT INTO dataset_instances(id,code,version,seed,generated_at) VALUES ('DATA-1','camera-demo',1,'fixed-seed','2026-09-01T00:00:00.000Z')").run();
        assert.throws(() => withValidatedTransaction(db, (transaction) => {
            transaction.prepare("INSERT INTO lines(id,code,name) VALUES ('LINE-G','LG','Guard test')").run();
            transaction.setAuthorizer(null);
            transaction.exec('COMMIT');
        }), /authorizer|function|not available/i);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lines WHERE id='LINE-G'").get().n, 0);
    } finally {
        db.close();
    }
});

test('async transaction callbacks never run, and returned promises close the connection', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-async-'));
    const filename = join(directory, 'demo.sqlite');
    const db = openDatabase(filename);
    try {
        db.prepare("INSERT INTO dataset_instances(id,code,version,seed,generated_at) VALUES ('DATA-1','camera-demo',1,'fixed-seed','2026-09-01T00:00:00.000Z')").run();
        let invoked = false;
        assert.throws(() => withValidatedTransaction(db, async () => { invoked = true; }), /synchronous/i);
        assert.equal(invoked, false);

        let lateWriteError;
        assert.throws(() => withValidatedTransaction(db, () => Promise.resolve().then(() => {
            try {
                db.prepare("INSERT INTO lines(id,code,name) VALUES ('LINE-L','LL','Late write')").run();
            } catch (error) {
                lateWriteError = error;
            }
        })), /synchronous/i);
        await Promise.resolve();
        assert.ok(lateWriteError);
        const reopened = openDatabase(filename);
        try {
            assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM lines WHERE id='LINE-L'").get().n, 0);
        } finally {
            reopened.close();
        }
    } finally {
        try { db.close(); } catch { /* The rejected promise path closes this handle. */ }
        rmSync(directory, { recursive: true, force: true });
    }
});
