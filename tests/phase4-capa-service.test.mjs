import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { createIncident, containIncident, recordIncidentLkg,
    proposeIncidentTrace, reviewIncidentScope } from '../src/domain/incident-service.mjs';
import { startIncidentCapa, assessIncidentCause, planCapaAction,
    reviewCapaAction } from '../src/domain/capa-service.mjs';

const at = minute => `2026-08-27T10:${String(minute).padStart(2, '0')}:00.000Z`;

function scenario(reviewScope = true) {
    const db = openDatabase(':memory:');
    seedDatabase(db, { instanceId: 'DATASET-CAPA-SERVICE' });
    createIncident(db, { id: 'INC-CAPA-SERVICE', title: 'Synthetic fiducial excursion',
        actorId: 'ACT-Q1', defectCodeId: 'DEF-FIDUCIAL',
        detectionEventId: 'EV-DETECTION', observedLotId: 'LOT-A-026',
        recipeRevisionId: 'REC-ALIGN-R3', detectedAt: at(0), at: at(2) });
    containIncident(db, { incidentId: 'INC-CAPA-SERVICE', expectedRevisionNo: 1,
        actorId: 'ACT-PROD', ownerActorId: 'ACT-PROD',
        heldLotIds: ['LOT-A-025', 'LOT-A-026', 'LOT-A-027'],
        reason: 'Synthetic hold', at: at(4) });
    recordIncidentLkg(db, { incidentId: 'INC-CAPA-SERVICE', expectedRevisionNo: 1,
        actorId: 'ACT-Q1', aoiInspectionId: 'AOI-A-025',
        earliestPossibleAt: '2026-08-25T08:00:00.000Z',
        latestPossibleAt: '2026-08-25T12:00:00.000Z',
        method: 'Synthetic AOI screen', sampleScope: '100 units',
        limitation: 'Intermediate units uncertain', at: at(6) });
    const proposal = proposeIncidentTrace(db, { incidentId: 'INC-CAPA-SERVICE',
        expectedRevisionNo: 1, actorId: 'ACT-Q1', at: at(8) });
    if (reviewScope) {
        reviewIncidentScope(db, { incidentId: 'INC-CAPA-SERVICE',
            expectedRevisionNo: 1, proposalId: proposal.proposalId, actorId: 'ACT-REV',
            decision: 'Pass', reason: 'Synthetic independent scope review',
            lotDecisions: proposal.lots.map(lot => ({ lotId: lot.lotId,
                scopeStatus: lot.classification === 'excluded' ? 'excluded' :
                    lot.classification === 'ambiguous' ? 'ambiguous' : 'included',
                containment: lot.classification === 'excluded' ? 'No Change' : 'Held',
                reason: `Synthetic ${lot.classification} scope` })), at: at(10) });
    }
    return db;
}

const startInput = { incidentId: 'INC-CAPA-SERVICE', expectedRevisionNo: 1,
    actorId: 'ACT-Q1', reason: 'Source trace warrants corrective action', at: at(11) };

test('CAPA starts only after an independent passing scope review', () => {
    const db = scenario(false);
    try {
        const before = db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        assert.throws(() => startIncidentCapa(db, startInput), /scope|review|state/i);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM incident_cycles').get().n, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, before);
    } finally {
        db.close();
    }
});

test('CAPA cycle records reviewed scope, qualified actor and one audit event', () => {
    const db = scenario();
    try {
        const before = db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        assert.throws(() => startIncidentCapa(db, { ...startInput, actorId: 'ACT-REV' }),
            /role|actor|Quality/i);
        const result = startIncidentCapa(db, startInput);
        assert.equal(result.cycleId, 'INC-CAPA-SERVICE-CYC-1');
        assert.equal(result.state, 'CAPA In Progress');
        const row = db.prepare('SELECT * FROM incident_cycles WHERE id=?').get(result.cycleId);
        assert.equal(row.cycle_no, 1);
        assert.equal(row.scope_review_id,
            db.prepare('SELECT id FROM scope_reviews WHERE decision=?').get('Pass').id);
        assert.equal(db.prepare('SELECT state FROM incidents WHERE id=?')
            .get(startInput.incidentId).state, 'CAPA In Progress');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, before + 1);
        assert.throws(() => startIncidentCapa(db, startInput), /state|cycle|stale/i);
    } finally {
        db.close();
    }
});

test('cause assessment retains hypothesis and rejects unsupported or future evidence', () => {
    const db = scenario();
    try {
        startIncidentCapa(db, startInput);
        const base = { incidentId: startInput.incidentId, expectedRevisionNo: 1,
            cycleId: 'INC-CAPA-SERVICE-CYC-1', actorId: 'ACT-Q1', at: at(12),
            evidenceKind: 'equipment-event', evidenceId: 'EV-DETECTION' };
        assert.throws(() => assessIncidentCause(db, { ...base, id: 'CAUSE-STALE',
            expectedRevisionNo: 0, status: 'Confirmed', statement: 'Stale revision' }),
        /stale|revision/i);
        assert.throws(() => assessIncidentCause(db, { ...base, id: 'CAUSE-WRONG-CYCLE',
            cycleId: 'INC-CAPA-SERVICE-CYC-9', status: 'Confirmed',
            statement: 'Wrong cycle' }), /cycle/i);
        assert.throws(() => assessIncidentCause(db, { ...base, id: 'CAUSE-UNSUPPORTED',
            status: 'Confirmed', statement: 'Wrong source',
            evidenceId: 'EV-B-MODULE' }), /cause|source|evidence/i);
        assert.throws(() => assessIncidentCause(db, { ...base, id: 'CAUSE-FUTURE',
            status: 'Confirmed', statement: 'Future AOI', evidenceKind: 'aoi-defect',
            evidenceId: 'AOIDEF-A-027-1' }), /cause|source|evidence/i);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cause_assessments').get().n, 0);
        assert.equal(db.prepare('SELECT updated_at FROM incidents WHERE id=?')
            .get(startInput.incidentId).updated_at, at(11));
        const hypothesis = assessIncidentCause(db, { ...base, id: 'CAUSE-HYP',
            status: 'Hypothesis', statement: 'Fixture may have shifted' });
        assert.equal(hypothesis.status, 'Hypothesis');
        const confirmed = assessIncidentCause(db, { ...base, id: 'CAUSE-CONF',
            status: 'Confirmed', statement: 'Synthetic equipment evidence supports shift',
            at: at(13) });
        assert.equal(confirmed.status, 'Confirmed');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cause_assessments')
            .get().n, 2);
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action='cause-assessed'`)
            .get().n, 2);
    } finally {
        db.close();
    }
});

test('CAPA action requires confirmed cause and independent source-linked review', () => {
    const db = scenario();
    try {
        startIncidentCapa(db, startInput);
        const context = { incidentId: startInput.incidentId, expectedRevisionNo: 1,
            cycleId: 'INC-CAPA-SERVICE-CYC-1' };
        assessIncidentCause(db, { ...context, id: 'CAUSE-HYP-ACTION',
            actorId: 'ACT-Q1', at: at(12), status: 'Hypothesis',
            statement: 'Potential fixture movement', evidenceKind: 'equipment-event',
            evidenceId: 'EV-DETECTION' });
        assessIncidentCause(db, { ...context, id: 'CAUSE-CONF-ACTION',
            actorId: 'ACT-Q1', at: at(13), status: 'Confirmed',
            statement: 'Synthetic fixture movement confirmed',
            evidenceKind: 'equipment-event', evidenceId: 'EV-DETECTION' });
        const action = { ...context, id: 'CAPA-CORRECTIVE', actorId: 'ACT-Q1',
            ownerActorId: 'ACT-EQP', actionType: 'Corrective',
            actionText: 'Adjust synthetic fixture alignment',
            dueAt: '2026-09-01T00:00:00.000Z', at: at(14) };
        assert.throws(() => planCapaAction(db, { ...action,
            causeId: 'CAUSE-CONF-ACTION', ownerActorId: 'ACT-REV' }),
        /role|owner|actor/i);
        assert.throws(() => planCapaAction(db, { ...action,
            causeId: 'CAUSE-HYP-ACTION' }), /cause|confirmed|CAPA/i);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capa_actions').get().n, 0);
        assert.equal(planCapaAction(db, { ...action,
            causeId: 'CAUSE-CONF-ACTION' }).actionId, 'CAPA-CORRECTIVE');
        const review = { ...context, actionId: 'CAPA-CORRECTIVE',
            actorId: 'ACT-REV', decision: 'Pass', evidenceKind: 'aoi-inspection',
            evidenceId: 'AOI-A-028', reason: 'Later synthetic AOI confirms action',
            at: '2026-08-29T10:00:00.000Z' };
        assert.throws(() => reviewCapaAction(db, { ...review, actorId: 'ACT-Q1' }),
            /independent|review|actor/i);
        const beforeRejectedReview = db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        const stateBeforeRejectedReview = db.prepare('SELECT updated_at FROM incidents WHERE id=?')
            .get(startInput.incidentId).updated_at;
        assert.throws(() => reviewCapaAction(db, { ...review,
            evidenceId: 'AOI-A-026' }), /source|review|evidence/i);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,
            beforeRejectedReview);
        assert.equal(db.prepare('SELECT updated_at FROM incidents WHERE id=?')
            .get(startInput.incidentId).updated_at, stateBeforeRejectedReview);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capa_action_reviews').get().n, 0);
        assert.throws(() => reviewCapaAction(db, { ...review,
            at: '2099-01-01T00:00:00.000Z', serverNow: review.at }), /server UTC/i);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capa_action_reviews').get().n, 0);
        const accepted = reviewCapaAction(db, review);
        assert.equal(accepted.decision, 'Pass');
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit_events
            WHERE action IN ('capa-action-recorded','capa-action-reviewed')`).get().n, 2);
        assert.throws(() => reviewCapaAction(db, { ...review,
            at: '2026-08-29T10:01:00.000Z' }), /review|duplicate|data/i);
    } finally {
        db.close();
    }
});

test('Needs Rework preserves the original action and requires a reviewed parent', () => {
    const db = scenario();
    try {
        startIncidentCapa(db, startInput);
        const context = { incidentId: startInput.incidentId, expectedRevisionNo: 1,
            cycleId: 'INC-CAPA-SERVICE-CYC-1' };
        assessIncidentCause(db, { ...context, id: 'CAUSE-REWORK',
            actorId: 'ACT-Q1', at: at(13), status: 'Confirmed',
            statement: 'Synthetic source-confirmed issue',
            evidenceKind: 'equipment-event', evidenceId: 'EV-DETECTION' });
        const base = { ...context, actorId: 'ACT-Q1', ownerActorId: 'ACT-EQP',
            causeId: 'CAUSE-REWORK', actionType: 'Corrective',
            dueAt: '2026-09-02T00:00:00.000Z' };
        planCapaAction(db, { ...base, id: 'CAPA-FIRST',
            actionText: 'Initial fixture correction', at: at(14) });
        assert.throws(() => planCapaAction(db, { ...base, id: 'CAPA-EARLY',
            parentActionId: 'CAPA-FIRST', actionText: 'Unreviewed replacement',
            at: at(15) }), /review|rework|parent|CAPA/i);
        reviewCapaAction(db, { ...context, actionId: 'CAPA-FIRST',
            actorId: 'ACT-REV', decision: 'Needs Rework',
            evidenceKind: 'aoi-inspection', evidenceId: 'AOI-A-028',
            reason: 'Synthetic AOI remains unsuitable', at: '2026-08-29T10:00:00.000Z' });
        const replacement = planCapaAction(db, { ...base, id: 'CAPA-SECOND',
            parentActionId: 'CAPA-FIRST', actionText: 'Revised fixture correction',
            at: '2026-08-29T11:00:00.000Z' });
        assert.equal(replacement.parentActionId, 'CAPA-FIRST');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capa_actions').get().n, 2);
        assert.equal(db.prepare('SELECT decision FROM capa_action_reviews WHERE action_id=?')
            .get('CAPA-FIRST').decision, 'Needs Rework');
    } finally {
        db.close();
    }
});
