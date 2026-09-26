-- MIG-009: only the newest Incident effectiveness check may authorize closure.
-- Keep the historical v4 guard and all existing rows intact.

CREATE TRIGGER incident_cycle_latest_check_guard BEFORE INSERT ON incident_cycle_decisions
WHEN NEW.decision='Closed' AND NEW.effectiveness_check_id IS NOT (
    SELECT id FROM incident_effectiveness_checks
    WHERE cycle_id=NEW.cycle_id AND incident_id=NEW.incident_id
    ORDER BY evaluated_at DESC,id DESC LIMIT 1)
BEGIN SELECT RAISE(ABORT,'latest passing Incident effectiveness check is required'); END;

-- A direct SQL check cannot become a Closure or Reopen decision without its
-- recorded audit. assertDataIntegrity validates the complete one-to-one audit.
CREATE TRIGGER incident_cycle_check_audit_guard BEFORE INSERT ON incident_cycle_decisions
WHEN NOT EXISTS (
    SELECT 1 FROM audit_events e JOIN incident_effectiveness_checks c
        ON c.id=NEW.effectiveness_check_id
    WHERE e.entity_type='incident' AND e.action='effectiveness-evaluated'
        AND e.entity_id=NEW.incident_id AND e.actor_id=c.evaluated_by
        AND e.recorded_at=c.evaluated_at
        AND json_extract(e.payload_json,'$.checkId')=c.id
        AND json_extract(e.payload_json,'$.cycleId')=NEW.cycle_id)
BEGIN SELECT RAISE(ABORT,'Incident effectiveness audit is required for cycle decision'); END;
