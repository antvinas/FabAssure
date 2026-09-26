-- FabAssure synthetic CAPA, controlled-document and incident effectiveness lineage.
-- Additive version 4. Rows representing decisions and evidence are append-only.

CREATE TABLE incident_cycles (
    id TEXT PRIMARY KEY NOT NULL,
    incident_id TEXT NOT NULL REFERENCES incidents(id),
    cycle_no INTEGER NOT NULL CHECK (typeof(cycle_no)='integer' AND cycle_no>=1),
    parent_cycle_id TEXT,
    scope_review_id TEXT REFERENCES scope_reviews(id),
    linked_change_revision_id TEXT REFERENCES change_revisions(id),
    opened_by TEXT NOT NULL REFERENCES demo_actors(id),
    opened_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',opened_at)=opened_at,0)),
    reason TEXT NOT NULL CHECK (length(trim(reason))>0),
    UNIQUE(incident_id,cycle_no),
    UNIQUE(id,incident_id),
    UNIQUE(id,incident_id,cycle_no),
    FOREIGN KEY (parent_cycle_id,incident_id) REFERENCES incident_cycles(id,incident_id),
    CHECK ((cycle_no=1 AND parent_cycle_id IS NULL AND scope_review_id IS NOT NULL)
        OR (cycle_no>1 AND parent_cycle_id IS NOT NULL))
);
CREATE TRIGGER incident_cycle_context_guard BEFORE INSERT ON incident_cycles
WHEN NEW.cycle_no IS NOT (SELECT cycle_no FROM incidents WHERE id=NEW.incident_id)
    OR (NEW.cycle_no=1 AND NOT EXISTS (
        SELECT 1 FROM scope_reviews s
        JOIN trace_proposals p ON p.id=s.proposal_id
        JOIN incident_revisions r ON r.id=p.incident_revision_id
        WHERE s.id=NEW.scope_review_id AND r.incident_id=NEW.incident_id
            AND s.decision='Pass' AND s.reviewed_at<NEW.opened_at
    ))
    OR (NEW.cycle_no>1 AND (
        (SELECT cycle_no FROM incident_cycles WHERE id=NEW.parent_cycle_id) IS NOT NEW.cycle_no-1
        OR (SELECT incident_id FROM incident_cycles WHERE id=NEW.parent_cycle_id) IS NOT NEW.incident_id
        OR NOT EXISTS (SELECT 1 FROM incident_cycle_decisions d
            WHERE d.cycle_id=NEW.parent_cycle_id AND d.decision='Reopened'
                AND d.decided_at<NEW.opened_at)
    ))
BEGIN SELECT RAISE(ABORT,'incident cycle must follow reviewed scope or prior cycle'); END;

CREATE TABLE cause_assessments (
    id TEXT PRIMARY KEY NOT NULL,
    cycle_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('Hypothesis','Confirmed')),
    statement TEXT NOT NULL CHECK (length(trim(statement))>0),
    evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('equipment-event','aoi-defect','trace-candidate')),
    evidence_id TEXT NOT NULL CHECK (length(trim(evidence_id))>0),
    assessed_by TEXT NOT NULL REFERENCES demo_actors(id),
    assessed_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',assessed_at)=assessed_at,0)),
    FOREIGN KEY (cycle_id,incident_id) REFERENCES incident_cycles(id,incident_id),
    UNIQUE(id,cycle_id,incident_id)
);
CREATE TRIGGER cause_evidence_guard BEFORE INSERT ON cause_assessments
WHEN NEW.assessed_at<=(SELECT opened_at FROM incident_cycles WHERE id=NEW.cycle_id)
    OR NOT EXISTS (
    SELECT 1 FROM incidents i WHERE i.id=NEW.incident_id AND (
        (NEW.evidence_kind='equipment-event' AND EXISTS (
            SELECT 1 FROM equipment_events e WHERE e.id=NEW.evidence_id
                AND e.equipment_id=i.equipment_id AND e.module_id=i.module_id
                AND e.occurred_at<=NEW.assessed_at))
        OR (NEW.evidence_kind='aoi-defect' AND EXISTS (
            SELECT 1 FROM aoi_defects d
            JOIN aoi_inspections a ON a.id=d.aoi_inspection_id
            JOIN process_runs r ON r.id=a.process_run_id
            WHERE d.id=NEW.evidence_id AND d.defect_code_id=i.defect_code_id
                AND r.equipment_id=i.equipment_id AND r.module_id=i.module_id
                AND a.inspected_at<=NEW.assessed_at))
        OR (NEW.evidence_kind='trace-candidate' AND EXISTS (
            SELECT 1 FROM trace_candidates c
            JOIN trace_proposals p ON p.id=c.proposal_id
            JOIN incident_revisions ir ON ir.id=p.incident_revision_id
            WHERE c.id=NEW.evidence_id AND ir.incident_id=i.id
                AND p.proposed_at<=NEW.assessed_at))
    )
)
BEGIN SELECT RAISE(ABORT,'cause evidence must belong to incident source'); END;

CREATE TABLE capa_actions (
    id TEXT PRIMARY KEY NOT NULL,
    cycle_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    cause_id TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK (action_type IN ('Corrective','Preventive')),
    action_text TEXT NOT NULL CHECK (length(trim(action_text))>0),
    owner_actor_id TEXT NOT NULL REFERENCES demo_actors(id),
    due_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',due_at)=due_at,0)),
    created_by TEXT NOT NULL REFERENCES demo_actors(id),
    created_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at,0)),
    parent_action_id TEXT,
    FOREIGN KEY (cycle_id,incident_id) REFERENCES incident_cycles(id,incident_id),
    FOREIGN KEY (cause_id,cycle_id,incident_id) REFERENCES cause_assessments(id,cycle_id,incident_id),
    FOREIGN KEY (parent_action_id,cycle_id,incident_id) REFERENCES capa_actions(id,cycle_id,incident_id),
    CHECK (due_at>created_at),
    CHECK (parent_action_id IS NULL OR parent_action_id<>id),
    UNIQUE(id,cycle_id,incident_id)
);
CREATE TRIGGER capa_cause_guard BEFORE INSERT ON capa_actions
WHEN (SELECT status FROM cause_assessments WHERE id=NEW.cause_id) IS NOT 'Confirmed'
    OR NEW.created_at<=(SELECT assessed_at FROM cause_assessments WHERE id=NEW.cause_id)
    OR (NEW.parent_action_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM capa_action_reviews r WHERE r.action_id=NEW.parent_action_id
            AND r.decision='Needs Rework' AND r.reviewed_at<NEW.created_at))
BEGIN SELECT RAISE(ABORT,'CAPA needs confirmed cause and reviewed rework parent'); END;

CREATE TABLE capa_action_reviews (
    id TEXT PRIMARY KEY NOT NULL,
    action_id TEXT NOT NULL REFERENCES capa_actions(id),
    reviewer_actor_id TEXT NOT NULL REFERENCES demo_actors(id),
    decision TEXT NOT NULL CHECK (decision IN ('Pass','Needs Rework')),
    evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('equipment-event','aoi-inspection','measurement')),
    evidence_id TEXT NOT NULL CHECK (length(trim(evidence_id))>0),
    reason TEXT NOT NULL CHECK (length(trim(reason))>0),
    reviewed_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',reviewed_at)=reviewed_at,0)),
    UNIQUE(action_id)
);
CREATE TRIGGER capa_review_guard BEFORE INSERT ON capa_action_reviews
WHEN NEW.reviewer_actor_id IS (SELECT owner_actor_id FROM capa_actions WHERE id=NEW.action_id)
    OR NEW.reviewer_actor_id IS (SELECT created_by FROM capa_actions WHERE id=NEW.action_id)
    OR (SELECT role FROM demo_actors WHERE id=NEW.reviewer_actor_id) NOT IN ('Reviewer','Quality Engineer')
    OR NEW.reviewed_at <= (SELECT created_at FROM capa_actions WHERE id=NEW.action_id)
    OR NOT EXISTS (
        SELECT 1 FROM capa_actions c
        JOIN incidents i ON i.id=c.incident_id
        WHERE c.id=NEW.action_id AND (
            (NEW.evidence_kind='equipment-event' AND EXISTS (
                SELECT 1 FROM equipment_events e WHERE e.id=NEW.evidence_id
                    AND e.equipment_id=i.equipment_id AND e.module_id=i.module_id
                    AND e.occurred_at>c.created_at AND e.occurred_at<=NEW.reviewed_at))
            OR (NEW.evidence_kind='aoi-inspection' AND EXISTS (
                SELECT 1 FROM aoi_inspections a JOIN process_runs r ON r.id=a.process_run_id
                WHERE a.id=NEW.evidence_id AND r.equipment_id=i.equipment_id
                    AND r.module_id=i.module_id AND a.inspected_at>c.created_at
                    AND a.inspected_at<=NEW.reviewed_at))
            OR (NEW.evidence_kind='measurement' AND EXISTS (
                SELECT 1 FROM measurements m JOIN inspection_samples s ON s.id=m.inspection_sample_id
                JOIN process_runs r ON r.id=s.process_run_id WHERE m.id=NEW.evidence_id
                    AND r.equipment_id=i.equipment_id AND r.module_id=i.module_id
                    AND m.recorded_at>c.created_at AND m.recorded_at<=NEW.reviewed_at))
        )
    )
BEGIN SELECT RAISE(ABORT,'CAPA review needs independent actor and matching source evidence'); END;

CREATE TABLE controlled_documents (
    id TEXT PRIMARY KEY NOT NULL,
    doc_type TEXT NOT NULL CHECK (doc_type IN ('PFMEA','Control Plan','WI')),
    scope_equipment_id TEXT NOT NULL REFERENCES equipment(id),
    defect_code_id TEXT NOT NULL REFERENCES defect_codes(id),
    code TEXT NOT NULL CHECK (length(trim(code))>0),
    title TEXT NOT NULL CHECK (length(trim(title))>0),
    UNIQUE(scope_equipment_id,defect_code_id,doc_type),
    UNIQUE(scope_equipment_id,doc_type,code)
);
CREATE TABLE document_revisions (
    id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL REFERENCES controlled_documents(id),
    revision_no INTEGER NOT NULL CHECK (typeof(revision_no)='integer' AND revision_no>=1),
    parent_revision_id TEXT,
    source_feedback_id TEXT,
    summary TEXT NOT NULL CHECK (length(trim(summary))>0),
    approved_by TEXT NOT NULL REFERENCES demo_actors(id),
    approved_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',approved_at)=approved_at,0)),
    FOREIGN KEY (parent_revision_id,document_id) REFERENCES document_revisions(id,document_id),
    FOREIGN KEY (source_feedback_id,document_id) REFERENCES feedback_actions(id,document_id),
    UNIQUE(document_id,revision_no),
    UNIQUE(id,document_id),
    CHECK ((revision_no=1 AND parent_revision_id IS NULL AND source_feedback_id IS NULL)
        OR (revision_no>1 AND parent_revision_id IS NOT NULL AND source_feedback_id IS NOT NULL))
);
CREATE TABLE feedback_actions (
    id TEXT PRIMARY KEY NOT NULL,
    cycle_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    capa_action_id TEXT NOT NULL,
    document_id TEXT NOT NULL REFERENCES controlled_documents(id),
    base_revision_id TEXT NOT NULL,
    proposed_summary TEXT NOT NULL CHECK (length(trim(proposed_summary))>0),
    proposed_by TEXT NOT NULL REFERENCES demo_actors(id),
    proposed_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',proposed_at)=proposed_at,0)),
    FOREIGN KEY (cycle_id,incident_id) REFERENCES incident_cycles(id,incident_id),
    FOREIGN KEY (capa_action_id,cycle_id,incident_id) REFERENCES capa_actions(id,cycle_id,incident_id),
    FOREIGN KEY (base_revision_id,document_id) REFERENCES document_revisions(id,document_id),
    UNIQUE(id,document_id)
);
CREATE TABLE feedback_reviews (
    id TEXT PRIMARY KEY NOT NULL,
    feedback_id TEXT NOT NULL REFERENCES feedback_actions(id),
    reviewer_actor_id TEXT NOT NULL REFERENCES demo_actors(id),
    decision TEXT NOT NULL CHECK (decision IN ('Pass','Needs Rework')),
    verification_kind TEXT NOT NULL CHECK (verification_kind IN ('capa-review','aoi-inspection')),
    verification_id TEXT NOT NULL CHECK (length(trim(verification_id))>0),
    reason TEXT NOT NULL CHECK (length(trim(reason))>0),
    reviewed_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',reviewed_at)=reviewed_at,0)),
    UNIQUE(feedback_id)
);
CREATE TRIGGER feedback_proposal_guard BEFORE INSERT ON feedback_actions
WHEN NOT EXISTS (SELECT 1 FROM capa_action_reviews r
    WHERE r.action_id=NEW.capa_action_id AND r.decision='Pass' AND r.reviewed_at<NEW.proposed_at)
    OR NEW.base_revision_id IS NOT (SELECT id FROM document_revisions
        WHERE document_id=NEW.document_id ORDER BY revision_no DESC LIMIT 1)
    OR NOT EXISTS (SELECT 1 FROM controlled_documents d
        JOIN incidents i ON i.equipment_id=d.scope_equipment_id
            AND i.defect_code_id=d.defect_code_id
        WHERE d.id=NEW.document_id AND i.id=NEW.incident_id)
BEGIN SELECT RAISE(ABORT,'feedback needs passed CAPA and current document revision'); END;
CREATE TRIGGER feedback_review_guard BEFORE INSERT ON feedback_reviews
WHEN NEW.reviewer_actor_id IS (SELECT proposed_by FROM feedback_actions WHERE id=NEW.feedback_id)
    OR (SELECT role FROM demo_actors WHERE id=NEW.reviewer_actor_id) NOT IN ('Reviewer','Quality Engineer','Approver')
    OR NEW.reviewed_at <= (SELECT proposed_at FROM feedback_actions WHERE id=NEW.feedback_id)
    OR (NEW.verification_kind='capa-review' AND NEW.verification_id IS NOT
        (SELECT r.id FROM feedback_actions f JOIN capa_action_reviews r
            ON r.action_id=f.capa_action_id WHERE f.id=NEW.feedback_id AND r.decision='Pass'))
    OR (NEW.verification_kind='aoi-inspection' AND NOT EXISTS (
        SELECT 1 FROM feedback_actions f JOIN incidents i ON i.id=f.incident_id
        JOIN aoi_inspections a ON a.id=NEW.verification_id
        JOIN process_runs r ON r.id=a.process_run_id
        WHERE f.id=NEW.feedback_id AND r.equipment_id=i.equipment_id AND r.module_id=i.module_id
            AND a.inspected_at>f.proposed_at AND a.inspected_at<=NEW.reviewed_at))
BEGIN SELECT RAISE(ABORT,'feedback needs independent review and linked verification'); END;
CREATE TRIGGER document_revision_guard BEFORE INSERT ON document_revisions
WHEN (NEW.revision_no>1 AND (
        (SELECT revision_no FROM document_revisions WHERE id=NEW.parent_revision_id) IS NOT NEW.revision_no-1
        OR NOT EXISTS (SELECT 1 FROM feedback_actions f JOIN feedback_reviews r ON r.feedback_id=f.id
            WHERE f.id=NEW.source_feedback_id AND f.document_id=NEW.document_id
                AND f.base_revision_id=NEW.parent_revision_id AND r.decision='Pass'
                AND r.reviewed_at<NEW.approved_at AND NEW.summary=f.proposed_summary)
        OR NEW.parent_revision_id IS NOT (SELECT id FROM document_revisions
            WHERE document_id=NEW.document_id ORDER BY revision_no DESC LIMIT 1)
    ))
    OR (NEW.revision_no=1 AND EXISTS (SELECT 1 FROM document_revisions WHERE document_id=NEW.document_id))
BEGIN SELECT RAISE(ABORT,'document revision needs approved feedback and current parent'); END;
CREATE TRIGGER document_revision_approval_guard BEFORE INSERT ON document_revisions
WHEN (SELECT role FROM demo_actors WHERE id=NEW.approved_by) NOT IN ('Approver','Quality Engineer')
    OR (NEW.revision_no>1 AND (
        NEW.approved_by IS (SELECT proposed_by FROM feedback_actions WHERE id=NEW.source_feedback_id)
        OR NEW.approved_by IS (SELECT r.reviewer_actor_id FROM feedback_reviews r
        WHERE r.feedback_id=NEW.source_feedback_id)
    ))
BEGIN SELECT RAISE(ABORT,'document revision needs separate qualified approver'); END;

CREATE TABLE equipment_event_resolutions (
    id TEXT PRIMARY KEY NOT NULL,
    equipment_event_id TEXT NOT NULL REFERENCES equipment_events(id),
    maintenance_action_id TEXT NOT NULL REFERENCES maintenance_actions(id),
    recorded_by TEXT NOT NULL REFERENCES demo_actors(id),
    recorded_at TEXT NOT NULL CHECK
        (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at,0)),
    UNIQUE(equipment_event_id),
    UNIQUE(maintenance_action_id)
);
CREATE TRIGGER equipment_event_resolution_guard BEFORE INSERT ON equipment_event_resolutions
WHEN (SELECT role FROM demo_actors WHERE id=NEW.recorded_by)
        NOT IN ('Equipment / Automation Engineer','Quality Engineer')
    OR NOT EXISTS (SELECT 1 FROM equipment_events e
        JOIN maintenance_actions m ON m.id=NEW.maintenance_action_id
        WHERE e.id=NEW.equipment_event_id AND e.event_type IN ('alarm','failure')
            AND e.equipment_id=m.equipment_id AND e.module_id=m.module_id
            AND m.code='REPAIR' AND m.start_at>=e.occurred_at
            AND m.end_at<=NEW.recorded_at)
BEGIN SELECT RAISE(ABORT,'resolution needs explicit same-module later repair'); END;
CREATE TRIGGER immutable_equipment_resolution_update BEFORE UPDATE ON equipment_event_resolutions
BEGIN SELECT RAISE(ABORT,'immutable equipment resolution'); END;
CREATE TRIGGER immutable_equipment_resolution_delete BEFORE DELETE ON equipment_event_resolutions
BEGIN SELECT RAISE(ABORT,'immutable equipment resolution'); END;

CREATE TABLE incident_effectiveness_checks (
    id TEXT PRIMARY KEY NOT NULL,
    cycle_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    source_json TEXT NOT NULL CHECK (json_valid(source_json)),
    source_digest TEXT NOT NULL CHECK (length(source_digest)=64),
    lot_count INTEGER NOT NULL CHECK (lot_count>=0),
    inspected_units INTEGER NOT NULL CHECK (inspected_units>=0),
    rejected_units INTEGER NOT NULL CHECK (rejected_units>=0 AND rejected_units<=inspected_units),
    recurrence_count INTEGER NOT NULL CHECK (recurrence_count>=0),
    unresolved_alarm_count INTEGER NOT NULL CHECK (unresolved_alarm_count>=0),
    rule_version TEXT NOT NULL CHECK (length(trim(rule_version))>0),
    passed INTEGER NOT NULL CHECK (passed IN (0,1)),
    evaluated_by TEXT NOT NULL REFERENCES demo_actors(id),
    evaluated_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',evaluated_at)=evaluated_at,0)),
    FOREIGN KEY (cycle_id,incident_id) REFERENCES incident_cycles(id,incident_id),
    CHECK (window_start<window_end),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',window_start)=window_start,0)),
    CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',window_end)=window_end,0)),
    UNIQUE(id,cycle_id,incident_id)
);
CREATE TRIGGER incident_effectiveness_source_guard BEFORE INSERT ON incident_effectiveness_checks
WHEN NEW.rule_version<>'DEMO-CAPA-1'
    OR NEW.evaluated_at<NEW.window_end
    OR NEW.source_digest IS NOT fab_sha256(NEW.source_json)
    OR json_type(NEW.source_json,'$.lotIds') IS NOT 'array'
    OR NEW.lot_count IS NOT json_array_length(NEW.source_json,'$.lotIds')
    OR (SELECT COUNT(DISTINCT value) FROM json_each(NEW.source_json,'$.lotIds')) IS NOT NEW.lot_count
    OR EXISTS (SELECT 1 FROM json_each(NEW.source_json,'$.lotIds') ids WHERE NOT EXISTS (
        SELECT 1 FROM process_runs r JOIN aoi_inspections a ON a.process_run_id=r.id
        JOIN incidents i ON i.id=NEW.incident_id
        WHERE r.lot_id=ids.value AND r.equipment_id=i.equipment_id
            AND r.module_id=i.module_id AND r.start_at>=NEW.window_start
            AND a.inspected_at<NEW.window_end AND a.inspected_at>=r.start_at
            AND a.inspected_at<=r.end_at))
    OR NEW.inspected_units IS NOT (SELECT COALESCE(SUM(a.inspected_units),0)
        FROM json_each(NEW.source_json,'$.lotIds') ids
        JOIN process_runs r ON r.lot_id=ids.value
        JOIN aoi_inspections a ON a.process_run_id=r.id
        JOIN incidents i ON i.id=NEW.incident_id
        WHERE r.equipment_id=i.equipment_id AND r.module_id=i.module_id
            AND r.start_at>=NEW.window_start AND a.inspected_at<NEW.window_end)
    OR NEW.rejected_units IS NOT (SELECT COALESCE(SUM(a.rejected_units),0)
        FROM json_each(NEW.source_json,'$.lotIds') ids
        JOIN process_runs r ON r.lot_id=ids.value
        JOIN aoi_inspections a ON a.process_run_id=r.id
        JOIN incidents i ON i.id=NEW.incident_id
        WHERE r.equipment_id=i.equipment_id AND r.module_id=i.module_id
            AND r.start_at>=NEW.window_start AND a.inspected_at<NEW.window_end)
    OR NEW.recurrence_count IS NOT (SELECT COALESCE(SUM(d.defect_count),0)
        FROM json_each(NEW.source_json,'$.lotIds') ids
        JOIN process_runs r ON r.lot_id=ids.value
        JOIN aoi_inspections a ON a.process_run_id=r.id
        JOIN aoi_defects d ON d.aoi_inspection_id=a.id
        JOIN incidents i ON i.id=NEW.incident_id
        WHERE r.equipment_id=i.equipment_id AND r.module_id=i.module_id
            AND d.defect_code_id=i.defect_code_id
            AND r.start_at>=NEW.window_start AND a.inspected_at<NEW.window_end)
    OR NEW.unresolved_alarm_count IS NOT (
        SELECT COUNT(*) FROM equipment_events e
        JOIN incidents i ON i.id=NEW.incident_id
        WHERE e.equipment_id=i.equipment_id AND e.module_id=i.module_id
            AND e.event_type IN ('alarm','failure')
            AND e.occurred_at>=NEW.window_start AND e.occurred_at<NEW.window_end
            AND NOT EXISTS (SELECT 1 FROM equipment_event_resolutions link
                WHERE link.equipment_event_id=e.id AND link.recorded_at<=NEW.evaluated_at))
    OR EXISTS (SELECT 1 FROM process_runs r
        JOIN aoi_inspections a ON a.process_run_id=r.id
        JOIN incidents i ON i.id=NEW.incident_id
        WHERE r.equipment_id=i.equipment_id AND r.module_id=i.module_id
            AND r.start_at>=NEW.window_start AND a.inspected_at<NEW.window_end
            AND NOT EXISTS (SELECT 1 FROM json_each(NEW.source_json,'$.lotIds') ids
                WHERE ids.value=r.lot_id))
BEGIN SELECT RAISE(ABORT,'effectiveness source must match local evidence'); END;
CREATE TRIGGER incident_effectiveness_pass_guard BEFORE INSERT ON incident_effectiveness_checks
WHEN NEW.passed=1 AND (
    NEW.rule_version<>'DEMO-CAPA-1'
    OR NEW.evaluated_at<NEW.window_end
    OR NOT EXISTS (SELECT 1 FROM capa_actions c
        JOIN capa_action_reviews r ON r.action_id=c.id
        WHERE c.cycle_id=NEW.cycle_id AND c.action_type='Corrective'
            AND r.decision='Pass' AND r.reviewed_at<NEW.window_start)
    OR NOT EXISTS (SELECT 1 FROM capa_actions c
        JOIN capa_action_reviews r ON r.action_id=c.id
        WHERE c.cycle_id=NEW.cycle_id AND c.action_type='Preventive'
            AND r.decision='Pass' AND r.reviewed_at<NEW.window_start)
    OR NEW.inspected_units<1
    OR NEW.rejected_units*100>NEW.inspected_units*2
    OR NEW.recurrence_count<>0 OR NEW.unresolved_alarm_count<>0
    OR NEW.source_digest IS NOT fab_sha256(NEW.source_json)
    OR json_type(NEW.source_json,'$.lotIds') IS NOT 'array'
    OR NEW.lot_count IS NOT json_array_length(NEW.source_json,'$.lotIds')
    OR NEW.lot_count < (SELECT CASE WHEN d.severity='critical' OR EXISTS (
        SELECT 1 FROM incident_cycles c
        JOIN verification_plans p ON p.change_revision_id=c.linked_change_revision_id
        WHERE c.id=NEW.cycle_id AND p.final_level='L3'
    ) THEN 10 ELSE 5 END FROM incidents i
        JOIN defect_codes d ON d.id=i.defect_code_id WHERE i.id=NEW.incident_id)
    OR (SELECT COUNT(DISTINCT value) FROM json_each(NEW.source_json,'$.lotIds')) IS NOT NEW.lot_count
    OR EXISTS (SELECT 1 FROM json_each(NEW.source_json,'$.lotIds') ids WHERE NOT EXISTS (
        SELECT 1 FROM process_runs r JOIN aoi_inspections a ON a.process_run_id=r.id
        JOIN incidents i ON i.id=NEW.incident_id
        WHERE r.lot_id=ids.value AND r.equipment_id=i.equipment_id
            AND r.module_id=i.module_id AND r.start_at>=NEW.window_start
            AND a.inspected_at<NEW.window_end AND a.inspected_at>=r.start_at
            AND a.inspected_at<=r.end_at))
    OR NEW.inspected_units IS NOT (SELECT COALESCE(SUM(a.inspected_units),0)
        FROM json_each(NEW.source_json,'$.lotIds') ids
        JOIN process_runs r ON r.lot_id=ids.value
        JOIN aoi_inspections a ON a.process_run_id=r.id
        JOIN incidents i ON i.id=NEW.incident_id
        WHERE r.equipment_id=i.equipment_id AND r.module_id=i.module_id
            AND r.start_at>=NEW.window_start AND a.inspected_at<NEW.window_end)
    OR NEW.rejected_units IS NOT (SELECT COALESCE(SUM(a.rejected_units),0)
        FROM json_each(NEW.source_json,'$.lotIds') ids
        JOIN process_runs r ON r.lot_id=ids.value
        JOIN aoi_inspections a ON a.process_run_id=r.id
        JOIN incidents i ON i.id=NEW.incident_id
        WHERE r.equipment_id=i.equipment_id AND r.module_id=i.module_id
            AND r.start_at>=NEW.window_start AND a.inspected_at<NEW.window_end)
    OR NEW.recurrence_count IS NOT (SELECT COALESCE(SUM(d.defect_count),0)
        FROM json_each(NEW.source_json,'$.lotIds') ids
        JOIN process_runs r ON r.lot_id=ids.value
        JOIN aoi_inspections a ON a.process_run_id=r.id
        JOIN aoi_defects d ON d.aoi_inspection_id=a.id
        JOIN incidents i ON i.id=NEW.incident_id
        WHERE r.equipment_id=i.equipment_id AND r.module_id=i.module_id
            AND d.defect_code_id=i.defect_code_id
            AND r.start_at>=NEW.window_start AND a.inspected_at<NEW.window_end)
    OR julianday(date((SELECT MAX(a.inspected_at) FROM json_each(NEW.source_json,'$.lotIds') ids
        JOIN process_runs r ON r.lot_id=ids.value
        JOIN aoi_inspections a ON a.process_run_id=r.id
        JOIN incidents i ON i.id=NEW.incident_id
        WHERE r.equipment_id=i.equipment_id AND r.module_id=i.module_id
            AND r.start_at>=NEW.window_start AND a.inspected_at<NEW.window_end)))-
        julianday(date((SELECT MIN(a.inspected_at) FROM json_each(NEW.source_json,'$.lotIds') ids
        JOIN process_runs r ON r.lot_id=ids.value
        JOIN aoi_inspections a ON a.process_run_id=r.id
        JOIN incidents i ON i.id=NEW.incident_id
        WHERE r.equipment_id=i.equipment_id AND r.module_id=i.module_id
            AND r.start_at>=NEW.window_start AND a.inspected_at<NEW.window_end)))<7
    OR NEW.unresolved_alarm_count IS NOT (
        SELECT COUNT(*) FROM equipment_events e
        JOIN incidents i ON i.id=NEW.incident_id
        WHERE e.equipment_id=i.equipment_id AND e.module_id=i.module_id
            AND e.event_type IN ('alarm','failure')
            AND e.occurred_at>=NEW.window_start AND e.occurred_at<NEW.window_end
            AND NOT EXISTS (SELECT 1 FROM equipment_event_resolutions link
                JOIN maintenance_actions m ON m.id=link.maintenance_action_id
                WHERE link.equipment_event_id=e.id AND m.end_at<=NEW.evaluated_at
                    AND link.recorded_at<=NEW.evaluated_at))
    OR EXISTS (SELECT 1 FROM process_runs r
        JOIN aoi_inspections a ON a.process_run_id=r.id
        JOIN incidents i ON i.id=NEW.incident_id
        WHERE r.equipment_id=i.equipment_id AND r.module_id=i.module_id
            AND r.start_at>=NEW.window_start AND a.inspected_at<NEW.window_end
            AND NOT EXISTS (SELECT 1 FROM json_each(NEW.source_json,'$.lotIds') ids
                WHERE ids.value=r.lot_id))
    OR EXISTS (SELECT 1 FROM capa_actions c JOIN capa_action_reviews r ON r.action_id=c.id
        WHERE c.cycle_id=NEW.cycle_id AND r.decision='Pass'
            AND r.reviewed_at>=NEW.window_start)
)
BEGIN SELECT RAISE(ABORT,'passing effectiveness needs full source window and demo rule'); END;
CREATE TABLE incident_cycle_decisions (
    id TEXT PRIMARY KEY NOT NULL,
    cycle_id TEXT NOT NULL,
    incident_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('Closed','Reopened')),
    effectiveness_check_id TEXT NOT NULL,
    recurrence_aoi_defect_id TEXT REFERENCES aoi_defects(id),
    actor_id TEXT NOT NULL REFERENCES demo_actors(id),
    reason TEXT NOT NULL CHECK (length(trim(reason))>0),
    decided_at TEXT NOT NULL CHECK (COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',decided_at)=decided_at,0)),
    FOREIGN KEY (cycle_id,incident_id) REFERENCES incident_cycles(id,incident_id),
    FOREIGN KEY (effectiveness_check_id,cycle_id,incident_id)
        REFERENCES incident_effectiveness_checks(id,cycle_id,incident_id),
    CHECK ((decision='Closed' AND recurrence_aoi_defect_id IS NULL)
        OR (decision='Reopened' AND recurrence_aoi_defect_id IS NOT NULL)),
    UNIQUE(cycle_id,decision)
);
CREATE TRIGGER incident_cycle_decision_guard BEFORE INSERT ON incident_cycle_decisions
WHEN NEW.decided_at <= (SELECT evaluated_at FROM incident_effectiveness_checks
        WHERE id=NEW.effectiveness_check_id)
    OR (NEW.decision='Closed' AND (
        (SELECT passed FROM incident_effectiveness_checks WHERE id=NEW.effectiveness_check_id) IS NOT 1
        OR NOT EXISTS (SELECT 1 FROM cause_assessments c WHERE c.cycle_id=NEW.cycle_id
            AND c.status='Confirmed')
        OR NOT EXISTS (SELECT 1 FROM capa_actions a JOIN capa_action_reviews r ON r.action_id=a.id
            WHERE a.cycle_id=NEW.cycle_id AND a.action_type='Corrective' AND r.decision='Pass')
        OR NOT EXISTS (SELECT 1 FROM capa_actions a JOIN capa_action_reviews r ON r.action_id=a.id
            WHERE a.cycle_id=NEW.cycle_id AND a.action_type='Preventive' AND r.decision='Pass')
        OR (SELECT COUNT(DISTINCT d.doc_type) FROM controlled_documents d
            JOIN incidents i ON i.equipment_id=d.scope_equipment_id
                AND i.defect_code_id=d.defect_code_id
            WHERE i.id=NEW.incident_id)<3
        OR EXISTS (SELECT 1 FROM controlled_documents d
            JOIN incidents i ON i.equipment_id=d.scope_equipment_id
                AND i.defect_code_id=d.defect_code_id
            WHERE i.id=NEW.incident_id AND NOT EXISTS (
            SELECT 1 FROM feedback_actions f JOIN feedback_reviews r ON r.feedback_id=f.id
            JOIN document_revisions v ON v.source_feedback_id=f.id
            WHERE f.cycle_id=NEW.cycle_id AND f.document_id=d.id AND r.decision='Pass'
                AND v.approved_at<=NEW.decided_at))
    ))
    OR (NEW.decision='Reopened' AND (
        (SELECT passed FROM incident_effectiveness_checks WHERE id=NEW.effectiveness_check_id) IS NOT 0
        OR NOT EXISTS (SELECT 1 FROM incident_cycle_decisions d
            WHERE d.cycle_id=NEW.cycle_id AND d.decision='Closed'
                AND d.decided_at<NEW.decided_at)
        OR NOT EXISTS (SELECT 1 FROM aoi_defects d
            JOIN aoi_inspections a ON a.id=d.aoi_inspection_id
            JOIN process_runs r ON r.id=a.process_run_id
            JOIN incidents i ON i.id=NEW.incident_id
            JOIN incident_cycle_decisions prior ON prior.cycle_id=NEW.cycle_id
                AND prior.decision='Closed'
            WHERE d.id=NEW.recurrence_aoi_defect_id AND d.defect_code_id=i.defect_code_id
                AND d.defect_count>0 AND r.equipment_id=i.equipment_id
                AND r.module_id=i.module_id AND a.inspected_at>prior.decided_at
                AND a.inspected_at<=NEW.decided_at)
    ))
BEGIN SELECT RAISE(ABORT,'cycle decision needs complete CAPA, feedback and effectiveness lineage'); END;

CREATE TRIGGER immutable_incident_cycle_update BEFORE UPDATE ON incident_cycles BEGIN SELECT RAISE(ABORT,'immutable CAPA record'); END;
CREATE TRIGGER immutable_incident_cycle_delete BEFORE DELETE ON incident_cycles BEGIN SELECT RAISE(ABORT,'immutable CAPA record'); END;
CREATE TRIGGER immutable_cause_update BEFORE UPDATE ON cause_assessments BEGIN SELECT RAISE(ABORT,'immutable CAPA record'); END;
CREATE TRIGGER immutable_cause_delete BEFORE DELETE ON cause_assessments BEGIN SELECT RAISE(ABORT,'immutable CAPA record'); END;
CREATE TRIGGER immutable_capa_action_update BEFORE UPDATE ON capa_actions BEGIN SELECT RAISE(ABORT,'immutable CAPA record'); END;
CREATE TRIGGER immutable_capa_action_delete BEFORE DELETE ON capa_actions BEGIN SELECT RAISE(ABORT,'immutable CAPA record'); END;
CREATE TRIGGER immutable_capa_review_update BEFORE UPDATE ON capa_action_reviews BEGIN SELECT RAISE(ABORT,'immutable CAPA record'); END;
CREATE TRIGGER immutable_capa_review_delete BEFORE DELETE ON capa_action_reviews BEGIN SELECT RAISE(ABORT,'immutable CAPA record'); END;
CREATE TRIGGER immutable_controlled_document_update BEFORE UPDATE ON controlled_documents BEGIN SELECT RAISE(ABORT,'immutable document identity'); END;
CREATE TRIGGER immutable_controlled_document_delete BEFORE DELETE ON controlled_documents BEGIN SELECT RAISE(ABORT,'immutable document identity'); END;
CREATE TRIGGER immutable_document_revision_update BEFORE UPDATE ON document_revisions BEGIN SELECT RAISE(ABORT,'immutable document revision'); END;
CREATE TRIGGER immutable_document_revision_delete BEFORE DELETE ON document_revisions BEGIN SELECT RAISE(ABORT,'immutable document revision'); END;
CREATE TRIGGER immutable_feedback_action_update BEFORE UPDATE ON feedback_actions BEGIN SELECT RAISE(ABORT,'immutable feedback record'); END;
CREATE TRIGGER immutable_feedback_action_delete BEFORE DELETE ON feedback_actions BEGIN SELECT RAISE(ABORT,'immutable feedback record'); END;
CREATE TRIGGER immutable_feedback_review_update BEFORE UPDATE ON feedback_reviews BEGIN SELECT RAISE(ABORT,'immutable feedback record'); END;
CREATE TRIGGER immutable_feedback_review_delete BEFORE DELETE ON feedback_reviews BEGIN SELECT RAISE(ABORT,'immutable feedback record'); END;
CREATE TRIGGER immutable_incident_effectiveness_update BEFORE UPDATE ON incident_effectiveness_checks BEGIN SELECT RAISE(ABORT,'immutable effectiveness record'); END;
CREATE TRIGGER immutable_incident_effectiveness_delete BEFORE DELETE ON incident_effectiveness_checks BEGIN SELECT RAISE(ABORT,'immutable effectiveness record'); END;
CREATE TRIGGER immutable_incident_cycle_decision_update BEFORE UPDATE ON incident_cycle_decisions BEGIN SELECT RAISE(ABORT,'immutable cycle decision'); END;
CREATE TRIGGER immutable_incident_cycle_decision_delete BEFORE DELETE ON incident_cycle_decisions BEGIN SELECT RAISE(ABORT,'immutable cycle decision'); END;
