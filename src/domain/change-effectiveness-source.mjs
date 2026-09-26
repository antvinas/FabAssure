import { createHash } from 'node:crypto';
import { assessEffectiveness } from './effectiveness.mjs';

export function projectSource(tx, { change, revisionId, acceptance, plan, at }) {
    const rows = tx.prepare(`SELECT r.id AS run_id,r.lot_id,r.start_at,r.end_at,
        r.processed_units,a.id AS aoi_id,a.inspected_at,a.inspected_units,
        a.rejected_units
        FROM process_runs r LEFT JOIN aoi_inspections a ON a.process_run_id=r.id
        WHERE r.equipment_id=? AND r.module_id=? AND r.recipe_revision_id=?
            AND r.start_at>? AND r.end_at<=?
        ORDER BY r.start_at,r.id`).all(change.equipment_id, change.module_id,
        change.recipe_revision_id, acceptance.accepted_at, at);
    const lotIds = new Set();
    const defectRows = tx.prepare(`SELECT d.id,d.defect_code_id,d.defect_count,c.severity
        FROM aoi_defects d JOIN defect_codes c ON c.id=d.defect_code_id
        WHERE d.aoi_inspection_id=? ORDER BY d.id`);
    const sampleRows = tx.prepare(`SELECT id,sample_size,sampled_at
        FROM inspection_samples WHERE process_run_id=? ORDER BY id`);
    const measurementRows = tx.prepare(`SELECT id,value,unit,recorded_at
        FROM measurements WHERE inspection_sample_id=? AND characteristic_id='CHAR-ALIGN-X'
        ORDER BY id`);
    const sourceLots = [];
    const assessmentLots = [];
    for (const row of rows) {
        if (lotIds.has(row.lot_id)) throw new Error('Each later lot needs one selected run');
        lotIds.add(row.lot_id);
        if (!row.aoi_id || row.inspected_at < row.start_at ||
            row.inspected_at >= row.end_at || row.inspected_at >= at ||
            row.inspected_units !== row.processed_units ||
            row.rejected_units > row.inspected_units) {
            throw new Error(`Complete same-run AOI is required: ${row.run_id}`);
        }
        const defects = defectRows.all(row.aoi_id);
        const measurements = [];
        const sampleSources = [];
        let sampledUnits = 0;
        for (const sample of sampleRows.all(row.run_id)) {
            const values = measurementRows.all(sample.id);
            if (values.length !== sample.sample_size ||
                sample.sampled_at < row.start_at || sample.sampled_at >= row.end_at) {
                throw new Error(`Complete later-lot measurement sample is required: ${sample.id}`);
            }
            sampledUnits += sample.sample_size;
            for (const value of values) {
                if (value.unit !== 'mm' || !Number.isFinite(value.value) ||
                    value.recorded_at < sample.sampled_at ||
                    value.recorded_at >= row.end_at) {
                    throw new Error(`Later-lot measurement source is invalid: ${value.id}`);
                }
                measurements.push({ id: value.id, absoluteOffsetMm: Math.abs(value.value) });
            }
            sampleSources.push({ id: sample.id, measurementIds: values.map(value => value.id) });
        }
        if (sampledUnits < plan.samples_per_lot) {
            throw new Error(`Approved later-lot sample count is missing: ${row.lot_id}`);
        }
        const targetedDefects = defects.filter(item => item.defect_code_id === 'DEF-ALIGN')
            .reduce((sum, item) => sum + item.defect_count, 0);
        const criticalDefects = defects.filter(item => item.severity === 'critical')
            .reduce((sum, item) => sum + item.defect_count, 0);
        const source = { lotId: row.lot_id, runId: row.run_id,
            startAt: row.start_at, endAt: row.end_at,
            processedUnits: row.processed_units, aoiId: row.aoi_id,
            inspectedAt: row.inspected_at, inspectedUnits: row.inspected_units,
            rejectedUnits: row.rejected_units, defects,
            samples: sampleSources, measurements };
        sourceLots.push(source);
        assessmentLots.push({ lotId: source.lotId, startAt: source.startAt,
            endAt: source.endAt, processedUnits: source.processedUnits,
            inspectedUnits: source.inspectedUnits, rejectedUnits: source.rejectedUnits,
            targetedDefects, criticalDefects, measurements });
    }
    const alarms = tx.prepare(`SELECT e.id FROM equipment_events e
        WHERE e.equipment_id=? AND e.module_id=? AND e.occurred_at>?
            AND e.occurred_at<? AND e.event_type IN ('alarm','failure')
            AND NOT EXISTS (SELECT 1 FROM equipment_event_resolutions link
                JOIN maintenance_actions m ON m.id=link.maintenance_action_id
                WHERE link.equipment_event_id=e.id AND m.end_at<=?
                    AND link.recorded_at<=?) ORDER BY e.occurred_at,e.id`)
        .all(change.equipment_id, change.module_id, acceptance.accepted_at,
            at, at, at).map(row => row.id);
    const deviations = tx.prepare(`SELECT id FROM deviations
        WHERE plan_id=? AND blocking=1 AND disposition<>'Closed'
            AND recorded_at<=?
        ORDER BY recorded_at,id`).all(plan.id, at).map(row => row.id);
    const source = { revisionId, acceptanceId: acceptance.id,
        windowStart: acceptance.accepted_at, windowEnd: at,
        lots: sourceLots, unresolvedAlarmIds: alarms,
        blockingDeviationIds: deviations };
    const sourceJson = JSON.stringify(source);
    const sourceDigest = createHash('sha256').update(sourceJson, 'utf8').digest('hex');
    const assessment = assessEffectiveness({ cycleType: 'change',
        finalLevel: plan.final_level, absoluteOffsetLimitMm: plan.alignment_abs_limit,
        afterAt: acceptance.accepted_at, targetedDefectCodeId: 'DEF-ALIGN',
        unresolvedRelatedAlarm: alarms.length > 0,
        unresolvedBlockingDeviation: deviations.length > 0,
        lots: assessmentLots });
    return { source, sourceDigest, assessment };
}
