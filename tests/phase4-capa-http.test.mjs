import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { createLocalServer, listenLocal } from '../src/server/http.mjs';

async function fixture(run) {
    const db = openDatabase(':memory:');
    const assetsDir = mkdtempSync(join(tmpdir(), 'fabassure-capa-http-'));
    for (const name of ['index.html', 'app.js', 'styles.css']) {
        writeFileSync(join(assetsDir, name), `Synthetic ${name}`);
    }
    let server;
    try {
        seedDatabase(db, { instanceId: 'DATASET-CAPA-HTTP' });
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
        return await run({ db, local, action });
    } finally {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        db.close();
        rmSync(assetsDir, { recursive: true, force: true });
    }
}

test('FabTrace HTTP exposes audited CAPA and controlled-document decision lineage', () => fixture(async ({ db, local, action }) => {
    const incidentId = 'INC-CAPA-HTTP';
    const common = { incidentId, expectedRevisionNo: 1 };
    const ok = async (name, input) => {
        const result = await action(name, input);
        assert.equal(result.status, 200, `${name}: ${JSON.stringify(result.body)}`);
        return result.body.result;
    };
    const denied = async (name, input, status = 409) => {
        const before = db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        const result = await action(name, input);
        assert.equal(result.status, status, `${name}: ${JSON.stringify(result.body)}`);
        assert.equal(result.body.error.code, 'GATE_DENIED');
        assert.doesNotMatch(JSON.stringify(result.body), /SQLITE|SELECT\s|INSERT\s|\/src\//i);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, before);
        return result;
    };
    await ok('createIncident', { id: incidentId,
        title: 'Synthetic post-maintenance fiducial excursion', actorId: 'ACT-Q1',
        defectCodeId: 'DEF-FIDUCIAL', detectionEventId: 'EV-DETECTION',
        observedLotId: 'LOT-A-026', recipeRevisionId: 'REC-ALIGN-R3',
        detectedAt: '2026-08-27T10:00:00.000Z', at: '2026-08-27T10:02:00.000Z' });
    await ok('containIncident', { ...common, actorId: 'ACT-PROD',
        ownerActorId: 'ACT-PROD', heldLotIds: ['LOT-A-025', 'LOT-A-026', 'LOT-A-027'],
        reason: 'Synthetic lot hold', at: '2026-08-27T10:04:00.000Z' });
    await ok('recordIncidentLkg', { ...common, actorId: 'ACT-Q1',
        aoiInspectionId: 'AOI-A-025', earliestPossibleAt: '2026-08-25T08:00:00.000Z',
        latestPossibleAt: '2026-08-25T12:00:00.000Z', method: 'Synthetic AOI screen',
        sampleScope: '100 units', limitation: 'Intermediate units uncertain',
        at: '2026-08-27T10:06:00.000Z' });
    const proposal = await ok('proposeIncidentTrace', { ...common,
        actorId: 'ACT-Q1', at: '2026-08-27T10:08:00.000Z' });
    await ok('reviewIncidentScope', { ...common, proposalId: proposal.proposalId,
        actorId: 'ACT-REV', decision: 'Pass',
        reason: 'Independent synthetic scope review',
        lotDecisions: proposal.lots.map(lot => ({ lotId: lot.lotId,
            scopeStatus: lot.classification === 'excluded' ? 'excluded' :
                lot.classification === 'ambiguous' ? 'ambiguous' : 'included',
            containment: lot.classification === 'excluded' ? 'No Change' : 'Held',
            reason: `Synthetic ${lot.classification} scope` })),
        at: '2026-08-27T10:10:00.000Z' });
    await denied('startIncidentCapa', { ...common,
        actorId: 'ACT-VER', reason: 'Wrong simulated role',
        at: '2026-08-27T10:11:00.000Z' });
    const started = await ok('startIncidentCapa', { ...common,
        actorId: 'ACT-Q1', reason: 'Synthetic CAPA start',
        at: '2026-08-27T10:11:00.000Z' });
    assert.equal(started.cycleId, `${incidentId}-CYC-1`);
    const cycleId = started.cycleId;
    await denied('assessIncidentCause', { ...common, cycleId: 'INC-WRONG-CYC-1',
        id: 'CAUSE-WRONG-HTTP', actorId: 'ACT-Q1', status: 'Confirmed',
        statement: 'Wrong incident cycle', evidenceKind: 'equipment-event',
        evidenceId: 'EV-DETECTION', at: '2026-08-27T10:12:00.000Z' });
    await ok('assessIncidentCause', { ...common, cycleId,
        id: 'CAUSE-HTTP', actorId: 'ACT-Q1', status: 'Confirmed',
        statement: 'Synthetic module shift hypothesis confirmed',
        evidenceKind: 'equipment-event', evidenceId: 'EV-DETECTION',
        at: '2026-08-27T10:13:00.000Z' });
    await ok('planCapaAction', { ...common, cycleId,
        id: 'CAPA-HTTP', actorId: 'ACT-Q1', ownerActorId: 'ACT-EQP',
        causeId: 'CAUSE-HTTP', actionType: 'Corrective',
        actionText: 'Synthetic fixture check', dueAt: '2026-09-01T00:00:00.000Z',
        at: '2026-08-27T10:14:00.000Z' });
    const wrongReviewer = await denied('reviewCapaAction', { ...common, cycleId,
        actionId: 'CAPA-HTTP', actorId: 'ACT-Q1', decision: 'Pass',
        evidenceKind: 'aoi-inspection', evidenceId: 'AOI-A-028',
        reason: 'Must be independent', at: '2026-08-29T10:00:00.000Z' });
    assert.equal(wrongReviewer.status, 409);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capa_action_reviews').get().n, 0);
    const reviewed = await ok('reviewCapaAction', { ...common, cycleId,
        actionId: 'CAPA-HTTP', actorId: 'ACT-REV', decision: 'Pass',
        evidenceKind: 'aoi-inspection', evidenceId: 'AOI-A-028',
        reason: 'Synthetic later AOI source', at: '2026-08-29T10:00:00.000Z' });
    await ok('proposeDocumentFeedback', { ...common, cycleId,
        id: 'FB-HTTP-PFMEA', documentId: 'DOC-CAM-PFMEA',
        baseRevisionId: 'DOC-CAM-PFMEA-R1', capaActionId: 'CAPA-HTTP',
        actorId: 'ACT-Q1', proposedSummary: 'Synthetic revised detection control',
        at: '2026-08-29T11:00:00.000Z' });
    await denied('reviewDocumentFeedback', { ...common, cycleId,
        feedbackId: 'FB-HTTP-PFMEA', actorId: 'ACT-Q1', decision: 'Pass',
        verificationKind: 'capa-review', verificationId: reviewed.reviewId,
        reason: 'Same proposer cannot review', at: '2026-08-29T12:00:00.000Z' });
    await ok('reviewDocumentFeedback', { ...common, cycleId,
        feedbackId: 'FB-HTTP-PFMEA', actorId: 'ACT-REV', decision: 'Pass',
        verificationKind: 'capa-review', verificationId: reviewed.reviewId,
        reason: 'Synthetic source review', at: '2026-08-29T12:00:00.000Z' });
    await denied('approveDocumentRevision', { ...common, cycleId,
        feedbackId: 'FB-HTTP-PFMEA', actorId: 'ACT-REV',
        reason: 'Reviewer cannot approve same revision', at: '2026-08-29T13:00:00.000Z' });
    const approved = await ok('approveDocumentRevision', { ...common, cycleId,
        feedbackId: 'FB-HTTP-PFMEA', actorId: 'ACT-APP',
        reason: 'Synthetic document approval', at: '2026-08-29T13:00:00.000Z' });
    assert.equal(approved.revisionId, 'DOC-CAM-PFMEA-R2');

    const response = await fetch(`${local.url}/api/incidents/${incidentId}`);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.incident.state, 'CAPA In Progress');
    assert.equal(detail.capaCycles[0].id, cycleId);
    assert.equal(detail.causeAssessments[0].evidence_id, 'EV-DETECTION');
    assert.equal(detail.capaActions[0].review.id, reviewed.reviewId);
    assert.equal(detail.documentFeedback[0].review.verification_id, reviewed.reviewId);
    const pfmea = detail.controlledDocuments.find(doc => doc.id === 'DOC-CAM-PFMEA');
    assert.deepEqual(pfmea.revisions.map(rev => rev.id), [
        'DOC-CAM-PFMEA-R1', 'DOC-CAM-PFMEA-R2'
    ]);
    assert.equal(pfmea.revisions[1].source_feedback_id, 'FB-HTTP-PFMEA');
    assert.equal(pfmea.revisions[1].source_incident_id, incidentId);
    assert.equal(pfmea.revisions[1].source_cycle_id, cycleId);
    assert.equal(detail.audit.at(-1).action, 'document-revision-approved');
    assert.equal(detail.audit.at(-1).payload.revisionId, approved.revisionId);

    const peerId = 'INC-CAPA-PEER';
    await ok('createIncident', { id: peerId,
        title: 'Synthetic second incident sharing controlled documents',
        actorId: 'ACT-Q1', defectCodeId: 'DEF-FIDUCIAL',
        detectionEventId: 'EV-DETECTION', observedLotId: 'LOT-A-026',
        recipeRevisionId: 'REC-ALIGN-R3', detectedAt: '2026-08-27T10:00:00.000Z',
        at: '2026-08-29T13:02:00.000Z' });
    const peer = await (await fetch(`${local.url}/api/incidents/${peerId}`)).json();
    assert.equal(peer.documentFeedback.length, 0);
    const shared = peer.controlledDocuments.find(doc => doc.id === 'DOC-CAM-PFMEA');
    assert.equal(shared.revisions[1].source_feedback_id, 'FB-HTTP-PFMEA');
    assert.equal(shared.revisions[1].source_incident_id, incidentId);
    assert.equal(shared.revisions[1].source_cycle_id, cycleId);
    assert.notEqual(shared.revisions[1].source_incident_id, peerId);
}));

test('new CAPA actions retain local-origin and allowlist boundaries', () => fixture(async ({ db, local }) => {
    const body = JSON.stringify({ action: 'startIncidentCapa', input: {
        incidentId: 'INC-NO-SUCH-RECORD', expectedRevisionNo: 1,
        actorId: 'ACT-Q1', reason: 'Synthetic probe',
        at: '2026-08-27T10:11:00.000Z' } });
    const post = headers => fetch(`${local.url}/api/actions`, {
        method: 'POST', headers, body });
    assert.equal((await post({ 'content-type': 'application/json',
        origin: local.url })).status, 403);
    assert.equal((await post({ 'content-type': 'application/json',
        'x-fabassure-local': '1', origin: 'https://unrelated.invalid' })).status, 403);
    const unsupported = await fetch(`${local.url}/api/actions`, { method: 'POST',
        headers: { 'content-type': 'application/json',
            'x-fabassure-local': '1', origin: local.url },
        body: JSON.stringify({ action: 'deleteAll', input: {} }) });
    assert.equal(unsupported.status, 400);
    const unknown = await post({ 'content-type': 'application/json',
        'x-fabassure-local': '1', origin: local.url });
    assert.equal(unknown.status, 409);
    const error = await unknown.json();
    assert.equal(error.error.code, 'GATE_DENIED');
    assert.doesNotMatch(JSON.stringify(error), /INC-NO-SUCH-RECORD|SQLITE|SELECT\s|\/src\//i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 0);
}));
