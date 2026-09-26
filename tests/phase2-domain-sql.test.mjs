import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const sourceSchema = readFileSync(new URL('../src/data/schema.sql', import.meta.url), 'utf8');
const domainSchema = readFileSync(new URL('../src/data/schema-v2.sql', import.meta.url), 'utf8');
const build = () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(sourceSchema);
    db.exec(domainSchema);
    return db;
};

test('additive v2 SQL provides the domain, actor and audit tables without replacing source tables', () => {
    const db = build();
    try {
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(({ name }) => name));
        for (const name of [
            'dataset_instances', 'lots', 'measurements', 'aoi_inspections',
            'demo_actors', 'risk_rule_versions', 'changes', 'change_revisions',
            'risk_assessments', 'risk_overrides', 'verification_plans', 'plan_criteria',
            'evidence_items', 'criterion_results', 'deviations', 'reviews',
            'acceptances', 'effectiveness_checks', 'incidents', 'incident_revisions',
            'audit_events'
        ]) assert.ok(tables.has(name), `missing table ${name}`);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM demo_actors WHERE role='Quality Engineer'").get().n, 2);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM demo_actors').get().n, 8);
        assert.equal(db.prepare("SELECT version FROM risk_rule_versions WHERE version='FA-DEMO-RISK-1.0'").get().version, 'FA-DEMO-RISK-1.0');
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        assert.ok(db.prepare('PRAGMA table_info(criterion_results)').all().some(({ name }) => name === 'verifier_actor_id'));
    } finally {
        db.close();
    }
});

test('audit rows are append-only and belong to a synthetic dataset instance and actor', () => {
    const db = build();
    try {
        db.prepare("INSERT INTO dataset_instances(id,code,version,seed,generated_at) VALUES ('DATASET-T','camera-demo',1,'fixed','2026-09-01T00:00:00.000Z')").run();
        const digest = 'a'.repeat(64);
        db.prepare('INSERT INTO audit_events(id,dataset_instance_id,recorded_at,actor_id,simulated_role,entity_type,entity_id,action,payload_json,payload_sha256,previous_digest,digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
            'AUD-1', 'DATASET-T', '2026-09-01T01:00:00.000Z', 'ACT-MFG', 'Manufacturing Engineer',
            'change', 'CHG-1', 'created', '{}', digest, null, digest
        );
        assert.throws(() => db.prepare("UPDATE audit_events SET action='altered' WHERE id='AUD-1'").run(), /immutable|audit/i);
        assert.throws(() => db.prepare("DELETE FROM audit_events WHERE id='AUD-1'").run(), /immutable|audit/i);
        assert.throws(() => db.prepare('INSERT INTO audit_events(id,dataset_instance_id,recorded_at,actor_id,simulated_role,entity_type,entity_id,action,payload_json,payload_sha256,previous_digest,digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
            'AUD-2', 'DATASET-UNKNOWN', '2026-09-01T01:00:00.000Z', 'ACT-MFG', 'Manufacturing Engineer',
            'change', 'CHG-1', 'created', '{}', digest, null, digest
        ));
        assert.throws(() => db.prepare('INSERT INTO audit_events(id,dataset_instance_id,recorded_at,actor_id,simulated_role,entity_type,entity_id,action,payload_json,payload_sha256,previous_digest,digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
            'AUD-3', 'DATASET-T', '2026-09-01T02:00:00.000Z', 'ACT-MFG', 'Manufacturing Engineer',
            'change', 'CHG-1', 'submitted', '{}', digest, 'b'.repeat(64), 'c'.repeat(64)
        ), /previous|audit/i);
        assert.throws(() => db.prepare('INSERT INTO audit_events(id,dataset_instance_id,recorded_at,actor_id,simulated_role,entity_type,entity_id,action,payload_json,payload_sha256,previous_digest,digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
            'AUD-4', 'DATASET-T', '2026-09-01T02:00:00.000Z', 'ACT-MFG', 'Approver',
            'change', 'CHG-1', 'submitted', '{}', digest, digest, 'd'.repeat(64)
        ), /actor|role|audit/i);
    } finally {
        db.close();
    }
});

test('plan, review and acceptance cannot cross revisions or accept a failed review', () => {
    const db = build();
    try {
        db.exec(`
            INSERT INTO dataset_instances(id,code,version,seed,generated_at) VALUES ('DATASET-T','camera-demo',1,'fixed','2026-09-01T00:00:00.000Z');
            INSERT INTO lines(id,code,name) VALUES ('LINE-T','T','Test');
            INSERT INTO equipment(id,line_id,code,name) VALUES ('EQ-T','LINE-T','T','Test');
            INSERT INTO modules(id,equipment_id,code,name) VALUES ('MOD-T','EQ-T','T','Test');
            INSERT INTO recipe_revisions(id,recipe_code,revision,effective_at) VALUES ('REC-T','T',1,'2026-09-01T00:00:00.000Z');
            INSERT INTO product_families(id,code,name) VALUES ('FAM-T','CAM-T','Synthetic camera');
            INSERT INTO characteristics(id,product_family_id,code,name,unit) VALUES ('CHAR-T','FAM-T','ALIGN','Synthetic alignment','mm');
            INSERT INTO lots(id,product_family_id,code,quantity,start_at,end_at)
                VALUES ('LOT-T','FAM-T','LOT-T',2,'2026-09-01T02:00:00.000Z','2026-09-01T05:00:00.000Z');
            INSERT INTO process_runs(id,lot_id,equipment_id,module_id,recipe_revision_id,start_at,end_at,processed_units)
                VALUES ('RUN-T','LOT-T','EQ-T','MOD-T','REC-T','2026-09-01T02:10:00.000Z','2026-09-01T04:50:00.000Z',2);
            INSERT INTO inspection_samples(id,lot_id,process_run_id,sampled_at,sample_size)
                VALUES ('SAMPLE-T','LOT-T','RUN-T','2026-09-01T03:00:00.000Z',2);
            INSERT INTO measurements(id,inspection_sample_id,characteristic_id,value,unit,method,recorded_at)
                VALUES ('MEAS-T-1','SAMPLE-T','CHAR-T',0.03,'mm','synthetic gauge','2026-09-01T03:00:00.000Z');
            INSERT INTO measurements(id,inspection_sample_id,characteristic_id,value,unit,method,recorded_at)
                VALUES ('MEAS-T-2','SAMPLE-T','CHAR-T',0.04,'mm','synthetic gauge','2026-09-01T03:01:00.000Z');
            INSERT INTO changes(id,title,proposer_actor_id,line_id,equipment_id,module_id,recipe_revision_id,reason,baseline_ref,state,created_at,updated_at)
                VALUES ('CHG-T','Test','ACT-MFG','LINE-T','EQ-T','MOD-T','REC-T','Test reason','EVID-T','Draft','2026-09-01T01:00:00.000Z','2026-09-01T01:00:00.000Z');
            INSERT INTO change_revisions(id,change_id,revision_no,created_by,created_at,reason) VALUES ('REV-1','CHG-T',1,'ACT-MFG','2026-09-01T01:00:00.000Z','Original');
            INSERT INTO change_revisions(id,change_id,revision_no,parent_revision_id,created_by,created_at,reason) VALUES ('REV-2','CHG-T',2,'REV-1','ACT-MFG','2026-09-01T02:00:00.000Z','Rework');
            INSERT INTO risk_assessments(id,change_revision_id,rule_version,inputs_json,score,matched_rule,computed_level,assessed_by,assessed_at)
                VALUES ('RISK-1','REV-1','FA-DEMO-RISK-1.0','{}',4,'R06','L1','ACT-Q1','2026-09-01T01:00:00.000Z');
            INSERT INTO risk_assessments(id,change_revision_id,rule_version,inputs_json,score,matched_rule,computed_level,assessed_by,assessed_at)
                VALUES ('RISK-2','REV-2','FA-DEMO-RISK-1.0','{}',4,'R06','L1','ACT-Q1','2026-09-01T02:00:00.000Z');
        `);
        const insertPlan = db.prepare('INSERT INTO verification_plans(id,change_revision_id,assessment_id,revision_no,final_level,baseline_lots,post_change_lots,samples_per_lot,effectiveness_lots,effectiveness_days,max_aoi_reject_rate,alignment_abs_limit,criteria_json,approved_by,approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        const planArgs = (id, revision, risk) => [id, revision, risk, 1, 'L1', 1, 1, 5, 2, 0, 0.02, 0.08, '{}', 'ACT-Q1', '2026-09-01T03:00:00.000Z'];
        assert.throws(() => insertPlan.run(...planArgs('PLAN-BAD', 'REV-1', 'RISK-2')));
        insertPlan.run(...planArgs('PLAN-1', 'REV-1', 'RISK-1'));
        insertPlan.run(...planArgs('PLAN-2', 'REV-2', 'RISK-2'));
        const insertEvidence = db.prepare('INSERT INTO evidence_items(id,change_revision_id,source_table,source_id,evidence_type,payload_json,sha256,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)');
        assert.throws(() => insertEvidence.run('EVID-MISSING', 'REV-1', 'measurements', 'MEAS-MISSING', 'measurement', '{}', 'c'.repeat(64), 'ACT-VER', '2026-09-01T03:00:00.000Z'), /source|missing|reference/i);
        assert.throws(() => insertEvidence.run('EVID-UNSUPPORTED', 'REV-1', 'other_table', 'MEAS-T-1', 'measurement', '{}', 'c'.repeat(64), 'ACT-VER', '2026-09-01T03:00:00.000Z'), /source|unsupported/i);
        assert.throws(() => insertEvidence.run('EVID-NOTE-BAD', 'REV-1', 'embedded_note', 'OTHER', 'note', '{"text":"Synthetic observation"}', 'c'.repeat(64), 'ACT-VER', '2026-09-01T03:00:00.000Z'), /source|missing|reference/i);
        assert.throws(() => insertEvidence.run('EVID-NOTE-EMPTY', 'REV-1', 'embedded_note', 'EVID-NOTE-EMPTY', 'note', '{}', 'c'.repeat(64), 'ACT-VER', '2026-09-01T03:00:00.000Z'), /source|missing|reference/i);
        insertEvidence.run('EVID-NOTE', 'REV-1', 'embedded_note', 'EVID-NOTE', 'note', '{"text":"Synthetic observation"}', 'c'.repeat(64), 'ACT-VER', '2026-09-01T03:00:00.000Z');
        insertEvidence.run('EVID-1', 'REV-1', 'measurements', 'MEAS-T-1', 'measurement', '{}', 'a'.repeat(64), 'ACT-VER', '2026-09-01T03:00:00.000Z');
        insertEvidence.run('EVID-2', 'REV-2', 'measurements', 'MEAS-T-2', 'measurement', '{}', 'b'.repeat(64), 'ACT-VER', '2026-09-01T03:00:00.000Z');
        db.prepare("INSERT INTO plan_criteria(id,plan_id,code,comparison,threshold,unit,required) VALUES ('CRIT-1','PLAN-1','ALIGN','<=',0.08,'mm',1)").run();
        const insertResult = db.prepare('INSERT INTO criterion_results(id,plan_id,criterion_code,evidence_id,verifier_actor_id,passed,observed_value,unit,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)');
        assert.throws(() => insertResult.run('RESULT-CROSS', 'PLAN-1', 'ALIGN', 'EVID-2', 'ACT-VER', 1, 0.03, 'mm', '2026-09-01T03:30:00.000Z'), /revision|evidence|foreign/i);
        insertResult.run('RESULT-1', 'PLAN-1', 'ALIGN', 'EVID-1', 'ACT-VER', 1, 0.03, 'mm', '2026-09-01T03:30:00.000Z');
        const insertOverride = db.prepare('INSERT INTO risk_overrides(id,assessment_id,from_level,to_level,rationale,evidence_id,requester_actor_id,recorded_at) VALUES (?,?,?,?,?,?,?,?)');
        assert.throws(() => insertOverride.run('OVR-ORPHAN', 'RISK-MISSING', 'L1', 'L2', 'Synthetic reason', 'EVID-1', 'ACT-Q1', '2026-09-01T03:40:00.000Z'));
        assert.throws(() => insertOverride.run('OVR-CROSS', 'RISK-1', 'L1', 'L2', 'Synthetic reason', 'EVID-2', 'ACT-Q1', '2026-09-01T03:40:00.000Z'), /revision|evidence|foreign/i);
        insertOverride.run('OVR-1', 'RISK-1', 'L1', 'L2', 'Synthetic reason', 'EVID-1', 'ACT-Q1', '2026-09-01T03:40:00.000Z');
        assert.throws(() => db.prepare("INSERT INTO deviations(id,plan_id,description,blocking,disposition,recorded_by,recorded_at) VALUES ('DEV-ORPHAN','PLAN-MISSING','Synthetic deviation',1,'Open','ACT-VER','2026-09-01T03:40:00.000Z')").run());
        db.prepare("INSERT INTO reviews(id,change_revision_id,plan_id,reviewer_actor_id,decision,reason,evidence_set_digest,reviewed_at) VALUES ('REVIEW-FAIL','REV-1','PLAN-1','ACT-REV','Needs Rework','Failed criterion',?,'2026-09-01T04:00:00.000Z')").run('a'.repeat(64));
        db.prepare("INSERT INTO reviews(id,change_revision_id,plan_id,reviewer_actor_id,decision,reason,evidence_set_digest,reviewed_at) VALUES ('REVIEW-PASS','REV-2','PLAN-2','ACT-REV','Pass','Complete',?,'2026-09-01T04:00:00.000Z')").run('b'.repeat(64));
        const accept = db.prepare('INSERT INTO acceptances(id,change_revision_id,plan_id,review_id,approver_actor_id,accepted_at,frozen_digest) VALUES (?,?,?,?,?,?,?)');
        assert.throws(() => accept.run('ACCEPT-FAIL', 'REV-1', 'PLAN-1', 'REVIEW-FAIL', 'ACT-APP', '2026-09-01T05:00:00.000Z', 'c'.repeat(64)));
        assert.throws(() => accept.run('ACCEPT-CROSS', 'REV-1', 'PLAN-1', 'REVIEW-PASS', 'ACT-APP', '2026-09-01T05:00:00.000Z', 'c'.repeat(64)));
        assert.throws(() => accept.run('ACCEPT-DIGEST', 'REV-2', 'PLAN-2', 'REVIEW-PASS', 'ACT-APP', '2026-09-01T05:00:00.000Z', 'c'.repeat(64)), /digest/i);
        assert.throws(() => accept.run('ACCEPT-NOAUDIT', 'REV-2', 'PLAN-2', 'REVIEW-PASS', 'ACT-APP', '2026-09-01T05:00:00.000Z', 'b'.repeat(64)), /audit/i);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n, 0);
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
        db.close();
    }
});

test('revision parents cannot cross changes or incidents', () => {
    const db = build();
    try {
        db.exec(`
            INSERT INTO dataset_instances(id,code,version,seed,generated_at) VALUES ('DATASET-P','camera-demo',1,'fixed','2026-09-01T00:00:00.000Z');
            INSERT INTO lines(id,code,name) VALUES ('LINE-P','P','Parent test');
            INSERT INTO equipment(id,line_id,code,name) VALUES ('EQ-P','LINE-P','P','Parent cell');
            INSERT INTO modules(id,equipment_id,code,name) VALUES ('MOD-P','EQ-P','P','Parent module');
            INSERT INTO recipe_revisions(id,recipe_code,revision,effective_at) VALUES ('REC-P','P',1,'2026-09-01T00:00:00.000Z');
            INSERT INTO defect_codes(id,code,name,severity) VALUES ('DEF-P','P','Synthetic defect','major');
            INSERT INTO changes(id,title,proposer_actor_id,line_id,equipment_id,module_id,recipe_revision_id,reason,baseline_ref,state,created_at,updated_at)
                VALUES ('CHG-P1','First','ACT-MFG','LINE-P','EQ-P','MOD-P','REC-P','Reason','Baseline','Draft','2026-09-01T01:00:00.000Z','2026-09-01T01:00:00.000Z');
            INSERT INTO changes(id,title,proposer_actor_id,line_id,equipment_id,module_id,recipe_revision_id,reason,baseline_ref,state,created_at,updated_at)
                VALUES ('CHG-P2','Second','ACT-MFG','LINE-P','EQ-P','MOD-P','REC-P','Reason','Baseline','Draft','2026-09-01T01:00:00.000Z','2026-09-01T01:00:00.000Z');
            INSERT INTO change_revisions(id,change_id,revision_no,created_by,created_at,reason)
                VALUES ('CHG-REV-P1','CHG-P1',1,'ACT-MFG','2026-09-01T01:00:00.000Z','Initial');
            INSERT INTO change_revisions(id,change_id,revision_no,created_by,created_at,reason)
                VALUES ('CHG-REV-P2','CHG-P2',1,'ACT-MFG','2026-09-01T01:00:00.000Z','Initial');
            INSERT INTO incidents(id,title,proposer_actor_id,defect_code_id,equipment_id,module_id,detected_at,state,created_at,updated_at)
                VALUES ('INC-P1','First','ACT-Q1','DEF-P','EQ-P','MOD-P','2026-09-01T02:00:00.000Z','Open','2026-09-01T02:00:00.000Z','2026-09-01T02:00:00.000Z');
            INSERT INTO incidents(id,title,proposer_actor_id,defect_code_id,equipment_id,module_id,detected_at,state,created_at,updated_at)
                VALUES ('INC-P2','Second','ACT-Q1','DEF-P','EQ-P','MOD-P','2026-09-01T02:00:00.000Z','Open','2026-09-01T02:00:00.000Z','2026-09-01T02:00:00.000Z');
            INSERT INTO incident_revisions(id,incident_id,revision_no,reason,created_by,created_at)
                VALUES ('INC-REV-P1','INC-P1',1,'Initial','ACT-Q1','2026-09-01T02:00:00.000Z');
            INSERT INTO incident_revisions(id,incident_id,revision_no,reason,created_by,created_at)
                VALUES ('INC-REV-P2','INC-P2',1,'Initial','ACT-Q1','2026-09-01T02:00:00.000Z');
        `);
        assert.throws(() => db.prepare("INSERT INTO change_revisions(id,change_id,revision_no,parent_revision_id,created_by,created_at,reason) VALUES ('CHG-REV-BAD','CHG-P2',2,'CHG-REV-P1','ACT-MFG','2026-09-01T03:00:00.000Z','Cross parent')").run(), /parent|foreign|revision/i);
        assert.throws(() => db.prepare("INSERT INTO incident_revisions(id,incident_id,revision_no,parent_revision_id,reason,created_by,created_at) VALUES ('INC-REV-BAD','INC-P2',2,'INC-REV-P1','Cross parent','ACT-Q1','2026-09-01T03:00:00.000Z')").run(), /parent|foreign|revision/i);
        assert.throws(() => db.prepare("INSERT INTO change_revisions(id,change_id,revision_no,created_by,created_at,reason) VALUES ('CHG-REV-SKIP','CHG-P2',2,'ACT-MFG','2026-09-01T03:00:00.000Z','Missing parent')").run(), /parent|revision/i);
        assert.throws(() => db.prepare("INSERT INTO incident_revisions(id,incident_id,revision_no,reason,created_by,created_at) VALUES ('INC-REV-SKIP','INC-P2',2,'Missing parent','ACT-Q1','2026-09-01T03:00:00.000Z')").run(), /parent|revision/i);
        assert.throws(() => db.prepare("INSERT INTO change_revisions(id,change_id,revision_no,parent_revision_id,created_by,created_at,reason) VALUES ('CHG-REV-GAP','CHG-P2',3,'CHG-REV-P2','ACT-MFG','2026-09-01T03:00:00.000Z','Wrong parent number')").run(), /parent|revision/i);
        assert.throws(() => db.prepare("INSERT INTO incident_revisions(id,incident_id,revision_no,parent_revision_id,reason,created_by,created_at) VALUES ('INC-REV-GAP','INC-P2',3,'INC-REV-P2','Wrong parent number','ACT-Q1','2026-09-01T03:00:00.000Z')").run(), /parent|revision/i);
        assert.throws(() => db.prepare("INSERT INTO change_revisions(id,change_id,revision_no,parent_revision_id,created_by,created_at,reason) VALUES ('CHG-REV-TEXT','CHG-P2','2x','CHG-REV-P2','ACT-MFG','2026-09-01T03:00:00.000Z','Invalid number')").run(), /revision|check|constraint/i);
        assert.throws(() => db.prepare("INSERT INTO incident_revisions(id,incident_id,revision_no,parent_revision_id,reason,created_by,created_at) VALUES ('INC-REV-TEXT','INC-P2','2x','INC-REV-P2','Invalid number','ACT-Q1','2026-09-01T03:00:00.000Z')").run(), /revision|check|constraint/i);
        db.prepare("INSERT INTO change_revisions(id,change_id,revision_no,parent_revision_id,created_by,created_at,reason) VALUES ('CHG-REV-P2-2','CHG-P2',2,'CHG-REV-P2','ACT-MFG','2026-09-01T03:00:00.000Z','Valid child')").run();
        db.prepare("INSERT INTO incident_revisions(id,incident_id,revision_no,parent_revision_id,reason,created_by,created_at) VALUES ('INC-REV-P2-2','INC-P2',2,'INC-REV-P2','Valid child','ACT-Q1','2026-09-01T03:00:00.000Z')").run();
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
        db.close();
    }
});

test('actor roles and workflow states reject unsupported values', () => {
    const db = build();
    try {
        assert.throws(() => db.prepare("INSERT INTO demo_actors(id,role,display_name) VALUES ('BAD','Administrator','Bad')").run());
        db.prepare("INSERT INTO dataset_instances(id,code,version,seed,generated_at) VALUES ('DATASET-T','camera-demo',1,'fixed','2026-09-01T00:00:00.000Z')").run();
        db.prepare("INSERT INTO lines(id,code,name) VALUES ('LINE-T','T','Test')").run();
        db.prepare("INSERT INTO equipment(id,line_id,code,name) VALUES ('EQ-T','LINE-T','T','Test')").run();
        db.prepare("INSERT INTO modules(id,equipment_id,code,name) VALUES ('MOD-T','EQ-T','T','Test')").run();
        db.prepare("INSERT INTO recipe_revisions(id,recipe_code,revision,effective_at) VALUES ('REC-T','T',1,'2026-09-01T00:00:00.000Z')").run();
        assert.throws(() => db.prepare("INSERT INTO changes(id,title,proposer_actor_id,line_id,equipment_id,module_id,recipe_revision_id,reason,baseline_ref,state,created_at,updated_at) VALUES ('CHG-T','Test','ACT-MFG','LINE-T','EQ-T','MOD-T','REC-T','Test reason','EVID-T','Accepted','2026-09-01T01:00:00.000Z','2026-09-01T01:00:00.000Z')").run(), /state|draft|check/i);
        db.prepare("INSERT INTO changes(id,title,proposer_actor_id,line_id,equipment_id,module_id,recipe_revision_id,reason,baseline_ref,state,created_at,updated_at) VALUES ('CHG-T','Test','ACT-MFG','LINE-T','EQ-T','MOD-T','REC-T','Test reason','EVID-T','Draft','2026-09-01T01:00:00.000Z','2026-09-01T01:00:00.000Z')").run();
        assert.throws(() => db.prepare("UPDATE changes SET state='Bogus' WHERE id='CHG-T'").run());
    } finally {
        db.close();
    }
});
