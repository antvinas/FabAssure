-- FabAssure synthetic change-control domain extension, version 2.
-- Additive to schema.sql so existing version-1 manufacturing source rows survive.

CREATE TABLE demo_actors (
    id TEXT PRIMARY KEY NOT NULL,
    role TEXT NOT NULL CHECK (role IN (
        'Manufacturing Engineer', 'Equipment / Automation Engineer',
        'Quality Engineer', 'Verification Engineer', 'Reviewer',
        'Approver', 'Production Manager'
    )),
    display_name TEXT NOT NULL
);

INSERT INTO demo_actors(id,role,display_name) VALUES
    ('ACT-MFG','Manufacturing Engineer','Synthetic Manufacturing Engineer'),
    ('ACT-EQP','Equipment / Automation Engineer','Synthetic Equipment Engineer'),
    ('ACT-Q1','Quality Engineer','Synthetic Quality Engineer A'),
    ('ACT-Q2','Quality Engineer','Synthetic Quality Engineer B'),
    ('ACT-VER','Verification Engineer','Synthetic Verification Engineer'),
    ('ACT-REV','Reviewer','Synthetic Independent Reviewer'),
    ('ACT-APP','Approver','Synthetic Acceptance Approver'),
    ('ACT-PROD','Production Manager','Synthetic Production Manager');

CREATE TABLE risk_rule_versions (
    version TEXT PRIMARY KEY NOT NULL,
    description TEXT NOT NULL,
    demonstration_only INTEGER NOT NULL CHECK (demonstration_only = 1)
);
INSERT INTO risk_rule_versions(version,description,demonstration_only)
VALUES ('FA-DEMO-RISK-1.0','Synthetic demonstration-only L1/L2/L3 teaching policy',1);

CREATE TABLE changes (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    proposer_actor_id TEXT NOT NULL REFERENCES demo_actors(id),
    line_id TEXT NOT NULL REFERENCES lines(id),
    equipment_id TEXT NOT NULL REFERENCES equipment(id),
    module_id TEXT NOT NULL,
    recipe_revision_id TEXT NOT NULL REFERENCES recipe_revisions(id),
    reason TEXT NOT NULL,
    baseline_ref TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
        'Draft','Submitted','Risk Classified','Plan Approved',
        'Verification In Progress','Evidence Ready','Independent Review',
        'Accepted','Effectiveness Monitoring','Closed','Needs Rework',
        'Rejected','Reopened'
    )),
    current_revision_no INTEGER NOT NULL DEFAULT 1 CHECK (current_revision_no >= 1),
    cycle_no INTEGER NOT NULL DEFAULT 1 CHECK (cycle_no >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (module_id,equipment_id) REFERENCES modules(id,equipment_id),
    CHECK (length(trim(reason)) > 0 AND length(trim(baseline_ref)) > 0),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at,0)),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at,0))
);
CREATE TRIGGER change_starts_draft BEFORE INSERT ON changes
WHEN NEW.state <> 'Draft' BEGIN SELECT RAISE(ABORT,'change must start Draft'); END;

CREATE TABLE change_revisions (
    id TEXT PRIMARY KEY NOT NULL,
    change_id TEXT NOT NULL REFERENCES changes(id),
    revision_no INTEGER NOT NULL CHECK (typeof(revision_no)='integer' AND revision_no >= 1),
    parent_revision_id TEXT,
    created_by TEXT NOT NULL REFERENCES demo_actors(id),
    created_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    UNIQUE(change_id,revision_no),
    UNIQUE(id,change_id),
    FOREIGN KEY (parent_revision_id,change_id) REFERENCES change_revisions(id,change_id),
    CHECK ((revision_no=1 AND parent_revision_id IS NULL) OR (revision_no>1 AND parent_revision_id IS NOT NULL)),
    CHECK (parent_revision_id IS NULL OR parent_revision_id <> id),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at,0))
);
CREATE TRIGGER change_revision_sequence_guard BEFORE INSERT ON change_revisions
WHEN NEW.revision_no > 1 AND
    (SELECT revision_no FROM change_revisions WHERE id=NEW.parent_revision_id) IS NOT (NEW.revision_no - 1)
BEGIN SELECT RAISE(ABORT,'change revision parent must be previous revision'); END;

CREATE TABLE risk_assessments (
    id TEXT PRIMARY KEY NOT NULL,
    change_revision_id TEXT NOT NULL REFERENCES change_revisions(id),
    rule_version TEXT NOT NULL REFERENCES risk_rule_versions(version),
    inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json)),
    score INTEGER NOT NULL CHECK (score BETWEEN 4 AND 12),
    matched_rule TEXT NOT NULL CHECK (matched_rule IN ('R01','R02','R03','R04','R05','R06')),
    computed_level TEXT NOT NULL CHECK (computed_level IN ('L1','L2','L3')),
    assessed_by TEXT NOT NULL REFERENCES demo_actors(id),
    assessed_at TEXT NOT NULL,
    UNIQUE(id,change_revision_id),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',assessed_at)=assessed_at,0))
);

CREATE TABLE evidence_items (
    id TEXT PRIMARY KEY NOT NULL,
    change_revision_id TEXT REFERENCES change_revisions(id),
    incident_revision_id TEXT REFERENCES incident_revisions(id),
    source_table TEXT NOT NULL,
    source_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    sha256 TEXT NOT NULL CHECK (length(sha256)=64),
    recorded_by TEXT NOT NULL REFERENCES demo_actors(id),
    recorded_at TEXT NOT NULL,
    supersedes_id TEXT REFERENCES evidence_items(id),
    CHECK ((change_revision_id IS NOT NULL) <> (incident_revision_id IS NOT NULL)),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at,0))
);
CREATE TRIGGER evidence_source_guard BEFORE INSERT ON evidence_items
WHEN NOT (
    (NEW.source_table='measurements' AND EXISTS (SELECT 1 FROM measurements WHERE id=NEW.source_id)) OR
    (NEW.source_table='inspection_samples' AND EXISTS (SELECT 1 FROM inspection_samples WHERE id=NEW.source_id)) OR
    (NEW.source_table='aoi_inspections' AND EXISTS (SELECT 1 FROM aoi_inspections WHERE id=NEW.source_id)) OR
    (NEW.source_table='aoi_defects' AND EXISTS (SELECT 1 FROM aoi_defects WHERE id=NEW.source_id)) OR
    (NEW.source_table='process_runs' AND EXISTS (SELECT 1 FROM process_runs WHERE id=NEW.source_id)) OR
    (NEW.source_table='lots' AND EXISTS (SELECT 1 FROM lots WHERE id=NEW.source_id)) OR
    (NEW.source_table='equipment_events' AND EXISTS (SELECT 1 FROM equipment_events WHERE id=NEW.source_id)) OR
    (NEW.source_table='maintenance_actions' AND EXISTS (SELECT 1 FROM maintenance_actions WHERE id=NEW.source_id)) OR
    (NEW.source_table='recipe_revisions' AND EXISTS (SELECT 1 FROM recipe_revisions WHERE id=NEW.source_id)) OR
    (NEW.source_table='embedded_note' AND NEW.source_id=NEW.id AND
        COALESCE(json_type(NEW.payload_json,'$.text'),'')='text' AND
        COALESCE(length(trim(json_extract(NEW.payload_json,'$.text'))),0) > 0)
) BEGIN SELECT RAISE(ABORT,'evidence source reference missing or unsupported'); END;
CREATE TRIGGER evidence_supersession_guard BEFORE INSERT ON evidence_items
WHEN NEW.supersedes_id IS NOT NULL AND (
    NEW.supersedes_id = NEW.id OR
    COALESCE((SELECT change_revision_id FROM evidence_items WHERE id=NEW.supersedes_id),'') <> COALESCE(NEW.change_revision_id,'') OR
    COALESCE((SELECT incident_revision_id FROM evidence_items WHERE id=NEW.supersedes_id),'') <> COALESCE(NEW.incident_revision_id,'')
) BEGIN SELECT RAISE(ABORT,'evidence supersession must stay within revision'); END;

CREATE TABLE risk_overrides (
    id TEXT PRIMARY KEY NOT NULL,
    assessment_id TEXT NOT NULL REFERENCES risk_assessments(id),
    from_level TEXT NOT NULL CHECK (from_level IN ('L1','L2','L3')),
    to_level TEXT NOT NULL CHECK (to_level IN ('L1','L2','L3')),
    rationale TEXT NOT NULL,
    evidence_id TEXT NOT NULL REFERENCES evidence_items(id),
    requester_actor_id TEXT NOT NULL REFERENCES demo_actors(id),
    approver_actor_id TEXT REFERENCES demo_actors(id),
    recorded_at TEXT NOT NULL,
    CHECK (from_level <> to_level AND length(trim(rationale)) > 0),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at,0))
);
CREATE TRIGGER risk_override_revision_guard BEFORE INSERT ON risk_overrides
WHEN (SELECT change_revision_id FROM risk_assessments WHERE id=NEW.assessment_id)
     IS NOT (SELECT change_revision_id FROM evidence_items WHERE id=NEW.evidence_id)
BEGIN SELECT RAISE(ABORT,'risk override evidence revision mismatch'); END;

CREATE TABLE verification_plans (
    id TEXT PRIMARY KEY NOT NULL,
    change_revision_id TEXT NOT NULL REFERENCES change_revisions(id),
    assessment_id TEXT NOT NULL REFERENCES risk_assessments(id),
    revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
    final_level TEXT NOT NULL CHECK (final_level IN ('L1','L2','L3')),
    baseline_lots INTEGER NOT NULL CHECK (baseline_lots >= 1),
    post_change_lots INTEGER NOT NULL CHECK (post_change_lots >= 1),
    samples_per_lot INTEGER NOT NULL CHECK (samples_per_lot >= 1),
    effectiveness_lots INTEGER NOT NULL CHECK (effectiveness_lots >= 1),
    effectiveness_days INTEGER NOT NULL CHECK (effectiveness_days >= 0),
    max_aoi_reject_rate REAL NOT NULL CHECK (max_aoi_reject_rate BETWEEN 0 AND 1),
    alignment_abs_limit REAL NOT NULL CHECK (alignment_abs_limit > 0),
    criteria_json TEXT NOT NULL CHECK (json_valid(criteria_json)),
    approved_by TEXT NOT NULL REFERENCES demo_actors(id),
    approved_at TEXT NOT NULL,
    UNIQUE(change_revision_id,revision_no),
    UNIQUE(id,change_revision_id),
    FOREIGN KEY (assessment_id,change_revision_id) REFERENCES risk_assessments(id,change_revision_id),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',approved_at)=approved_at,0))
);

CREATE TABLE plan_criteria (
    id TEXT PRIMARY KEY NOT NULL,
    plan_id TEXT NOT NULL REFERENCES verification_plans(id),
    code TEXT NOT NULL,
    comparison TEXT NOT NULL CHECK (comparison IN ('<=','>=','=','none')),
    threshold REAL,
    unit TEXT,
    required INTEGER NOT NULL CHECK (required IN (0,1)),
    UNIQUE(plan_id,code)
);

CREATE TABLE criterion_results (
    id TEXT PRIMARY KEY NOT NULL,
    plan_id TEXT NOT NULL REFERENCES verification_plans(id),
    criterion_code TEXT NOT NULL,
    evidence_id TEXT NOT NULL REFERENCES evidence_items(id),
    verifier_actor_id TEXT NOT NULL REFERENCES demo_actors(id),
    passed INTEGER NOT NULL CHECK (passed IN (0,1)),
    observed_value REAL,
    unit TEXT,
    recorded_at TEXT NOT NULL,
    UNIQUE(plan_id,criterion_code),
    FOREIGN KEY (plan_id,criterion_code) REFERENCES plan_criteria(plan_id,code),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at,0))
);
CREATE TRIGGER criterion_result_revision_guard BEFORE INSERT ON criterion_results
WHEN (SELECT change_revision_id FROM verification_plans WHERE id=NEW.plan_id)
     IS NOT (SELECT change_revision_id FROM evidence_items WHERE id=NEW.evidence_id)
BEGIN SELECT RAISE(ABORT,'criterion evidence revision mismatch'); END;

CREATE TABLE deviations (
    id TEXT PRIMARY KEY NOT NULL,
    plan_id TEXT NOT NULL REFERENCES verification_plans(id),
    description TEXT NOT NULL,
    blocking INTEGER NOT NULL CHECK (blocking IN (0,1)),
    disposition TEXT NOT NULL CHECK (disposition IN ('Open','Rework','Accepted with rationale','Closed')),
    recorded_by TEXT NOT NULL REFERENCES demo_actors(id),
    recorded_at TEXT NOT NULL
);

CREATE TABLE reviews (
    id TEXT PRIMARY KEY NOT NULL,
    change_revision_id TEXT NOT NULL REFERENCES change_revisions(id),
    plan_id TEXT NOT NULL REFERENCES verification_plans(id),
    reviewer_actor_id TEXT NOT NULL REFERENCES demo_actors(id),
    decision TEXT NOT NULL CHECK (decision IN ('Pass','Needs Rework')),
    reason TEXT NOT NULL,
    evidence_set_digest TEXT NOT NULL CHECK (length(evidence_set_digest)=64),
    reviewed_at TEXT NOT NULL,
    UNIQUE(id,change_revision_id,plan_id,decision),
    FOREIGN KEY (plan_id,change_revision_id) REFERENCES verification_plans(id,change_revision_id),
    CHECK (length(trim(reason)) > 0)
);

CREATE TABLE acceptances (
    id TEXT PRIMARY KEY NOT NULL,
    change_revision_id TEXT NOT NULL REFERENCES change_revisions(id),
    plan_id TEXT NOT NULL,
    review_id TEXT NOT NULL,
    review_decision TEXT NOT NULL DEFAULT 'Pass' CHECK (review_decision='Pass'),
    approver_actor_id TEXT NOT NULL REFERENCES demo_actors(id),
    accepted_at TEXT NOT NULL,
    frozen_digest TEXT NOT NULL CHECK (length(frozen_digest)=64),
    UNIQUE(change_revision_id),
    FOREIGN KEY (review_id,change_revision_id,plan_id,review_decision)
        REFERENCES reviews(id,change_revision_id,plan_id,decision)
);

CREATE TABLE effectiveness_checks (
    id TEXT PRIMARY KEY NOT NULL,
    change_revision_id TEXT NOT NULL REFERENCES change_revisions(id),
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    lot_count INTEGER NOT NULL CHECK (lot_count >= 0),
    passed INTEGER NOT NULL CHECK (passed IN (0,1)),
    reason TEXT NOT NULL,
    recorded_by TEXT NOT NULL REFERENCES demo_actors(id),
    recorded_at TEXT NOT NULL,
    CHECK (window_start < window_end)
);

CREATE TABLE incidents (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    proposer_actor_id TEXT NOT NULL REFERENCES demo_actors(id),
    defect_code_id TEXT NOT NULL REFERENCES defect_codes(id),
    equipment_id TEXT NOT NULL REFERENCES equipment(id),
    module_id TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
        'Open','Contained','Trace Proposed','Scope Reviewed',
        'CAPA In Progress','Effectiveness Check','Closed','Reopened'
    )),
    cycle_no INTEGER NOT NULL DEFAULT 1 CHECK (cycle_no >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (module_id,equipment_id) REFERENCES modules(id,equipment_id)
);
CREATE TRIGGER incident_starts_open BEFORE INSERT ON incidents
WHEN NEW.state <> 'Open' BEGIN SELECT RAISE(ABORT,'incident must start Open'); END;

CREATE TABLE incident_revisions (
    id TEXT PRIMARY KEY NOT NULL,
    incident_id TEXT NOT NULL REFERENCES incidents(id),
    revision_no INTEGER NOT NULL CHECK (typeof(revision_no)='integer' AND revision_no >= 1),
    parent_revision_id TEXT,
    reason TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES demo_actors(id),
    created_at TEXT NOT NULL,
    UNIQUE(incident_id,revision_no),
    UNIQUE(id,incident_id),
    FOREIGN KEY (parent_revision_id,incident_id) REFERENCES incident_revisions(id,incident_id),
    CHECK ((revision_no=1 AND parent_revision_id IS NULL) OR (revision_no>1 AND parent_revision_id IS NOT NULL)),
    CHECK (parent_revision_id IS NULL OR parent_revision_id <> id)
);
CREATE TRIGGER incident_revision_sequence_guard BEFORE INSERT ON incident_revisions
WHEN NEW.revision_no > 1 AND
    (SELECT revision_no FROM incident_revisions WHERE id=NEW.parent_revision_id) IS NOT (NEW.revision_no - 1)
BEGIN SELECT RAISE(ABORT,'incident revision parent must be previous revision'); END;

CREATE TABLE audit_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    dataset_instance_id TEXT NOT NULL REFERENCES dataset_instances(id),
    recorded_at TEXT NOT NULL,
    actor_id TEXT NOT NULL REFERENCES demo_actors(id),
    simulated_role TEXT NOT NULL,
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
    UNIQUE(dataset_instance_id,digest)
);
CREATE TRIGGER audit_append_guard BEFORE INSERT ON audit_events
WHEN NEW.simulated_role IS NOT (SELECT role FROM demo_actors WHERE id=NEW.actor_id)
    OR NEW.previous_digest IS NOT (
        SELECT digest FROM audit_events
        WHERE dataset_instance_id=NEW.dataset_instance_id
        ORDER BY sequence DESC LIMIT 1
    )
BEGIN SELECT RAISE(ABORT,'audit actor role or previous digest mismatch'); END;

-- A direct SQL acceptance must still cite the exact reviewed package and
-- the independent Pass decision's immutable audit event. Domain checks also
-- rederive the full source package and enforce simulated actor separation.
CREATE TRIGGER acceptance_review_audit_guard BEFORE INSERT ON acceptances
WHEN NOT EXISTS (
    SELECT 1 FROM reviews r
    JOIN change_revisions cr ON cr.id=r.change_revision_id
    JOIN audit_events a ON a.entity_type='change' AND a.entity_id=cr.change_id
        AND a.entity_revision_id=r.change_revision_id
        AND a.action='independent-review-passed'
        AND a.actor_id=r.reviewer_actor_id AND a.recorded_at=r.reviewed_at
        AND a.prior_state='Independent Review' AND a.new_state IS NULL
        AND a.reason=r.reason
        AND json_extract(a.payload_json,'$.reviewId')=r.id
        AND json_extract(a.payload_json,'$.planId')=r.plan_id
        AND json_extract(a.payload_json,'$.decision')='Pass'
        AND json_extract(a.payload_json,'$.packageDigest')=r.evidence_set_digest
        AND EXISTS (
            SELECT 1 FROM audit_events started
            WHERE started.entity_type='change' AND started.entity_id=cr.change_id
                AND started.entity_revision_id=r.change_revision_id
                AND started.action='independent-review-started'
                AND started.actor_id=r.reviewer_actor_id
                AND started.recorded_at<r.reviewed_at
                AND started.prior_state='Evidence Ready'
                AND started.new_state='Independent Review'
                AND json_extract(started.payload_json,'$.planId')=r.plan_id
                AND json_extract(started.payload_json,'$.packageDigest')=r.evidence_set_digest
        )
    WHERE r.id=NEW.review_id AND r.change_revision_id=NEW.change_revision_id
        AND r.plan_id=NEW.plan_id AND r.decision='Pass'
)
BEGIN SELECT RAISE(ABORT,'acceptance passing review audit missing'); END;

CREATE TRIGGER acceptance_digest_guard BEFORE INSERT ON acceptances
WHEN NEW.frozen_digest IS NOT (
    SELECT evidence_set_digest FROM reviews
    WHERE id=NEW.review_id AND change_revision_id=NEW.change_revision_id
        AND plan_id=NEW.plan_id AND decision='Pass'
)
BEGIN SELECT RAISE(ABORT,'acceptance frozen digest differs from passing review'); END;

CREATE TRIGGER acceptance_actor_guard BEFORE INSERT ON acceptances
WHEN (SELECT role FROM demo_actors WHERE id=NEW.approver_actor_id) IS NOT 'Approver'
    OR (SELECT role FROM demo_actors WHERE id=(
        SELECT reviewer_actor_id FROM reviews WHERE id=NEW.review_id
    )) IS NOT 'Reviewer'
    OR EXISTS (
        SELECT 1 FROM reviews r
        JOIN change_revisions cr ON cr.id=r.change_revision_id
        JOIN changes c ON c.id=cr.change_id
        WHERE r.id=NEW.review_id AND r.change_revision_id=NEW.change_revision_id
            AND (
                r.reviewer_actor_id=c.proposer_actor_id
                OR NEW.approver_actor_id IN (r.reviewer_actor_id,c.proposer_actor_id)
                OR EXISTS (
                    SELECT 1 FROM criterion_results result
                    JOIN verification_plans p ON p.id=result.plan_id
                    WHERE p.change_revision_id=NEW.change_revision_id
                        AND result.verifier_actor_id IN (r.reviewer_actor_id,NEW.approver_actor_id)
                )
                OR EXISTS (
                    SELECT 1 FROM evidence_items e
                    WHERE e.change_revision_id=NEW.change_revision_id
                        AND e.recorded_by IN (r.reviewer_actor_id,NEW.approver_actor_id)
                )
                OR EXISTS (
                    SELECT 1 FROM audit_events a
                    WHERE a.entity_type='change' AND a.entity_id=cr.change_id
                        AND a.entity_revision_id=NEW.change_revision_id
                        AND a.action IN ('verification-started','evidence-ready')
                        AND a.actor_id IN (r.reviewer_actor_id,NEW.approver_actor_id)
                )
            )
    )
BEGIN SELECT RAISE(ABORT,'acceptance approver or reviewer actor separation failed'); END;

CREATE TRIGGER acceptance_time_guard BEFORE INSERT ON acceptances
WHEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',NEW.accepted_at)=NEW.accepted_at,0)=0
    OR NEW.accepted_at <= (
        SELECT reviewed_at FROM reviews WHERE id=NEW.review_id
            AND change_revision_id=NEW.change_revision_id
    )
BEGIN SELECT RAISE(ABORT,'acceptance time must follow independent review'); END;

-- Decision history and evidence are append-only. Change and incident header
-- state fields are the only mutable workflow projections; domain transactions
-- must update those headers and append an audit event atomically.
CREATE TRIGGER immutable_change_revision_update BEFORE UPDATE ON change_revisions BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_actor_update BEFORE UPDATE ON demo_actors BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_actor_delete BEFORE DELETE ON demo_actors BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_risk_rule_update BEFORE UPDATE ON risk_rule_versions BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_risk_rule_delete BEFORE DELETE ON risk_rule_versions BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_change_revision_delete BEFORE DELETE ON change_revisions BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_risk_assessment_update BEFORE UPDATE ON risk_assessments BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_risk_assessment_delete BEFORE DELETE ON risk_assessments BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_risk_override_update BEFORE UPDATE ON risk_overrides BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_risk_override_delete BEFORE DELETE ON risk_overrides BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_plan_update BEFORE UPDATE ON verification_plans BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_plan_delete BEFORE DELETE ON verification_plans BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_plan_criterion_update BEFORE UPDATE ON plan_criteria BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_plan_criterion_delete BEFORE DELETE ON plan_criteria BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_evidence_update BEFORE UPDATE ON evidence_items BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_evidence_delete BEFORE DELETE ON evidence_items BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_criterion_result_update BEFORE UPDATE ON criterion_results BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_criterion_result_delete BEFORE DELETE ON criterion_results BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_deviation_update BEFORE UPDATE ON deviations BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_deviation_delete BEFORE DELETE ON deviations BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_review_update BEFORE UPDATE ON reviews BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_review_delete BEFORE DELETE ON reviews BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_acceptance_update BEFORE UPDATE ON acceptances BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_acceptance_delete BEFORE DELETE ON acceptances BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_effectiveness_update BEFORE UPDATE ON effectiveness_checks BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_effectiveness_delete BEFORE DELETE ON effectiveness_checks BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_incident_revision_update BEFORE UPDATE ON incident_revisions BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_incident_revision_delete BEFORE DELETE ON incident_revisions BEGIN SELECT RAISE(ABORT,'immutable decision record'); END;
CREATE TRIGGER immutable_audit_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'immutable audit event'); END;
CREATE TRIGGER immutable_audit_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'immutable audit event'); END;
