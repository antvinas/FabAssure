import { createHash } from 'node:crypto';
import { withValidatedTransaction } from '../data/db.mjs';
import { appendAuditEvent } from './audit.mjs';
import { assertStateTransition } from './state.mjs';
import { calculateExposure } from './trace.mjs';
import { buildSourceTraceQuery } from './trace-source.mjs';

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

function required(value, label) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
    return value.trim();
}

function utc(value, label) {
    const text = required(value, label);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) ||
        !Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
        throw new TypeError(`${label} must be canonical UTC`);
    }
    return text;
}

function simulatedActor(tx, id, roles) {
    const actorId = required(id, 'Simulated actor ID');
    const actor = tx.prepare('SELECT id,role FROM demo_actors WHERE id=?').get(actorId);
    if (!actor || !roles.includes(actor.role)) throw new Error('Required simulated actor role is missing');
    return actor;
}

function decisionTransaction(db, operation) {
    return withValidatedTransaction(db, tx => {
        const before = tx.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        const result = operation(tx);
        const after = tx.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        if (after !== before + 1) throw new Error('Incident decision requires exactly one audit event');
        return result;
    });
}

function currentIncident(tx, input, state) {
    const incidentId = required(input.incidentId, 'Incident ID');
    const incident = tx.prepare('SELECT * FROM incidents WHERE id=?').get(incidentId);
    if (!incident) throw new Error(`Unknown incident: ${incidentId}`);
    const revision = tx.prepare(`SELECT * FROM incident_revisions WHERE incident_id=?
        ORDER BY revision_no DESC LIMIT 1`).get(incidentId);
    if (!revision || !Number.isSafeInteger(input.expectedRevisionNo) ||
        input.expectedRevisionNo !== revision.revision_no) throw new Error('Stale incident revision');
    if (state && incident.state !== state) throw new Error(`Incident must be ${state}`);
    return { incident, revision };
}

function later(input, previous) {
    const at = utc(input.at, 'Decision time');
    if (at <= previous) throw new Error('Incident decision must follow previous event');
    return at;
}

function advance(tx, incident, to, at) {
    assertStateTransition('incident', incident.state, to);
    const result = tx.prepare('UPDATE incidents SET state=?,updated_at=? WHERE id=? AND state=?')
        .run(to, at, incident.id, incident.state);
    if (result.changes !== 1) throw new Error('Stale incident state');
}

export function createIncident(db, input) {
    return decisionTransaction(db, tx => {
        if (!input || typeof input !== 'object') throw new TypeError('Incident input is required');
        const proposer = simulatedActor(tx, input.actorId, ['Quality Engineer', 'Production Manager']);
        const id = required(input.id, 'Incident ID');
        const detectedAt = utc(input.detectedAt, 'Detection time');
        const at = utc(input.at, 'Decision time');
        if (at < detectedAt) throw new Error('Incident cannot be recorded before detection');
        const eventId = required(input.detectionEventId, 'Detection event ID');
        const event = tx.prepare('SELECT * FROM equipment_events WHERE id=?').get(eventId);
        if (!event || event.event_type !== 'defect-detected' || event.occurred_at !== detectedAt) {
            throw new Error('Detection event source and time do not match');
        }
        const defectCodeId = required(input.defectCodeId, 'Defect code ID');
        if (!tx.prepare('SELECT id FROM defect_codes WHERE id=?').get(defectCodeId)) {
            throw new Error('Unknown incident defect code');
        }
        const observedLotId = required(input.observedLotId, 'Observed lot ID');
        const recipeRevisionId = required(input.recipeRevisionId, 'Observed recipe revision');
        const observed = tx.prepare(`SELECT r.id FROM process_runs r WHERE r.lot_id=?
            AND r.equipment_id=? AND r.module_id=? AND r.recipe_revision_id=?
            AND r.end_at<=? LIMIT 1`).get(observedLotId, event.equipment_id,
            event.module_id, recipeRevisionId, detectedAt);
        if (!observed) throw new Error('Observed lot and recipe lack matching source run');
        tx.prepare(`INSERT INTO incidents(id,title,proposer_actor_id,defect_code_id,equipment_id,
            module_id,detected_at,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run(id, required(input.title, 'Incident title'), proposer.id, defectCodeId,
                event.equipment_id, event.module_id, detectedAt, 'Open', at, at);
        const revisionId = `${id}-R1`;
        tx.prepare(`INSERT INTO incident_revisions(id,incident_id,revision_no,reason,created_by,created_at)
            VALUES (?,?,1,?,?,?)`).run(revisionId, id, 'Initial synthetic incident', proposer.id, at);
        appendAuditEvent(tx, { actorId: proposer.id, recordedAt: at, entityType: 'incident',
            entityId: id, entityRevisionId: revisionId, action: 'incident-created',
            newState: 'Open', reason: input.title,
            payload: { detectionEventId: eventId, observedLotId, observedRunId: observed.id,
                recipeRevisionId, defectCodeId, detectedAt } });
        return { id, revisionId, state: 'Open' };
    });
}

export function containIncident(db, input) {
    return decisionTransaction(db, tx => {
        const { incident, revision } = currentIncident(tx, input, 'Open');
        const actor = simulatedActor(tx, input.actorId, ['Production Manager', 'Quality Engineer']);
        const owner = simulatedActor(tx, input.ownerActorId, ['Production Manager', 'Quality Engineer']);
        const at = later(input, incident.updated_at);
        const reason = required(input.reason, 'Containment reason');
        if (!Array.isArray(input.heldLotIds) || input.heldLotIds.length === 0 ||
            new Set(input.heldLotIds).size !== input.heldLotIds.length) {
            throw new Error('Distinct held lots are required for containment');
        }
        const heldLotIds = input.heldLotIds.map(id => required(id, 'Held lot ID'));
        const matchingLot = tx.prepare(`SELECT r.id FROM process_runs r WHERE r.lot_id=?
            AND r.equipment_id=? AND r.module_id=? LIMIT 1`);
        for (const lotId of heldLotIds) {
            if (!matchingLot.get(lotId, incident.equipment_id, incident.module_id)) {
                throw new Error(`Held lot lacks incident source context: ${lotId}`);
            }
        }
        advance(tx, incident, 'Contained', at);
        appendAuditEvent(tx, { actorId: actor.id, recordedAt: at, entityType: 'incident',
            entityId: incident.id, entityRevisionId: revision.id, action: 'incident-contained',
            priorState: 'Open', newState: 'Contained', reason,
            payload: { heldLotIds, ownerActorId: owner.id, releaseAllowed: false } });
        return { id: incident.id, state: 'Contained', heldLotIds };
    });
}

export function recordIncidentLkg(db, input) {
    return decisionTransaction(db, tx => {
        const { incident, revision } = currentIncident(tx, input, 'Contained');
        const actor = simulatedActor(tx, input.actorId, ['Quality Engineer', 'Verification Engineer']);
        const at = later(input, incident.updated_at);
        const aoiInspectionId = required(input.aoiInspectionId, 'LKG AOI source');
        const earliest = utc(input.earliestPossibleAt, 'Earliest LKG');
        const latest = utc(input.latestPossibleAt, 'Latest LKG');
        if (earliest > latest || latest >= incident.detected_at) {
            throw new Error('LKG bounds must precede incident detection');
        }
        if (tx.prepare('SELECT id FROM lkg_observations WHERE incident_revision_id=?').get(revision.id)) {
            throw new Error('Current incident revision already has an LKG observation');
        }
        const id = `${incident.id}-LKG-R${revision.revision_no}`;
        const method = required(input.method, 'LKG method');
        const sampleScope = required(input.sampleScope, 'LKG sample scope');
        const limitation = required(input.limitation, 'LKG limitation');
        tx.prepare(`INSERT INTO lkg_observations(id,incident_revision_id,aoi_inspection_id,
            earliest_possible_at,latest_possible_at,method,sample_scope,limitation,recorded_by,recorded_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, revision.id, aoiInspectionId, earliest, latest,
            method, sampleScope, limitation, actor.id, at);
        tx.prepare('UPDATE incidents SET updated_at=? WHERE id=?').run(at, incident.id);
        appendAuditEvent(tx, { actorId: actor.id, recordedAt: at, entityType: 'incident',
            entityId: incident.id, entityRevisionId: revision.id, action: 'lkg-recorded',
            priorState: 'Contained', reason: limitation,
            payload: { lkgId: id, aoiInspectionId, earliestPossibleAt: earliest,
                latestPossibleAt: latest, method, sampleScope } });
        return { id, aoiInspectionId, earliestPossibleAt: earliest, latestPossibleAt: latest };
    });
}

export function proposeIncidentTrace(db, input) {
    return decisionTransaction(db, tx => {
        const { incident, revision } = currentIncident(tx, input, 'Contained');
        const actor = simulatedActor(tx, input.actorId, ['Quality Engineer',
            'Manufacturing Engineer', 'Equipment / Automation Engineer']);
        const at = later(input, incident.updated_at);
        const created = tx.prepare(`SELECT payload_json FROM audit_events WHERE entity_type='incident'
            AND entity_id=? AND action='incident-created' ORDER BY sequence LIMIT 1`).get(incident.id);
        if (!created) throw new Error('Incident source audit is missing');
        const { recipeRevisionId } = JSON.parse(created.payload_json);
        const lkg = tx.prepare(`SELECT * FROM lkg_observations WHERE incident_revision_id=?
            ORDER BY recorded_at DESC LIMIT 1`).get(revision.id);
        const query = buildSourceTraceQuery(tx, { equipmentId: incident.equipment_id,
            moduleId: incident.module_id,
            recipeRevisionId, defectCodeId: incident.defect_code_id,
            earliestLkgAt: lkg?.earliest_possible_at ?? null,
            latestLkgAt: lkg?.latest_possible_at ?? null,
            cutoffAt: incident.detected_at });
        const runs = query.runs;
        const result = calculateExposure(query);
        const proposalId = `${incident.id}-TRACE-R${revision.revision_no}`;
        const resultJson = JSON.stringify(result);
        const digest = sha256(resultJson);
        tx.prepare(`INSERT INTO trace_proposals(id,incident_revision_id,proposer_actor_id,
            recipe_revision_id,lkg_observation_id,earliest_trace_at,cutoff_at,query_json,
            result_json,result_digest,proposed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
            .run(proposalId, revision.id, actor.id, recipeRevisionId, lkg?.id ?? null,
                query.earliestTraceAt, incident.detected_at, JSON.stringify(query), resultJson, digest, at);
        const insertCandidate = tx.prepare(`INSERT INTO trace_candidates(id,proposal_id,lot_id,
            classification,reason,details_json,targeted_defects,certain_interval_defects)
            VALUES (?,?,?,?,?,?,?,?)`);
        for (const lot of result.lots) {
            insertCandidate.run(`${proposalId}-${lot.lotId}`, proposalId, lot.lotId,
                lot.classification, lot.reason, JSON.stringify(lot), lot.targetedDefects,
                lot.certainIntervalDefects);
        }
        advance(tx, incident, 'Trace Proposed', at);
        appendAuditEvent(tx, { actorId: actor.id, recordedAt: at, entityType: 'incident',
            entityId: incident.id, entityRevisionId: revision.id, action: 'trace-proposed',
            priorState: 'Contained', newState: 'Trace Proposed',
            reason: lkg ? 'Synthetic source interval and AOI intersection' :
                'Synthetic source interval and AOI intersection; unknown LKG start',
            payload: { proposalId, lkgId: lkg?.id ?? null, sourceRunIds: runs.map(run => run.id),
                candidateLotIds: result.lots.map(lot => lot.lotId), resultDigest: digest,
                lkgMode: lkg ? 'bounded' : 'unknown-start',
                intervalConvention: '[start,end)' } });
        return { proposalId, state: 'Trace Proposed', lots: result.lots,
            window: result.window, resultDigest: digest };
    });
}

export function reviewIncidentScope(db, input) {
    return decisionTransaction(db, tx => {
        const { incident, revision } = currentIncident(tx, input, 'Trace Proposed');
        const reviewer = simulatedActor(tx, input.actorId, ['Reviewer', 'Quality Engineer']);
        const proposalId = required(input.proposalId, 'Trace proposal ID');
        const proposal = tx.prepare('SELECT * FROM trace_proposals WHERE id=? AND incident_revision_id=?')
            .get(proposalId, revision.id);
        if (!proposal) throw new Error('Current incident trace proposal is missing');
        if (reviewer.id === proposal.proposer_actor_id) throw new Error('Independent scope reviewer required');
        const at = later(input, incident.updated_at);
        if (at <= proposal.proposed_at) throw new Error('Scope review must follow trace proposal');
        const decision = required(input.decision, 'Scope review decision');
        if (!['Pass', 'Needs Rework'].includes(decision)) throw new Error('Invalid scope review decision');
        const reason = required(input.reason, 'Scope review reason');
        const candidates = tx.prepare('SELECT * FROM trace_candidates WHERE proposal_id=? ORDER BY lot_id')
            .all(proposalId);
        const decisions = input.lotDecisions ?? [];
        if (!Array.isArray(decisions)) throw new TypeError('Lot scope decisions must be an array');
        if (decision === 'Pass' && decisions.length !== candidates.length) {
            throw new Error('All candidate lots require scope decisions');
        }
        if (decision === 'Needs Rework' && decisions.length !== 0) {
            throw new Error('Failed scope review cannot issue lot decisions');
        }
        const byLot = new Map(candidates.map(candidate => [candidate.lot_id, candidate]));
        if (new Set(decisions.map(item => item.lotId)).size !== decisions.length) {
            throw new Error('Duplicate lot scope decision');
        }
        for (const item of decisions) {
            const candidate = byLot.get(item.lotId);
            if (!candidate) throw new Error('Lot scope decision lacks candidate evidence');
            const status = required(item.scopeStatus, 'Lot scope status');
            const containment = required(item.containment, 'Lot containment');
            required(item.reason, 'Lot scope reason');
            if (candidate.classification === 'excluded' &&
                (status !== 'excluded' || containment !== 'No Change')) {
                throw new Error('Excluded source lot requires explicit excluded decision');
            }
            if (candidate.classification !== 'excluded' &&
                (status === 'excluded' || !['Held', 'Additional Inspection'].includes(containment))) {
                throw new Error('Exposed or uncertain candidate cannot be silently released');
            }
        }
        const reviewId = `${proposalId}-REVIEW`;
        tx.prepare(`INSERT INTO scope_reviews(id,proposal_id,candidate_digest,reviewer_actor_id,
            decision,reason,reviewed_at) VALUES (?,?,?,?,?,?,?)`)
            .run(reviewId, proposalId, proposal.result_digest, reviewer.id, decision, reason, at);
        const insertDecision = tx.prepare(`INSERT INTO scope_decisions(id,review_id,proposal_id,lot_id,
            scope_status,containment,reason) VALUES (?,?,?,?,?,?,?)`);
        for (const item of decisions) {
            insertDecision.run(`${reviewId}-${item.lotId}`, reviewId, proposalId, item.lotId,
                item.scopeStatus, item.containment, item.reason);
        }
        if (decision === 'Pass') advance(tx, incident, 'Scope Reviewed', at);
        else tx.prepare('UPDATE incidents SET updated_at=? WHERE id=?').run(at, incident.id);
        appendAuditEvent(tx, { actorId: reviewer.id, recordedAt: at, entityType: 'incident',
            entityId: incident.id, entityRevisionId: revision.id,
            action: decision === 'Pass' ? 'scope-reviewed' : 'scope-needs-rework',
            priorState: 'Trace Proposed', newState: decision === 'Pass' ? 'Scope Reviewed' : null,
            reason, payload: { proposalId, reviewId, candidateDigest: proposal.result_digest,
                decision, lotDecisionIds: decisions.map(item => `${reviewId}-${item.lotId}`) } });
        return { reviewId, state: decision === 'Pass' ? 'Scope Reviewed' : 'Trace Proposed',
            decision, lotCount: decisions.length };
    });
}

export function reviseIncidentTrace(db, input) {
    return decisionTransaction(db, tx => {
        const { incident, revision } = currentIncident(tx, input, 'Trace Proposed');
        const actor = simulatedActor(tx, input.actorId, ['Quality Engineer',
            'Manufacturing Engineer', 'Equipment / Automation Engineer']);
        const oldProposal = tx.prepare('SELECT * FROM trace_proposals WHERE incident_revision_id=?')
            .get(revision.id);
        const oldReview = oldProposal ? tx.prepare('SELECT * FROM scope_reviews WHERE proposal_id=?')
            .get(oldProposal.id) : null;
        if (!oldReview || oldReview.decision !== 'Needs Rework') {
            throw new Error('A recorded Needs Rework scope review is required');
        }
        const at = later(input, incident.updated_at);
        const reason = required(input.reason, 'Trace revision reason');
        const nextNo = revision.revision_no + 1;
        const revisionId = `${incident.id}-R${nextNo}`;
        tx.prepare(`INSERT INTO incident_revisions(id,incident_id,revision_no,
            parent_revision_id,reason,created_by,created_at) VALUES (?,?,?,?,?,?,?)`)
            .run(revisionId, incident.id, nextNo, revision.id, reason, actor.id, at);
        const priorLkg = tx.prepare('SELECT * FROM lkg_observations WHERE incident_revision_id=?')
            .get(revision.id);
        const changedLkg = input.lkg ?? null;
        if (changedLkg !== null && (typeof changedLkg !== 'object' ||
            Array.isArray(changedLkg))) throw new TypeError('Revised LKG source must be an object');
        const earliest = changedLkg ? utc(changedLkg.earliestPossibleAt, 'Earliest LKG') :
            priorLkg?.earliest_possible_at;
        const latest = changedLkg ? utc(changedLkg.latestPossibleAt, 'Latest LKG') :
            priorLkg?.latest_possible_at;
        if (changedLkg && (earliest > latest || latest >= incident.detected_at)) {
            throw new Error('Revised LKG bounds must precede incident detection');
        }
        const lkgMode = changedLkg ? 'revalidated' : priorLkg ? 'carried-forward' : 'unknown-start';
        let lkg = null;
        if (changedLkg || priorLkg) {
            const lkgId = `${incident.id}-LKG-R${nextNo}`;
            tx.prepare(`INSERT INTO lkg_observations(id,incident_revision_id,aoi_inspection_id,
                earliest_possible_at,latest_possible_at,method,sample_scope,limitation,
                recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
                .run(lkgId, revisionId, changedLkg ? required(changedLkg.aoiInspectionId,
                    'Revised LKG AOI source') : priorLkg.aoi_inspection_id,
                earliest, latest, changedLkg ? required(changedLkg.method, 'Revised LKG method') :
                    `Carried forward from ${priorLkg.id}: ${priorLkg.method}`,
                changedLkg ? required(changedLkg.sampleScope, 'Revised LKG sample scope') :
                    priorLkg.sample_scope,
                changedLkg ? required(changedLkg.limitation, 'Revised LKG limitation') :
                    priorLkg.limitation, actor.id, at);
            lkg = tx.prepare('SELECT * FROM lkg_observations WHERE id=?').get(lkgId);
        }
        const query = buildSourceTraceQuery(tx, { equipmentId: incident.equipment_id,
            moduleId: incident.module_id,
            recipeRevisionId: oldProposal.recipe_revision_id,
            defectCodeId: incident.defect_code_id,
            earliestLkgAt: lkg?.earliest_possible_at ?? null,
            latestLkgAt: lkg?.latest_possible_at ?? null,
            cutoffAt: incident.detected_at });
        const result = calculateExposure(query);
        const resultJson = JSON.stringify(result);
        const digest = sha256(resultJson);
        const proposalId = `${incident.id}-TRACE-R${nextNo}`;
        tx.prepare(`INSERT INTO trace_proposals(id,incident_revision_id,proposer_actor_id,
            recipe_revision_id,lkg_observation_id,earliest_trace_at,cutoff_at,query_json,
            result_json,result_digest,proposed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
            .run(proposalId, revisionId, actor.id, oldProposal.recipe_revision_id,
                lkg?.id ?? null, query.earliestTraceAt, incident.detected_at,
                JSON.stringify(query), resultJson, digest, at);
        const insertCandidate = tx.prepare(`INSERT INTO trace_candidates(id,proposal_id,lot_id,
            classification,reason,details_json,targeted_defects,certain_interval_defects)
            VALUES (?,?,?,?,?,?,?,?)`);
        for (const lot of result.lots) {
            insertCandidate.run(`${proposalId}-${lot.lotId}`, proposalId, lot.lotId,
                lot.classification, lot.reason, JSON.stringify(lot), lot.targetedDefects,
                lot.certainIntervalDefects);
        }
        tx.prepare('UPDATE incidents SET updated_at=? WHERE id=?').run(at, incident.id);
        appendAuditEvent(tx, { actorId: actor.id, recordedAt: at, entityType: 'incident',
            entityId: incident.id, entityRevisionId: revisionId, action: 'trace-revised',
            priorState: 'Trace Proposed', reason: lkgMode === 'unknown-start' ?
                `${reason}; unknown LKG start` : reason,
            payload: { parentRevisionId: revision.id, priorProposalId: oldProposal.id,
                priorReviewId: oldReview.id, priorLkgId: priorLkg?.id ?? null,
                lkgMode, lkgId: lkg?.id ?? null, proposalId, resultDigest: digest,
                lkgSource: lkg ? { aoiInspectionId: lkg.aoi_inspection_id,
                    earliestPossibleAt: lkg.earliest_possible_at,
                    latestPossibleAt: lkg.latest_possible_at, method: lkg.method,
                    sampleScope: lkg.sample_scope, limitation: lkg.limitation } : null,
                sourceRunIds: query.runs.map(run => run.id),
                candidateLotIds: result.lots.map(lot => lot.lotId) } });
        return { revisionId, proposalId, state: 'Trace Proposed', lots: result.lots,
            window: result.window, resultDigest: digest };
    });
}
