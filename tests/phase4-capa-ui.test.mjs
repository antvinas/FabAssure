import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { createIncident, containIncident, recordIncidentLkg,
    proposeIncidentTrace, reviewIncidentScope } from '../src/domain/incident-service.mjs';
import { startIncidentCapa, assessIncidentCause, planCapaAction,
    reviewCapaAction } from '../src/domain/capa-service.mjs';
import { proposeDocumentFeedback, reviewDocumentFeedback,
    approveDocumentRevision } from '../src/domain/document-service.mjs';
import { createLocalServer, listenLocal } from '../src/server/http.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const assetsDir = join(root, 'assets', 'ui');
const incidentId = 'INC-CAPA-UI';
const cycleId = `${incidentId}-CYC-1`;

function seedScenarioB(db, { complete = true } = {}) {
    seedDatabase(db, { instanceId: 'DATASET-CAPA-UI' });
    createIncident(db, { id: incidentId,
        title: 'Synthetic post-maintenance fiducial excursion', actorId: 'ACT-Q1',
        defectCodeId: 'DEF-FIDUCIAL', detectionEventId: 'EV-DETECTION',
        observedLotId: 'LOT-A-026', recipeRevisionId: 'REC-ALIGN-R3',
        detectedAt: '2026-08-27T10:00:00.000Z', at: '2026-08-27T10:02:00.000Z' });
    containIncident(db, { incidentId, expectedRevisionNo: 1, actorId: 'ACT-PROD',
        ownerActorId: 'ACT-PROD', heldLotIds: ['LOT-A-025', 'LOT-A-026', 'LOT-A-027'],
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
        reason: 'Synthetic independent source scope review',
        lotDecisions: proposal.lots.map(lot => ({ lotId: lot.lotId,
            scopeStatus: lot.classification === 'excluded' ? 'excluded' :
                lot.classification === 'ambiguous' ? 'ambiguous' : 'included',
            containment: lot.classification === 'excluded' ? 'No Change' : 'Held',
            reason: `Synthetic ${lot.classification} disposition` })),
        at: '2026-08-27T10:10:00.000Z' });
    if (!complete) return;
    startIncidentCapa(db, { incidentId, expectedRevisionNo: 1, actorId: 'ACT-Q1',
        reason: 'Source trace warrants CAPA', at: '2026-08-27T10:11:00.000Z' });
    assessIncidentCause(db, { incidentId, expectedRevisionNo: 1, cycleId,
        id: 'CAUSE-CAPA-UI', actorId: 'ACT-Q1', status: 'Confirmed',
        statement: 'Synthetic alignment fixture shifted after service',
        evidenceKind: 'equipment-event', evidenceId: 'EV-DETECTION',
        at: '2026-08-27T10:13:00.000Z' });
    const actions = [
        ['CAPA-CORR-UI', 'Corrective', 'ACT-EQP',
            'Restore the synthetic alignment fixture datum', '2026-08-27T10:14:00.000Z', 'AOI-A-028'],
        ['CAPA-PREV-UI', 'Preventive', 'ACT-MFG',
            'Add post-service fixture verification to the standard work', '2026-08-27T10:15:00.000Z', 'AOI-A-030']
    ];
    for (const [id, actionType, ownerActorId, actionText, actionAt] of actions) {
        planCapaAction(db, { incidentId, expectedRevisionNo: 1, cycleId,
            id, actorId: 'ACT-Q1', ownerActorId, causeId: 'CAUSE-CAPA-UI',
            actionType, actionText, dueAt: '2026-09-01T00:00:00.000Z',
            at: actionAt });
    }
    for (const [index, [id, , , , , inspectionId]] of actions.entries()) {
        reviewCapaAction(db, { incidentId, expectedRevisionNo: 1, cycleId,
            actionId: id, actorId: 'ACT-REV', decision: 'Pass',
            evidenceKind: 'aoi-inspection', evidenceId: inspectionId,
            reason: 'Synthetic independent later-AOI review',
            at: index === 0 ? '2026-08-29T10:00:00.000Z' :
                '2026-08-30T11:00:00.000Z' });
    }
    proposeDocumentFeedback(db, { incidentId, expectedRevisionNo: 1, cycleId,
        id: 'FB-CAPA-UI', documentId: 'DOC-CAM-PFMEA',
        baseRevisionId: 'DOC-CAM-PFMEA-R1', capaActionId: 'CAPA-PREV-UI',
        actorId: 'ACT-Q1', proposedSummary: 'Add post-service fixture verification',
        at: '2026-08-30T12:00:00.000Z' });
    reviewDocumentFeedback(db, { incidentId, expectedRevisionNo: 1, cycleId,
        feedbackId: 'FB-CAPA-UI', actorId: 'ACT-REV', decision: 'Pass',
        verificationKind: 'capa-review', verificationId: 'CAPA-PREV-UI-REVIEW',
        reason: 'Independent synthetic PFMEA feedback review',
        at: '2026-08-30T13:00:00.000Z' });
    approveDocumentRevision(db, { incidentId, expectedRevisionNo: 1, cycleId,
        feedbackId: 'FB-CAPA-UI', actorId: 'ACT-APP',
        reason: 'Separate synthetic controlled-document approval',
        at: '2026-08-30T14:00:00.000Z' });
    createIncident(db, { id: 'INC-CAPA-UI-PEER',
        title: 'Synthetic peer incident sharing the controlled standard', actorId: 'ACT-Q1',
        defectCodeId: 'DEF-FIDUCIAL', detectionEventId: 'EV-DETECTION',
        observedLotId: 'LOT-A-026', recipeRevisionId: 'REC-ALIGN-R3',
        detectedAt: '2026-08-27T10:00:00.000Z', at: '2026-08-30T15:00:00.000Z' });
}

async function renderedIncident(run, { complete = true } = {}) {
    const db = openDatabase(':memory:');
    let server;
    try {
        seedScenarioB(db, { complete });
        server = createLocalServer(db, { assetsDir });
        const local = await listenLocal(server, 0);
        const handlers = new Map();
        const view = { innerHTML: '', focus() {} };
        const actorSelect = { innerHTML: '', value: 'ACT-MFG', selectedOptions: [],
            addEventListener: (name, handler) => handlers.set(`actor-${name}`, handler) };
        const shellNode = () => ({ textContent: '', className: '', hidden: true, attributes: {},
            setAttribute(name, value) { this.attributes[name] = String(value); },
            addEventListener() {} });
        const elements = { view, 'actor-select': actorSelect,
            crumb: { textContent: '' }, toast: shellNode(), 'toast-message': shellNode(),
            'toast-close': shellNode(), 'live-region': shellNode(),
            actorName: shellNode(), actorRole: shellNode() };
        const shellSelectors = { '[data-actor-name]': 'actorName', '[data-actor-role]': 'actorRole' };
        const document = {
            getElementById: id => elements[id] ?? null,
            querySelector: selector => elements[shellSelectors[selector]] ?? null,
            querySelectorAll: () => [],
            addEventListener: (name, handler) => handlers.set(name, handler)
        };
        const context = { document, fetch: (path, options) => fetch(new URL(path, local.url), options),
            setTimeout, clearTimeout, crypto: globalThis.crypto, console,
            FormData: class { constructor(target) { this.fields = target.fields; }
                get(name) { return this.fields[name] ?? null; } } };
        runInNewContext(readFileSync(join(assetsDir, 'app.js'), 'utf8'), context);
        for (let attempt = 0; attempt < 100 && !view.innerHTML.includes('변경 관리 시작'); attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        const click = handlers.get('click');
        // Ordinary synthetic buttons carry no attributes, matching a real button without aria-disabled.
        const press = async dataset => click({ target: { closest: () => ({ dataset,
            getAttribute: () => null }) } });
        await press({ view: 'fabtrace' });
        await press({ openIncident: incidentId });
        context.handlers = handlers;
        return await run({ db, local, context, view, handlers, press, elements, actorSelect });
    } finally {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        db.close();
    }
}

test('FabTrace UI renders persisted CAPA and controlled-document feedback lineage', () =>
    renderedIncident(async ({ db, local, context, view, press }) => {
        assert.match(view.innerHTML, /INC-CAPA-UI/);
        assert.match(view.innerHTML, /CAPA 단계/i);
        assert.match(view.innerHTML, /CAUSE-CAPA-UI/);
        assert.match(view.innerHTML, /CAPA-CORR-UI/);
        assert.match(view.innerHTML, /CAPA-PREV-UI/);
        assert.match(view.innerHTML, /Independent Review|ACT-REV/);
        assert.match(view.innerHTML, /DOC-CAM-PFMEA-R1/);
        assert.match(view.innerHTML, /DOC-CAM-PFMEA-R2/);
        assert.match(view.innerHTML, /FB-CAPA-UI/);
        assert.match(view.innerHTML, /원천 사건/i);
        assert.match(view.innerHTML, /원천 사이클/i);
        assert.match(view.innerHTML, /ACT-Q1/);
        assert.match(view.innerHTML, /ACT-REV/);
        assert.match(view.innerHTML, /ACT-APP/);
        assert.match(view.innerHTML, /document-revision-approved/);

        const before = db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        const beforeUpdatedAt = db.prepare('SELECT updated_at FROM incidents WHERE id=?')
            .get(incidentId).updated_at;
        const rejected = await fetch(new URL('/api/actions', local.url), {
            method: 'POST', headers: { 'content-type': 'application/json',
                'x-fabassure-local': '1' }, body: JSON.stringify({ action: 'reviewCapaAction',
                input: { incidentId, expectedRevisionNo: 1, cycleId,
                    actionId: 'CAPA-CORR-UI', actorId: 'ACT-Q1', decision: 'Pass',
                    evidenceKind: 'aoi-inspection', evidenceId: 'AOI-A-028',
                    reason: 'Same proposer cannot independently review',
                    at: '2026-08-31T10:00:00.000Z' } }) });
        assert.equal(rejected.status, 409);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, before);
        assert.equal(db.prepare('SELECT updated_at FROM incidents WHERE id=?')
            .get(incidentId).updated_at, beforeUpdatedAt);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capa_action_reviews WHERE reviewer_actor_id=?')
            .get('ACT-Q1').n, 0);

        await context.reload();
        await press({ openIncident: incidentId });
        assert.match(view.innerHTML, /DOC-CAM-PFMEA-R2/);
        assert.match(view.innerHTML, /원천 사건/i);
        const peer = await (await fetch(new URL('/api/incidents/INC-CAPA-UI-PEER', local.url))).json();
        const shared = peer.controlledDocuments.find(doc => doc.id === 'DOC-CAM-PFMEA');
        assert.equal(shared.revisions[1].source_incident_id, incidentId);
        assert.equal(shared.revisions[1].source_cycle_id, cycleId);
        assert.equal(shared.revisions[1].approved_by, 'ACT-APP');
        await press({ openIncident: 'INC-CAPA-UI-PEER' });
        assert.match(view.innerHTML, /DOC-CAM-PFMEA-R2/);
        assert.match(view.innerHTML, /원천 사건/);
        assert.match(view.innerHTML, /INC-CAPA-UI-CYC-1/);
        assert.equal(context.document.getElementById('crumb').textContent, '영향 추적');
    }));

test('CAPA and document decisions can be completed through the local UI and persist after refresh', () =>
    renderedIncident(async ({ db, context, view, press, elements, actorSelect }) => {
        const setActor = id => {
            actorSelect.value = id;
            actorSelect.selectedOptions = [{ textContent: id }];
            context.handlers.get('actor-change')();
        };
        const act = async (kind, fields, marker) => {
            elements[`capa-${kind}-form`] = { fields };
            await press({ capaSubmit: kind });
            for (let attempt = 0; attempt < 100 && !marker.test(view.innerHTML); attempt++) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.match(view.innerHTML, new RegExp(marker));
        };
        assert.match(view.innerHTML, /CAPA 사이클 시작/);
        setActor('ACT-Q1');
        assert.match(elements.actorRole.textContent, /품질 엔지니어/);
        await act('start', { reason: 'Synthetic reviewed scope requires corrective follow-up' }, /INC-CAPA-UI-CYC-1/);
        await act('cause', { id: 'CAUSE-CAPA-UI', status: 'Confirmed',
            statement: 'Synthetic alignment fixture shifted after service',
            evidenceKind: 'equipment-event', evidenceId: 'EV-DETECTION' }, /CAUSE-CAPA-UI/);
        await act('action', { id: 'CAPA-CORR-UI', causeId: 'CAUSE-CAPA-UI',
            actionType: 'Corrective', ownerActorId: 'ACT-EQP',
            actionText: 'Restore the synthetic alignment fixture datum',
            dueAt: '2026-09-01T00:00:00.000Z' }, /CAPA-CORR-UI/);
        await act('action', { id: 'CAPA-PREV-UI', causeId: 'CAUSE-CAPA-UI',
            actionType: 'Preventive', ownerActorId: 'ACT-MFG',
            actionText: 'Add post-service fixture verification to standard work',
            dueAt: '2026-09-01T00:00:00.000Z' }, /CAPA-PREV-UI/);

        setActor('ACT-REV');
        await act('action-review', { actionId: 'CAPA-CORR-UI', decision: 'Pass',
            evidenceKind: 'aoi-inspection', evidenceId: 'AOI-A-028',
            reviewedAt: '2026-08-29T10:00:00.000Z',
            reason: 'Independent later-AOI review of corrective action' }, /AOI-A-028/);
        await act('action-review', { actionId: 'CAPA-PREV-UI', decision: 'Pass',
            evidenceKind: 'aoi-inspection', evidenceId: 'AOI-A-030',
            reviewedAt: '2026-08-30T11:00:00.000Z',
            reason: 'Independent later-AOI review of standardization action' }, /AOI-A-030/);

        setActor('ACT-Q1');
        await act('feedback', { id: 'FB-CAPA-UI',
            documentRevision: 'DOC-CAM-PFMEA|DOC-CAM-PFMEA-R1',
            capaActionId: 'CAPA-PREV-UI',
            proposedSummary: 'Add post-service fixture verification' }, /FB-CAPA-UI/);
        setActor('ACT-REV');
        await act('feedback-review', { feedbackId: 'FB-CAPA-UI', decision: 'Pass',
            verificationId: 'CAPA-PREV-UI-REVIEW',
            reason: 'Independent synthetic PFMEA feedback review' }, /Feedback pending|FB-CAPA-UI/);
        setActor('ACT-APP');
        await act('document-approval', { feedbackId: 'FB-CAPA-UI',
            reason: 'Separate synthetic document approval' }, /DOC-CAM-PFMEA-R2/);

        assert.equal(db.prepare("SELECT state FROM incidents WHERE id=?").get(incidentId).state,
            'CAPA In Progress');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM incident_cycles WHERE incident_id=?')
            .get(incidentId).n, 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capa_actions WHERE incident_id=?')
            .get(incidentId).n, 2);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capa_action_reviews').get().n, 2);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback_reviews').get().n, 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM document_revisions WHERE id=?')
            .get('DOC-CAM-PFMEA-R2').n, 1);
        await context.reload();
        assert.match(view.innerHTML, /DOC-CAM-PFMEA-R2/);
        assert.match(view.innerHTML, /원천 사건/);
        assert.match(view.innerHTML, /원천 사이클/);
        assert.match(view.innerHTML, /document-revision-approved/);
    }, { complete: false }));
