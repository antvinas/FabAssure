import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync, constants } from 'node:sqlite';
import { verifyAuditChain } from '../domain/audit.mjs';
import { calculateExposure } from '../domain/trace.mjs';
import { buildSourceTraceQuery } from '../domain/trace-source.mjs';
import { projectSource as projectChangeEffectivenessSource }
    from '../domain/change-effectiveness-source.mjs';

export const SCHEMA_VERSION = 9;

const schemaSql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const domainSchemaSql = readFileSync(new URL('./schema-v2.sql', import.meta.url), 'utf8');
const traceSchemaSql = readFileSync(new URL('./schema-v3.sql', import.meta.url), 'utf8');
const capaSchemaSql = readFileSync(new URL('./schema-v4.sql', import.meta.url), 'utf8');
const coverageSchemaSql = readFileSync(new URL('./schema-v5.sql', import.meta.url), 'utf8');
const conditionalSchemaSql = readFileSync(new URL('./schema-v6.sql', import.meta.url), 'utf8');
const changeEffectivenessSchemaSql = readFileSync(new URL('./schema-v7.sql', import.meta.url), 'utf8');
const frozenChangeScopeSchemaSql = readFileSync(new URL('./schema-v8.sql', import.meta.url), 'utf8');
const incidentClosureSchemaSql = readFileSync(new URL('./schema-v9.sql', import.meta.url), 'utf8');
const initialMigration = Object.freeze({
    id: 'MIG-001',
    version: 1,
    name: 'initial manufacturing source schema'
});
const domainMigration = Object.freeze({
    id: 'MIG-002',
    version: 2,
    name: 'change control and audit domain schema'
});
const traceMigration = Object.freeze({
    id: 'MIG-003',
    version: 3,
    name: 'FabTrace proposal and scope review schema'
});
const capaMigration = Object.freeze({
    id: 'MIG-004',
    version: 4,
    name: 'FabTrace CAPA and controlled-document schema'
});
const coverageMigration = Object.freeze({
    id: 'MIG-005',
    version: 5,
    name: 'effectiveness completed-run AOI coverage guard'
});
const conditionalMigration = Object.freeze({
    id: 'MIG-006',
    version: 6,
    name: 'conditional Change Acceptance expiry and typed clock audit'
});
const changeEffectivenessMigration = Object.freeze({
    id: 'MIG-007',
    version: 7,
    name: 'Change effectiveness source-freeze guards'
});
const frozenChangeScopeMigration = Object.freeze({
    id: 'MIG-008',
    version: 8,
    name: 'revision-bound Change effectiveness source-freeze guards'
});
const incidentClosureMigration = Object.freeze({
    id: 'MIG-009',
    version: 9,
    name: 'Incident latest-check closure and effectiveness audit guards'
});
const expectedSchemaManifests = new Map();
const databaseHandles = new WeakMap();

function createDatabaseHandle(raw) {
    const state = { raw, closed: false, insideCallback: false };
    const handle = Object.freeze({
        prepare(sql) {
            if (state.closed) throw new Error('SQLite connection is closed');
            return raw.prepare(sql);
        },
        exec(sql) {
            if (state.closed) throw new Error('SQLite connection is closed');
            return raw.exec(sql);
        },
        close() {
            if (state.insideCallback) throw new Error('Transaction callback cannot close its connection');
            if (!state.closed) {
                state.closed = true;
                raw.close();
            }
        },
        get isTransaction() {
            return !state.closed && raw.isTransaction;
        }
    });
    databaseHandles.set(handle, state);
    return handle;
}

function readUserVersion(db) {
    return db.prepare('PRAGMA user_version').get().user_version;
}

function requireForeignKeys(db) {
    db.exec('PRAGMA foreign_keys = ON');
    if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) {
        throw new Error('SQLite foreign keys must be enabled');
    }
}

function schemaManifest(db) {
    return JSON.stringify(db.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    ).all());
}

function applyConditionalSchema(db) {
    const names = ['acceptance_review_audit_guard', 'acceptance_actor_guard'];
    const historicalGuards = names.map(name => {
        const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
            .get(name);
        if (!row?.sql) throw new Error(`Missing historical acceptance guard: ${name}`);
        return row.sql;
    });
    db.exec(conditionalSchemaSql);
    for (const sql of historicalGuards) db.exec(sql);
}

function applyIncidentClosureMigration(db) {
    db.exec(incidentClosureSchemaSql);
    db.prepare('INSERT INTO schema_migrations (id,version,name,applied_at) VALUES (?,?,?,?)')
        .run(incidentClosureMigration.id, incidentClosureMigration.version,
            incidentClosureMigration.name, new Date().toISOString());
}

function expectedSchemaManifest(version) {
    if (!expectedSchemaManifests.has(version)) {
        const reference = new DatabaseSync(':memory:');
        try {
            reference.exec(schemaSql);
            if (version >= 2) reference.exec(domainSchemaSql);
            if (version >= 3) reference.exec(traceSchemaSql);
            if (version >= 4) reference.exec(capaSchemaSql);
            if (version >= 5) reference.exec(coverageSchemaSql);
            if (version >= 6) applyConditionalSchema(reference);
            if (version >= 7) reference.exec(changeEffectivenessSchemaSql);
            if (version >= 8) reference.exec(frozenChangeScopeSchemaSql);
            if (version >= 9) reference.exec(incidentClosureSchemaSql);
            expectedSchemaManifests.set(version, schemaManifest(reference));
        } finally {
            reference.close();
        }
    }
    return expectedSchemaManifests.get(version);
}

function requireSupportedSchema(db, version = SCHEMA_VERSION) {
    if (schemaManifest(db) !== expectedSchemaManifest(version)) {
        throw new Error('Incompatible SQLite schema shape');
    }
    const migrations = db.prepare(
        'SELECT id, version, name FROM schema_migrations ORDER BY version'
    ).all();
    const expected = version === 1 ? [initialMigration] :
        version === 2 ? [initialMigration, domainMigration] :
            version === 3 ? [initialMigration, domainMigration, traceMigration] :
                version === 4 ? [initialMigration, domainMigration, traceMigration,
                    capaMigration] :
                    version === 5 ? [initialMigration, domainMigration, traceMigration,
                        capaMigration, coverageMigration] :
                        version === 6 ? [initialMigration, domainMigration, traceMigration,
                            capaMigration, coverageMigration, conditionalMigration] :
                            version === 7 ? [initialMigration, domainMigration, traceMigration,
                                capaMigration, coverageMigration, conditionalMigration,
                                changeEffectivenessMigration] :
                                version === 8 ? [initialMigration, domainMigration, traceMigration,
                                    capaMigration, coverageMigration, conditionalMigration,
                                    changeEffectivenessMigration, frozenChangeScopeMigration] :
                                    [initialMigration, domainMigration, traceMigration,
                                        capaMigration, coverageMigration, conditionalMigration,
                                        changeEffectivenessMigration, frozenChangeScopeMigration,
                                        incidentClosureMigration];
    if (readUserVersion(db) !== version || migrations.length !== expected.length ||
        expected.some((migration, index) =>
            migrations[index].id !== migration.id ||
            migrations[index].version !== migration.version ||
            migrations[index].name !== migration.name)) {
        throw new Error('Incompatible SQLite schema migration history');
    }
}

function createFreshSchema(db) {
    db.exec('BEGIN IMMEDIATE');
    try {
        db.exec(schemaSql);
        db.exec(domainSchemaSql);
        db.exec(traceSchemaSql);
        db.exec(capaSchemaSql);
        db.exec(coverageSchemaSql);
        applyConditionalSchema(db);
        db.exec(changeEffectivenessSchemaSql);
        db.exec(frozenChangeScopeSchemaSql);
        db.exec(incidentClosureSchemaSql);
        const insertMigration = db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        );
        const appliedAt = new Date().toISOString();
        insertMigration.run(initialMigration.id, initialMigration.version, initialMigration.name, appliedAt);
        insertMigration.run(domainMigration.id, domainMigration.version, domainMigration.name, appliedAt);
        insertMigration.run(traceMigration.id, traceMigration.version, traceMigration.name, appliedAt);
        insertMigration.run(capaMigration.id, capaMigration.version, capaMigration.name, appliedAt);
        insertMigration.run(coverageMigration.id, coverageMigration.version,
            coverageMigration.name, appliedAt);
        insertMigration.run(conditionalMigration.id, conditionalMigration.version,
            conditionalMigration.name, appliedAt);
        insertMigration.run(changeEffectivenessMigration.id,
            changeEffectivenessMigration.version,
            changeEffectivenessMigration.name, appliedAt);
        insertMigration.run(frozenChangeScopeMigration.id,
            frozenChangeScopeMigration.version,
            frozenChangeScopeMigration.name, appliedAt);
        insertMigration.run(incidentClosureMigration.id,
            incidentClosureMigration.version,
            incidentClosureMigration.name, appliedAt);
        db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
        requireSupportedSchema(db);
        assertDataIntegrity(db);
        db.exec('COMMIT');
    } catch (error) {
        try {
            db.exec('ROLLBACK');
        } catch {
            // Preserve the original schema error.
        }
        throw error;
    }
}

function migrateVersionOne(db) {
    db.exec('BEGIN IMMEDIATE');
    try {
        requireSupportedSchema(db, 1);
        assertRelationalIntegrity(db);
        db.exec(domainSchemaSql);
        db.exec(traceSchemaSql);
        db.exec(capaSchemaSql);
        db.exec(coverageSchemaSql);
        applyConditionalSchema(db);
        db.exec(changeEffectivenessSchemaSql);
        db.exec(frozenChangeScopeSchemaSql);
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(domainMigration.id, domainMigration.version, domainMigration.name, new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(traceMigration.id, traceMigration.version, traceMigration.name, new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(capaMigration.id, capaMigration.version, capaMigration.name, new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(coverageMigration.id, coverageMigration.version, coverageMigration.name,
            new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(conditionalMigration.id, conditionalMigration.version, conditionalMigration.name,
            new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(changeEffectivenessMigration.id, changeEffectivenessMigration.version,
            changeEffectivenessMigration.name, new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(frozenChangeScopeMigration.id, frozenChangeScopeMigration.version,
            frozenChangeScopeMigration.name, new Date().toISOString());
        applyIncidentClosureMigration(db);
        db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
        requireSupportedSchema(db);
        assertRelationalIntegrity(db);
        assertDataIntegrity(db);
        db.exec('COMMIT');
    } catch (error) {
        try {
            db.exec('ROLLBACK');
        } catch {
            // Preserve the original migration error.
        }
        throw error;
    }
}

function migrateVersionTwo(db) {
    db.exec('BEGIN IMMEDIATE');
    try {
        requireSupportedSchema(db, 2);
        assertRelationalIntegrity(db);
        db.exec(traceSchemaSql);
        db.exec(capaSchemaSql);
        db.exec(coverageSchemaSql);
        applyConditionalSchema(db);
        db.exec(changeEffectivenessSchemaSql);
        db.exec(frozenChangeScopeSchemaSql);
        db.prepare(`INSERT INTO legacy_incidents(incident_id,state_at_migration,
            updated_at_at_migration,migrated_at)
            SELECT id,state,updated_at,? FROM incidents`).run(new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(traceMigration.id, traceMigration.version, traceMigration.name, new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(capaMigration.id, capaMigration.version, capaMigration.name, new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(coverageMigration.id, coverageMigration.version, coverageMigration.name,
            new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(conditionalMigration.id, conditionalMigration.version, conditionalMigration.name,
            new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(changeEffectivenessMigration.id, changeEffectivenessMigration.version,
            changeEffectivenessMigration.name, new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(frozenChangeScopeMigration.id, frozenChangeScopeMigration.version,
            frozenChangeScopeMigration.name, new Date().toISOString());
        applyIncidentClosureMigration(db);
        db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
        requireSupportedSchema(db);
        assertRelationalIntegrity(db);
        assertDataIntegrity(db);
        db.exec('COMMIT');
    } catch (error) {
        try {
            db.exec('ROLLBACK');
        } catch {
            // Preserve the original migration error.
        }
        throw error;
    }
}

function migrateVersionThree(db) {
    db.exec('BEGIN IMMEDIATE');
    try {
        requireSupportedSchema(db, 3);
        assertRelationalIntegrity(db);
        assertTraceIntegrity(db);
        verifyAuditChain(db);
        assertIncidentCreationProvenance(db);
        assertLkgAuditProvenance(db);
        assertIncidentRevisionProvenance(db);
        assertIncidentStateProjection(db);
        db.exec(capaSchemaSql);
        db.exec(coverageSchemaSql);
        applyConditionalSchema(db);
        db.exec(changeEffectivenessSchemaSql);
        db.exec(frozenChangeScopeSchemaSql);
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(capaMigration.id, capaMigration.version, capaMigration.name, new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(coverageMigration.id, coverageMigration.version, coverageMigration.name,
            new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(conditionalMigration.id, conditionalMigration.version, conditionalMigration.name,
            new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(changeEffectivenessMigration.id, changeEffectivenessMigration.version,
            changeEffectivenessMigration.name, new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(frozenChangeScopeMigration.id, frozenChangeScopeMigration.version,
            frozenChangeScopeMigration.name, new Date().toISOString());
        applyIncidentClosureMigration(db);
        db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
        requireSupportedSchema(db);
        assertRelationalIntegrity(db);
        assertDataIntegrity(db);
        db.exec('COMMIT');
    } catch (error) {
        try {
            db.exec('ROLLBACK');
        } catch {
            // Preserve the original migration error.
        }
        throw error;
    }
}

function migrateVersionFour(db) {
    db.exec('BEGIN IMMEDIATE');
    try {
        requireSupportedSchema(db, 4);
        assertRelationalIntegrity(db);
        assertTraceIntegrity(db);
        assertIncidentEffectivenessIntegrity(db);
        verifyAuditChain(db);
        assertIncidentCreationProvenance(db);
        assertLkgAuditProvenance(db);
        assertIncidentRevisionProvenance(db);
        assertIncidentStateProjection(db);
        db.exec(coverageSchemaSql);
        applyConditionalSchema(db);
        db.exec(changeEffectivenessSchemaSql);
        db.exec(frozenChangeScopeSchemaSql);
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(coverageMigration.id, coverageMigration.version, coverageMigration.name,
            new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(conditionalMigration.id, conditionalMigration.version, conditionalMigration.name,
            new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(changeEffectivenessMigration.id, changeEffectivenessMigration.version,
            changeEffectivenessMigration.name, new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(frozenChangeScopeMigration.id, frozenChangeScopeMigration.version,
            frozenChangeScopeMigration.name, new Date().toISOString());
        applyIncidentClosureMigration(db);
        db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
        requireSupportedSchema(db);
        assertRelationalIntegrity(db);
        assertIncidentEffectivenessIntegrity(db);
        assertDataIntegrity(db);
        db.exec('COMMIT');
    } catch (error) {
        try {
            db.exec('ROLLBACK');
        } catch {
            // Preserve the original migration error.
        }
        throw error;
    }
}

function migrateVersionFive(db) {
    db.exec('BEGIN IMMEDIATE');
    try {
        requireSupportedSchema(db, 5);
        assertRelationalIntegrity(db);
        assertTraceIntegrity(db);
        assertIncidentEffectivenessIntegrity(db);
        verifyAuditChain(db);
        assertIncidentCreationProvenance(db);
        assertLkgAuditProvenance(db);
        assertIncidentRevisionProvenance(db);
        assertIncidentStateProjection(db);
        applyConditionalSchema(db);
        db.exec(changeEffectivenessSchemaSql);
        db.exec(frozenChangeScopeSchemaSql);
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(conditionalMigration.id, conditionalMigration.version, conditionalMigration.name,
            new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(changeEffectivenessMigration.id, changeEffectivenessMigration.version,
            changeEffectivenessMigration.name, new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(frozenChangeScopeMigration.id, frozenChangeScopeMigration.version,
            frozenChangeScopeMigration.name, new Date().toISOString());
        applyIncidentClosureMigration(db);
        db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
        requireSupportedSchema(db);
        assertRelationalIntegrity(db);
        assertChangeAcceptanceIntegrity(db);
        verifyAuditChain(db);
        assertDataIntegrity(db);
        db.exec('COMMIT');
    } catch (error) {
        try {
            db.exec('ROLLBACK');
        } catch {
            // Preserve the original migration error.
        }
        throw error;
    }
}

function migrateVersionSix(db) {
    db.exec('BEGIN IMMEDIATE');
    try {
        requireSupportedSchema(db, 6);
        assertRelationalIntegrity(db);
        assertTraceIntegrity(db);
        assertIncidentEffectivenessIntegrity(db);
        assertChangeAcceptanceIntegrity(db);
        verifyAuditChain(db);
        assertIncidentCreationProvenance(db);
        assertLkgAuditProvenance(db);
        assertIncidentRevisionProvenance(db);
        assertIncidentStateProjection(db);
        db.exec(changeEffectivenessSchemaSql);
        db.exec(frozenChangeScopeSchemaSql);
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(changeEffectivenessMigration.id, changeEffectivenessMigration.version,
            changeEffectivenessMigration.name, new Date().toISOString());
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(frozenChangeScopeMigration.id, frozenChangeScopeMigration.version,
            frozenChangeScopeMigration.name, new Date().toISOString());
        applyIncidentClosureMigration(db);
        db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
        requireSupportedSchema(db);
        assertDataIntegrity(db);
        db.exec('COMMIT');
    } catch (error) {
        try { db.exec('ROLLBACK'); } catch {
            // Preserve the original migration error.
        }
        throw error;
    }
}

function migrateVersionSeven(db) {
    db.exec('BEGIN IMMEDIATE');
    try {
        requireSupportedSchema(db, 7);
        db.exec(frozenChangeScopeSchemaSql);
        db.prepare(
            'INSERT INTO schema_migrations (id, version, name, applied_at) VALUES (?, ?, ?, ?)'
        ).run(frozenChangeScopeMigration.id, frozenChangeScopeMigration.version,
            frozenChangeScopeMigration.name, new Date().toISOString());
        applyIncidentClosureMigration(db);
        db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
        requireSupportedSchema(db);
        assertDataIntegrity(db);
        db.exec('COMMIT');
    } catch (error) {
        try { db.exec('ROLLBACK'); } catch {
            // Preserve the original migration error.
        }
        throw error;
    }
}

function migrateVersionEight(db) {
    db.exec('BEGIN IMMEDIATE');
    try {
        requireSupportedSchema(db, 8);
        applyIncidentClosureMigration(db);
        db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
        requireSupportedSchema(db);
        assertDataIntegrity(db);
        db.exec('COMMIT');
    } catch (error) {
        try { db.exec('ROLLBACK'); } catch {
            // Preserve the original migration error.
        }
        throw error;
    }
}

export function openDatabase(filename) {
    if (typeof filename !== 'string' || filename.length === 0) {
        throw new TypeError('A local SQLite filename is required');
    }

    const db = new DatabaseSync(filename);
    try {
        db.function('fab_sha256', { deterministic: true }, value => {
            if (typeof value !== 'string') throw new TypeError('SHA-256 source must be text');
            return createHash('sha256').update(value, 'utf8').digest('hex');
        });
        requireForeignKeys(db);
        const version = readUserVersion(db);
        if (version === 0) {
            const objects = db.prepare(
                "SELECT COUNT(*) AS total FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
            ).get().total;
            if (objects !== 0) {
                throw new Error('Incompatible unversioned nonempty database');
            }
            createFreshSchema(db);
        } else if (version === 1) {
            migrateVersionOne(db);
        } else if (version === 2) {
            migrateVersionTwo(db);
        } else if (version === 3) {
            migrateVersionThree(db);
        } else if (version === 4) {
            migrateVersionFour(db);
        } else if (version === 5) {
            migrateVersionFive(db);
        } else if (version === 6) {
            migrateVersionSix(db);
        } else if (version === 7) {
            migrateVersionSeven(db);
        } else if (version === 8) {
            migrateVersionEight(db);
        } else if (version !== SCHEMA_VERSION) {
            throw new Error('Incompatible SQLite schema version: ' + version);
        }
        requireSupportedSchema(db);
        assertDataIntegrity(db);
        return createDatabaseHandle(db);
    } catch (error) {
        db.close();
        throw error;
    }
}

export function assertDataIntegrity(db) {
    requireSupportedSchema(db);
    assertRelationalIntegrity(db);
    assertTraceIntegrity(db);
    assertIncidentEffectivenessIntegrity(db);
    assertChangeAcceptanceIntegrity(db);
    assertChangeEffectivenessIntegrity(db);
    verifyAuditChain(db);
    assertIncidentCreationProvenance(db);
    assertLkgAuditProvenance(db);
    assertIncidentRevisionProvenance(db);
    assertIncidentStateProjection(db);
}

function assertChangeEffectivenessIntegrity(db) {
    const checks = db.prepare('SELECT * FROM effectiveness_checks ORDER BY id').all();
    const auditRows = db.prepare(`SELECT * FROM audit_events
        WHERE entity_type='change' AND action='change-effectiveness-evaluated'
        ORDER BY sequence`).all();
    if (checks.length !== auditRows.length) {
        throw new Error('Change effectiveness check and audit counts disagree');
    }
    const auditsByCheck = new Map();
    for (const event of auditRows) {
        let payload;
        try { payload = JSON.parse(event.payload_json); } catch {
            throw new Error('Change effectiveness audit payload is invalid');
        }
        if (typeof payload?.checkId !== 'string' ||
            auditsByCheck.has(payload.checkId)) {
            throw new Error('Change effectiveness audit check ID is missing or duplicated');
        }
        auditsByCheck.set(payload.checkId, { event, payload });
    }
    for (const check of checks) {
        const revisions = db.prepare(`SELECT h.*,s.recipe_revision_id AS frozen_recipe_revision_id,
                a.id AS acceptance_id,a.accepted_at,
                p.id AS plan_id,p.final_level,p.samples_per_lot,p.alignment_abs_limit
            FROM change_revisions v JOIN changes h ON h.id=v.change_id
            LEFT JOIN change_revision_frozen_scope s ON s.change_revision_id=v.id
            LEFT JOIN acceptances a ON a.change_revision_id=v.id
            LEFT JOIN verification_plans p ON p.id=a.plan_id
            WHERE v.id=?`).all(check.change_revision_id);
        const row = revisions.length === 1 ? revisions[0] : null;
        const audit = auditsByCheck.get(check.id);
        if (!row?.acceptance_id || !row.plan_id || !row.frozen_recipe_revision_id || !audit ||
            audit.event.entity_id !== row.id ||
            audit.event.entity_revision_id !== check.change_revision_id ||
            audit.event.actor_id !== check.recorded_by ||
            audit.event.recorded_at !== check.recorded_at ||
            check.window_start !== row.accepted_at ||
            check.window_end !== check.recorded_at ||
            audit.payload.acceptanceId !== row.acceptance_id ||
            audit.payload.planId !== row.plan_id ||
            audit.payload.windowStart !== check.window_start ||
            audit.payload.windowEnd !== check.window_end) {
            throw new Error(`Change effectiveness provenance mismatch: ${check.id}`);
        }
        let projected;
        try {
            projected = projectChangeEffectivenessSource(db, {
                change: { ...row, recipe_revision_id: row.frozen_recipe_revision_id },
                revisionId: check.change_revision_id,
                acceptance: { id: row.acceptance_id, accepted_at: row.accepted_at },
                plan: row, at: check.window_end
            });
        } catch (error) {
            throw new Error(`Change effectiveness source is invalid: ${check.id}: ${error.message}`);
        }
        const { source, sourceDigest, assessment } = projected;
        const reason = assessment.reasons.length ? assessment.reasons.join('; ') :
            'Synthetic later source meets the approved monitoring rule';
        if (audit.payload.sourceDigest !== sourceDigest ||
            JSON.stringify(audit.payload.sourceLotIds) !==
                JSON.stringify(source.lots.map(lot => lot.lotId)) ||
            JSON.stringify(audit.payload.sourceRunIds) !==
                JSON.stringify(source.lots.map(lot => lot.runId)) ||
            JSON.stringify(audit.payload.aoiInspectionIds) !==
                JSON.stringify(source.lots.map(lot => lot.aoiId)) ||
            audit.payload.status !== assessment.status ||
            audit.payload.lotCount !== assessment.observedLots ||
            check.lot_count !== assessment.observedLots ||
            check.passed !== Number(assessment.status === 'Pass') ||
            check.reason !== reason ||
            audit.event.reason !== reason) {
            throw new Error(`Change effectiveness source or result mismatch: ${check.id}`);
        }
    }
}

function assertIncidentEffectivenessIntegrity(db) {
    const checks = db.prepare('SELECT * FROM incident_effectiveness_checks ORDER BY id').all();
    const auditRows = db.prepare(`SELECT * FROM audit_events
        WHERE entity_type='incident' AND action='effectiveness-evaluated'
        ORDER BY sequence`).all();
    if (checks.length !== auditRows.length) {
        throw new Error('Incident effectiveness check and audit counts disagree');
    }
    const auditsByCheck = new Map();
    for (const event of auditRows) {
        let payload;
        try { payload = JSON.parse(event.payload_json); } catch {
            throw new Error('Incident effectiveness audit payload is invalid');
        }
        if (typeof payload?.checkId !== 'string' || auditsByCheck.has(payload.checkId)) {
            throw new Error('Incident effectiveness audit check ID is missing or duplicated');
        }
        auditsByCheck.set(payload.checkId, { event, payload });
    }
    const incidentFor = db.prepare(`SELECT i.equipment_id,i.module_id,i.defect_code_id,d.severity
        FROM incidents i JOIN defect_codes d ON d.id=i.defect_code_id WHERE i.id=?`);
    const sourceRowsFor = db.prepare(`SELECT r.id AS run_id,r.lot_id,r.start_at,r.end_at,
            r.processed_units,a.id AS aoi_id,a.inspected_at,a.inspected_units,a.rejected_units
        FROM process_runs r LEFT JOIN aoi_inspections a ON a.process_run_id=r.id
        WHERE r.equipment_id=? AND r.module_id=? AND r.start_at>=?
            AND r.end_at<=? ORDER BY r.start_at,r.id`);
    const recurrenceFor = db.prepare(`SELECT COALESCE(SUM(d.defect_count),0) AS total
        FROM process_runs r JOIN aoi_inspections a ON a.process_run_id=r.id
        JOIN aoi_defects d ON d.aoi_inspection_id=a.id
        WHERE r.equipment_id=? AND r.module_id=? AND r.start_at>=?
            AND r.end_at<=? AND a.inspected_at<? AND d.defect_code_id=?`);
    const unresolvedFor = db.prepare(`SELECT COUNT(*) AS total FROM equipment_events e
        WHERE e.equipment_id=? AND e.module_id=? AND e.occurred_at>=?
            AND e.occurred_at<? AND e.event_type IN ('alarm','failure')
            AND NOT EXISTS (SELECT 1 FROM equipment_event_resolutions link
                JOIN maintenance_actions m ON m.id=link.maintenance_action_id
                WHERE link.equipment_event_id=e.id AND m.end_at<=?
                    AND link.recorded_at<=?)`);
    const linkedRevisionFor = db.prepare(`SELECT linked_change_revision_id
        FROM incident_cycles WHERE id=?`);
    const incidentRevisionFor = db.prepare(`SELECT 1 FROM incident_revisions
        WHERE id=? AND incident_id=?`);
    const hasTypedAcceptances = readUserVersion(db) >= 6;
    const acceptanceFor = hasTypedAcceptances ? db.prepare(`SELECT a.id,a.accepted_at,a.acceptance_type,
            a.expires_at,r.change_id
        FROM acceptances a JOIN change_revisions r ON r.id=a.change_revision_id
        WHERE a.id=? AND a.change_revision_id=?`) : null;
    const classificationFor = hasTypedAcceptances ? db.prepare(`SELECT classification_type,classified_at,expires_at
        FROM legacy_acceptance_classifications WHERE acceptance_id=?`) : null;
    const revisionFor = db.prepare(`SELECT change_id,parent_revision_id
        FROM change_revisions WHERE id=?`);
    const priorCloseFor = db.prepare(`SELECT 1 FROM incident_cycle_decisions
        WHERE cycle_id=? AND decision='Closed' AND decided_at<? LIMIT 1`);
    const highRiskFor = db.prepare(`SELECT 1 FROM verification_plans
        WHERE change_revision_id IN (?,?) AND final_level='L3' LIMIT 1`);
    const passingActionsFor = db.prepare(`SELECT a.action_type,r.reviewed_at
        FROM capa_actions a JOIN capa_action_reviews r ON r.action_id=a.id
        WHERE a.cycle_id=? AND r.decision='Pass'`);
    for (const check of checks) {
        const incident = incidentFor.get(check.incident_id);
        const audit = auditsByCheck.get(check.id);
        if (!incident || check.rule_version !== 'DEMO-CAPA-1' || !audit ||
            audit.event.entity_id !== check.incident_id ||
            audit.event.actor_id !== check.evaluated_by ||
            audit.event.recorded_at !== check.evaluated_at ||
            !incidentRevisionFor.get(audit.event.entity_revision_id, check.incident_id) ||
            audit.payload.cycleId !== check.cycle_id) {
            throw new Error(`Incident effectiveness audit or source is invalid: ${check.id}`);
        }
        const rows = sourceRowsFor.all(incident.equipment_id, incident.module_id,
            check.window_start, check.window_end);
        for (const row of rows) {
            if (!row.aoi_id || row.inspected_at < row.start_at ||
                row.inspected_at >= row.end_at || row.inspected_at >= check.window_end ||
                row.inspected_units !== row.processed_units) {
                throw new Error(`Incident effectiveness run lacks complete AOI: ${row.run_id}`);
            }
        }
        const lotIds = rows.map(row => row.lot_id);
        const canonicalSource = JSON.stringify({ lotIds });
        const digest = createHash('sha256').update(canonicalSource, 'utf8').digest('hex');
        if (new Set(lotIds).size !== lotIds.length ||
            check.source_json !== canonicalSource || check.source_digest !== digest ||
            check.lot_count !== rows.length) {
            throw new Error(`Incident effectiveness source or digest differs from SQLite: ${check.id}`);
        }
        const inspected = rows.reduce((total, row) => total + row.inspected_units, 0);
        const rejected = rows.reduce((total, row) => total + row.rejected_units, 0);
        const recurrence = recurrenceFor.get(incident.equipment_id, incident.module_id,
            check.window_start, check.window_end, check.window_end,
            incident.defect_code_id).total;
        const unresolved = unresolvedFor.get(incident.equipment_id, incident.module_id,
            check.window_start, check.window_end, check.evaluated_at,
            check.evaluated_at).total;
        if (!Number.isSafeInteger(inspected) || !Number.isSafeInteger(rejected) ||
            !Number.isSafeInteger(recurrence) || !Number.isSafeInteger(unresolved) ||
            check.inspected_units !== inspected || check.rejected_units !== rejected ||
            check.recurrence_count !== recurrence ||
            check.unresolved_alarm_count !== unresolved) {
            throw new Error(`Incident effectiveness aggregates differ from source: ${check.id}`);
        }
        const dates = rows.map(row => row.inspected_at.slice(0, 10)).sort();
        const first = dates[0];
        const last = dates.at(-1);
        const calendarDays = first && last ?
            (Date.parse(`${last}T00:00:00.000Z`) - Date.parse(`${first}T00:00:00.000Z`)) /
                86400000 : 0;
        const linkedRevision = linkedRevisionFor.get(check.cycle_id);
        if (!linkedRevision) {
            throw new Error(`Incident effectiveness cycle is missing: ${check.id}`);
        }
        const authorityRevisionId = audit.payload.authorityRevisionId;
        const authorityAcceptanceId = audit.payload.operatingAcceptanceId;
        if (linkedRevision.linked_change_revision_id === null) {
            if (authorityRevisionId !== null || authorityAcceptanceId !== null) {
                throw new Error(`Incident effectiveness authority audit mismatch: ${check.id}`);
            }
        } else {
            if (!hasTypedAcceptances) {
                throw new Error(`Historical linked Incident effectiveness authority requires classification: ${check.id}`);
            }
            const acceptance = acceptanceFor.get(authorityAcceptanceId, authorityRevisionId);
            const classification = acceptance?.acceptance_type === null ?
                classificationFor.get(acceptance.id) : null;
            const type = acceptance?.acceptance_type ?? classification?.classification_type;
            const expiresAt = acceptance?.acceptance_type === 'Conditional' ?
                acceptance.expires_at : classification?.classification_type === 'Conditional' ?
                    classification.expires_at : null;
            if (!acceptance || acceptance.accepted_at >= check.evaluated_at ||
                (classification && classification.classified_at >= check.evaluated_at) ||
                !['Ordinary', 'Conditional'].includes(type) ||
                (type === 'Conditional' && (!expiresAt || expiresAt <= check.evaluated_at))) {
                throw new Error(`Incident effectiveness authority audit mismatch: ${check.id}`);
            }
            const linked = revisionFor.get(linkedRevision.linked_change_revision_id);
            let cursor = authorityRevisionId;
            const visited = new Set();
            while (cursor !== linkedRevision.linked_change_revision_id) {
                if (visited.has(cursor)) break;
                visited.add(cursor);
                const row = revisionFor.get(cursor);
                if (!row || row.change_id !== linked?.change_id) break;
                cursor = row.parent_revision_id;
            }
            if (!linked || cursor !== linkedRevision.linked_change_revision_id) {
                throw new Error(`Incident effectiveness authority lineage mismatch: ${check.id}`);
            }
        }
        const requiredLots = incident.severity === 'critical' ||
            highRiskFor.get(linkedRevision.linked_change_revision_id,
                authorityRevisionId) ? 10 : 5;
        const actions = passingActionsFor.all(check.cycle_id);
        const corrective = actions.some(row => row.action_type === 'Corrective');
        const preventive = actions.some(row => row.action_type === 'Preventive');
        const actionsBeforeWindow = actions.every(row => row.reviewed_at < check.window_start);
        const passes = corrective && preventive && actionsBeforeWindow &&
            rows.length >= requiredLots && calendarDays >= 7 && inspected > 0 &&
            rejected * 100 <= inspected * 2 && recurrence === 0 && unresolved === 0 &&
            check.evaluated_at >= check.window_end;
        if (check.passed !== Number(passes)) {
            throw new Error(`Incident effectiveness result differs from demo rule: ${check.id}`);
        }
        const gaps = [];
        if (rows.length < requiredLots) gaps.push(`${requiredLots - rows.length} later lots`);
        if (calendarDays < 7) gaps.push(`${7 - calendarDays} calendar days`);
        if (inspected === 0) gaps.push('AOI denominator');
        if (rejected * 100 > inspected * 2) gaps.push('AOI reject rate above 2%');
        if (recurrence) gaps.push('target defect recurrence');
        if (unresolved) gaps.push('unresolved related alarm');
        const reason = passes ? 'Synthetic source window meets DEMO-CAPA-1' :
            `Synthetic source window needs action: ${gaps.join(', ')}`;
        if (audit.event.reason !== reason ||
            audit.payload.sourceDigest !== digest ||
            audit.payload.windowStart !== check.window_start ||
            audit.payload.windowEnd !== check.window_end ||
            audit.payload.requiredLots !== requiredLots ||
            audit.payload.lotCount !== rows.length ||
            audit.payload.inspectedUnits !== inspected ||
            audit.payload.rejectedUnits !== rejected ||
            audit.payload.recurrenceCount !== recurrence ||
            audit.payload.unresolvedAlarmCount !== unresolved ||
            audit.payload.calendarDays !== calendarDays ||
            audit.payload.passed !== passes ||
            audit.payload.postClose !== Boolean(priorCloseFor.get(check.cycle_id,
                check.evaluated_at)) ||
            JSON.stringify(audit.payload.sourceRunIds) !==
                JSON.stringify(rows.map(row => row.run_id)) ||
            JSON.stringify(audit.payload.aoiInspectionIds) !==
                JSON.stringify(rows.map(row => row.aoi_id)) ||
            JSON.stringify(audit.payload.gaps) !== JSON.stringify(gaps)) {
            throw new Error(`Incident effectiveness source or audit mismatch: ${check.id}`);
        }
    }
    const staleClosure = db.prepare(`SELECT d.id FROM incident_cycle_decisions d
        JOIN incident_effectiveness_checks cited ON cited.id=d.effectiveness_check_id
        WHERE d.decision='Closed' AND EXISTS (
            SELECT 1 FROM incident_effectiveness_checks later
            WHERE later.cycle_id=d.cycle_id AND later.incident_id=d.incident_id
                AND later.evaluated_at<d.decided_at
                AND (later.evaluated_at>cited.evaluated_at OR
                    (later.evaluated_at=cited.evaluated_at AND later.id>cited.id))
        ) LIMIT 1`).get();
    if (staleClosure) {
        throw new Error(`Incident closure cites a stale effectiveness check: ${staleClosure.id}`);
    }
}

function assertChangeAcceptanceIntegrity(db) {
    const acceptances = db.prepare(`SELECT a.*,r.change_id FROM acceptances a
        JOIN change_revisions r ON r.id=a.change_revision_id ORDER BY a.id`).all();
    const classificationFor = db.prepare(`SELECT * FROM legacy_acceptance_classifications
        WHERE acceptance_id=?`);
    const acceptanceAuditFor = db.prepare(`SELECT * FROM audit_events
        WHERE entity_type='change' AND entity_id=? AND entity_revision_id=?
            AND action='change-accepted' AND json_extract(payload_json,'$.acceptanceId')=?`);
    const classificationAuditFor = db.prepare('SELECT * FROM audit_events WHERE id=?');
    for (const acceptance of acceptances) {
        const audits = acceptanceAuditFor.all(acceptance.change_id,
            acceptance.change_revision_id, acceptance.id);
        const audit = audits[0];
        const review = db.prepare('SELECT * FROM reviews WHERE id=?').get(acceptance.review_id);
        if (audits.length !== 1 || !audit ||
            audit.actor_id !== acceptance.approver_actor_id ||
            audit.recorded_at !== acceptance.accepted_at ||
            audit.prior_state !== 'Independent Review' ||
            audit.new_state !== 'Accepted' ||
            typeof audit.reason !== 'string' || !audit.reason.trim() ||
            !review || review.change_revision_id !== acceptance.change_revision_id ||
            review.plan_id !== acceptance.plan_id || review.decision !== 'Pass' ||
            review.evidence_set_digest !== acceptance.frozen_digest ||
            review.reviewed_at >= acceptance.accepted_at) {
            throw new Error(`Change acceptance audit provenance is missing: ${acceptance.id}`);
        }
        const payload = JSON.parse(audit.payload_json);
        if (payload.reviewId !== acceptance.review_id ||
            payload.planId !== acceptance.plan_id ||
            payload.packageDigest !== acceptance.frozen_digest ||
            payload.reviewerActorId !== review.reviewer_actor_id ||
            !Array.isArray(payload.verifierActorIds) ||
            !Array.isArray(payload.linkedEvidenceIds)) {
            throw new Error(`Change acceptance audit package differs: ${acceptance.id}`);
        }
        const evidence = db.prepare(`SELECT id,recorded_by FROM evidence_items
            WHERE change_revision_id=? ORDER BY id`).all(acceptance.change_revision_id);
        const resultVerifiers = db.prepare(`SELECT verifier_actor_id FROM criterion_results
            WHERE plan_id=? ORDER BY criterion_code`).all(acceptance.plan_id);
        const startVerifiers = db.prepare(`SELECT actor_id FROM audit_events
            WHERE entity_type='change' AND entity_id=? AND entity_revision_id=?
                AND action='verification-started' ORDER BY sequence`)
            .all(acceptance.change_id, acceptance.change_revision_id);
        const expectedVerifiers = [...new Set([
            ...resultVerifiers.map(row => row.verifier_actor_id),
            ...evidence.map(row => row.recorded_by),
            ...startVerifiers.map(row => row.actor_id)
        ])];
        if (JSON.stringify(payload.linkedEvidenceIds) !==
                JSON.stringify(evidence.map(row => row.id)) ||
            JSON.stringify(payload.verifierActorIds) !== JSON.stringify(expectedVerifiers)) {
            throw new Error(`Change acceptance audit evidence or verifier set differs: ${acceptance.id}`);
        }
        const classification = classificationFor.get(acceptance.id);
        if (acceptance.acceptance_type === null) {
            if (acceptance.condition_text !== null || acceptance.expires_at !== null) {
                throw new Error(`Legacy acceptance terms were rewritten: ${acceptance.id}`);
            }
            if (classification) {
                const classAudit = classificationAuditFor.get(classification.audit_event_id);
                if (!classAudit || classAudit.action !== 'legacy-acceptance-classified' ||
                    classAudit.actor_id !== classification.classified_by ||
                    classAudit.recorded_at !== classification.classified_at) {
                    throw new Error(`Legacy acceptance classification audit differs: ${acceptance.id}`);
                }
                const classPayload = JSON.parse(classAudit.payload_json);
                if (classPayload.acceptanceId !== acceptance.id ||
                    classPayload.classificationType !== classification.classification_type ||
                    classPayload.condition !== classification.condition_text ||
                    classPayload.expiresAt !== classification.expires_at) {
                    throw new Error(`Legacy acceptance classification terms differ: ${acceptance.id}`);
                }
            }
        } else if (acceptance.acceptance_type === 'Ordinary') {
            if (classification || acceptance.condition_text !== null ||
                acceptance.expires_at !== null || payload.acceptanceType !== 'Ordinary') {
                throw new Error(`Ordinary acceptance terms differ: ${acceptance.id}`);
            }
        } else if (acceptance.acceptance_type === 'Conditional') {
            if (classification || typeof acceptance.condition_text !== 'string' ||
                !acceptance.condition_text.trim() || !acceptance.expires_at ||
                acceptance.expires_at <= acceptance.accepted_at ||
                payload.acceptanceType !== 'Conditional' ||
                payload.condition !== acceptance.condition_text ||
                payload.expiresAt !== acceptance.expires_at) {
                throw new Error(`Conditional acceptance terms differ: ${acceptance.id}`);
            }
        } else {
            throw new Error(`Unknown acceptance type: ${acceptance.id}`);
        }
    }
    const expiries = db.prepare(`SELECT e.*,a.acceptance_type,a.expires_at,
        c.classification_type,c.expires_at AS classified_expires_at
        FROM conditional_acceptance_expiries e
        JOIN acceptances a ON a.id=e.acceptance_id
        LEFT JOIN legacy_acceptance_classifications c ON c.acceptance_id=a.id
        ORDER BY e.id`).all();
    for (const expiry of expiries) {
        const due = expiry.acceptance_type === 'Conditional' ? expiry.expires_at :
            expiry.classification_type === 'Conditional' ? expiry.classified_expires_at : null;
        const audit = classificationAuditFor.get(expiry.audit_event_id);
        if (!due || due !== expiry.effective_at || !audit ||
            audit.action !== 'conditional-acceptance-expired' ||
            audit.system_principal_id !== 'SYS-SERVER-CLOCK' ||
            audit.recorded_at !== expiry.observed_at ||
            audit.prior_state !== expiry.prior_state || audit.new_state !== 'Reopened') {
            throw new Error(`Conditional acceptance expiry provenance differs: ${expiry.id}`);
        }
        const payload = JSON.parse(audit.payload_json);
        if (payload.acceptanceId !== expiry.acceptance_id ||
            payload.expiresAt !== expiry.effective_at ||
            payload.observedAt !== expiry.observed_at ||
            payload.priorCycleNo !== expiry.prior_cycle_no ||
            payload.newCycleNo !== expiry.new_cycle_no) {
            throw new Error(`Conditional acceptance expiry audit differs: ${expiry.id}`);
        }
    }
}

export function assertValidatedTransaction(db) {
    const state = databaseHandles.get(db);
    if (!state || state.closed || !state.insideCallback || !state.raw.isTransaction) {
        throw new Error('An active validated transaction callback is required');
    }
}

function assertRelationalIntegrity(db) {
    if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) {
        throw new Error('SQLite foreign-key enforcement is disabled');
    }
    const foreignKeyError = db.prepare('PRAGMA foreign_key_check').get();
    if (foreignKeyError) {
        throw new Error('Foreign-key integrity failure');
    }
    const integrityRows = db.prepare('PRAGMA integrity_check').all();
    if (integrityRows.length !== 1 || integrityRows[0].integrity_check !== 'ok') {
        throw new Error('SQLite integrity check failed');
    }
    const aoiGap = db.prepare(
        'SELECT entity_type, entity_id, issue FROM aoi_integrity_gaps LIMIT 1'
    ).get();
    if (aoiGap) {
        throw new Error('AOI coverage integrity failure: ' + aoiGap.issue + ' for ' + aoiGap.entity_id);
    }
}

function assertTraceIntegrity(db) {
    const proposals = db.prepare('SELECT * FROM trace_proposals').all();
    const proposalRevisionFor = db.prepare('SELECT * FROM incident_revisions WHERE id=?');
    const proposalAuditsFor = db.prepare(`SELECT * FROM audit_events WHERE entity_type='incident'
        AND entity_id=? AND entity_revision_id=? AND action=?
        AND actor_id=? AND recorded_at=?`);
    const candidatesFor = db.prepare('SELECT lot_id,details_json FROM trace_candidates WHERE proposal_id=?');
    const reviewFor = db.prepare('SELECT * FROM scope_reviews WHERE proposal_id=?');
    const decisionsFor = db.prepare('SELECT id FROM scope_decisions WHERE review_id=? ORDER BY id');
    const auditFor = db.prepare(`SELECT * FROM audit_events WHERE entity_type='incident'
        AND entity_id=? AND entity_revision_id=? AND action=? AND actor_id=?
        AND recorded_at=? AND reason=?`);
    for (const proposal of proposals) {
        const incident = db.prepare(`SELECT i.* FROM incidents i JOIN incident_revisions ir
            ON ir.incident_id=i.id WHERE ir.id=?`).get(proposal.incident_revision_id);
        const lkg = proposal.lkg_observation_id ? db.prepare('SELECT * FROM lkg_observations WHERE id=?')
            .get(proposal.lkg_observation_id) : null;
        if (!incident || proposal.cutoff_at !== incident.detected_at) {
            throw new Error(`Trace proposal incident cutoff mismatch: ${proposal.id}`);
        }
        const sourceQuery = buildSourceTraceQuery(db, {
            equipmentId: incident.equipment_id, moduleId: incident.module_id,
            recipeRevisionId: proposal.recipe_revision_id, defectCodeId: incident.defect_code_id,
            earliestLkgAt: lkg?.earliest_possible_at ?? null,
            latestLkgAt: lkg?.latest_possible_at ?? null,
            cutoffAt: incident.detected_at
        });
        const sourceResult = calculateExposure(sourceQuery);
        if (JSON.stringify(sourceQuery) !== proposal.query_json ||
            sourceQuery.earliestTraceAt !== proposal.earliest_trace_at ||
            JSON.stringify(sourceResult) !== proposal.result_json) {
            throw new Error(`Trace proposal differs from immutable source rows: ${proposal.id}`);
        }
        const digest = createHash('sha256').update(proposal.result_json, 'utf8').digest('hex');
        if (digest !== proposal.result_digest) throw new Error(`Trace result digest mismatch: ${proposal.id}`);
        const result = JSON.parse(proposal.result_json);
        if (!result || !Array.isArray(result.lots) || result.lots.length === 0) {
            throw new Error(`Trace result lacks candidate lots: ${proposal.id}`);
        }
        const revision = proposalRevisionFor.get(proposal.incident_revision_id);
        const action = revision?.revision_no === 1 ? 'trace-proposed' : 'trace-revised';
        const proposalAudits = revision ? proposalAuditsFor.all(incident.id,
            revision.id, action, proposal.proposer_actor_id, proposal.proposed_at) : [];
        const proposalAudit = proposalAudits[0];
        const proposalPayload = proposalAudit ? JSON.parse(proposalAudit.payload_json) : null;
        if (proposalAudits.length !== 1 ||
            proposalAudit.prior_state !== (revision.revision_no === 1 ? 'Contained' : 'Trace Proposed') ||
            proposalAudit.new_state !== (revision.revision_no === 1 ? 'Trace Proposed' : null) ||
            proposalPayload.proposalId !== proposal.id ||
            proposalPayload.lkgId !== proposal.lkg_observation_id ||
            proposalPayload.resultDigest !== proposal.result_digest ||
            JSON.stringify(proposalPayload.sourceRunIds) !==
                JSON.stringify(sourceQuery.runs.map(run => run.id)) ||
            JSON.stringify(proposalPayload.candidateLotIds) !==
                JSON.stringify(result.lots.map(lot => lot.lotId)) ||
            (revision.revision_no === 1 &&
                (proposalPayload.intervalConvention !== '[start,end)' ||
                proposalPayload.lkgMode !== (lkg ? 'bounded' : 'unknown-start') ||
                proposalAudit.reason !== (lkg ?
                    'Synthetic source interval and AOI intersection' :
                    'Synthetic source interval and AOI intersection; unknown LKG start')))) {
            throw new Error(`Trace proposal audit differs from source evidence: ${proposal.id}`);
        }
        const candidates = candidatesFor.all(proposal.id);
        if (candidates.length !== result.lots.length) {
            throw new Error(`Trace candidate set differs from result: ${proposal.id}`);
        }
        const byLot = new Map(result.lots.map(lot => [lot.lotId, JSON.stringify(lot)]));
        if (byLot.size !== result.lots.length || candidates.some(candidate =>
            JSON.stringify(JSON.parse(candidate.details_json)) !== byLot.get(candidate.lot_id))) {
            throw new Error(`Trace candidate details differ from result: ${proposal.id}`);
        }
        const review = reviewFor.get(proposal.id);
        if (review) {
            const decisionIds = decisionsFor.all(review.id).map(row => row.id);
            if ((review.decision === 'Pass' && decisionIds.length !== candidates.length) ||
                (review.decision === 'Needs Rework' && decisionIds.length !== 0)) {
                throw new Error(`Trace review lot decisions are incomplete or invalid: ${review.id}`);
            }
            const action = review.decision === 'Pass' ? 'scope-reviewed' : 'scope-needs-rework';
            const audits = auditFor.all(incident.id, proposal.incident_revision_id, action,
                review.reviewer_actor_id, review.reviewed_at, review.reason);
            const matchingAudit = audits.some(audit => {
                if (audit.prior_state !== 'Trace Proposed' ||
                    audit.new_state !== (review.decision === 'Pass' ? 'Scope Reviewed' : null)) return false;
                const payload = JSON.parse(audit.payload_json);
                return payload.proposalId === proposal.id && payload.reviewId === review.id &&
                    payload.candidateDigest === review.candidate_digest &&
                    payload.decision === review.decision &&
                    Array.isArray(payload.lotDecisionIds) &&
                    JSON.stringify([...payload.lotDecisionIds].sort()) === JSON.stringify(decisionIds);
            });
            if (!matchingAudit) throw new Error(`Trace scope review audit is missing: ${review.id}`);
        }
    }
}

function assertIncidentCreationProvenance(db) {
    const incidents = db.prepare(`SELECT i.* FROM incidents i WHERE NOT EXISTS (
        SELECT 1 FROM legacy_incidents l WHERE l.incident_id=i.id
    )`).all();
    const firstRevisionFor = db.prepare(`SELECT * FROM incident_revisions
        WHERE incident_id=? AND revision_no=1`);
    const eventsFor = db.prepare(`SELECT * FROM audit_events WHERE entity_type='incident'
        AND entity_id=? ORDER BY sequence`);
    const detectionFor = db.prepare('SELECT * FROM equipment_events WHERE id=?');
    const runFor = db.prepare('SELECT * FROM process_runs WHERE id=?');
    for (const incident of incidents) {
        const revisions = firstRevisionFor.all(incident.id);
        const events = eventsFor.all(incident.id);
        const creation = events[0];
        if (revisions.length !== 1 || !creation ||
            events.filter(event => event.action === 'incident-created').length !== 1) {
            throw new Error(`Incident creation lacks a unique R1 and audit origin: ${incident.id}`);
        }
        const revision = revisions[0];
        const payload = JSON.parse(creation.payload_json);
        const detection = detectionFor.get(payload.detectionEventId);
        const observedRun = runFor.get(payload.observedRunId);
        if (revision.created_by !== incident.proposer_actor_id ||
            revision.created_at !== incident.created_at ||
            incident.created_at < incident.detected_at ||
            creation.action !== 'incident-created' ||
            creation.entity_revision_id !== revision.id ||
            creation.actor_id !== incident.proposer_actor_id ||
            creation.recorded_at !== incident.created_at ||
            creation.prior_state !== null || creation.new_state !== 'Open' ||
            creation.reason !== incident.title ||
            payload.defectCodeId !== incident.defect_code_id ||
            payload.detectedAt !== incident.detected_at ||
            !detection || detection.event_type !== 'defect-detected' ||
            detection.occurred_at !== incident.detected_at ||
            detection.equipment_id !== incident.equipment_id ||
            detection.module_id !== incident.module_id ||
            !observedRun || observedRun.lot_id !== payload.observedLotId ||
            observedRun.equipment_id !== incident.equipment_id ||
            observedRun.module_id !== incident.module_id ||
            observedRun.recipe_revision_id !== payload.recipeRevisionId ||
            observedRun.end_at > incident.detected_at) {
            throw new Error(`Incident creation audit differs from source and R1: ${incident.id}`);
        }
    }
}

function assertLkgAuditProvenance(db) {
    const observations = db.prepare(`SELECT l.*,r.incident_id,r.revision_no FROM lkg_observations l
        JOIN incident_revisions r ON r.id=l.incident_revision_id
        WHERE NOT EXISTS (
            SELECT 1 FROM legacy_incidents old WHERE old.incident_id=r.incident_id
        )`).all();
    const auditsFor = db.prepare(`SELECT * FROM audit_events WHERE entity_type='incident'
        AND entity_id=? AND entity_revision_id=? AND action='lkg-recorded'`);
    const containmentFor = db.prepare(`SELECT sequence,recorded_at FROM audit_events
        WHERE entity_type='incident' AND entity_id=? AND entity_revision_id=?
        AND action='incident-contained' AND new_state='Contained'`);
    const proposalFor = db.prepare(`SELECT lkg_observation_id FROM trace_proposals
        WHERE incident_revision_id=?`);
    const proposalAuditFor = db.prepare(`SELECT sequence FROM audit_events
        WHERE entity_type='incident' AND entity_id=? AND entity_revision_id=?
        AND action='trace-proposed'`);
    for (const row of observations) {
        if (row.revision_no > 1) {
            const proposal = proposalFor.get(row.incident_revision_id);
            if (!proposal || proposal.lkg_observation_id !== row.id) {
                throw new Error(`Revised LKG observation lacks trace proposal: ${row.id}`);
            }
            continue;
        }
        const audits = auditsFor.all(row.incident_id, row.incident_revision_id);
        const audit = audits[0];
        const containment = containmentFor.all(row.incident_id, row.incident_revision_id);
        const payload = audit ? JSON.parse(audit.payload_json) : null;
        const proposalAudit = proposalAuditFor.get(row.incident_id, row.incident_revision_id);
        if (audits.length !== 1 || containment.length !== 1 ||
            containment[0].sequence >= audit.sequence ||
            containment[0].recorded_at >= audit.recorded_at ||
            audit.actor_id !== row.recorded_by ||
            audit.recorded_at !== row.recorded_at || audit.prior_state !== 'Contained' ||
            audit.new_state !== null || audit.reason !== row.limitation ||
            (proposalAudit && audit.sequence >= proposalAudit.sequence) ||
            payload.lkgId !== row.id || payload.aoiInspectionId !== row.aoi_inspection_id ||
            payload.earliestPossibleAt !== row.earliest_possible_at ||
            payload.latestPossibleAt !== row.latest_possible_at ||
            payload.method !== row.method || payload.sampleScope !== row.sample_scope) {
            throw new Error(`LKG observation lacks matching recorded audit: ${row.id}`);
        }
    }
    const recordedEvents = db.prepare(`SELECT * FROM audit_events
        WHERE entity_type='incident' AND action='lkg-recorded'`).all();
    const revisionFor = db.prepare('SELECT * FROM incident_revisions WHERE id=?');
    const observationFor = db.prepare('SELECT * FROM lkg_observations WHERE id=?');
    for (const audit of recordedEvents) {
        const revision = revisionFor.get(audit.entity_revision_id);
        const payload = JSON.parse(audit.payload_json);
        const observation = observationFor.get(payload.lkgId);
        if (!revision || revision.revision_no !== 1 ||
            revision.incident_id !== audit.entity_id || !observation ||
            observation.incident_revision_id !== revision.id) {
            throw new Error(`LKG recorded audit lacks observation: ${audit.id}`);
        }
    }
}

function sameLkgAuditSource(snapshot, row) {
    if (!row) return snapshot === null;
    return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) &&
        snapshot.aoiInspectionId === row.aoi_inspection_id &&
        snapshot.earliestPossibleAt === row.earliest_possible_at &&
        snapshot.latestPossibleAt === row.latest_possible_at &&
        snapshot.method === row.method &&
        snapshot.sampleScope === row.sample_scope &&
        snapshot.limitation === row.limitation;
}

function assertIncidentRevisionProvenance(db) {
    const revisions = db.prepare(`SELECT r.* FROM incident_revisions r
        WHERE r.revision_no>1 AND NOT EXISTS (
            SELECT 1 FROM legacy_incidents l WHERE l.incident_id=r.incident_id
        )`).all();
    const proposalsFor = db.prepare('SELECT * FROM trace_proposals WHERE incident_revision_id=?');
    const reviewFor = db.prepare('SELECT * FROM scope_reviews WHERE proposal_id=?');
    const auditsFor = db.prepare(`SELECT * FROM audit_events WHERE entity_type='incident'
        AND entity_id=? AND entity_revision_id=? AND action='trace-revised'`);
    const priorAuditsFor = db.prepare(`SELECT * FROM audit_events WHERE entity_type='incident'
        AND entity_id=? AND entity_revision_id=? AND action='scope-needs-rework'
        AND actor_id=? AND recorded_at=?`);
    const proposalAuditsFor = db.prepare(`SELECT * FROM audit_events WHERE entity_type='incident'
        AND entity_id=? AND entity_revision_id=? AND action=?
        AND actor_id=? AND recorded_at=?`);
    const revisionFor = db.prepare('SELECT * FROM incident_revisions WHERE id=?');
    for (const revision of revisions) {
        const current = proposalsFor.all(revision.id);
        const parent = proposalsFor.all(revision.parent_revision_id);
        const priorReview = parent.length === 1 ? reviewFor.get(parent[0].id) : null;
        const audits = auditsFor.all(revision.incident_id, revision.id);
        const priorAudits = priorReview ? priorAuditsFor.all(revision.incident_id,
            revision.parent_revision_id, priorReview.reviewer_actor_id,
            priorReview.reviewed_at) : [];
        const parentRevision = revisionFor.get(revision.parent_revision_id);
        const parentAction = parentRevision?.revision_no === 1 ? 'trace-proposed' :
            'trace-revised';
        const parentAudits = parent.length === 1 && parentRevision ?
            proposalAuditsFor.all(revision.incident_id, revision.parent_revision_id,
                parentAction, parent[0].proposer_actor_id, parent[0].proposed_at) : [];
        if (current.length !== 1 || parent.length !== 1 ||
            priorReview?.decision !== 'Needs Rework' || audits.length !== 1 ||
            priorAudits.length !== 1 || parentAudits.length !== 1) {
            throw new Error(`Incident revision lacks audited trace rework: ${revision.id}`);
        }
        const audit = audits[0];
        const priorAudit = priorAudits[0];
        const payload = JSON.parse(audit.payload_json);
        const priorPayload = JSON.parse(priorAudit.payload_json);
        const proposal = current[0];
        const priorLkg = parent[0].lkg_observation_id ? db.prepare(
            'SELECT * FROM lkg_observations WHERE id=?').get(parent[0].lkg_observation_id) : null;
        const lkg = proposal.lkg_observation_id ? db.prepare(
            'SELECT * FROM lkg_observations WHERE id=?').get(proposal.lkg_observation_id) : null;
        const query = JSON.parse(proposal.query_json);
        const result = JSON.parse(proposal.result_json);
        if (audit.actor_id !== revision.created_by || audit.recorded_at !== revision.created_at ||
            parentAudits[0].sequence >= priorAudit.sequence ||
            parent[0].proposed_at >= priorReview.reviewed_at ||
            audit.sequence <= priorAudit.sequence ||
            audit.recorded_at <= priorReview.reviewed_at ||
            priorPayload.reviewId !== priorReview.id ||
            priorPayload.proposalId !== parent[0].id ||
            audit.reason !== (payload.lkgMode === 'unknown-start' ?
                `${revision.reason}; unknown LKG start` : revision.reason) ||
            audit.prior_state !== 'Trace Proposed' ||
            audit.new_state !== null || proposal.proposer_actor_id !== revision.created_by ||
            proposal.proposed_at !== revision.created_at ||
            payload.parentRevisionId !== revision.parent_revision_id ||
            payload.priorProposalId !== parent[0].id ||
            payload.priorReviewId !== priorReview.id ||
            payload.priorLkgId !== parent[0].lkg_observation_id ||
            !['revalidated', 'carried-forward', 'unknown-start'].includes(payload.lkgMode) ||
            (payload.lkgMode === 'unknown-start' &&
                (lkg !== null || priorLkg !== null)) ||
            (payload.lkgMode !== 'unknown-start' && !lkg) ||
            (payload.lkgMode === 'carried-forward' && (!priorLkg ||
                lkg.aoi_inspection_id !== priorLkg.aoi_inspection_id ||
                lkg.earliest_possible_at !== priorLkg.earliest_possible_at ||
                lkg.latest_possible_at !== priorLkg.latest_possible_at ||
                lkg.method !== `Carried forward from ${priorLkg.id}: ${priorLkg.method}` ||
                lkg.sample_scope !== priorLkg.sample_scope ||
                lkg.limitation !== priorLkg.limitation)) ||
            payload.lkgId !== proposal.lkg_observation_id ||
            !sameLkgAuditSource(payload.lkgSource, lkg) ||
            payload.proposalId !== proposal.id ||
            payload.resultDigest !== proposal.result_digest ||
            JSON.stringify(payload.sourceRunIds) !== JSON.stringify(query.runs.map(run => run.id)) ||
            JSON.stringify(payload.candidateLotIds) !== JSON.stringify(result.lots.map(lot => lot.lotId)) ||
            (lkg && (lkg.incident_revision_id !== revision.id ||
                lkg.recorded_by !== revision.created_by || lkg.recorded_at !== revision.created_at))) {
            throw new Error(`Incident revision audit differs from trace evidence: ${revision.id}`);
        }
    }
}

function assertIncidentStateProjection(db) {
    const incidents = db.prepare('SELECT id,state,created_at,updated_at FROM incidents').all();
    const eventsFor = db.prepare(`SELECT * FROM audit_events
        WHERE entity_type='incident' AND entity_id=? ORDER BY sequence DESC`);
    const legacyFor = db.prepare(`SELECT state_at_migration,updated_at_at_migration
        FROM legacy_incidents WHERE incident_id=?`);
    const proposalsFor = db.prepare('SELECT * FROM trace_proposals WHERE incident_revision_id=?');
    const passReviewsFor = db.prepare(`SELECT * FROM scope_reviews
        WHERE proposal_id=? AND decision='Pass'`);
    const candidateCountFor = db.prepare(`SELECT COUNT(*) AS n FROM trace_candidates
        WHERE proposal_id=?`);
    const decisionIdsFor = db.prepare(`SELECT id FROM scope_decisions
        WHERE review_id=? ORDER BY id`);
    for (const incident of incidents) {
        const events = eventsFor.all(incident.id);
        if (events.length === 0) {
            const legacy = legacyFor.get(incident.id);
            if (legacy && legacy.state_at_migration === incident.state &&
                legacy.updated_at_at_migration === incident.updated_at) continue;
            throw new Error(`Incident without audited provenance or frozen legacy state: ${incident.id}`);
        }
        if (!legacyFor.get(incident.id)) {
            const creation = events.at(-1);
            if (creation.action !== 'incident-created' || creation.prior_state !== null ||
                creation.new_state !== 'Open' || creation.recorded_at !== incident.created_at) {
                throw new Error(`Incident creation differs from audited origin: ${incident.id}`);
            }
        }
        const stateEvent = events.find(event => event.new_state !== null);
        if (!stateEvent || stateEvent.new_state !== incident.state ||
            events[0].recorded_at !== incident.updated_at) {
            throw new Error(`Incident state differs from audited projection: ${incident.id}`);
        }
        if (incident.state === 'Scope Reviewed' && !legacyFor.get(incident.id)) {
            const proposals = proposalsFor.all(stateEvent.entity_revision_id);
            const proposal = proposals[0];
            const reviews = proposal ? passReviewsFor.all(proposal.id) : [];
            const review = reviews[0];
            const candidateCount = proposal ? candidateCountFor.get(proposal.id).n : 0;
            const decisionIds = review ? decisionIdsFor.all(review.id).map(row => row.id) : [];
            const payload = JSON.parse(stateEvent.payload_json);
            if (stateEvent.action !== 'scope-reviewed' ||
                stateEvent.prior_state !== 'Trace Proposed' ||
                proposals.length !== 1 || reviews.length !== 1 || candidateCount < 1 ||
                review.reviewer_actor_id === proposal.proposer_actor_id ||
                review.reviewer_actor_id !== stateEvent.actor_id ||
                review.reviewed_at !== stateEvent.recorded_at ||
                review.reason !== stateEvent.reason ||
                review.candidate_digest !== proposal.result_digest ||
                decisionIds.length !== candidateCount ||
                payload.proposalId !== proposal.id || payload.reviewId !== review.id ||
                payload.candidateDigest !== review.candidate_digest ||
                payload.decision !== 'Pass' || !Array.isArray(payload.lotDecisionIds) ||
                JSON.stringify([...payload.lotDecisionIds].sort()) !==
                    JSON.stringify(decisionIds)) {
                throw new Error(`Incident reviewed state lacks independent scope decision: ${incident.id}`);
            }
        }
    }
}

function denyCallbackTransactionControl(action) {
    // Keep transaction ownership with withValidatedTransaction until integrity checks finish.
    if (action === constants.SQLITE_TRANSACTION ||
        action === constants.SQLITE_SAVEPOINT ||
        action === constants.SQLITE_ATTACH ||
        action === constants.SQLITE_DETACH) {
        return constants.SQLITE_DENY;
    }
    return constants.SQLITE_OK;
}

export function withValidatedTransaction(db, synchronousOperation) {
    if (typeof synchronousOperation !== 'function') {
        throw new TypeError('A synchronous transaction operation is required');
    }
    const state = databaseHandles.get(db);
    if (!state || state.closed) {
        throw new TypeError('An open FabAssure database handle is required');
    }
    if (synchronousOperation.constructor?.name === 'AsyncFunction') {
        throw new TypeError('Transaction operation must be synchronous');
    }
    const raw = state.raw;
    if (raw.isTransaction) {
        throw new Error('Nested validated transaction is not supported');
    }
    raw.exec('BEGIN IMMEDIATE');
    let active = true;
    let guardInstalled = false;
    let closeAfterError = false;
    try {
        raw.setAuthorizer(denyCallbackTransactionControl);
        guardInstalled = true;
        state.insideCallback = true;
        const value = synchronousOperation(db);
        state.insideCallback = false;
        raw.setAuthorizer(null);
        guardInstalled = false;
        if (value !== null && (typeof value === 'object' || typeof value === 'function') &&
            typeof value.then === 'function') {
            closeAfterError = true;
            Promise.resolve(value).catch(() => {});
            throw new TypeError('Transaction operation must be synchronous');
        }
        assertDataIntegrity(raw);
        raw.exec('COMMIT');
        active = false;
        return value;
    } catch (error) {
        state.insideCallback = false;
        if (guardInstalled) raw.setAuthorizer(null);
        if (active) {
            try {
                if (raw.isTransaction) raw.exec('ROLLBACK');
            } catch {
                // Preserve the original operation or integrity error.
            }
        }
        if (closeAfterError) db.close();
        throw error;
    }
}
