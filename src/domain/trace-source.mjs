// Build a trace input from immutable synthetic SQLite source rows.
// The same query is used when a proposal is written and when its integrity is checked.
export function buildSourceTraceQuery(db, context) {
    if (!context || typeof context !== 'object') throw new TypeError('Source trace context is required');
    const { equipmentId, moduleId, recipeRevisionId, defectCodeId, cutoffAt } = context;
    const earliestLkgAt = context.earliestLkgAt ?? null;
    const latestLkgAt = context.latestLkgAt ?? null;
    if ((earliestLkgAt === null) !== (latestLkgAt === null)) {
        throw new TypeError('Both LKG bounds are required together');
    }
    const matching = db.prepare(`SELECT id,lot_id AS lotId,start_at AS startAt,end_at AS endAt
        FROM process_runs WHERE equipment_id=? AND module_id=? AND recipe_revision_id=?
        ORDER BY start_at,id`).all(equipmentId, moduleId, recipeRevisionId);
    const earliestTraceAt = earliestLkgAt === null ?
        matching.find(run => run.startAt < cutoffAt)?.startAt ?? null : null;
    if (earliestLkgAt === null && !earliestTraceAt) {
        throw new Error('Unknown LKG has no source trace boundary');
    }
    const startAt = earliestLkgAt ?? earliestTraceAt;
    const overlapping = matching.filter(run => run.endAt > startAt && run.startAt < cutoffAt);
    if (overlapping.length === 0) throw new Error('No source runs overlap the exposure window');
    const selectedLots = new Set(overlapping.map(run => run.lotId));
    const preceding = matching.filter(run => run.endAt <= startAt).at(-1);
    const following = matching.find(run => run.startAt >= cutoffAt);
    if (preceding) selectedLots.add(preceding.lotId);
    if (following) selectedLots.add(following.lotId);
    const rows = db.prepare(`SELECT id,lot_id AS lotId,equipment_id AS equipmentId,
        module_id AS moduleId,recipe_revision_id AS recipeRevisionId,
        start_at AS startAt,end_at AS endAt FROM process_runs ORDER BY start_at,id`).all()
        .filter(row => selectedLots.has(row.lotId));
    const defectRows = db.prepare(`SELECT d.id AS sourceId,d.defect_code_id AS defectCodeId,
        a.inspected_at AS observedAt,d.defect_count AS count FROM aoi_defects d
        JOIN aoi_inspections a ON a.id=d.aoi_inspection_id
        WHERE a.process_run_id=? AND d.defect_code_id=? ORDER BY d.id`);
    const runs = rows.map(row => ({ ...row, defects: defectRows.all(row.id, defectCodeId) }));
    return { equipmentId, moduleId, recipeRevisionId, defectCodeId,
        earliestLkgAt, latestLkgAt, earliestTraceAt, cutoffAt, runs };
}
