import test from 'node:test';
import assert from 'node:assert/strict';
import { assessEffectiveness, EFFECTIVENESS_RULE_VERSION } from '../src/domain/effectiveness.mjs';

function lots(count, { firstDay = 1, lastDay = count, inspected = 100,
    rejected = 0, target = 0, critical = 0, offset = 0.04 } = {}) {
    return Array.from({ length: count }, (_, index) => {
        const day = count === 1 ? firstDay : firstDay +
            Math.floor(index * (lastDay - firstDay) / (count - 1));
        const date = `2026-09-${String(day).padStart(2, '0')}`;
        return { lotId: `LOT-E-${String(index + 1).padStart(3, '0')}`,
            startAt: `${date}T08:00:00.000Z`, endAt: `${date}T12:00:00.000Z`,
            processedUnits: 100, inspectedUnits: inspected, rejectedUnits: rejected,
            targetedDefects: target, criticalDefects: critical,
            measurements: [{ id: `MEAS-E-${index + 1}`, absoluteOffsetMm: offset }] };
    });
}

const change = (finalLevel, observedLots, extra = {}) => ({ cycleType: 'change',
    finalLevel, targetedDefectCodeId: 'DEF-FIDUCIAL',
    absoluteOffsetLimitMm: 0.08, afterAt: '2026-08-31T00:00:00.000Z',
    lots: observedLots,
    unresolvedRelatedAlarm: false, unresolvedBlockingDeviation: false, ...extra });

const incident = (observedLots, extra = {}) => ({ cycleType: 'incident',
    targetedDefectCodeId: 'DEF-FIDUCIAL',
    afterAt: '2026-08-31T00:00:00.000Z', lots: observedLots,
    criticalIncident: false, linkedL3: false,
    unresolvedRelatedAlarm: false, unresolvedBlockingDeviation: false, ...extra });

test('L1 needs two subsequent lots; complete AOI and measurements permit Pass', () => {
    const incomplete = assessEffectiveness(change('L1', lots(1)));
    assert.equal(incomplete.status, 'Monitoring');
    assert.equal(incomplete.requiredLots, 2);
    const passed = assessEffectiveness(change('L1', lots(2)));
    assert.equal(passed.status, 'Pass');
    assert.equal(passed.ruleVersion, EFFECTIVENESS_RULE_VERSION);
    assert.equal(passed.inspectedUnits, 200);
    assert.equal(passed.aoiRejectRate, 0);
});

test('L2 needs five subsequent lots', () => {
    assert.equal(assessEffectiveness(change('L2', lots(4))).status, 'Monitoring');
    const passed = assessEffectiveness(change('L2', lots(5)));
    assert.equal(passed.status, 'Pass');
    assert.equal(passed.requiredLots, 5);
});

test('L3 needs ten subsequent lots spanning seven UTC calendar days', () => {
    const sixDays = assessEffectiveness(change('L3', lots(10, { lastDay: 7 })));
    assert.equal(sixDays.status, 'Monitoring');
    assert.equal(sixDays.requiredLots, 10);
    assert.equal(sixDays.observedCalendarDays, 6);
    assert.equal(assessEffectiveness(change('L3', lots(10, { lastDay: 8 }))).status, 'Pass');
    assert.equal(assessEffectiveness(change('L3', lots(9, { lastDay: 8 }))).status,
        'Monitoring');
});

test('FabTrace CAPA needs five or ten later lots and seven calendar days', () => {
    assert.equal(assessEffectiveness(incident(lots(5, { lastDay: 8 }))).status, 'Pass');
    assert.equal(assessEffectiveness(incident(lots(5, { lastDay: 7 }))).status,
        'Monitoring');
    assert.equal(assessEffectiveness(incident(lots(5, { lastDay: 8 }),
        { criticalIncident: true })).status, 'Monitoring');
    assert.equal(assessEffectiveness(incident(lots(10, { lastDay: 8 }),
        { linkedL3: true })).status, 'Pass');
});

test('target recurrence or unresolved alarm requires reopen even before window completes', () => {
    const recurrence = lots(1, { rejected: 1, target: 1 });
    assert.equal(assessEffectiveness(incident(recurrence)).status, 'Reopen Required');
    assert.match(assessEffectiveness(incident(recurrence)).reasons.join(' '), /target.*recurrence/i);
    assert.equal(assessEffectiveness(change('L2', lots(1),
        { unresolvedRelatedAlarm: true })).status, 'Reopen Required');
});

test('AOI 2% boundary uses inspected units, while missing coverage stays Monitoring', () => {
    const atLimit = lots(5, { lastDay: 8, rejected: 2 });
    const passed = assessEffectiveness(incident(atLimit));
    assert.equal(passed.status, 'Pass');
    assert.equal(passed.aoiRejectRate, 0.02);
    assert.equal(assessEffectiveness(incident(lots(5,
        { lastDay: 8, rejected: 3 }))).status, 'Reopen Required');
    assert.equal(assessEffectiveness(incident(lots(5,
        { lastDay: 8, inspected: 99 }))).status, 'Monitoring');
});

test('critical AOI defect, failed measurement and unresolved deviation block closure', () => {
    assert.equal(assessEffectiveness(change('L1', lots(2,
        { rejected: 1, critical: 1 }))).status, 'Reopen Required');
    assert.equal(assessEffectiveness(change('L1', lots(2,
        { offset: 0.10 }))).status, 'Reopen Required');
    assert.equal(assessEffectiveness(change('L1', lots(2),
        { unresolvedBlockingDeviation: true })).status, 'Reopen Required');
    const missingMeasurement = lots(2);
    missingMeasurement[0].measurements = [];
    assert.equal(assessEffectiveness(change('L1', missingMeasurement)).status,
        'Monitoring');
});

test('invalid or duplicate source summaries cannot produce a passing decision', () => {
    const duplicate = lots(2);
    duplicate[1].lotId = duplicate[0].lotId;
    assert.throws(() => assessEffectiveness(change('L1', duplicate)), /duplicate/i);
    assert.throws(() => assessEffectiveness(incident(lots(1,
        { rejected: 2, inspected: 1 }))), /count|inspection|AOI/i);
    assert.throws(() => assessEffectiveness(change('L1', lots(2),
        { absoluteOffsetLimitMm: -1 })), /limit/i);
    assert.throws(() => assessEffectiveness(change('L1', lots(2),
        { afterAt: '2026-09-02T00:00:00.000Z' })), /subsequent|after/i);
    assert.throws(() => assessEffectiveness(change('toString', lots(2))), /L1|L2|L3/);
    assert.throws(() => assessEffectiveness(change('__proto__', lots(2))), /L1|L2|L3/);
    assert.throws(() => assessEffectiveness(change(['L1'], lots(2))), /L1|L2|L3/);
    assert.throws(() => assessEffectiveness(change(new String('L1'), lots(2))),
        /L1|L2|L3/);
    assert.throws(() => assessEffectiveness(change({ toString: () => 'L1' }, lots(2))),
        /L1|L2|L3/);
    assert.throws(() => assessEffectiveness(change('L1', lots(2,
        { offset: 0.10 }), { absoluteOffsetLimitMm: 1.0 })), /limit|approved/i);
});
