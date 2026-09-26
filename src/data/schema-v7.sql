-- Additive Change effectiveness source-freeze guards. Historical v2-v6 rows
-- and their audit lineage are not rewritten by this migration.

CREATE TRIGGER change_run_after_effectiveness_guard
BEFORE INSERT ON process_runs
WHEN EXISTS (
    SELECT 1 FROM effectiveness_checks c
    JOIN change_revisions v ON v.id=c.change_revision_id
    JOIN changes h ON h.id=v.change_id
    WHERE h.equipment_id=NEW.equipment_id AND h.module_id=NEW.module_id
        AND h.recipe_revision_id=NEW.recipe_revision_id
        AND NEW.start_at>c.window_start AND NEW.end_at<=c.window_end)
BEGIN SELECT RAISE(ABORT,'backdated Change run would change saved Change effectiveness'); END;

CREATE TRIGGER change_aoi_after_effectiveness_guard
BEFORE INSERT ON aoi_inspections
WHEN EXISTS (
    SELECT 1 FROM process_runs r
    JOIN changes h ON h.equipment_id=r.equipment_id
        AND h.module_id=r.module_id AND h.recipe_revision_id=r.recipe_revision_id
    JOIN change_revisions v ON v.change_id=h.id
    JOIN effectiveness_checks c ON c.change_revision_id=v.id
    WHERE r.id=NEW.process_run_id AND r.start_at>c.window_start
        AND r.end_at<=c.window_end)
BEGIN SELECT RAISE(ABORT,'backdated Change AOI would change saved Change effectiveness'); END;

CREATE TRIGGER change_aoi_defect_after_effectiveness_guard
BEFORE INSERT ON aoi_defects
WHEN EXISTS (
    SELECT 1 FROM aoi_inspections a
    JOIN process_runs r ON r.id=a.process_run_id
    JOIN changes h ON h.equipment_id=r.equipment_id
        AND h.module_id=r.module_id AND h.recipe_revision_id=r.recipe_revision_id
    JOIN change_revisions v ON v.change_id=h.id
    JOIN effectiveness_checks c ON c.change_revision_id=v.id
    WHERE a.id=NEW.aoi_inspection_id AND r.start_at>c.window_start
        AND r.end_at<=c.window_end AND a.inspected_at<c.window_end)
BEGIN SELECT RAISE(ABORT,'backdated Change AOI defect would change saved Change effectiveness'); END;

CREATE TRIGGER change_sample_after_effectiveness_guard
BEFORE INSERT ON inspection_samples
WHEN EXISTS (
    SELECT 1 FROM process_runs r
    JOIN changes h ON h.equipment_id=r.equipment_id
        AND h.module_id=r.module_id AND h.recipe_revision_id=r.recipe_revision_id
    JOIN change_revisions v ON v.change_id=h.id
    JOIN effectiveness_checks c ON c.change_revision_id=v.id
    WHERE r.id=NEW.process_run_id AND r.start_at>c.window_start
        AND r.end_at<=c.window_end)
BEGIN SELECT RAISE(ABORT,'backdated Change sample would change saved Change effectiveness'); END;

CREATE TRIGGER change_measurement_after_effectiveness_guard
BEFORE INSERT ON measurements
WHEN EXISTS (
    SELECT 1 FROM inspection_samples s
    JOIN process_runs r ON r.id=s.process_run_id
    JOIN changes h ON h.equipment_id=r.equipment_id
        AND h.module_id=r.module_id AND h.recipe_revision_id=r.recipe_revision_id
    JOIN change_revisions v ON v.change_id=h.id
    JOIN effectiveness_checks c ON c.change_revision_id=v.id
    WHERE s.id=NEW.inspection_sample_id AND NEW.characteristic_id='CHAR-ALIGN-X'
        AND r.start_at>c.window_start AND r.end_at<=c.window_end)
BEGIN SELECT RAISE(ABORT,'backdated Change measurement would change saved Change effectiveness'); END;

CREATE TRIGGER change_alarm_after_effectiveness_guard
BEFORE INSERT ON equipment_events
WHEN NEW.event_type IN ('alarm','failure') AND EXISTS (
    SELECT 1 FROM effectiveness_checks c
    JOIN change_revisions v ON v.id=c.change_revision_id
    JOIN changes h ON h.id=v.change_id
    WHERE h.equipment_id=NEW.equipment_id AND h.module_id=NEW.module_id
        AND NEW.occurred_at>c.window_start AND NEW.occurred_at<c.window_end)
BEGIN SELECT RAISE(ABORT,'backdated Change alarm would change saved Change effectiveness'); END;

CREATE TRIGGER change_resolution_after_effectiveness_guard
BEFORE INSERT ON equipment_event_resolutions
WHEN EXISTS (
    SELECT 1 FROM equipment_events e
    JOIN changes h ON h.equipment_id=e.equipment_id AND h.module_id=e.module_id
    JOIN change_revisions v ON v.change_id=h.id
    JOIN effectiveness_checks c ON c.change_revision_id=v.id
    JOIN maintenance_actions m ON m.id=NEW.maintenance_action_id
    WHERE e.id=NEW.equipment_event_id AND e.event_type IN ('alarm','failure')
        AND e.occurred_at>c.window_start AND e.occurred_at<c.window_end
        AND m.end_at<=c.window_end AND NEW.recorded_at<=c.window_end)
BEGIN SELECT RAISE(ABORT,'backdated Change resolution would change saved Change effectiveness'); END;

CREATE TRIGGER change_deviation_after_effectiveness_guard
BEFORE INSERT ON deviations
WHEN NEW.blocking=1 AND NEW.disposition<>'Closed' AND EXISTS (
    SELECT 1 FROM effectiveness_checks c
    JOIN verification_plans p ON p.change_revision_id=c.change_revision_id
    WHERE p.id=NEW.plan_id AND NEW.recorded_at<=c.window_end)
BEGIN SELECT RAISE(ABORT,'backdated Change deviation would change saved Change effectiveness'); END;
