-- An effectiveness decision may be inserted only after all completed runs in
-- its incident/window have their same-run AOI evidence. Source rows may still
-- be staged in the normal run-then-AOI order inside a transaction.
CREATE TRIGGER incident_effectiveness_aoi_coverage_guard
BEFORE INSERT ON incident_effectiveness_checks
WHEN EXISTS (
    SELECT 1 FROM process_runs r
    JOIN incidents i ON i.id=NEW.incident_id
    WHERE r.equipment_id=i.equipment_id AND r.module_id=i.module_id
        AND r.start_at>=NEW.window_start AND r.end_at<=NEW.window_end
        AND NOT EXISTS (
            SELECT 1 FROM aoi_inspections a
            WHERE a.process_run_id=r.id AND a.inspected_at>=r.start_at
                AND a.inspected_at<r.end_at AND a.inspected_at<NEW.window_end
                AND a.inspected_units=r.processed_units
        )
)
OR EXISTS (
    SELECT 1 FROM process_runs r
    JOIN aoi_inspections a ON a.process_run_id=r.id
    JOIN incidents i ON i.id=NEW.incident_id
    WHERE r.equipment_id=i.equipment_id AND r.module_id=i.module_id
        AND r.start_at>=NEW.window_start AND r.start_at<NEW.window_end
        AND r.end_at>NEW.window_end AND a.inspected_at<NEW.window_end
)
OR EXISTS (
    SELECT 1 FROM process_runs r
    JOIN incidents i ON i.id=NEW.incident_id
    WHERE r.equipment_id=i.equipment_id AND r.module_id=i.module_id
        AND r.start_at>=NEW.window_start AND r.end_at<=NEW.window_end
    GROUP BY r.lot_id HAVING COUNT(*)>1
)
BEGIN SELECT RAISE(ABORT,'effectiveness source requires complete unique AOI runs'); END;

-- A finalized source window is immutable even through direct source inserts.
CREATE TRIGGER process_run_after_effectiveness_guard
BEFORE INSERT ON process_runs
WHEN EXISTS (
    SELECT 1 FROM incident_effectiveness_checks c
    JOIN incidents i ON i.id=c.incident_id
    WHERE NEW.equipment_id=i.equipment_id AND NEW.module_id=i.module_id
        AND NEW.start_at>=c.window_start AND NEW.start_at<c.window_end
)
BEGIN SELECT RAISE(ABORT,'process run falls in finalized effectiveness window'); END;

CREATE TRIGGER aoi_after_effectiveness_guard
BEFORE INSERT ON aoi_inspections
WHEN EXISTS (
    SELECT 1 FROM process_runs r
    JOIN incidents i ON i.equipment_id=r.equipment_id AND i.module_id=r.module_id
    JOIN incident_effectiveness_checks c ON c.incident_id=i.id
    WHERE r.id=NEW.process_run_id AND r.start_at>=c.window_start
        AND r.start_at<c.window_end AND NEW.inspected_at<c.window_end
)
BEGIN SELECT RAISE(ABORT,'AOI falls in finalized effectiveness window'); END;
