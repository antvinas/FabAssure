-- FabAssure synthetic FabTrace proposal and independent scope review, version 3.
-- Additive to the version-2 domain schema; source and prior decisions are retained.

CREATE TABLE legacy_incidents (
    incident_id TEXT PRIMARY KEY NOT NULL REFERENCES incidents(id),
    state_at_migration TEXT NOT NULL,
    updated_at_at_migration TEXT NOT NULL,
    migrated_at TEXT NOT NULL CHECK
        (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',migrated_at)=migrated_at,0)),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at_at_migration)=updated_at_at_migration,0))
);
CREATE TRIGGER legacy_incident_insert_guard BEFORE INSERT ON legacy_incidents
WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE version>=3)
BEGIN SELECT RAISE(ABORT,'legacy incident marker is migration-only'); END;
CREATE TRIGGER immutable_legacy_incident_update BEFORE UPDATE ON legacy_incidents
BEGIN SELECT RAISE(ABORT,'immutable migration provenance'); END;
CREATE TRIGGER immutable_legacy_incident_delete BEFORE DELETE ON legacy_incidents
BEGIN SELECT RAISE(ABORT,'immutable migration provenance'); END;

CREATE TABLE lkg_observations (
    id TEXT PRIMARY KEY NOT NULL,
    incident_revision_id TEXT NOT NULL REFERENCES incident_revisions(id),
    aoi_inspection_id TEXT NOT NULL REFERENCES aoi_inspections(id),
    earliest_possible_at TEXT NOT NULL,
    latest_possible_at TEXT NOT NULL,
    method TEXT NOT NULL CHECK (length(trim(method)) > 0),
    sample_scope TEXT NOT NULL CHECK (length(trim(sample_scope)) > 0),
    limitation TEXT NOT NULL CHECK (length(trim(limitation)) > 0),
    recorded_by TEXT NOT NULL REFERENCES demo_actors(id),
    recorded_at TEXT NOT NULL,
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',earliest_possible_at)=earliest_possible_at,0)),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',latest_possible_at)=latest_possible_at,0)),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at,0)),
    CHECK (earliest_possible_at <= latest_possible_at),
    UNIQUE(id,incident_revision_id)
);
CREATE TRIGGER lkg_source_scope_guard BEFORE INSERT ON lkg_observations
WHEN NOT EXISTS (
    SELECT 1 FROM incident_revisions ir
    JOIN incidents i ON i.id=ir.incident_id
    JOIN aoi_inspections a ON a.id=NEW.aoi_inspection_id
    JOIN process_runs r ON r.id=a.process_run_id
    WHERE ir.id=NEW.incident_revision_id
        AND r.equipment_id=i.equipment_id AND r.module_id=i.module_id
        AND a.inspected_at BETWEEN NEW.earliest_possible_at AND NEW.latest_possible_at
        AND a.inspected_at < i.detected_at
        AND NOT EXISTS (SELECT 1 FROM aoi_defects d
            WHERE d.aoi_inspection_id=a.id AND d.defect_code_id=i.defect_code_id)
)
BEGIN SELECT RAISE(ABORT,'LKG source must match incident scope, time and target-code good result'); END;

CREATE TABLE trace_proposals (
    id TEXT PRIMARY KEY NOT NULL,
    incident_revision_id TEXT NOT NULL REFERENCES incident_revisions(id),
    proposer_actor_id TEXT NOT NULL REFERENCES demo_actors(id),
    recipe_revision_id TEXT NOT NULL REFERENCES recipe_revisions(id),
    lkg_observation_id TEXT,
    earliest_trace_at TEXT,
    cutoff_at TEXT NOT NULL,
    query_json TEXT NOT NULL CHECK (json_valid(query_json)),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    result_digest TEXT NOT NULL CHECK (length(result_digest)=64),
    proposed_at TEXT NOT NULL,
    FOREIGN KEY (lkg_observation_id,incident_revision_id)
        REFERENCES lkg_observations(id,incident_revision_id),
    CHECK ((lkg_observation_id IS NULL AND earliest_trace_at IS NOT NULL) OR
        (lkg_observation_id IS NOT NULL AND earliest_trace_at IS NULL)),
    CHECK (earliest_trace_at IS NULL OR
        COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',earliest_trace_at)=earliest_trace_at,0)),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',cutoff_at)=cutoff_at,0)),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',proposed_at)=proposed_at,0)),
    UNIQUE(id,incident_revision_id),
    UNIQUE(id,result_digest)
);
CREATE TRIGGER trace_proposal_context_guard BEFORE INSERT ON trace_proposals
WHEN NOT EXISTS (
    SELECT 1 FROM incident_revisions ir JOIN incidents i ON i.id=ir.incident_id
    JOIN process_runs r ON r.equipment_id=i.equipment_id AND r.module_id=i.module_id
        AND r.recipe_revision_id=NEW.recipe_revision_id
    WHERE ir.id=NEW.incident_revision_id AND NEW.cutoff_at=i.detected_at
        AND r.start_at < NEW.cutoff_at
        AND r.end_at > COALESCE(
            (SELECT earliest_possible_at FROM lkg_observations WHERE id=NEW.lkg_observation_id),
            NEW.earliest_trace_at)
)
    OR (NEW.lkg_observation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM lkg_observations l
        JOIN aoi_inspections a ON a.id=l.aoi_inspection_id
        JOIN process_runs r ON r.id=a.process_run_id
        WHERE l.id=NEW.lkg_observation_id AND r.recipe_revision_id=NEW.recipe_revision_id
    ))
BEGIN SELECT RAISE(ABORT,'trace recipe and detection cutoff must match incident source context'); END;

CREATE TABLE trace_candidates (
    id TEXT PRIMARY KEY NOT NULL,
    proposal_id TEXT NOT NULL REFERENCES trace_proposals(id),
    lot_id TEXT NOT NULL REFERENCES lots(id),
    classification TEXT NOT NULL CHECK (classification IN
        ('excluded','ambiguous','potentially-exposed','confirmed-affected')),
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    details_json TEXT NOT NULL CHECK (json_valid(details_json)),
    targeted_defects INTEGER NOT NULL CHECK (targeted_defects >= 0),
    certain_interval_defects INTEGER NOT NULL CHECK
        (certain_interval_defects >= 0 AND certain_interval_defects <= targeted_defects),
    UNIQUE(proposal_id,lot_id)
);
CREATE TRIGGER trace_candidate_source_guard BEFORE INSERT ON trace_candidates
WHEN EXISTS (SELECT 1 FROM scope_reviews WHERE proposal_id=NEW.proposal_id)
    OR json_extract(NEW.details_json,'$.lotId') IS NOT NEW.lot_id
    OR json_extract(NEW.details_json,'$.classification') IS NOT NEW.classification
    OR json_extract(NEW.details_json,'$.reason') IS NOT NEW.reason
    OR json_extract(NEW.details_json,'$.targetedDefects') IS NOT NEW.targeted_defects
    OR json_extract(NEW.details_json,'$.certainIntervalDefects') IS NOT NEW.certain_interval_defects
    OR json_type(NEW.details_json,'$.runIds') IS NOT 'array'
    OR json_array_length(NEW.details_json,'$.runIds') < 1
    OR EXISTS (
        SELECT 1 FROM json_each(NEW.details_json,'$.runIds') ids
        WHERE NOT EXISTS (SELECT 1 FROM process_runs r
            WHERE r.id=ids.value AND r.lot_id=NEW.lot_id)
    )
    OR (NEW.classification <> 'excluded' AND NOT EXISTS (
        SELECT 1 FROM trace_proposals p
        JOIN incident_revisions ir ON ir.id=p.incident_revision_id
        JOIN incidents i ON i.id=ir.incident_id
        JOIN json_each(NEW.details_json,'$.runIds') ids
        JOIN process_runs r ON r.id=ids.value AND r.lot_id=NEW.lot_id
        WHERE p.id=NEW.proposal_id AND r.equipment_id=i.equipment_id
            AND r.module_id=i.module_id AND r.recipe_revision_id=p.recipe_revision_id
            AND r.end_at > COALESCE(
                (SELECT earliest_possible_at FROM lkg_observations WHERE id=p.lkg_observation_id),
                p.earliest_trace_at)
            AND r.start_at < p.cutoff_at
    ))
BEGIN SELECT RAISE(ABORT,'trace candidate source invalid or reviewed candidate set frozen'); END;

CREATE TABLE scope_reviews (
    id TEXT PRIMARY KEY NOT NULL,
    proposal_id TEXT NOT NULL,
    candidate_digest TEXT NOT NULL,
    reviewer_actor_id TEXT NOT NULL REFERENCES demo_actors(id),
    decision TEXT NOT NULL CHECK (decision IN ('Pass','Needs Rework')),
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    reviewed_at TEXT NOT NULL,
    FOREIGN KEY (proposal_id,candidate_digest)
        REFERENCES trace_proposals(id,result_digest),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',reviewed_at)=reviewed_at,0)),
    UNIQUE(id,proposal_id),
    UNIQUE(proposal_id)
);
CREATE TRIGGER scope_reviewer_separation BEFORE INSERT ON scope_reviews
WHEN NEW.reviewer_actor_id IS (SELECT proposer_actor_id FROM trace_proposals
    WHERE id=NEW.proposal_id)
    OR (SELECT role FROM demo_actors WHERE id=NEW.reviewer_actor_id)
        NOT IN ('Reviewer','Quality Engineer')
    OR NEW.reviewed_at <= (SELECT proposed_at FROM trace_proposals WHERE id=NEW.proposal_id)
BEGIN SELECT RAISE(ABORT,'independent scope reviewer and later decision required'); END;
CREATE TRIGGER scope_review_candidate_set_guard BEFORE INSERT ON scope_reviews
WHEN (SELECT COUNT(*) FROM trace_candidates WHERE proposal_id=NEW.proposal_id) < 1
    OR (SELECT COUNT(*) FROM trace_candidates WHERE proposal_id=NEW.proposal_id) IS NOT
        (SELECT json_array_length(result_json,'$.lots') FROM trace_proposals WHERE id=NEW.proposal_id)
    OR EXISTS (
        SELECT 1 FROM trace_candidates c JOIN trace_proposals p ON p.id=c.proposal_id
        WHERE c.proposal_id=NEW.proposal_id AND NOT EXISTS (
            SELECT 1 FROM json_each(p.result_json,'$.lots') item
            WHERE json_extract(item.value,'$.lotId')=c.lot_id
                AND json(item.value)=json(c.details_json)
        )
    )
BEGIN SELECT RAISE(ABORT,'scope review requires the complete frozen candidate set'); END;

CREATE TABLE scope_decisions (
    id TEXT PRIMARY KEY NOT NULL,
    review_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    lot_id TEXT NOT NULL,
    scope_status TEXT NOT NULL CHECK (scope_status IN ('included','excluded','ambiguous')),
    containment TEXT NOT NULL CHECK (containment IN ('Held','Additional Inspection','No Change')),
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    FOREIGN KEY (review_id,proposal_id) REFERENCES scope_reviews(id,proposal_id),
    FOREIGN KEY (proposal_id,lot_id) REFERENCES trace_candidates(proposal_id,lot_id),
    UNIQUE(review_id,lot_id)
);
CREATE TRIGGER scope_decision_pass_guard BEFORE INSERT ON scope_decisions
WHEN (SELECT decision FROM scope_reviews WHERE id=NEW.review_id) IS NOT 'Pass'
    OR (SELECT classification FROM trace_candidates
        WHERE proposal_id=NEW.proposal_id AND lot_id=NEW.lot_id) IS 'excluded'
        AND (NEW.scope_status <> 'excluded' OR NEW.containment <> 'No Change')
    OR (SELECT classification FROM trace_candidates
        WHERE proposal_id=NEW.proposal_id AND lot_id=NEW.lot_id) IS NOT 'excluded'
        AND (NEW.scope_status='excluded' OR NEW.containment='No Change')
BEGIN SELECT RAISE(ABORT,'scope review cannot silently release an exposed or uncertain lot'); END;

CREATE TRIGGER immutable_lkg_update BEFORE UPDATE ON lkg_observations BEGIN SELECT RAISE(ABORT,'immutable trace record'); END;
CREATE TRIGGER immutable_lkg_delete BEFORE DELETE ON lkg_observations BEGIN SELECT RAISE(ABORT,'immutable trace record'); END;
CREATE TRIGGER immutable_trace_proposal_update BEFORE UPDATE ON trace_proposals BEGIN SELECT RAISE(ABORT,'immutable trace record'); END;
CREATE TRIGGER immutable_trace_proposal_delete BEFORE DELETE ON trace_proposals BEGIN SELECT RAISE(ABORT,'immutable trace record'); END;
CREATE TRIGGER immutable_trace_candidate_update BEFORE UPDATE ON trace_candidates BEGIN SELECT RAISE(ABORT,'immutable trace record'); END;
CREATE TRIGGER immutable_trace_candidate_delete BEFORE DELETE ON trace_candidates BEGIN SELECT RAISE(ABORT,'immutable trace record'); END;
CREATE TRIGGER immutable_scope_review_update BEFORE UPDATE ON scope_reviews BEGIN SELECT RAISE(ABORT,'immutable trace record'); END;
CREATE TRIGGER immutable_scope_review_delete BEFORE DELETE ON scope_reviews BEGIN SELECT RAISE(ABORT,'immutable trace record'); END;
CREATE TRIGGER immutable_scope_decision_update BEFORE UPDATE ON scope_decisions BEGIN SELECT RAISE(ABORT,'immutable trace record'); END;
CREATE TRIGGER immutable_scope_decision_delete BEFORE DELETE ON scope_decisions BEGIN SELECT RAISE(ABORT,'immutable trace record'); END;
