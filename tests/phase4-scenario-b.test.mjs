import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { createLocalServer, listenLocal } from '../src/server/http.mjs';

const incidentId = 'INC-SCENARIO-B';
const cycleId = `${incidentId}-CYC-1`;

test('Scenario B links containment, CAPA, independent action review and R1-to-R2 feedback over local HTTP', async () => {
    const db = openDatabase(':memory:');
    let server;
    try {
        seedDatabase(db, { instanceId: 'DATASET-SCENARIO-B' });
        server = createLocalServer(db, { assetsDir: fileURLToPath(new URL('../assets/ui/', import.meta.url)) });
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
        const common = { incidentId, expectedRevisionNo: 1 };
        await action('createIncident', { id: incidentId,
            title: 'Synthetic post-maintenance fiducial excursion', actorId: 'ACT-Q1',
            defectCodeId: 'DEF-FIDUCIAL', detectionEventId: 'EV-DETECTION',
            observedLotId: 'LOT-A-026', recipeRevisionId: 'REC-ALIGN-R3',
            detectedAt: '2026-08-27T10:00:00.000Z', at: '2026-08-27T10:02:00.000Z' });
        await action('containIncident', { ...common, actorId: 'ACT-PROD',
            ownerActorId: 'ACT-PROD', heldLotIds: ['LOT-A-025', 'LOT-A-026', 'LOT-A-027'],
            reason: 'Synthetic excursion containment', at: '2026-08-27T10:04:00.000Z' });
        await action('recordIncidentLkg', { ...common, actorId: 'ACT-Q1',
            aoiInspectionId: 'AOI-A-025', earliestPossibleAt: '2026-08-25T08:00:00.000Z',
            latestPossibleAt: '2026-08-25T12:00:00.000Z', method: 'Synthetic AOI screen',
            sampleScope: '100 inspected units', limitation: 'Intermediate units uncertain',
            at: '2026-08-27T10:06:00.000Z' });
        const proposal = await action('proposeIncidentTrace', { ...common,
            actorId: 'ACT-Q1', at: '2026-08-27T10:08:00.000Z' });
        await action('reviewIncidentScope', { ...common, proposalId: proposal.proposalId,
            actorId: 'ACT-REV', decision: 'Pass',
            reason: 'Independent synthetic source scope review',
            lotDecisions: proposal.lots.map(lot => ({ lotId: lot.lotId,
                scopeStatus: lot.classification === 'excluded' ? 'excluded' :
                    lot.classification === 'ambiguous' ? 'ambiguous' : 'included',
                containment: lot.classification === 'excluded' ? 'No Change' : 'Held',
                reason: `Synthetic ${lot.classification} disposition` })),
            at: '2026-08-27T10:10:00.000Z' });
        const cycle = await action('startIncidentCapa', { ...common,
            actorId: 'ACT-Q1', reason: 'Reviewed exposure scope requires CAPA',
            at: '2026-08-27T10:11:00.000Z' });
        assert.equal(cycle.cycleId, cycleId);
        const causeId = 'CAUSE-SCENARIO-B';
        await action('assessIncidentCause', { ...common, cycleId,
            id: causeId, actorId: 'ACT-Q1', status: 'Confirmed',
            statement: 'Synthetic fixture datum shifted after service',
            evidenceKind: 'equipment-event', evidenceId: 'EV-DETECTION',
            at: '2026-08-27T10:13:00.000Z' });
        const actions = [
            { id: 'CAPA-SCENARIO-B-CORR', actionType: 'Corrective',
                ownerActorId: 'ACT-EQP', evidenceId: 'AOI-A-028',
                actionText: 'Restore the alignment fixture datum',
                createdAt: '2026-08-27T10:14:00.000Z',
                reviewedAt: '2026-08-29T10:00:00.000Z' },
            { id: 'CAPA-SCENARIO-B-PREV', actionType: 'Preventive',
                ownerActorId: 'ACT-MFG', evidenceId: 'AOI-A-030',
                actionText: 'Add a post-service fixture check to standard work',
                createdAt: '2026-08-27T10:15:00.000Z',
                reviewedAt: '2026-08-30T11:00:00.000Z' }
        ];
        for (const item of actions) {
            await action('planCapaAction', { ...common, cycleId,
                id: item.id, actorId: 'ACT-Q1', ownerActorId: item.ownerActorId,
                causeId, actionType: item.actionType, actionText: item.actionText,
                dueAt: '2026-09-01T00:00:00.000Z', at: item.createdAt });
        }
        const auditBeforeRejected = db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        const updatedBeforeRejected = db.prepare('SELECT updated_at FROM incidents WHERE id=?')
            .get(incidentId).updated_at;
        await action('reviewCapaAction', { ...common, cycleId,
            actionId: actions[0].id, actorId: 'ACT-Q1', decision: 'Pass',
            evidenceKind: 'aoi-inspection', evidenceId: actions[0].evidenceId,
            reason: 'Proposer cannot independently review',
            at: '2026-08-29T10:01:00.000Z' }, 409);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,
            auditBeforeRejected);
        assert.equal(db.prepare('SELECT updated_at FROM incidents WHERE id=?')
            .get(incidentId).updated_at, updatedBeforeRejected);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capa_action_reviews').get().n, 0);
        for (const item of actions) {
            await action('reviewCapaAction', { ...common, cycleId,
                actionId: item.id, actorId: 'ACT-REV', decision: 'Pass',
                evidenceKind: 'aoi-inspection', evidenceId: item.evidenceId,
                reason: `Independent synthetic review of ${item.actionType.toLowerCase()} action`,
                at: item.reviewedAt });
        }
        const feedbackId = 'FB-SCENARIO-B-PFMEA';
        await action('proposeDocumentFeedback', { ...common, cycleId,
            id: feedbackId, documentId: 'DOC-CAM-PFMEA',
            baseRevisionId: 'DOC-CAM-PFMEA-R1',
            capaActionId: actions[1].id, actorId: 'ACT-Q1',
            proposedSummary: 'Add post-service alignment fixture verification',
            at: '2026-08-30T12:00:00.000Z' });
        await action('reviewDocumentFeedback', { ...common, cycleId,
            feedbackId, actorId: 'ACT-REV', decision: 'Pass',
            verificationKind: 'capa-review', verificationId: `${actions[1].id}-REVIEW`,
            reason: 'Independent source review confirms the prevention item',
            at: '2026-08-30T13:00:00.000Z' });
        const revision = await action('approveDocumentRevision', { ...common, cycleId,
            feedbackId, actorId: 'ACT-APP',
            reason: 'Separate synthetic controlled-document approval',
            at: '2026-08-30T14:00:00.000Z' });
        assert.equal(revision.revisionId, 'DOC-CAM-PFMEA-R2');

        const peerId = 'INC-SCENARIO-B-PEER';
        await action('createIncident', { id: peerId,
            title: 'Synthetic incident sharing the equipment and defect standard',
            actorId: 'ACT-Q1', defectCodeId: 'DEF-FIDUCIAL',
            detectionEventId: 'EV-DETECTION', observedLotId: 'LOT-A-026',
            recipeRevisionId: 'REC-ALIGN-R3', detectedAt: '2026-08-27T10:00:00.000Z',
            at: '2026-08-30T15:00:00.000Z' });
        const detail = await (await fetch(`${local.url}/api/incidents/${incidentId}`)).json();
        const peer = await (await fetch(`${local.url}/api/incidents/${peerId}`)).json();
        assert.equal(detail.incident.state, 'CAPA In Progress');
        assert.deepEqual(detail.capaActions.map(item => item.action_type), ['Corrective', 'Preventive']);
        assert.equal(detail.documentFeedback[0].review.reviewer_actor_id, 'ACT-REV');
        const document = detail.controlledDocuments.find(item => item.id === 'DOC-CAM-PFMEA');
        assert.deepEqual(document.revisions.map(item => item.id),
            ['DOC-CAM-PFMEA-R1', 'DOC-CAM-PFMEA-R2']);
        assert.equal(document.revisions[1].source_feedback_id, feedbackId);
        assert.equal(document.revisions[1].source_incident_id, incidentId);
        assert.equal(document.revisions[1].source_cycle_id, cycleId);
        assert.equal(document.revisions[1].approved_by, 'ACT-APP');
        assert.equal(peer.documentFeedback.length, 0);
        const shared = peer.controlledDocuments.find(item => item.id === 'DOC-CAM-PFMEA');
        assert.equal(shared.revisions[1].source_incident_id, incidentId);
        assert.equal(shared.revisions[1].source_cycle_id, cycleId);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE entity_id=?')
            .get(incidentId).n, 14);
        const audit = db.prepare(`SELECT id,action,digest FROM audit_events
            WHERE entity_id=? ORDER BY sequence`).all(incidentId).map(row => ({ ...row }));
        assert.deepEqual(audit.map(item => item.action), [
            'incident-created', 'incident-contained', 'lkg-recorded', 'trace-proposed',
            'scope-reviewed', 'capa-started', 'cause-assessed', 'capa-action-recorded',
            'capa-action-recorded', 'capa-action-reviewed', 'capa-action-reviewed',
            'document-feedback-proposed', 'document-feedback-reviewed',
            'document-revision-approved'
        ]);
        assert.equal(new Set(audit.map(item => item.id)).size, audit.length);
        assert.ok(audit.every(item => item.digest.length === 64));
        console.log('Scenario B evidence:', JSON.stringify({ incidentId, cycleId, causeId,
            actionIds: actions.map(item => item.id), feedbackId,
            revisionId: revision.revisionId,
            sourceIncidentId: document.revisions[1].source_incident_id,
            sourceCycleId: document.revisions[1].source_cycle_id,
            sharedDocumentId: 'DOC-CAM-PFMEA',
            revisionIds: document.revisions.map(item => item.id),
            audit: audit.map(({ id, action, digest }) => ({ id, action,
                digestPrefix: digest.slice(0, 12) })) }, null, 2));
    } finally {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        db.close();
    }
});
