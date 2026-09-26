-- FabAssure manufacturing source schema (SQLite).
-- Stable text IDs, required foreign keys, nonnegative counts, and
-- half-open intervals (start_at < end_at).

CREATE TABLE schema_migrations (
    id TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL UNIQUE CHECK (version >= 1),
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', applied_at) = applied_at, 0) AND substr(applied_at, 12, 2) BETWEEN '00' AND '23')
);

CREATE TABLE dataset_instances (
    id TEXT PRIMARY KEY NOT NULL,
    code TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    seed TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    slot INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (slot = 1),
    notes TEXT,
    UNIQUE (code, version),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', generated_at) = generated_at, 0) AND substr(generated_at, 12, 2) BETWEEN '00' AND '23')
);

CREATE TABLE lines (
    id TEXT PRIMARY KEY NOT NULL,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
);

CREATE TABLE equipment (
    id TEXT PRIMARY KEY NOT NULL,
    line_id TEXT NOT NULL REFERENCES lines (id),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE (line_id, code)
);

CREATE TABLE modules (
    id TEXT PRIMARY KEY NOT NULL,
    equipment_id TEXT NOT NULL REFERENCES equipment (id),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE (equipment_id, code),
    UNIQUE (id, equipment_id)
);

CREATE TABLE recipe_revisions (
    id TEXT PRIMARY KEY NOT NULL,
    recipe_code TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    effective_at TEXT NOT NULL,
    UNIQUE (recipe_code, revision),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', effective_at) = effective_at, 0) AND substr(effective_at, 12, 2) BETWEEN '00' AND '23')
);

CREATE TABLE product_families (
    id TEXT PRIMARY KEY NOT NULL,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
);

CREATE TABLE characteristics (
    id TEXT PRIMARY KEY NOT NULL,
    product_family_id TEXT NOT NULL REFERENCES product_families (id),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    unit TEXT NOT NULL CHECK (length(trim(unit)) > 0),
    UNIQUE (product_family_id, code)
);

CREATE TABLE defect_codes (
    id TEXT PRIMARY KEY NOT NULL,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    severity TEXT NOT NULL
);

CREATE TABLE lots (
    id TEXT PRIMARY KEY NOT NULL,
    product_family_id TEXT NOT NULL REFERENCES product_families (id),
    code TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    UNIQUE (product_family_id, code),
    UNIQUE (id, product_family_id),
    CHECK (start_at < end_at),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', start_at) = start_at, 0) AND substr(start_at, 12, 2) BETWEEN '00' AND '23'),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', end_at) = end_at, 0) AND substr(end_at, 12, 2) BETWEEN '00' AND '23')
);

CREATE TABLE process_runs (
    id TEXT PRIMARY KEY NOT NULL,
    lot_id TEXT NOT NULL REFERENCES lots (id),
    equipment_id TEXT NOT NULL REFERENCES equipment (id),
    module_id TEXT NOT NULL,
    recipe_revision_id TEXT NOT NULL REFERENCES recipe_revisions (id),
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    processed_units INTEGER NOT NULL CHECK (processed_units >= 0),
    UNIQUE (id, lot_id),
    FOREIGN KEY (module_id, equipment_id) REFERENCES modules (id, equipment_id),
    CHECK (start_at < end_at),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', start_at) = start_at, 0) AND substr(start_at, 12, 2) BETWEEN '00' AND '23'),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', end_at) = end_at, 0) AND substr(end_at, 12, 2) BETWEEN '00' AND '23')
);

CREATE TABLE inspection_samples (
    id TEXT PRIMARY KEY NOT NULL,
    lot_id TEXT NOT NULL REFERENCES lots (id),
    process_run_id TEXT NOT NULL,
    sampled_at TEXT NOT NULL,
    sample_size INTEGER NOT NULL CHECK (sample_size >= 0),
    FOREIGN KEY (process_run_id, lot_id) REFERENCES process_runs (id, lot_id),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', sampled_at) = sampled_at, 0) AND substr(sampled_at, 12, 2) BETWEEN '00' AND '23')
);

CREATE TABLE measurements (
    id TEXT PRIMARY KEY NOT NULL,
    inspection_sample_id TEXT NOT NULL REFERENCES inspection_samples (id),
    characteristic_id TEXT NOT NULL REFERENCES characteristics (id),
    value REAL NOT NULL,
    unit TEXT NOT NULL CHECK (length(trim(unit)) > 0),
    method TEXT NOT NULL CHECK (length(trim(method)) > 0),
    recorded_at TEXT NOT NULL,
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) = recorded_at, 0) AND substr(recorded_at, 12, 2) BETWEEN '00' AND '23')
);

CREATE TABLE aoi_inspections (
    id TEXT PRIMARY KEY NOT NULL,
    lot_id TEXT NOT NULL REFERENCES lots (id),
    process_run_id TEXT NOT NULL,
    inspected_at TEXT NOT NULL,
    inspected_units INTEGER NOT NULL CHECK (inspected_units >= 0),
    rejected_units INTEGER NOT NULL CHECK (rejected_units >= 0 AND rejected_units <= inspected_units),
    UNIQUE (process_run_id),
    FOREIGN KEY (process_run_id, lot_id) REFERENCES process_runs (id, lot_id),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', inspected_at) = inspected_at, 0) AND substr(inspected_at, 12, 2) BETWEEN '00' AND '23')
);

CREATE TABLE aoi_defects (
    id TEXT PRIMARY KEY NOT NULL,
    aoi_inspection_id TEXT NOT NULL REFERENCES aoi_inspections (id),
    defect_code_id TEXT NOT NULL REFERENCES defect_codes (id),
    defect_count INTEGER NOT NULL CHECK (defect_count >= 0),
    location TEXT
);

CREATE TABLE equipment_events (
    id TEXT PRIMARY KEY NOT NULL,
    equipment_id TEXT NOT NULL REFERENCES equipment (id),
    module_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL CHECK (duration_seconds >= 0),
    FOREIGN KEY (module_id, equipment_id) REFERENCES modules (id, equipment_id),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) = occurred_at, 0) AND substr(occurred_at, 12, 2) BETWEEN '00' AND '23')
);

CREATE TABLE maintenance_actions (
    id TEXT PRIMARY KEY NOT NULL,
    equipment_id TEXT NOT NULL REFERENCES equipment (id),
    module_id TEXT NOT NULL,
    code TEXT NOT NULL,
    summary TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    FOREIGN KEY (module_id, equipment_id) REFERENCES modules (id, equipment_id),
    CHECK (start_at < end_at),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', start_at) = start_at, 0) AND substr(start_at, 12, 2) BETWEEN '00' AND '23'),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', end_at) = end_at, 0) AND substr(end_at, 12, 2) BETWEEN '00' AND '23')
);

-- One database file belongs to one synthetic dataset instance. A reset creates
-- a fresh database with a new instance ID; no source row may exist without it.
CREATE TRIGGER require_dataset_for_lines BEFORE INSERT ON lines
WHEN (SELECT COUNT(*) FROM dataset_instances) <> 1
BEGIN SELECT RAISE(ABORT, 'dataset instance required'); END;
CREATE TRIGGER require_dataset_for_families BEFORE INSERT ON product_families
WHEN (SELECT COUNT(*) FROM dataset_instances) <> 1
BEGIN SELECT RAISE(ABORT, 'dataset instance required'); END;
CREATE TRIGGER require_dataset_for_recipes BEFORE INSERT ON recipe_revisions
WHEN (SELECT COUNT(*) FROM dataset_instances) <> 1
BEGIN SELECT RAISE(ABORT, 'dataset instance required'); END;
CREATE TRIGGER require_dataset_for_defects BEFORE INSERT ON defect_codes
WHEN (SELECT COUNT(*) FROM dataset_instances) <> 1
BEGIN SELECT RAISE(ABORT, 'dataset instance required'); END;

CREATE TRIGGER process_run_context BEFORE INSERT ON process_runs
WHEN NEW.start_at < (SELECT start_at FROM lots WHERE id = NEW.lot_id)
    OR NEW.end_at > (SELECT end_at FROM lots WHERE id = NEW.lot_id)
    OR NEW.start_at < (SELECT effective_at FROM recipe_revisions WHERE id = NEW.recipe_revision_id)
BEGIN SELECT RAISE(ABORT, 'run outside lot or recipe interval'); END;

CREATE TRIGGER sample_context BEFORE INSERT ON inspection_samples
WHEN NEW.sampled_at < (SELECT start_at FROM process_runs WHERE id = NEW.process_run_id)
    OR NEW.sampled_at >= (SELECT end_at FROM process_runs WHERE id = NEW.process_run_id)
BEGIN SELECT RAISE(ABORT, 'sample outside process run'); END;

CREATE TRIGGER measurement_context BEFORE INSERT ON measurements
WHEN (SELECT c.product_family_id FROM characteristics c WHERE c.id = NEW.characteristic_id)
    <> (SELECT l.product_family_id FROM inspection_samples s
        JOIN lots l ON l.id = s.lot_id WHERE s.id = NEW.inspection_sample_id)
BEGIN SELECT RAISE(ABORT, 'measurement characteristic family mismatch'); END;

CREATE TRIGGER aoi_context BEFORE INSERT ON aoi_inspections
WHEN NEW.inspected_at < (SELECT start_at FROM process_runs WHERE id = NEW.process_run_id)
    OR NEW.inspected_at >= (SELECT end_at FROM process_runs WHERE id = NEW.process_run_id)
    OR NEW.inspected_units <> (SELECT processed_units FROM process_runs WHERE id = NEW.process_run_id)
BEGIN SELECT RAISE(ABORT, 'AOI inspection outside or incomplete for process run'); END;

-- Source records are append-only. Corrections and later decisions must create
-- new rows/revisions instead of editing or deleting an original observation.
CREATE TRIGGER immutable_dataset_update BEFORE UPDATE ON dataset_instances BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_dataset_delete BEFORE DELETE ON dataset_instances BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_recipe_update BEFORE UPDATE ON recipe_revisions BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_recipe_delete BEFORE DELETE ON recipe_revisions BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_lot_update BEFORE UPDATE ON lots BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_lot_delete BEFORE DELETE ON lots BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_run_update BEFORE UPDATE ON process_runs BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_run_delete BEFORE DELETE ON process_runs BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_sample_update BEFORE UPDATE ON inspection_samples BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_sample_delete BEFORE DELETE ON inspection_samples BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_measurement_update BEFORE UPDATE ON measurements BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_measurement_delete BEFORE DELETE ON measurements BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_aoi_update BEFORE UPDATE ON aoi_inspections BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_aoi_delete BEFORE DELETE ON aoi_inspections BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_aoi_defect_update BEFORE UPDATE ON aoi_defects BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_aoi_defect_delete BEFORE DELETE ON aoi_defects BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_event_update BEFORE UPDATE ON equipment_events BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_event_delete BEFORE DELETE ON equipment_events BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_maintenance_update BEFORE UPDATE ON maintenance_actions BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_maintenance_delete BEFORE DELETE ON maintenance_actions BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_line_update BEFORE UPDATE ON lines BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_line_delete BEFORE DELETE ON lines BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_equipment_update BEFORE UPDATE ON equipment BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_equipment_delete BEFORE DELETE ON equipment BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_module_update BEFORE UPDATE ON modules BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_module_delete BEFORE DELETE ON modules BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_family_update BEFORE UPDATE ON product_families BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_family_delete BEFORE DELETE ON product_families BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_characteristic_update BEFORE UPDATE ON characteristics BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_characteristic_delete BEFORE DELETE ON characteristics BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_defect_code_update BEFORE UPDATE ON defect_codes BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_defect_code_delete BEFORE DELETE ON defect_codes BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_migration_update BEFORE UPDATE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'immutable source'); END;
CREATE TRIGGER immutable_migration_delete BEFORE DELETE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'immutable source'); END;

-- Each rejected unit receives one primary synthetic AOI defect code. The view
-- exposes incomplete staged transactions; the bootstrap/domain layer must
-- reject nonempty results before committing seeded or accepted evidence.
CREATE VIEW aoi_integrity_gaps AS
SELECT 'process_run' AS entity_type, r.id AS entity_id, 'missing-aoi' AS issue
FROM process_runs r LEFT JOIN aoi_inspections a ON a.process_run_id = r.id
WHERE a.id IS NULL
UNION ALL
SELECT 'aoi_inspection', a.id, 'reject-count-mismatch'
FROM aoi_inspections a LEFT JOIN aoi_defects d ON d.aoi_inspection_id = a.id
GROUP BY a.id
HAVING COALESCE(SUM(d.defect_count), 0) <> a.rejected_units;
