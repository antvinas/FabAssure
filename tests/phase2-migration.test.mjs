import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, SCHEMA_VERSION } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';

const sourceSchema = readFileSync(new URL('../src/data/schema.sql', import.meta.url), 'utf8');
const fixtureDirectory = () => mkdtempSync(join(tmpdir(), 'fabassure-v2-'));

function createLegacyV1(filename, { malformed = false } = {}) {
    const raw = new DatabaseSync(filename);
    try {
        raw.exec('PRAGMA foreign_keys=ON');
        raw.exec(sourceSchema);
        raw.prepare("INSERT INTO schema_migrations(id,version,name,applied_at) VALUES ('MIG-001',1,'initial manufacturing source schema','2026-09-01T00:00:00.000Z')").run();
        raw.exec('PRAGMA user_version=1');
        raw.prepare("INSERT INTO dataset_instances(id,code,version,seed,generated_at) VALUES ('DATASET-V1','camera-demo',1,'fixed','2026-09-01T00:00:00.000Z')").run();
        raw.prepare("INSERT INTO lines(id,code,name) VALUES ('LINE-V1','L1','Legacy synthetic line')").run();
        raw.exec(`
            INSERT INTO equipment(id,line_id,code,name) VALUES ('EQ-V1','LINE-V1','E1','Synthetic cell');
            INSERT INTO modules(id,equipment_id,code,name) VALUES ('MOD-V1','EQ-V1','M1','Synthetic module');
            INSERT INTO recipe_revisions(id,recipe_code,revision,effective_at) VALUES ('REC-V1','RCP-V1',1,'2026-09-01T00:00:00.000Z');
            INSERT INTO product_families(id,code,name) VALUES ('PF-V1','CAM-V1','Synthetic camera');
            INSERT INTO characteristics(id,product_family_id,code,name,unit) VALUES ('CHAR-V1','PF-V1','ALIGN-X','Synthetic alignment','mm');
            INSERT INTO defect_codes(id,code,name,severity) VALUES ('DEF-V1','D-V1','Synthetic reject','major');
            INSERT INTO lots(id,product_family_id,code,quantity,start_at,end_at) VALUES ('LOT-V1','PF-V1','LOT-V1',10,'2026-09-01T08:00:00.000Z','2026-09-01T12:00:00.000Z');
            INSERT INTO process_runs(id,lot_id,equipment_id,module_id,recipe_revision_id,start_at,end_at,processed_units)
                VALUES ('RUN-V1','LOT-V1','EQ-V1','MOD-V1','REC-V1','2026-09-01T09:00:00.000Z','2026-09-01T11:00:00.000Z',10);
            INSERT INTO inspection_samples(id,lot_id,process_run_id,sampled_at,sample_size) VALUES ('SAMPLE-V1','LOT-V1','RUN-V1','2026-09-01T10:00:00.000Z',1);
            INSERT INTO measurements(id,inspection_sample_id,characteristic_id,value,unit,method,recorded_at)
                VALUES ('MEAS-V1','SAMPLE-V1','CHAR-V1',0.03,'mm','synthetic gauge','2026-09-01T10:00:00.000Z');
            INSERT INTO aoi_inspections(id,lot_id,process_run_id,inspected_at,inspected_units,rejected_units)
                VALUES ('AOI-V1','LOT-V1','RUN-V1','2026-09-01T10:30:00.000Z',10,1);
            INSERT INTO aoi_defects(id,aoi_inspection_id,defect_code_id,defect_count,location)
                VALUES ('AOIDEF-V1','AOI-V1','DEF-V1',1,'synthetic location');
            INSERT INTO equipment_events(id,equipment_id,module_id,event_type,occurred_at,duration_seconds)
                VALUES ('EVENT-V1','EQ-V1','MOD-V1','failure','2026-09-01T12:00:00.000Z',3600);
            INSERT INTO maintenance_actions(id,equipment_id,module_id,code,summary,start_at,end_at)
                VALUES ('MA-V1','EQ-V1','MOD-V1','REPAIR','Synthetic repair','2026-09-01T12:00:00.000Z','2026-09-01T13:00:00.000Z');
        `);
        if (malformed) raw.exec('DROP TRIGGER immutable_line_update');
    } finally {
        raw.close();
    }
}

function createPopulatedVersionSix(filename) {
    const current = openDatabase(filename);
    let original;
    try {
        seedDatabase(current, { instanceId: 'DATASET-V6-MIGRATION' });
        original = {
            runs: current.prepare('SELECT * FROM process_runs ORDER BY id').all(),
            inspections: current.prepare('SELECT * FROM aoi_inspections ORDER BY id').all(),
            audit: current.prepare('SELECT * FROM audit_events ORDER BY sequence').all()
        };
    } finally { current.close(); }
    const raw = new DatabaseSync(filename);
    try {
        raw.exec('BEGIN IMMEDIATE');
        for (const { name } of raw.prepare(`SELECT name FROM sqlite_master
            WHERE type='trigger' AND name LIKE 'change_%_after_effectiveness_guard'`).all()) {
            raw.exec(`DROP TRIGGER ${name}`);
        }
        raw.exec(`DROP TRIGGER incident_cycle_latest_check_guard;
            DROP TRIGGER incident_cycle_check_audit_guard;
            DROP VIEW change_revision_frozen_scope`);
        const guard = raw.prepare(`SELECT sql FROM sqlite_master
            WHERE name='immutable_migration_delete'`).get().sql;
        raw.exec('DROP TRIGGER immutable_migration_delete');
        raw.prepare("DELETE FROM schema_migrations WHERE id='MIG-009'").run();
        raw.prepare("DELETE FROM schema_migrations WHERE id='MIG-008'").run();
        raw.prepare("DELETE FROM schema_migrations WHERE id='MIG-007'").run();
        raw.exec(guard);
        raw.exec('PRAGMA user_version=6; COMMIT');
        assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 6);
        assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id='MIG-007'")
            .get().n, 0);
    } finally {
        if (raw.isTransaction) raw.exec('ROLLBACK');
        raw.close();
    }
    return original;
}

test('fresh database creates all versioned migrations and domain actor records', () => {
    const db = openDatabase(':memory:');
    try {
        assert.equal(SCHEMA_VERSION, 9);
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
        assert.deepEqual(db.prepare('SELECT id FROM schema_migrations ORDER BY version').all().map(({ id }) => id), ['MIG-001', 'MIG-002', 'MIG-003', 'MIG-004', 'MIG-005', 'MIG-006', 'MIG-007', 'MIG-008', 'MIG-009']);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM demo_actors').get().n, 8);
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
        db.close();
    }
});

test('valid v1 source rows migrate transactionally to v7 and reopen intact', () => {
    const directory = fixtureDirectory();
    const filename = join(directory, 'legacy.sqlite');
    try {
        createLegacyV1(filename);
        let db = openDatabase(filename);
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
        assert.equal(db.prepare("SELECT name FROM lines WHERE id='LINE-V1'").get().name, 'Legacy synthetic line');
        assert.equal(db.prepare("SELECT recipe_revision_id FROM process_runs WHERE id='RUN-V1'").get().recipe_revision_id, 'REC-V1');
        assert.equal(db.prepare("SELECT value FROM measurements WHERE id='MEAS-V1'").get().value, 0.03);
        assert.equal(db.prepare("SELECT rejected_units FROM aoi_inspections WHERE id='AOI-V1'").get().rejected_units, 1);
        assert.equal(db.prepare("SELECT duration_seconds FROM equipment_events WHERE id='EVENT-V1'").get().duration_seconds, 3600);
        assert.equal(db.prepare("SELECT id FROM maintenance_actions WHERE id='MA-V1'").get().id, 'MA-V1');
        assert.throws(() => db.prepare("UPDATE lines SET name='altered' WHERE id='LINE-V1'").run(), /immutable/i);
        db.close();
        db = openDatabase(filename);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 9);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM demo_actors').get().n, 8);
        db.close();
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('malformed v1 is rejected without a partial migration', () => {
    const directory = fixtureDirectory();
    const filename = join(directory, 'malformed.sqlite');
    try {
        createLegacyV1(filename, { malformed: true });
        assert.throws(() => openDatabase(filename), /schema|incompatible|integrity/i);
        const raw = new DatabaseSync(filename);
        try {
            assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1);
            assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='demo_actors'").get().n, 0);
            assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM lines WHERE id='LINE-V1'").get().n, 1);
            assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM process_runs WHERE id='RUN-V1'").get().n, 1);
        } finally {
            raw.close();
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('populated v6 file gains source-freeze guards once and preserves all rows and audit', () => {
    const directory = fixtureDirectory();
    const filename = join(directory, 'populated-v6.sqlite');
    try {
        const original = createPopulatedVersionSix(filename);
        for (let attempt = 0; attempt < 2; attempt++) {
            const db = openDatabase(filename);
            try {
                assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
                assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id='MIG-007'")
                    .get().n, 1);
                assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id='MIG-008'")
                    .get().n, 1);
                assert.deepEqual(db.prepare('SELECT * FROM process_runs ORDER BY id').all(),
                    original.runs);
                assert.deepEqual(db.prepare('SELECT * FROM aoi_inspections ORDER BY id').all(),
                    original.inspections);
                assert.deepEqual(db.prepare('SELECT * FROM audit_events ORDER BY sequence').all(),
                    original.audit);
                assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master
                    WHERE type='trigger' AND name LIKE 'change_%_after_effectiveness_guard'`)
                    .get().n, 8);
            } finally { db.close(); }
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('populated v7 source and audit migrate once to revision-bound v8 guards', () => {
    const directory = fixtureDirectory();
    const filename = join(directory, 'populated-v7.sqlite');
    try {
        const fresh = openDatabase(filename);
        seedDatabase(fresh, { instanceId: 'DATASET-V7-GUARD-MIGRATION' });
        const originalRuns = fresh.prepare('SELECT * FROM process_runs ORDER BY id').all();
        const originalAudit = fresh.prepare('SELECT * FROM audit_events ORDER BY sequence').all();
        fresh.close();
        const raw = new DatabaseSync(filename);
        try {
            raw.exec('BEGIN IMMEDIATE');
            const oldSql = readFileSync(new URL('../src/data/schema-v7.sql', import.meta.url),
                'utf8');
            for (const name of ['change_run_after_effectiveness_guard',
                'change_aoi_after_effectiveness_guard',
                'change_aoi_defect_after_effectiveness_guard',
                'change_sample_after_effectiveness_guard',
                'change_measurement_after_effectiveness_guard']) {
                raw.exec(`DROP TRIGGER ${name}`);
                const definition = oldSql.match(new RegExp(
                    `CREATE TRIGGER ${name}[^]*?END;`))?.[0];
                assert.ok(definition, name);
                raw.exec(definition);
            }
            raw.exec(`DROP TRIGGER incident_cycle_latest_check_guard;
                DROP TRIGGER incident_cycle_check_audit_guard;
                DROP VIEW change_revision_frozen_scope`);
            const guard = raw.prepare(`SELECT sql FROM sqlite_master
                WHERE name='immutable_migration_delete'`).get().sql;
            raw.exec('DROP TRIGGER immutable_migration_delete');
            raw.prepare("DELETE FROM schema_migrations WHERE id='MIG-009'").run();
            raw.prepare("DELETE FROM schema_migrations WHERE id='MIG-008'").run();
            raw.exec(guard);
            raw.exec('PRAGMA user_version=7; COMMIT');
        } finally {
            if (raw.isTransaction) raw.exec('ROLLBACK');
            raw.close();
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            const upgraded = openDatabase(filename);
            try {
                assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 9);
                assert.equal(upgraded.prepare(`SELECT COUNT(*) AS n FROM schema_migrations
                    WHERE id='MIG-008'`).get().n, 1);
                assert.equal(upgraded.prepare(`SELECT COUNT(*) AS n FROM sqlite_master
                    WHERE type='view' AND name='change_revision_frozen_scope'`).get().n, 1);
                assert.deepEqual(upgraded.prepare('SELECT * FROM process_runs ORDER BY id').all(),
                    originalRuns);
                assert.deepEqual(upgraded.prepare('SELECT * FROM audit_events ORDER BY sequence').all(),
                    originalAudit);
            } finally { upgraded.close(); }
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('failed v7 DDL rolls back a populated v6 file and its migration history', async () => {
    const directory = fixtureDirectory();
    const filename = join(directory, 'v7-fault.sqlite');
    try {
        const original = createPopulatedVersionSix(filename);
        const dataDirectory = join(directory, 'data');
        const domainDirectory = join(directory, 'domain');
        mkdirSync(dataDirectory);
        mkdirSync(domainDirectory);
        for (const file of ['db.mjs', 'schema.sql', 'schema-v2.sql', 'schema-v3.sql',
            'schema-v4.sql', 'schema-v5.sql', 'schema-v6.sql', 'schema-v7.sql', 'schema-v8.sql', 'schema-v9.sql']) {
            copyFileSync(new URL(`../src/data/${file}`, import.meta.url), join(dataDirectory, file));
        }
        for (const file of ['audit.mjs', 'trace.mjs', 'trace-source.mjs',
            'effectiveness.mjs', 'change-effectiveness-source.mjs']) {
            copyFileSync(new URL(`../src/domain/${file}`, import.meta.url), join(domainDirectory, file));
        }
        appendFileSync(join(dataDirectory, 'schema-v7.sql'), '\nTHIS IS INVALID SQL;\n');
        const { openDatabase: openWithFault } = await import(pathToFileURL(
            join(dataDirectory, 'db.mjs')).href);
        assert.throws(() => openWithFault(filename), /syntax|near|SQL/i);
        const raw = new DatabaseSync(filename);
        try {
            assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 6);
            assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id='MIG-007'")
                .get().n, 0);
            assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM sqlite_master
                WHERE type='trigger' AND name LIKE 'change_%_after_effectiveness_guard'`)
                .get().n, 0);
            assert.deepEqual(raw.prepare('SELECT * FROM process_runs ORDER BY id').all(),
                original.runs);
            assert.deepEqual(raw.prepare('SELECT * FROM audit_events ORDER BY sequence').all(),
                original.audit);
        } finally { raw.close(); }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('a failure after v2 DDL begins rolls back every migration change', async () => {
    const directory = fixtureDirectory();
    const filename = join(directory, 'late-failure.sqlite');
    try {
        createLegacyV1(filename);
        const dataDirectory = join(directory, 'data');
        const domainDirectory = join(directory, 'domain');
        mkdirSync(dataDirectory);
        mkdirSync(domainDirectory);
        const modulePath = join(dataDirectory, 'db.mjs');
        copyFileSync(new URL('../src/data/db.mjs', import.meta.url), modulePath);
        for (const file of ['schema.sql', 'schema-v2.sql', 'schema-v3.sql', 'schema-v4.sql', 'schema-v5.sql', 'schema-v6.sql', 'schema-v7.sql', 'schema-v8.sql', 'schema-v9.sql']) {
            copyFileSync(new URL(`../src/data/${file}`, import.meta.url), join(dataDirectory, file));
        }
        for (const file of ['audit.mjs', 'trace.mjs', 'trace-source.mjs',
            'effectiveness.mjs', 'change-effectiveness-source.mjs']) {
            copyFileSync(new URL(`../src/domain/${file}`, import.meta.url), join(domainDirectory, file));
        }
        appendFileSync(join(dataDirectory, 'schema-v2.sql'), '\nTHIS IS INVALID SQL;\n');
        const { openDatabase: openWithFault } = await import(pathToFileURL(modulePath).href);
        assert.throws(() => openWithFault(filename), /syntax|near|SQL/i);
        const raw = new DatabaseSync(filename);
        try {
            assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1);
            assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n, 1);
            assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='demo_actors'").get().n, 0);
            assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM process_runs WHERE id='RUN-V1'").get().n, 1);
            assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
        } finally {
            raw.close();
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
