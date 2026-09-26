import { withValidatedTransaction } from '../data/db.mjs';
import { appendAuditEvent } from './audit.mjs';
import { assertOperatingAcceptance, getChangeRevisionContext } from './change-service.mjs';
import { assertStateTransition } from './state.mjs';
import { projectSource } from './change-effectiveness-source.mjs';

function required(value, label) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
    return value.trim();
}

function stableId(value, label) {
    const id = required(value, label);
    if (!/^[A-Z][A-Z0-9-]{2,79}$/.test(id)) {
        throw new TypeError(`${label} must be a synthetic stable ID`);
    }
    return id;
}

function utc(value, label) {
    const at = required(value, label);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) ||
        !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) {
        throw new TypeError(`${label} must be canonical UTC`);
    }
    return at;
}

function actor(tx, id, roles) {
    const row = tx.prepare('SELECT id,role FROM demo_actors WHERE id=?')
        .get(stableId(id, 'Simulated actor ID'));
    if (!row || !roles.includes(row.role)) throw new Error('Qualified simulated actor is required');
    return row;
}

function context(tx, input, states) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('Change effectiveness input is required');
    }
    const changeId = stableId(input.changeId, 'Change ID');
    const change = tx.prepare('SELECT * FROM changes WHERE id=?').get(changeId);
    if (!change || !states.includes(change.state)) {
        throw new Error(`Change must be ${states.join(' or ')}`);
    }
    if (!Number.isSafeInteger(input.expectedRevisionNo) ||
        input.expectedRevisionNo !== change.current_revision_no) {
        throw new Error('Stale Change revision');
    }
    const revisionId = `${change.id}-R${change.current_revision_no}`;
    const frozen = getChangeRevisionContext(tx, change.id, change.current_revision_no);
    if (frozen.equipmentId !== change.equipment_id ||
        frozen.moduleId !== change.module_id) {
        throw new Error('Frozen Change scope differs from current equipment and module');
    }
    const at = utc(input.at, 'Decision time');
    const serverNow = utc(input.serverNow ?? new Date().toISOString(), 'Server UTC time');
    if (at > serverNow) throw new Error('Decision time cannot be later than server UTC time');
    if (at <= change.updated_at) throw new Error('Decision must follow prior Change event');
    const authority = assertOperatingAcceptance(tx, revisionId, serverNow);
    if (authority.authorityRevisionId !== revisionId) {
        throw new Error('Current Change revision Acceptance is required');
    }
    const acceptance = tx.prepare(`SELECT * FROM acceptances
        WHERE change_revision_id=? AND id=?`).get(revisionId, authority.acceptanceId);
    if (!acceptance || acceptance.accepted_at >= at) {
        throw new Error('Prior current Acceptance is required for monitoring');
    }
    const plan = tx.prepare(`SELECT * FROM verification_plans
        WHERE change_revision_id=? AND id=?`).get(revisionId, acceptance.plan_id);
    if (!plan) throw new Error('Accepted verification plan is missing');
    return { change: { ...change, recipe_revision_id: frozen.recipeRevisionId },
        revisionId, acceptance, plan, at, serverNow };
}

function decisionTransaction(db, operation) {
    return withValidatedTransaction(db, tx => {
        const before = tx.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        const result = operation(tx);
        const after = tx.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        if (after !== before + 1) throw new Error('Change effectiveness decision requires one audit event');
        return result;
    });
}

function checkAudit(tx, changeId, checkId) {
    const rows = tx.prepare(`SELECT payload_json FROM audit_events
        WHERE entity_type='change' AND entity_id=?
            AND action='change-effectiveness-evaluated'
            AND json_extract(payload_json,'$.checkId')=?
        ORDER BY sequence`).all(changeId, checkId);
    if (rows.length !== 1) throw new Error('Effectiveness source audit is missing');
    return JSON.parse(rows[0].payload_json);
}

export function evaluateChangeEffectiveness(db, input) {
    return decisionTransaction(db, tx => {
        const ctx = context(tx, input,
            ['Accepted', 'Effectiveness Monitoring', 'Closed']);
        const evaluator = actor(tx, input.actorId,
            ['Quality Engineer', 'Verification Engineer']);
        const id = stableId(input.id, 'Effectiveness check ID');
        const { source, sourceDigest, assessment } = projectSource(tx, ctx);
        const reason = assessment.reasons.length ? assessment.reasons.join('; ') :
            'Synthetic later source meets the approved monitoring rule';
        tx.prepare(`INSERT INTO effectiveness_checks(id,change_revision_id,
            window_start,window_end,lot_count,passed,reason,recorded_by,recorded_at)
            VALUES (?,?,?,?,?,?,?,?,?)`).run(id, ctx.revisionId,
            ctx.acceptance.accepted_at, ctx.at, assessment.observedLots,
            Number(assessment.status === 'Pass'), reason, evaluator.id, ctx.at);
        const nextState = ctx.change.state === 'Accepted' ?
            'Effectiveness Monitoring' : ctx.change.state;
        if (nextState !== ctx.change.state) {
            assertStateTransition('change', ctx.change.state, nextState);
        }
        const changed = tx.prepare(`UPDATE changes SET state=?,updated_at=?
            WHERE id=? AND state=? AND current_revision_no=?`).run(nextState,
            ctx.at, ctx.change.id, ctx.change.state, ctx.change.current_revision_no);
        if (changed.changes !== 1) throw new Error('Stale Change state');
        appendAuditEvent(tx, { actorId: evaluator.id, recordedAt: ctx.at,
            entityType: 'change', entityId: ctx.change.id,
            entityRevisionId: ctx.revisionId,
            action: 'change-effectiveness-evaluated',
            priorState: ctx.change.state,
            newState: nextState !== ctx.change.state ? nextState : null,
            reason, ruleVersion: assessment.ruleVersion,
            payload: { checkId: id, cycleNo: ctx.change.cycle_no,
                acceptanceId: ctx.acceptance.id, planId: ctx.plan.id,
                sourceDigest, sourceLotIds: source.lots.map(lot => lot.lotId),
                sourceRunIds: source.lots.map(lot => lot.runId),
                aoiInspectionIds: source.lots.map(lot => lot.aoiId),
                windowStart: source.windowStart, windowEnd: source.windowEnd,
                status: assessment.status, requiredLots: assessment.requiredLots,
                lotCount: assessment.observedLots,
                observedCalendarDays: assessment.observedCalendarDays,
                inspectedUnits: assessment.inspectedUnits,
                rejectedUnits: assessment.rejectedUnits,
                targetedDefects: assessment.targetedDefects,
                criticalDefects: assessment.criticalDefects,
                unresolvedAlarmIds: source.unresolvedAlarmIds,
                blockingDeviationIds: source.blockingDeviationIds,
                reasons: assessment.reasons } });
        return { checkId: id, state: nextState, status: assessment.status,
            lotCount: assessment.observedLots,
            lotIds: source.lots.map(lot => lot.lotId), sourceDigest,
            reasons: assessment.reasons };
    });
}

export function closeChangeMonitoring(db, input) {
    return decisionTransaction(db, tx => {
        const ctx = context(tx, input, ['Effectiveness Monitoring']);
        const approver = actor(tx, input.actorId,
            ['Quality Engineer', 'Approver']);
        const checkId = stableId(input.checkId, 'Passing check ID');
        const check = tx.prepare(`SELECT * FROM effectiveness_checks
            WHERE id=? AND change_revision_id=? AND passed=1`)
            .get(checkId, ctx.revisionId);
        const latest = tx.prepare(`SELECT id FROM effectiveness_checks
            WHERE change_revision_id=? ORDER BY recorded_at DESC,id DESC LIMIT 1`)
            .get(ctx.revisionId);
        if (!check || latest?.id !== checkId || check.recorded_at >= ctx.at) {
            throw new Error('Latest passing Change effectiveness check is required');
        }
        if (approver.id === check.recorded_by ||
            approver.id === ctx.change.proposer_actor_id) {
            throw new Error('Separate Change closure approver is required');
        }
        const reviewed = checkAudit(tx, ctx.change.id, checkId);
        if (reviewed.status !== 'Pass' || reviewed.cycleNo !== ctx.change.cycle_no ||
            reviewed.acceptanceId !== ctx.acceptance.id) {
            throw new Error('Passing source audit does not match current Change cycle');
        }
        const fresh = projectSource(tx, { ...ctx, at: check.window_end });
        if (fresh.sourceDigest !== reviewed.sourceDigest ||
            fresh.assessment.status !== 'Pass') {
            throw new Error('Later source changed after the passing effectiveness check');
        }
        const id = stableId(input.id, 'Closure decision ID');
        const reason = required(input.reason, 'Closure reason');
        assertStateTransition('change', ctx.change.state, 'Closed');
        const changed = tx.prepare(`UPDATE changes SET state='Closed',updated_at=?
            WHERE id=? AND state='Effectiveness Monitoring'
                AND current_revision_no=?`).run(ctx.at, ctx.change.id,
            ctx.change.current_revision_no);
        if (changed.changes !== 1) throw new Error('Stale Change state');
        appendAuditEvent(tx, { actorId: approver.id, recordedAt: ctx.at,
            entityType: 'change', entityId: ctx.change.id,
            entityRevisionId: ctx.revisionId, action: 'change-monitoring-closed',
            priorState: ctx.change.state, newState: 'Closed', reason,
            payload: { decisionId: id, cycleNo: ctx.change.cycle_no,
                checkId, acceptanceId: ctx.acceptance.id,
                sourceDigest: reviewed.sourceDigest } });
        return { decisionId: id, checkId, state: 'Closed' };
    });
}

export function reopenChangeMonitoring(db, input) {
    return decisionTransaction(db, tx => {
        const ctx = context(tx, input, ['Closed', 'Effectiveness Monitoring']);
        const engineer = actor(tx, input.actorId, ['Quality Engineer']);
        const checkId = stableId(input.checkId, 'Failed monitoring check ID');
        const check = tx.prepare(`SELECT * FROM effectiveness_checks
            WHERE id=? AND change_revision_id=? AND passed=0`)
            .get(checkId, ctx.revisionId);
        const latest = tx.prepare(`SELECT id FROM effectiveness_checks
            WHERE change_revision_id=? ORDER BY recorded_at DESC,id DESC LIMIT 1`)
            .get(ctx.revisionId);
        const closeEvents = tx.prepare(`SELECT id,recorded_at,payload_json
            FROM audit_events WHERE entity_type='change' AND entity_id=?
                AND action='change-monitoring-closed'
                AND json_extract(payload_json,'$.cycleNo')=?
            ORDER BY sequence`).all(ctx.change.id, ctx.change.cycle_no);
        const afterClosure = ctx.change.state === 'Closed';
        const sourceBoundary = afterClosure ? closeEvents[0]?.recorded_at :
            ctx.acceptance.accepted_at;
        if (!check || latest?.id !== checkId ||
            closeEvents.length !== (afterClosure ? 1 : 0) ||
            !sourceBoundary || check.recorded_at <= sourceBoundary ||
            check.recorded_at >= ctx.at) {
            throw new Error('Later failed source-derived monitoring is required for Change reopen');
        }
        const reviewed = checkAudit(tx, ctx.change.id, checkId);
        if (reviewed.status !== 'Reopen Required' ||
            reviewed.cycleNo !== ctx.change.cycle_no ||
            reviewed.acceptanceId !== ctx.acceptance.id) {
            throw new Error('Failed monitoring audit does not match current Change cycle');
        }
        const fresh = projectSource(tx, { ...ctx, at: check.window_end });
        if (fresh.sourceDigest !== reviewed.sourceDigest ||
            fresh.assessment.status !== 'Reopen Required') {
            throw new Error('Later source changed after the failed effectiveness check');
        }
        let recurrenceAoiDefectId = null;
        if (reviewed.targetedDefects > 0) {
            recurrenceAoiDefectId = stableId(input.recurrenceAoiDefectId,
                'Target recurrence AOI defect ID');
        } else if (input.recurrenceAoiDefectId != null) {
            recurrenceAoiDefectId = stableId(input.recurrenceAoiDefectId,
                'Recurrence AOI defect ID');
        }
        if (recurrenceAoiDefectId) {
            const defect = tx.prepare(`SELECT d.id,a.id AS aoi_id,a.inspected_at
                FROM aoi_defects d JOIN aoi_inspections a
                    ON a.id=d.aoi_inspection_id
                JOIN process_runs r ON r.id=a.process_run_id
                WHERE d.id=? AND d.defect_code_id='DEF-ALIGN'
                    AND d.defect_count>0 AND r.equipment_id=?
                    AND r.module_id=? AND r.recipe_revision_id=?`)
                .get(recurrenceAoiDefectId, ctx.change.equipment_id,
                    ctx.change.module_id, ctx.change.recipe_revision_id);
            if (!defect || defect.inspected_at <= sourceBoundary ||
                defect.inspected_at > check.recorded_at ||
                !reviewed.aoiInspectionIds.includes(defect.aoi_id)) {
                throw new Error('Change reopen needs a later linked target AOI recurrence');
            }
        }
        const id = stableId(input.id, 'Reopen decision ID');
        const reason = required(input.reason, 'Reopen reason');
        const nextCycleNo = ctx.change.cycle_no + 1;
        assertStateTransition('change', ctx.change.state, 'Reopened',
            { newCycle: true });
        const changed = tx.prepare(`UPDATE changes
            SET state='Reopened',cycle_no=?,updated_at=?
            WHERE id=? AND state=? AND cycle_no=?
                AND current_revision_no=?`).run(nextCycleNo, ctx.at,
            ctx.change.id, ctx.change.state, ctx.change.cycle_no,
            ctx.change.current_revision_no);
        if (changed.changes !== 1) throw new Error('Stale Change cycle');
        appendAuditEvent(tx, { actorId: engineer.id, recordedAt: ctx.at,
            entityType: 'change', entityId: ctx.change.id,
            entityRevisionId: ctx.revisionId,
            action: 'change-monitoring-reopened',
            priorState: ctx.change.state, newState: 'Reopened', reason,
            payload: { decisionId: id, priorCycleNo: ctx.change.cycle_no,
                nextCycleNo, priorClosureId: afterClosure ?
                    JSON.parse(closeEvents[0].payload_json).decisionId : null,
                failedCheckId: checkId, acceptanceId: ctx.acceptance.id,
                sourceDigest: reviewed.sourceDigest, recurrenceAoiDefectId } });
        return { decisionId: id, failedCheckId: checkId,
            nextCycleNo, state: 'Reopened', recurrenceAoiDefectId };
    });
}
