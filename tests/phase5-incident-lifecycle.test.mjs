import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openDatabase, assertDataIntegrity } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { createIncident, containIncident, recordIncidentLkg,
    proposeIncidentTrace, reviewIncidentScope } from '../src/domain/incident-service.mjs';
import { startIncidentCapa, assessIncidentCause, planCapaAction,
    reviewCapaAction } from '../src/domain/capa-service.mjs';
import { proposeDocumentFeedback, reviewDocumentFeedback,
    approveDocumentRevision } from '../src/domain/document-service.mjs';
import { evaluateIncidentEffectiveness, closeIncidentCycle,
    reopenIncidentCycle } from '../src/domain/incident-effectiveness-service.mjs';
import { createLocalServer, listenLocal } from '../src/server/http.mjs';

const incidentId = 'INC-P5-LIFECYCLE';
const at = (day, hour = 10) => `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

function sourceLot(db, suffix, day, { defect = false } = {}) {
    const date = typeof day === 'number' ?
        `2026-09-${String(day).padStart(2, '0')}` : day;
    const lot = `LOT-P5-${suffix}`;
    const run = `RUN-P5-${suffix}`;
    const aoi = `AOI-P5-${suffix}`;
    const start = `${date}T08:00:00.000Z`;
    const end = `${date}T09:00:00.000Z`;
    db.prepare(`INSERT INTO lots(id,product_family_id,code,quantity,start_at,end_at)
        SELECT ?,product_family_id,?,100,?,? FROM lots WHERE id='LOT-A-026'`)
        .run(lot, lot, start, end);
    db.prepare(`INSERT INTO process_runs(id,lot_id,equipment_id,module_id,
        recipe_revision_id,start_at,end_at,processed_units) VALUES (?,?,?,?,?,?,?,100)`)
        .run(run, lot, 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'REC-ALIGN-R3', start, end);
    db.prepare(`INSERT INTO aoi_inspections(id,lot_id,process_run_id,
        inspected_at,inspected_units,rejected_units) VALUES (?,?,?,?,100,?)`)
        .run(aoi, lot, run, `${date}T08:30:00.000Z`, defect ? 1 : 0);
    if (defect) db.prepare(`INSERT INTO aoi_defects(id,aoi_inspection_id,
        defect_code_id,defect_count,location) VALUES (?,?,?,1,'synthetic')`)
        .run(`DEFECT-P5-${suffix}`, aoi, 'DEF-FIDUCIAL');
    return { lot, run, aoi, defectId: defect ? `DEFECT-P5-${suffix}` : null };
}

function initialCapa(db) {
    seedDatabase(db, { instanceId: 'DATASET-P5-LIFECYCLE' });
    createIncident(db, { id: incidentId, title: 'Synthetic post-service vision issue',
        actorId: 'ACT-Q1', defectCodeId: 'DEF-FIDUCIAL',
        detectionEventId: 'EV-DETECTION', observedLotId: 'LOT-A-026',
        recipeRevisionId: 'REC-ALIGN-R3',
        detectedAt: '2026-08-27T10:00:00.000Z', at: '2026-08-27T10:02:00.000Z' });
    containIncident(db, { incidentId, expectedRevisionNo: 1, actorId: 'ACT-PROD',
        ownerActorId: 'ACT-PROD', heldLotIds: ['LOT-A-025', 'LOT-A-026'],
        reason: 'Synthetic lot hold', at: '2026-08-27T10:04:00.000Z' });
    recordIncidentLkg(db, { incidentId, expectedRevisionNo: 1, actorId: 'ACT-Q1',
        aoiInspectionId: 'AOI-A-025', earliestPossibleAt: '2026-08-25T08:00:00.000Z',
        latestPossibleAt: '2026-08-25T12:00:00.000Z', method: 'Synthetic AOI screen',
        sampleScope: '100 inspected units', limitation: 'Intermediate units uncertain',
        at: '2026-08-27T10:06:00.000Z' });
    const proposal = proposeIncidentTrace(db, { incidentId, expectedRevisionNo: 1,
        actorId: 'ACT-Q1', at: '2026-08-27T10:08:00.000Z' });
    reviewIncidentScope(db, { incidentId, expectedRevisionNo: 1,
        proposalId: proposal.proposalId, actorId: 'ACT-REV', decision: 'Pass',
        reason: 'Independent synthetic scope review',
        lotDecisions: proposal.lots.map(lot => ({ lotId: lot.lotId,
            scopeStatus: lot.classification === 'excluded' ? 'excluded' : 'included',
            containment: lot.classification === 'excluded' ? 'No Change' : 'Held',
            reason: 'Synthetic disposition' })),
        at: '2026-08-27T10:10:00.000Z' });
    startIncidentCapa(db, { incidentId, expectedRevisionNo: 1, actorId: 'ACT-Q1',
        reason: 'Reviewed scope warrants CAPA', at: '2026-08-27T10:11:00.000Z' });
    assessIncidentCause(db, { incidentId, expectedRevisionNo: 1,
        cycleId: `${incidentId}-CYC-1`, id: 'CAUSE-P5-1', actorId: 'ACT-Q1',
        status: 'Confirmed', statement: 'Synthetic fixture shift',
        evidenceKind: 'equipment-event', evidenceId: 'EV-DETECTION',
        at: '2026-08-27T10:13:00.000Z' });
    for (const [index, kind, owner, evidence] of [
        [0, 'Corrective', 'ACT-EQP', 'AOI-A-028'],
        [1, 'Preventive', 'ACT-MFG', 'AOI-A-030']
    ]) {
        const actionId = `ACTION-P5-${kind.toUpperCase()}`;
        planCapaAction(db, { incidentId, expectedRevisionNo: 1,
            cycleId: `${incidentId}-CYC-1`, id: actionId, actorId: 'ACT-Q1',
            ownerActorId: owner, causeId: 'CAUSE-P5-1', actionType: kind,
            actionText: `Synthetic ${kind} action`, dueAt: '2026-09-01T00:00:00.000Z',
            at: `2026-08-27T10:${14 + index}:00.000Z` });
    }
    for (const [index, kind, , evidence] of [
        [0, 'Corrective', 'ACT-EQP', 'AOI-A-028'],
        [1, 'Preventive', 'ACT-MFG', 'AOI-A-030']
    ]) {
        const actionId = `ACTION-P5-${kind.toUpperCase()}`;
        reviewCapaAction(db, { incidentId, expectedRevisionNo: 1,
            cycleId: `${incidentId}-CYC-1`, actionId, actorId: 'ACT-REV',
            decision: 'Pass', evidenceKind: 'aoi-inspection', evidenceId: evidence,
            reason: `Independent ${kind} review`,
            at: index === 0 ? '2026-09-10T10:00:00.000Z' :
                '2026-09-10T11:00:00.000Z' });
    }
    for (const [index, doc] of ['DOC-CAM-PFMEA', 'DOC-CAM-CP', 'DOC-CAM-WI'].entries()) {
        const feedbackId = `FB-P5-${index + 1}`;
        proposeDocumentFeedback(db, { incidentId, expectedRevisionNo: 1,
            cycleId: `${incidentId}-CYC-1`, id: feedbackId, documentId: doc,
            baseRevisionId: `${doc}-R1`, capaActionId: 'ACTION-P5-PREVENTIVE',
            actorId: 'ACT-Q1', proposedSummary: `Synthetic ${doc} prevention update`,
            at: `2026-09-10T${12 + index * 3}:00:00.000Z` });
        reviewDocumentFeedback(db, { incidentId, expectedRevisionNo: 1,
            cycleId: `${incidentId}-CYC-1`, feedbackId, actorId: 'ACT-REV',
            decision: 'Pass', verificationKind: 'capa-review',
            verificationId: 'ACTION-P5-PREVENTIVE-REVIEW',
            reason: 'Independent synthetic feedback review',
            at: `2026-09-10T${13 + index * 3}:00:00.000Z` });
        approveDocumentRevision(db, { incidentId, expectedRevisionNo: 1,
            cycleId: `${incidentId}-CYC-1`, feedbackId, actorId: 'ACT-APP',
            reason: 'Separate synthetic document approval',
            at: `2026-09-10T${14 + index * 3}:00:00.000Z` });
    }
}

test('a later failed Incident check blocks an older Pass at domain and SQLite closure gates', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-p5-stale-pass-'));
    const path = join(directory, 'demo.sqlite');
    const db = openDatabase(path);
    try {
        initialCapa(db);
        const cycleId = `${incidentId}-CYC-1`;
        for (const [index, day] of [12, 14, 16, 18, 20].entries()) {
            sourceLot(db, `STALE-CLEAN-${index}`, day);
        }
        const pass = evaluateIncidentEffectiveness(db, { incidentId,
            expectedRevisionNo: 1, cycleId, id: 'EFF-P5-STALE-PASS',
            actorId: 'ACT-Q1', at: at(21) });
        assert.equal(pass.passed, true);
        sourceLot(db, 'STALE-RECURRENCE', 22, { defect: true });
        const fail = evaluateIncidentEffectiveness(db, { incidentId,
            expectedRevisionNo: 1, cycleId, id: 'EFF-P5-STALE-FAIL',
            actorId: 'ACT-Q1', at: at(23) });
        assert.equal(fail.passed, false);
        const beforeAudit = db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        assert.throws(() => closeIncidentCycle(db, { incidentId,
            expectedRevisionNo: 1, cycleId, checkId: pass.checkId,
            id: 'CLOSE-P5-STALE-DOMAIN', actorId: 'ACT-APP',
            reason: 'Older Pass must not close after failure', at: at(23, 11) }),
        /latest passing/i);
        assert.throws(() => db.prepare(`INSERT INTO incident_cycle_decisions
            (id,cycle_id,incident_id,decision,effectiveness_check_id,actor_id,reason,decided_at)
            VALUES ('CLOSE-P5-STALE-SQL',?,?,'Closed',?,'ACT-APP',?,?)`)
            .run(cycleId, incidentId, pass.checkId,
                'Direct SQL older Pass must not close', at(23, 11)), /latest|lineage/i);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM incident_cycle_decisions').get().n, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, beforeAudit);
        assert.equal(db.prepare('SELECT state FROM incidents WHERE id=?').get(incidentId).state,
            'Effectiveness Check');
        db.close();
        const old = new DatabaseSync(path);
        let preserved;
        try {
            old.exec('BEGIN IMMEDIATE');
            const migrationGuard = old.prepare(`SELECT sql FROM sqlite_master
                WHERE name='immutable_migration_delete'`).get().sql;
            old.exec(`DROP TRIGGER incident_cycle_latest_check_guard;
                DROP TRIGGER incident_cycle_check_audit_guard;
                DROP TRIGGER immutable_migration_delete`);
            old.prepare("DELETE FROM schema_migrations WHERE id='MIG-009'").run();
            old.exec(migrationGuard);
            old.exec('PRAGMA user_version=8');
            old.prepare(`INSERT INTO incident_cycle_decisions
                (id,cycle_id,incident_id,decision,effectiveness_check_id,actor_id,reason,decided_at)
                VALUES ('CLOSE-P5-LEGACY-STALE',?,?,'Closed',?,'ACT-APP',?,?)`)
                .run(cycleId, incidentId, pass.checkId,
                    'Historical v8 decision with stale Pass', at(23, 11));
            preserved = {
                closure: old.prepare(`SELECT * FROM incident_cycle_decisions
                    WHERE id='CLOSE-P5-LEGACY-STALE'`).get(),
                audits: old.prepare('SELECT id,digest,payload_json FROM audit_events ORDER BY sequence').all()
            };
            old.exec('COMMIT');
        } finally {
            if (old.isTransaction) old.exec('ROLLBACK');
            old.close();
        }
        assert.throws(() => openDatabase(path), /stale effectiveness check/i);
        const retained = new DatabaseSync(path);
        try {
            assert.deepEqual(retained.prepare(`SELECT * FROM incident_cycle_decisions
                WHERE id='CLOSE-P5-LEGACY-STALE'`).get(), preserved.closure);
            assert.deepEqual(retained.prepare(`SELECT id,digest,payload_json FROM audit_events
                ORDER BY sequence`).all(), preserved.audits);
            assert.equal(retained.prepare('PRAGMA user_version').get().user_version, 8);
        } finally { retained.close(); }
    } finally {
        db.close();
        const withinTemp = relative(resolve(tmpdir()), resolve(directory));
        assert.ok(withinTemp && !withinTemp.startsWith('..'));
        rmSync(directory, { recursive: true, force: true });
    }
});

test('unaudited direct SQL Incident check is rejected by integrity and restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-p5-unaudited-'));
    const path = join(directory, 'demo.sqlite');
    let db = openDatabase(path);
    try {
        initialCapa(db);
        const cycleId = `${incidentId}-CYC-1`;
        for (const [index, day] of [12, 14, 16, 18, 20].entries()) {
            sourceLot(db, `UNAUDITED-CLEAN-${index}`, day);
        }
        const pass = evaluateIncidentEffectiveness(db, { incidentId,
            expectedRevisionNo: 1, cycleId, id: 'EFF-P5-AUDITED-PASS',
            actorId: 'ACT-Q1', at: at(21) });
        assert.equal(pass.passed, true);
        db.prepare(`INSERT INTO incident_effectiveness_checks
            (id,cycle_id,incident_id,window_start,window_end,source_json,source_digest,
            lot_count,inspected_units,rejected_units,recurrence_count,unresolved_alarm_count,
            rule_version,passed,evaluated_by,evaluated_at)
            SELECT 'EFF-P5-UNAUDITED',cycle_id,incident_id,window_start,window_end,
                source_json,source_digest,lot_count,inspected_units,rejected_units,
                recurrence_count,unresolved_alarm_count,rule_version,passed,evaluated_by,?
            FROM incident_effectiveness_checks WHERE id=?`).run(at(21, 11), pass.checkId);
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit_events
            WHERE action='effectiveness-evaluated' AND
                json_extract(payload_json,'$.checkId')='EFF-P5-UNAUDITED'`).get().n, 0);
        assert.throws(() => db.prepare(`INSERT INTO incident_cycle_decisions
            (id,cycle_id,incident_id,decision,effectiveness_check_id,actor_id,reason,decided_at)
            VALUES ('CLOSE-P5-UNAUDITED-SQL',?,?,'Closed','EFF-P5-UNAUDITED',
                'ACT-APP','Unaudited direct SQL decision',?)`).run(cycleId, incidentId,
                at(21, 12)), /effectiveness audit/i);
        assert.throws(() => closeIncidentCycle(db, { incidentId,
            expectedRevisionNo: 1, cycleId, checkId: 'EFF-P5-UNAUDITED',
            id: 'CLOSE-P5-UNAUDITED-DOMAIN', actorId: 'ACT-APP',
            reason: 'Unaudited decision must fail', at: at(21, 12) }),
        /effectiveness audit/i);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM incident_cycle_decisions').get().n, 0);
        assert.throws(() => assertDataIntegrity(db), /incident effectiveness.*audit/i);
        db.close();
        db = null;
        assert.throws(() => openDatabase(path), /incident effectiveness.*audit/i);
    } finally {
        db?.close();
        const withinTemp = relative(resolve(tmpdir()), resolve(directory));
        assert.ok(withinTemp && !withinTemp.startsWith('..'));
        rmSync(directory, { recursive: true, force: true });
    }
});

test('source-derived checks block early closure and preserve closed history after recurrence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-p5-lifecycle-'));
    const path = join(directory, 'demo.sqlite');
    let db;
    try {
        db = openDatabase(path);
        initialCapa(db);
        const cycleId = `${incidentId}-CYC-1`;
        const initialAudits = db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        assert.throws(() => evaluateIncidentEffectiveness(db, { incidentId,
            expectedRevisionNo: 2, cycleId, id: 'EFF-P5-STALE',
            actorId: 'ACT-Q1', at: at(11) }), /stale/i);
        assert.throws(() => evaluateIncidentEffectiveness(db, { incidentId,
            expectedRevisionNo: 1, cycleId, id: 'EFF-P5-WRONG-ROLE',
            actorId: 'ACT-MFG', at: at(11) }), /actor/i);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,
            initialAudits);
        assert.throws(() => evaluateIncidentEffectiveness(db, { incidentId,
            expectedRevisionNo: 1, cycleId, id: 'EFF-P5-FUTURE',
            actorId: 'ACT-Q1', at: at(11), serverNow: at(10, 23) }),
        /server UTC time/i);
        const early = evaluateIncidentEffectiveness(db, { incidentId,
            expectedRevisionNo: 1, cycleId, id: 'EFF-P5-EARLY', actorId: 'ACT-Q1',
            at: at(11) });
        assert.equal(early.passed, false);
        assert.equal(early.state, 'Effectiveness Check');
        assert.match(early.gaps.join(' '), /later lots/);
        assert.throws(() => closeIncidentCycle(db, { incidentId,
            expectedRevisionNo: 1, cycleId, checkId: early.checkId,
            id: 'CLOSE-P5-EARLY', actorId: 'ACT-APP', reason: 'Premature',
            at: at(11, 11) }), /passing effectiveness/i);
        for (const [index, day] of [12, 14, 16, 18, 20].entries()) {
            sourceLot(db, `CLEAN-${index}`, day);
        }
        const pass = evaluateIncidentEffectiveness(db, { incidentId,
            expectedRevisionNo: 1, cycleId, id: 'EFF-P5-PASS', actorId: 'ACT-Q1',
            at: at(21) });
        assert.equal(pass.passed, true);
        assert.equal(pass.lotCount, 5);
        assert.equal(pass.inspectedUnits, 500);
        assert.equal(pass.recurrenceCount, 0);
        assert.throws(() => db.prepare(`INSERT INTO equipment_events
            (id,equipment_id,module_id,event_type,occurred_at,duration_seconds)
            VALUES ('EV-P5-LATE','EQ-ALIGN-A','MOD-ALIGN-A','alarm',
                '2026-09-16T09:30:00.000Z',60)`).run(), /saved effectiveness/i);
        assert.throws(() => db.prepare(`INSERT INTO aoi_defects
            (id,aoi_inspection_id,defect_code_id,defect_count,location)
            VALUES ('DEFECT-P5-LATE','AOI-P5-CLEAN-0','DEF-FIDUCIAL',1,
                'synthetic')`).run(), /saved effectiveness/i);
        db.prepare(`INSERT INTO aoi_defects
            (id,aoi_inspection_id,defect_code_id,defect_count,location)
            VALUES ('DEFECT-P5-ZERO','AOI-P5-CLEAN-0','DEF-FIDUCIAL',0,
                'synthetic zero-count source')`).run();
        assert.throws(() => closeIncidentCycle(db, { incidentId,
            expectedRevisionNo: 1, cycleId, checkId: pass.checkId,
            id: 'CLOSE-P5-FUTURE', actorId: 'ACT-APP', reason: 'Future closure',
            at: at(21, 11), serverNow: at(21) }), /server UTC time/i);
        assert.equal(db.prepare(`SELECT source_json FROM incident_effectiveness_checks
            WHERE id='EFF-P5-PASS'`).get().source_json,
        JSON.stringify({ lotIds: [0, 1, 2, 3, 4].map(index => `LOT-P5-CLEAN-${index}`) }));
        assert.throws(() => closeIncidentCycle(db, { incidentId,
            expectedRevisionNo: 1, cycleId, checkId: pass.checkId,
            id: 'CLOSE-P5-SELF', actorId: 'ACT-Q1', reason: 'Self approval',
            at: at(21, 11) }), /separate/i);
        const closed = closeIncidentCycle(db, { incidentId, expectedRevisionNo: 1,
            cycleId, checkId: pass.checkId, id: 'CLOSE-P5-1', actorId: 'ACT-APP',
            reason: 'Complete synthetic source and document review', at: at(21, 11) });
        assert.equal(closed.state, 'Closed');
        const frozen = {
            check: db.prepare(`SELECT * FROM incident_effectiveness_checks
                WHERE id='EFF-P5-PASS'`).get(),
            close: db.prepare(`SELECT * FROM incident_cycle_decisions
                WHERE id='CLOSE-P5-1'`).get()
        };
        assertDataIntegrity(db);
        db.close();
        db = openDatabase(path);
        assertDataIntegrity(db);
        const recurrence = sourceLot(db, 'RECURRENCE', 22, { defect: true });
        const failed = evaluateIncidentEffectiveness(db, { incidentId,
            expectedRevisionNo: 1, cycleId, id: 'EFF-P5-RECURRENCE',
            actorId: 'ACT-Q1', at: at(23) });
        assert.equal(failed.passed, false);
        assert.equal(failed.recurrenceCount, 1);
        assert.throws(() => reopenIncidentCycle(db, { incidentId,
            expectedRevisionNo: 1, cycleId, checkId: failed.checkId,
            recurrenceAoiDefectId: 'AOIDEF-A-027-1', id: 'REOPEN-P5-WRONG',
            actorId: 'ACT-Q1', reason: 'Wrong source', at: at(23, 11) }),
        /later linked/i);
        const reopened = reopenIncidentCycle(db, { incidentId,
            expectedRevisionNo: 1, cycleId, checkId: failed.checkId,
            recurrenceAoiDefectId: recurrence.defectId, id: 'REOPEN-P5-1',
            actorId: 'ACT-Q1', reason: 'Later same-code AOI recurrence',
            at: at(23, 11) });
        assert.equal(reopened.nextCycleNo, 2);
        const second = startIncidentCapa(db, { incidentId,
            expectedRevisionNo: 1, actorId: 'ACT-Q1',
            reason: 'Recurrence source opens a linked CAPA cycle',
            at: at(23, 12) });
        assert.equal(second.cycleNo, 2);
        assert.equal(db.prepare(`SELECT parent_cycle_id FROM incident_cycles
            WHERE id=?`).get(second.cycleId).parent_cycle_id, cycleId);
        assessIncidentCause(db, { incidentId, expectedRevisionNo: 1,
            cycleId: second.cycleId, id: 'CAUSE-P5-2', actorId: 'ACT-Q1',
            status: 'Confirmed', statement: 'Synthetic recurrence source reviewed',
            evidenceKind: 'aoi-defect', evidenceId: recurrence.defectId,
            at: at(23, 13) });
        for (const [index, kind, owner] of [
            [0, 'Corrective', 'ACT-EQP'], [1, 'Preventive', 'ACT-MFG']
        ]) {
            planCapaAction(db, { incidentId, expectedRevisionNo: 1,
                cycleId: second.cycleId, id: `ACTION-P5-2-${kind.toUpperCase()}`,
                actorId: 'ACT-Q1', ownerActorId: owner, causeId: 'CAUSE-P5-2',
                actionType: kind, actionText: `Second-cycle ${kind} action`,
                dueAt: '2026-10-01T00:00:00.000Z', at: at(23, 14 + index) });
        }
        const reviewSource = sourceLot(db, 'REVIEW-2', 24);
        for (const [index, kind] of ['Corrective', 'Preventive'].entries()) {
            reviewCapaAction(db, { incidentId, expectedRevisionNo: 1,
                cycleId: second.cycleId,
                actionId: `ACTION-P5-2-${kind.toUpperCase()}`,
                actorId: 'ACT-REV', decision: 'Pass',
                evidenceKind: 'aoi-inspection', evidenceId: reviewSource.aoi,
                reason: `Independent second-cycle ${kind} review`,
                at: at(24, 10 + index) });
        }
        for (const [index, doc] of ['DOC-CAM-PFMEA', 'DOC-CAM-CP', 'DOC-CAM-WI'].entries()) {
            const feedbackId = `FB-P5-2-${index + 1}`;
            proposeDocumentFeedback(db, { incidentId, expectedRevisionNo: 1,
                cycleId: second.cycleId, id: feedbackId, documentId: doc,
                baseRevisionId: `${doc}-R2`,
                capaActionId: 'ACTION-P5-2-PREVENTIVE', actorId: 'ACT-Q1',
                proposedSummary: `Second-cycle ${doc} update`,
                at: at(24, 12 + index * 3) });
            reviewDocumentFeedback(db, { incidentId, expectedRevisionNo: 1,
                cycleId: second.cycleId, feedbackId, actorId: 'ACT-REV',
                decision: 'Pass', verificationKind: 'capa-review',
                verificationId: 'ACTION-P5-2-PREVENTIVE-REVIEW',
                reason: 'Independent second-cycle feedback review',
                at: at(24, 13 + index * 3) });
            approveDocumentRevision(db, { incidentId, expectedRevisionNo: 1,
                cycleId: second.cycleId, feedbackId, actorId: 'ACT-APP',
                reason: 'Separate second-cycle document approval',
                at: at(24, 14 + index * 3) });
        }
        for (const [index, day] of [25, 27, 29, '2026-10-01', '2026-10-03'].entries()) {
            sourceLot(db, `SECOND-${index}`, day);
        }
        const secondPass = evaluateIncidentEffectiveness(db, { incidentId,
            expectedRevisionNo: 1, cycleId: second.cycleId,
            id: 'EFF-P5-SECOND-PASS', actorId: 'ACT-Q1',
            at: '2026-10-04T10:00:00.000Z',
            serverNow: '2026-10-04T10:00:00.000Z' });
        assert.equal(secondPass.passed, true);
        assert.equal(secondPass.lotCount, 5);
        const secondClose = closeIncidentCycle(db, { incidentId,
            expectedRevisionNo: 1, cycleId: second.cycleId,
            checkId: secondPass.checkId, id: 'CLOSE-P5-2', actorId: 'ACT-APP',
            reason: 'Second cycle has a new complete source window',
            at: '2026-10-04T11:00:00.000Z',
            serverNow: '2026-10-04T11:00:00.000Z' });
        assert.equal(secondClose.state, 'Closed');
        assert.deepEqual(db.prepare(`SELECT * FROM incident_effectiveness_checks
            WHERE id='EFF-P5-PASS'`).get(), frozen.check);
        assert.deepEqual(db.prepare(`SELECT * FROM incident_cycle_decisions
            WHERE id='CLOSE-P5-1'`).get(), frozen.close);
        assert.throws(() => db.prepare(`UPDATE incident_cycle_decisions
            SET reason='erased' WHERE id='CLOSE-P5-1'`).run(), /immutable/i);
        assertDataIntegrity(db);
    } finally {
        db?.close();
        const withinTemp = relative(resolve(tmpdir()), resolve(directory));
        assert.ok(withinTemp && !withinTemp.startsWith('..'));
        rmSync(directory, { recursive: true, force: true });
    }
});

test('backdated resolution cannot rewrite a saved unresolved-alarm result', () => {
    const db = openDatabase(':memory:');
    try {
        initialCapa(db);
        db.prepare(`INSERT INTO equipment_events
            (id,equipment_id,module_id,event_type,occurred_at,duration_seconds)
            VALUES ('EV-P5-OPEN','EQ-ALIGN-A','MOD-ALIGN-A','alarm',
                '2026-09-10T21:00:00.000Z',60)`).run();
        db.prepare(`INSERT INTO maintenance_actions
            (id,equipment_id,module_id,code,summary,start_at,end_at)
            VALUES ('MA-P5-OPEN','EQ-ALIGN-A','MOD-ALIGN-A','REPAIR',
                'Synthetic repair','2026-09-10T21:15:00.000Z',
                '2026-09-10T21:30:00.000Z')`).run();
        const check = evaluateIncidentEffectiveness(db, { incidentId,
            expectedRevisionNo: 1, cycleId: `${incidentId}-CYC-1`,
            id: 'EFF-P5-OPEN-ALARM', actorId: 'ACT-Q1', at: at(11) });
        assert.equal(check.unresolvedAlarmCount, 1);
        assert.throws(() => db.prepare(`INSERT INTO equipment_event_resolutions
            (id,equipment_event_id,maintenance_action_id,recorded_by,recorded_at)
            VALUES ('RES-P5-BACKDATED','EV-P5-OPEN','MA-P5-OPEN','ACT-EQP',
                '2026-09-10T21:31:00.000Z')`).run(), /saved effectiveness/i);
        db.prepare(`INSERT INTO equipment_event_resolutions
            (id,equipment_event_id,maintenance_action_id,recorded_by,recorded_at)
            VALUES ('RES-P5-LATER','EV-P5-OPEN','MA-P5-OPEN','ACT-EQP',
                '2026-09-11T11:00:00.000Z')`).run();
        assert.equal(db.prepare(`SELECT unresolved_alarm_count FROM
            incident_effectiveness_checks WHERE id='EFF-P5-OPEN-ALARM'`)
            .get().unresolved_alarm_count, 1);
        assertDataIntegrity(db);
    } finally {
        db.close();
    }
});

test('loopback HTTP action and detail expose a persisted monitoring result', async () => {
    const db = openDatabase(':memory:');
    let server;
    try {
        initialCapa(db);
        const assetsDir = fileURLToPath(new URL('../assets/ui/', import.meta.url));
        server = createLocalServer(db, { assetsDir });
        const local = await listenLocal(server, 0);
        const action = async (name, input) => {
            const response = await fetch(`${local.url}/api/actions`, {
                method: 'POST',
                headers: { 'content-type': 'application/json',
                    'x-fabassure-local': '1', origin: local.url },
                body: JSON.stringify({ action: name, input })
            });
            return { status: response.status, body: await response.json() };
        };
        const cycleId = `${incidentId}-CYC-1`;
        const first = await action('evaluateIncidentEffectiveness', { incidentId,
            expectedRevisionNo: 1, cycleId, id: 'EFF-P5-HTTP',
            actorId: 'ACT-Q1', at: at(11) });
        assert.equal(first.status, 200);
        assert.equal(first.body.result.passed, false);
        const detailResponse = await fetch(`${local.url}/api/incidents/${incidentId}`);
        assert.equal(detailResponse.status, 200);
        const detail = await detailResponse.json();
        assert.equal(detail.effectivenessChecks[0].id, 'EFF-P5-HTTP');
        assert.deepEqual(detail.effectivenessChecks[0].source, { lotIds: [] });
        const audits = db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        const denied = await action('closeIncidentCycle', { incidentId,
            expectedRevisionNo: 1, cycleId, checkId: 'EFF-P5-HTTP',
            id: 'CLOSE-P5-HTTP', actorId: 'ACT-APP', reason: 'Premature',
            at: at(11, 11) });
        assert.equal(denied.status, 409);
        assert.equal(denied.body.error.code, 'GATE_DENIED');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, audits);
    } finally {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        db.close();
    }
});
