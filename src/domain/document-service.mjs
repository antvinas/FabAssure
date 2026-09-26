import { withValidatedTransaction } from '../data/db.mjs';
import { appendAuditEvent } from './audit.mjs';

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

function context(tx, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('Document feedback input is required');
    }
    const incidentId = stableId(input.incidentId, 'Incident ID');
    const incident = tx.prepare('SELECT * FROM incidents WHERE id=?').get(incidentId);
    if (!incident || incident.state !== 'CAPA In Progress') {
        throw new Error('Incident must be in CAPA In Progress state');
    }
    const revision = tx.prepare(`SELECT * FROM incident_revisions WHERE incident_id=?
        ORDER BY revision_no DESC LIMIT 1`).get(incidentId);
    if (!revision || !Number.isSafeInteger(input.expectedRevisionNo) ||
        input.expectedRevisionNo !== revision.revision_no) {
        throw new Error('Stale incident revision');
    }
    const cycleId = stableId(input.cycleId, 'CAPA cycle ID');
    if (!tx.prepare(`SELECT 1 FROM incident_cycles WHERE id=? AND incident_id=?
        AND cycle_no=?`).get(cycleId, incidentId, incident.cycle_no)) {
        throw new Error('Current CAPA cycle is missing');
    }
    const at = utc(input.at, 'Decision time');
    if (at <= incident.updated_at) {
        throw new Error('Document feedback decision must follow prior event');
    }
    return { incident, revision, cycleId, at };
}

function decisionTransaction(db, operation) {
    return withValidatedTransaction(db, tx => {
        const before = tx.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        const result = operation(tx);
        const after = tx.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        if (after !== before + 1) {
            throw new Error('Document feedback decision requires one audit event');
        }
        return result;
    });
}

export function proposeDocumentFeedback(db, input) {
    return decisionTransaction(db, tx => {
        const { incident, revision, cycleId, at } = context(tx, input);
        const proposer = actor(tx, input.actorId, ['Quality Engineer',
            'Manufacturing Engineer', 'Equipment / Automation Engineer']);
        const feedbackId = stableId(input.id, 'Feedback ID');
        const actionId = stableId(input.capaActionId, 'CAPA action ID');
        const action = tx.prepare(`SELECT a.id,r.id AS review_id,r.reviewed_at
            FROM capa_actions a JOIN capa_action_reviews r ON r.action_id=a.id
            WHERE a.id=? AND a.cycle_id=? AND a.incident_id=? AND r.decision='Pass'`)
            .get(actionId, cycleId, incident.id);
        if (!action || action.reviewed_at >= at) {
            throw new Error('Passed CAPA action review is required for feedback');
        }
        const documentId = stableId(input.documentId, 'Controlled document ID');
        const document = tx.prepare(`SELECT * FROM controlled_documents
            WHERE id=? AND scope_equipment_id=? AND defect_code_id=?`)
            .get(documentId, incident.equipment_id, incident.defect_code_id);
        if (!document) throw new Error('Controlled document does not match incident scope');
        const baseRevisionId = stableId(input.baseRevisionId, 'Base document revision ID');
        const latest = tx.prepare(`SELECT id FROM document_revisions WHERE document_id=?
            ORDER BY revision_no DESC LIMIT 1`).get(documentId);
        if (!latest || latest.id !== baseRevisionId) {
            throw new Error('Current controlled-document revision is required');
        }
        const proposedSummary = required(input.proposedSummary, 'Synthetic feedback summary');
        tx.prepare(`INSERT INTO feedback_actions(id,cycle_id,incident_id,capa_action_id,
            document_id,base_revision_id,proposed_summary,proposed_by,proposed_at)
            VALUES (?,?,?,?,?,?,?,?,?)`).run(feedbackId, cycleId, incident.id,
                actionId, documentId, baseRevisionId, proposedSummary, proposer.id, at);
        tx.prepare('UPDATE incidents SET updated_at=? WHERE id=?').run(at, incident.id);
        appendAuditEvent(tx, { actorId: proposer.id, recordedAt: at,
            entityType: 'incident', entityId: incident.id, entityRevisionId: revision.id,
            action: 'document-feedback-proposed', reason: proposedSummary,
            payload: { cycleId, feedbackId, documentId, baseRevisionId, actionId,
                actionReviewId: action.review_id } });
        return { cycleId, feedbackId, documentId, baseRevisionId };
    });
}

export function reviewDocumentFeedback(db, input) {
    return decisionTransaction(db, tx => {
        const { incident, revision, cycleId, at } = context(tx, input);
        const reviewer = actor(tx, input.actorId, ['Reviewer', 'Quality Engineer', 'Approver']);
        const feedbackId = stableId(input.feedbackId, 'Feedback ID');
        const feedback = tx.prepare(`SELECT * FROM feedback_actions WHERE id=?
            AND cycle_id=? AND incident_id=?`).get(feedbackId, cycleId, incident.id);
        if (!feedback) throw new Error('Current document feedback is missing');
        if (feedback.proposed_by === reviewer.id) {
            throw new Error('Independent document feedback reviewer required');
        }
        const decision = required(input.decision, 'Feedback review decision');
        if (!['Pass', 'Needs Rework'].includes(decision)) {
            throw new Error('Feedback review must Pass or Needs Rework');
        }
        const verificationKind = required(input.verificationKind, 'Verification kind');
        const verificationId = stableId(input.verificationId, 'Verification ID');
        const reason = required(input.reason, 'Feedback review reason');
        const reviewId = `${feedbackId}-REVIEW`;
        tx.prepare(`INSERT INTO feedback_reviews(id,feedback_id,reviewer_actor_id,
            decision,verification_kind,verification_id,reason,reviewed_at)
            VALUES (?,?,?,?,?,?,?,?)`).run(reviewId, feedbackId, reviewer.id,
                decision, verificationKind, verificationId, reason, at);
        tx.prepare('UPDATE incidents SET updated_at=? WHERE id=?').run(at, incident.id);
        appendAuditEvent(tx, { actorId: reviewer.id, recordedAt: at,
            entityType: 'incident', entityId: incident.id, entityRevisionId: revision.id,
            action: 'document-feedback-reviewed', reason,
            payload: { cycleId, feedbackId, reviewId, decision, verificationKind,
                verificationId } });
        return { cycleId, feedbackId, reviewId, decision };
    });
}

export function approveDocumentRevision(db, input) {
    return decisionTransaction(db, tx => {
        const { incident, revision, cycleId, at } = context(tx, input);
        const approver = actor(tx, input.actorId, ['Approver', 'Quality Engineer']);
        const feedbackId = stableId(input.feedbackId, 'Feedback ID');
        const feedback = tx.prepare(`SELECT f.*,r.id AS review_id,
            r.reviewer_actor_id,r.reviewed_at FROM feedback_actions f
            JOIN feedback_reviews r ON r.feedback_id=f.id AND r.decision='Pass'
            WHERE f.id=? AND f.cycle_id=? AND f.incident_id=?`)
            .get(feedbackId, cycleId, incident.id);
        if (!feedback || feedback.reviewed_at >= at) {
            throw new Error('Passing feedback review is required before document approval');
        }
        if (approver.id === feedback.proposed_by ||
            approver.id === feedback.reviewer_actor_id) {
            throw new Error('Separate controlled-document approver required');
        }
        const latest = tx.prepare(`SELECT id,revision_no FROM document_revisions
            WHERE document_id=? ORDER BY revision_no DESC LIMIT 1`).get(feedback.document_id);
        if (!latest || latest.id !== feedback.base_revision_id) {
            throw new Error('Controlled-document base revision is stale');
        }
        const reason = required(input.reason, 'Document approval reason');
        const revisionNo = latest.revision_no + 1;
        const revisionId = `${feedback.document_id}-R${revisionNo}`;
        tx.prepare(`INSERT INTO document_revisions(id,document_id,revision_no,
            parent_revision_id,source_feedback_id,summary,approved_by,approved_at)
            VALUES (?,?,?,?,?,?,?,?)`).run(revisionId, feedback.document_id, revisionNo,
                latest.id, feedbackId, feedback.proposed_summary, approver.id, at);
        tx.prepare('UPDATE incidents SET updated_at=? WHERE id=?').run(at, incident.id);
        appendAuditEvent(tx, { actorId: approver.id, recordedAt: at,
            entityType: 'incident', entityId: incident.id, entityRevisionId: revision.id,
            action: 'document-revision-approved', reason,
            payload: { cycleId, feedbackId, feedbackReviewId: feedback.review_id,
                documentId: feedback.document_id, parentRevisionId: latest.id,
                revisionId, revisionNo } });
        return { cycleId, documentId: feedback.document_id, revisionId, revisionNo };
    });
}
