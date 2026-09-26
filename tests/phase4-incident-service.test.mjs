import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertDataIntegrity, openDatabase, withValidatedTransaction } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { appendAuditEvent, verifyAuditChain } from '../src/domain/audit.mjs';
import { containIncident, createIncident, proposeIncidentTrace,
    recordIncidentLkg, reviewIncidentScope, reviseIncidentTrace } from '../src/domain/incident-service.mjs';
import { calculateExposure } from '../src/domain/trace.mjs';
import { buildSourceTraceQuery } from '../src/domain/trace-source.mjs';

const detectedAt = '2026-08-27T10:00:00.000Z';
const at = minute => `2026-08-27T10:${String(minute).padStart(2, '0')}:00.000Z`;

function fixture() {
    const db = openDatabase(':memory:');
    seedDatabase(db, { instanceId: 'DATASET-INCIDENT-TEST' });
    return db;
}

function openScenario(db) {
    return createIncident(db, {
        id: 'INC-DEMO-B', title: 'Synthetic post-maintenance fiducial excursion',
        actorId: 'ACT-Q1', defectCodeId: 'DEF-FIDUCIAL',
        detectionEventId: 'EV-DETECTION', observedLotId: 'LOT-A-026',
        recipeRevisionId: 'REC-ALIGN-R3', detectedAt, at: at(2)
    });
}

function containScenario(db) {
    return containIncident(db, { incidentId: 'INC-DEMO-B', expectedRevisionNo: 1,
        actorId: 'ACT-PROD', ownerActorId: 'ACT-PROD',
        heldLotIds: ['LOT-A-025', 'LOT-A-026', 'LOT-A-027'],
        reason: 'Hold candidate lots pending independent trace review', at: at(4) });
}

function lkgScenario(db) {
    return recordIncidentLkg(db, { incidentId: 'INC-DEMO-B', expectedRevisionNo: 1,
        actorId: 'ACT-Q1', aoiInspectionId: 'AOI-A-025',
        earliestPossibleAt: '2026-08-25T08:00:00.000Z',
        latestPossibleAt: '2026-08-25T12:00:00.000Z',
        method: 'Synthetic AOI target-code screen', sampleScope: '100 inspected units in LOT-A-025',
        limitation: 'Sampled observation does not prove every intervening unit good', at: at(6) });
}

test('direct SQL LKG observation requires its own matching audit event', () => {
    const db = fixture();
    try {
        openScenario(db);
        containScenario(db);
        db.prepare(`INSERT INTO lkg_observations(id,incident_revision_id,aoi_inspection_id,
            earliest_possible_at,latest_possible_at,method,sample_scope,limitation,
            recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run('INC-DEMO-B-LKG-R1', 'INC-DEMO-B-R1', 'AOI-A-025',
                '2026-08-25T08:00:00.000Z', '2026-08-25T12:00:00.000Z',
                'Synthetic AOI target-code screen', '100 inspected units in LOT-A-025',
                'Sampled observation does not prove every intervening unit good',
                'ACT-Q1', at(6));
        assert.throws(() => assertDataIntegrity(db), /LKG|audit|observation/i);
    } finally {
        db.close();
    }
});

test('unknown LKG start is explicit in initial and revised trace audits', () => {
    const db = fixture();
    try {
        openScenario(db);
        containScenario(db);
        const proposal = proposeIncidentTrace(db, { incidentId: 'INC-DEMO-B',
            expectedRevisionNo: 1, actorId: 'ACT-Q1', at: at(8) });
        const first = db.prepare(`SELECT reason,payload_json FROM audit_events
            WHERE entity_type='incident' AND entity_id='INC-DEMO-B'
            AND action='trace-proposed'`).get();
        assert.match(first.reason, /unknown LKG start/i);
        assert.equal(JSON.parse(first.payload_json).lkgMode, 'unknown-start');
        reviewIncidentScope(db, { incidentId: 'INC-DEMO-B', expectedRevisionNo: 1,
            proposalId: proposal.proposalId, actorId: 'ACT-REV', decision: 'Needs Rework',
            reason: 'Recheck the candidate boundary', lotDecisions: [], at: at(10) });
        reviseIncidentTrace(db, { incidentId: 'INC-DEMO-B', expectedRevisionNo: 1,
            actorId: 'ACT-Q1', reason: 'Reassess candidate scope', at: at(12) });
        const revised = db.prepare(`SELECT reason,payload_json FROM audit_events
            WHERE entity_type='incident' AND entity_id='INC-DEMO-B'
            AND action='trace-revised'`).get();
        assert.match(revised.reason, /unknown LKG start/i);
        assert.equal(JSON.parse(revised.payload_json).lkgMode, 'unknown-start');
        assertDataIntegrity(db);
    } finally {
        db.close();
    }
});

test('an LKG audit without its observation cannot create false provenance', () => {
    const db = fixture();
    try {
        openScenario(db);
        containScenario(db);
        assert.throws(() => withValidatedTransaction(db, tx => {
            tx.prepare("UPDATE incidents SET updated_at=? WHERE id='INC-DEMO-B'").run(at(6));
            appendAuditEvent(tx, { actorId: 'ACT-Q1', recordedAt: at(6),
                entityType: 'incident', entityId: 'INC-DEMO-B',
                entityRevisionId: 'INC-DEMO-B-R1', action: 'lkg-recorded',
                priorState: 'Contained', reason: 'No observation exists',
                payload: { lkgId: 'LKG-MISSING', aoiInspectionId: 'AOI-A-025',
                    earliestPossibleAt: '2026-08-25T08:00:00.000Z',
                    latestPossibleAt: '2026-08-25T12:00:00.000Z',
                    method: 'Synthetic screen', sampleScope: '100 units' } });
        }), /LKG|observation|audit/i);
    } finally {
        db.close();
    }
});

test('LKG observation and audit require an earlier audited containment decision', () => {
    const db = fixture();
    try {
        openScenario(db);
        assert.throws(() => withValidatedTransaction(db, tx => {
            const id = 'INC-DEMO-B-LKG-R1';
            const limitation = 'No containment decision preceded this observation';
            tx.prepare(`INSERT INTO lkg_observations(id,incident_revision_id,aoi_inspection_id,
                earliest_possible_at,latest_possible_at,method,sample_scope,limitation,
                recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
                .run(id, 'INC-DEMO-B-R1', 'AOI-A-025',
                    '2026-08-25T08:00:00.000Z', '2026-08-25T12:00:00.000Z',
                    'Synthetic AOI target-code screen', '100 inspected units',
                    limitation, 'ACT-Q1', at(4));
            tx.prepare("UPDATE incidents SET updated_at=? WHERE id='INC-DEMO-B'").run(at(4));
            appendAuditEvent(tx, { actorId: 'ACT-Q1', recordedAt: at(4),
                entityType: 'incident', entityId: 'INC-DEMO-B',
                entityRevisionId: 'INC-DEMO-B-R1', action: 'lkg-recorded',
                priorState: 'Contained', reason: limitation,
                payload: { lkgId: id, aoiInspectionId: 'AOI-A-025',
                    earliestPossibleAt: '2026-08-25T08:00:00.000Z',
                    latestPossibleAt: '2026-08-25T12:00:00.000Z',
                    method: 'Synthetic AOI target-code screen',
                    sampleScope: '100 inspected units' } });
        }), /LKG|containment|audit/i);
    } finally {
        db.close();
    }
});

test('LKG audit uses normalized source text from an accepted observation', () => {
    const db = fixture();
    try {
        openScenario(db);
        containScenario(db);
        recordIncidentLkg(db, { incidentId: 'INC-DEMO-B', expectedRevisionNo: 1,
            actorId: 'ACT-Q1', aoiInspectionId: 'AOI-A-025',
            earliestPossibleAt: '2026-08-25T08:00:00.000Z',
            latestPossibleAt: '2026-08-25T12:00:00.000Z',
            method: '  Synthetic AOI screen  ', sampleScope: '  100 inspected units  ',
            limitation: '  Sample does not prove all units good  ', at: at(6) });
        const audit = db.prepare(`SELECT reason,payload_json FROM audit_events
            WHERE entity_type='incident' AND entity_id='INC-DEMO-B'
            AND action='lkg-recorded'`).get();
        const row = db.prepare(`SELECT method,sample_scope,limitation FROM lkg_observations
            WHERE incident_revision_id='INC-DEMO-B-R1'`).get();
        assert.equal(audit.reason, row.limitation);
        assert.equal(JSON.parse(audit.payload_json).method, row.method);
        assert.equal(JSON.parse(audit.payload_json).sampleScope, row.sample_scope);
        assertDataIntegrity(db);
    } finally {
        db.close();
    }
});

test('an extra R2 LKG observation cannot escape the revised trace proposal', () => {
    const db = fixture();
    try {
        openScenario(db);
        containScenario(db);
        lkgScenario(db);
        const first = proposeIncidentTrace(db, { incidentId: 'INC-DEMO-B',
            expectedRevisionNo: 1, actorId: 'ACT-Q1', at: at(8) });
        reviewIncidentScope(db, { incidentId: 'INC-DEMO-B', expectedRevisionNo: 1,
            proposalId: first.proposalId, actorId: 'ACT-REV', decision: 'Needs Rework',
            reason: 'Recheck the boundary', lotDecisions: [], at: at(10) });
        reviseIncidentTrace(db, { incidentId: 'INC-DEMO-B', expectedRevisionNo: 1,
            actorId: 'ACT-Q1', reason: 'Reassess candidate scope', at: at(12) });
        db.prepare(`INSERT INTO lkg_observations(id,incident_revision_id,aoi_inspection_id,
            earliest_possible_at,latest_possible_at,method,sample_scope,limitation,
            recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run('INC-DEMO-B-LKG-R2-EXTRA', 'INC-DEMO-B-R2', 'AOI-A-024',
                '2026-08-24T08:00:00.000Z', '2026-08-24T12:00:00.000Z',
                'Unreferenced synthetic screen', '100 inspected units',
                'Extra observation has no proposal', 'ACT-Q1', at(13));
        assert.throws(() => assertDataIntegrity(db), /LKG|observation|proposal/i);
    } finally {
        db.close();
    }
});

test('a source-consistent R2 proposal cannot cite the wrong parent scope review', () => {
    const db = fixture();
    try {
        openScenario(db);
        containScenario(db);
        const first = proposeIncidentTrace(db, { incidentId: 'INC-DEMO-B',
            expectedRevisionNo: 1, actorId: 'ACT-Q1', at: at(8) });
        reviewIncidentScope(db, { incidentId: 'INC-DEMO-B', expectedRevisionNo: 1,
            proposalId: first.proposalId, actorId: 'ACT-REV', decision: 'Needs Rework',
            reason: 'Recheck the boundary', lotDecisions: [], at: at(10) });
        assert.throws(() => withValidatedTransaction(db, tx => {
            const revisionId = 'INC-DEMO-B-R2';
            const proposalId = 'INC-DEMO-B-TRACE-R2';
            const reason = 'Reassess candidate scope';
            tx.prepare(`INSERT INTO incident_revisions(id,incident_id,revision_no,
                parent_revision_id,reason,created_by,created_at) VALUES (?,?,?,?,?,?,?)`)
                .run(revisionId, 'INC-DEMO-B', 2, 'INC-DEMO-B-R1', reason, 'ACT-Q1', at(12));
            const query = buildSourceTraceQuery(tx, { equipmentId: 'EQ-ALIGN-A',
                moduleId: 'MOD-ALIGN-A', recipeRevisionId: 'REC-ALIGN-R3',
                defectCodeId: 'DEF-FIDUCIAL', earliestLkgAt: null,
                latestLkgAt: null, cutoffAt: detectedAt });
            const result = calculateExposure(query);
            const resultJson = JSON.stringify(result);
            const digest = createHash('sha256').update(resultJson).digest('hex');
            tx.prepare(`INSERT INTO trace_proposals(id,incident_revision_id,proposer_actor_id,
                recipe_revision_id,lkg_observation_id,earliest_trace_at,cutoff_at,query_json,
                result_json,result_digest,proposed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
                .run(proposalId, revisionId, 'ACT-Q1', 'REC-ALIGN-R3', null,
                    query.earliestTraceAt, detectedAt, JSON.stringify(query), resultJson,
                    digest, at(12));
            const insertCandidate = tx.prepare(`INSERT INTO trace_candidates(id,proposal_id,
                lot_id,classification,reason,details_json,targeted_defects,
                certain_interval_defects) VALUES (?,?,?,?,?,?,?,?)`);
            for (const lot of result.lots) {
                insertCandidate.run(`${proposalId}-${lot.lotId}`, proposalId, lot.lotId,
                    lot.classification, lot.reason, JSON.stringify(lot),
                    lot.targetedDefects, lot.certainIntervalDefects);
            }
            tx.prepare("UPDATE incidents SET updated_at=? WHERE id='INC-DEMO-B'").run(at(12));
            appendAuditEvent(tx, { actorId: 'ACT-Q1', recordedAt: at(12),
                entityType: 'incident', entityId: 'INC-DEMO-B',
                entityRevisionId: revisionId, action: 'trace-revised',
                priorState: 'Trace Proposed', reason: `${reason}; unknown LKG start`,
                payload: { parentRevisionId: 'INC-DEMO-B-R1',
                    priorProposalId: first.proposalId, priorReviewId: 'WRONG-REVIEW',
                    priorLkgId: null, lkgMode: 'unknown-start', lkgId: null,
                    proposalId, resultDigest: digest, lkgSource: null,
                    sourceRunIds: query.runs.map(run => run.id),
                    candidateLotIds: result.lots.map(lot => lot.lotId) } });
        }), /revision|review|audit/i);
    } finally {
        db.close();
    }
});

test('Scenario B opens, contains, traces source lots, and records independent scope review', () => {
    const db = fixture();
    try {
        assert.deepEqual(openScenario(db), { id: 'INC-DEMO-B', revisionId: 'INC-DEMO-B-R1', state: 'Open' });
        assert.equal(containScenario(db).state, 'Contained');
        assert.equal(lkgScenario(db).aoiInspectionId, 'AOI-A-025');
        const proposal = proposeIncidentTrace(db, { incidentId: 'INC-DEMO-B',
            expectedRevisionNo: 1, actorId: 'ACT-Q1', at: at(8) });
        assert.equal(proposal.state, 'Trace Proposed');
        assert.deepEqual(proposal.lots.map(lot => [lot.lotId, lot.classification]), [
            ['LOT-A-024', 'excluded'], ['LOT-A-025', 'ambiguous'],
            ['LOT-A-026', 'confirmed-affected'], ['LOT-A-027', 'potentially-exposed'],
            ['LOT-A-028', 'excluded']
        ]);
        assert.equal(proposal.lots[2].certainIntervalDefects, 5);
        assert.equal(proposal.lots[3].certainIntervalDefects, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trace_candidates WHERE proposal_id=?')
            .get(proposal.proposalId).n, 5);
        const decisions = proposal.lots.map(lot => ({ lotId: lot.lotId,
            scopeStatus: lot.classification === 'excluded' ? 'excluded' :
                lot.classification === 'ambiguous' ? 'ambiguous' : 'included',
            containment: lot.classification === 'excluded' ? 'No Change' : 'Held',
            reason: `${lot.classification}; synthetic source interval and AOI reviewed` }));
        const reviewed = reviewIncidentScope(db, { incidentId: 'INC-DEMO-B',
            expectedRevisionNo: 1, proposalId: proposal.proposalId,
            actorId: 'ACT-REV', decision: 'Pass',
            reason: 'Five candidate lots and uncertain interval reviewed',
            lotDecisions: decisions, at: at(10) });
        assert.equal(reviewed.state, 'Scope Reviewed');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scope_decisions WHERE review_id=?')
            .get(reviewed.reviewId).n, 5);
        assert.equal(db.prepare('SELECT state FROM incidents WHERE id=?').get('INC-DEMO-B').state,
            'Scope Reviewed');
        assert.equal(verifyAuditChain(db).count, 5);
    } finally {
        db.close();
    }
});

test('failed scope review preserves the first proposal and requires a new audited revision', () => {
    const db = fixture();
    try {
        openScenario(db);
        containScenario(db);
        lkgScenario(db);
        const first = proposeIncidentTrace(db, { incidentId: 'INC-DEMO-B',
            expectedRevisionNo: 1, actorId: 'ACT-Q1', at: at(8) });
        const rejected = reviewIncidentScope(db, { incidentId: 'INC-DEMO-B',
            expectedRevisionNo: 1, proposalId: first.proposalId,
            actorId: 'ACT-REV', decision: 'Needs Rework',
            reason: 'Ambiguous boundary requires another independent decision',
            lotDecisions: [], at: at(10) });
        assert.equal(rejected.state, 'Trace Proposed');
        assert.throws(() => reviseIncidentTrace(db, { incidentId: 'INC-DEMO-B',
            expectedRevisionNo: 1, actorId: 'ACT-REV',
            reason: 'Reviewer cannot replace the proposal', at: at(12) }),
        /role|proposer|review/i);
        const revised = reviseIncidentTrace(db, { incidentId: 'INC-DEMO-B',
            expectedRevisionNo: 1, actorId: 'ACT-Q1',
            reason: 'Recheck the LKG at the pre-service AOI source',
            lkg: { aoiInspectionId: 'AOI-A-024',
                earliestPossibleAt: '2026-08-24T08:00:00.000Z',
                latestPossibleAt: '2026-08-24T12:00:00.000Z',
                method: 'Synthetic pre-service AOI source recheck',
                sampleScope: '100 inspected units in LOT-A-024',
                limitation: 'This earlier sample extends the uncertain exposure segment' },
            at: at(12) });
        assert.equal(revised.revisionId, 'INC-DEMO-B-R2');
        assert.equal(revised.proposalId, 'INC-DEMO-B-TRACE-R2');
        assert.notEqual(revised.resultDigest, first.resultDigest);
        assert.notEqual(revised.lots.find(lot => lot.lotId === 'LOT-A-024')?.classification,
            'excluded');
        assert.equal(db.prepare('SELECT aoi_inspection_id FROM lkg_observations WHERE id=?')
            .get('INC-DEMO-B-LKG-R2').aoi_inspection_id, 'AOI-A-024');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scope_reviews').get().n, 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trace_proposals').get().n, 2);
        const old = db.prepare('SELECT decision,reason FROM scope_reviews WHERE id=?')
            .get(rejected.reviewId);
        assert.equal(old.decision, 'Needs Rework');
        assert.match(old.reason, /Ambiguous boundary/);
        const decisions = revised.lots.map(lot => ({ lotId: lot.lotId,
            scopeStatus: lot.classification === 'excluded' ? 'excluded' :
                lot.classification === 'ambiguous' ? 'ambiguous' : 'included',
            containment: lot.classification === 'excluded' ? 'No Change' : 'Held',
            reason: `R2 review of ${lot.classification} source` }));
        assert.throws(() => reviewIncidentScope(db, { incidentId: 'INC-DEMO-B',
            expectedRevisionNo: 1, proposalId: first.proposalId, actorId: 'ACT-REV',
            decision: 'Pass', reason: 'Stale R1 review', lotDecisions: decisions,
            at: at(14) }), /Stale incident revision/);
        const passed = reviewIncidentScope(db, { incidentId: 'INC-DEMO-B',
            expectedRevisionNo: 2, proposalId: revised.proposalId,
            actorId: 'ACT-REV', decision: 'Pass',
            reason: 'Revised uncertainty statement and five lots checked',
            lotDecisions: decisions, at: at(14) });
        assert.equal(passed.state, 'Scope Reviewed');
        assert.equal(verifyAuditChain(db).count, 7);
        assertDataIntegrity(db);
    } finally {
        db.close();
    }
});

test('incident source and scope decisions reject ungrounded evidence and same-actor review', () => {
    const db = fixture();
    try {
        assert.throws(() => createIncident(db, {
            id: 'INC-WRONG', title: 'Wrong detection event', actorId: 'ACT-Q1',
            defectCodeId: 'DEF-FIDUCIAL', detectionEventId: 'EV-VISION-1',
            observedLotId: 'LOT-A-026', recipeRevisionId: 'REC-ALIGN-R3',
            detectedAt, at: at(2)
        }), /detection|event|source/i);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE id='INC-WRONG'").get().n, 0);
        openScenario(db);
        containScenario(db);
        assert.throws(() => recordIncidentLkg(db, { incidentId: 'INC-DEMO-B',
            expectedRevisionNo: 1, actorId: 'ACT-Q1', aoiInspectionId: 'AOI-A-026',
            earliestPossibleAt: '2026-08-26T08:00:00.000Z',
            latestPossibleAt: '2026-08-26T12:00:00.000Z',
            method: 'AOI', sampleScope: '100 units', limitation: 'Defect found', at: at(6)
        }), /LKG|good|defect/i);
        lkgScenario(db);
        const proposal = proposeIncidentTrace(db, { incidentId: 'INC-DEMO-B',
            expectedRevisionNo: 1, actorId: 'ACT-Q1', at: at(8) });
        const decisions = proposal.lots.map(lot => ({ lotId: lot.lotId,
            scopeStatus: lot.classification === 'excluded' ? 'excluded' : 'included',
            containment: lot.classification === 'excluded' ? 'No Change' : 'Held',
            reason: 'Synthetic source reviewed' }));
        assert.throws(() => reviewIncidentScope(db, { incidentId: 'INC-DEMO-B',
            expectedRevisionNo: 1, proposalId: proposal.proposalId,
            actorId: 'ACT-Q1', decision: 'Pass', reason: 'Same actor',
            lotDecisions: decisions, at: at(10) }), /independent|reviewer|proposer/i);
        assert.throws(() => reviewIncidentScope(db, { incidentId: 'INC-DEMO-B',
            expectedRevisionNo: 1, proposalId: proposal.proposalId,
            actorId: 'ACT-REV', decision: 'Pass', reason: 'Incomplete',
            lotDecisions: decisions.slice(1), at: at(10) }), /all|candidate|complete/i);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scope_reviews').get().n, 0);
        assert.equal(db.prepare('SELECT state FROM incidents WHERE id=?').get('INC-DEMO-B').state,
            'Trace Proposed');
    } finally {
        db.close();
    }
});

test('direct SQL cannot mark an exposed lot excluded with no containment', () => {
    const db = fixture();
    try {
        openScenario(db);
        containScenario(db);
        lkgScenario(db);
        const proposal = proposeIncidentTrace(db, { incidentId: 'INC-DEMO-B',
            expectedRevisionNo: 1, actorId: 'ACT-Q1', at: at(8) });
        db.prepare(`INSERT INTO scope_reviews(id,proposal_id,candidate_digest,reviewer_actor_id,
            decision,reason,reviewed_at) VALUES (?,?,?,?,?,?,?)`)
            .run('SCOPE-DIRECT', proposal.proposalId, proposal.resultDigest, 'ACT-REV',
                'Pass', 'Direct SQL negative probe', at(10));
        assert.throws(() => db.prepare(`INSERT INTO scope_decisions(id,review_id,proposal_id,lot_id,
            scope_status,containment,reason) VALUES (?,?,?,?,?,?,?)`)
            .run('DEC-UNSAFE', 'SCOPE-DIRECT', proposal.proposalId, 'LOT-A-026',
                'excluded', 'No Change', 'Unsupported release'), /scope|containment|candidate|release/i);
        const insert = db.prepare(`INSERT INTO scope_decisions(id,review_id,proposal_id,lot_id,
            scope_status,containment,reason) VALUES (?,?,?,?,?,?,?)`);
        for (const lot of proposal.lots) {
            insert.run(`DEC-DIRECT-${lot.lotId}`, 'SCOPE-DIRECT', proposal.proposalId,
                lot.lotId, lot.classification === 'excluded' ? 'excluded' : 'included',
                lot.classification === 'excluded' ? 'No Change' : 'Held',
                'Direct SQL scope decision');
        }
        assert.throws(() => assertDataIntegrity(db), /scope|review|audit/i);
    } finally {
        db.close();
    }
});

test('integrity rejects an internally consistent proposal that omits a source-overlapping lot', () => {
    const db = fixture();
    try {
        openScenario(db);
        containScenario(db);
        const lkg = lkgScenario(db);
        const query = buildSourceTraceQuery(db, {
            equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
            recipeRevisionId: 'REC-ALIGN-R3', defectCodeId: 'DEF-FIDUCIAL',
            earliestLkgAt: lkg.earliestPossibleAt, latestLkgAt: lkg.latestPossibleAt,
            cutoffAt: detectedAt
        });
        query.runs = query.runs.filter(run => run.lotId !== 'LOT-A-026');
        const result = calculateExposure(query);
        const resultJson = JSON.stringify(result);
        const digest = createHash('sha256').update(resultJson).digest('hex');
        db.prepare(`INSERT INTO trace_proposals(id,incident_revision_id,proposer_actor_id,
            recipe_revision_id,lkg_observation_id,earliest_trace_at,cutoff_at,query_json,
            result_json,result_digest,proposed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
            .run('TRACE-OMITTED', 'INC-DEMO-B-R1', 'ACT-Q1', 'REC-ALIGN-R3', lkg.id,
                null, detectedAt, JSON.stringify(query), resultJson, digest, at(8));
        const insert = db.prepare(`INSERT INTO trace_candidates(id,proposal_id,lot_id,classification,
            reason,details_json,targeted_defects,certain_interval_defects)
            VALUES (?,?,?,?,?,?,?,?)`);
        for (const lot of result.lots) {
            insert.run(`TRACE-OMITTED-${lot.lotId}`, 'TRACE-OMITTED', lot.lotId,
                lot.classification, lot.reason, JSON.stringify(lot), lot.targetedDefects,
                lot.certainIntervalDefects);
        }
        assert.throws(() => assertDataIntegrity(db), /source|trace|query|candidate/i);
    } finally {
        db.close();
    }
});

test('ordinary integrity check detects a directly appended invalid audit digest', () => {
    const db = fixture();
    try {
        const payload = '{}';
        const hash = createHash('sha256').update(payload).digest('hex');
        db.prepare(`INSERT INTO audit_events(id,dataset_instance_id,recorded_at,actor_id,
            simulated_role,entity_type,entity_id,action,payload_json,payload_sha256,
            previous_digest,digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run('AUD-INVALID', 'DATASET-INCIDENT-TEST', at(1), 'ACT-Q1', 'Quality Engineer',
                'incident', 'INC-NONE', 'invalid', payload, hash, null, 'f'.repeat(64));
        assert.throws(() => assertDataIntegrity(db), /audit|digest/i);
    } finally {
        db.close();
    }
});

test('audited passing scope cannot be projected back to Trace Proposed by direct SQL', () => {
    const db = fixture();
    try {
        openScenario(db);
        containScenario(db);
        lkgScenario(db);
        const proposal = proposeIncidentTrace(db, { incidentId: 'INC-DEMO-B',
            expectedRevisionNo: 1, actorId: 'ACT-Q1', at: at(8) });
        reviewIncidentScope(db, { incidentId: 'INC-DEMO-B', expectedRevisionNo: 1,
            proposalId: proposal.proposalId, actorId: 'ACT-REV', decision: 'Pass',
            reason: 'Synthetic independent source review', at: at(10),
            lotDecisions: proposal.lots.map(lot => ({ lotId: lot.lotId,
                scopeStatus: lot.classification === 'excluded' ? 'excluded' : 'included',
                containment: lot.classification === 'excluded' ? 'No Change' : 'Held',
                reason: 'Source interval reviewed' })) });
        db.prepare("UPDATE incidents SET state='Trace Proposed' WHERE id='INC-DEMO-B'").run();
        assert.throws(() => assertDataIntegrity(db), /incident|state|audit|projection/i);
    } finally {
        db.close();
    }
});

test('reviewed incident state requires an independent Pass review row and lot decisions', () => {
    const db = fixture();
    try {
        openScenario(db);
        containScenario(db);
        lkgScenario(db);
        const proposal = proposeIncidentTrace(db, { incidentId: 'INC-DEMO-B',
            expectedRevisionNo: 1, actorId: 'ACT-Q1', at: at(8) });
        assert.throws(() => withValidatedTransaction(db, tx => {
            tx.prepare(`UPDATE incidents SET state='Scope Reviewed',updated_at=?
                WHERE id='INC-DEMO-B'`).run(at(10));
            appendAuditEvent(tx, { actorId: 'ACT-REV', recordedAt: at(10),
                entityType: 'incident', entityId: 'INC-DEMO-B',
                entityRevisionId: 'INC-DEMO-B-R1', action: 'scope-reviewed',
                priorState: 'Trace Proposed', newState: 'Scope Reviewed',
                reason: 'Fabricated pass without independent review record',
                payload: { proposalId: proposal.proposalId,
                    reviewId: 'SCOPE-MISSING', candidateDigest: proposal.resultDigest,
                    decision: 'Pass', lotDecisionIds: [] } });
        }), /review|scope|decision|audit/i);
    } finally {
        db.close();
    }
});

test('a new version 3 incident cannot acquire a reviewed state without any audit event', () => {
    const db = fixture();
    try {
        db.prepare(`INSERT INTO incidents(id,title,proposer_actor_id,defect_code_id,equipment_id,
            module_id,detected_at,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run('INC-DIRECT', 'Unaudited direct incident', 'ACT-Q1', 'DEF-FIDUCIAL',
                'EQ-ALIGN-A', 'MOD-ALIGN-A', detectedAt, 'Open', at(2), at(2));
        db.prepare("UPDATE incidents SET state='Scope Reviewed' WHERE id='INC-DIRECT'").run();
        assert.throws(() => assertDataIntegrity(db), /incident|audit|legacy|projection/i);
    } finally {
        db.close();
    }
});

test('an incident revision after rework requires its own audited provenance', () => {
    const db = fixture();
    try {
        openScenario(db);
        containScenario(db);
        lkgScenario(db);
        const proposal = proposeIncidentTrace(db, { incidentId: 'INC-DEMO-B',
            expectedRevisionNo: 1, actorId: 'ACT-Q1', at: at(8) });
        reviewIncidentScope(db, { incidentId: 'INC-DEMO-B', expectedRevisionNo: 1,
            proposalId: proposal.proposalId, actorId: 'ACT-REV',
            decision: 'Needs Rework', reason: 'Recheck the boundary',
            lotDecisions: [], at: at(10) });
        db.prepare(`INSERT INTO incident_revisions(id,incident_id,revision_no,
            parent_revision_id,reason,created_by,created_at) VALUES (?,?,?,?,?,?,?)`)
            .run('INC-DEMO-B-R2', 'INC-DEMO-B', 2, 'INC-DEMO-B-R1',
                'Unaudited revision', 'ACT-Q1', at(12));
        assert.throws(() => assertDataIntegrity(db), /incident|revision|audit/i);
    } finally {
        db.close();
    }
});

test('incident creation time remains bound to its first audit event', () => {
    const db = fixture();
    try {
        openScenario(db);
        db.prepare("UPDATE incidents SET created_at=? WHERE id='INC-DEMO-B'")
            .run(at(1));
        assert.throws(() => assertDataIntegrity(db), /incident|audit|created/i);
    } finally {
        db.close();
    }
});

test('a forged creation audit cannot substitute for a missing R1', () => {
    const db = fixture();
    try {
        assert.throws(() => withValidatedTransaction(db, tx => {
            tx.prepare(`INSERT INTO incidents(id,title,proposer_actor_id,defect_code_id,
                equipment_id,module_id,detected_at,state,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`).run('INC-FORGED-R1', 'Synthetic forged origin',
                'ACT-Q1', 'DEF-FIDUCIAL', 'EQ-ALIGN-A', 'MOD-ALIGN-A', detectedAt,
                'Open', at(2), at(2));
            appendAuditEvent(tx, { actorId: 'ACT-Q1', recordedAt: at(2),
                entityType: 'incident', entityId: 'INC-FORGED-R1',
                entityRevisionId: 'INC-FORGED-R1-R1', action: 'incident-created',
                newState: 'Open', reason: 'Synthetic forged origin',
                payload: { detectionEventId: 'EV-DETECTION', observedLotId: 'LOT-A-026',
                    observedRunId: 'RUN-A-026', recipeRevisionId: 'REC-ALIGN-R3',
                    defectCodeId: 'DEF-FIDUCIAL', detectedAt } });
        }), /revision|incident|audit/i);
    } finally {
        db.close();
    }
});

test('creation audit must cite the matching detection source and observed run', () => {
    const db = fixture();
    try {
        assert.throws(() => withValidatedTransaction(db, tx => {
            tx.prepare(`INSERT INTO incidents(id,title,proposer_actor_id,defect_code_id,
                equipment_id,module_id,detected_at,state,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`).run('INC-FORGED-SOURCE',
                'Synthetic wrong detection source', 'ACT-Q1', 'DEF-FIDUCIAL',
                'EQ-ALIGN-A', 'MOD-ALIGN-A', detectedAt, 'Open', at(2), at(2));
            tx.prepare(`INSERT INTO incident_revisions(id,incident_id,revision_no,
                reason,created_by,created_at) VALUES (?,?,1,?,?,?)`)
                .run('INC-FORGED-SOURCE-R1', 'INC-FORGED-SOURCE',
                    'Initial synthetic incident', 'ACT-Q1', at(2));
            appendAuditEvent(tx, { actorId: 'ACT-Q1', recordedAt: at(2),
                entityType: 'incident', entityId: 'INC-FORGED-SOURCE',
                entityRevisionId: 'INC-FORGED-SOURCE-R1', action: 'incident-created',
                newState: 'Open', reason: 'Synthetic wrong detection source',
                payload: { detectionEventId: 'EV-VISION-1', observedLotId: 'LOT-A-026',
                    observedRunId: 'RUN-A-026', recipeRevisionId: 'REC-ALIGN-R3',
                    defectCodeId: 'DEF-FIDUCIAL', detectedAt } });
        }), /source|detection|incident|audit/i);
    } finally {
        db.close();
    }
});

test('creation audit rejects a detection-consistent event with the wrong observed run', () => {
    const db = fixture();
    try {
        assert.throws(() => withValidatedTransaction(db, tx => {
            tx.prepare(`INSERT INTO incidents(id,title,proposer_actor_id,defect_code_id,
                equipment_id,module_id,detected_at,state,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`).run('INC-WRONG-RUN',
                    'Synthetic wrong observed run', 'ACT-Q1', 'DEF-FIDUCIAL',
                    'EQ-ALIGN-A', 'MOD-ALIGN-A', detectedAt, 'Open', at(2), at(2));
            tx.prepare(`INSERT INTO incident_revisions(id,incident_id,revision_no,
                reason,created_by,created_at) VALUES (?,?,1,?,?,?)`)
                .run('INC-WRONG-RUN-R1', 'INC-WRONG-RUN',
                    'Initial synthetic incident', 'ACT-Q1', at(2));
            appendAuditEvent(tx, { actorId: 'ACT-Q1', recordedAt: at(2),
                entityType: 'incident', entityId: 'INC-WRONG-RUN',
                entityRevisionId: 'INC-WRONG-RUN-R1', action: 'incident-created',
                newState: 'Open', reason: 'Synthetic wrong observed run',
                payload: { detectionEventId: 'EV-DETECTION', observedLotId: 'LOT-A-026',
                    observedRunId: 'RUN-A-025', recipeRevisionId: 'REC-ALIGN-R3',
                    defectCodeId: 'DEF-FIDUCIAL', detectedAt } });
        }), /run|source|incident|audit/i);
    } finally {
        db.close();
    }
});

test('a source-consistent direct trace proposal still requires its proposal audit', () => {
    const db = fixture();
    try {
        openScenario(db);
        containScenario(db);
        const lkg = lkgScenario(db);
        const query = buildSourceTraceQuery(db, {
            equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
            recipeRevisionId: 'REC-ALIGN-R3', defectCodeId: 'DEF-FIDUCIAL',
            earliestLkgAt: lkg.earliestPossibleAt,
            latestLkgAt: lkg.latestPossibleAt, cutoffAt: detectedAt
        });
        const result = calculateExposure(query);
        const resultJson = JSON.stringify(result);
        const digest = createHash('sha256').update(resultJson).digest('hex');
        const proposalId = 'INC-DEMO-B-TRACE-UNAUDITED';
        db.prepare(`INSERT INTO trace_proposals(id,incident_revision_id,proposer_actor_id,
            recipe_revision_id,lkg_observation_id,earliest_trace_at,cutoff_at,query_json,
            result_json,result_digest,proposed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
            .run(proposalId, 'INC-DEMO-B-R1', 'ACT-Q1', 'REC-ALIGN-R3',
                lkg.id, query.earliestTraceAt, detectedAt, JSON.stringify(query),
                resultJson, digest, at(8));
        const insert = db.prepare(`INSERT INTO trace_candidates(id,proposal_id,lot_id,
            classification,reason,details_json,targeted_defects,certain_interval_defects)
            VALUES (?,?,?,?,?,?,?,?)`);
        for (const lot of result.lots) {
            insert.run(`${proposalId}-${lot.lotId}`, proposalId, lot.lotId,
                lot.classification, lot.reason, JSON.stringify(lot),
                lot.targetedDefects, lot.certainIntervalDefects);
        }
        assert.throws(() => assertDataIntegrity(db), /proposal|audit|trace/i);
    } finally {
        db.close();
    }
});
