// Fixed, synthetic observation window used by the demonstration seed.
const START_AT = '2026-08-01T00:00:00.000Z';
const END_AT = '2026-09-10T00:00:00.000Z';
const HOURS = (Date.parse(END_AT) - Date.parse(START_AT)) / 3_600_000;

export function getEquipmentRegister(db) {
    const equipment = db.prepare(`SELECT e.id,e.line_id AS lineId,e.code,e.name,
        l.name AS lineName FROM equipment e JOIN lines l ON l.id=e.line_id
        ORDER BY e.line_id,e.id`).all();
    const modules = db.prepare(`SELECT id,equipment_id AS equipmentId,code,name
        FROM modules ORDER BY equipment_id,id`).all();
    return equipment.map(item => ({ ...item,
        modules: modules.filter(module => module.equipmentId === item.id) }));
}

export function getEquipmentTimeline(db, equipmentId) {
    if (typeof equipmentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(equipmentId)) {
        throw new TypeError('A valid synthetic equipment ID is required');
    }
    const equipment = getEquipmentRegister(db).find(item => item.id === equipmentId);
    if (!equipment) return null;
    const events = db.prepare(`SELECT id,module_id AS moduleId,event_type AS eventType,
        occurred_at AS at,duration_seconds AS durationSeconds
        FROM equipment_events WHERE equipment_id=? AND occurred_at>=? AND occurred_at<?
        ORDER BY occurred_at,id`).all(equipmentId, START_AT, END_AT);
    const maintenance = db.prepare(`SELECT id,module_id AS moduleId,code,summary,
        start_at AS startAt,end_at AS endAt FROM maintenance_actions
        WHERE equipment_id=? AND start_at<? AND end_at>? ORDER BY start_at,id`)
        .all(equipmentId, END_AT, START_AT);
    const boundaryRepairs = maintenance.filter(action => action.code === 'REPAIR' &&
        (action.startAt < START_AT || action.endAt > END_AT));
    const failures = events.filter(event => event.eventType === 'failure');
    let downtimeSeconds = 0;
    const repairActionIds = [];
    const matchedRepairs = new Set();
    for (const failure of failures) {
        const matches = maintenance.filter(action => action.code === 'REPAIR' &&
            action.moduleId === failure.moduleId && action.startAt === failure.at);
        const duration = matches.length === 1 ?
            (Date.parse(matches[0].endAt) - Date.parse(matches[0].startAt)) / 1000 : NaN;
        if (matches.length !== 1 || duration !== failure.durationSeconds ||
            matchedRepairs.has(matches[0].id)) {
            throw new Error(`Unreconciled failure and repair: ${failure.id}`);
        }
        downtimeSeconds += duration;
        repairActionIds.push(matches[0].id);
        matchedRepairs.add(matches[0].id);
    }
    for (const repair of maintenance.filter(action => action.code === 'REPAIR' &&
        action.startAt >= START_AT && action.endAt <= END_AT)) {
        if (!matchedRepairs.has(repair.id)) {
            throw new Error(`Unreconciled repair: ${repair.id}`);
        }
    }
    const processRunCount = db.prepare(`SELECT COUNT(*) AS count FROM process_runs
        WHERE equipment_id=? AND start_at>=? AND start_at<?`)
        .get(equipmentId, START_AT, END_AT).count;
    const recentRuns = db.prepare(`SELECT id,lot_id AS lotId,module_id AS moduleId,
        recipe_revision_id AS recipeRevisionId,start_at AS startAt,end_at AS endAt,
        processed_units AS processedUnits FROM process_runs
        WHERE equipment_id=? AND start_at>=? AND start_at<?
        ORDER BY start_at DESC,id DESC LIMIT 8`).all(equipmentId, START_AT, END_AT);
    const aoiInspections = db.prepare(`SELECT a.id,a.lot_id AS lotId,
        a.process_run_id AS processRunId,a.inspected_at AS inspectedAt,
        a.inspected_units AS inspectedUnits,a.rejected_units AS rejectedUnits,
        r.module_id AS moduleId,r.recipe_revision_id AS recipeRevisionId
        FROM aoi_inspections a JOIN process_runs r ON r.id=a.process_run_id
        WHERE r.equipment_id=? AND r.start_at>=? AND r.start_at<?
            AND a.inspected_at>=? AND a.inspected_at<?
        ORDER BY a.inspected_at,a.id`).all(equipmentId, START_AT, END_AT, START_AT, END_AT)
        .map(row => ({ ...row, defects: db.prepare(`SELECT id,
            defect_code_id AS defectCodeId,defect_count AS defectCount
            FROM aoi_defects WHERE aoi_inspection_id=? ORDER BY id`).all(row.id) }));
    const aoi = aoiInspections.reduce((total, row) => ({
        inspectedUnits: total.inspectedUnits + row.inspectedUnits,
        rejectedUnits: total.rejectedUnits + row.rejectedUnits,
        inspectionCount: total.inspectionCount + 1
    }), { inspectedUnits: 0, rejectedUnits: 0, inspectionCount: 0 });
    const aoiSignals = aoiInspections.filter(row => row.rejectedUnits > 0).map(row => ({
        id: row.id, moduleId: row.moduleId, at: row.inspectedAt,
        eventType: 'aoi-reject', kind: 'aoi-defect-signal',
        summary: `${row.rejectedUnits}/${row.inspectedUnits} rejected; ${row.defects.map(item =>
            `${item.defectCodeId}:${item.defectCount}`).join(', ') || 'defect code not recorded'}`
    }));
    const timeline = [
        ...events.map(event => ({ ...event, kind: 'equipment-event' })),
        ...maintenance.map(action => ({ ...action, at: action.startAt,
            kind: 'maintenance-action' })),
        ...aoiSignals
    ].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    const downtimeHours = downtimeSeconds / 3600;
    const incompleteWindow = boundaryRepairs.length > 0;
    return { synthetic: true, equipment, observationWindow: {
        startAt: START_AT, endExclusiveAt: END_AT, hours: HOURS
    }, reliability: {
        failureCount: failures.length,
        downtimeHours: incompleteWindow ? null : downtimeHours,
        mttrHours: incompleteWindow || !failures.length ? null : downtimeHours / failures.length,
        mtbfHours: incompleteWindow || !failures.length ? null : (HOURS - downtimeHours) / failures.length,
        notCalculatedReason: incompleteWindow ?
            'A repair overlaps the observation boundary; complete-window reliability is unavailable' : null,
        boundaryRepairActionIds: boundaryRepairs.map(item => item.id),
        failureEventIds: failures.map(item => item.id), repairActionIds
    }, timeline, processRunCount, recentRuns, aoi, aoiInspections,
    aoiCohort: 'AOI inspections timestamped inside the half-open observation window and linked to process runs starting inside it' };
}
