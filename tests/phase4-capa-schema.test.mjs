import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertDataIntegrity, openDatabase, withValidatedTransaction } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { appendAuditEvent } from '../src/domain/audit.mjs';
import { createIncident, containIncident, recordIncidentLkg,
    proposeIncidentTrace, reviewIncidentScope } from '../src/domain/incident-service.mjs';

const at = minute => `2026-08-27T10:${String(minute).padStart(2, '0')}:00.000Z`;

function reviewedIncident(databasePath = ':memory:') {
    const db = openDatabase(databasePath);
    seedDatabase(db, { instanceId: 'DATASET-CAPA-SCHEMA' });
    createIncident(db, { id: 'INC-CAPA', title: 'Synthetic post-maintenance excursion',
        actorId: 'ACT-Q1', defectCodeId: 'DEF-FIDUCIAL', detectionEventId: 'EV-DETECTION',
        observedLotId: 'LOT-A-026', recipeRevisionId: 'REC-ALIGN-R3',
        detectedAt: at(0), at: at(2) });
    containIncident(db, { incidentId: 'INC-CAPA', expectedRevisionNo: 1,
        actorId: 'ACT-PROD', ownerActorId: 'ACT-PROD',
        heldLotIds: ['LOT-A-025', 'LOT-A-026', 'LOT-A-027'],
        reason: 'Synthetic containment', at: at(4) });
    recordIncidentLkg(db, { incidentId: 'INC-CAPA', expectedRevisionNo: 1,
        actorId: 'ACT-Q1', aoiInspectionId: 'AOI-A-025',
        earliestPossibleAt: '2026-08-25T08:00:00.000Z',
        latestPossibleAt: '2026-08-25T12:00:00.000Z',
        method: 'AOI source inspection', sampleScope: 'Synthetic lot',
        limitation: 'Intervening units remain uncertain', at: at(6) });
    const proposal = proposeIncidentTrace(db, { incidentId: 'INC-CAPA',
        expectedRevisionNo: 1, actorId: 'ACT-Q1', at: at(8) });
    const decisions = proposal.lots.map(lot => ({ lotId: lot.lotId,
        scopeStatus: lot.classification === 'excluded' ? 'excluded' :
            lot.classification === 'ambiguous' ? 'ambiguous' : 'included',
        containment: lot.classification === 'excluded' ? 'No Change' : 'Held',
        reason: `Synthetic ${lot.classification} disposition` }));
    const review = reviewIncidentScope(db, { incidentId: 'INC-CAPA',
        expectedRevisionNo: 1, proposalId: proposal.proposalId,
        actorId: 'ACT-REV', decision: 'Pass', reason: 'Reviewed source lot set',
        lotDecisions: decisions, at: at(10) });
    return { db, review };
}

test('v4 CAPA and document lineage applies additively with foreign keys', () => {
    const { db } = reviewedIncident();
    try {
        for (const name of ['incident_cycles', 'cause_assessments', 'capa_actions',
            'capa_action_reviews', 'controlled_documents', 'document_revisions',
            'feedback_actions', 'feedback_reviews', 'incident_effectiveness_checks',
            'incident_cycle_decisions', 'equipment_event_resolutions']) {
            assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?")
                .get(name).n, 1, name);
        }
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
        db.close();
    }
});

test('CAPA cause and action timestamps follow their supporting evidence', () => {
    const { db, review } = reviewedIncident();
    try {
        db.prepare(`INSERT INTO incident_cycles(id,incident_id,cycle_no,scope_review_id,
            opened_by,opened_at,reason) VALUES (?,?,?,?,?,?,?)`)
            .run('CYC-TIME', 'INC-CAPA', 1, review.reviewId, 'ACT-Q1', at(11),
                'Synthetic chronology test');
        const cause = db.prepare(`INSERT INTO cause_assessments(id,cycle_id,incident_id,
            status,statement,evidence_kind,evidence_id,assessed_by,assessed_at)
            VALUES (?,?,?,?,?,?,?,?,?)`);
        assert.throws(() => cause.run('CAUSE-BEFORE-CYCLE', 'CYC-TIME', 'INC-CAPA',
            'Confirmed', 'Backdated assessment', 'equipment-event', 'EV-DETECTION',
            'ACT-Q1', at(10)), /cause|evidence|chronology/i);
        assert.throws(() => cause.run('CAUSE-FUTURE-AOI', 'CYC-TIME', 'INC-CAPA',
            'Confirmed', 'Future AOI defect', 'aoi-defect', 'AOIDEF-A-027-1',
            'ACT-Q1', at(12)), /cause|evidence|chronology/i);
        db.prepare(`INSERT INTO equipment_events(id,equipment_id,module_id,event_type,
            occurred_at,duration_seconds) VALUES (?,?,?,?,?,?)`).run('EV-FUTURE-CAUSE',
                'EQ-ALIGN-A', 'MOD-ALIGN-A', 'alarm', '2026-08-28T09:00:00.000Z', 0);
        assert.throws(() => cause.run('CAUSE-FUTURE-EVENT', 'CYC-TIME', 'INC-CAPA',
            'Confirmed', 'Future alarm', 'equipment-event', 'EV-FUTURE-CAUSE',
            'ACT-Q1', at(12)), /cause|evidence|chronology/i);
        const priorProposalId = db.prepare('SELECT proposal_id FROM scope_reviews WHERE id=?')
            .get(review.reviewId).proposal_id;
        db.prepare(`INSERT INTO trace_proposals(id,incident_revision_id,proposer_actor_id,
            recipe_revision_id,lkg_observation_id,earliest_trace_at,cutoff_at,query_json,
            result_json,result_digest,proposed_at)
            SELECT 'TRACE-FUTURE',incident_revision_id,proposer_actor_id,
                recipe_revision_id,lkg_observation_id,earliest_trace_at,cutoff_at,query_json,
                result_json,result_digest,? FROM trace_proposals WHERE id=?`)
            .run(at(20), priorProposalId);
        db.prepare(`INSERT INTO trace_candidates(id,proposal_id,lot_id,classification,
            reason,details_json,targeted_defects,certain_interval_defects)
            SELECT 'CAND-FUTURE','TRACE-FUTURE',lot_id,classification,reason,
                details_json,targeted_defects,certain_interval_defects
            FROM trace_candidates WHERE proposal_id=? LIMIT 1`).run(priorProposalId);
        assert.throws(() => cause.run('CAUSE-FUTURE-TRACE', 'CYC-TIME', 'INC-CAPA',
            'Confirmed', 'Future trace candidate', 'trace-candidate', 'CAND-FUTURE',
            'ACT-Q1', at(12)), /cause|evidence|chronology/i);
        cause.run('CAUSE-TIME', 'CYC-TIME', 'INC-CAPA', 'Confirmed',
            'Synthetic fixture source', 'equipment-event', 'EV-DETECTION', 'ACT-Q1', at(13));
        const action = db.prepare(`INSERT INTO capa_actions(id,cycle_id,incident_id,
            cause_id,action_type,action_text,owner_actor_id,due_at,created_by,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`);
        assert.throws(() => action.run('CAPA-BEFORE-CAUSE', 'CYC-TIME', 'INC-CAPA',
            'CAUSE-TIME', 'Corrective', 'Synthetic backdated repair', 'ACT-EQP',
            '2026-08-29T10:00:00.000Z', 'ACT-Q1', at(12)), /cause|chronology|CAPA/i);
        action.run('CAPA-TIME', 'CYC-TIME', 'INC-CAPA', 'CAUSE-TIME', 'Corrective',
            'Synthetic ordered repair', 'ACT-EQP', '2026-08-29T10:00:00.000Z',
            'ACT-Q1', at(14));
        db.prepare(`INSERT INTO capa_action_reviews(id,action_id,reviewer_actor_id,
            decision,evidence_kind,evidence_id,reason,reviewed_at)
            VALUES (?,?,?,?,?,?,?,?)`).run('CAPA-TIME-REVIEW', 'CAPA-TIME', 'ACT-REV',
                'Needs Rework', 'aoi-inspection', 'AOI-A-028',
                'Synthetic rework evidence', '2026-08-29T10:00:00.000Z');
        const rework = db.prepare(`INSERT INTO capa_actions(id,cycle_id,incident_id,
            cause_id,action_type,action_text,owner_actor_id,due_at,created_by,created_at,
            parent_action_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
        assert.throws(() => rework.run('CAPA-EARLY-REWORK', 'CYC-TIME', 'INC-CAPA',
            'CAUSE-TIME', 'Corrective', 'Premature rework', 'ACT-EQP',
            '2026-09-02T00:00:00.000Z', 'ACT-Q1', '2026-08-28T11:00:00.000Z',
            'CAPA-TIME'), /CAPA|cause|rework/i);
        rework.run('CAPA-ORDERED-REWORK', 'CYC-TIME', 'INC-CAPA',
            'CAUSE-TIME', 'Corrective', 'Reviewed rework', 'ACT-EQP',
            '2026-09-02T00:00:00.000Z', 'ACT-Q1', '2026-08-29T11:00:00.000Z',
            'CAPA-TIME');
    } finally {
        db.close();
    }
});

test('direct SQL blocks unreviewed CAPA, wrong source, mutable history and premature closure', () => {
    const { db, review } = reviewedIncident();
    try {
        db.prepare(`INSERT INTO incident_cycles(id,incident_id,cycle_no,scope_review_id,
            opened_by,opened_at,reason) VALUES (?,?,?,?,?,?,?)`)
            .run('CYC-1', 'INC-CAPA', 1, review.reviewId, 'ACT-Q1', at(11), 'Reviewed scope');
        const wrongEvent = db.prepare("SELECT id FROM equipment_events WHERE equipment_id<>'EQ-ALIGN-A' LIMIT 1").get().id;
        const insertCause = db.prepare(`INSERT INTO cause_assessments(id,cycle_id,incident_id,
            status,statement,evidence_kind,evidence_id,assessed_by,assessed_at)
            VALUES (?,?,?,?,?,?,?,?,?)`);
        assert.throws(() => insertCause.run('CAUSE-WRONG', 'CYC-1', 'INC-CAPA', 'Confirmed',
            'Wrong equipment', 'equipment-event', wrongEvent, 'ACT-Q1', at(12)), /cause|source/i);
        insertCause.run('CAUSE-H', 'CYC-1', 'INC-CAPA', 'Hypothesis',
            'Maintenance may have shifted the fixture', 'equipment-event', 'EV-DETECTION',
            'ACT-Q1', at(12));
        const insertAction = db.prepare(`INSERT INTO capa_actions(id,cycle_id,incident_id,
            cause_id,action_type,action_text,owner_actor_id,due_at,created_by,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`);
        assert.throws(() => insertAction.run('CAPA-H', 'CYC-1', 'INC-CAPA', 'CAUSE-H',
            'Corrective', 'Inspect module', 'ACT-EQP', '2026-08-29T10:00:00.000Z',
            'ACT-Q1', at(13)), /confirmed|cause/i);
        insertCause.run('CAUSE-C', 'CYC-1', 'INC-CAPA', 'Confirmed',
            'Synthetic fixture shift confirmed by source', 'equipment-event', 'EV-DETECTION',
            'ACT-Q1', at(13));
        insertAction.run('CAPA-C', 'CYC-1', 'INC-CAPA', 'CAUSE-C', 'Corrective',
            'Adjust and verify fixture alignment', 'ACT-EQP',
            '2026-08-29T10:00:00.000Z', 'ACT-Q1', at(14));
        const insertReview = db.prepare(`INSERT INTO capa_action_reviews(id,action_id,
            reviewer_actor_id,decision,evidence_kind,evidence_id,reason,reviewed_at)
            VALUES (?,?,?,?,?,?,?,?)`);
        assert.throws(() => insertReview.run('CAPA-SAME', 'CAPA-C', 'ACT-Q1', 'Pass',
            'aoi-inspection', 'AOI-A-028', 'Self review', '2026-08-29T10:00:00.000Z'),
        /independent|review/i);
        assert.throws(() => insertReview.run('CAPA-OLD', 'CAPA-C', 'ACT-REV', 'Pass',
            'aoi-inspection', 'AOI-A-026', 'Old source', '2026-08-29T10:00:00.000Z'),
        /source|review/i);
        insertReview.run('CAPA-CR', 'CAPA-C', 'ACT-REV', 'Pass',
            'aoi-inspection', 'AOI-A-028', 'Synthetic source reviewed',
            '2026-08-29T10:00:00.000Z');
        assert.throws(() => db.prepare("UPDATE capa_actions SET action_text='erased' WHERE id='CAPA-C'").run(),
            /immutable/i);
        db.prepare(`INSERT INTO controlled_documents(id,doc_type,scope_equipment_id,
            defect_code_id,code,title) VALUES (?,?,?,?,?,?)`)
            .run('DOC-INVALID-APPROVER', 'PFMEA', 'EQ-ALIGN-B', 'DEF-ALIGN',
                'FA-INVALID', 'Synthetic unrelated approval probe');
        assert.throws(() => db.prepare(`INSERT INTO document_revisions(id,document_id,
            revision_no,summary,approved_by,approved_at) VALUES (?,?,?,?,?,?)`)
            .run('DOC-INVALID-R1', 'DOC-INVALID-APPROVER', 1, 'Unqualified baseline',
                'ACT-MFG', '2026-08-01T00:00:00.000Z'), /qualified|approver/i);
        db.prepare(`INSERT INTO feedback_actions(id,cycle_id,incident_id,capa_action_id,
            document_id,base_revision_id,proposed_summary,proposed_by,proposed_at)
            VALUES (?,?,?,?,?,?,?,?,?)`).run('FB-PFMEA', 'CYC-1', 'INC-CAPA', 'CAPA-C',
            'DOC-CAM-PFMEA', 'DOC-CAM-PFMEA-R1', 'Add fixture shift prevention control',
            'ACT-Q1', '2026-08-29T11:00:00.000Z');
        const insertFeedbackReview = db.prepare(`INSERT INTO feedback_reviews(id,feedback_id,
            reviewer_actor_id,decision,verification_kind,verification_id,reason,reviewed_at)
            VALUES (?,?,?,?,?,?,?,?)`);
        assert.throws(() => insertFeedbackReview.run('FB-OLD', 'FB-PFMEA', 'ACT-REV',
            'Pass', 'aoi-inspection', 'AOI-A-026', 'Old AOI source',
            '2026-08-29T12:00:00.000Z'), /feedback|verification|review/i);
        insertFeedbackReview.run('FB-REV', 'FB-PFMEA', 'ACT-REV', 'Pass',
            'capa-review', 'CAPA-CR',
                'Source verification linked', '2026-08-29T12:00:00.000Z');
        const insertRevision = db.prepare(`INSERT INTO document_revisions(id,document_id,
            revision_no,parent_revision_id,source_feedback_id,summary,approved_by,approved_at)
            VALUES (?,?,?,?,?,?,?,?)`);
        assert.throws(() => insertRevision.run('DOC-CAM-PFMEA-R2-BAD', 'DOC-CAM-PFMEA', 2,
            'DOC-CAM-PFMEA-R1', 'FB-PFMEA', 'Add fixture shift prevention control',
            'ACT-Q1', '2026-08-29T13:00:00.000Z'), /separate|approver/i);
        insertRevision.run('DOC-CAM-PFMEA-R2', 'DOC-CAM-PFMEA', 2,
            'DOC-CAM-PFMEA-R1', 'FB-PFMEA', 'Add fixture shift prevention control',
            'ACT-APP', '2026-08-29T13:00:00.000Z');
        const laterRows = db.prepare(`SELECT r.lot_id,a.inspected_units,a.rejected_units
            FROM process_runs r JOIN aoi_inspections a ON a.process_run_id=r.id
            WHERE r.equipment_id='EQ-ALIGN-A' AND r.module_id='MOD-ALIGN-A'
                AND r.start_at>='2026-08-28T00:00:00.000Z'
                AND a.inspected_at<'2026-09-05T00:00:00.000Z'
            ORDER BY r.start_at,r.id`).all();
        const sourceJson = JSON.stringify({ lotIds: laterRows.map(row => row.lot_id) });
        const insertCheck = db.prepare(`INSERT INTO incident_effectiveness_checks(id,cycle_id,incident_id,
            window_start,window_end,source_json,source_digest,lot_count,inspected_units,
            rejected_units,recurrence_count,unresolved_alarm_count,rule_version,passed,
            evaluated_by,evaluated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const attemptPass = (id, first, last, windowEnd) => {
            const lotIds = Array.from({ length: last - first + 1 }, (_, offset) =>
                `LOT-A-${String(first + offset).padStart(3, '0')}`);
            const placeholders = lotIds.map(() => '?').join(',');
            const totals = db.prepare(`SELECT SUM(a.inspected_units) AS inspected,
                SUM(a.rejected_units) AS rejected FROM aoi_inspections a
                JOIN process_runs r ON r.id=a.process_run_id
                WHERE r.lot_id IN (${placeholders})`).get(...lotIds);
            const json = JSON.stringify({ lotIds });
            return insertCheck.run(id, 'CYC-1', 'INC-CAPA', '2026-08-30T00:00:00.000Z',
                windowEnd, json, createHash('sha256').update(json).digest('hex'),
                lotIds.length, totals.inspected, totals.rejected, 0, 0,
                'DEMO-CAPA-1', 1, 'ACT-Q1', '2026-09-12T00:00:00.000Z');
        };
        assert.throws(() => attemptPass('EFF-PADDED', 30, 34,
            '2026-09-07T00:00:00.000Z'), /effectiveness|window|rule/i);
        assert.throws(() => attemptPass('EFF-HIDDEN-RECURRENCE', 30, 39,
            '2026-09-09T00:00:00.000Z'), /effectiveness|window|rule/i);
        assert.throws(() => attemptPass('EFF-SKIPPED-LOT', 30, 38,
            '2026-09-09T00:00:00.000Z'), /effectiveness|window|rule/i);
        const checkArgs = ['EFF-1', 'CYC-1', 'INC-CAPA', '2026-08-28T00:00:00.000Z',
                '2026-09-05T00:00:00.000Z', sourceJson,
                createHash('sha256').update(sourceJson).digest('hex'), laterRows.length,
                laterRows.reduce((n, row) => n + row.inspected_units, 0),
                laterRows.reduce((n, row) => n + row.rejected_units, 0), 0, 0,
                'DEMO-CAPA-1', 1, 'ACT-Q1', '2026-09-05T00:01:00.000Z'];
        assert.throws(() => insertCheck.run(...checkArgs), /effectiveness|window|rule/i);
        checkArgs[13] = 0;
        insertCheck.run(...checkArgs);
        assert.throws(() => db.prepare(`INSERT INTO incident_cycle_decisions(id,cycle_id,
            incident_id,decision,effectiveness_check_id,actor_id,reason,decided_at)
            VALUES (?,?,?,?,?,?,?,?)`).run('CLOSE-EARLY', 'CYC-1', 'INC-CAPA', 'Closed',
            'EFF-1', 'ACT-Q1', 'Incomplete CAPA and feedback', '2026-09-05T00:02:00.000Z'),
        /cycle|CAPA|feedback/i);
        db.prepare("UPDATE incidents SET cycle_no=2 WHERE id='INC-CAPA'").run();
        assert.throws(() => db.prepare(`INSERT INTO incident_cycles(id,incident_id,cycle_no,
            parent_cycle_id,opened_by,opened_at,reason) VALUES (?,?,?,?,?,?,?)`)
            .run('CYC-2', 'INC-CAPA', 2, 'CYC-1', 'ACT-Q1',
                '2026-09-05T00:03:00.000Z', 'Unapproved reopen'), /cycle|prior|reopen/i);
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
        db.close();
    }
});

function effectivenessIntegrityFixture(databasePath = ':memory:', insertInitialCheck = true) {
    const { db, review } = reviewedIncident(databasePath);
    db.prepare(`INSERT INTO incident_cycles(id,incident_id,cycle_no,scope_review_id,
        opened_by,opened_at,reason) VALUES (?,?,?,?,?,?,?)`)
        .run('CYC-EFF', 'INC-CAPA', 1, review.reviewId, 'ACT-Q1', at(11),
            'Synthetic source integrity test');
    const windowStart = '2026-08-30T00:00:00.000Z';
    const windowEnd = '2026-09-09T00:00:00.000Z';
    const rows = db.prepare(`SELECT r.lot_id,a.inspected_units,a.rejected_units
        FROM process_runs r JOIN aoi_inspections a ON a.process_run_id=r.id
        WHERE r.equipment_id='EQ-ALIGN-A' AND r.module_id='MOD-ALIGN-A'
            AND r.start_at>=? AND a.inspected_at<? ORDER BY r.start_at,r.id`)
        .all(windowStart, windowEnd);
    const sourceJson = JSON.stringify({ lotIds: rows.map(row => row.lot_id) });
    const insert = db.prepare(`INSERT INTO incident_effectiveness_checks(id,cycle_id,incident_id,
        window_start,window_end,source_json,source_digest,lot_count,inspected_units,
        rejected_units,recurrence_count,unresolved_alarm_count,rule_version,passed,
        evaluated_by,evaluated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const values = id => [id, 'CYC-EFF', 'INC-CAPA', windowStart, windowEnd, sourceJson,
        createHash('sha256').update(sourceJson).digest('hex'), rows.length,
        rows.reduce((n, row) => n + row.inspected_units, 0),
        rows.reduce((n, row) => n + row.rejected_units, 0), 1, 0,
        'DEMO-CAPA-1', 0, 'ACT-Q1', '2026-09-09T00:01:00.000Z'];
    if (insertInitialCheck) {
        insert.run(...values('EFF-SOURCE'));
        appendEffectivenessAudit(db, 'EFF-SOURCE');
    }
    return { db, insert, values };
}

function appendEffectivenessAudit(db, checkId) {
    const check = db.prepare('SELECT * FROM incident_effectiveness_checks WHERE id=?').get(checkId);
    const incident = db.prepare('SELECT equipment_id,module_id,defect_code_id FROM incidents WHERE id=?')
        .get(check.incident_id);
    const rows = db.prepare(`SELECT r.id AS run_id,a.id AS aoi_id,a.inspected_at
        FROM process_runs r JOIN aoi_inspections a ON a.process_run_id=r.id
        WHERE r.equipment_id=? AND r.module_id=? AND r.start_at>=? AND r.end_at<=?
        ORDER BY r.start_at,r.id`).all(incident.equipment_id, incident.module_id,
            check.window_start, check.window_end);
    const dates = rows.map(row => row.inspected_at.slice(0, 10)).sort();
    const calendarDays = dates.length > 1 ?
        (Date.parse(`${dates.at(-1)}T00:00:00.000Z`) -
            Date.parse(`${dates[0]}T00:00:00.000Z`)) / 86400000 : 0;
    const requiredLots = 5;
    const gaps = [];
    if (rows.length < requiredLots) gaps.push(`${requiredLots - rows.length} later lots`);
    if (calendarDays < 7) gaps.push(`${7 - calendarDays} calendar days`);
    if (check.inspected_units === 0) gaps.push('AOI denominator');
    if (check.rejected_units * 100 > check.inspected_units * 2)
        gaps.push('AOI reject rate above 2%');
    if (check.recurrence_count) gaps.push('target defect recurrence');
    if (check.unresolved_alarm_count) gaps.push('unresolved related alarm');
    const revision = db.prepare(`SELECT id FROM incident_revisions
        WHERE incident_id=? ORDER BY revision_no DESC LIMIT 1`).get(check.incident_id);
    const state = db.prepare('SELECT state FROM incidents WHERE id=?').get(check.incident_id).state;
    const nextState = state === 'Scope Reviewed' ? 'Effectiveness Check' : state;
    db.prepare('UPDATE incidents SET state=?,updated_at=? WHERE id=?')
        .run(nextState, check.evaluated_at, check.incident_id);
    withValidatedTransaction(db, tx => appendAuditEvent(tx, {
        actorId: check.evaluated_by, recordedAt: check.evaluated_at,
        entityType: 'incident', entityId: check.incident_id,
        entityRevisionId: revision.id, action: 'effectiveness-evaluated',
        priorState: state, newState: nextState !== state ? nextState : null,
        reason: check.passed ? 'Synthetic source window meets DEMO-CAPA-1' :
            `Synthetic source window needs action: ${gaps.join(', ')}`,
        payload: { cycleId: check.cycle_id, checkId: check.id,
            sourceDigest: check.source_digest, sourceRunIds: rows.map(row => row.run_id),
            aoiInspectionIds: rows.map(row => row.aoi_id),
            windowStart: check.window_start, windowEnd: check.window_end,
            requiredLots, lotCount: check.lot_count,
            inspectedUnits: check.inspected_units, rejectedUnits: check.rejected_units,
            recurrenceCount: check.recurrence_count,
            unresolvedAlarmCount: check.unresolved_alarm_count, calendarDays,
            passed: Boolean(check.passed), gaps, postClose: false,
            authorityRevisionId: null, operatingAcceptanceId: null }
    }));
}

test('v4 integrity rederives effectiveness digest and source cohort in memory', () => {
    const { db, insert, values } = effectivenessIntegrityFixture();
    try {
        assert.doesNotThrow(() => assertDataIntegrity(db));
        const forged = values('EFF-FORGED');
        forged[6] = 'f'.repeat(64);
        assert.throws(() => insert.run(...forged), /effectiveness|digest|source/i);
        assert.doesNotThrow(() => assertDataIntegrity(db));
    } finally {
        db.close();
    }
});

test('direct SQL effectiveness insert rejects a completed run without AOI in its window', () => {
    const { db, insert, values } = effectivenessIntegrityFixture(':memory:', false);
    try {
        db.prepare(`INSERT INTO process_runs(id,lot_id,equipment_id,module_id,
            recipe_revision_id,start_at,end_at,processed_units)
            SELECT 'RUN-EFF-NO-AOI',lot_id,equipment_id,module_id,recipe_revision_id,
                start_at,end_at,processed_units
            FROM process_runs WHERE equipment_id='EQ-ALIGN-A' AND module_id='MOD-ALIGN-A'
                AND start_at>='2026-08-30T00:00:00.000Z'
                AND end_at<='2026-09-09T00:00:00.000Z'
            LIMIT 1`).run();
        assert.throws(() => insert.run(...values('EFF-MISSING-AOI')),
            /effectiveness|AOI|source/i);
        assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM incident_effectiveness_checks
            WHERE id='EFF-MISSING-AOI'`).get().total, 0);
    } finally {
        db.close();
    }
});

test('direct SQL cannot backfill a run into an already evaluated source window', () => {
    const { db } = effectivenessIntegrityFixture();
    try {
        assert.throws(() => db.prepare(`INSERT INTO process_runs(id,lot_id,equipment_id,
            module_id,recipe_revision_id,start_at,end_at,processed_units)
            SELECT 'RUN-EFF-BACKFILL',lot_id,equipment_id,module_id,recipe_revision_id,
                start_at,end_at,processed_units FROM process_runs
            WHERE equipment_id='EQ-ALIGN-A' AND module_id='MOD-ALIGN-A'
                AND start_at>='2026-08-30T00:00:00.000Z'
                AND end_at<='2026-09-09T00:00:00.000Z'
            LIMIT 1`).run(), /effectiveness|window|source/i);
        assert.doesNotThrow(() => assertDataIntegrity(db));
    } finally {
        db.close();
    }
});

test('direct SQL cannot count AOI from a run unfinished at the window end', () => {
    const { db, insert, values } = effectivenessIntegrityFixture(':memory:', false);
    try {
        db.prepare(`INSERT INTO lots(id,product_family_id,code,quantity,start_at,end_at)
            VALUES (?,?,?,?,?,?)`).run('LOT-EFF-PARTIAL', 'PF-CAMERA', 'LOT-EFF-PARTIAL',
                100, '2026-09-08T22:00:00.000Z', '2026-09-09T02:00:00.000Z');
        db.prepare(`INSERT INTO process_runs(id,lot_id,equipment_id,module_id,
            recipe_revision_id,start_at,end_at,processed_units) VALUES (?,?,?,?,?,?,?,?)`)
            .run('RUN-EFF-PARTIAL', 'LOT-EFF-PARTIAL', 'EQ-ALIGN-A', 'MOD-ALIGN-A',
                'REC-ALIGN-R3', '2026-09-08T23:00:00.000Z',
                '2026-09-09T01:00:00.000Z', 100);
        db.prepare(`INSERT INTO aoi_inspections(id,lot_id,process_run_id,inspected_at,
            inspected_units,rejected_units) VALUES (?,?,?,?,?,?)`)
            .run('AOI-EFF-PARTIAL', 'LOT-EFF-PARTIAL', 'RUN-EFF-PARTIAL',
                '2026-09-08T23:30:00.000Z', 100, 0);
        const forged = values('EFF-PARTIAL');
        const lotIds = JSON.parse(forged[5]).lotIds.concat('LOT-EFF-PARTIAL');
        forged[5] = JSON.stringify({ lotIds });
        forged[6] = createHash('sha256').update(forged[5]).digest('hex');
        forged[7] += 1;
        forged[8] += 100;
        assert.throws(() => insert.run(...forged), /effectiveness|window|source/i);
    } finally {
        db.close();
    }
});

test('direct SQL cannot count two completed runs as one effectiveness lot', () => {
    const { db, insert, values } = effectivenessIntegrityFixture(':memory:', false);
    try {
        const original = db.prepare(`SELECT r.* FROM process_runs r
            WHERE r.equipment_id='EQ-ALIGN-A' AND r.module_id='MOD-ALIGN-A'
                AND r.start_at>='2026-08-30T00:00:00.000Z'
                AND r.end_at<='2026-09-09T00:00:00.000Z'
            ORDER BY r.start_at,r.id LIMIT 1`).get();
        db.prepare(`INSERT INTO process_runs(id,lot_id,equipment_id,module_id,
            recipe_revision_id,start_at,end_at,processed_units) VALUES (?,?,?,?,?,?,?,?)`)
            .run('RUN-EFF-DUP', original.lot_id, original.equipment_id,
                original.module_id, original.recipe_revision_id, original.start_at,
                original.end_at, original.processed_units);
        db.prepare(`INSERT INTO aoi_inspections(id,lot_id,process_run_id,inspected_at,
            inspected_units,rejected_units) VALUES (?,?,?,?,?,?)`)
            .run('AOI-EFF-DUP', original.lot_id, 'RUN-EFF-DUP',
                original.start_at, original.processed_units, 0);
        const duplicated = values('EFF-DUPLICATE-RUN');
        duplicated[8] += original.processed_units;
        assert.throws(() => insert.run(...duplicated), /effectiveness|source|AOI/i);
    } finally {
        db.close();
    }
});

test('run then AOI staging permits a complete effectiveness source and rolls back cleanly', () => {
    const { db, insert, values } = effectivenessIntegrityFixture(':memory:', false);
    try {
        db.exec('BEGIN IMMEDIATE');
        try {
            db.prepare(`INSERT INTO lots(id,product_family_id,code,quantity,start_at,end_at)
                VALUES (?,?,?,?,?,?)`).run('LOT-EFF-STAGED', 'PF-CAMERA', 'LOT-EFF-STAGED',
                    100, '2026-09-08T08:00:00.000Z', '2026-09-08T12:00:00.000Z');
            db.prepare(`INSERT INTO process_runs(id,lot_id,equipment_id,module_id,
                recipe_revision_id,start_at,end_at,processed_units) VALUES (?,?,?,?,?,?,?,?)`)
                .run('RUN-EFF-STAGED', 'LOT-EFF-STAGED', 'EQ-ALIGN-A', 'MOD-ALIGN-A',
                    'REC-ALIGN-R3', '2026-09-08T09:00:00.000Z',
                    '2026-09-08T11:00:00.000Z', 100);
            assert.throws(() => insert.run(...values('EFF-STAGED-EARLY')),
                /effectiveness|AOI|source/i);
            db.prepare(`INSERT INTO aoi_inspections(id,lot_id,process_run_id,inspected_at,
                inspected_units,rejected_units) VALUES (?,?,?,?,?,?)`)
                .run('AOI-EFF-STAGED', 'LOT-EFF-STAGED', 'RUN-EFF-STAGED',
                    '2026-09-08T10:30:00.000Z', 100, 0);
            const rows = db.prepare(`SELECT r.lot_id,a.inspected_units,a.rejected_units
                FROM process_runs r JOIN aoi_inspections a ON a.process_run_id=r.id
                WHERE r.equipment_id='EQ-ALIGN-A' AND r.module_id='MOD-ALIGN-A'
                    AND r.start_at>='2026-08-30T00:00:00.000Z'
                    AND r.end_at<='2026-09-09T00:00:00.000Z'
                ORDER BY r.start_at,r.id`).all();
            const staged = values('EFF-STAGED-COMPLETE');
            staged[5] = JSON.stringify({ lotIds: rows.map(row => row.lot_id) });
            staged[6] = createHash('sha256').update(staged[5]).digest('hex');
            staged[7] = rows.length;
            staged[8] = rows.reduce((total, row) => total + row.inspected_units, 0);
            staged[9] = rows.reduce((total, row) => total + row.rejected_units, 0);
            assert.doesNotThrow(() => insert.run(...staged));
        } finally {
            db.exec('ROLLBACK');
        }
        assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM process_runs
            WHERE id='RUN-EFF-STAGED'`).get().total, 0);
        assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM incident_effectiveness_checks
            WHERE id='EFF-STAGED-COMPLETE'`).get().total, 0);
        assert.doesNotThrow(() => assertDataIntegrity(db));
    } finally {
        db.close();
    }
});

test('a persisted effectiveness check survives close and database reopen validation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-capa-reopen-'));
    const path = join(directory, 'demo.sqlite');
    let db;
    try {
        ({ db } = effectivenessIntegrityFixture(path));
        db.close();
        db = undefined;
        const reopened = openDatabase(path);
        try {
            assert.equal(reopened.prepare(`SELECT passed FROM incident_effectiveness_checks
                WHERE id='EFF-SOURCE'`).get().passed, 0);
            assert.doesNotThrow(() => assertDataIntegrity(reopened));
        } finally {
            reopened.close();
        }
    } finally {
        db?.close();
        const withinTemp = relative(resolve(tmpdir()), resolve(directory));
        assert.ok(withinTemp && !withinTemp.startsWith('..'));
        rmSync(directory, { recursive: true, force: true });
    }
});

test('a populated effectiveness check remains byte-identical after v7 reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-capa-v4-check-'));
    const path = join(directory, 'demo.sqlite');
    try {
        const { db } = effectivenessIntegrityFixture(path);
        const before = JSON.stringify(db.prepare(`SELECT * FROM incident_effectiveness_checks
            WHERE id='EFF-SOURCE'`).get());
        db.close();
        const upgraded = openDatabase(path);
        try {
            assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 9);
            assert.equal(JSON.stringify(upgraded.prepare(`SELECT * FROM incident_effectiveness_checks
                WHERE id='EFF-SOURCE'`).get()), before);
            assert.doesNotThrow(() => assertDataIntegrity(upgraded));
        } finally {
            upgraded.close();
        }
    } finally {
        const withinTemp = relative(resolve(tmpdir()), resolve(directory));
        assert.ok(withinTemp && !withinTemp.startsWith('..'));
        rmSync(directory, { recursive: true, force: true });
    }
});

test('populated v5 incident CAPA and check migrate to v7 without changing history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fabassure-populated-v5-'));
    const path = join(directory, 'demo.sqlite');
    let original;
    try {
        const { db } = effectivenessIntegrityFixture(path);
        original = {
            cycle: db.prepare("SELECT * FROM incident_cycles WHERE id='CYC-EFF'").get(),
            check: db.prepare("SELECT * FROM incident_effectiveness_checks WHERE id='EFF-SOURCE'").get(),
            audit: db.prepare('SELECT id,digest,payload_json FROM audit_events ORDER BY sequence').all()
        };
        db.close();
        const old = new DatabaseSync(path);
        try {
            old.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
            const source = readFileSync(new URL('../src/data/schema-v2.sql', import.meta.url), 'utf8');
            const oldAuditSql = source.match(/CREATE TABLE audit_events \([\s\S]*?\n\);/)[0];
            const oldAcceptanceSql = source.match(/CREATE TABLE acceptances \([\s\S]*?\n\);/)[0];
            const auditTriggers = ['audit_append_guard', 'immutable_audit_update',
                'immutable_audit_delete'].map(name => source.match(
                new RegExp(`CREATE TRIGGER ${name}[^]*?END;`))[0]);
            const acceptanceTriggers = old.prepare(`SELECT sql FROM sqlite_master
                WHERE type='trigger' AND tbl_name='acceptances'
                    AND name<>'acceptance_condition_guard' ORDER BY name`).all();
            const migrationGuard = old.prepare(`SELECT sql FROM sqlite_master
                WHERE name='immutable_migration_delete'`).get().sql;
            const auditRows = old.prepare('SELECT * FROM audit_events ORDER BY sequence').all();
            for (const { name } of old.prepare(`SELECT name FROM sqlite_master
                WHERE type='trigger' AND name LIKE 'change_%_after_effectiveness_guard'`).all()) {
                old.exec(`DROP TRIGGER ${name}`);
            }
            old.exec(`DROP TRIGGER incident_cycle_latest_check_guard;
                DROP TRIGGER incident_cycle_check_audit_guard;
                DROP VIEW change_revision_frozen_scope`);
            old.exec(`DROP TRIGGER equipment_event_after_effectiveness_guard;
                DROP TRIGGER equipment_resolution_after_effectiveness_guard;
                DROP TRIGGER aoi_defect_after_effectiveness_guard;
                DROP TABLE conditional_acceptance_expiries;
                DROP TABLE legacy_acceptance_classifications;
                DROP TABLE acceptances;
                DROP TABLE audit_events;
                DROP TABLE system_principals;`);
            old.exec(oldAuditSql);
            const columns = ['sequence', 'id', 'dataset_instance_id', 'recorded_at',
                'actor_id', 'simulated_role', 'entity_type', 'entity_id',
                'entity_revision_id', 'action', 'prior_state', 'new_state', 'reason',
                'payload_json', 'payload_sha256', 'previous_digest', 'digest'];
            const insertAudit = old.prepare(`INSERT INTO audit_events(${columns.join(',')})
                VALUES (${columns.map(() => '?').join(',')})`);
            for (const row of auditRows) insertAudit.run(...columns.map(key => row[key]));
            for (const sql of auditTriggers) old.exec(sql);
            old.exec(oldAcceptanceSql);
            for (const row of acceptanceTriggers) old.exec(row.sql);
            old.exec('DROP TRIGGER immutable_migration_delete');
            old.prepare("DELETE FROM schema_migrations WHERE id='MIG-009'").run();
            old.prepare("DELETE FROM schema_migrations WHERE id='MIG-008'").run();
            old.prepare("DELETE FROM schema_migrations WHERE id='MIG-007'").run();
            old.prepare("DELETE FROM schema_migrations WHERE id='MIG-006'").run();
            old.exec(migrationGuard);
            old.exec('PRAGMA user_version=5; COMMIT; PRAGMA foreign_keys=ON');
            assert.deepEqual(old.prepare('PRAGMA foreign_key_check').all(), []);
        } finally {
            if (old.isTransaction) old.exec('ROLLBACK');
            old.close();
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            const upgraded = openDatabase(path);
            try {
                assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 9);
                assert.deepEqual(upgraded.prepare("SELECT * FROM incident_cycles WHERE id='CYC-EFF'").get(),
                    original.cycle);
                assert.deepEqual(upgraded.prepare(`SELECT * FROM incident_effectiveness_checks
                    WHERE id='EFF-SOURCE'`).get(), original.check);
                assert.deepEqual(upgraded.prepare(`SELECT id,digest,payload_json FROM audit_events
                    ORDER BY sequence`).all(), original.audit);
                assert.equal(upgraded.prepare(`SELECT COUNT(*) AS n FROM
                    legacy_acceptance_classifications`).get().n, 0);
                assertDataIntegrity(upgraded);
            } finally { upgraded.close(); }
        }
    } finally {
        const withinTemp = relative(resolve(tmpdir()), resolve(directory));
        assert.ok(withinTemp && !withinTemp.startsWith('..'));
        rmSync(directory, { recursive: true, force: true });
    }
});

test('saved effectiveness rejects a backdated alarm before its source can change', () => {
    const { db } = effectivenessIntegrityFixture();
    try {
        assert.doesNotThrow(() => assertDataIntegrity(db));
        assert.throws(() => db.prepare(`INSERT INTO equipment_events(id,equipment_id,module_id,event_type,
            occurred_at,duration_seconds) VALUES (?,?,?,?,?,?)`)
            .run('EV-UNRESOLVED', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'alarm',
                '2026-09-01T14:00:00.000Z', 0), /saved effectiveness/i);
        assert.doesNotThrow(() => assertDataIntegrity(db));
    } finally {
        db.close();
    }
});

test('a late repair cannot be attached to an alarm rejected from a frozen window', () => {
    const { db } = effectivenessIntegrityFixture();
    try {
        assert.throws(() => db.prepare(`INSERT INTO equipment_events(id,equipment_id,module_id,event_type,
            occurred_at,duration_seconds) VALUES (?,?,?,?,?,?)`)
            .run('EV-LATE-LINK', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'alarm',
                '2026-09-01T14:00:00.000Z', 0), /saved effectiveness/i);
        db.prepare(`INSERT INTO maintenance_actions(id,equipment_id,module_id,code,
            summary,start_at,end_at) VALUES (?,?,?,?,?,?,?)`)
            .run('MA-LATE-LINK', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'REPAIR',
                'Synthetic alarm repair', '2026-09-01T15:00:00.000Z',
                '2026-09-01T16:00:00.000Z');
        assert.throws(() => db.prepare(`INSERT INTO equipment_event_resolutions(id,equipment_event_id,
            maintenance_action_id,recorded_by,recorded_at) VALUES (?,?,?,?,?)`)
            .run('RES-LATE-LINK', 'EV-LATE-LINK', 'MA-LATE-LINK', 'ACT-EQP',
                '2026-09-10T00:00:00.000Z'), /FOREIGN KEY|resolution/i);
        assert.doesNotThrow(() => assertDataIntegrity(db));
    } finally {
        db.close();
    }
});

test('SQL effectiveness uses seven UTC inspection dates rather than 168 elapsed hours', () => {
    const { db, review } = reviewedIncident();
    try {
        db.prepare(`INSERT INTO incident_cycles(id,incident_id,cycle_no,scope_review_id,
            opened_by,opened_at,reason) VALUES (?,?,?,?,?,?,?)`)
            .run('CYC-CALENDAR', 'INC-CAPA', 1, review.reviewId, 'ACT-Q1', at(11),
                'Synthetic calendar boundary');
        db.prepare(`INSERT INTO cause_assessments(id,cycle_id,incident_id,status,
            statement,evidence_kind,evidence_id,assessed_by,assessed_at)
            VALUES (?,?,?,?,?,?,?,?,?)`).run('CAUSE-CALENDAR', 'CYC-CALENDAR',
                'INC-CAPA', 'Confirmed', 'Synthetic source event', 'equipment-event',
                'EV-DETECTION', 'ACT-Q1', at(13));
        const addAction = db.prepare(`INSERT INTO capa_actions(id,cycle_id,incident_id,
            cause_id,action_type,action_text,owner_actor_id,due_at,created_by,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`);
        const reviewAction = db.prepare(`INSERT INTO capa_action_reviews(id,action_id,
            reviewer_actor_id,decision,evidence_kind,evidence_id,reason,reviewed_at)
            VALUES (?,?,?,?,?,?,?,?)`);
        for (const [type, minute] of [['Corrective', 14], ['Preventive', 15]]) {
            const actionId = `CAPA-CALENDAR-${type}`;
            addAction.run(actionId, 'CYC-CALENDAR', 'INC-CAPA', 'CAUSE-CALENDAR',
                type, `Synthetic ${type} action`, 'ACT-EQP',
                '2026-08-30T00:00:00.000Z', 'ACT-Q1', at(minute));
            reviewAction.run(`${actionId}-REVIEW`, actionId, 'ACT-REV', 'Pass',
                'aoi-inspection', 'AOI-A-028', 'Synthetic later AOI evidence',
                `2026-08-29T10:${String(minute).padStart(2, '0')}:00.000Z`);
        }
        const times = [
            ['2026-09-11T23:05:00.000Z', '2026-09-11T23:15:00.000Z', '2026-09-11T23:25:00.000Z'],
            ['2026-09-12T12:00:00.000Z', '2026-09-12T12:10:00.000Z', '2026-09-12T12:20:00.000Z'],
            ['2026-09-14T12:00:00.000Z', '2026-09-14T12:10:00.000Z', '2026-09-14T12:20:00.000Z'],
            ['2026-09-16T12:00:00.000Z', '2026-09-16T12:10:00.000Z', '2026-09-16T12:20:00.000Z'],
            ['2026-09-18T00:05:00.000Z', '2026-09-18T00:15:00.000Z', '2026-09-18T00:25:00.000Z']
        ];
        const lotIds = [];
        for (const [index, [start, inspected, end]] of times.entries()) {
            const lotId = `LOT-CALENDAR-${index + 1}`;
            const runId = `RUN-CALENDAR-${index + 1}`;
            lotIds.push(lotId);
            db.prepare(`INSERT INTO lots(id,product_family_id,code,quantity,start_at,end_at)
                VALUES (?,?,?,?,?,?)`).run(lotId, 'PF-CAMERA', lotId, 100, start, end);
            db.prepare(`INSERT INTO process_runs(id,lot_id,equipment_id,module_id,
                recipe_revision_id,start_at,end_at,processed_units)
                VALUES (?,?,?,?,?,?,?,?)`).run(runId, lotId, 'EQ-ALIGN-A',
                    'MOD-ALIGN-A', 'REC-ALIGN-R3', start, end, 100);
            db.prepare(`INSERT INTO aoi_inspections(id,lot_id,process_run_id,
                inspected_at,inspected_units,rejected_units) VALUES (?,?,?,?,?,?)`)
                .run(`AOI-CALENDAR-${index + 1}`, lotId, runId, inspected, 100, 0);
        }
        const start = '2026-09-11T23:00:00.000Z';
        const end = '2026-09-18T00:30:00.000Z';
        assert.ok(Date.parse(end) - Date.parse(start) < 7 * 86400000);
        const source = JSON.stringify({ lotIds });
        assert.doesNotThrow(() => db.prepare(`INSERT INTO incident_effectiveness_checks(
            id,cycle_id,incident_id,window_start,window_end,source_json,source_digest,
            lot_count,inspected_units,rejected_units,recurrence_count,
            unresolved_alarm_count,rule_version,passed,evaluated_by,evaluated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('EFF-CALENDAR', 'CYC-CALENDAR',
                'INC-CAPA', start, end, source,
                createHash('sha256').update(source).digest('hex'), 5, 500, 0, 0, 0,
                'DEMO-CAPA-1', 1, 'ACT-Q1', '2026-09-18T00:31:00.000Z'));
        appendEffectivenessAudit(db, 'EFF-CALENDAR');
        assert.doesNotThrow(() => assertDataIntegrity(db));
    } finally {
        db.close();
    }
});

test('passing effectiveness requires both CAPA action reviews before the source window', () => {
    const { db, review } = reviewedIncident();
    try {
        db.prepare(`INSERT INTO incident_cycles(id,incident_id,cycle_no,scope_review_id,
            opened_by,opened_at,reason) VALUES (?,?,?,?,?,?,?)`)
            .run('CYC-NO-ACTIONS', 'INC-CAPA', 1, review.reviewId, 'ACT-Q1', at(11),
                'Synthetic missing-action test');
        const start = '2026-08-30T00:00:00.000Z';
        const end = '2026-09-07T00:00:00.000Z';
        const rows = db.prepare(`SELECT r.lot_id,a.inspected_units,a.rejected_units
            FROM process_runs r JOIN aoi_inspections a ON a.process_run_id=r.id
            WHERE r.equipment_id='EQ-ALIGN-A' AND r.module_id='MOD-ALIGN-A'
                AND r.start_at>=? AND a.inspected_at<? ORDER BY r.start_at,r.id`)
            .all(start, end);
        const source = JSON.stringify({ lotIds: rows.map(row => row.lot_id) });
        const insertPass = db.prepare(`INSERT INTO incident_effectiveness_checks(
            id,cycle_id,incident_id,window_start,window_end,source_json,source_digest,
            lot_count,inspected_units,rejected_units,recurrence_count,
            unresolved_alarm_count,rule_version,passed,evaluated_by,evaluated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const attempt = id => insertPass.run(id, 'CYC-NO-ACTIONS', 'INC-CAPA', start,
                end, source,
                createHash('sha256').update(source).digest('hex'), rows.length,
                rows.reduce((n, row) => n + row.inspected_units, 0),
                rows.reduce((n, row) => n + row.rejected_units, 0), 0, 0,
                'DEMO-CAPA-1', 1, 'ACT-Q1', '2026-09-07T00:01:00.000Z');
        assert.throws(() => attempt('EFF-NO-ACTIONS'), /effectiveness|CAPA|rule/i);
        db.prepare(`INSERT INTO cause_assessments(id,cycle_id,incident_id,status,
            statement,evidence_kind,evidence_id,assessed_by,assessed_at)
            VALUES (?,?,?,?,?,?,?,?,?)`).run('CAUSE-NO-ACTIONS', 'CYC-NO-ACTIONS',
                'INC-CAPA', 'Confirmed', 'Synthetic source event', 'equipment-event',
                'EV-DETECTION', 'ACT-Q1', at(13));
        const addAction = db.prepare(`INSERT INTO capa_actions(id,cycle_id,incident_id,
            cause_id,action_type,action_text,owner_actor_id,due_at,created_by,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`);
        const reviewAction = db.prepare(`INSERT INTO capa_action_reviews(id,action_id,
            reviewer_actor_id,decision,evidence_kind,evidence_id,reason,reviewed_at)
            VALUES (?,?,?,?,?,?,?,?)`);
        addAction.run('CAPA-ONLY-CORRECTIVE', 'CYC-NO-ACTIONS', 'INC-CAPA',
            'CAUSE-NO-ACTIONS', 'Corrective', 'Synthetic corrective action',
            'ACT-EQP', '2026-09-01T00:00:00.000Z', 'ACT-Q1', at(14));
        reviewAction.run('CAPA-ONLY-CORRECTIVE-REVIEW', 'CAPA-ONLY-CORRECTIVE',
            'ACT-REV', 'Pass', 'aoi-inspection', 'AOI-A-028',
            'Synthetic corrective verification', '2026-08-29T11:00:00.000Z');
        assert.throws(() => attempt('EFF-ONE-ACTION'), /effectiveness|CAPA|rule/i);
        addAction.run('CAPA-LATE-PREVENTIVE', 'CYC-NO-ACTIONS', 'INC-CAPA',
            'CAUSE-NO-ACTIONS', 'Preventive', 'Synthetic preventive action',
            'ACT-EQP', '2026-09-01T00:00:00.000Z', 'ACT-Q1', at(15));
        reviewAction.run('CAPA-LATE-PREVENTIVE-REVIEW', 'CAPA-LATE-PREVENTIVE',
            'ACT-REV', 'Pass', 'aoi-inspection', 'AOI-A-030',
            'Synthetic late preventive verification', '2026-08-30T11:00:00.000Z');
        assert.throws(() => attempt('EFF-LATE-ACTION'), /effectiveness|CAPA|rule/i);
    } finally {
        db.close();
    }
});

test('passing effectiveness rejects a forged digest and backdated hidden alarm', () => {
    const { db, insert } = effectivenessIntegrityFixture();
    try {
        const rows = db.prepare(`SELECT r.lot_id,a.inspected_units,a.rejected_units
            FROM process_runs r JOIN aoi_inspections a ON a.process_run_id=r.id
            WHERE r.equipment_id='EQ-ALIGN-A' AND r.module_id='MOD-ALIGN-A'
                AND r.start_at>='2026-08-30T00:00:00.000Z'
                AND a.inspected_at<'2026-09-08T00:00:00.000Z'
            ORDER BY r.start_at,r.id`).all();
        const source = JSON.stringify({ lotIds: rows.map(row => row.lot_id) });
        const values = id => [id, 'CYC-EFF', 'INC-CAPA',
            '2026-08-30T00:00:00.000Z', '2026-09-08T00:00:00.000Z', source,
            createHash('sha256').update(source).digest('hex'), rows.length,
            rows.reduce((n, row) => n + row.inspected_units, 0),
            rows.reduce((n, row) => n + row.rejected_units, 0), 0, 0,
            'DEMO-CAPA-1', 1, 'ACT-Q1', '2026-09-08T00:01:00.000Z'];
        const forged = values('EFF-BAD-DIGEST');
        forged[6] = 'f'.repeat(64);
        assert.throws(() => insert.run(...forged), /digest|effectiveness|source/i);
        assert.throws(() => db.prepare(`INSERT INTO equipment_events(id,equipment_id,module_id,event_type,
            occurred_at,duration_seconds) VALUES (?,?,?,?,?,?)`)
            .run('EV-HIDDEN-ALARM', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'alarm',
                '2026-09-01T14:00:00.000Z', 0), /saved effectiveness/i);
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM equipment_events
            WHERE id='EV-HIDDEN-ALARM'`).get().n, 0);
        assert.doesNotThrow(() => assertDataIntegrity(db));
    } finally {
        db.close();
    }
});
