import { withValidatedTransaction } from '../data/db.mjs';
import { appendAuditEvent } from './audit.mjs';
import { assertStateTransition } from './state.mjs';

function required(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError(`${label} is required`);
    }
    return value.trim();
}

function stableId(value, label) {
    const text = required(value, label);
    if (!/^[A-Z][A-Z0-9-]{2,79}$/.test(text)) {
        throw new TypeError(`${label} must be a synthetic stable ID`);
    }
    return text;
}

function utc(value, label) {
    const text = required(value, label);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) ||
        !Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
        throw new TypeError(`${label} must be canonical UTC`);
    }
    return text;
}

function actor(tx, id, roles) {
    const actorId = stableId(id, 'Simulated actor ID');
    const row = tx.prepare('SELECT id,role FROM demo_actors WHERE id=?').get(actorId);
    if (!row || !roles.includes(row.role)) {
        throw new Error('Required simulated actor role is missing');
    }
    return row;
}

function incidentContext(tx, input, state) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('CAPA input is required');
    }
    const incidentId = stableId(input.incidentId, 'Incident ID');
    const incident = tx.prepare('SELECT * FROM incidents WHERE id=?').get(incidentId);
    if (!incident) throw new Error(`Unknown incident: ${incidentId}`);
    const revision = tx.prepare(`SELECT * FROM incident_revisions
        WHERE incident_id=? ORDER BY revision_no DESC LIMIT 1`).get(incidentId);
    if (!revision || !Number.isSafeInteger(input.expectedRevisionNo) ||
        input.expectedRevisionNo !== revision.revision_no) {
        throw new Error('Stale incident revision');
    }
    const states = Array.isArray(state) ? state : [state];
    if (!states.includes(incident.state)) throw new Error(`Incident state must be ${states.join(' or ')}`);
    const at = utc(input.at, 'Decision time');
    const serverNow = utc(input.serverNow ?? new Date().toISOString(), 'Server UTC time');
    if (at > serverNow) throw new Error('CAPA decision time cannot exceed server UTC time');
    if (at <= incident.updated_at) throw new Error('CAPA decision must follow prior event');
    return { incident, revision, at };
}

function decisionTransaction(db, operation) {
    return withValidatedTransaction(db, tx => {
        const before = tx.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        const result = operation(tx);
        const after = tx.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        if (after !== before + 1) throw new Error('CAPA decision requires one audit event');
        return result;
    });
}

export function startIncidentCapa(db, input) {
    return decisionTransaction(db, tx => {
        const { incident, revision, at } = incidentContext(tx, input,
            ['Scope Reviewed', 'Reopened']);
        const starter = actor(tx, input.actorId, ['Quality Engineer', 'Production Manager']);
        const reason = required(input.reason, 'CAPA start reason');
        const scope = incident.cycle_no === 1 ? tx.prepare(`SELECT s.id,s.reviewed_at
            FROM scope_reviews s JOIN trace_proposals p ON p.id=s.proposal_id
            WHERE p.incident_revision_id=? AND s.decision='Pass'
            ORDER BY s.reviewed_at DESC,s.id DESC LIMIT 1`).get(revision.id) : null;
        if (incident.cycle_no === 1 && (!scope || scope.reviewed_at >= at)) {
            throw new Error('Independent passing scope review is required before CAPA');
        }
        assertStateTransition('incident', incident.state, 'CAPA In Progress');
        const cycleId = `${incident.id}-CYC-${incident.cycle_no}`;
        let parentCycleId = null;
        if (incident.cycle_no > 1) {
            const parent = tx.prepare(`SELECT c.id,d.decided_at
                FROM incident_cycles c JOIN incident_cycle_decisions d ON d.cycle_id=c.id
                WHERE c.incident_id=? AND c.cycle_no=? AND d.decision='Reopened'`)
                .get(incident.id, incident.cycle_no - 1);
            if (!parent || parent.decided_at >= at) {
                throw new Error('Prior reopened CAPA cycle is required');
            }
            parentCycleId = parent.id;
        }
        tx.prepare(`INSERT INTO incident_cycles(id,incident_id,cycle_no,parent_cycle_id,
            scope_review_id,opened_by,opened_at,reason) VALUES (?,?,?,?,?,?,?,?)`)
            .run(cycleId, incident.id, incident.cycle_no, parentCycleId, scope?.id ?? null,
                starter.id, at, reason);
        const updated = tx.prepare(`UPDATE incidents SET state='CAPA In Progress',updated_at=?
            WHERE id=? AND state=?`).run(at, incident.id, incident.state);
        if (updated.changes !== 1) throw new Error('Stale incident state');
        appendAuditEvent(tx, { actorId: starter.id, recordedAt: at,
            entityType: 'incident', entityId: incident.id, entityRevisionId: revision.id,
            action: 'capa-started', priorState: incident.state,
            newState: 'CAPA In Progress', reason,
            payload: { cycleId, cycleNo: incident.cycle_no, parentCycleId,
                scopeReviewId: scope?.id ?? null } });
        return { cycleId, state: 'CAPA In Progress', cycleNo: incident.cycle_no };
    });
}

export function assessIncidentCause(db, input) {
    return decisionTransaction(db, tx => {
        const { incident, revision, at } = incidentContext(tx, input, 'CAPA In Progress');
        const assessor = actor(tx, input.actorId, ['Quality Engineer',
            'Manufacturing Engineer', 'Equipment / Automation Engineer']);
        const cycleId = stableId(input.cycleId, 'CAPA cycle ID');
        const cycle = tx.prepare(`SELECT id FROM incident_cycles WHERE id=? AND incident_id=?
            AND cycle_no=?`).get(cycleId, incident.id, incident.cycle_no);
        if (!cycle) throw new Error('Current CAPA cycle is missing');
        const causeId = stableId(input.id, 'Cause assessment ID');
        const status = required(input.status, 'Cause status');
        if (!['Hypothesis', 'Confirmed'].includes(status)) {
            throw new Error('Cause status must be Hypothesis or Confirmed');
        }
        const statement = required(input.statement, 'Cause statement');
        const evidenceKind = required(input.evidenceKind, 'Cause evidence kind');
        const evidenceId = stableId(input.evidenceId, 'Cause evidence ID');
        tx.prepare(`INSERT INTO cause_assessments(id,cycle_id,incident_id,status,
            statement,evidence_kind,evidence_id,assessed_by,assessed_at)
            VALUES (?,?,?,?,?,?,?,?,?)`).run(causeId, cycleId, incident.id, status,
                statement, evidenceKind, evidenceId, assessor.id, at);
        tx.prepare('UPDATE incidents SET updated_at=? WHERE id=?').run(at, incident.id);
        appendAuditEvent(tx, { actorId: assessor.id, recordedAt: at,
            entityType: 'incident', entityId: incident.id, entityRevisionId: revision.id,
            action: 'cause-assessed', reason: statement,
            payload: { cycleId, causeId, status, evidenceKind, evidenceId } });
        return { cycleId, causeId, status };
    });
}

export function planCapaAction(db, input) {
    return decisionTransaction(db, tx => {
        const { incident, revision, at } = incidentContext(tx, input, 'CAPA In Progress');
        const proposer = actor(tx, input.actorId, ['Quality Engineer',
            'Manufacturing Engineer', 'Equipment / Automation Engineer']);
        const owner = actor(tx, input.ownerActorId, ['Quality Engineer',
            'Manufacturing Engineer', 'Equipment / Automation Engineer',
            'Production Manager', 'Verification Engineer']);
        const cycleId = stableId(input.cycleId, 'CAPA cycle ID');
        if (!tx.prepare(`SELECT 1 FROM incident_cycles WHERE id=? AND incident_id=?
            AND cycle_no=?`).get(cycleId, incident.id, incident.cycle_no)) {
            throw new Error('Current CAPA cycle is missing');
        }
        const actionId = stableId(input.id, 'CAPA action ID');
        const causeId = stableId(input.causeId, 'Confirmed cause ID');
        const actionType = required(input.actionType, 'CAPA action type');
        if (!['Corrective', 'Preventive'].includes(actionType)) {
            throw new Error('CAPA action type must be Corrective or Preventive');
        }
        const actionText = required(input.actionText, 'CAPA action');
        const dueAt = utc(input.dueAt, 'CAPA due time');
        if (dueAt <= at) throw new Error('CAPA due time must follow action creation');
        const parentActionId = input.parentActionId == null ? null :
            stableId(input.parentActionId, 'Parent CAPA action ID');
        tx.prepare(`INSERT INTO capa_actions(id,cycle_id,incident_id,cause_id,
            action_type,action_text,owner_actor_id,due_at,created_by,created_at,
            parent_action_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
            .run(actionId, cycleId, incident.id, causeId, actionType, actionText,
                owner.id, dueAt, proposer.id, at, parentActionId);
        tx.prepare('UPDATE incidents SET updated_at=? WHERE id=?').run(at, incident.id);
        appendAuditEvent(tx, { actorId: proposer.id, recordedAt: at,
            entityType: 'incident', entityId: incident.id, entityRevisionId: revision.id,
            action: 'capa-action-recorded', reason: actionText,
            payload: { cycleId, actionId, causeId, actionType, ownerActorId: owner.id,
                dueAt, parentActionId } });
        return { cycleId, actionId, actionType, parentActionId };
    });
}

export function reviewCapaAction(db, input) {
    return decisionTransaction(db, tx => {
        const { incident, revision, at } = incidentContext(tx, input, 'CAPA In Progress');
        const reviewer = actor(tx, input.actorId, ['Reviewer', 'Quality Engineer']);
        const cycleId = stableId(input.cycleId, 'CAPA cycle ID');
        const actionId = stableId(input.actionId, 'CAPA action ID');
        const action = tx.prepare(`SELECT a.* FROM capa_actions a
            JOIN incident_cycles c ON c.id=a.cycle_id
            WHERE a.id=? AND a.cycle_id=? AND a.incident_id=? AND c.cycle_no=?`)
            .get(actionId, cycleId, incident.id, incident.cycle_no);
        if (!action) throw new Error('Current CAPA action is missing');
        if (reviewer.id === action.created_by || reviewer.id === action.owner_actor_id) {
            throw new Error('Independent CAPA action reviewer required');
        }
        const decision = required(input.decision, 'CAPA review decision');
        if (!['Pass', 'Needs Rework'].includes(decision)) {
            throw new Error('CAPA review must Pass or Needs Rework');
        }
        const evidenceKind = required(input.evidenceKind, 'CAPA review evidence kind');
        const evidenceId = stableId(input.evidenceId, 'CAPA review evidence ID');
        const reason = required(input.reason, 'CAPA review reason');
        const reviewId = `${actionId}-REVIEW`;
        tx.prepare(`INSERT INTO capa_action_reviews(id,action_id,reviewer_actor_id,
            decision,evidence_kind,evidence_id,reason,reviewed_at)
            VALUES (?,?,?,?,?,?,?,?)`).run(reviewId, actionId, reviewer.id,
                decision, evidenceKind, evidenceId, reason, at);
        tx.prepare('UPDATE incidents SET updated_at=? WHERE id=?').run(at, incident.id);
        appendAuditEvent(tx, { actorId: reviewer.id, recordedAt: at,
            entityType: 'incident', entityId: incident.id, entityRevisionId: revision.id,
            action: 'capa-action-reviewed', reason,
            payload: { cycleId, actionId, reviewId, decision, evidenceKind, evidenceId } });
        return { cycleId, actionId, reviewId, decision };
    });
}
