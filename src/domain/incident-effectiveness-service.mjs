import { createHash } from 'node:crypto';
import { withValidatedTransaction } from '../data/db.mjs';
import { appendAuditEvent } from './audit.mjs';
import { assertStateTransition } from './state.mjs';
import { assertOperatingAcceptance } from './change-service.mjs';

function required(value, label) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
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
    if (!row || !roles.includes(row.role)) throw new Error('Qualified simulated actor is required');
    return row;
}

function context(tx, input, states) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('Incident effectiveness input is required');
    }
    const incidentId = stableId(input.incidentId, 'Incident ID');
    const incident = tx.prepare(`SELECT i.*,d.severity FROM incidents i
        JOIN defect_codes d ON d.id=i.defect_code_id WHERE i.id=?`).get(incidentId);
    if (!incident || !states.includes(incident.state)) {
        throw new Error(`Incident must be ${states.join(' or ')}`);
    }
    const revision = tx.prepare(`SELECT * FROM incident_revisions WHERE incident_id=?
        ORDER BY revision_no DESC LIMIT 1`).get(incidentId);
    if (!revision || !Number.isSafeInteger(input.expectedRevisionNo) ||
        input.expectedRevisionNo !== revision.revision_no) throw new Error('Stale incident revision');
    const cycleId = stableId(input.cycleId, 'CAPA cycle ID');
    const cycle = tx.prepare(`SELECT * FROM incident_cycles WHERE id=? AND incident_id=?
        AND cycle_no=?`).get(cycleId, incidentId, incident.cycle_no);
    if (!cycle) throw new Error('Current CAPA cycle is missing');
    const at = utc(input.at, 'Decision time');
    if (at <= incident.updated_at) throw new Error('Decision must follow prior event');
    const serverNow = utc(input.serverNow ?? new Date().toISOString(), 'Server UTC time');
    if (at > serverNow) throw new Error('Decision time cannot be later than server UTC time');
    return { incident, revision, cycle, at, serverNow };
}

function decisionTransaction(db, operation) {
    return withValidatedTransaction(db, tx => {
        const before = tx.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        const result = operation(tx);
        const after = tx.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
        if (after !== before + 1) throw new Error('Incident effectiveness decision requires one audit event');
        return result;
    });
}

function windowStart(tx, cycle, incident, at) {
    const actions = tx.prepare(`SELECT a.action_type,r.reviewed_at FROM capa_actions a
        JOIN capa_action_reviews r ON r.action_id=a.id AND r.decision='Pass'
        WHERE a.cycle_id=? ORDER BY r.reviewed_at,r.id`).all(cycle.id);
    if (!actions.some(row => row.action_type === 'Corrective') ||
        !actions.some(row => row.action_type === 'Preventive')) {
        throw new Error('Passing independent corrective and preventive reviews are required');
    }
    const priorClose = tx.prepare(`SELECT decided_at FROM incident_cycle_decisions
        WHERE cycle_id=? AND decision='Closed'`).get(cycle.id);
    const baseline = [cycle.opened_at, ...actions.map(row => row.reviewed_at),
        ...(priorClose ? [priorClose.decided_at] : [])].sort().at(-1);
    const start = new Date(Date.parse(baseline) + 1).toISOString();
    if (start >= at) throw new Error('Effectiveness window has not started');
    if (priorClose && incident.state !== 'Closed') {
        throw new Error('Post-close monitoring requires Closed state');
    }
    return { start, actions, priorClose };
}

function projectSource(tx, incident, start, end) {
    const runs = tx.prepare(`SELECT r.id AS run_id,r.lot_id,r.start_at,r.end_at,
        r.processed_units,a.id AS aoi_id,a.inspected_at,a.inspected_units,a.rejected_units
        FROM process_runs r LEFT JOIN aoi_inspections a ON a.process_run_id=r.id
        WHERE r.equipment_id=? AND r.module_id=? AND r.start_at>=? AND r.end_at<=?
        ORDER BY r.start_at,r.id`).all(incident.equipment_id, incident.module_id, start, end);
    for (const row of runs) {
        if (!row.aoi_id || row.end_at > end || row.inspected_at < row.start_at ||
            row.inspected_at >= row.end_at || row.inspected_at >= end ||
            row.inspected_units !== row.processed_units) {
            throw new Error(`Complete same-run AOI evidence is required: ${row.run_id}`);
        }
    }
    const lotIds = runs.map(row => row.lot_id);
    if (new Set(lotIds).size !== lotIds.length) {
        throw new Error('Each effectiveness lot must have one selected run');
    }
    const inspected = runs.reduce((sum, row) => sum + row.inspected_units, 0);
    const rejected = runs.reduce((sum, row) => sum + row.rejected_units, 0);
    const recurrence = tx.prepare(`SELECT COALESCE(SUM(d.defect_count),0) AS n
        FROM process_runs r JOIN aoi_inspections a ON a.process_run_id=r.id
        JOIN aoi_defects d ON d.aoi_inspection_id=a.id
        WHERE r.equipment_id=? AND r.module_id=? AND r.start_at>=?
            AND a.inspected_at<? AND d.defect_code_id=?`)
        .get(incident.equipment_id, incident.module_id, start, end,
            incident.defect_code_id).n;
    const unresolved = tx.prepare(`SELECT COUNT(*) AS n FROM equipment_events e
        WHERE e.equipment_id=? AND e.module_id=? AND e.occurred_at>=?
            AND e.occurred_at<? AND e.event_type IN ('alarm','failure')
            AND NOT EXISTS (SELECT 1 FROM equipment_event_resolutions link
                JOIN maintenance_actions m ON m.id=link.maintenance_action_id
                WHERE link.equipment_event_id=e.id AND m.end_at<=?
                    AND link.recorded_at<=?)`)
        .get(incident.equipment_id, incident.module_id, start, end, end, end).n;
    const days = runs.map(row => row.inspected_at.slice(0, 10)).sort();
    const calendarDays = days.length > 1 ?
        (Date.parse(`${days.at(-1)}T00:00:00.000Z`) -
            Date.parse(`${days[0]}T00:00:00.000Z`)) / 86400000 : 0;
    return { runs, lotIds, inspected, rejected, recurrence, unresolved, calendarDays };
}

export function evaluateIncidentEffectiveness(db, input) {
    return decisionTransaction(db, tx => {
        const { incident, revision, cycle, at, serverNow } = context(tx, input,
            ['CAPA In Progress', 'Effectiveness Check', 'Closed']);
        const operatingAcceptance = assertOperatingAcceptance(tx,
            cycle.linked_change_revision_id, serverNow);
        const evaluator = actor(tx, input.actorId, ['Quality Engineer', 'Verification Engineer']);
        const id = stableId(input.id, 'Effectiveness check ID');
        const { start, actions, priorClose } = windowStart(tx, cycle, incident, at);
        const source = projectSource(tx, incident, start, at);
        const linkedHighRisk = tx.prepare(`SELECT 1 FROM verification_plans
            WHERE change_revision_id IN (?,?) AND final_level='L3' LIMIT 1`)
            .get(cycle.linked_change_revision_id,
                operatingAcceptance?.authorityRevisionId ?? cycle.linked_change_revision_id);
        const requiredLots = incident.severity === 'critical' || linkedHighRisk ? 10 : 5;
        const passed = source.lotIds.length >= requiredLots && source.calendarDays >= 7 &&
            source.inspected > 0 && source.rejected * 100 <= source.inspected * 2 &&
            source.recurrence === 0 && source.unresolved === 0 &&
            actions.every(row => row.reviewed_at < start);
        const sourceJson = JSON.stringify({ lotIds: source.lotIds });
        const digest = createHash('sha256').update(sourceJson, 'utf8').digest('hex');
        tx.prepare(`INSERT INTO incident_effectiveness_checks(id,cycle_id,incident_id,
            window_start,window_end,source_json,source_digest,lot_count,
            inspected_units,rejected_units,recurrence_count,unresolved_alarm_count,
            rule_version,passed,evaluated_by,evaluated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, cycle.id, incident.id,
                start, at, sourceJson, digest, source.lotIds.length, source.inspected,
                source.rejected, source.recurrence, source.unresolved, 'DEMO-CAPA-1',
                Number(passed), evaluator.id, at);
        const nextState = incident.state === 'CAPA In Progress' ? 'Effectiveness Check' :
            incident.state;
        if (nextState !== incident.state) {
            assertStateTransition('incident', incident.state, nextState);
        }
        tx.prepare('UPDATE incidents SET state=?,updated_at=? WHERE id=? AND state=?')
            .run(nextState, at, incident.id, incident.state);
        const gaps = [];
        if (source.lotIds.length < requiredLots) gaps.push(`${requiredLots - source.lotIds.length} later lots`);
        if (source.calendarDays < 7) gaps.push(`${7 - source.calendarDays} calendar days`);
        if (source.inspected === 0) gaps.push('AOI denominator');
        if (source.rejected * 100 > source.inspected * 2) gaps.push('AOI reject rate above 2%');
        if (source.recurrence) gaps.push('target defect recurrence');
        if (source.unresolved) gaps.push('unresolved related alarm');
        appendAuditEvent(tx, { actorId: evaluator.id, recordedAt: at,
            entityType: 'incident', entityId: incident.id, entityRevisionId: revision.id,
            action: 'effectiveness-evaluated', priorState: incident.state,
            newState: nextState !== incident.state ? nextState : null,
            reason: passed ? 'Synthetic source window meets DEMO-CAPA-1' :
                `Synthetic source window needs action: ${gaps.join(', ')}`,
            payload: { cycleId: cycle.id, checkId: id, sourceDigest: digest,
                sourceRunIds: source.runs.map(row => row.run_id),
                aoiInspectionIds: source.runs.map(row => row.aoi_id),
                windowStart: start, windowEnd: at, requiredLots,
                lotCount: source.lotIds.length, inspectedUnits: source.inspected,
                rejectedUnits: source.rejected, recurrenceCount: source.recurrence,
                unresolvedAlarmCount: source.unresolved, calendarDays: source.calendarDays,
                passed, gaps, postClose: Boolean(priorClose),
                operatingAcceptanceId: operatingAcceptance?.acceptanceId ?? null,
                authorityRevisionId: operatingAcceptance?.authorityRevisionId ?? null } });
        return { checkId: id, cycleId: cycle.id, state: nextState, passed, gaps,
            sourceDigest: digest, lotCount: source.lotIds.length,
            inspectedUnits: source.inspected, rejectedUnits: source.rejected,
            recurrenceCount: source.recurrence, unresolvedAlarmCount: source.unresolved,
            windowStart: start, windowEnd: at };
    });
}

export function closeIncidentCycle(db, input) {
    return decisionTransaction(db, tx => {
        const { incident, revision, cycle, at, serverNow } = context(tx, input,
            ['Effectiveness Check']);
        const operatingAcceptance = assertOperatingAcceptance(tx,
            cycle.linked_change_revision_id, serverNow);
        const approver = actor(tx, input.actorId, ['Approver', 'Quality Engineer']);
        const checkId = stableId(input.checkId, 'Passing effectiveness check ID');
        const check = tx.prepare(`SELECT * FROM incident_effectiveness_checks
            WHERE id=? AND cycle_id=? AND incident_id=? AND passed=1`)
            .get(checkId, cycle.id, incident.id);
        const latest = tx.prepare(`SELECT id FROM incident_effectiveness_checks
            WHERE cycle_id=? AND incident_id=?
            ORDER BY evaluated_at DESC,id DESC LIMIT 1`).get(cycle.id, incident.id);
        if (!check || latest?.id !== checkId || check.evaluated_at >= at) {
            throw new Error('Latest passing effectiveness check is required');
        }
        if (approver.id === check.evaluated_by || approver.id === incident.proposer_actor_id) {
            throw new Error('Separate closure approver is required');
        }
        const reason = required(input.reason, 'Closure reason');
        const id = stableId(input.id, 'Closure decision ID');
        assertStateTransition('incident', incident.state, 'Closed');
        tx.prepare(`INSERT INTO incident_cycle_decisions(id,cycle_id,incident_id,
            decision,effectiveness_check_id,actor_id,reason,decided_at)
            VALUES (?,?,?,'Closed',?,?,?,?)`).run(id, cycle.id, incident.id,
                checkId, approver.id, reason, at);
        tx.prepare(`UPDATE incidents SET state='Closed',updated_at=?
            WHERE id=? AND state='Effectiveness Check'`).run(at, incident.id);
        appendAuditEvent(tx, { actorId: approver.id, recordedAt: at,
            entityType: 'incident', entityId: incident.id, entityRevisionId: revision.id,
            action: 'incident-closed', priorState: 'Effectiveness Check',
            newState: 'Closed', reason,
            payload: { cycleId: cycle.id, decisionId: id, checkId,
                sourceDigest: check.source_digest,
                operatingAcceptanceId: operatingAcceptance?.acceptanceId ?? null,
                authorityRevisionId: operatingAcceptance?.authorityRevisionId ?? null } });
        return { decisionId: id, cycleId: cycle.id, checkId, state: 'Closed' };
    });
}

export function reopenIncidentCycle(db, input) {
    return decisionTransaction(db, tx => {
        const { incident, revision, cycle, at, serverNow } = context(tx, input, ['Closed']);
        const operatingAcceptance = assertOperatingAcceptance(tx,
            cycle.linked_change_revision_id, serverNow);
        const engineer = actor(tx, input.actorId, ['Quality Engineer']);
        const checkId = stableId(input.checkId, 'Failed monitoring check ID');
        const check = tx.prepare(`SELECT * FROM incident_effectiveness_checks
            WHERE id=? AND cycle_id=? AND incident_id=? AND passed=0`)
            .get(checkId, cycle.id, incident.id);
        const close = tx.prepare(`SELECT * FROM incident_cycle_decisions
            WHERE cycle_id=? AND decision='Closed'`).get(cycle.id);
        if (!close || !check || check.evaluated_at <= close.decided_at ||
            check.recurrence_count < 1 || check.evaluated_at >= at) {
            throw new Error('Later failed source-derived monitoring is required for reopen');
        }
        const defectId = stableId(input.recurrenceAoiDefectId, 'Recurrence AOI defect ID');
        const source = tx.prepare(`SELECT d.id,d.defect_count,a.inspected_at
            FROM aoi_defects d JOIN aoi_inspections a ON a.id=d.aoi_inspection_id
            JOIN process_runs r ON r.id=a.process_run_id
            WHERE d.id=? AND d.defect_code_id=? AND d.defect_count>0
                AND r.equipment_id=? AND r.module_id=?`)
            .get(defectId, incident.defect_code_id, incident.equipment_id, incident.module_id);
        if (!source || source.inspected_at <= close.decided_at ||
            source.inspected_at > check.evaluated_at) {
            throw new Error('Reopen needs a later linked same-code AOI recurrence');
        }
        const id = stableId(input.id, 'Reopen decision ID');
        const reason = required(input.reason, 'Reopen reason');
        assertStateTransition('incident', incident.state, 'Reopened', { newCycle: true });
        tx.prepare(`INSERT INTO incident_cycle_decisions(id,cycle_id,incident_id,
            decision,effectiveness_check_id,recurrence_aoi_defect_id,actor_id,
            reason,decided_at) VALUES (?,?,?,'Reopened',?,?,?,?,?)`)
            .run(id, cycle.id, incident.id, checkId, defectId, engineer.id, reason, at);
        const nextCycleNo = incident.cycle_no + 1;
        tx.prepare(`UPDATE incidents SET state='Reopened',cycle_no=?,updated_at=?
            WHERE id=? AND state='Closed' AND cycle_no=?`)
            .run(nextCycleNo, at, incident.id, incident.cycle_no);
        appendAuditEvent(tx, { actorId: engineer.id, recordedAt: at,
            entityType: 'incident', entityId: incident.id, entityRevisionId: revision.id,
            action: 'incident-reopened', priorState: 'Closed', newState: 'Reopened',
            reason, payload: { priorCycleId: cycle.id, reopenDecisionId: id,
                priorClosureId: close.id, failedCheckId: checkId,
                recurrenceAoiDefectId: defectId, nextCycleNo,
                operatingAcceptanceId: operatingAcceptance?.acceptanceId ?? null,
                authorityRevisionId: operatingAcceptance?.authorityRevisionId ?? null } });
        return { decisionId: id, priorCycleId: cycle.id, nextCycleNo,
            state: 'Reopened', recurrenceAoiDefectId: defectId };
    });
}
