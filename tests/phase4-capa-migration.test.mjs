import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/data/db.mjs';

const at = '2026-09-01T00:00:00.000Z';

function createVersionThree(filename) {
    const db = new DatabaseSync(filename);
    try {
        db.exec('PRAGMA foreign_keys=ON');
        for (const name of ['schema.sql', 'schema-v2.sql', 'schema-v3.sql']) {
            db.exec(readFileSync(new URL(`../src/data/${name}`, import.meta.url), 'utf8'));
        }
        db.prepare('INSERT INTO schema_migrations(id,version,name,applied_at) VALUES (?,?,?,?)')
            .run('MIG-001', 1, 'initial manufacturing source schema', at);
        db.prepare('INSERT INTO schema_migrations(id,version,name,applied_at) VALUES (?,?,?,?)')
            .run('MIG-002', 2, 'change control and audit domain schema', at);
        db.exec(`
            INSERT INTO dataset_instances(id,code,version,seed,generated_at)
                VALUES ('DATASET-V3','camera-demo',1,'fixed','2026-09-01T00:00:00.000Z');
            INSERT INTO lines(id,code,name) VALUES ('LINE-V3','L3','Synthetic migration line');
            INSERT INTO equipment(id,line_id,code,name)
                VALUES ('EQ-V3','LINE-V3','E3','Synthetic cell');
            INSERT INTO modules(id,equipment_id,code,name)
                VALUES ('MOD-V3','EQ-V3','M3','Synthetic module');
            INSERT INTO defect_codes(id,code,name,severity)
                VALUES ('DEF-V3','DV3','Synthetic defect','major');
            INSERT INTO incidents(id,title,proposer_actor_id,defect_code_id,equipment_id,module_id,
                detected_at,state,created_at,updated_at)
                VALUES ('INC-V3','Retained synthetic incident','ACT-Q1','DEF-V3','EQ-V3','MOD-V3',
                    '2026-09-01T00:00:00.000Z','Open','2026-09-01T00:00:00.000Z',
                    '2026-09-01T00:00:00.000Z');
            INSERT INTO incident_revisions(id,incident_id,revision_no,reason,created_by,created_at)
                VALUES ('INC-V3-R1','INC-V3',1,'Initial','ACT-Q1','2026-09-01T00:00:00.000Z');
            INSERT INTO legacy_incidents(incident_id,state_at_migration,updated_at_at_migration,migrated_at)
                VALUES ('INC-V3','Open','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
        `);
        db.prepare('INSERT INTO schema_migrations(id,version,name,applied_at) VALUES (?,?,?,?)')
            .run('MIG-003', 3, 'FabTrace proposal and scope review schema', at);
        db.exec('PRAGMA user_version=3');
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
        db.close();
    }
}

function createVersionFour(filename) {
    createVersionThree(filename);
    const db = new DatabaseSync(filename);
    try {
        db.exec(readFileSync(new URL('../src/data/schema-v4.sql', import.meta.url), 'utf8'));
        db.prepare('INSERT INTO schema_migrations(id,version,name,applied_at) VALUES (?,?,?,?)')
            .run('MIG-004', 4, 'FabTrace CAPA and controlled-document schema', at);
        db.exec('PRAGMA user_version=4');
    } finally {
        db.close();
    }
}

test('valid v3 incident history migrates to v7 without rewriting earlier decisions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-capa-v4-'));
    const filename = join(directory, 'prior.sqlite');
    try {
        createVersionThree(filename);
        const db = openDatabase(filename);
        try {
            assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
            assert.deepEqual(db.prepare('SELECT id FROM schema_migrations ORDER BY version')
                .all().map(row => row.id), ['MIG-001', 'MIG-002', 'MIG-003', 'MIG-004', 'MIG-005', 'MIG-006', 'MIG-007', 'MIG-008', 'MIG-009']);
            assert.equal(db.prepare("SELECT title FROM incidents WHERE id='INC-V3'").get().title,
                'Retained synthetic incident');
            assert.equal(db.prepare("SELECT state_at_migration FROM legacy_incidents WHERE incident_id='INC-V3'")
                .get().state_at_migration, 'Open');
            assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='incident_cycles'")
                .get().n, 1);
            assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        } finally {
            db.close();
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('a v4 database retains incident history and gains the AOI coverage guard in v5', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-capa-v5-'));
    const filename = join(directory, 'prior.sqlite');
    try {
        createVersionFour(filename);
        const db = openDatabase(filename);
        try {
            assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
            assert.equal(db.prepare("SELECT title FROM incidents WHERE id='INC-V3'").get().title,
                'Retained synthetic incident');
            assert.deepEqual(db.prepare('SELECT id FROM schema_migrations ORDER BY version')
                .all().map(row => row.id),
                ['MIG-001', 'MIG-002', 'MIG-003', 'MIG-004', 'MIG-005', 'MIG-006', 'MIG-007', 'MIG-008', 'MIG-009']);
            assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master
                WHERE type='trigger' AND name='incident_effectiveness_aoi_coverage_guard'`)
                .get().n, 1);
        } finally {
            db.close();
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('failed v4 DDL rolls back the v3 database and retains its incident history', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-capa-v4-fault-'));
    const filename = join(directory, 'prior.sqlite');
    try {
        createVersionThree(filename);
        const dataDirectory = join(directory, 'data');
        const domainDirectory = join(directory, 'domain');
        mkdirSync(dataDirectory);
        mkdirSync(domainDirectory);
        for (const name of ['db.mjs', 'schema.sql', 'schema-v2.sql', 'schema-v3.sql',
            'schema-v4.sql', 'schema-v5.sql', 'schema-v6.sql', 'schema-v7.sql', 'schema-v8.sql', 'schema-v9.sql']) {
            copyFileSync(new URL(`../src/data/${name}`, import.meta.url), join(dataDirectory, name));
        }
        for (const name of ['audit.mjs', 'trace.mjs', 'trace-source.mjs',
            'effectiveness.mjs', 'change-effectiveness-source.mjs']) {
            copyFileSync(new URL(`../src/domain/${name}`, import.meta.url), join(domainDirectory, name));
        }
        appendFileSync(join(dataDirectory, 'schema-v4.sql'), '\nTHIS IS INVALID SQL;\n');
        const { openDatabase: openFaulted } = await import(pathToFileURL(join(dataDirectory, 'db.mjs')).href);
        assert.throws(() => openFaulted(filename), /syntax|near|SQL/i);
        const retained = new DatabaseSync(filename);
        try {
            assert.equal(retained.prepare('PRAGMA user_version').get().user_version, 3);
            assert.equal(retained.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 3);
            assert.equal(retained.prepare("SELECT title FROM incidents WHERE id='INC-V3'").get().title,
                'Retained synthetic incident');
            assert.equal(retained.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='incident_cycles'")
                .get().n, 0);
        } finally {
            retained.close();
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('failed v5 DDL rolls back a populated v4 database without migration marker', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-capa-v5-fault-'));
    const filename = join(directory, 'prior.sqlite');
    try {
        createVersionFour(filename);
        const dataDirectory = join(directory, 'data');
        const domainDirectory = join(directory, 'domain');
        mkdirSync(dataDirectory);
        mkdirSync(domainDirectory);
        for (const name of ['db.mjs', 'schema.sql', 'schema-v2.sql', 'schema-v3.sql',
            'schema-v4.sql', 'schema-v5.sql', 'schema-v6.sql', 'schema-v7.sql', 'schema-v8.sql', 'schema-v9.sql']) {
            copyFileSync(new URL(`../src/data/${name}`, import.meta.url), join(dataDirectory, name));
        }
        for (const name of ['audit.mjs', 'trace.mjs', 'trace-source.mjs',
            'effectiveness.mjs', 'change-effectiveness-source.mjs']) {
            copyFileSync(new URL(`../src/domain/${name}`, import.meta.url),
                join(domainDirectory, name));
        }
        appendFileSync(join(dataDirectory, 'schema-v5.sql'), '\nTHIS IS INVALID SQL;\n');
        const { openDatabase: openFaulted } = await import(pathToFileURL(join(dataDirectory, 'db.mjs')).href);
        assert.throws(() => openFaulted(filename), /syntax|near|SQL/i);
        const retained = new DatabaseSync(filename);
        try {
            assert.equal(retained.prepare('PRAGMA user_version').get().user_version, 4);
            assert.equal(retained.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 4);
            assert.equal(retained.prepare("SELECT title FROM incidents WHERE id='INC-V3'").get().title,
                'Retained synthetic incident');
            assert.equal(retained.prepare(`SELECT COUNT(*) AS n FROM sqlite_master
                WHERE name='incident_effectiveness_aoi_coverage_guard'`).get().n, 0);
        } finally {
            retained.close();
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
