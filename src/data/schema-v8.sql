-- Bind saved Change effectiveness windows to each revision's immutable
-- creation/revision audit recipe, even after the mutable Change header advances.
-- MIG-008 upgrades v7 guards without rewriting any source, check, or audit row.

CREATE VIEW change_revision_frozen_scope AS
SELECT e.entity_revision_id AS change_revision_id,
    json_extract(e.payload_json,'$.recipeRevisionId') AS recipe_revision_id
FROM audit_events e
WHERE e.entity_type='change'
    AND e.action IN ('change-created','change-revised-after-failure',
        'change-revised-after-expiry',
        'change-revised-after-effectiveness-failure');

DROP TRIGGER change_run_after_effectiveness_guard;
CREATE TRIGGER change_run_after_effectiveness_guard
BEFORE INSERT ON process_runs
WHEN EXISTS (
    SELECT 1 FROM effectiveness_checks c
    JOIN change_revisions v ON v.id=c.change_revision_id
    JOIN changes h ON h.id=v.change_id
    JOIN change_revision_frozen_scope s ON s.change_revision_id=v.id
    WHERE h.equipment_id=NEW.equipment_id AND h.module_id=NEW.module_id
        AND s.recipe_revision_id=NEW.recipe_revision_id
        AND NEW.start_at>c.window_start AND NEW.end_at<=c.window_end)
BEGIN SELECT RAISE(ABORT,'backdated Change run would change saved Change effectiveness'); END;

DROP TRIGGER change_aoi_after_effectiveness_guard;
CREATE TRIGGER change_aoi_after_effectiveness_guard
BEFORE INSERT ON aoi_inspections
WHEN EXISTS (
    SELECT 1 FROM process_runs r
    JOIN changes h ON h.equipment_id=r.equipment_id AND h.module_id=r.module_id
    JOIN change_revisions v ON v.change_id=h.id
    JOIN change_revision_frozen_scope s ON s.change_revision_id=v.id
        AND s.recipe_revision_id=r.recipe_revision_id
    JOIN effectiveness_checks c ON c.change_revision_id=v.id
    WHERE r.id=NEW.process_run_id AND r.start_at>c.window_start
        AND r.end_at<=c.window_end)
BEGIN SELECT RAISE(ABORT,'backdated Change AOI would change saved Change effectiveness'); END;

DROP TRIGGER change_aoi_defect_after_effectiveness_guard;
CREATE TRIGGER change_aoi_defect_after_effectiveness_guard
BEFORE INSERT ON aoi_defects
WHEN EXISTS (
    SELECT 1 FROM aoi_inspections a
    JOIN process_runs r ON r.id=a.process_run_id
    JOIN changes h ON h.equipment_id=r.equipment_id AND h.module_id=r.module_id
    JOIN change_revisions v ON v.change_id=h.id
    JOIN change_revision_frozen_scope s ON s.change_revision_id=v.id
        AND s.recipe_revision_id=r.recipe_revision_id
    JOIN effectiveness_checks c ON c.change_revision_id=v.id
    WHERE a.id=NEW.aoi_inspection_id AND r.start_at>c.window_start
        AND r.end_at<=c.window_end AND a.inspected_at<c.window_end)
BEGIN SELECT RAISE(ABORT,'backdated Change AOI defect would change saved Change effectiveness'); END;

DROP TRIGGER change_sample_after_effectiveness_guard;
CREATE TRIGGER change_sample_after_effectiveness_guard
BEFORE INSERT ON inspection_samples
WHEN EXISTS (
    SELECT 1 FROM process_runs r
    JOIN changes h ON h.equipment_id=r.equipment_id AND h.module_id=r.module_id
    JOIN change_revisions v ON v.change_id=h.id
    JOIN change_revision_frozen_scope s ON s.change_revision_id=v.id
        AND s.recipe_revision_id=r.recipe_revision_id
    JOIN effectiveness_checks c ON c.change_revision_id=v.id
    WHERE r.id=NEW.process_run_id AND r.start_at>c.window_start
        AND r.end_at<=c.window_end)
BEGIN SELECT RAISE(ABORT,'backdated Change sample would change saved Change effectiveness'); END;

DROP TRIGGER change_measurement_after_effectiveness_guard;
CREATE TRIGGER change_measurement_after_effectiveness_guard
BEFORE INSERT ON measurements
WHEN EXISTS (
    SELECT 1 FROM inspection_samples sample
    JOIN process_runs r ON r.id=sample.process_run_id
    JOIN changes h ON h.equipment_id=r.equipment_id AND h.module_id=r.module_id
    JOIN change_revisions v ON v.change_id=h.id
    JOIN change_revision_frozen_scope s ON s.change_revision_id=v.id
        AND s.recipe_revision_id=r.recipe_revision_id
    JOIN effectiveness_checks c ON c.change_revision_id=v.id
    WHERE sample.id=NEW.inspection_sample_id AND NEW.characteristic_id='CHAR-ALIGN-X'
        AND r.start_at>c.window_start AND r.end_at<=c.window_end)
BEGIN SELECT RAISE(ABORT,'backdated Change measurement would change saved Change effectiveness'); END;
