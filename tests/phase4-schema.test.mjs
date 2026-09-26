import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { assertDataIntegrity, openDatabase, SCHEMA_VERSION } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';

const v1 = readFileSync(new URL('../src/data/schema.sql', import.meta.url), 'utf8');
const v2 = readFileSync(new URL('../src/data/schema-v2.sql', import.meta.url), 'utf8');

test('fresh schema adds immutable FabTrace proposal and independent scope review records', () => {
    const db = openDatabase(':memory:');
    try {
        assert.equal(SCHEMA_VERSION, 9);
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
        for (const name of ['legacy_incidents', 'lkg_observations', 'trace_proposals', 'trace_candidates',
            'scope_reviews', 'scope_decisions']) {
            assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?")
                .get(name).n, 1, name);
        }
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
        db.close();
    }
});

test('valid version 2 incident and source rows migrate to version 7 without losing history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-trace-v3-'));
    const filename = join(directory, 'prior.sqlite');
    try {
        const prior = new DatabaseSync(filename);
        try {
            prior.exec('PRAGMA foreign_keys=ON');
            prior.exec(v1);
            prior.exec(v2);
            prior.prepare('INSERT INTO schema_migrations(id,version,name,applied_at) VALUES (?,?,?,?)')
                .run('MIG-001', 1, 'initial manufacturing source schema', '2026-09-01T00:00:00.000Z');
            prior.prepare('INSERT INTO schema_migrations(id,version,name,applied_at) VALUES (?,?,?,?)')
                .run('MIG-002', 2, 'change control and audit domain schema', '2026-09-01T00:00:00.000Z');
            prior.exec('PRAGMA user_version=2');
            prior.exec(`
                INSERT INTO dataset_instances(id,code,version,seed,generated_at) VALUES ('DATASET-V2','camera-demo',1,'fixed','2026-09-01T00:00:00.000Z');
                INSERT INTO lines(id,code,name) VALUES ('LINE-V2','L2','Synthetic line');
                INSERT INTO equipment(id,line_id,code,name) VALUES ('EQ-V2','LINE-V2','E2','Synthetic cell');
                INSERT INTO modules(id,equipment_id,code,name) VALUES ('MOD-V2','EQ-V2','M2','Synthetic module');
                INSERT INTO defect_codes(id,code,name,severity) VALUES ('DEF-V2','DV2','Synthetic defect','major');
                INSERT INTO incidents(id,title,proposer_actor_id,defect_code_id,equipment_id,module_id,detected_at,state,created_at,updated_at)
                    VALUES ('INC-V2','Synthetic incident','ACT-Q1','DEF-V2','EQ-V2','MOD-V2','2026-09-01T02:00:00.000Z','Open','2026-09-01T02:00:00.000Z','2026-09-01T02:00:00.000Z');
                INSERT INTO incident_revisions(id,incident_id,revision_no,reason,created_by,created_at)
                    VALUES ('INC-V2-R1','INC-V2',1,'Initial','ACT-Q1','2026-09-01T02:00:00.000Z');
            `);
        } finally {
            prior.close();
        }
        const migrated = openDatabase(filename);
        try {
            assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 9);
            assert.deepEqual(migrated.prepare('SELECT id FROM schema_migrations ORDER BY version').all()
                .map(({ id }) => id), ['MIG-001', 'MIG-002', 'MIG-003', 'MIG-004', 'MIG-005', 'MIG-006', 'MIG-007', 'MIG-008', 'MIG-009']);
            assert.equal(migrated.prepare('SELECT title FROM incidents WHERE id=?').get('INC-V2').title,
                'Synthetic incident');
            assert.equal(migrated.prepare('SELECT id FROM incident_revisions WHERE id=?')
                .get('INC-V2-R1').id, 'INC-V2-R1');
            assert.deepEqual({ ...migrated.prepare(`SELECT incident_id,state_at_migration,
                updated_at_at_migration FROM legacy_incidents WHERE incident_id=?`).get('INC-V2') }, {
                incident_id: 'INC-V2', state_at_migration: 'Open',
                updated_at_at_migration: '2026-09-01T02:00:00.000Z'
            });
            assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
            migrated.prepare("UPDATE incidents SET state='Scope Reviewed' WHERE id='INC-V2'").run();
            assert.throws(() => assertDataIntegrity(migrated), /legacy|incident|audit|projection/i);
        } finally {
            migrated.close();
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('failed version 3 DDL rolls back a version 2 database and its incident history', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-trace-v3-fault-'));
    const filename = join(directory, 'prior.sqlite');
    try {
        const prior = new DatabaseSync(filename);
        try {
            prior.exec('PRAGMA foreign_keys=ON');
            prior.exec(v1);
            prior.exec(v2);
            prior.prepare('INSERT INTO schema_migrations(id,version,name,applied_at) VALUES (?,?,?,?)')
                .run('MIG-001', 1, 'initial manufacturing source schema', '2026-09-01T00:00:00.000Z');
            prior.prepare('INSERT INTO schema_migrations(id,version,name,applied_at) VALUES (?,?,?,?)')
                .run('MIG-002', 2, 'change control and audit domain schema', '2026-09-01T00:00:00.000Z');
            prior.exec('PRAGMA user_version=2');
            prior.exec(`
                INSERT INTO dataset_instances(id,code,version,seed,generated_at) VALUES ('DATASET-ROLLBACK','camera-demo',1,'fixed','2026-09-01T00:00:00.000Z');
                INSERT INTO lines(id,code,name) VALUES ('LINE-R','LR','Synthetic line');
                INSERT INTO equipment(id,line_id,code,name) VALUES ('EQ-R','LINE-R','ER','Synthetic cell');
                INSERT INTO modules(id,equipment_id,code,name) VALUES ('MOD-R','EQ-R','MR','Synthetic module');
                INSERT INTO defect_codes(id,code,name,severity) VALUES ('DEF-R','DR','Synthetic defect','major');
                INSERT INTO incidents(id,title,proposer_actor_id,defect_code_id,equipment_id,module_id,detected_at,state,created_at,updated_at)
                    VALUES ('INC-R','Retained incident','ACT-Q1','DEF-R','EQ-R','MOD-R','2026-09-01T02:00:00.000Z','Open','2026-09-01T02:00:00.000Z','2026-09-01T02:00:00.000Z');
            `);
        } finally {
            prior.close();
        }
        const dataDirectory = join(directory, 'data');
        const domainDirectory = join(directory, 'domain');
        mkdirSync(dataDirectory);
        mkdirSync(domainDirectory);
        for (const file of ['db.mjs', 'schema.sql', 'schema-v2.sql', 'schema-v3.sql', 'schema-v4.sql', 'schema-v5.sql', 'schema-v6.sql', 'schema-v7.sql', 'schema-v8.sql', 'schema-v9.sql']) {
            copyFileSync(new URL(`../src/data/${file}`, import.meta.url), join(dataDirectory, file));
        }
        for (const file of ['audit.mjs', 'trace.mjs', 'trace-source.mjs',
            'effectiveness.mjs', 'change-effectiveness-source.mjs']) {
            copyFileSync(new URL(`../src/domain/${file}`, import.meta.url), join(domainDirectory, file));
        }
        appendFileSync(join(dataDirectory, 'schema-v3.sql'), '\nTHIS IS INVALID SQL;\n');
        const { openDatabase: openWithFault } = await import(pathToFileURL(join(dataDirectory, 'db.mjs')).href);
        assert.throws(() => openWithFault(filename), /syntax|near|SQL/i);
        const retained = new DatabaseSync(filename);
        try {
            assert.equal(retained.prepare('PRAGMA user_version').get().user_version, 2);
            assert.equal(retained.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 2);
            assert.equal(retained.prepare('SELECT title FROM incidents WHERE id=?').get('INC-R').title,
                'Retained incident');
            assert.equal(retained.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='trace_proposals'")
                .get().n, 0);
        } finally {
            retained.close();
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('reviewed candidate set is frozen and failed review cannot issue lot decisions', () => {
    const db = openDatabase(':memory:');
    try {
        seedDatabase(db, { instanceId: 'DATASET-TRACE-GATE' });
        const at = '2026-08-28T11:00:00.000Z';
        db.prepare(`INSERT INTO incidents(id,title,proposer_actor_id,defect_code_id,equipment_id,module_id,
            detected_at,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run('INC-GATE', 'Synthetic excursion', 'ACT-Q1', 'DEF-FIDUCIAL', 'EQ-ALIGN-A',
                'MOD-ALIGN-A', at, 'Open', at, at);
        db.prepare(`INSERT INTO incident_revisions(id,incident_id,revision_no,reason,created_by,created_at)
            VALUES (?,?,?,?,?,?)`).run('INC-GATE-R1', 'INC-GATE', 1, 'Initial', 'ACT-Q1', at);
        assert.throws(() => db.prepare(`INSERT INTO lkg_observations(id,incident_revision_id,
            aoi_inspection_id,earliest_possible_at,latest_possible_at,method,sample_scope,
            limitation,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run('LKG-WRONG', 'INC-GATE-R1', 'AOI-B-001', '2026-08-01T00:00:00.000Z',
                '2026-08-10T00:00:00.000Z', 'AOI', 'Synthetic lot', 'Limited sample',
                'ACT-Q1', at), /LKG|source|module/i);
        assert.throws(() => db.prepare(`INSERT INTO lkg_observations(id,incident_revision_id,
            aoi_inspection_id,earliest_possible_at,latest_possible_at,method,sample_scope,
            limitation,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run('LKG-DEFECT', 'INC-GATE-R1', 'AOI-A-026', '2026-08-26T10:00:00.000Z',
                '2026-08-26T11:00:00.000Z', 'AOI', 'Synthetic lot', 'Target code observed',
                'ACT-Q1', at), /LKG|good|defect/i);
        const lot = { lotId: 'LOT-A-025', classification: 'ambiguous', reason: 'Synthetic uncertainty',
            runIds: ['RUN-A-025'], targetedDefects: 0, certainIntervalDefects: 0 };
        const digest = 'a'.repeat(64);
        db.prepare(`INSERT INTO trace_proposals(id,incident_revision_id,proposer_actor_id,recipe_revision_id,
            earliest_trace_at,cutoff_at,query_json,result_json,result_digest,proposed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`).run('TRACE-GATE', 'INC-GATE-R1', 'ACT-Q1',
            'REC-ALIGN-R3', '2026-08-25T00:00:00.000Z', at, '{}', JSON.stringify({ lots: [lot] }),
            digest, '2026-08-28T11:05:00.000Z');
        assert.throws(() => db.prepare(`INSERT INTO trace_candidates(id,proposal_id,lot_id,
            classification,reason,details_json,targeted_defects,certain_interval_defects)
            VALUES (?,?,?,?,?,?,?,?)`).run('CAND-WRONG-RUN', 'TRACE-GATE', lot.lotId,
            lot.classification, lot.reason, JSON.stringify({ ...lot, runIds: ['RUN-A-026'] }), 0, 0),
        /candidate|source/i);
        db.prepare(`INSERT INTO trace_candidates(id,proposal_id,lot_id,classification,reason,details_json,
            targeted_defects,certain_interval_defects) VALUES (?,?,?,?,?,?,?,?)`)
            .run('CAND-GATE', 'TRACE-GATE', lot.lotId, lot.classification, lot.reason,
                JSON.stringify(lot), 0, 0);
        assert.throws(() => db.prepare(`INSERT INTO trace_proposals(id,incident_revision_id,proposer_actor_id,recipe_revision_id,
            earliest_trace_at,cutoff_at,query_json,result_json,result_digest,proposed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`).run('TRACE-WRONG-RECIPE', 'INC-GATE-R1', 'ACT-Q1',
            'REC-B-R2', '2026-08-25T00:00:00.000Z', at, '{}', JSON.stringify({ lots: [lot] }),
            digest, '2026-08-28T11:06:00.000Z'), /trace|recipe|context/i);
        assert.throws(() => db.prepare(`INSERT INTO trace_proposals(id,incident_revision_id,proposer_actor_id,recipe_revision_id,
            earliest_trace_at,cutoff_at,query_json,result_json,result_digest,proposed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`).run('TRACE-LATE-CUTOFF', 'INC-GATE-R1', 'ACT-Q1',
            'REC-ALIGN-R3', '2026-08-25T00:00:00.000Z', '2026-08-28T12:00:00.000Z',
            '{}', JSON.stringify({ lots: [lot] }), digest, '2026-08-28T11:06:00.000Z'),
        /cutoff|trace|context/i);
        db.prepare(`INSERT INTO scope_reviews(id,proposal_id,candidate_digest,reviewer_actor_id,decision,
            reason,reviewed_at) VALUES (?,?,?,?,?,?,?)`).run('SCOPE-FAIL', 'TRACE-GATE', digest,
            'ACT-REV', 'Needs Rework', 'Uncertain lot needs another inspection',
            '2026-08-28T11:10:00.000Z');
        assert.throws(() => db.prepare(`INSERT INTO trace_candidates(id,proposal_id,lot_id,classification,
            reason,details_json,targeted_defects,certain_interval_defects) VALUES (?,?,?,?,?,?,?,?)`)
            .run('CAND-LATE', 'TRACE-GATE', 'LOT-A-026', 'excluded', 'Late candidate',
                JSON.stringify({ ...lot, lotId: 'LOT-A-026', reason: 'Late candidate', runIds: ['RUN-A-026'] }),
                0, 0), /review|frozen|candidate/i);
        assert.throws(() => db.prepare(`INSERT INTO scope_decisions(id,review_id,proposal_id,lot_id,
            scope_status,containment,reason) VALUES (?,?,?,?,?,?,?)`)
            .run('DEC-FAIL', 'SCOPE-FAIL', 'TRACE-GATE', lot.lotId, 'excluded', 'No Change',
                'Unreviewed exclusion'), /pass|review/i);
        assert.throws(() => assertDataIntegrity(db), /trace|digest/i);
    } finally {
        db.close();
    }
});
