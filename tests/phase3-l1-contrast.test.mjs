import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { assertDataIntegrity, openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { createChange, submitChange, classifyChange, approvePlan,
    startVerification, recordBaselineSet, addMeasurementEvidence,
    addAoiEvidence, recordAlignmentResult, recordAoiResults,
    markEvidenceReady, beginIndependentReview, recordIndependentReview,
    acceptChange } from '../src/domain/change-service.mjs';
import { createLocalServer, listenLocal } from '../src/server/http.mjs';

const changeId = 'CHG-L1-MODULE-CONTRAST';
const at = (day, time) => `2026-08-${String(day).padStart(2, '0')}T${time}.000Z`;

function addLaterTargetRecurrence(db) {
    db.prepare(`INSERT INTO lots(id,product_family_id,code,quantity,start_at,end_at)
        SELECT 'LOT-B-006',product_family_id,'LOT-B-006',100,?,?
        FROM lots WHERE id='LOT-B-005'`).run(at(8, '08:00:00'), at(8, '12:00:00'));
    db.prepare(`INSERT INTO process_runs(id,lot_id,equipment_id,module_id,
        recipe_revision_id,start_at,end_at,processed_units)
        VALUES ('RUN-B-006','LOT-B-006','EQ-ALIGN-B','MOD-ALIGN-B-R2',
            'REC-B-R2',?,?,100)`).run(at(8, '09:00:00'), at(8, '11:00:00'));
    db.prepare(`INSERT INTO aoi_inspections(id,lot_id,process_run_id,
        inspected_at,inspected_units,rejected_units)
        VALUES ('AOI-B-006','LOT-B-006','RUN-B-006',?,100,1)`)
        .run(at(8, '10:30:00'));
    db.prepare(`INSERT INTO aoi_defects(id,aoi_inspection_id,defect_code_id,
        defect_count,location)
        VALUES ('AOIDEF-B-006-TARGET','AOI-B-006','DEF-ALIGN',1,'synthetic')`).run();
    db.prepare(`INSERT INTO inspection_samples(id,lot_id,process_run_id,
        sampled_at,sample_size)
        VALUES ('SAMPLE-B-006','LOT-B-006','RUN-B-006',?,5)`)
        .run(at(8, '10:00:00'));
    for (let index = 1; index <= 5; index++) {
        db.prepare(`INSERT INTO measurements(id,inspection_sample_id,
            characteristic_id,value,unit,method,recorded_at)
            VALUES (?,'SAMPLE-B-006','CHAR-ALIGN-X',0.02,'mm',
                'synthetic vision gauge',?)`)
            .run(`MEAS-B-006-${String(index).padStart(2, '0')}`,
                at(8, '10:00:00'));
    }
}

function addSecondRevisionSource(db) {
    db.prepare(`INSERT INTO lots(id,product_family_id,code,quantity,start_at,end_at)
        SELECT 'LOT-B-007',product_family_id,'LOT-B-007',100,?,?
        FROM lots WHERE id='LOT-B-005'`).run(at(9, '08:00:00'), at(9, '12:00:00'));
    db.prepare(`INSERT INTO process_runs(id,lot_id,equipment_id,module_id,
        recipe_revision_id,start_at,end_at,processed_units)
        VALUES ('RUN-B-007','LOT-B-007','EQ-ALIGN-B','MOD-ALIGN-B-R2',
            'REC-B-R2',?,?,100)`).run(at(9, '09:00:00'), at(9, '11:00:00'));
    db.prepare(`INSERT INTO aoi_inspections(id,lot_id,process_run_id,
        inspected_at,inspected_units,rejected_units)
        VALUES ('AOI-B-007','LOT-B-007','RUN-B-007',?,100,0)`)
        .run(at(9, '10:30:00'));
    db.prepare(`INSERT INTO inspection_samples(id,lot_id,process_run_id,
        sampled_at,sample_size)
        VALUES ('SAMPLE-B-007','LOT-B-007','RUN-B-007',?,5)`)
        .run(at(9, '10:00:00'));
    for (let index = 1; index <= 5; index++) {
        db.prepare(`INSERT INTO measurements(id,inspection_sample_id,
            characteristic_id,value,unit,method,recorded_at)
            VALUES (?,'SAMPLE-B-007','CHAR-ALIGN-X',0.02,'mm',
                'synthetic vision gauge',?)`)
            .run(`MEAS-B-007-${String(index).padStart(2, '0')}`,
                at(9, '10:00:00'));
    }
}

test('L1 Line B module transition reaches monitored closure through local HTTP', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-l1-monitor-'));
    const filename = join(directory, 'monitor.sqlite');
    const db = openDatabase(filename);
    let server;
    let serverClock = at(8, '00:00:00');
    try {
        seedDatabase(db, { instanceId: 'DATASET-L1-CONTRAST' });
        const created = createChange(db, {
            id: changeId, title: 'Synthetic single-module alignment update',
            actorId: 'ACT-MFG', lineId: 'LINE-B', equipmentId: 'EQ-ALIGN-B',
            moduleId: 'MOD-ALIGN-B-R2', recipeRevisionId: 'REC-B-R2',
            baselineRef: 'AOI-B-002', reason: 'Compare new module with prior module source',
            at: at(4, '13:00:00')
        });
        assert.equal(created.state, 'Draft');
        db.prepare(`INSERT INTO equipment_events(id,equipment_id,module_id,
            event_type,occurred_at,duration_seconds)
            VALUES (?,?,?,?,?,?)`).run('EV-B-BACKDATED-MODULE', 'EQ-ALIGN-B',
            'MOD-ALIGN-B-R2', 'module-change', at(4, '14:00:00'), 0);
        submitChange(db, { changeId, expectedRevisionNo: 1,
            actorId: 'ACT-MFG', at: at(4, '13:10:00') });
        const risk = classifyChange(db, { changeId, expectedRevisionNo: 1,
            actorId: 'ACT-Q1', assessmentId: 'RISK-L1-CONTRAST',
            riskInputs: {
                severity: 1, occurrence: 1, detectability: 1, scope: 1,
                criticalCharacteristic: false, safetyRelevance: false,
                bases: {
                    severity: 'Synthetic local rework only',
                    occurrence: 'Synthetic baseline below one percent',
                    detectability: 'Full AOI screen before release',
                    scope: 'One equipment module',
                    criticalCharacteristic: 'No critical characteristic in this contrast',
                    safetyRelevance: 'No synthetic safety relevance'
                }
            }, at: at(4, '13:20:00') });
        assert.equal(risk.computedLevel, 'L1');
        const plan = approvePlan(db, { changeId, expectedRevisionNo: 1,
            actorId: 'ACT-Q1', planId: 'PLAN-L1-CONTRAST',
            at: at(4, '13:30:00') });
        assert.equal(plan.defaults.baselineLots, 1);
        assert.equal(plan.defaults.postChangeLots, 1);
        startVerification(db, { changeId, expectedRevisionNo: 1,
            actorId: 'ACT-VER', at: at(5, '07:00:00') });
        const baseline = recordBaselineSet(db, { changeId, expectedRevisionNo: 1,
            actorId: 'ACT-VER', evidenceId: 'BASE-L1-CONTRAST',
            at: at(5, '07:01:00') });
        assert.deepEqual(baseline.lotIds, ['LOT-B-002']);
        assert.equal(baseline.sampledUnits, 5);
        assert.equal(baseline.inspectedUnits, 100);
        const createdAudit = db.prepare(`SELECT payload_json FROM audit_events
            WHERE entity_type='change' AND entity_id=? AND action='change-created'`).get(changeId);
        assert.equal(JSON.parse(createdAudit.payload_json).baselineModuleId, 'MOD-ALIGN-B');
        assert.equal(JSON.parse(createdAudit.payload_json).moduleTransitionEventId,
            'EV-B-MODULE');
        const storedBaseline = db.prepare('SELECT payload_json FROM evidence_items WHERE id=?')
            .get('BASE-L1-CONTRAST');
        assert.equal(JSON.parse(storedBaseline.payload_json).moduleTransitionEventId,
            'EV-B-MODULE');
        const base = { changeId, expectedRevisionNo: 1, actorId: 'ACT-VER' };
        for (let unit = 1; unit <= 5; unit++) {
            const suffix = String(unit).padStart(2, '0');
            addMeasurementEvidence(db, { ...base,
                evidenceId: `EVID-L1-MEAS-${suffix}`,
                measurementId: `MEAS-B-003-${suffix}`,
                at: at(5, '11:10:00') });
        }
        addAoiEvidence(db, { ...base, evidenceId: 'EVID-L1-AOI',
            inspectionId: 'AOI-B-003', at: at(5, '11:20:00') });
        assert.equal(recordAlignmentResult(db, { ...base,
            resultId: 'RESULT-L1-ALIGN', evidenceId: 'EVID-L1-MEAS-05',
            at: at(5, '12:01:00') }).passed, true);
        assert.equal(recordAoiResults(db, { ...base,
            resultPrefix: 'RESULT-L1-AOI', at: at(5, '12:02:00') }).passed,
        true);
        assert.equal(markEvidenceReady(db, { ...base,
            at: at(5, '12:03:00') }).state, 'Evidence Ready');
        beginIndependentReview(db, { changeId, expectedRevisionNo: 1,
            actorId: 'ACT-REV', at: at(5, '12:04:00') });
        recordIndependentReview(db, { changeId, expectedRevisionNo: 1,
            actorId: 'ACT-REV', reviewId: 'REVIEW-L1-CONTRAST',
            decision: 'Pass', reason: 'Independent source review',
            at: at(5, '12:05:00') });
        assert.equal(acceptChange(db, { changeId, expectedRevisionNo: 1,
            actorId: 'ACT-APP', acceptanceId: 'ACCEPT-L1-CONTRAST',
            reviewId: 'REVIEW-L1-CONTRAST', acceptanceType: 'Ordinary',
            reason: 'Synthetic L1 source set passed',
            at: at(5, '12:06:00') }).state, 'Accepted');
        assert.equal(db.prepare('SELECT state FROM changes WHERE id=?').get(changeId).state,
            'Accepted');
        server = createLocalServer(db, {
            assetsDir: fileURLToPath(new URL('../assets/ui/', import.meta.url)),
            clock: () => serverClock
        });
        const local = await listenLocal(server, 0);
        const action = async (name, input, expectedStatus = 200) => {
            const response = await fetch(`${local.url}/api/actions`, {
                method: 'POST', headers: { 'content-type': 'application/json',
                    'x-fabassure-local': '1', origin: local.url },
                body: JSON.stringify({ action: name, input }) });
            const body = await response.json();
            assert.equal(response.status, expectedStatus,
                `${name}: ${JSON.stringify(body)}`);
            return body.result;
        };
        const early = await action('evaluateChangeEffectiveness', {
            changeId, expectedRevisionNo: 1, id: 'EFF-L1-EARLY',
            actorId: 'ACT-Q1', at: at(6, '12:30:00')
        });
        assert.equal(early.status, 'Monitoring');
        assert.equal(early.lotCount, 1);
        assert.deepEqual(early.lotIds, ['LOT-B-004']);
        assert.equal(db.prepare('SELECT state FROM changes WHERE id=?').get(changeId).state,
            'Effectiveness Monitoring');
        const auditAfterEarly = db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        await action('closeChangeMonitoring', {
            changeId, expectedRevisionNo: 1, id: 'CLOSE-L1-TOO-EARLY',
            checkId: 'EFF-L1-EARLY', actorId: 'ACT-APP',
            reason: 'One lot is insufficient', at: at(6, '12:31:00')
        }, 409);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,
            auditAfterEarly);
        const passed = await action('evaluateChangeEffectiveness', {
            changeId, expectedRevisionNo: 1, id: 'EFF-L1-PASS',
            actorId: 'ACT-Q1', at: at(7, '12:30:00')
        });
        assert.equal(passed.status, 'Pass');
        assert.equal(passed.lotCount, 2);
        assert.deepEqual(passed.lotIds, ['LOT-B-004', 'LOT-B-005']);
        await action('closeChangeMonitoring', {
            changeId, expectedRevisionNo: 1, id: 'CLOSE-L1-SAME-ACTOR',
            checkId: 'EFF-L1-PASS', actorId: 'ACT-Q1',
            reason: 'Evaluator cannot close own check', at: at(7, '12:31:00')
        }, 409);
        const close = await action('closeChangeMonitoring', {
            changeId, expectedRevisionNo: 1, id: 'CLOSE-L1-CONTRAST',
            checkId: 'EFF-L1-PASS', actorId: 'ACT-APP',
            reason: 'Two later synthetic lots meet the L1 criteria',
            at: at(7, '12:31:00')
        });
        assert.equal(close.state, 'Closed');
        assert.equal(db.prepare('SELECT state FROM changes WHERE id=?').get(changeId).state,
            'Closed');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM effectiveness_checks WHERE change_revision_id=?')
            .get(`${changeId}-R1`).n, 2);
        const auditBefore = db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        await action('evaluateChangeEffectiveness', {
            changeId, expectedRevisionNo: 1, id: 'EFF-L1-FUTURE',
            actorId: 'ACT-Q1', at: at(8, '01:00:00'),
            serverNow: at(9, '00:00:00')
        }, 409);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,
            auditBefore);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM effectiveness_checks WHERE id='EFF-L1-FUTURE'")
            .get().n, 0);
        const detailResponse = await fetch(`${local.url}/api/changes/${changeId}`);
        assert.equal(detailResponse.status, 200);
        const detail = await detailResponse.json();
        assert.equal(detail.revisions[0].effectivenessChecks.length, 2);
        assert.throws(() => db.prepare(`INSERT INTO equipment_events
            (id,equipment_id,module_id,event_type,occurred_at,duration_seconds)
            VALUES ('EV-L1-BACKDATED','EQ-ALIGN-B','MOD-ALIGN-B-R2',
                'alarm',?,0)`).run(at(6, '09:00:00')),
        /saved Change effectiveness|backdated Change/i);
        assert.throws(() => db.prepare(`INSERT INTO aoi_defects
            (id,aoi_inspection_id,defect_code_id,defect_count,location)
            VALUES ('AOIDEF-L1-LATE-ZERO','AOI-B-004','DEF-ALIGN',0,'synthetic')`)
            .run(), /saved Change effectiveness|backdated Change/i);
        addLaterTargetRecurrence(db);
        serverClock = at(9, '00:00:00');
        const failed = await action('evaluateChangeEffectiveness', {
            changeId, expectedRevisionNo: 1, id: 'EFF-L1-RECURRENCE',
            actorId: 'ACT-Q1', at: at(8, '12:30:00')
        });
        assert.equal(failed.status, 'Reopen Required');
        assert.equal(failed.lotCount, 3);
        assert.equal(db.prepare('SELECT state FROM changes WHERE id=?').get(changeId).state,
            'Closed');
        const reopened = await action('reopenChangeMonitoring', {
            changeId, expectedRevisionNo: 1, id: 'REOPEN-L1-CONTRAST',
            checkId: 'EFF-L1-RECURRENCE', actorId: 'ACT-Q1',
            recurrenceAoiDefectId: 'AOIDEF-B-006-TARGET',
            reason: 'Later same-code synthetic AOI recurrence',
            at: at(8, '12:31:00')
        });
        assert.equal(reopened.state, 'Reopened');
        assert.equal(reopened.nextCycleNo, 2);
        assert.equal(db.prepare('SELECT state FROM changes WHERE id=?').get(changeId).state,
            'Reopened');
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit_events
            WHERE entity_id=? AND action='change-monitoring-closed'`).get(changeId).n,
        1);
        const priorAcceptance = db.prepare('SELECT * FROM acceptances WHERE id=?')
            .get('ACCEPT-L1-CONTRAST');
        const priorClose = db.prepare(`SELECT id,digest FROM audit_events
            WHERE entity_id=? AND action='change-monitoring-closed'`).get(changeId);
        const revision = await action('reviseFailedEffectivenessChange', {
            changeId, expectedRevisionNo: 1, actorId: 'ACT-MFG',
            reason: 'Preserve failed monitoring and start a new controlled revision',
            at: at(8, '12:32:00')
        });
        assert.equal(revision.revisionNo, 2);
        assert.equal(revision.state, 'Draft');
        assert.deepEqual(db.prepare('SELECT * FROM acceptances WHERE id=?')
            .get('ACCEPT-L1-CONTRAST'), priorAcceptance);
        assert.deepEqual(db.prepare(`SELECT id,digest FROM audit_events
            WHERE entity_id=? AND action='change-monitoring-closed'`).get(changeId),
        priorClose);
        assert.equal(db.prepare('SELECT state FROM changes WHERE id=?').get(changeId).state,
            'Draft');
        addSecondRevisionSource(db);
        submitChange(db, { changeId, expectedRevisionNo: 2,
            actorId: 'ACT-MFG', at: at(8, '12:33:00') });
        const secondRisk = classifyChange(db, {
            changeId, expectedRevisionNo: 2, actorId: 'ACT-Q1',
            assessmentId: 'RISK-L1-CONTRAST-R2',
            riskInputs: {
                severity: 1, occurrence: 1, detectability: 1, scope: 1,
                criticalCharacteristic: false, safetyRelevance: false,
                bases: {
                    severity: 'Synthetic local rework only',
                    occurrence: 'Synthetic baseline below one percent',
                    detectability: 'Full AOI screen before release',
                    scope: 'One equipment module',
                    criticalCharacteristic: 'No critical characteristic in this contrast',
                    safetyRelevance: 'No synthetic safety relevance'
                }
            }, at: at(8, '12:34:00')
        });
        assert.equal(secondRisk.computedLevel, 'L1');
        approvePlan(db, { changeId, expectedRevisionNo: 2,
            actorId: 'ACT-Q1', planId: 'PLAN-L1-CONTRAST-R2',
            at: at(8, '12:35:00') });
        startVerification(db, { changeId, expectedRevisionNo: 2,
            actorId: 'ACT-VER', at: at(9, '07:00:00') });
        const secondBaseline = recordBaselineSet(db, {
            changeId, expectedRevisionNo: 2, actorId: 'ACT-VER',
            evidenceId: 'BASE-L1-CONTRAST-R2', at: at(9, '07:01:00')
        });
        assert.deepEqual(secondBaseline.lotIds, ['LOT-B-002']);
        const secondBase = { changeId, expectedRevisionNo: 2,
            actorId: 'ACT-VER' };
        for (let unit = 1; unit <= 5; unit++) {
            const suffix = String(unit).padStart(2, '0');
            addMeasurementEvidence(db, { ...secondBase,
                evidenceId: `EVID-L1-R2-MEAS-${suffix}`,
                measurementId: `MEAS-B-007-${suffix}`,
                at: at(9, '11:10:00') });
        }
        addAoiEvidence(db, { ...secondBase,
            evidenceId: 'EVID-L1-R2-AOI', inspectionId: 'AOI-B-007',
            at: at(9, '11:20:00') });
        assert.equal(recordAlignmentResult(db, { ...secondBase,
            resultId: 'RESULT-L1-R2-ALIGN',
            evidenceId: 'EVID-L1-R2-MEAS-05',
            at: at(9, '12:01:00') }).passed, true);
        assert.equal(recordAoiResults(db, { ...secondBase,
            resultPrefix: 'RESULT-L1-R2-AOI',
            at: at(9, '12:02:00') }).passed, true);
        assert.equal(markEvidenceReady(db, { ...secondBase,
            at: at(9, '12:03:00') }).state, 'Evidence Ready');
        beginIndependentReview(db, { changeId, expectedRevisionNo: 2,
            actorId: 'ACT-REV', at: at(9, '12:04:00') });
        recordIndependentReview(db, { changeId, expectedRevisionNo: 2,
            actorId: 'ACT-REV', reviewId: 'REVIEW-L1-CONTRAST-R2',
            decision: 'Pass', reason: 'Independent R2 source review',
            at: at(9, '12:05:00') });
        assert.equal(acceptChange(db, { changeId, expectedRevisionNo: 2,
            actorId: 'ACT-APP', acceptanceId: 'ACCEPT-L1-CONTRAST-R2',
            reviewId: 'REVIEW-L1-CONTRAST-R2', acceptanceType: 'Ordinary',
            reason: 'Synthetic second revision source set passed',
            at: at(9, '12:06:00') }).state, 'Accepted');
        assert.deepEqual(db.prepare('SELECT * FROM acceptances WHERE id=?')
            .get('ACCEPT-L1-CONTRAST'), priorAcceptance);
        const auditCount = db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        if (server?.listening) await new Promise((resolve, reject) =>
            server.close(error => error ? reject(error) : resolve()));
        db.close();
        // Model a populated v7 file, including saved R1 checks, before the v8 upgrade.
        const v7 = new DatabaseSync(filename);
        try {
            v7.exec('BEGIN IMMEDIATE');
            const oldSql = readFileSync(new URL('../src/data/schema-v7.sql', import.meta.url),
                'utf8');
            for (const name of ['change_run_after_effectiveness_guard',
                'change_aoi_after_effectiveness_guard',
                'change_aoi_defect_after_effectiveness_guard',
                'change_sample_after_effectiveness_guard',
                'change_measurement_after_effectiveness_guard']) {
                v7.exec(`DROP TRIGGER ${name}`);
                const definition = oldSql.match(new RegExp(
                    `CREATE TRIGGER ${name}[^]*?END;`))?.[0];
                assert.ok(definition, name);
                v7.exec(definition);
            }
            v7.exec(`DROP TRIGGER incident_cycle_latest_check_guard;
                DROP TRIGGER incident_cycle_check_audit_guard;
                DROP VIEW change_revision_frozen_scope`);
            const guard = v7.prepare(`SELECT sql FROM sqlite_master
                WHERE name='immutable_migration_delete'`).get().sql;
            v7.exec('DROP TRIGGER immutable_migration_delete');
            v7.prepare("DELETE FROM schema_migrations WHERE id='MIG-009'").run();
            v7.prepare("DELETE FROM schema_migrations WHERE id='MIG-008'").run();
            v7.exec(guard);
            v7.exec('PRAGMA user_version=7; COMMIT');
            assert.equal(v7.prepare(`SELECT COUNT(*) AS n FROM effectiveness_checks
                WHERE change_revision_id=?`).get(`${changeId}-R1`).n, 3);
        } finally {
            if (v7.isTransaction) v7.exec('ROLLBACK');
            v7.close();
        }
        const reopenedDb = openDatabase(filename);
        try {
            assert.doesNotThrow(() => assertDataIntegrity(reopenedDb));
            assert.equal(reopenedDb.prepare('PRAGMA user_version').get().user_version, 9);
            assert.equal(reopenedDb.prepare(`SELECT COUNT(*) AS n FROM schema_migrations
                WHERE id='MIG-008'`).get().n, 1);
            assert.equal(reopenedDb.prepare('SELECT state FROM changes WHERE id=?')
                .get(changeId).state, 'Accepted');
            assert.equal(reopenedDb.prepare(`SELECT COUNT(*) AS n FROM effectiveness_checks
                WHERE change_revision_id=?`).get(`${changeId}-R1`).n, 3);
            assert.equal(reopenedDb.prepare(`SELECT COUNT(*) AS n FROM acceptances
                WHERE change_revision_id=?`).get(`${changeId}-R2`).n, 1);
            assert.equal(reopenedDb.prepare('SELECT COUNT(*) AS n FROM audit_events')
                .get().n, auditCount);
            assert.deepEqual(reopenedDb.prepare('SELECT * FROM acceptances WHERE id=?')
                .get('ACCEPT-L1-CONTRAST'), priorAcceptance);
        } finally { reopenedDb.close(); }
    } finally {
        if (server?.listening) await new Promise((resolve, reject) =>
            server.close(error => error ? reject(error) : resolve()));
        db.close();
        const withinTemp = relative(resolve(tmpdir()), resolve(directory));
        assert.ok(withinTemp && !withinTemp.startsWith('..'));
        rmSync(directory, { recursive: true, force: true });
    }
});

test('L1 module baseline cannot borrow an unrelated or already elapsed transition', () => {
    const db = openDatabase(':memory:');
    try {
        seedDatabase(db, { instanceId: 'DATASET-L1-SCOPE-NEGATIVE' });
        db.prepare(`INSERT INTO modules(id,equipment_id,code,name)
            VALUES ('MOD-ALIGN-B-NO-EVENT','EQ-ALIGN-B','ALIGN-NO-EVENT',
                'Synthetic unrelated alignment module')`).run();
        const proposal = (id, moduleId, baselineRef, time) => ({
            id, title: 'Synthetic module baseline scope negative', actorId: 'ACT-MFG',
            lineId: 'LINE-B', equipmentId: 'EQ-ALIGN-B', moduleId,
            recipeRevisionId: 'REC-B-R2', baselineRef,
            reason: 'Prove module transition source is required', at: time
        });
        const auditBefore = db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        assert.throws(() => createChange(db, proposal('CHG-L1-NO-EVENT',
            'MOD-ALIGN-B-NO-EVENT', 'AOI-B-002', at(4, '13:00:00'))),
        /target-module change event/i);
        assert.throws(() => createChange(db, proposal('CHG-L1-WRONG-EQUIPMENT',
            'MOD-ALIGN-B-R2', 'AOI-A-002', at(4, '13:00:00'))),
        /equipment scope/i);
        assert.throws(() => createChange(db, proposal('CHG-L1-ELAPSED-EVENT',
            'MOD-ALIGN-B-R2', 'AOI-B-002', at(5, '00:01:00'))),
        /target-module change event/i);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,
            auditBefore);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM changes WHERE id LIKE 'CHG-L1-%'")
            .get().n, 0);
    } finally {
        db.close();
    }
});

test('a direct SQL Change effectiveness check without source audit fails integrity', () => {
    const db = openDatabase(':memory:');
    try {
        seedDatabase(db, { instanceId: 'DATASET-L1-CHECK-FORGERY' });
        createChange(db, {
            id: 'CHG-L1-FORGED-CHECK', title: 'Synthetic forged monitor row',
            actorId: 'ACT-MFG', lineId: 'LINE-B', equipmentId: 'EQ-ALIGN-B',
            moduleId: 'MOD-ALIGN-B-R2', recipeRevisionId: 'REC-B-R2',
            baselineRef: 'AOI-B-002', reason: 'Test source audit integrity',
            at: at(4, '13:00:00')
        });
        db.prepare(`INSERT INTO effectiveness_checks(id,change_revision_id,
            window_start,window_end,lot_count,passed,reason,recorded_by,recorded_at)
            VALUES (?,?,?,?,?,?,?,?,?)`).run('EFF-L1-FORGED',
            'CHG-L1-FORGED-CHECK-R1', at(4, '13:00:00'),
            at(7, '12:30:00'), 2, 1, 'Forged synthetic Pass', 'ACT-Q1',
            at(7, '12:30:00'));
        assert.throws(() => assertDataIntegrity(db), /Change effectiveness/i);
    } finally { db.close(); }
});
