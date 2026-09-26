import { createHash, randomUUID } from 'node:crypto';
import { withValidatedTransaction } from '../data/db.mjs';
import { appendAuditEvent, verifyAuditChain } from './audit.mjs';
import { applyRiskOverride, classifyRisk, defaultVerificationPlan } from './risk.mjs';
import { assertStateTransition } from './state.mjs';

function text(value, label) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new TypeError(`${label} is required`);
    }
    return value.trim();
}

function utc(value, label) {
    const at = text(value, label);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) ||
        !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) {
        throw new TypeError(`${label} must be canonical UTC`);
    }
    return at;
}

function baselineModuleTransition(db, { equipmentId, baselineModuleId,
    targetModuleId, baselineRunEndAt, createdAt, targetRecipeEffectiveAt,
    frozenEventId = null }) {
    if (baselineModuleId === targetModuleId) return null;
    const event = db.prepare(`
        SELECT e.id,e.occurred_at FROM equipment_events e
        JOIN modules m ON m.id=e.module_id AND m.equipment_id=e.equipment_id
        WHERE e.equipment_id=? AND e.module_id=? AND e.event_type='module-change'
            AND e.occurred_at>? AND e.occurred_at>=?
            AND e.occurred_at<=? AND (? IS NULL OR e.id=?)
        ORDER BY e.occurred_at,e.id LIMIT 1
    `).get(equipmentId, targetModuleId, baselineRunEndAt,
        createdAt, targetRecipeEffectiveAt, frozenEventId, frozenEventId);
    if (!event) {
        throw new Error('Earlier-module baseline requires a timed target-module change event');
    }
    return event;
}

function acceptanceTerms(input, at, label = 'Acceptance') {
    const acceptanceType = input.acceptanceType;
    if (!['Ordinary', 'Conditional'].includes(acceptanceType)) {
        throw new TypeError(`${label} type must be Ordinary or Conditional`);
    }
    if (acceptanceType === 'Ordinary') {
        if (input.condition != null || input.expiresAt != null) {
            throw new TypeError('Ordinary acceptance cannot carry conditional terms');
        }
        return { acceptanceType, condition: null, expiresAt: null };
    }
    if (typeof input.condition !== 'string' || !input.condition.trim()) {
        throw new TypeError('Conditional acceptance requires an exact condition');
    }
    const expiresAt = utc(input.expiresAt, 'Conditional expiry');
    if (expiresAt <= at) throw new Error('Conditional expiry must follow the decision time');
    const serverNow = utc(input.serverNow ?? new Date().toISOString(), 'Server UTC time');
    if (expiresAt <= serverNow) {
        throw new Error('Conditional expiry must be later than the server UTC decision time');
    }
    return { acceptanceType, condition: input.condition, expiresAt };
}

export function getAcceptanceStatus(db, acceptanceId, now) {
    const currentAt = utc(now, 'Server UTC time');
    const acceptance = db.prepare('SELECT * FROM acceptances WHERE id=?').get(acceptanceId);
    if (!acceptance) throw new Error('Acceptance is missing');
    const classification = acceptance.acceptance_type === null ? db.prepare(
        'SELECT * FROM legacy_acceptance_classifications WHERE acceptance_id=?'
    ).get(acceptance.id) : null;
    const type = acceptance.acceptance_type ?? classification?.classification_type ?? 'UNKNOWN';
    const expiresAt = acceptance.acceptance_type === 'Conditional' ? acceptance.expires_at :
        classification?.classification_type === 'Conditional' ? classification.expires_at : null;
    const condition = acceptance.acceptance_type === 'Conditional' ? acceptance.condition_text :
        classification?.classification_type === 'Conditional' ? classification.condition_text : null;
    const recordedExpiry = db.prepare(
        'SELECT id FROM conditional_acceptance_expiries WHERE acceptance_id=?'
    ).get(acceptance.id);
    const expired = type === 'Conditional' &&
        (currentAt >= expiresAt || Boolean(recordedExpiry));
    return { acceptanceId: acceptance.id, type, classificationRequired: type === 'UNKNOWN',
        condition, expiresAt, expired, expiryRecorded: Boolean(recordedExpiry),
        operationallyValid: type !== 'UNKNOWN' && !expired };
}

export function assertOperatingAcceptance(db, changeRevisionId, now) {
    if (changeRevisionId == null) return null;
    const acceptance = db.prepare(`SELECT a.id,h.id AS change_id,h.state,
        h.current_revision_no,r.revision_no
        FROM acceptances a JOIN change_revisions r ON r.id=a.change_revision_id
        JOIN changes h ON h.id=r.change_id WHERE a.change_revision_id=?`
    ).get(changeRevisionId);
    if (!acceptance) throw new Error('Linked Change Acceptance is missing');
    const linkedStatus = getAcceptanceStatus(db, acceptance.id, now);
    if (linkedStatus.classificationRequired) {
        throw new Error('Legacy Change Acceptance requires Approver classification before operating use');
    }
    if (!['Accepted', 'Effectiveness Monitoring', 'Closed'].includes(acceptance.state)) {
        if (linkedStatus.expired) throw new Error('Conditional Change Acceptance has expired');
        throw new Error('Linked Change Acceptance is not a current operating approval');
    }
    let authority = acceptance;
    let authorityRevisionId = changeRevisionId;
    if (acceptance.current_revision_no !== acceptance.revision_no) {
        if (!linkedStatus.expired || !linkedStatus.expiryRecorded) {
            throw new Error('Linked Change Acceptance is not a current operating approval');
        }
        const current = db.prepare(`SELECT a.id,r.id AS revision_id,r.parent_revision_id
            FROM changes h JOIN change_revisions r ON r.change_id=h.id
                AND r.revision_no=h.current_revision_no
            JOIN acceptances a ON a.change_revision_id=r.id WHERE h.id=?`
        ).get(acceptance.change_id);
        if (!current) throw new Error('A new accepted Change revision is required after expiry');
        let cursor = current.revision_id;
        const visited = new Set();
        while (cursor !== changeRevisionId) {
            if (visited.has(cursor)) throw new Error('Change revision lineage is cyclic');
            visited.add(cursor);
            const row = db.prepare(`SELECT parent_revision_id FROM change_revisions
                WHERE id=? AND change_id=?`).get(cursor, acceptance.change_id);
            if (!row?.parent_revision_id) {
                throw new Error('New Change approval is not a descendant of the linked revision');
            }
            cursor = row.parent_revision_id;
        }
        authority = current;
        authorityRevisionId = current.revision_id;
    }
    const status = getAcceptanceStatus(db, authority.id, now);
    if (status.classificationRequired) {
        throw new Error('Legacy Change Acceptance requires Approver classification before operating use');
    }
    if (status.expired) throw new Error('Conditional Change Acceptance has expired');
    return { ...status, linkedRevisionId: changeRevisionId,
        authorityRevisionId, renewedAuthority: authorityRevisionId !== changeRevisionId };
}

export function classifyLegacyAcceptance(db, input) {
    return decisionTransaction(db, tx => {
        const acceptanceId = text(input.acceptanceId, 'Acceptance ID');
        const acceptance = tx.prepare('SELECT * FROM acceptances WHERE id=?').get(acceptanceId);
        if (!acceptance || acceptance.acceptance_type !== null) {
            throw new Error('A legacy Acceptance with unknown type is required');
        }
        if (tx.prepare('SELECT id FROM legacy_acceptance_classifications WHERE acceptance_id=?')
            .get(acceptanceId)) throw new Error('Legacy Acceptance already classified');
        const approver = actor(tx, input.actorId, 'Approver');
        const at = utc(input.at, 'Classification UTC time');
        if (at <= acceptance.accepted_at) throw new Error('Classification must follow original Acceptance');
        const serverNow = utc(input.serverNow ?? new Date().toISOString(),
            'Server UTC time');
        if (at > serverNow) {
            throw new Error('Classification time cannot exceed server UTC time');
        }
        if (input.acceptanceType !== 'Ordinary' && input.acceptanceType !== 'Conditional') {
            throw new TypeError('Legacy classification requires an explicit Ordinary or Conditional choice');
        }
        const terms = acceptanceTerms(input, at, 'Classification');
        const revision = tx.prepare('SELECT * FROM change_revisions WHERE id=?')
            .get(acceptance.change_revision_id);
        const id = text(input.id, 'Classification ID');
        const reason = text(input.reason, 'Classification reason');
        const audit = appendAuditEvent(tx, {
            actorId: approver.id, recordedAt: at, entityType: 'change',
            entityId: revision.change_id, entityRevisionId: revision.id,
            action: 'legacy-acceptance-classified', reason,
            payload: { acceptanceId, classificationType: terms.acceptanceType,
                condition: terms.condition, expiresAt: terms.expiresAt }
        });
        tx.prepare(`INSERT INTO legacy_acceptance_classifications
            (id,acceptance_id,classification_type,condition_text,expires_at,
                classified_by,classified_at,audit_event_id)
            VALUES (?,?,?,?,?,?,?,?)`).run(id, acceptanceId, terms.acceptanceType,
                terms.condition, terms.expiresAt, approver.id, at, audit.id);
        return { id, acceptanceId, classificationType: terms.acceptanceType,
            expiresAt: terms.expiresAt, auditEventId: audit.id };
    });
}

export function reconcileConditionalAcceptances(db, now) {
    const observedAt = utc(now, 'Server UTC time');
    const due = db.prepare(`SELECT a.id,a.change_revision_id,
            COALESCE(a.expires_at,c.expires_at) AS expires_at
        FROM acceptances a
        LEFT JOIN legacy_acceptance_classifications c ON c.acceptance_id=a.id
        JOIN change_revisions r ON r.id=a.change_revision_id
        JOIN changes h ON h.id=r.change_id AND h.current_revision_no=r.revision_no
        WHERE (a.acceptance_type='Conditional' OR
            (a.acceptance_type IS NULL AND c.classification_type='Conditional'))
            AND COALESCE(a.expires_at,c.expires_at)<=?
            AND h.state IN ('Accepted','Effectiveness Monitoring','Closed')
            AND NOT EXISTS (SELECT 1 FROM conditional_acceptance_expiries e
                WHERE e.acceptance_id=a.id)
        ORDER BY expires_at,a.id`).all(observedAt);
    const results = [];
    for (const item of due) {
        const result = withValidatedTransaction(db, tx => {
            if (tx.prepare('SELECT id FROM conditional_acceptance_expiries WHERE acceptance_id=?')
                .get(item.id)) return null;
            const revision = tx.prepare('SELECT * FROM change_revisions WHERE id=?')
                .get(item.change_revision_id);
            const change = tx.prepare('SELECT * FROM changes WHERE id=?')
                .get(revision.change_id);
            if (change.current_revision_no !== revision.revision_no ||
                !['Accepted', 'Effectiveness Monitoring', 'Closed'].includes(change.state)) return null;
            if (observedAt < change.updated_at) return null;
            assertStateTransition('change', change.state, 'Reopened', { newCycle: true });
            const nextCycleNo = change.cycle_no + 1;
            const updated = tx.prepare(`UPDATE changes SET state='Reopened',cycle_no=?,updated_at=?
                WHERE id=? AND state=? AND cycle_no=? AND current_revision_no=?`)
                .run(nextCycleNo, observedAt, change.id, change.state, change.cycle_no,
                    revision.revision_no);
            if (updated.changes !== 1) throw new Error('Stale Change expiry state');
            const audit = appendAuditEvent(tx, {
                systemPrincipalId: 'SYS-SERVER-CLOCK', recordedAt: observedAt,
                entityType: 'change', entityId: change.id, entityRevisionId: revision.id,
                action: 'conditional-acceptance-expired', priorState: change.state,
                newState: 'Reopened', reason: 'Conditional Acceptance reached its UTC expiry',
                payload: { acceptanceId: item.id, expiresAt: item.expires_at,
                    observedAt, priorCycleNo: change.cycle_no, newCycleNo: nextCycleNo }
            });
            const id = `EXP-${randomUUID()}`;
            tx.prepare(`INSERT INTO conditional_acceptance_expiries
                (id,acceptance_id,change_revision_id,effective_at,observed_at,
                    prior_state,new_state,prior_cycle_no,new_cycle_no,audit_event_id)
                VALUES (?,?,?,?,? ,?,'Reopened',?,?,?)`).run(id, item.id,
                    revision.id, item.expires_at, observedAt, change.state,
                    change.cycle_no, nextCycleNo, audit.id);
            return { id, acceptanceId: item.id, auditEventId: audit.id };
        });
        if (result) results.push(result);
    }
    return results;
}

export function reviseExpiredChange(db, input) {
    return decisionTransaction(db, tx => {
        const change = currentChange(tx, input);
        if (change.state !== 'Reopened') throw new Error('An expired reopened Change is required');
        const proposer = actor(tx, input.actorId);
        if (proposer.id !== change.proposer_actor_id) {
            throw new Error('Only the original proposer may start the renewal revision');
        }
        const at = utc(input.at, 'Renewal revision UTC time');
        const serverNow = utc(input.serverNow ?? new Date().toISOString(),
            'Server UTC time');
        if (at <= change.updated_at || at > serverNow) {
            throw new Error('Renewal revision time must follow expiry and not exceed server UTC time');
        }
        const reason = text(input.reason, 'Renewal reason');
        const oldRevisionId = revisionIdFor(change);
        const expiry = tx.prepare(`SELECT e.*,a.frozen_digest,a.condition_text,
                a.expires_at,c.condition_text AS classified_condition
            FROM conditional_acceptance_expiries e
            JOIN acceptances a ON a.id=e.acceptance_id
            LEFT JOIN legacy_acceptance_classifications c ON c.acceptance_id=a.id
            WHERE e.change_revision_id=?`).get(oldRevisionId);
        if (!expiry) throw new Error('Audited conditional expiry is required');
        assertStateTransition('change', change.state, 'Draft', { newRevision: true });
        const revisionNo = change.current_revision_no + 1;
        const revisionId = `${change.id}-R${revisionNo}`;
        tx.prepare(`INSERT INTO change_revisions
            (id,change_id,revision_no,parent_revision_id,created_by,created_at,reason)
            VALUES (?,?,?,?,?,?,?)`).run(revisionId, change.id, revisionNo,
                oldRevisionId, proposer.id, at, reason);
        const updated = tx.prepare(`UPDATE changes SET state='Draft',current_revision_no=?,updated_at=?
            WHERE id=? AND state='Reopened' AND current_revision_no=?`)
            .run(revisionNo, at, change.id, change.current_revision_no);
        if (updated.changes !== 1) throw new Error('Stale expired Change state');
        appendAuditEvent(tx, {
            actorId: proposer.id, recordedAt: at, entityType: 'change', entityId: change.id,
            entityRevisionId: revisionId, action: 'change-revised-after-expiry',
            priorState: 'Reopened', newState: 'Draft', reason,
            payload: { priorRevisionId: oldRevisionId, priorAcceptanceId: expiry.acceptance_id,
                expiryEventId: expiry.id, expiryAuditId: expiry.audit_event_id,
                priorFrozenDigest: expiry.frozen_digest,
                priorCondition: expiry.condition_text ?? expiry.classified_condition,
                priorExpiresAt: expiry.effective_at,
                lineId: change.line_id, equipmentId: change.equipment_id,
                moduleId: change.module_id, recipeRevisionId: change.recipe_revision_id,
                baselineRef: change.baseline_ref }
        });
        return { id: change.id, revisionId, revisionNo, state: 'Draft',
            priorAcceptanceId: expiry.acceptance_id };
    });
}

export function reviseFailedEffectivenessChange(db, input) {
    return decisionTransaction(db, tx => {
        const change = currentChange(tx, input);
        if (change.state !== 'Reopened') {
            throw new Error('A Change reopened after failed effectiveness is required');
        }
        const proposer = actor(tx, input.actorId);
        if (proposer.id !== change.proposer_actor_id) {
            throw new Error('Only the original proposer may start the next Change revision');
        }
        const at = utc(input.at, 'New revision UTC time');
        const serverNow = utc(input.serverNow ?? new Date().toISOString(),
            'Server UTC time');
        if (at <= change.updated_at || at > serverNow) {
            throw new Error('New revision time must follow reopen and not exceed server UTC time');
        }
        const reason = text(input.reason, 'New revision reason');
        const priorRevisionId = revisionIdFor(change);
        const events = tx.prepare(`SELECT id,recorded_at,payload_json
            FROM audit_events WHERE entity_type='change' AND entity_id=?
                AND entity_revision_id=? AND action='change-monitoring-reopened'
                AND prior_state IN ('Closed','Effectiveness Monitoring')
                AND new_state='Reopened'
            ORDER BY sequence DESC LIMIT 1`).all(change.id, priorRevisionId);
        const reopen = events[0];
        const payload = reopen ? JSON.parse(reopen.payload_json) : null;
        if (!reopen || reopen.recorded_at !== change.updated_at ||
            payload?.nextCycleNo !== change.cycle_no ||
            payload?.priorCycleNo !== change.cycle_no - 1 ||
            typeof payload.failedCheckId !== 'string') {
            throw new Error('Audited failed-effectiveness reopen is required');
        }
        const priorAcceptance = tx.prepare(`SELECT * FROM acceptances
            WHERE id=? AND change_revision_id=?`)
            .get(payload.acceptanceId, priorRevisionId);
        if (!priorAcceptance) throw new Error('Prior accepted Change history is missing');
        assertStateTransition('change', change.state, 'Draft', { newRevision: true });
        const revisionNo = change.current_revision_no + 1;
        const revisionId = `${change.id}-R${revisionNo}`;
        tx.prepare(`INSERT INTO change_revisions
            (id,change_id,revision_no,parent_revision_id,created_by,created_at,reason)
            VALUES (?,?,?,?,?,?,?)`).run(revisionId, change.id, revisionNo,
            priorRevisionId, proposer.id, at, reason);
        const updated = tx.prepare(`UPDATE changes SET state='Draft',
            current_revision_no=?,updated_at=?
            WHERE id=? AND state='Reopened' AND current_revision_no=?
                AND cycle_no=?`).run(revisionNo, at, change.id,
            change.current_revision_no, change.cycle_no);
        if (updated.changes !== 1) throw new Error('Stale reopened Change state');
        appendAuditEvent(tx, { actorId: proposer.id, recordedAt: at,
            entityType: 'change', entityId: change.id,
            entityRevisionId: revisionId,
            action: 'change-revised-after-effectiveness-failure',
            priorState: 'Reopened', newState: 'Draft', reason,
            payload: { priorRevisionId, priorAcceptanceId: priorAcceptance.id,
                priorFrozenDigest: priorAcceptance.frozen_digest,
                priorCycleNo: payload.priorCycleNo, cycleNo: change.cycle_no,
                reopenDecisionId: payload.decisionId,
                reopenAuditId: reopen.id,
                failedCheckId: payload.failedCheckId,
                priorClosureId: payload.priorClosureId,
                lineId: change.line_id, equipmentId: change.equipment_id,
                moduleId: change.module_id,
                recipeRevisionId: change.recipe_revision_id,
                baselineRef: change.baseline_ref } });
        return { id: change.id, revisionId, revisionNo,
            state: 'Draft', priorAcceptanceId: priorAcceptance.id };
    });
}

function actor(tx, id, requiredRole = null) {
    const actorId = text(id, 'Actor ID');
    const row = tx.prepare('SELECT id,role FROM demo_actors WHERE id=?').get(actorId);
    if (!row) throw new Error(`Unknown simulated actor: ${actorId}`);
    if (requiredRole && row.role !== requiredRole) throw new Error(`${requiredRole} role is required`);
    return row;
}

function decisionTransaction(db, operation) {
    return withValidatedTransaction(db, tx => {
        const before = tx.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        const value = operation(tx);
        const after = tx.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        if (after !== before + 1) throw new Error('Domain decision requires exactly one audit event');
        return value;
    });
}

function currentChange(tx, input) {
    const id = text(input.changeId, 'Change ID');
    const row = tx.prepare('SELECT * FROM changes WHERE id=?').get(id);
    if (!row) throw new Error(`Unknown change: ${id}`);
    if (!Number.isInteger(input.expectedRevisionNo) ||
        row.current_revision_no !== input.expectedRevisionNo) {
        throw new Error('Stale change revision');
    }
    const at = utc(input.at, 'Decision UTC time');
    const serverNow = utc(input.serverNow ?? new Date().toISOString(),
        'Server UTC time');
    if (at > serverNow) throw new Error('Decision time cannot exceed server UTC time');
    return row;
}

function transition(tx, change, to, at) {
    assertStateTransition('change', change.state, to);
    if (at < change.updated_at) throw new Error('Decision time precedes the previous change event');
    const result = tx.prepare(
        'UPDATE changes SET state=?,updated_at=? WHERE id=? AND state=? AND current_revision_no=?'
    ).run(to, at, change.id, change.state, change.current_revision_no);
    if (result.changes !== 1) throw new Error('Stale change state');
}

export function createChange(db, input) {
    return decisionTransaction(db, tx => {
        if (!input || typeof input !== 'object') throw new TypeError('Change input is required');
        const proposer = actor(tx, input.actorId);
        if (!['Manufacturing Engineer', 'Equipment / Automation Engineer', 'Quality Engineer', 'Production Manager'].includes(proposer.role)) {
            throw new Error('A proposing manufacturing, equipment, quality or production role is required');
        }
        const id = text(input.id, 'Change ID');
        const lineId = text(input.lineId, 'Line ID');
        const equipmentId = text(input.equipmentId, 'Equipment ID');
        const moduleId = text(input.moduleId, 'Module ID');
        const recipeRevisionId = text(input.recipeRevisionId, 'Recipe revision ID');
        const baselineRef = text(input.baselineRef, 'Baseline evidence reference');
        const at = utc(input.at, 'Decision UTC time');
        const serverNow = utc(input.serverNow ?? new Date().toISOString(),
            'Server UTC time');
        if (at > serverNow) throw new Error('Decision time cannot exceed server UTC time');
        const equipment = tx.prepare('SELECT line_id FROM equipment WHERE id=?').get(equipmentId);
        if (!equipment || equipment.line_id !== lineId) throw new Error('Equipment and line scope mismatch');
        const baseline = tx.prepare(`
            SELECT r.equipment_id,r.module_id,r.end_at AS run_end_at,
                recipe.recipe_code FROM aoi_inspections a
            JOIN process_runs r ON r.id=a.process_run_id
            JOIN recipe_revisions recipe ON recipe.id=r.recipe_revision_id WHERE a.id=?
        `).get(baselineRef);
        if (!baseline || baseline.equipment_id !== equipmentId || baseline.run_end_at >= at) {
            throw new Error('Baseline AOI source does not match earlier change equipment scope');
        }
        const targetRecipe = tx.prepare(
            'SELECT recipe_code,effective_at FROM recipe_revisions WHERE id=?'
        ).get(recipeRevisionId);
        if (!targetRecipe || targetRecipe.recipe_code !== baseline.recipe_code) {
            throw new Error('Proposed recipe family does not match the baseline source scope');
        }
        const transitionEvent = baselineModuleTransition(tx, {
            equipmentId, baselineModuleId: baseline.module_id,
            targetModuleId: moduleId, baselineRunEndAt: baseline.run_end_at,
            createdAt: at, targetRecipeEffectiveAt: targetRecipe.effective_at
        });
        tx.prepare(`
            INSERT INTO changes (
                id,title,proposer_actor_id,line_id,equipment_id,module_id,
                recipe_revision_id,reason,baseline_ref,state,created_at,updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
            id, text(input.title, 'Change title'), proposer.id, lineId, equipmentId, moduleId,
            recipeRevisionId, text(input.reason, 'Change reason'), baselineRef, 'Draft', at, at
        );
        const revisionId = `${id}-R1`;
        tx.prepare(`
            INSERT INTO change_revisions(id,change_id,revision_no,created_by,created_at,reason)
            VALUES (?,?,1,?,?,?)
        `).run(revisionId, id, proposer.id, at, text(input.reason, 'Change reason'));
        appendAuditEvent(tx, {
            actorId: proposer.id, recordedAt: at, entityType: 'change', entityId: id,
            entityRevisionId: revisionId, action: 'change-created', newState: 'Draft',
            reason: input.reason,
            payload: { lineId, equipmentId, moduleId, recipeRevisionId, baselineRef,
                ...(transitionEvent ? { baselineModuleId: baseline.module_id,
                    moduleTransitionEventId: transitionEvent.id } : {}) }
        });
        return { id, revisionId, state: 'Draft' };
    });
}

export function submitChange(db, input) {
    return decisionTransaction(db, tx => {
        const change = currentChange(tx, input);
        const proposer = actor(tx, input.actorId);
        if (proposer.id !== change.proposer_actor_id) throw new Error('Only the proposer may submit this change');
        const at = text(input.at, 'Decision UTC time');
        transition(tx, change, 'Submitted', at);
        appendAuditEvent(tx, {
            actorId: proposer.id, recordedAt: at, entityType: 'change', entityId: change.id,
            entityRevisionId: `${change.id}-R${change.current_revision_no}`,
            action: 'change-submitted', priorState: change.state, newState: 'Submitted',
            payload: { baselineRef: change.baseline_ref }
        });
        return { id: change.id, state: 'Submitted' };
    });
}

export function classifyChange(db, input) {
    return decisionTransaction(db, tx => {
        const change = currentChange(tx, input);
        const quality = actor(tx, input.actorId, 'Quality Engineer');
        const at = text(input.at, 'Decision UTC time');
        assertStateTransition('change', change.state, 'Risk Classified');
        const risk = classifyRisk(input.riskInputs);
        const revisionId = `${change.id}-R${change.current_revision_no}`;
        const stored = tx.prepare('SELECT id FROM change_revisions WHERE id=? AND change_id=?').get(revisionId, change.id);
        if (!stored) throw new Error('Current change revision is missing');
        const assessmentId = text(input.assessmentId, 'Risk assessment ID');
        tx.prepare(`
            INSERT INTO risk_assessments (
                id,change_revision_id,rule_version,inputs_json,score,matched_rule,
                computed_level,assessed_by,assessed_at
            ) VALUES (?,?,?,?,?,?,?,?,?)
        `).run(assessmentId, revisionId, risk.ruleVersion, JSON.stringify(risk.inputs),
            risk.score, risk.matchedRule, risk.computedLevel, quality.id, at);
        transition(tx, change, 'Risk Classified', at);
        appendAuditEvent(tx, {
            actorId: quality.id, recordedAt: at, entityType: 'change', entityId: change.id,
            entityRevisionId: revisionId, action: 'risk-classified',
            priorState: change.state, newState: 'Risk Classified', ruleVersion: risk.ruleVersion,
            payload: { assessmentId, score: risk.score, matchedRule: risk.matchedRule,
                computedLevel: risk.computedLevel, inputs: risk.inputs }
        });
        return { assessmentId, ...risk };
    });
}

export function approvePlan(db, input) {
    return decisionTransaction(db, tx => {
        const change = currentChange(tx, input);
        const quality = actor(tx, input.actorId, 'Quality Engineer');
        const at = text(input.at, 'Decision UTC time');
        assertStateTransition('change', change.state, 'Plan Approved');
        const revisionId = `${change.id}-R${change.current_revision_no}`;
        const risk = tx.prepare('SELECT * FROM risk_assessments WHERE change_revision_id=? ORDER BY rowid DESC LIMIT 1').get(revisionId);
        if (!risk) throw new Error('Risk assessment is required before plan approval');
        let finalRisk = {
            ruleVersion: risk.rule_version,
            matchedRule: risk.matched_rule,
            computedLevel: risk.computed_level,
            finalLevel: risk.computed_level
        };
        const overrides = tx.prepare('SELECT * FROM risk_overrides WHERE assessment_id=? ORDER BY rowid').all(risk.id);
        for (const override of overrides) {
            const audited = tx.prepare(`
                SELECT id FROM audit_events WHERE entity_type='change' AND entity_id=?
                    AND entity_revision_id=? AND action='risk-override'
                    AND json_extract(payload_json,'$.overrideId')=? LIMIT 1
            `).get(change.id, revisionId, override.id);
            if (!audited) throw new Error('Risk override audit record is missing');
            finalRisk = applyRiskOverride(finalRisk, {
                beforePlanApproval: true,
                fromLevel: override.from_level,
                toLevel: override.to_level,
                rationale: override.rationale,
                evidenceId: override.evidence_id,
                recordedAt: override.recorded_at,
                requestedBy: actor(tx, override.requester_actor_id),
                approvedBy: override.approver_actor_id ? actor(tx, override.approver_actor_id) : null
            });
        }
        const finalLevel = finalRisk.finalLevel;
        if (finalLevel === 'L3' && quality.id === change.proposer_actor_id) {
            throw new Error('L3 plan approval requires independent Quality actor distinct from proposer');
        }
        const defaults = defaultVerificationPlan(finalLevel);
        const criteria = [
            { code: 'ALIGN-X', comparison: '<=', threshold: 0.08, unit: 'mm', required: 1 },
            { code: 'AOI-RATE', comparison: '<=', threshold: defaults.maxRejectRate, unit: 'fraction', required: 1 },
            { code: 'CRITICAL-DEFECTS', comparison: '<=', threshold: 0, unit: 'count', required: 1 }
        ];
        const planId = text(input.planId, 'Verification plan ID');
        tx.prepare(`
            INSERT INTO verification_plans (
                id,change_revision_id,assessment_id,revision_no,final_level,
                baseline_lots,post_change_lots,samples_per_lot,effectiveness_lots,
                effectiveness_days,max_aoi_reject_rate,alignment_abs_limit,
                criteria_json,approved_by,approved_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(planId, revisionId, risk.id, 1, finalLevel,
            defaults.baselineLots, defaults.postChangeLots, defaults.samplesPerLot,
            defaults.effectivenessLots, defaults.effectivenessDays, defaults.maxRejectRate,
            0.08, JSON.stringify(criteria), quality.id, at);
        const insertCriterion = tx.prepare(`
            INSERT INTO plan_criteria(id,plan_id,code,comparison,threshold,unit,required)
            VALUES (?,?,?,?,?,?,?)
        `);
        for (const criterion of criteria) {
            insertCriterion.run(`${planId}-${criterion.code}`, planId, criterion.code,
                criterion.comparison, criterion.threshold, criterion.unit, criterion.required);
        }
        transition(tx, change, 'Plan Approved', at);
        appendAuditEvent(tx, {
            actorId: quality.id, recordedAt: at, entityType: 'change', entityId: change.id,
            entityRevisionId: revisionId, action: 'plan-approved',
            priorState: change.state, newState: 'Plan Approved', ruleVersion: risk.rule_version,
            payload: { planId, assessmentId: risk.id, computedLevel: risk.computed_level,
                finalLevel, defaults, criteria }
        });
        return { planId, revisionId, finalLevel, defaults, criteria };
    });
}

function revisionIdFor(change) {
    return `${change.id}-R${change.current_revision_no}`;
}

export function startVerification(db, input) {
    return decisionTransaction(db, tx => {
        const change = currentChange(tx, input);
        const verifier = actor(tx, input.actorId, 'Verification Engineer');
        const at = text(input.at, 'Decision UTC time');
        const plan = tx.prepare('SELECT id FROM verification_plans WHERE change_revision_id=? ORDER BY revision_no DESC LIMIT 1').get(revisionIdFor(change));
        if (!plan) throw new Error('Approved verification plan is missing');
        transition(tx, change, 'Verification In Progress', at);
        appendAuditEvent(tx, {
            actorId: verifier.id, recordedAt: at, entityType: 'change', entityId: change.id,
            entityRevisionId: revisionIdFor(change), action: 'verification-started',
            priorState: change.state, newState: 'Verification In Progress',
            payload: { planId: plan.id }
        });
        return { id: change.id, state: 'Verification In Progress' };
    });
}

export function addMeasurementEvidence(db, input) {
    return decisionTransaction(db, tx => {
        const change = currentChange(tx, input);
        const verifier = actor(tx, input.actorId, 'Verification Engineer');
        if (change.state !== 'Verification In Progress') throw new Error('Measurement evidence requires verification state');
        const at = text(input.at, 'Evidence UTC time');
        if (at < change.updated_at) throw new Error('Evidence time precedes verification start');
        const measurementId = text(input.measurementId, 'Measurement ID');
        const row = tx.prepare(`
            SELECT m.id,m.value,m.unit,m.method,m.characteristic_id,m.recorded_at,
                s.id AS sample_id,r.id AS run_id,r.lot_id,r.equipment_id,r.module_id,r.recipe_revision_id
            FROM measurements m
            JOIN inspection_samples s ON s.id=m.inspection_sample_id
            JOIN process_runs r ON r.id=s.process_run_id
            WHERE m.id=?
        `).get(measurementId);
        if (!row || row.equipment_id !== change.equipment_id || row.module_id !== change.module_id ||
            row.recipe_revision_id !== change.recipe_revision_id || row.characteristic_id !== 'CHAR-ALIGN-X' ||
            row.unit !== 'mm') {
            throw new Error('Measurement recipe or equipment scope does not match the approved change');
        }
        if (row.recorded_at < change.updated_at || at <= row.recorded_at) {
            throw new Error('Evidence time must follow verification start and source measurement time');
        }
        const evidenceId = text(input.evidenceId, 'Evidence ID');
        const payload = {
            measurementId: row.id, sampleId: row.sample_id, runId: row.run_id,
            lotId: row.lot_id, recipeRevisionId: row.recipe_revision_id,
            characteristicId: row.characteristic_id, value: row.value, unit: row.unit,
            method: row.method, sourceRecordedAt: row.recorded_at
        };
        const payloadJson = JSON.stringify(payload);
        const sha256 = createHash('sha256').update(payloadJson, 'utf8').digest('hex');
        tx.prepare(`
            INSERT INTO evidence_items (
                id,change_revision_id,source_table,source_id,evidence_type,
                payload_json,sha256,recorded_by,recorded_at
            ) VALUES (?,?,?,?,?,?,?,?,?)
        `).run(evidenceId, revisionIdFor(change), 'measurements', row.id, 'measurement',
            payloadJson, sha256, verifier.id, at);
        appendAuditEvent(tx, {
            actorId: verifier.id, recordedAt: at, entityType: 'change', entityId: change.id,
            entityRevisionId: revisionIdFor(change), action: 'measurement-evidence-added',
            linkedEvidenceIds: [evidenceId], payload: { evidenceId, measurementId, lotId: row.lot_id, sha256 }
        });
        return { evidenceId, measurementId, lotId: row.lot_id, value: row.value, unit: row.unit, sha256 };
    });
}

export function recordAlignmentResult(db, input) {
    return decisionTransaction(db, tx => {
        const change = currentChange(tx, input);
        const verifier = actor(tx, input.actorId, 'Verification Engineer');
        if (change.state !== 'Verification In Progress') throw new Error('Criterion result requires verification state');
        const at = text(input.at, 'Result UTC time');
        if (at < change.updated_at) throw new Error('Result time precedes verification start');
        const revisionId = revisionIdFor(change);
        const plan = tx.prepare('SELECT id,post_change_lots,samples_per_lot FROM verification_plans WHERE change_revision_id=? ORDER BY revision_no DESC LIMIT 1').get(revisionId);
        if (!plan) throw new Error('Approved verification plan is missing');
        const criterion = tx.prepare("SELECT threshold,unit FROM plan_criteria WHERE plan_id=? AND code='ALIGN-X'").get(plan.id);
        if (!criterion) throw new Error('ALIGN-X criterion is missing');
        const evidenceId = text(input.evidenceId, 'Evidence ID');
        const evidence = tx.prepare(`
            SELECT e.change_revision_id,e.source_table,e.source_id,e.recorded_by,e.recorded_at,
                m.value,m.unit,m.characteristic_id,m.recorded_at AS source_recorded_at,r.id AS run_id,
                r.equipment_id,r.module_id,r.recipe_revision_id
            FROM evidence_items e LEFT JOIN measurements m ON m.id=e.source_id
            LEFT JOIN inspection_samples s ON s.id=m.inspection_sample_id
            LEFT JOIN process_runs r ON r.id=s.process_run_id
            WHERE e.id=?
        `).get(evidenceId);
        if (!evidence || evidence.change_revision_id !== revisionId ||
            evidence.source_table !== 'measurements' || evidence.recorded_by !== verifier.id ||
            evidence.unit !== criterion.unit || evidence.characteristic_id !== 'CHAR-ALIGN-X' ||
            !Number.isFinite(evidence.value) ||
            evidence.equipment_id !== change.equipment_id || evidence.module_id !== change.module_id ||
            evidence.recipe_revision_id !== change.recipe_revision_id) {
            throw new Error('Criterion evidence source or revision mismatch');
        }
        if (at <= evidence.recorded_at || evidence.recorded_at <= evidence.source_recorded_at ||
            evidence.source_recorded_at < change.updated_at) {
            throw new Error('Result time must follow linked evidence and post-change source measurement');
        }
        const lotRows = tx.prepare(`
            SELECT r.lot_id,l.end_at,MIN(r.start_at) AS first_run_at
            FROM process_runs r JOIN lots l ON l.id=r.lot_id
            WHERE r.equipment_id=? AND r.module_id=? AND r.start_at>=? AND r.start_at<=?
            GROUP BY r.lot_id ORDER BY first_run_at,r.lot_id LIMIT ?
        `).all(change.equipment_id, change.module_id, change.updated_at, at, plan.post_change_lots);
        const lotIds = lotRows.map(row => row.lot_id);
        const runsForLot = tx.prepare(`
            SELECT id,lot_id,recipe_revision_id FROM process_runs
            WHERE lot_id=? AND equipment_id=? AND module_id=? AND start_at>=? AND start_at<=?
            ORDER BY start_at,id
        `);
        const runs = lotIds.flatMap(lotId => runsForLot.all(
            lotId, change.equipment_id, change.module_id, change.updated_at, at
        ));
        if (!runs.some(row => row.id === evidence.run_id) ||
            runs.some(row => row.recipe_revision_id !== change.recipe_revision_id)) {
            throw new Error('Criterion evidence is outside consecutive post-change lot scope');
        }
        let observedValue = Math.abs(evidence.value);
        const passed = observedValue <= criterion.threshold;
        let linkedEvidenceIds = [evidenceId];
        let sampleCount = 1;
        if (passed) {
            if (lotIds.length < plan.post_change_lots) {
                throw new Error('Insufficient consecutive post-change lots for passing criterion');
            }
            if (lotRows.some(row => row.end_at > at)) {
                throw new Error('Post-change lot has not ended before passing criterion');
            }
            linkedEvidenceIds = [];
            sampleCount = 0;
            observedValue = 0;
            const declaredSamples = tx.prepare(`
                SELECT id,sample_size FROM inspection_samples WHERE process_run_id=? ORDER BY id
            `);
            const sourceMeasurements = tx.prepare(`
                SELECT m.id,s.id AS sample_id,m.value,m.unit,m.recorded_at,e.id AS evidence_id,
                    e.recorded_at AS evidence_at,e.recorded_by
                FROM measurements m JOIN inspection_samples s ON s.id=m.inspection_sample_id
                LEFT JOIN evidence_items e ON e.source_table='measurements' AND e.source_id=m.id
                    AND e.change_revision_id=? AND e.evidence_type='measurement'
                WHERE s.process_run_id=? AND m.characteristic_id='CHAR-ALIGN-X'
                ORDER BY m.id,e.recorded_at,e.id
            `);
            for (const lotId of lotIds) {
                let lotSampleCount = 0;
                for (const run of runs.filter(row => row.lot_id === lotId)) {
                    const rows = sourceMeasurements.all(revisionId, run.id);
                    const measurements = new Map();
                    for (const row of rows) {
                        const selected = measurements.get(row.id);
                        const validEvidence = row.evidence_id && row.recorded_by === verifier.id &&
                            row.evidence_at <= at && row.evidence_at > row.recorded_at;
                        if (!selected || (!selected.evidence_id && validEvidence)) {
                            measurements.set(row.id, { ...row, evidence_id: validEvidence ? row.evidence_id : null });
                        }
                    }
                    for (const sample of declaredSamples.all(run.id)) {
                        const observations = [...measurements.values()].filter(row => row.sample_id === sample.id);
                        if (observations.length !== sample.sample_size) {
                            throw new Error('Sampled unit count does not match its individual measurement rows');
                        }
                        lotSampleCount += sample.sample_size;
                    }
                    for (const row of measurements.values()) {
                        if (!row.evidence_id || row.recorded_at < change.updated_at ||
                            row.recorded_at >= at || row.evidence_at >= at ||
                            row.unit !== criterion.unit || !Number.isFinite(row.value)) {
                            throw new Error('Insufficient valid linked measurement evidence for passing criterion');
                        }
                        linkedEvidenceIds.push(row.evidence_id);
                        observedValue = Math.max(observedValue, Math.abs(row.value));
                        sampleCount++;
                    }
                }
                if (lotSampleCount < plan.samples_per_lot) {
                    throw new Error('Insufficient sampled units in post-change lot');
                }
            }
            if (observedValue > criterion.threshold) {
                throw new Error('Passing criterion is contradicted by another sampled measurement');
            }
            if (!linkedEvidenceIds.includes(evidenceId)) linkedEvidenceIds.push(evidenceId);
        }
        const resultId = text(input.resultId, 'Criterion result ID');
        tx.prepare(`
            INSERT INTO criterion_results (
                id,plan_id,criterion_code,evidence_id,verifier_actor_id,
                passed,observed_value,unit,recorded_at
            ) VALUES (?,?,'ALIGN-X',?,?,?,?,?,?)
        `).run(resultId, plan.id, evidenceId, verifier.id, passed ? 1 : 0,
            observedValue, criterion.unit, at);
        if (!passed) transition(tx, change, 'Needs Rework', at);
        appendAuditEvent(tx, {
            actorId: verifier.id, recordedAt: at, entityType: 'change', entityId: change.id,
            entityRevisionId: revisionId, action: passed ? 'criterion-passed' : 'criterion-failed',
            priorState: change.state, newState: passed ? null : 'Needs Rework',
            linkedEvidenceIds,
            payload: { resultId, planId: plan.id, criterionCode: 'ALIGN-X',
                observedValue, threshold: criterion.threshold, unit: criterion.unit,
                passed, lotIds, sampleCount }
        });
        return { resultId, passed, observedValue, threshold: criterion.threshold,
            unit: criterion.unit, lotCount: lotIds.length, sampleCount };
    });
}

export function reviseFailedChange(db, input) {
    return decisionTransaction(db, tx => {
        const change = currentChange(tx, input);
        const proposer = actor(tx, input.actorId);
        if (proposer.id !== change.proposer_actor_id) {
            throw new Error('Only the original proposer may revise a failed change');
        }
        assertStateTransition('change', change.state, 'Draft', { newRevision: true });
        const at = text(input.at, 'Decision UTC time');
        if (at < change.updated_at) throw new Error('Decision time precedes the previous change event');
        const reason = text(input.reason, 'Rework reason');
        const oldRevisionId = revisionIdFor(change);
        if ((input.failedResultId == null) === (input.failedReviewId == null)) {
            throw new Error('Exactly one failed criterion result or Needs Rework review is required');
        }
        let failureBasis;
        if (input.failedResultId != null) {
            const failedResultId = text(input.failedResultId, 'Failed criterion result ID');
            const failed = tx.prepare(`
                SELECT c.evidence_id,p.id AS plan_id FROM criterion_results c
                JOIN verification_plans p ON p.id=c.plan_id
                WHERE c.id=? AND c.passed=0 AND p.change_revision_id=?
            `).get(failedResultId, oldRevisionId);
            if (!failed) throw new Error('Linked failed criterion result is required for rework');
            failureBasis = {
                planId: failed.plan_id, evidenceIds: [failed.evidence_id],
                payload: { failedResultId }
            };
        } else {
            const failedReviewId = text(input.failedReviewId, 'Needs Rework review ID');
            const review = tx.prepare(`
                SELECT id,plan_id,reviewer_actor_id,decision,reason,evidence_set_digest,reviewed_at
                FROM reviews WHERE id=? AND change_revision_id=?
            `).get(failedReviewId, oldRevisionId);
            if (!review || review.decision !== 'Needs Rework') {
                throw new Error('Linked Needs Rework review is required for rework');
            }
            const { plan, frozen } = readyPackageForReview(tx, change);
            if (review.plan_id !== plan.id || review.evidence_set_digest !== frozen.packageDigest) {
                throw new Error('Needs Rework review does not match the frozen evidence package');
            }
            const reviewEvents = tx.prepare(`
                SELECT actor_id,recorded_at,prior_state,new_state,reason,payload_json FROM audit_events
                WHERE entity_type='change' AND entity_id=? AND entity_revision_id=?
                    AND action='independent-review-needs-rework'
                    AND json_extract(payload_json,'$.reviewId')=?
            `).all(change.id, oldRevisionId, failedReviewId);
            if (reviewEvents.length !== 1 ||
                reviewEvents[0].actor_id !== review.reviewer_actor_id ||
                reviewEvents[0].recorded_at !== review.reviewed_at ||
                reviewEvents[0].prior_state !== 'Independent Review' ||
                reviewEvents[0].reason !== review.reason ||
                reviewEvents[0].new_state !== 'Needs Rework') {
                throw new Error('Needs Rework review audit provenance is missing');
            }
            const reviewed = JSON.parse(reviewEvents[0].payload_json);
            if (reviewed.planId !== plan.id || reviewed.decision !== 'Needs Rework' ||
                reviewed.packageDigest !== frozen.packageDigest ||
                !Array.isArray(reviewed.linkedEvidenceIds) ||
                JSON.stringify(reviewed.linkedEvidenceIds) !== JSON.stringify(frozen.evidenceIds)) {
                throw new Error('Needs Rework review audit evidence set differs from frozen package');
            }
            if (at <= review.reviewed_at) {
                throw new Error('Review rework revision time must follow the review decision');
            }
            failureBasis = {
                planId: plan.id, evidenceIds: frozen.evidenceIds,
                payload: { failedReviewId, failedPackageDigest: frozen.packageDigest }
            };
        }
        const newRecipeRevisionId = text(input.newRecipeRevisionId, 'New recipe revision ID');
        const recipes = tx.prepare('SELECT recipe_code,revision,effective_at FROM recipe_revisions WHERE id=?');
        const currentRecipe = recipes.get(change.recipe_revision_id);
        const newRecipe = recipes.get(newRecipeRevisionId);
        if (!currentRecipe || !newRecipe || newRecipe.recipe_code !== currentRecipe.recipe_code) {
            throw new Error('Rework recipe must stay in the approved equipment recipe family');
        }
        if (newRecipe.revision <= currentRecipe.revision ||
            newRecipe.effective_at <= currentRecipe.effective_at) {
            throw new Error('Rework requires a newer target recipe revision');
        }
        const revisionNo = change.current_revision_no + 1;
        const revisionId = `${change.id}-R${revisionNo}`;
        tx.prepare(`
            INSERT INTO change_revisions (
                id,change_id,revision_no,parent_revision_id,created_by,created_at,reason
            ) VALUES (?,?,?,?,?,?,?)
        `).run(revisionId, change.id, revisionNo, oldRevisionId, proposer.id, at, reason);
        const updated = tx.prepare(`
            UPDATE changes SET state='Draft',current_revision_no=?,recipe_revision_id=?,updated_at=?
            WHERE id=? AND state='Needs Rework' AND current_revision_no=?
        `).run(revisionNo, newRecipeRevisionId, at, change.id, change.current_revision_no);
        if (updated.changes !== 1) throw new Error('Stale failed change state');
        appendAuditEvent(tx, {
            actorId: proposer.id, recordedAt: at, entityType: 'change', entityId: change.id,
            entityRevisionId: revisionId, action: 'change-revised-after-failure',
            priorState: change.state, newState: 'Draft', reason,
            linkedEvidenceIds: failureBasis.evidenceIds,
            payload: { priorRevisionId: oldRevisionId, ...failureBasis.payload,
                failedPlanId: failureBasis.planId, oldRecipeRevisionId: change.recipe_revision_id,
                lineId: change.line_id, equipmentId: change.equipment_id,
                moduleId: change.module_id, recipeRevisionId: newRecipeRevisionId,
                baselineRef: change.baseline_ref }
        });
        return { id: change.id, revisionId, revisionNo, state: 'Draft' };
    });
}

export function getChangeRevisionContext(db, changeId, revisionNo) {
    const id = text(changeId, 'Change ID');
    if (!Number.isInteger(revisionNo) || revisionNo < 1) throw new TypeError('Revision number is required');
    const revision = db.prepare(`
        SELECT id,parent_revision_id FROM change_revisions WHERE change_id=? AND revision_no=?
    `).get(id, revisionNo);
    if (!revision) throw new Error('Unknown change revision');
    verifyAuditChain(db);
    const events = db.prepare(`
        SELECT payload_json,digest,actor_id FROM audit_events
        WHERE entity_type='change' AND entity_id=? AND entity_revision_id=?
            AND action IN ('change-created','change-revised-after-failure',
                'change-revised-after-expiry',
                'change-revised-after-effectiveness-failure')
    `).all(id, revision.id);
    if (events.length !== 1) throw new Error('Frozen change revision context is missing or ambiguous');
    const payload = JSON.parse(events[0].payload_json);
    const context = {
        revisionId: revision.id, parentRevisionId: revision.parent_revision_id,
        lineId: payload.lineId, equipmentId: payload.equipmentId,
        moduleId: payload.moduleId, recipeRevisionId: payload.recipeRevisionId,
        baselineRef: payload.baselineRef, proposerActorId: events[0].actor_id,
        auditDigest: events[0].digest
    };
    for (const field of ['lineId', 'equipmentId', 'moduleId', 'recipeRevisionId', 'baselineRef']) {
        text(context[field], `Frozen ${field}`);
    }
    return context;
}

function aoiEvidenceSnapshot(tx, row) {
    const defects = tx.prepare(`
        SELECT d.id,c.code,c.severity,d.defect_count FROM aoi_defects d
        JOIN defect_codes c ON c.id=d.defect_code_id
        WHERE d.aoi_inspection_id=? ORDER BY d.id
    `).all(row.id).map(defect => ({
        id: defect.id, code: defect.code, severity: defect.severity,
        count: defect.defect_count
    }));
    if (defects.reduce((sum, defect) => sum + defect.count, 0) !== row.rejected_units) {
        throw new Error('AOI source defect count does not match rejected units');
    }
    const payloadJson = JSON.stringify({
        inspectionId: row.id, runId: row.run_id, lotId: row.lot_id,
        recipeRevisionId: row.recipe_revision_id, inspectedUnits: row.inspected_units,
        rejectedUnits: row.rejected_units, sourceInspectedAt: row.inspected_at, defects
    });
    return {
        payloadJson, defects,
        sha256: createHash('sha256').update(payloadJson, 'utf8').digest('hex')
    };
}

export function addAoiEvidence(db, input) {
    return decisionTransaction(db, tx => {
        const change = currentChange(tx, input);
        const verifier = actor(tx, input.actorId, 'Verification Engineer');
        if (change.state !== 'Verification In Progress') throw new Error('AOI evidence requires verification state');
        const at = text(input.at, 'Evidence UTC time');
        const inspectionId = text(input.inspectionId, 'AOI inspection ID');
        const row = tx.prepare(`
            SELECT a.id,a.inspected_at,a.inspected_units,a.rejected_units,
                r.id AS run_id,r.lot_id,r.equipment_id,r.module_id,r.recipe_revision_id,r.processed_units
            FROM aoi_inspections a JOIN process_runs r ON r.id=a.process_run_id
            WHERE a.id=?
        `).get(inspectionId);
        if (!row || row.equipment_id !== change.equipment_id || row.module_id !== change.module_id ||
            row.recipe_revision_id !== change.recipe_revision_id || row.inspected_units !== row.processed_units) {
            throw new Error('AOI source recipe, equipment or complete inspection scope mismatch');
        }
        if (row.inspected_at < change.updated_at || at <= row.inspected_at) {
            throw new Error('AOI evidence time must follow verification start and source inspection time');
        }
        const evidenceId = text(input.evidenceId, 'Evidence ID');
        const { payloadJson, sha256 } = aoiEvidenceSnapshot(tx, row);
        tx.prepare(`
            INSERT INTO evidence_items (
                id,change_revision_id,source_table,source_id,evidence_type,
                payload_json,sha256,recorded_by,recorded_at
            ) VALUES (?,?,?,?,?,?,?,?,?)
        `).run(evidenceId, revisionIdFor(change), 'aoi_inspections', row.id, 'aoi',
            payloadJson, sha256, verifier.id, at);
        appendAuditEvent(tx, {
            actorId: verifier.id, recordedAt: at, entityType: 'change', entityId: change.id,
            entityRevisionId: revisionIdFor(change), action: 'aoi-evidence-added',
            linkedEvidenceIds: [evidenceId],
            payload: { evidenceId, inspectionId, lotId: row.lot_id, sha256 }
        });
        return { evidenceId, inspectionId, lotId: row.lot_id,
            inspectedUnits: row.inspected_units, rejectedUnits: row.rejected_units, sha256 };
    });
}

export function recordAoiResults(db, input) {
    return decisionTransaction(db, tx => {
        const change = currentChange(tx, input);
        const verifier = actor(tx, input.actorId, 'Verification Engineer');
        if (change.state !== 'Verification In Progress') throw new Error('AOI criteria require verification state');
        const at = text(input.at, 'Result UTC time');
        if (at < change.updated_at) throw new Error('Result time precedes verification start');
        const revisionId = revisionIdFor(change);
        const plan = tx.prepare(`
            SELECT id,post_change_lots FROM verification_plans
            WHERE change_revision_id=? ORDER BY revision_no DESC LIMIT 1
        `).get(revisionId);
        if (!plan) throw new Error('Approved verification plan is missing');
        const criteria = tx.prepare(`
            SELECT code,threshold,unit FROM plan_criteria
            WHERE plan_id=? AND code IN ('AOI-RATE','CRITICAL-DEFECTS')
        `).all(plan.id);
        const rateCriterion = criteria.find(row => row.code === 'AOI-RATE');
        const criticalCriterion = criteria.find(row => row.code === 'CRITICAL-DEFECTS');
        if (!rateCriterion || !criticalCriterion || rateCriterion.unit !== 'fraction' ||
            criticalCriterion.unit !== 'count' || criticalCriterion.threshold !== 0) {
            throw new Error('Approved AOI criteria are missing or invalid');
        }
        const lotRows = tx.prepare(`
            SELECT r.lot_id,l.end_at,MIN(r.start_at) AS first_run_at
            FROM process_runs r JOIN lots l ON l.id=r.lot_id
            WHERE r.equipment_id=? AND r.module_id=? AND r.start_at>=? AND r.start_at<=?
            GROUP BY r.lot_id ORDER BY first_run_at,r.lot_id LIMIT ?
        `).all(change.equipment_id, change.module_id, change.updated_at, at, plan.post_change_lots);
        const lotIds = lotRows.map(row => row.lot_id);
        if (lotIds.length === 0) throw new Error('Insufficient post-change lots for AOI evaluation');
        const runsForLot = tx.prepare(`
            SELECT id,recipe_revision_id,processed_units FROM process_runs
            WHERE lot_id=? AND equipment_id=? AND module_id=? AND start_at>=? AND start_at<=?
            ORDER BY start_at,id
        `);
        const inspectionForRun = tx.prepare(`
            SELECT id,inspected_at,inspected_units,rejected_units
            FROM aoi_inspections WHERE process_run_id=?
        `);
        const evidenceForInspection = tx.prepare(`
            SELECT id,recorded_at,payload_json,sha256 FROM evidence_items
            WHERE change_revision_id=? AND source_table='aoi_inspections'
                AND source_id=? AND evidence_type='aoi' AND recorded_by=?
            ORDER BY recorded_at,id
        `);
        let inspectedUnits = 0;
        let rejectedUnits = 0;
        let criticalDefects = 0;
        let incomplete = lotIds.length < plan.post_change_lots;
        const observed = [];
        for (const lotId of lotIds) {
            for (const run of runsForLot.all(
                lotId, change.equipment_id, change.module_id, change.updated_at, at
            )) {
                if (run.recipe_revision_id !== change.recipe_revision_id) {
                    throw new Error('AOI lot contains an unexpected recipe revision');
                }
                const inspection = inspectionForRun.get(run.id);
                if (!inspection || inspection.inspected_at >= at ||
                    inspection.inspected_units !== run.processed_units) {
                    incomplete = true;
                    continue;
                }
                const snapshot = aoiEvidenceSnapshot(tx, {
                    ...inspection, run_id: run.id, lot_id: lotId,
                    recipe_revision_id: run.recipe_revision_id
                });
                const evidence = evidenceForInspection.all(revisionId, inspection.id, verifier.id)
                    .find(item => item.recorded_at > inspection.inspected_at && item.recorded_at < at &&
                        item.payload_json === snapshot.payloadJson && item.sha256 === snapshot.sha256);
                if (!evidence) {
                    incomplete = true;
                    continue;
                }
                const critical = snapshot.defects
                    .filter(defect => defect.severity === 'critical')
                    .reduce((sum, defect) => sum + defect.count, 0);
                observed.push({ evidenceId: evidence.id, critical });
                inspectedUnits += inspection.inspected_units;
                rejectedUnits += inspection.rejected_units;
                criticalDefects += critical;
            }
        }
        if (inspectedUnits === 0) throw new Error('Insufficient AOI evidence or inspected-unit denominator');
        const rejectRate = rejectedUnits / inspectedUnits;
        const failedCodes = [];
        if (rejectRate > rateCriterion.threshold) failedCodes.push('AOI-RATE');
        if (criticalDefects > criticalCriterion.threshold) failedCodes.push('CRITICAL-DEFECTS');
        if (failedCodes.length === 0 && lotRows.some(row => row.end_at > at)) {
            throw new Error('Post-change lot has not ended before passing AOI criteria');
        }
        if (failedCodes.length === 0 && incomplete) {
            throw new Error('Insufficient AOI evidence or consecutive post-change lot coverage');
        }
        const passed = failedCodes.length === 0;
        const resultPrefix = text(input.resultPrefix, 'AOI result prefix');
        const insertResult = tx.prepare(`
            INSERT INTO criterion_results (
                id,plan_id,criterion_code,evidence_id,verifier_actor_id,
                passed,observed_value,unit,recorded_at
            ) VALUES (?,?,?,?,?,?,?, ?,?)
        `);
        const reportedCodes = passed ? ['AOI-RATE', 'CRITICAL-DEFECTS'] : failedCodes;
        for (const code of reportedCodes) {
            const criterion = code === 'AOI-RATE' ? rateCriterion : criticalCriterion;
            const representative = code === 'CRITICAL-DEFECTS' && !passed
                ? observed.find(item => item.critical > 0) : observed[0];
            insertResult.run(`${resultPrefix}-${code}`, plan.id, code, representative.evidenceId,
                verifier.id, passed ? 1 : 0,
                code === 'AOI-RATE' ? rejectRate : criticalDefects, criterion.unit, at);
        }
        if (!passed) transition(tx, change, 'Needs Rework', at);
        appendAuditEvent(tx, {
            actorId: verifier.id, recordedAt: at, entityType: 'change', entityId: change.id,
            entityRevisionId: revisionId, action: passed ? 'aoi-criteria-passed' : 'aoi-criteria-failed',
            priorState: change.state, newState: passed ? null : 'Needs Rework',
            linkedEvidenceIds: observed.map(item => item.evidenceId),
            payload: { planId: plan.id, reportedCodes, failedCodes, lotIds,
                inspectedUnits, rejectedUnits, rejectRate, criticalDefects,
                rateThreshold: rateCriterion.threshold, incomplete }
        });
        return { passed, failedCodes, lotCount: lotIds.length, inspectedUnits,
            rejectedUnits, rejectRate, criticalDefects };
    });
}

function buildBaselineSourceSnapshot(tx, change, plan) {
    const anchor = tx.prepare(`
        SELECT a.id,r.id AS run_id,r.lot_id,r.equipment_id,r.module_id,
            r.recipe_revision_id,r.start_at,r.end_at,l.start_at AS lot_start_at
        FROM aoi_inspections a JOIN process_runs r ON r.id=a.process_run_id
        JOIN lots l ON l.id=r.lot_id WHERE a.id=?
    `).get(change.baseline_ref);
    if (!anchor || anchor.equipment_id !== change.equipment_id ||
        anchor.start_at >= change.created_at) {
        throw new Error('Baseline anchor is outside the earlier change equipment/module scope');
    }
    const recipes = tx.prepare('SELECT recipe_code,revision,effective_at FROM recipe_revisions WHERE id=?');
    const baselineRecipe = recipes.get(anchor.recipe_revision_id);
    const targetRecipe = recipes.get(change.recipe_revision_id);
    if (!baselineRecipe || !targetRecipe ||
        baselineRecipe.recipe_code !== targetRecipe.recipe_code ||
        baselineRecipe.revision >= targetRecipe.revision ||
        baselineRecipe.effective_at >= targetRecipe.effective_at) {
        throw new Error('Baseline requires an earlier revision in the same recipe family');
    }
    const creationEvents = tx.prepare(`SELECT payload_json FROM audit_events
        WHERE entity_type='change' AND entity_id=? AND action='change-created'
        ORDER BY sequence`).all(change.id);
    if (creationEvents.length !== 1) {
        throw new Error('Frozen Change creation audit is missing or ambiguous');
    }
    const creation = JSON.parse(creationEvents[0].payload_json);
    if (anchor.module_id !== change.module_id &&
        (typeof creation.moduleTransitionEventId !== 'string' ||
            creation.baselineModuleId !== anchor.module_id)) {
        throw new Error('Frozen target-module transition source is missing');
    }
    const transitionEvent = baselineModuleTransition(tx, {
        equipmentId: change.equipment_id, baselineModuleId: anchor.module_id,
        targetModuleId: change.module_id, baselineRunEndAt: anchor.end_at,
        createdAt: change.created_at, targetRecipeEffectiveAt: targetRecipe.effective_at,
        frozenEventId: creation.moduleTransitionEventId ?? null
    });
    const lotRows = tx.prepare(`
        SELECT l.id AS lot_id,l.start_at,l.end_at,MIN(r.start_at) AS first_run_at
        FROM lots l JOIN process_runs r ON r.lot_id=l.id
        WHERE r.equipment_id=? AND r.module_id=?
            AND l.start_at>=? AND l.start_at<?
        GROUP BY l.id ORDER BY l.start_at,l.id LIMIT ?
    `).all(change.equipment_id, anchor.module_id,
        anchor.lot_start_at, change.created_at, plan.baseline_lots);
    const lotIds = lotRows.map(row => row.lot_id);
    if (lotIds.length < plan.baseline_lots || lotIds[0] !== anchor.lot_id) {
        throw new Error('Insufficient pre-change same-recipe baseline lots');
    }
    if (lotRows.some(row => row.end_at >= change.created_at)) {
        throw new Error('Baseline lot must be completed before change creation');
    }
    const runsForLot = tx.prepare(`
        SELECT id,lot_id,recipe_revision_id,processed_units,start_at,end_at FROM process_runs
        WHERE lot_id=? AND equipment_id=? AND module_id=?
        ORDER BY start_at,id
    `);
    const inspectionForRun = tx.prepare(`
        SELECT id,inspected_at,inspected_units,rejected_units FROM aoi_inspections
        WHERE process_run_id=?
    `);
    const sampleForRun = tx.prepare(`
        SELECT id,sample_size,sampled_at FROM inspection_samples WHERE process_run_id=? ORDER BY id
    `);
    const measurementsForSample = tx.prepare(`
        SELECT id,value,unit,recorded_at FROM measurements
        WHERE inspection_sample_id=? AND characteristic_id='CHAR-ALIGN-X' ORDER BY id
    `);
    let sampledUnits = 0;
    let inspectedUnits = 0;
    let rejectedUnits = 0;
    let maxAbsOffset = 0;
    const aoiInspections = [];
    const measurements = [];
    const sourceFacts = [];
    for (const lotId of lotIds) {
        const lot = lotRows.find(row => row.lot_id === lotId);
        sourceFacts.push({ kind: 'lot', id: lotId, startAt: lot.start_at, endAt: lot.end_at });
        let lotSampleCount = 0;
        for (const run of runsForLot.all(lotId, change.equipment_id, anchor.module_id)) {
            sourceFacts.push({ kind: 'run', id: run.id, lotId,
                recipeRevisionId: run.recipe_revision_id, processedUnits: run.processed_units,
                startAt: run.start_at, endAt: run.end_at });
            if (run.recipe_revision_id !== anchor.recipe_revision_id || run.end_at >= change.created_at) {
                throw new Error('Baseline lot includes later or different-recipe run');
            }
            const inspection = inspectionForRun.get(run.id);
            if (!inspection || inspection.inspected_at >= change.created_at ||
                inspection.inspected_units !== run.processed_units) {
                throw new Error('Baseline AOI coverage is missing or after change creation');
            }
            const snapshot = aoiEvidenceSnapshot(tx, {
                ...inspection, run_id: run.id, lot_id: lotId,
                recipe_revision_id: run.recipe_revision_id
            });
            aoiInspections.push({
                id: inspection.id, runId: run.id, inspectedUnits: inspection.inspected_units,
                rejectedUnits: inspection.rejected_units, sourceSha256: snapshot.sha256
            });
            sourceFacts.push({ kind: 'aoi', id: inspection.id, runId: run.id,
                inspectedAt: inspection.inspected_at,
                inspectedUnits: inspection.inspected_units,
                rejectedUnits: inspection.rejected_units });
            inspectedUnits += inspection.inspected_units;
            rejectedUnits += inspection.rejected_units;
            for (const sample of sampleForRun.all(run.id)) {
                sourceFacts.push({ kind: 'sample', id: sample.id, runId: run.id,
                    sampledAt: sample.sampled_at, sampleSize: sample.sample_size });
                const rows = measurementsForSample.all(sample.id);
                if (rows.length !== sample.sample_size) {
                    throw new Error('Baseline sampled-unit count does not match measurement rows');
                }
                for (const row of rows) {
                    if (row.unit !== 'mm' || !Number.isFinite(row.value) ||
                        row.recorded_at < sample.sampled_at ||
                        row.recorded_at >= run.end_at || row.recorded_at >= change.created_at) {
                        throw new Error('Baseline measurement source time or unit is invalid');
                    }
                    measurements.push({
                        id: row.id, sampleId: sample.id, value: row.value,
                        unit: row.unit, recordedAt: row.recorded_at
                    });
                    maxAbsOffset = Math.max(maxAbsOffset, Math.abs(row.value));
                }
                lotSampleCount += sample.sample_size;
            }
        }
        if (lotSampleCount < plan.samples_per_lot) {
            throw new Error('Insufficient baseline sampled units per lot');
        }
        sampledUnits += lotSampleCount;
    }
    if (inspectedUnits === 0) throw new Error('Baseline AOI denominator is missing');
    if (transitionEvent) sourceFacts.push({ kind: 'module-transition',
        id: transitionEvent.id, targetModuleId: change.module_id,
        occurredAt: transitionEvent.occurred_at });
    const payloadJson = JSON.stringify({
        anchorRef: anchor.id, baselineRecipeRevisionId: anchor.recipe_revision_id,
        ...(transitionEvent ? { baselineModuleId: anchor.module_id,
            targetModuleId: change.module_id,
            moduleTransitionEventId: transitionEvent.id } : {}),
        lotIds, aoiInspections, measurements, sampledUnits,
        inspectedUnits, rejectedUnits, rejectRate: rejectedUnits / inspectedUnits,
        maxAbsOffset
    });
    return { anchor, lotIds, sampledUnits, inspectedUnits, rejectedUnits,
        maxAbsOffset, payloadJson, sourceFacts };
}

export function recordBaselineSet(db, input) {
    return decisionTransaction(db, tx => {
        const change = currentChange(tx, input);
        const verifier = actor(tx, input.actorId, 'Verification Engineer');
        if (change.state !== 'Verification In Progress') throw new Error('Baseline evidence requires verification state');
        const at = text(input.at, 'Evidence UTC time');
        if (at <= change.updated_at) throw new Error('Baseline evidence time must follow verification start');
        const revisionId = revisionIdFor(change);
        const existing = tx.prepare(`
            SELECT id FROM evidence_items WHERE change_revision_id=? AND evidence_type='baseline-set'
        `).get(revisionId);
        if (existing) throw new Error('Baseline evidence is already recorded for this revision');
        const plan = tx.prepare(`
            SELECT id,baseline_lots,samples_per_lot FROM verification_plans
            WHERE change_revision_id=? ORDER BY revision_no DESC LIMIT 1
        `).get(revisionId);
        if (!plan) throw new Error('Approved verification plan is missing');
        const { anchor, lotIds, sampledUnits, inspectedUnits, rejectedUnits, maxAbsOffset, payloadJson } =
            buildBaselineSourceSnapshot(tx, change, plan);
        const evidenceId = text(input.evidenceId, 'Baseline evidence ID');
        const sha256 = createHash('sha256').update(payloadJson, 'utf8').digest('hex');
        tx.prepare(`
            INSERT INTO evidence_items (
                id,change_revision_id,source_table,source_id,evidence_type,
                payload_json,sha256,recorded_by,recorded_at
            ) VALUES (?,?,?,?,?,?,?,?,?)
        `).run(evidenceId, revisionId, 'aoi_inspections', anchor.id, 'baseline-set',
            payloadJson, sha256, verifier.id, at);
        appendAuditEvent(tx, {
            actorId: verifier.id, recordedAt: at, entityType: 'change', entityId: change.id,
            entityRevisionId: revisionId, action: 'baseline-evidence-added',
            linkedEvidenceIds: [evidenceId],
            payload: { evidenceId, planId: plan.id, lotIds, sampledUnits,
                inspectedUnits, rejectedUnits, maxAbsOffset, sha256 }
        });
        return { evidenceId, lotIds, sampledUnits, inspectedUnits, rejectedUnits, sha256 };
    });
}

function measurementSourceSnapshot(tx, measurementId) {
    const row = tx.prepare(`
        SELECT m.id,m.value,m.unit,m.method,m.characteristic_id,m.recorded_at,
            s.id AS sample_id,s.sampled_at,r.id AS run_id,r.lot_id,r.equipment_id,
            r.module_id,r.recipe_revision_id,r.end_at AS run_end_at
        FROM measurements m JOIN inspection_samples s ON s.id=m.inspection_sample_id
        JOIN process_runs r ON r.id=s.process_run_id WHERE m.id=?
    `).get(measurementId);
    if (!row) throw new Error('Measurement evidence source is missing');
    const payloadJson = JSON.stringify({
        measurementId: row.id, sampleId: row.sample_id, runId: row.run_id,
        lotId: row.lot_id, recipeRevisionId: row.recipe_revision_id,
        characteristicId: row.characteristic_id, value: row.value, unit: row.unit,
        method: row.method, sourceRecordedAt: row.recorded_at
    });
    return { row, payloadJson };
}

function assertSourceEvidence(tx, change, item) {
    if (item.evidence_type === 'baseline-set') return;
    if (item.evidence_type === 'measurement' && item.source_table === 'measurements') {
        const { row, payloadJson } = measurementSourceSnapshot(tx, item.source_id);
        if (payloadJson !== item.payload_json || row.equipment_id !== change.equipment_id ||
            row.module_id !== change.module_id || row.recipe_revision_id !== change.recipe_revision_id ||
            row.characteristic_id !== 'CHAR-ALIGN-X' || row.unit !== 'mm' ||
            row.recorded_at < row.sampled_at || row.recorded_at >= row.run_end_at ||
            row.recorded_at < change.updated_at || item.recorded_at <= row.recorded_at) {
            throw new Error(`Measurement evidence differs from its source: ${item.id}`);
        }
        return;
    }
    if (item.evidence_type === 'aoi' && item.source_table === 'aoi_inspections') {
        const row = tx.prepare(`
            SELECT a.id,a.inspected_at,a.inspected_units,a.rejected_units,r.id AS run_id,
                r.lot_id,r.equipment_id,r.module_id,r.recipe_revision_id,r.processed_units
            FROM aoi_inspections a JOIN process_runs r ON r.id=a.process_run_id WHERE a.id=?
        `).get(item.source_id);
        if (!row || row.equipment_id !== change.equipment_id || row.module_id !== change.module_id ||
            row.recipe_revision_id !== change.recipe_revision_id ||
            row.inspected_units !== row.processed_units ||
            row.inspected_at < change.updated_at || item.recorded_at <= row.inspected_at ||
            aoiEvidenceSnapshot(tx, row).payloadJson !== item.payload_json) {
            throw new Error(`AOI evidence differs from its source: ${item.id}`);
        }
        return;
    }
    throw new Error(`Unsupported verification evidence type: ${item.id}`);
}

function canonicalPackageValue(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(canonicalPackageValue);
    if (typeof value === 'object' && value !== null) {
        const ordered = Object.create(null);
        for (const key of Object.keys(value).sort()) ordered[key] = canonicalPackageValue(value[key]);
        return ordered;
    }
    throw new TypeError('Unsupported frozen package value');
}

function derivePostChangeResults(tx, change, plan, evidence, results) {
    const evidenceBySource = new Map();
    for (const item of evidence) {
        if (item.evidence_type !== 'baseline-set') {
            const key = `${item.source_table}/${item.source_id}`;
            const items = evidenceBySource.get(key) ?? [];
            items.push(item);
            evidenceBySource.set(key, items);
        }
    }
    const lotRows = tx.prepare(`
        SELECT r.lot_id,l.start_at,l.end_at,MIN(r.start_at) AS first_run_at
        FROM process_runs r JOIN lots l ON l.id=r.lot_id
        WHERE r.equipment_id=? AND r.module_id=? AND r.start_at>=?
        GROUP BY r.lot_id ORDER BY first_run_at,r.lot_id LIMIT ?
    `).all(change.equipment_id, change.module_id, change.updated_at, plan.post_change_lots);
    if (lotRows.length !== plan.post_change_lots) {
        throw new Error('Post-change source has insufficient consecutive lots');
    }
    const lotIds = lotRows.map(row => row.lot_id);
    const resultByCode = new Map(results.map(row => [row.criterion_code, row]));
    const firstResultAt = results.reduce((earliest, row) =>
        row.recorded_at < earliest ? row.recorded_at : earliest, results[0].recorded_at);
    if (lotRows.some(row => row.end_at > firstResultAt)) {
        throw new Error('Post-change source lot was unfinished when criterion passed');
    }
    const runsForLot = tx.prepare(`
        SELECT id,lot_id,recipe_revision_id,processed_units,start_at,end_at FROM process_runs
        WHERE lot_id=? AND equipment_id=? AND module_id=?
        ORDER BY start_at,id
    `);
    const samplesForRun = tx.prepare(`
        SELECT id,sample_size,sampled_at FROM inspection_samples WHERE process_run_id=? ORDER BY id
    `);
    const measurementsForSample = tx.prepare(`
        SELECT id,value,unit,recorded_at FROM measurements
        WHERE inspection_sample_id=? AND characteristic_id='CHAR-ALIGN-X' ORDER BY id
    `);
    const inspectionForRun = tx.prepare(`
        SELECT id,inspected_at,inspected_units,rejected_units FROM aoi_inspections
        WHERE process_run_id=?
    `);
    let maxAbsOffset = 0;
    let sampledUnits = 0;
    let inspectedUnits = 0;
    let rejectedUnits = 0;
    let criticalDefects = 0;
    const usedSources = new Set();
    const measurementEvidenceIds = new Set();
    const aoiEvidenceIds = new Set();
    const sourceFacts = [];
    for (const lotId of lotIds) {
        const lot = lotRows.find(row => row.lot_id === lotId);
        sourceFacts.push({ kind: 'lot', id: lotId, startAt: lot.start_at, endAt: lot.end_at });
        let lotSampleCount = 0;
        for (const run of runsForLot.all(lotId, change.equipment_id, change.module_id)) {
            if (run.start_at < change.updated_at) {
                throw new Error('Selected post-change lot began before verification start');
            }
            sourceFacts.push({ kind: 'run', id: run.id, lotId,
                recipeRevisionId: run.recipe_revision_id, processedUnits: run.processed_units,
                startAt: run.start_at, endAt: run.end_at });
            if (run.recipe_revision_id !== change.recipe_revision_id) {
                throw new Error('Post-change source contains a mixed recipe lot');
            }
            const inspection = inspectionForRun.get(run.id);
            if (!inspection || inspection.inspected_units !== run.processed_units) {
                throw new Error('Post-change AOI source coverage is incomplete');
            }
            sourceFacts.push({ kind: 'aoi', id: inspection.id, runId: run.id,
                inspectedAt: inspection.inspected_at,
                inspectedUnits: inspection.inspected_units,
                rejectedUnits: inspection.rejected_units });
            const aoiKey = `aoi_inspections/${inspection.id}`;
            const aoiItems = evidenceBySource.get(aoiKey) ?? [];
            if (aoiItems.length === 0 || aoiItems.every(item => item.recorded_at >= resultByCode.get('AOI-RATE').recorded_at)) {
                throw new Error('Post-change AOI source evidence is missing or late');
            }
            usedSources.add(aoiKey);
            for (const item of aoiItems) aoiEvidenceIds.add(item.id);
            const snapshot = aoiEvidenceSnapshot(tx, {
                ...inspection, run_id: run.id, lot_id: lotId,
                recipe_revision_id: run.recipe_revision_id
            });
            criticalDefects += snapshot.defects.filter(defect => defect.severity === 'critical')
                .reduce((sum, defect) => sum + defect.count, 0);
            inspectedUnits += inspection.inspected_units;
            rejectedUnits += inspection.rejected_units;
            for (const sample of samplesForRun.all(run.id)) {
                sourceFacts.push({ kind: 'sample', id: sample.id, runId: run.id,
                    sampledAt: sample.sampled_at, sampleSize: sample.sample_size });
                const rows = measurementsForSample.all(sample.id);
                if (rows.length !== sample.sample_size) {
                    throw new Error('Post-change measurement source sample count changed');
                }
                for (const row of rows) {
                    const key = `measurements/${row.id}`;
                    const items = evidenceBySource.get(key) ?? [];
                    if (items.length === 0 || items.every(item => item.recorded_at >= resultByCode.get('ALIGN-X').recorded_at)) {
                        throw new Error('Post-change measurement source evidence is missing or late');
                    }
                    usedSources.add(key);
                    for (const item of items) measurementEvidenceIds.add(item.id);
                    maxAbsOffset = Math.max(maxAbsOffset, Math.abs(row.value));
                    sampledUnits++;
                    lotSampleCount++;
                }
            }
        }
        if (lotSampleCount < plan.samples_per_lot) {
            throw new Error('Post-change lot has insufficient sampled measurements');
        }
    }
    for (const key of evidenceBySource.keys()) {
        if (!usedSources.has(key)) throw new Error(`Evidence source is outside the approved post-change cohort: ${key}`);
    }
    if (inspectedUnits === 0) throw new Error('Post-change AOI denominator is missing');
    const rejectRate = rejectedUnits / inspectedUnits;
    const observed = {
        'ALIGN-X': maxAbsOffset,
        'AOI-RATE': rejectRate,
        'CRITICAL-DEFECTS': criticalDefects
    };
    for (const [code, value] of Object.entries(observed)) {
        const result = resultByCode.get(code);
        const cited = code === 'ALIGN-X' ? measurementEvidenceIds : aoiEvidenceIds;
        if (!result || result.observed_value !== value || !cited.has(result.evidence_id)) {
            throw new Error(`Source-derived criterion result mismatch: ${code}`);
        }
    }
    if (maxAbsOffset > plan.alignment_abs_limit || rejectRate > plan.max_aoi_reject_rate || criticalDefects !== 0) {
        throw new Error('Source-derived post-change criterion failed');
    }
    return { lotIds, sampledUnits, inspectedUnits, rejectedUnits,
        maxAbsOffset, rejectRate, criticalDefects, sourceFacts };
}

function frozenVerificationPackage(tx, change, plan) {
    const revisionId = revisionIdFor(change);
    const context = getChangeRevisionContext(tx, change.id, change.current_revision_no);
    if (context.lineId !== change.line_id || context.equipmentId !== change.equipment_id ||
        context.moduleId !== change.module_id || context.recipeRevisionId !== change.recipe_revision_id ||
        context.baselineRef !== change.baseline_ref ||
        context.proposerActorId !== change.proposer_actor_id) {
        throw new Error('Current change scope differs from its frozen revision context');
    }
    const risk = tx.prepare('SELECT * FROM risk_assessments WHERE id=?').get(plan.assessment_id);
    if (!risk || risk.change_revision_id !== revisionId) throw new Error('Plan risk assessment revision mismatch');
    const criteria = tx.prepare('SELECT * FROM plan_criteria WHERE plan_id=? ORDER BY code').all(plan.id);
    const results = tx.prepare('SELECT * FROM criterion_results WHERE plan_id=? ORDER BY criterion_code').all(plan.id);
    const evidence = tx.prepare('SELECT * FROM evidence_items WHERE change_revision_id=? ORDER BY id').all(revisionId);
    const deviations = tx.prepare('SELECT * FROM deviations WHERE plan_id=? ORDER BY id').all(plan.id);
    const overrides = tx.prepare('SELECT * FROM risk_overrides WHERE assessment_id=? ORDER BY id').all(risk.id);
    const evidenceById = new Map(evidence.map(row => [row.id, row]));
    const events = tx.prepare(`
        SELECT sequence,id,digest,actor_id,action,recorded_at,payload_json FROM audit_events
        WHERE entity_type='change' AND entity_id=? AND entity_revision_id=? ORDER BY sequence
    `).all(change.id, revisionId).map(row => ({
        sequence: row.sequence, id: row.id, digest: row.digest, actorId: row.actor_id,
        action: row.action, recordedAt: row.recorded_at, payload: JSON.parse(row.payload_json)
    }));
    const auditActionForType = {
        'baseline-set': 'baseline-evidence-added',
        measurement: 'measurement-evidence-added',
        aoi: 'aoi-evidence-added'
    };
    for (const item of evidence) {
        const calculated = createHash('sha256').update(item.payload_json, 'utf8').digest('hex');
        if (calculated !== item.sha256) {
            throw new Error(`Evidence hash or audit link is invalid: ${item.id}`);
        }
        const matchingAudit = events.filter(event =>
            event.action === auditActionForType[item.evidence_type] &&
            event.actorId === item.recorded_by && event.recordedAt === item.recorded_at &&
            event.payload.evidenceId === item.id && event.payload.sha256 === item.sha256 &&
            event.payload.linkedEvidenceIds?.includes(item.id) &&
            (item.evidence_type === 'baseline-set' ||
                event.payload[item.evidence_type === 'measurement' ? 'measurementId' : 'inspectionId'] === item.source_id)
        );
        if (matchingAudit.length !== 1) {
            throw new Error(`Evidence audit provenance is missing or ambiguous: ${item.id}`);
        }
        assertSourceEvidence(tx, change, item);
    }
    const baseline = evidence.filter(item => item.evidence_type === 'baseline-set');
    if (baseline.length !== 1 || baseline[0].source_table !== 'aoi_inspections' ||
        baseline[0].source_id !== change.baseline_ref) {
        throw new Error('Exactly one source-linked baseline evidence set is required');
    }
    const baselinePayload = JSON.parse(baseline[0].payload_json);
    if (!Array.isArray(baselinePayload.lotIds) || baselinePayload.lotIds.length !== plan.baseline_lots ||
        !Array.isArray(baselinePayload.measurements) ||
        baselinePayload.measurements.length < plan.baseline_lots * plan.samples_per_lot ||
        baselinePayload.sampledUnits !== baselinePayload.measurements.length ||
        baselinePayload.inspectedUnits <= 0) {
        throw new Error('Baseline evidence sampling or AOI denominator is incomplete');
    }
    const baselineAudit = events.find(event => event.action === 'baseline-evidence-added' &&
        event.payload.evidenceId === baseline[0].id && event.payload.sha256 === baseline[0].sha256);
    if (!baselineAudit) throw new Error('Baseline audit record does not match its evidence hash');
    const reconstructedBaseline = buildBaselineSourceSnapshot(tx, change, plan);
    if (baseline[0].payload_json !== reconstructedBaseline.payloadJson) {
        throw new Error('Baseline evidence differs from its current source rows');
    }
    const required = criteria.filter(row => row.required === 1);
    const requiredCodes = new Set(['ALIGN-X', 'AOI-RATE', 'CRITICAL-DEFECTS']);
    if (required.length !== 3 || required.some(row => !requiredCodes.has(row.code))) {
        throw new Error('Approved verification plan has unexpected required criteria');
    }
    for (const criterion of required) {
        const result = results.find(row => row.criterion_code === criterion.code);
        if (!result || result.passed !== 1 || result.unit !== criterion.unit ||
            !Number.isFinite(result.observed_value) ||
            (criterion.comparison === '<=' && result.observed_value > criterion.threshold)) {
            throw new Error(`Required criterion is missing or failed: ${criterion.code}`);
        }
        const cited = evidenceById.get(result.evidence_id);
        if (!cited || cited.change_revision_id !== revisionId ||
            result.recorded_at <= cited.recorded_at) {
            throw new Error(`Criterion evidence time or revision mismatch: ${criterion.code}`);
        }
        const auditAction = criterion.code === 'ALIGN-X' ? 'criterion-passed' : 'aoi-criteria-passed';
        const resultAudit = events.find(event => event.action === auditAction &&
            event.actorId === result.verifier_actor_id &&
            event.recordedAt === result.recorded_at &&
            event.payload.planId === plan.id &&
            (criterion.code === 'ALIGN-X' ? event.payload.resultId === result.id :
                event.payload.reportedCodes?.includes(criterion.code)) &&
            event.payload.linkedEvidenceIds?.includes(result.evidence_id));
        if (!resultAudit) throw new Error(`Criterion audit link is missing: ${criterion.code}`);
    }
    if (results.length !== required.length) throw new Error('Unexpected criterion result set for approved plan');
    const sourceSummary = derivePostChangeResults(tx, change, plan, evidence, results);
    const alignResult = results.find(row => row.criterion_code === 'ALIGN-X');
    const alignEvent = events.find(event => event.action === 'criterion-passed' &&
        event.payload.resultId === alignResult.id);
    const aoiEvent = events.find(event => event.action === 'aoi-criteria-passed' &&
        event.payload.planId === plan.id);
    if (!alignEvent || alignEvent.payload.observedValue !== sourceSummary.maxAbsOffset ||
        alignEvent.payload.sampleCount !== sourceSummary.sampledUnits ||
        JSON.stringify(alignEvent.payload.lotIds) !== JSON.stringify(sourceSummary.lotIds) ||
        alignEvent.payload.passed !== true ||
        !aoiEvent || aoiEvent.payload.rejectRate !== sourceSummary.rejectRate ||
        aoiEvent.payload.inspectedUnits !== sourceSummary.inspectedUnits ||
        aoiEvent.payload.rejectedUnits !== sourceSummary.rejectedUnits ||
        aoiEvent.payload.criticalDefects !== sourceSummary.criticalDefects ||
        JSON.stringify(aoiEvent.payload.lotIds) !== JSON.stringify(sourceSummary.lotIds) ||
        aoiEvent.payload.incomplete !== false) {
        throw new Error('Criterion audit values do not match source-derived verification results');
    }
    for (const deviation of deviations) {
        if (deviation.disposition === 'Open' ||
            (deviation.blocking === 1 && deviation.disposition !== 'Closed')) {
            throw new Error(`Unresolved blocking or undispositioned deviation: ${deviation.id}`);
        }
        const disposition = events.find(event => event.action === 'deviation-dispositioned' &&
            event.actorId === deviation.recorded_by && event.recordedAt === deviation.recorded_at &&
            event.payload.deviationId === deviation.id &&
            event.payload.disposition === deviation.disposition);
        if (!disposition) throw new Error(`Deviation audit disposition is missing: ${deviation.id}`);
    }
    for (const override of overrides) {
        const audited = events.find(event => event.action === 'risk-override' &&
            event.payload.overrideId === override.id && event.recordedAt === override.recorded_at);
        if (!audited || override.recorded_at > plan.approved_at) {
            throw new Error(`Risk override provenance is missing or late: ${override.id}`);
        }
    }
    const provenanceActions = new Set([
        'change-created', 'change-revised-after-failure',
        'change-revised-after-expiry',
        'change-revised-after-effectiveness-failure',
        'risk-classified', 'risk-override',
        'plan-approved', 'baseline-evidence-added', 'measurement-evidence-added',
        'aoi-evidence-added', 'criterion-passed', 'aoi-criteria-passed',
        'deviation-dispositioned'
    ]);
    const provenance = events.filter(event => provenanceActions.has(event.action)).map(event => ({
        sequence: event.sequence, id: event.id, digest: event.digest,
        actorId: event.actorId, action: event.action, recordedAt: event.recordedAt
    }));
    const packageJson = JSON.stringify(canonicalPackageValue({
        schemaVersion: 1, context, plan, risk, criteria, results, evidence,
        deviations, overrides, provenance,
        baselineSourceFacts: reconstructedBaseline.sourceFacts, sourceSummary
    }));
    const packageDigest = createHash('sha256').update(packageJson, 'utf8').digest('hex');
    return {
        packageDigest, evidenceCount: evidence.length,
        evidenceIds: evidence.map(row => row.id),
        verifierIds: [...new Set(results.map(row => row.verifier_actor_id))],
        verificationActorIds: [...new Set([
            ...results.map(row => row.verifier_actor_id),
            ...evidence.map(row => row.recorded_by),
            ...events.filter(event => event.action === 'verification-started')
                .map(event => event.actorId)
        ])],
        lastRecordedAt: [
            ...results.map(row => row.recorded_at), ...evidence.map(row => row.recorded_at),
            ...deviations.map(row => row.recorded_at), ...overrides.map(row => row.recorded_at),
            ...events.map(event => event.recordedAt)
        ].reduce((latest, recordedAt) => recordedAt > latest ? recordedAt : latest, plan.approved_at)
    };
}

export function markEvidenceReady(db, input) {
    return decisionTransaction(db, tx => {
        const change = currentChange(tx, input);
        const verifier = actor(tx, input.actorId, 'Verification Engineer');
        if (change.state !== 'Verification In Progress') throw new Error('Evidence Ready requires verification state');
        const at = text(input.at, 'Decision UTC time');
        const plan = tx.prepare(`
            SELECT * FROM verification_plans WHERE change_revision_id=? ORDER BY revision_no DESC LIMIT 1
        `).get(revisionIdFor(change));
        if (!plan) throw new Error('Approved verification plan is missing');
        const frozen = frozenVerificationPackage(tx, change, plan);
        if (at <= frozen.lastRecordedAt) throw new Error('Evidence Ready time must follow all evidence and results');
        transition(tx, change, 'Evidence Ready', at);
        appendAuditEvent(tx, {
            actorId: verifier.id, recordedAt: at, entityType: 'change', entityId: change.id,
            entityRevisionId: revisionIdFor(change), action: 'evidence-ready',
            priorState: change.state, newState: 'Evidence Ready',
            linkedEvidenceIds: frozen.evidenceIds,
            payload: { planId: plan.id, packageDigest: frozen.packageDigest,
                evidenceCount: frozen.evidenceCount, verifierIds: frozen.verifierIds,
                requiredCriteria: ['ALIGN-X', 'AOI-RATE', 'CRITICAL-DEFECTS'] }
        });
        return { id: change.id, state: 'Evidence Ready', planId: plan.id,
            packageDigest: frozen.packageDigest, evidenceCount: frozen.evidenceCount };
    });
}

function readyPackageForReview(tx, change) {
    const revisionId = revisionIdFor(change);
    const plan = tx.prepare(`
        SELECT * FROM verification_plans WHERE change_revision_id=? ORDER BY revision_no DESC LIMIT 1
    `).get(revisionId);
    if (!plan) throw new Error('Approved verification plan is missing');
    const events = tx.prepare(`
        SELECT actor_id,recorded_at,new_state,payload_json,action FROM audit_events
        WHERE entity_type='change' AND entity_id=? AND entity_revision_id=?
            AND action IN ('verification-started','evidence-ready')
        ORDER BY sequence
    `).all(change.id, revisionId);
    const starts = events.filter(event => event.action === 'verification-started');
    const ready = events.filter(event => event.action === 'evidence-ready');
    if (starts.length !== 1 || ready.length !== 1 ||
        starts[0].new_state !== 'Verification In Progress' ||
        ready[0].new_state !== 'Evidence Ready' ||
        starts[0].recorded_at >= ready[0].recorded_at) {
        throw new Error('Verification start or Evidence Ready audit anchor is missing');
    }
    const startPayload = JSON.parse(starts[0].payload_json);
    const readyPayload = JSON.parse(ready[0].payload_json);
    if (startPayload.planId !== plan.id || readyPayload.planId !== plan.id) {
        throw new Error('Review plan differs from the audited verification plan');
    }
    const frozen = frozenVerificationPackage(tx,
        { ...change, updated_at: starts[0].recorded_at }, plan);
    if (readyPayload.packageDigest !== frozen.packageDigest ||
        readyPayload.evidenceCount !== frozen.evidenceCount ||
        JSON.stringify(readyPayload.linkedEvidenceIds) !== JSON.stringify(frozen.evidenceIds) ||
        JSON.stringify(readyPayload.verifierIds) !== JSON.stringify(frozen.verifierIds)) {
        throw new Error('Evidence Ready frozen package digest or evidence set changed');
    }
    return { plan, ready: ready[0], frozen };
}

export function beginIndependentReview(db, input) {
    return decisionTransaction(db, tx => {
        const change = currentChange(tx, input);
        const reviewer = actor(tx, input.actorId, 'Reviewer');
        if (change.state !== 'Evidence Ready') throw new Error('Independent review requires Evidence Ready');
        const at = text(input.at, 'Review UTC time');
        const { plan, ready, frozen } = readyPackageForReview(tx, change);
        if (reviewer.id === change.proposer_actor_id ||
            reviewer.id === ready.actor_id ||
            frozen.verificationActorIds.includes(reviewer.id)) {
            throw new Error('Independent reviewer must differ from proposer and verifiers');
        }
        if (at <= ready.recorded_at) throw new Error('Review time must follow Evidence Ready');
        transition(tx, change, 'Independent Review', at);
        appendAuditEvent(tx, {
            actorId: reviewer.id, recordedAt: at, entityType: 'change', entityId: change.id,
            entityRevisionId: revisionIdFor(change), action: 'independent-review-started',
            priorState: change.state, newState: 'Independent Review',
            linkedEvidenceIds: frozen.evidenceIds,
            payload: { planId: plan.id, packageDigest: frozen.packageDigest,
                evidenceCount: frozen.evidenceCount }
        });
        return { id: change.id, state: 'Independent Review', planId: plan.id,
            packageDigest: frozen.packageDigest };
    });
}

export function recordIndependentReview(db, input) {
    return decisionTransaction(db, tx => {
        const change = currentChange(tx, input);
        const reviewer = actor(tx, input.actorId, 'Reviewer');
        if (change.state !== 'Independent Review') throw new Error('Review decision requires Independent Review state');
        const decision = text(input.decision, 'Review decision');
        if (decision !== 'Pass' && decision !== 'Needs Rework') {
            throw new Error('Review decision must be Pass or Needs Rework');
        }
        const reason = text(input.reason, 'Review reason');
        const at = text(input.at, 'Review UTC time');
        const reviewId = text(input.reviewId, 'Review ID');
        const { plan, frozen } = readyPackageForReview(tx, change);
        const revisionId = revisionIdFor(change);
        const starts = tx.prepare(`
            SELECT actor_id,recorded_at,payload_json FROM audit_events
            WHERE entity_type='change' AND entity_id=? AND entity_revision_id=?
                AND action='independent-review-started'
            ORDER BY sequence
        `).all(change.id, revisionId);
        if (starts.length !== 1 || starts[0].actor_id !== reviewer.id ||
            JSON.parse(starts[0].payload_json).packageDigest !== frozen.packageDigest) {
            throw new Error('Review decision actor or frozen package differs from review start');
        }
        if (at <= starts[0].recorded_at || at < change.updated_at) {
            throw new Error('Review decision time must follow review start');
        }
        if (tx.prepare('SELECT id FROM reviews WHERE change_revision_id=?').get(revisionId)) {
            throw new Error('Review decision already exists for this change revision');
        }
        tx.prepare(`
            INSERT INTO reviews(id,change_revision_id,plan_id,reviewer_actor_id,
                decision,reason,evidence_set_digest,reviewed_at)
            VALUES (?,?,?,?,?,?,?,?)
        `).run(reviewId, revisionId, plan.id, reviewer.id,
            decision, reason, frozen.packageDigest, at);
        if (decision === 'Needs Rework') transition(tx, change, 'Needs Rework', at);
        appendAuditEvent(tx, {
            actorId: reviewer.id, recordedAt: at, entityType: 'change', entityId: change.id,
            entityRevisionId: revisionId,
            action: decision === 'Pass' ? 'independent-review-passed' : 'independent-review-needs-rework',
            priorState: change.state,
            newState: decision === 'Needs Rework' ? 'Needs Rework' : null,
            reason, linkedEvidenceIds: frozen.evidenceIds,
            payload: { reviewId, planId: plan.id, decision,
                packageDigest: frozen.packageDigest }
        });
        return { reviewId, decision, state: decision === 'Pass' ? change.state : 'Needs Rework',
            packageDigest: frozen.packageDigest };
    });
}

export function acceptChange(db, input) {
    return decisionTransaction(db, tx => {
        const change = currentChange(tx, input);
        const approver = actor(tx, input.actorId, 'Approver');
        if (change.state !== 'Independent Review') {
            throw new Error('Acceptance requires Independent Review state');
        }
        const acceptanceId = text(input.acceptanceId, 'Acceptance ID');
        const reviewId = text(input.reviewId, 'Passing review ID');
        const reason = text(input.reason, 'Acceptance reason');
        const at = utc(input.at, 'Acceptance UTC time');
        const serverNow = utc(input.serverNow ?? new Date().toISOString(),
            'Server UTC time');
        if (at > serverNow) {
            throw new Error('Acceptance time cannot exceed server UTC time');
        }
        const terms = acceptanceTerms(input, at);
        const { plan, ready, frozen } = readyPackageForReview(tx, change);
        const revisionId = revisionIdFor(change);
        const reviews = tx.prepare(`
            SELECT * FROM reviews WHERE change_revision_id=? ORDER BY reviewed_at,id
        `).all(revisionId);
        if (reviews.length !== 1 || reviews[0].id !== reviewId ||
            reviews[0].decision !== 'Pass' || reviews[0].plan_id !== plan.id ||
            reviews[0].evidence_set_digest !== frozen.packageDigest) {
            throw new Error('A matching passing independent review is required for acceptance');
        }
        const review = reviews[0];
        actor(tx, review.reviewer_actor_id, 'Reviewer');
        if (approver.id === change.proposer_actor_id || approver.id === review.reviewer_actor_id ||
            approver.id === ready.actor_id ||
            frozen.verificationActorIds.includes(approver.id) ||
            review.reviewer_actor_id === change.proposer_actor_id ||
            review.reviewer_actor_id === ready.actor_id ||
            frozen.verificationActorIds.includes(review.reviewer_actor_id)) {
            throw new Error('Acceptance approver and reviewer must be independent of proposer and verifiers');
        }
        const reviewEvents = tx.prepare(`
            SELECT action,actor_id,recorded_at,prior_state,new_state,reason,payload_json
            FROM audit_events WHERE entity_type='change' AND entity_id=?
                AND entity_revision_id=?
                AND action IN ('independent-review-started','independent-review-passed')
            ORDER BY sequence
        `).all(change.id, revisionId);
        const started = reviewEvents.filter(event => event.action === 'independent-review-started');
        const passed = reviewEvents.filter(event => event.action === 'independent-review-passed');
        if (started.length !== 1 || passed.length !== 1 ||
            started[0].actor_id !== review.reviewer_actor_id ||
            passed[0].actor_id !== review.reviewer_actor_id ||
            started[0].prior_state !== 'Evidence Ready' ||
            started[0].new_state !== 'Independent Review' ||
            passed[0].prior_state !== 'Independent Review' ||
            passed[0].new_state !== null ||
            passed[0].recorded_at !== review.reviewed_at ||
            passed[0].reason !== review.reason ||
            started[0].recorded_at >= passed[0].recorded_at) {
            throw new Error('Passing independent review audit provenance is missing');
        }
        const startPayload = JSON.parse(started[0].payload_json);
        const passPayload = JSON.parse(passed[0].payload_json);
        if (startPayload.planId !== plan.id ||
            startPayload.packageDigest !== frozen.packageDigest ||
            passPayload.planId !== plan.id || passPayload.reviewId !== review.id ||
            passPayload.decision !== 'Pass' ||
            passPayload.packageDigest !== frozen.packageDigest ||
            !Array.isArray(passPayload.linkedEvidenceIds) ||
            JSON.stringify(passPayload.linkedEvidenceIds) !== JSON.stringify(frozen.evidenceIds)) {
            throw new Error('Passing review audit package differs from frozen evidence');
        }
        if (at <= review.reviewed_at || at <= change.updated_at) {
            throw new Error('Acceptance time must follow independent review decision');
        }
        tx.prepare(`
            INSERT INTO acceptances(id,change_revision_id,plan_id,review_id,
                approver_actor_id,accepted_at,frozen_digest,acceptance_type,
                condition_text,expires_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)
        `).run(acceptanceId, revisionId, plan.id, review.id,
            approver.id, at, frozen.packageDigest, terms.acceptanceType,
            terms.condition, terms.expiresAt);
        transition(tx, change, 'Accepted', at);
        appendAuditEvent(tx, {
            actorId: approver.id, recordedAt: at, entityType: 'change', entityId: change.id,
            entityRevisionId: revisionId, action: 'change-accepted',
            priorState: change.state, newState: 'Accepted', reason,
            linkedEvidenceIds: frozen.evidenceIds,
            payload: { acceptanceId, reviewId: review.id, planId: plan.id,
                packageDigest: frozen.packageDigest, reviewerActorId: review.reviewer_actor_id,
                verifierActorIds: frozen.verificationActorIds,
                acceptanceType: terms.acceptanceType, condition: terms.condition,
                expiresAt: terms.expiresAt }
        });
        return { acceptanceId, state: 'Accepted', reviewId: review.id,
            planId: plan.id, frozenDigest: frozen.packageDigest,
            acceptanceType: terms.acceptanceType, condition: terms.condition,
            expiresAt: terms.expiresAt };
    });
}
