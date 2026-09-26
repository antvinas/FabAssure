-- Conditional Change Acceptance and a distinct server-clock audit principal.
-- Earlier audit rows and digests are copied byte-for-byte; only new system
-- events use the extended digest envelope in the domain audit module.
CREATE TABLE system_principals (
    id TEXT PRIMARY KEY NOT NULL,
    description TEXT NOT NULL CHECK (length(trim(description))>0)
);
INSERT INTO system_principals(id,description)
VALUES ('SYS-SERVER-CLOCK','Local server UTC clock reconciliation');
CREATE TRIGGER immutable_system_principal_update BEFORE UPDATE ON system_principals
BEGIN SELECT RAISE(ABORT,'immutable system principal'); END;
CREATE TRIGGER immutable_system_principal_delete BEFORE DELETE ON system_principals
BEGIN SELECT RAISE(ABORT,'immutable system principal'); END;

CREATE TABLE audit_events_v6 (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    dataset_instance_id TEXT NOT NULL REFERENCES dataset_instances(id),
    recorded_at TEXT NOT NULL,
    actor_id TEXT REFERENCES demo_actors(id),
    simulated_role TEXT NOT NULL,
    system_principal_id TEXT REFERENCES system_principals(id),
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    entity_revision_id TEXT,
    action TEXT NOT NULL,
    prior_state TEXT,
    new_state TEXT,
    reason TEXT,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256)=64),
    previous_digest TEXT CHECK (previous_digest IS NULL OR length(previous_digest)=64),
    digest TEXT NOT NULL CHECK (length(digest)=64),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at,0)),
    CHECK ((actor_id IS NOT NULL AND system_principal_id IS NULL AND simulated_role<>'System')
        OR (actor_id IS NULL AND system_principal_id IS NOT NULL AND simulated_role='System')),
    UNIQUE(dataset_instance_id,digest)
);
INSERT INTO audit_events_v6(sequence,id,dataset_instance_id,recorded_at,actor_id,
    simulated_role,system_principal_id,entity_type,entity_id,entity_revision_id,
    action,prior_state,new_state,reason,payload_json,payload_sha256,previous_digest,digest)
SELECT sequence,id,dataset_instance_id,recorded_at,actor_id,simulated_role,NULL,
    entity_type,entity_id,entity_revision_id,action,prior_state,new_state,reason,
    payload_json,payload_sha256,previous_digest,digest FROM audit_events ORDER BY sequence;
-- db.mjs saves and restores these exact historical trigger definitions around
-- the audit-table replacement, preserving v2 SQL and manifest identity.
DROP TRIGGER acceptance_review_audit_guard;
DROP TRIGGER acceptance_actor_guard;
DROP TABLE audit_events;
ALTER TABLE audit_events_v6 RENAME TO audit_events;
CREATE TRIGGER audit_append_guard BEFORE INSERT ON audit_events
WHEN (NEW.system_principal_id IS NULL AND
        NEW.simulated_role IS NOT (SELECT role FROM demo_actors WHERE id=NEW.actor_id))
    OR (NEW.system_principal_id IS NOT NULL AND
        (NEW.simulated_role<>'System' OR NOT EXISTS (
            SELECT 1 FROM system_principals WHERE id=NEW.system_principal_id)))
    OR NEW.previous_digest IS NOT (
        SELECT digest FROM audit_events
        WHERE dataset_instance_id=NEW.dataset_instance_id
        ORDER BY sequence DESC LIMIT 1)
BEGIN SELECT RAISE(ABORT,'audit principal or previous digest mismatch'); END;
CREATE TRIGGER immutable_audit_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT,'immutable audit event'); END;
CREATE TRIGGER immutable_audit_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT,'immutable audit event'); END;

-- NULL is reserved for historical rows that did not record acceptance type.
-- New decisions must explicitly choose Ordinary or Conditional.
ALTER TABLE acceptances ADD COLUMN acceptance_type TEXT
    CHECK (acceptance_type IN ('Ordinary','Conditional'));
ALTER TABLE acceptances ADD COLUMN condition_text TEXT;
ALTER TABLE acceptances ADD COLUMN expires_at TEXT;
CREATE TRIGGER acceptance_condition_guard BEFORE INSERT ON acceptances
WHEN NEW.acceptance_type IS NULL
    OR (NEW.acceptance_type='Ordinary' AND
        (NEW.condition_text IS NOT NULL OR NEW.expires_at IS NOT NULL))
    OR (NEW.acceptance_type='Conditional' AND (
        NEW.condition_text IS NULL OR length(trim(NEW.condition_text))=0
        OR NEW.expires_at IS NULL
        OR COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',NEW.expires_at)=NEW.expires_at,0)=0
        OR substr(NEW.expires_at,12,2) NOT BETWEEN '00' AND '23'
        OR NEW.expires_at<=NEW.accepted_at))
BEGIN SELECT RAISE(ABORT,'conditional acceptance requires exact condition and later UTC expiry'); END;

-- Historical acceptance type is unknown. Classification is a new decision;
-- it never rewrites the earlier acceptance or its audit event.
CREATE TABLE legacy_acceptance_classifications (
    id TEXT PRIMARY KEY NOT NULL,
    acceptance_id TEXT NOT NULL UNIQUE REFERENCES acceptances(id),
    classification_type TEXT NOT NULL CHECK (classification_type IN ('Ordinary','Conditional')),
    condition_text TEXT,
    expires_at TEXT,
    classified_by TEXT NOT NULL REFERENCES demo_actors(id),
    classified_at TEXT NOT NULL,
    audit_event_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',classified_at)=classified_at,0)),
    CHECK ((classification_type='Ordinary' AND condition_text IS NULL AND expires_at IS NULL)
        OR (classification_type='Conditional' AND condition_text IS NOT NULL
            AND length(trim(condition_text))>0 AND expires_at IS NOT NULL
            AND COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at,0)
            AND substr(expires_at,12,2) BETWEEN '00' AND '23'
            AND expires_at>classified_at))
);
CREATE TRIGGER legacy_classification_source_guard
BEFORE INSERT ON legacy_acceptance_classifications
WHEN NOT EXISTS (
        SELECT 1 FROM acceptances a WHERE a.id=NEW.acceptance_id
            AND a.acceptance_type IS NULL)
    OR (SELECT role FROM demo_actors WHERE id=NEW.classified_by) IS NOT 'Approver'
    OR NOT EXISTS (
        SELECT 1 FROM audit_events e JOIN acceptances a
            ON a.id=NEW.acceptance_id
        JOIN change_revisions r ON r.id=a.change_revision_id
        WHERE e.id=NEW.audit_event_id AND e.entity_type='change'
            AND e.entity_id=r.change_id AND e.entity_revision_id=r.id
            AND e.action='legacy-acceptance-classified'
            AND e.actor_id=NEW.classified_by AND e.recorded_at=NEW.classified_at
            AND json_extract(e.payload_json,'$.acceptanceId')=NEW.acceptance_id
            AND json_extract(e.payload_json,'$.classificationType')=NEW.classification_type
            AND json_extract(e.payload_json,'$.condition') IS NEW.condition_text
            AND json_extract(e.payload_json,'$.expiresAt') IS NEW.expires_at)
BEGIN SELECT RAISE(ABORT,'legacy classification source or audit mismatch'); END;
CREATE TRIGGER immutable_legacy_classification_update
BEFORE UPDATE ON legacy_acceptance_classifications
BEGIN SELECT RAISE(ABORT,'immutable legacy classification'); END;
CREATE TRIGGER immutable_legacy_classification_delete
BEFORE DELETE ON legacy_acceptance_classifications
BEGIN SELECT RAISE(ABORT,'immutable legacy classification'); END;

CREATE TABLE conditional_acceptance_expiries (
    id TEXT PRIMARY KEY NOT NULL,
    acceptance_id TEXT NOT NULL UNIQUE REFERENCES acceptances(id),
    change_revision_id TEXT NOT NULL REFERENCES change_revisions(id),
    effective_at TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    prior_state TEXT NOT NULL CHECK (prior_state IN
        ('Accepted','Effectiveness Monitoring','Closed')),
    new_state TEXT NOT NULL DEFAULT 'Reopened' CHECK (new_state='Reopened'),
    prior_cycle_no INTEGER NOT NULL CHECK (prior_cycle_no>=1),
    new_cycle_no INTEGER NOT NULL CHECK (new_cycle_no=prior_cycle_no+1),
    audit_event_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id),
    CHECK (effective_at<=observed_at),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',effective_at)=effective_at,0)),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',observed_at)=observed_at,0))
);
CREATE TRIGGER conditional_expiry_source_guard
BEFORE INSERT ON conditional_acceptance_expiries
WHEN NOT EXISTS (
        SELECT 1 FROM acceptances a WHERE a.id=NEW.acceptance_id
            AND a.change_revision_id=NEW.change_revision_id
            AND ((a.acceptance_type='Conditional' AND a.expires_at=NEW.effective_at)
                OR (a.acceptance_type IS NULL AND EXISTS (
                    SELECT 1 FROM legacy_acceptance_classifications c
                    WHERE c.acceptance_id=a.id AND c.classification_type='Conditional'
                        AND c.expires_at=NEW.effective_at))))
    OR NOT EXISTS (
        SELECT 1 FROM audit_events e JOIN change_revisions r
            ON r.id=NEW.change_revision_id
        WHERE e.id=NEW.audit_event_id AND e.entity_type='change'
            AND e.entity_id=r.change_id AND e.entity_revision_id=r.id
            AND e.action='conditional-acceptance-expired'
            AND e.system_principal_id='SYS-SERVER-CLOCK'
            AND e.recorded_at=NEW.observed_at
            AND e.prior_state=NEW.prior_state AND e.new_state='Reopened'
            AND json_extract(e.payload_json,'$.acceptanceId')=NEW.acceptance_id
            AND json_extract(e.payload_json,'$.expiresAt')=NEW.effective_at
            AND json_extract(e.payload_json,'$.observedAt')=NEW.observed_at
            AND json_extract(e.payload_json,'$.priorCycleNo')=NEW.prior_cycle_no
            AND json_extract(e.payload_json,'$.newCycleNo')=NEW.new_cycle_no)
    OR NOT EXISTS (
        SELECT 1 FROM changes c JOIN change_revisions r ON r.change_id=c.id
        WHERE r.id=NEW.change_revision_id AND c.current_revision_no=r.revision_no
            AND c.state='Reopened' AND c.cycle_no=NEW.new_cycle_no)
BEGIN SELECT RAISE(ABORT,'conditional expiry source, audit or state mismatch'); END;
CREATE TRIGGER immutable_conditional_expiry_update
BEFORE UPDATE ON conditional_acceptance_expiries
BEGIN SELECT RAISE(ABORT,'immutable conditional expiry'); END;
CREATE TRIGGER immutable_conditional_expiry_delete
BEFORE DELETE ON conditional_acceptance_expiries
BEGIN SELECT RAISE(ABORT,'immutable conditional expiry'); END;

-- A recorded effectiveness check freezes its source-derived aggregates.
-- Reject backdated source rows that would change an earlier result.
CREATE TRIGGER equipment_event_after_effectiveness_guard
BEFORE INSERT ON equipment_events
WHEN NEW.event_type IN ('alarm','failure') AND EXISTS (
    SELECT 1 FROM incident_effectiveness_checks c
    JOIN incidents i ON i.id=c.incident_id
    WHERE i.equipment_id=NEW.equipment_id AND i.module_id=NEW.module_id
        AND NEW.occurred_at>=c.window_start AND NEW.occurred_at<c.window_end)
BEGIN SELECT RAISE(ABORT,'equipment alarm would change saved effectiveness'); END;

CREATE TRIGGER equipment_resolution_after_effectiveness_guard
BEFORE INSERT ON equipment_event_resolutions
WHEN EXISTS (
    SELECT 1 FROM equipment_events e
    JOIN incidents i ON i.equipment_id=e.equipment_id AND i.module_id=e.module_id
    JOIN incident_effectiveness_checks c ON c.incident_id=i.id
    JOIN maintenance_actions m ON m.id=NEW.maintenance_action_id
    WHERE e.id=NEW.equipment_event_id AND e.event_type IN ('alarm','failure')
        AND e.occurred_at>=c.window_start AND e.occurred_at<c.window_end
        AND m.end_at<=c.evaluated_at AND NEW.recorded_at<=c.evaluated_at)
BEGIN SELECT RAISE(ABORT,'equipment resolution would change saved effectiveness'); END;

CREATE TRIGGER aoi_defect_after_effectiveness_guard
BEFORE INSERT ON aoi_defects
WHEN NEW.defect_count>0 AND EXISTS (
    SELECT 1 FROM aoi_inspections a
    JOIN process_runs r ON r.id=a.process_run_id
    JOIN incidents i ON i.equipment_id=r.equipment_id AND i.module_id=r.module_id
    JOIN incident_effectiveness_checks c ON c.incident_id=i.id
    WHERE a.id=NEW.aoi_inspection_id AND NEW.defect_code_id=i.defect_code_id
        AND r.start_at>=c.window_start AND r.end_at<=c.window_end
        AND a.inspected_at<c.window_end)
BEGIN SELECT RAISE(ABORT,'AOI defect would change saved effectiveness'); END;
