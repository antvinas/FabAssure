import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { createIncident, containIncident, recordIncidentLkg,
    proposeIncidentTrace, reviewIncidentScope } from '../src/domain/incident-service.mjs';
import { startIncidentCapa, assessIncidentCause, planCapaAction,
    reviewCapaAction } from '../src/domain/capa-service.mjs';
import { proposeDocumentFeedback, reviewDocumentFeedback,
    approveDocumentRevision } from '../src/domain/document-service.mjs';

const at = minute => `2026-08-27T10:${String(minute).padStart(2, '0')}:00.000Z`;

function fixture() {
    const db = openDatabase(':memory:');
    seedDatabase(db, { instanceId: 'DATASET-FEEDBACK-TEST' });
    const incidentId = 'INC-FEEDBACK';
    createIncident(db, { id: incidentId, title: 'Synthetic vision defect excursion',
        actorId: 'ACT-Q1', defectCodeId: 'DEF-FIDUCIAL',
        detectionEventId: 'EV-DETECTION', observedLotId: 'LOT-A-026',
        recipeRevisionId: 'REC-ALIGN-R3', detectedAt: at(0), at: at(2) });
    containIncident(db, { incidentId, expectedRevisionNo: 1, actorId: 'ACT-PROD',
        ownerActorId: 'ACT-PROD', heldLotIds: ['LOT-A-025', 'LOT-A-026', 'LOT-A-027'],
        reason: 'Synthetic lot hold', at: at(4) });
    recordIncidentLkg(db, { incidentId, expectedRevisionNo: 1, actorId: 'ACT-Q1',
        aoiInspectionId: 'AOI-A-025', earliestPossibleAt: '2026-08-25T08:00:00.000Z',
        latestPossibleAt: '2026-08-25T12:00:00.000Z', method: 'Synthetic AOI screen',
        sampleScope: '100 units', limitation: 'Intermediate units uncertain', at: at(6) });
    const proposal = proposeIncidentTrace(db, { incidentId, expectedRevisionNo: 1,
        actorId: 'ACT-Q1', at: at(8) });
    reviewIncidentScope(db, { incidentId, expectedRevisionNo: 1,
        proposalId: proposal.proposalId, actorId: 'ACT-REV', decision: 'Pass',
        reason: 'Synthetic independent scope review',
        lotDecisions: proposal.lots.map(lot => ({ lotId: lot.lotId,
            scopeStatus: lot.classification === 'excluded' ? 'excluded' :
                lot.classification === 'ambiguous' ? 'ambiguous' : 'included',
            containment: lot.classification === 'excluded' ? 'No Change' : 'Held',
            reason: `Synthetic ${lot.classification} decision` })), at: at(10) });
    const cycleId = startIncidentCapa(db, { incidentId, expectedRevisionNo: 1,
        actorId: 'ACT-Q1', reason: 'Synthetic CAPA', at: at(11) }).cycleId;
    assessIncidentCause(db, { incidentId, expectedRevisionNo: 1, cycleId,
        id: 'CAUSE-FEEDBACK', actorId: 'ACT-Q1', status: 'Confirmed',
        statement: 'Synthetic module shift source', evidenceKind: 'equipment-event',
        evidenceId: 'EV-DETECTION', at: at(13) });
    planCapaAction(db, { incidentId, expectedRevisionNo: 1, cycleId,
        id: 'CAPA-FEEDBACK', actorId: 'ACT-Q1', ownerActorId: 'ACT-EQP',
        causeId: 'CAUSE-FEEDBACK', actionType: 'Corrective',
        actionText: 'Synthetic alignment adjustment',
        dueAt: '2026-09-01T00:00:00.000Z', at: at(14) });
    const actionReviewId = reviewCapaAction(db, { incidentId,
        expectedRevisionNo: 1, cycleId, actionId: 'CAPA-FEEDBACK',
        actorId: 'ACT-REV', decision: 'Pass', evidenceKind: 'aoi-inspection',
        evidenceId: 'AOI-A-028', reason: 'Synthetic later AOI evidence',
        at: '2026-08-29T10:00:00.000Z' }).reviewId;
    return { db, incidentId, cycleId, actionReviewId };
}

test('PFMEA feedback follows reviewed CAPA, independent review and separate approval', () => {
    const { db, incidentId, cycleId, actionReviewId } = fixture();
    try {
        const common = { incidentId, expectedRevisionNo: 1, cycleId };
        const proposal = { ...common, id: 'FB-PFMEA-SERVICE',
            documentId: 'DOC-CAM-PFMEA', baseRevisionId: 'DOC-CAM-PFMEA-R1',
            capaActionId: 'CAPA-FEEDBACK', actorId: 'ACT-Q1',
            proposedSummary: 'Synthetic revision: fixture check before AOI release',
            at: '2026-08-29T11:00:00.000Z' };
        assert.throws(() => proposeDocumentFeedback(db, { ...proposal,
            baseRevisionId: 'DOC-CAM-WI-R1' }), /document|revision|feedback/i);
        const created = proposeDocumentFeedback(db, proposal);
        assert.equal(created.feedbackId, proposal.id);
        const review = { ...common, feedbackId: proposal.id, actorId: 'ACT-REV',
            decision: 'Pass', verificationKind: 'capa-review',
            verificationId: actionReviewId, reason: 'Synthetic CAPA review link',
            at: '2026-08-29T12:00:00.000Z' };
        assert.throws(() => reviewDocumentFeedback(db, { ...review,
            actorId: 'ACT-Q1' }), /independent|review|actor/i);
        assert.throws(() => reviewDocumentFeedback(db, { ...review,
            verificationKind: 'external' }), /verification|kind/i);
        assert.equal(reviewDocumentFeedback(db, review).decision, 'Pass');
        const approve = { ...common, feedbackId: proposal.id, actorId: 'ACT-APP',
            reason: 'Synthetic document control acceptance',
            at: '2026-08-29T13:00:00.000Z' };
        assert.throws(() => approveDocumentRevision(db, { ...approve,
            actorId: 'ACT-Q1' }), /separate|approver|actor/i);
        const revision = approveDocumentRevision(db, approve);
        assert.equal(revision.revisionId, 'DOC-CAM-PFMEA-R2');
        assert.deepEqual(db.prepare(`SELECT revision_no,parent_revision_id,
            source_feedback_id,approved_by FROM document_revisions
            WHERE document_id='DOC-CAM-PFMEA' ORDER BY revision_no`).all()
            .map(row => ({ ...row })), [
            { revision_no: 1, parent_revision_id: null,
                source_feedback_id: null, approved_by: 'ACT-APP' },
            { revision_no: 2, parent_revision_id: 'DOC-CAM-PFMEA-R1',
                source_feedback_id: proposal.id, approved_by: 'ACT-APP' }
        ]);
        assert.throws(() => proposeDocumentFeedback(db, { ...proposal,
            id: 'FB-STALE', at: '2026-08-29T14:00:00.000Z' }),
        /current|revision|feedback/i);
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action IN
            ('document-feedback-proposed','document-feedback-reviewed','document-revision-approved')`)
            .get().n, 3);
    } finally {
        db.close();
    }
});

test('all three synthetic document types keep separate controlled revision chains', () => {
    const { db, incidentId, cycleId, actionReviewId } = fixture();
    try {
        const items = [
            ['DOC-CAM-PFMEA', 'PFMEA', 11],
            ['DOC-CAM-CP', 'Control Plan', 14],
            ['DOC-CAM-WI', 'WI', 17]
        ];
        for (const [documentId, type, hour] of items) {
            const feedbackId = `FB-${type.replaceAll(' ', '-').toUpperCase()}`;
            const clock = offset => `2026-08-29T${String(hour + offset).padStart(2, '0')}:00:00.000Z`;
            proposeDocumentFeedback(db, { id: feedbackId, incidentId,
                expectedRevisionNo: 1, cycleId, documentId,
                baseRevisionId: `${documentId}-R1`, capaActionId: 'CAPA-FEEDBACK',
                actorId: 'ACT-Q1', proposedSummary: `Synthetic ${type} prevention feedback`,
                at: clock(0) });
            reviewDocumentFeedback(db, { incidentId, expectedRevisionNo: 1,
                cycleId, feedbackId, actorId: 'ACT-REV', decision: 'Pass',
                verificationKind: 'capa-review', verificationId: actionReviewId,
                reason: `Synthetic ${type} source verification`, at: clock(1) });
            approveDocumentRevision(db, { incidentId, expectedRevisionNo: 1,
                cycleId, feedbackId, actorId: 'ACT-APP',
                reason: `Synthetic ${type} approval`, at: clock(2) });
        }
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM document_revisions
            WHERE revision_no=2`).get().n, 3);
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM feedback_actions`).get().n, 3);
    } finally {
        db.close();
    }
});
