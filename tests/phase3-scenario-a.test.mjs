import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAppliance } from '../src/server/main.mjs';
import { openDatabase } from '../src/data/db.mjs';

const at = (day, time) => `2026-08-${String(day).padStart(2, '0')}T${time}.000Z`;
const suffix = day => String(day).padStart(3, '0');
const riskInputs = {
    severity: 2, occurrence: 1, detectability: 2, scope: 1,
    criticalCharacteristic: true, safetyRelevance: false,
    bases: {
        severity: 'Synthetic alignment impact', occurrence: 'Three baseline lots below 1%',
        detectability: 'AOI and sampled alignment', scope: 'One module and recipe',
        criticalCharacteristic: 'ALIGN-X demo critical characteristic',
        safetyRelevance: 'No synthetic safety impact'
    }
};

test('Scenario A preserves failed R2 and reaches source-derived L3 monitoring closure through HTTP', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fabassure-scenario-a-'));
    const ui = join(root, 'assets', 'ui');
    mkdirSync(ui, { recursive: true });
    const source = fileURLToPath(new URL('../assets/ui/', import.meta.url));
    for (const name of ['index.html', 'app.js', 'styles.css']) copyFileSync(join(source, name), join(ui, name));
    let app;
    try {
        app = await startAppliance({ root, port: 0 });
        const call = async (action, input, expected = 200) => {
            const response = await fetch(`${app.url}/api/actions`, { method: 'POST', headers: {
                'content-type': 'application/json', 'x-fabassure-local': '1', origin: app.url
            }, body: JSON.stringify({ action, input }) });
            const body = await response.json();
            assert.equal(response.status, expected, `${action}: ${JSON.stringify(body)}`);
            return body;
        };
        const changeId = 'CHG-SCENARIO-A';
        const base = (actorId, expectedRevisionNo) => ({ changeId, actorId, expectedRevisionNo });
        await call('createChange', { id: changeId, title: 'Synthetic recipe verification',
            actorId: 'ACT-MFG', lineId: 'LINE-A', equipmentId: 'EQ-ALIGN-A',
            moduleId: 'MOD-ALIGN-A', recipeRevisionId: 'REC-ALIGN-R2',
            baselineRef: 'AOI-A-001', reason: 'Reduce fictional alignment variation',
            at: at(5, '12:00:00') });
        await call('submitChange', { ...base('ACT-MFG', 1), at: at(5, '12:10:00') });
        await call('classifyChange', { ...base('ACT-Q1', 1), assessmentId: 'RISK-A-R1',
            riskInputs, at: at(5, '12:20:00') });
        await call('approvePlan', { ...base('ACT-Q1', 1), planId: 'PLAN-A-R1',
            at: at(5, '12:30:00') });
        await call('startVerification', { ...base('ACT-VER', 1), at: at(6, '08:00:00') });
        await call('recordBaselineSet', { ...base('ACT-VER', 1), evidenceId: 'EVID-A-R1-BASE',
            at: at(6, '08:01:00') });
        await call('addMeasurementEvidence', { ...base('ACT-VER', 1),
            evidenceId: 'EVID-A-R1-FAIL', measurementId: 'MEAS-A-006-07',
            at: at(6, '10:01:00') });
        const failed = await call('recordAlignmentResult', { ...base('ACT-VER', 1),
            resultId: 'RESULT-A-R1-FAIL', evidenceId: 'EVID-A-R1-FAIL',
            at: at(6, '10:02:00') });
        assert.equal(failed.result.passed, false);
        assert.equal((await (await fetch(`${app.url}/api/changes/${changeId}`)).json()).change.state,
            'Needs Rework');
        await call('beginIndependentReview', { ...base('ACT-REV', 1),
            at: at(6, '10:03:00') }, 409);
        await call('reviseFailedChange', { ...base('ACT-MFG', 1),
            failedResultId: 'RESULT-A-R1-FAIL', newRecipeRevisionId: 'REC-ALIGN-R3',
            reason: 'Correct fictional R2 offset; retain failed source',
            at: at(7, '12:00:00') });
        await call('submitChange', { ...base('ACT-MFG', 2), at: at(7, '12:10:00') });
        await call('classifyChange', { ...base('ACT-Q1', 2), assessmentId: 'RISK-A-R2',
            riskInputs, at: at(7, '12:20:00') });
        await call('approvePlan', { ...base('ACT-Q1', 2), planId: 'PLAN-A-R2',
            at: at(7, '12:30:00') });
        await call('startVerification', { ...base('ACT-VER', 2), at: at(8, '08:00:00') });
        await call('recordBaselineSet', { ...base('ACT-VER', 2), evidenceId: 'EVID-A-R2-BASE',
            at: at(8, '08:01:00') });
        for (let day = 8; day <= 12; day++) {
            for (let unit = 1; unit <= 20; unit++) {
                const unitSuffix = String(unit).padStart(2, '0');
                await call('addMeasurementEvidence', { ...base('ACT-VER', 2),
                    evidenceId: `EVID-A-R2-${suffix(day)}-${unitSuffix}`,
                    measurementId: `MEAS-A-${suffix(day)}-${unitSuffix}`,
                    at: at(day, '10:01:00') });
            }
            await call('addAoiEvidence', { ...base('ACT-VER', 2),
                evidenceId: `EVID-A-R2-AOI-${suffix(day)}`,
                inspectionId: `AOI-A-${suffix(day)}`, at: at(day, '10:31:00') });
        }
        await call('recordAlignmentResult', { ...base('ACT-VER', 2),
            resultId: 'RESULT-A-R2-ALIGN', evidenceId: 'EVID-A-R2-012-20',
            at: at(12, '12:01:00') });
        await call('recordAoiResults', { ...base('ACT-VER', 2),
            resultPrefix: 'RESULT-A-R2-AOI', at: at(12, '12:02:00') });
        const ready = await call('markEvidenceReady', { ...base('ACT-VER', 2),
            at: at(12, '12:03:00') });
        assert.equal(ready.result.state, 'Evidence Ready');
        await call('beginIndependentReview', { ...base('ACT-MFG', 2),
            at: at(12, '12:04:00') }, 409);
        await call('beginIndependentReview', { ...base('ACT-REV', 2),
            at: at(12, '12:04:00') });
        await call('recordIndependentReview', { ...base('ACT-REV', 2),
            reviewId: 'REVIEW-A-R2', decision: 'Pass',
            reason: 'Synthetic source and criteria reconciled independently',
            at: at(12, '12:05:00') });
        await call('acceptChange', { ...base('ACT-VER', 2),
            acceptanceId: 'ACCEPT-WRONG', reviewId: 'REVIEW-A-R2',
            reason: 'Verifier may not accept', at: at(12, '12:06:00'),
            acceptanceType: 'Ordinary' }, 409);
        await call('acceptChange', { ...base('ACT-APP', 2),
            acceptanceId: 'ACCEPT-A-R2', reviewId: 'REVIEW-A-R2',
            reason: 'Synthetic acceptance after independent review',
            at: at(12, '12:06:00'), acceptanceType: 'Ordinary' });
        const detailResponse = await fetch(`${app.url}/api/changes/${changeId}`);
        assert.equal(detailResponse.status, 200);
        const detail = await detailResponse.json();
        assert.equal(detail.change.state, 'Accepted');
        assert.equal(detail.revisions.length, 2);
        assert.equal(detail.revisions[0].results[0].passed, 0);
        assert.equal(detail.revisions[0].evidence.find(item => item.id === 'EVID-A-R1-FAIL').source.value, 0.1);
        assert.equal(detail.revisions[1].evidence.length, 106);
        const baseline = detail.revisions[1].evidence.find(item => item.evidence_type === 'baseline-set');
        assert.equal(baseline.payload.lotIds.length, 3);
        assert.equal(baseline.payload.sampledUnits, 60);
        assert.equal(detail.revisions[1].evidence.find(item => item.source_id === 'MEAS-A-008-01').source.lot_id,
            'LOT-A-008');
        assert.equal(detail.revisions[1].evidence.find(item => item.source_id === 'AOI-A-008').source.lot_id,
            'LOT-A-008');
        assert.equal(detail.revisions[1].acceptances[0].frozen_digest,
            detail.revisions[1].reviews[0].evidence_set_digest);
        for (let index = 1; index < detail.audit.length; index++) {
            assert.equal(detail.audit[index].previous_digest, detail.audit[index - 1].digest);
        }
        const earlyMonitor = await call('evaluateChangeEffectiveness', {
            ...base('ACT-Q1', 2), id: 'EFF-A-R2-EARLY',
            at: at(19, '12:30:00') });
        assert.equal(earlyMonitor.result.status, 'Monitoring');
        assert.equal(earlyMonitor.result.lotCount, 7);
        await call('closeChangeMonitoring', {
            ...base('ACT-APP', 2), id: 'CLOSE-A-TOO-EARLY',
            checkId: 'EFF-A-R2-EARLY',
            reason: 'Seven lots do not meet L3 monitoring',
            at: at(19, '12:31:00')
        }, 409);
        const passedMonitor = await call('evaluateChangeEffectiveness', {
            ...base('ACT-Q1', 2), id: 'EFF-A-R2-PASS',
            at: at(22, '12:30:00') });
        assert.equal(passedMonitor.result.status, 'Pass');
        assert.equal(passedMonitor.result.lotCount, 10);
        assert.deepEqual(passedMonitor.result.lotIds,
            Array.from({ length: 10 }, (_, index) => `LOT-A-${suffix(index + 13)}`));
        const closed = await call('closeChangeMonitoring', {
            ...base('ACT-APP', 2), id: 'CLOSE-A-R2',
            checkId: 'EFF-A-R2-PASS',
            reason: 'Ten later synthetic lots and calendar span meet L3 monitoring',
            at: at(22, '12:31:00') });
        assert.equal(closed.result.state, 'Closed');
        const final = await fetch(`${app.url}/api/changes/${changeId}`)
            .then(response => response.json());
        assert.equal(final.change.state, 'Closed');
        assert.equal(final.revisions[0].results[0].passed, 0);
        assert.equal(final.revisions[1].acceptances[0].frozen_digest,
            detail.revisions[1].acceptances[0].frozen_digest);
        assert.deepEqual(final.revisions[1].effectivenessChecks.map(item => item.id),
            ['EFF-A-R2-EARLY', 'EFF-A-R2-PASS']);
        assert.equal(final.audit.filter(item => item.action === 'change-monitoring-closed')
            .length, 1);
        await app.close();
        app = null;
        const reopened = openDatabase(join(root, 'data', 'fabassure-demo.sqlite'));
        try {
            assert.equal(reopened.prepare('SELECT state FROM changes WHERE id=?')
                .get(changeId).state, 'Closed');
            assert.deepEqual(reopened.prepare(`SELECT id FROM effectiveness_checks
                WHERE change_revision_id='CHG-SCENARIO-A-R2' ORDER BY recorded_at`)
                .all().map(item => item.id), ['EFF-A-R2-EARLY', 'EFF-A-R2-PASS']);
            assert.equal(reopened.prepare(`SELECT COUNT(*) AS n FROM audit_events
                WHERE entity_id=? AND action='change-monitoring-closed'`)
                .get(changeId).n, 1);
        } finally { reopened.close(); }
    } finally {
        await app?.close();
        rmSync(root, { recursive: true, force: true });
    }
});
