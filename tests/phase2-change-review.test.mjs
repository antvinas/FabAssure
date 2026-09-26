import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, withValidatedTransaction } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { appendAuditEvent, verifyAuditChain } from '../src/domain/audit.mjs';
import {
    createChange, submitChange, classifyChange, approvePlan, startVerification,
    recordBaselineSet, addMeasurementEvidence, recordAlignmentResult,
    addAoiEvidence, recordAoiResults, markEvidenceReady,
    beginIndependentReview, recordIndependentReview, reviseFailedChange
} from '../src/domain/change-service.mjs';

const riskInputs = {
    severity: 2, occurrence: 1, detectability: 2, scope: 1,
    criticalCharacteristic: true, safetyRelevance: false,
    bases: {
        severity: 'Synthetic alignment characteristic', occurrence: 'Three baseline lots below 1%',
        detectability: 'AOI and sampled alignment', scope: 'One module and recipe',
        criticalCharacteristic: 'ALIGN-X demo critical characteristic', safetyRelevance: 'No synthetic safety impact'
    }
};
const at = (day, time) => `2026-08-${String(day).padStart(2, '0')}T${time}.000Z`;
const suffix = day => String(day).padStart(3, '0');

function fixture(options, operation) {
    const db = openDatabase(':memory:');
    try {
        seedDatabase(db, { instanceId: 'DATASET-READY' });
        createChange(db, {
            id: 'CHG-A', title: 'Synthetic R3 verification', actorId: 'ACT-MFG',
            lineId: 'LINE-A', equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
            recipeRevisionId: 'REC-ALIGN-R3', baselineRef: 'AOI-A-001',
            reason: 'Verify synthetic alignment improvement', at: at(7, '12:00:00')
        });
        submitChange(db, { changeId: 'CHG-A', actorId: 'ACT-MFG', expectedRevisionNo: 1,
            at: at(7, '12:10:00') });
        classifyChange(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
            assessmentId: 'RISK-A', riskInputs, at: at(7, '12:20:00') });
        approvePlan(db, { changeId: 'CHG-A', actorId: 'ACT-Q1', expectedRevisionNo: 1,
            planId: 'PLAN-A', at: at(7, '12:30:00') });
        startVerification(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
            at: at(8, options.delayedStart ? '08:15:00' : '08:00:00') });
        if (options.baseline !== false) {
            recordBaselineSet(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
                evidenceId: 'EVID-BASE', at: at(8, options.delayedStart ? '08:16:00' : '08:01:00') });
        }
        for (let day = 8; day <= 12; day++) {
            for (let unit = 1; unit <= 20; unit++) {
                const id = `MEAS-A-${suffix(day)}-${String(unit).padStart(2, '0')}`;
                addMeasurementEvidence(db, {
                    changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
                    evidenceId: `EVID-${suffix(day)}-${String(unit).padStart(2, '0')}`,
                    measurementId: id, at: at(day, '10:01:00')
                });
            }
            if (options.aoiEvidence !== false) {
                addAoiEvidence(db, {
                    changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
                    evidenceId: `EVID-AOI-${suffix(day)}`, inspectionId: `AOI-A-${suffix(day)}`,
                    at: at(day, '10:31:00')
                });
            }
        }
        recordAlignmentResult(db, {
            changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
            resultId: 'RESULT-ALIGN', evidenceId: 'EVID-012-20', at: at(12, '12:01:00')
        });
        if (options.aoiResults !== false) {
            recordAoiResults(db, { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
                resultPrefix: 'RESULT-AOI', at: at(12, '12:02:00') });
        }
        return operation(db);
    } finally {
        db.close();
    }
}

const ready = { changeId: 'CHG-A', actorId: 'ACT-VER', expectedRevisionNo: 1,
    at: at(12, '12:03:00') };

const begin = { changeId: 'CHG-A', actorId: 'ACT-REV', expectedRevisionNo: 1,
    at: at(12, '12:04:00') };
const pass = { changeId: 'CHG-A', actorId: 'ACT-REV', expectedRevisionNo: 1,
    reviewId: 'REVIEW-A', decision: 'Pass', reason: 'Synthetic criteria and source evidence reconcile',
    at: at(12, '12:05:00') };

test('independent reviewer opens the frozen package and records a reasoned passing decision', () => fixture({}, db => {
    const frozen = markEvidenceReady(db, ready);
    const opened = beginIndependentReview(db, begin);
    assert.equal(opened.state, 'Independent Review');
    assert.equal(opened.packageDigest, frozen.packageDigest);
    const decision = recordIndependentReview(db, pass);
    assert.equal(decision.decision, 'Pass');
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Independent Review');
    const row = db.prepare("SELECT * FROM reviews WHERE id='REVIEW-A'").get();
    assert.equal(row.evidence_set_digest, frozen.packageDigest);
    assert.equal(row.reviewer_actor_id, 'ACT-REV');
    assert.equal(verifyAuditChain(db).count, 116);
}));

test('wrong role, stale revision, early time, and blank review reason cause no review mutation', () => fixture({}, db => {
    markEvidenceReady(db, ready);
    const before = verifyAuditChain(db).count;
    assert.throws(() => beginIndependentReview(db, { ...begin, actorId: 'ACT-VER' }), /Reviewer|independent/i);
    assert.throws(() => beginIndependentReview(db, { ...begin, expectedRevisionNo: 2 }), /stale/i);
    assert.throws(() => beginIndependentReview(db, { ...begin, at: at(12, '12:02:00') }), /time|ready/i);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Evidence Ready');
    beginIndependentReview(db, begin);
    db.prepare('INSERT INTO demo_actors(id,role,display_name) VALUES (?,?,?)')
        .run('ACT-REV2', 'Reviewer', 'Synthetic second reviewer');
    assert.throws(() => recordIndependentReview(db, { ...pass, actorId: 'ACT-REV2' }), /reviewer|actor/i);
    assert.throws(() => recordIndependentReview(db, { ...pass, reason: ' ' }), /reason/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n, 0);
    assert.equal(verifyAuditChain(db).count, before + 1);
}));

test('review cannot use a changed package after Evidence Ready', () => fixture({}, db => {
    markEvidenceReady(db, ready);
    const original = db.prepare("SELECT * FROM evidence_items WHERE id='EVID-008-01'").get();
    withValidatedTransaction(db, tx => {
        tx.prepare(`
            INSERT INTO evidence_items(id,change_revision_id,source_table,source_id,evidence_type,
                payload_json,sha256,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)
        `).run('EVID-LATE', original.change_revision_id, original.source_table,
            original.source_id, original.evidence_type, original.payload_json,
            original.sha256, 'ACT-VER', at(12, '12:03:30'));
        appendAuditEvent(tx, {
            actorId: 'ACT-VER', recordedAt: at(12, '12:03:30'), entityType: 'change',
            entityId: 'CHG-A', entityRevisionId: 'CHG-A-R1',
            action: 'measurement-evidence-added', linkedEvidenceIds: ['EVID-LATE'],
            payload: { evidenceId: 'EVID-LATE', measurementId: original.source_id,
                lotId: 'LOT-A-008', sha256: original.sha256 }
        });
    });
    assert.throws(() => beginIndependentReview(db, begin), /frozen|digest|changed/i);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Evidence Ready');
}));

test('reviewer may return a reasoned Needs Rework decision without erasing evidence', () => fixture({}, db => {
    const frozen = markEvidenceReady(db, ready);
    beginIndependentReview(db, begin);
    const decision = recordIndependentReview(db, { ...pass,
        decision: 'Needs Rework', reason: 'Synthetic deviation requires another recipe revision' });
    assert.equal(decision.state, 'Needs Rework');
    assert.equal(db.prepare("SELECT decision,evidence_set_digest FROM reviews WHERE id='REVIEW-A'").get()
        .evidence_set_digest, frozen.packageDigest);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Needs Rework');
    db.prepare('INSERT INTO recipe_revisions(id,recipe_code,revision,effective_at) VALUES (?,?,?,?)')
        .run('REC-ALIGN-R4', 'ALIGN-A', 4, at(13, '00:00:00'));
    const rework = {
        changeId: 'CHG-A', actorId: 'ACT-MFG', expectedRevisionNo: 1,
        failedReviewId: 'REVIEW-A', newRecipeRevisionId: 'REC-ALIGN-R4',
        reason: 'Synthetic reviewer finding corrected by new recipe', at: at(13, '00:01:00')
    };
    assert.throws(() => reviseFailedChange(db, { ...rework, failedReviewId: 'UNKNOWN' }), /review/i);
    assert.throws(() => reviseFailedChange(db, { ...rework, actorId: 'ACT-Q1' }), /proposer/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM change_revisions WHERE change_id='CHG-A'").get().n, 1);
    const revised = reviseFailedChange(db, rework);
    assert.equal(revised.revisionNo, 2);
    assert.equal(revised.state, 'Draft');
    assert.equal(db.prepare("SELECT decision,evidence_set_digest FROM reviews WHERE id='REVIEW-A'").get()
        .evidence_set_digest, frozen.packageDigest);
    assert.equal(db.prepare("SELECT current_revision_no,state FROM changes WHERE id='CHG-A'").get().state, 'Draft');
    assert.equal(verifyAuditChain(db).count, 117);
}));

test('review rework rejects a stored rationale that conflicts with its audit event', () => fixture({}, db => {
    markEvidenceReady(db, ready);
    beginIndependentReview(db, begin);
    recordIndependentReview(db, { ...pass, decision: 'Needs Rework' });
    db.prepare('INSERT INTO recipe_revisions(id,recipe_code,revision,effective_at) VALUES (?,?,?,?)')
        .run('REC-ALIGN-R4', 'ALIGN-A', 4, at(13, '00:00:00'));
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='immutable_review_update'").get();
    assert.ok(trigger);
    db.exec('DROP TRIGGER immutable_review_update');
    db.prepare("UPDATE reviews SET reason=? WHERE id='REVIEW-A'")
        .run('Conflicting synthetic review rationale');
    db.exec(trigger.sql);
    assert.throws(() => reviseFailedChange(db, {
        changeId: 'CHG-A', actorId: 'ACT-MFG', expectedRevisionNo: 1,
        failedReviewId: 'REVIEW-A', newRecipeRevisionId: 'REC-ALIGN-R4',
        reason: 'Revise after reviewed finding', at: at(13, '00:01:00')
    }), /review audit|reason|provenance/i);
    assert.equal(db.prepare("SELECT state FROM changes WHERE id='CHG-A'").get().state, 'Needs Rework');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM change_revisions WHERE change_id='CHG-A'").get().n, 1);
}));
