import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { createLocalServer, listenLocal } from '../src/server/http.mjs';

const at = minute => `2026-08-27T10:${String(minute).padStart(2, '0')}:00.000Z`;
const detectedAt = '2026-08-27T10:00:00.000Z';

async function fixture(run) {
    const db = openDatabase(':memory:');
    const assetsDir = mkdtempSync(join(tmpdir(), 'fabassure-incident-http-'));
    for (const name of ['index.html', 'app.js', 'styles.css']) {
        writeFileSync(join(assetsDir, name), `Synthetic ${name}`);
    }
    let server;
    try {
        seedDatabase(db, { instanceId: 'DATASET-INCIDENT-HTTP' });
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

test('FabTrace HTTP exposes source-linked incident decisions and independent scope history', () => fixture(async ({ local, action }) => {
    const created = await action('createIncident', {
        id: 'INC-HTTP-B', title: 'Synthetic post-maintenance defect excursion',
        actorId: 'ACT-Q1', defectCodeId: 'DEF-FIDUCIAL',
        detectionEventId: 'EV-DETECTION', observedLotId: 'LOT-A-026',
        recipeRevisionId: 'REC-ALIGN-R3', detectedAt, at: at(2)
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.result.state, 'Open');
    const listed = await (await fetch(`${local.url}/api/bootstrap`)).json();
    assert.ok(listed.incidents.some(item => item.id === 'INC-HTTP-B' && item.state === 'Open'));

    const contained = await action('containIncident', {
        incidentId: 'INC-HTTP-B', expectedRevisionNo: 1, actorId: 'ACT-PROD',
        ownerActorId: 'ACT-PROD', heldLotIds: ['LOT-A-025', 'LOT-A-026', 'LOT-A-027'],
        reason: 'Hold synthetic candidate lots pending trace', at: at(4)
    });
    assert.equal(contained.status, 200);
    const lkg = await action('recordIncidentLkg', {
        incidentId: 'INC-HTTP-B', expectedRevisionNo: 1, actorId: 'ACT-Q1',
        aoiInspectionId: 'AOI-A-025',
        earliestPossibleAt: '2026-08-25T08:00:00.000Z',
        latestPossibleAt: '2026-08-25T12:00:00.000Z',
        method: 'Synthetic AOI target-code screen', sampleScope: '100 inspected units',
        limitation: 'A sample does not prove intervening units good', at: at(6)
    });
    assert.equal(lkg.status, 200);
    const proposed = await action('proposeIncidentTrace', {
        incidentId: 'INC-HTTP-B', expectedRevisionNo: 1,
        actorId: 'ACT-Q1', at: at(8)
    });
    assert.equal(proposed.status, 200);
    assert.deepEqual(proposed.body.result.lots.map(item => item.lotId), [
        'LOT-A-024', 'LOT-A-025', 'LOT-A-026', 'LOT-A-027', 'LOT-A-028'
    ]);

    const sameActor = await action('reviewIncidentScope', {
        incidentId: 'INC-HTTP-B', expectedRevisionNo: 1,
        proposalId: proposed.body.result.proposalId,
        actorId: 'ACT-Q1', decision: 'Pass',
        reason: 'Must reject same actor', at: at(9), lotDecisions: []
    });
    assert.equal(sameActor.status, 409);
    assert.match(sameActor.body.error.message, /Independent scope reviewer/);

    const reviewed = await action('reviewIncidentScope', {
        incidentId: 'INC-HTTP-B', expectedRevisionNo: 1,
        proposalId: proposed.body.result.proposalId,
        actorId: 'ACT-REV', decision: 'Pass',
        reason: 'Independent synthetic source review', at: at(10),
        lotDecisions: proposed.body.result.lots.map(item => ({
            lotId: item.lotId,
            scopeStatus: item.classification === 'excluded' ? 'excluded' : 'included',
            containment: item.classification === 'excluded' ? 'No Change' : 'Held',
            reason: 'Source interval and uncertainty considered'
        }))
    });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.body.result.state, 'Scope Reviewed');

    const response = await fetch(`${local.url}/api/incidents/INC-HTTP-B`);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.incident.state, 'Scope Reviewed');
    assert.equal(detail.detectionEvent.id, 'EV-DETECTION');
    assert.equal(detail.lkg.aoi_inspection_id, 'AOI-A-025');
    assert.equal(detail.proposal.resultDigest, proposed.body.result.resultDigest);
    assert.equal(detail.candidates.length, 5);
    assert.equal(detail.scopeReview.reviewer_actor_id, 'ACT-REV');
    assert.equal(detail.scopeDecisions.length, 5);
    assert.ok(detail.scopeDecisions.filter(item => item.containment === 'Held').length >= 3);
    assert.deepEqual(detail.audit.map(item => item.action), [
        'incident-created', 'incident-contained', 'lkg-recorded',
        'trace-proposed', 'scope-reviewed'
    ]);
    assert.equal(detail.audit.at(-1).digest.length, 64);
    assert.equal(detail.audit.at(-1).payload.candidateDigest, proposed.body.result.resultDigest);
}));

test('FabTrace HTTP retains rejected scope and exposes a new trace revision', () => fixture(async ({ local, action }) => {
    const id = 'INC-HTTP-REWORK';
    assert.equal((await action('createIncident', {
        id, title: 'Synthetic scope rework', actorId: 'ACT-Q1',
        defectCodeId: 'DEF-FIDUCIAL', detectionEventId: 'EV-DETECTION',
        observedLotId: 'LOT-A-026', recipeRevisionId: 'REC-ALIGN-R3',
        detectedAt, at: at(2)
    })).status, 200);
    assert.equal((await action('containIncident', {
        incidentId: id, expectedRevisionNo: 1, actorId: 'ACT-PROD',
        ownerActorId: 'ACT-PROD', heldLotIds: ['LOT-A-025', 'LOT-A-026', 'LOT-A-027'],
        reason: 'Hold uncertain lots', at: at(4)
    })).status, 200);
    const proposed = await action('proposeIncidentTrace', {
        incidentId: id, expectedRevisionNo: 1, actorId: 'ACT-Q1', at: at(8)
    });
    assert.equal(proposed.status, 200);
    assert.equal((await action('reviewIncidentScope', {
        incidentId: id, expectedRevisionNo: 1,
        proposalId: proposed.body.result.proposalId, actorId: 'ACT-REV',
        decision: 'Needs Rework', reason: 'Uncertain start requires revised rationale',
        lotDecisions: [], at: at(10)
    })).status, 200);
    const revised = await action('reviseIncidentTrace', {
        incidentId: id, expectedRevisionNo: 1, actorId: 'ACT-Q1',
        reason: 'Retain unknown start and recalculate the source lot set', at: at(12)
    });
    assert.equal(revised.status, 200);
    assert.equal(revised.body.result.revisionId, `${id}-R2`);
    const detail = await (await fetch(`${local.url}/api/incidents/${id}`)).json();
    assert.equal(detail.revisions.length, 2);
    assert.equal(detail.traceProposals.length, 2);
    assert.equal(detail.traceProposals[0].scopeReview.decision, 'Needs Rework');
    assert.equal(detail.proposal.id, revised.body.result.proposalId);
    assert.equal(detail.scopeReview, null);
    assert.equal(detail.audit.at(-1).action, 'trace-revised');
}));

test('FabTrace detail rejects invalid or unknown IDs without exposing SQLite internals', () => fixture(async ({ local }) => {
    const bad = await fetch(`${local.url}/api/incidents/bad%20id`);
    assert.equal(bad.status, 400);
    const missing = await fetch(`${local.url}/api/incidents/INC-NO-SUCH-RECORD`);
    assert.equal(missing.status, 404);
    assert.doesNotMatch(await missing.text(), /SELECT|SQLITE|src\\/i);
}));

test('FabTrace HTTP rejects foreign actions, wrong roles and caller ID reflection', () => fixture(async ({ db, local, action }) => {
    const incidentInput = {
        id: 'INC-HTTP-NEG', title: 'Synthetic blocked action check',
        actorId: 'ACT-Q1', defectCodeId: 'DEF-FIDUCIAL',
        detectionEventId: 'EV-DETECTION', observedLotId: 'LOT-A-026',
        recipeRevisionId: 'REC-ALIGN-R3', detectedAt, at: at(2)
    };
    const body = JSON.stringify({ action: 'createIncident', input: incidentInput });
    const missingHeader = await fetch(`${local.url}/api/actions`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: local.url }, body });
    assert.equal(missingHeader.status, 403);
    const foreign = await fetch(`${local.url}/api/actions`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fabassure-local': '1',
            origin: 'https://unrelated.invalid' }, body });
    assert.equal(foreign.status, 403);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM incidents').get().n, 0);

    const wrongRole = await action('createIncident', { ...incidentInput, actorId: 'ACT-VER' });
    assert.equal(wrongRole.status, 409);
    assert.match(wrongRole.body.error.message, /simulated actor role/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM incidents').get().n, 0);

    const unknown = await action('containIncident', {
        incidentId: 'INC-PRIVATE-CLIENT-TOKEN', expectedRevisionNo: 1,
        actorId: 'ACT-PROD', ownerActorId: 'ACT-PROD',
        heldLotIds: ['LOT-A-026'], reason: 'Synthetic hold', at: at(4)
    });
    assert.equal(unknown.status, 409);
    assert.match(unknown.body.error.message, /Unknown incident/);
    assert.doesNotMatch(JSON.stringify(unknown.body), /PRIVATE-CLIENT-TOKEN/);

    assert.equal((await action('createIncident', incidentInput)).status, 200);
    const invalidLot = await action('containIncident', {
        incidentId: incidentInput.id, expectedRevisionNo: 1,
        actorId: 'ACT-PROD', ownerActorId: 'ACT-PROD',
        heldLotIds: ['LOT-PRIVATE-CLIENT-TOKEN'], reason: 'Synthetic hold', at: at(4)
    });
    assert.equal(invalidLot.status, 409);
    assert.match(invalidLot.body.error.message, /source context/);
    assert.doesNotMatch(JSON.stringify(invalidLot.body), /PRIVATE-CLIENT-TOKEN/);
    assert.equal(db.prepare('SELECT state FROM incidents WHERE id=?').get(incidentInput.id).state, 'Open');
}));
