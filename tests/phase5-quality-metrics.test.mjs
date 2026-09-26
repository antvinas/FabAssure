import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCapability, describeRepeatability } from '../src/domain/quality-metrics.mjs';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10,
    `${actual} differs from ${expected}`);

const capability = (values) => ({ sampleSetId: 'SYN-SIGNED-ALIGN-01', unit: 'mm',
    method: 'synthetic fixed-gauge reading', lsl: -0.08, usl: 0.08,
    readings: values.map((value, index) => ({ id: `READ-${index + 1}`, value })) });

function study() {
    const readings = [];
    for (const [partId, base] of [['P1', 0.01], ['P2', 0.02], ['P3', 0.03]]) {
        for (const [operatorId, shift] of [['A', 0], ['B', 0.001]]) {
            readings.push({ partId, operatorId, repeat: 1, value: base + shift });
            readings.push({ partId, operatorId, repeat: 2, value: base + shift + 0.002 });
        }
    }
    return { studyId: 'SYN-MSA-01', unit: 'mm', method: 'synthetic repeated vision reading',
        readings };
}

test('sample Cpk reports the two-sided formula, denominator and no release badge', () => {
    const result = calculateCapability(capability([-0.03, -0.01, 0, 0.01, 0.03]));
    assert.equal(result.sampleSetId, 'SYN-SIGNED-ALIGN-01');
    assert.equal(result.n, 5);
    near(result.mean, 0);
    near(result.sampleStdDev, Math.sqrt(0.0005));
    near(result.cpk, 0.08 / (3 * Math.sqrt(0.0005)));
    assert.equal(result.unit, 'mm');
    assert.equal(result.lsl, -0.08);
    assert.equal(result.usl, 0.08);
    assert.equal(result.decision, null);
    assert.match(result.limitation, /stability|MSA/i);
});

test('out-of-spec mean remains a negative Cpk instead of becoming a pass badge', () => {
    const result = calculateCapability(capability([0.10, 0.11, 0.12]));
    assert.ok(result.cpk < 0);
    assert.equal(result.decision, null);
});

test('zero variation is reported as not estimable, not Infinity', () => {
    const result = calculateCapability(capability([0.01, 0.01, 0.01]));
    assert.equal(result.sampleStdDev, 0);
    assert.equal(result.cpk, null);
    assert.match(result.limitation, /variation/i);
});

test('very small distinct readings retain nonzero sample variation', () => {
    const result = calculateCapability({ ...capability([1e-200, 2e-200]),
        lsl: -1, usl: 1 });
    assert.ok(result.sampleStdDev > 0);
    assert.ok(Math.abs(result.sampleStdDev / (Math.SQRT1_2 * 1e-200) - 1) < 1e-12);
    assert.ok(result.cpk > 0);
});

test('large identical finite readings do not overflow the mean', () => {
    const result = calculateCapability({ ...capability([1e308, 1e308]),
        lsl: 9e307, usl: 1.1e308 });
    assert.equal(result.mean, 1e308);
    assert.equal(result.sampleStdDev, 0);
    assert.equal(result.cpk, null);
});

test('unrepresentable standard deviation is marked as precision-limited', () => {
    const result = calculateCapability({ ...capability([-1.7e308, 1.7e308]),
        lsl: -1.75e308, usl: 1.75e308 });
    assert.equal(result.sampleStdDev, null);
    assert.equal(result.cpk, null);
    assert.match(result.limitation, /precision/i);
});

test('opposing large values do not erase a smaller representable mean', () => {
    const first = calculateCapability({ ...capability([1, 1e308, -1e308]),
        lsl: -1.75e308, usl: 1.75e308 });
    const reordered = calculateCapability({ ...capability([1e308, -1e308, 1]),
        lsl: -1.75e308, usl: 1.75e308 });
    assert.equal(first.mean, 1 / 3);
    assert.equal(reordered.mean, 1 / 3);
});

test('mean rounds exact half-way values to the even binary significand', () => {
    assert.equal(calculateCapability({ ...capability([1, 1 + Number.EPSILON]),
        lsl: 0, usl: 3 }).mean, 1);
    assert.equal(calculateCapability({ ...capability([1 + Number.EPSILON,
        1 + 2 * Number.EPSILON]), lsl: 0, usl: 3 }).mean,
    1 + 2 * Number.EPSILON);
});

test('subnormal mean is retained when representable and labelled when it rounds to zero', () => {
    const retained = calculateCapability({ ...capability([
        Number.MIN_VALUE, Number.MIN_VALUE, 0]), lsl: -1, usl: 1 });
    assert.equal(retained.mean, Number.MIN_VALUE);
    const limited = calculateCapability({ ...capability([Number.MIN_VALUE, 0]),
        lsl: -1, usl: 1 });
    assert.equal(limited.mean, null);
    assert.match(limited.limitation, /precision/i);
});

test('capability rejects invalid limits, duplicate reading IDs and nonfinite values', () => {
    assert.throws(() => calculateCapability({ ...capability([0, 0.01]),
        usl: -0.08 }), /limit/i);
    const duplicate = capability([0, 0.01]);
    duplicate.readings[1].id = duplicate.readings[0].id;
    assert.throws(() => calculateCapability(duplicate), /duplicate/i);
    assert.throws(() => calculateCapability(capability([0, Number.NaN])), /finite/i);
    assert.throws(() => calculateCapability(capability([0])), /two|readings/i);
});

test('balanced synthetic repeatability summarizes within-cell and operator spread', () => {
    const result = describeRepeatability(study());
    assert.equal(result.studyId, 'SYN-MSA-01');
    assert.equal(result.partCount, 3);
    assert.equal(result.operatorCount, 2);
    assert.equal(result.repeatsPerCell, 2);
    assert.equal(result.readingCount, 12);
    near(result.averageWithinCellRange, 0.002);
    near(result.operatorMeanSpread, 0.001);
    near(result.partMeanSpread, 0.02);
    assert.equal(result.decision, null);
    assert.match(result.limitation, /not.*GRR|descriptive/i);
});

test('repeatability refuses missing or duplicate cells and nonfinite readings', () => {
    const missing = study();
    missing.readings.pop();
    assert.throws(() => describeRepeatability(missing), /balanced|missing/i);
    const duplicate = study();
    duplicate.readings[1].repeat = 1;
    assert.throws(() => describeRepeatability(duplicate), /duplicate/i);
    const nonfinite = study();
    nonfinite.readings[0].value = Infinity;
    assert.throws(() => describeRepeatability(nonfinite), /finite/i);
});

test('unrepresentable tiny study spread is labelled, never reported as zero', () => {
    const tiny = study();
    for (const reading of tiny.readings) reading.value = 0;
    tiny.readings[0].value = Number.MIN_VALUE;
    const result = describeRepeatability(tiny);
    assert.equal(result.averageWithinCellRange, null);
    assert.equal(result.operatorMeanSpread, null);
    assert.equal(result.partMeanSpread, null);
    assert.match(result.limitation, /precision/i);
});

test('large identical study readings remain finite with zero observed spread', () => {
    const large = study();
    for (const reading of large.readings) reading.value = 1e308;
    const result = describeRepeatability(large);
    assert.equal(result.averageWithinCellRange, 0);
    assert.equal(result.operatorMeanSpread, 0);
    assert.equal(result.partMeanSpread, 0);
});

test('opposing large study readings preserve a smaller operator mean spread', () => {
    const mixed = { studyId: 'SYN-MSA-MIXED', unit: 'mm', method: 'synthetic precision stress',
        readings: [
            { partId: 'P1', operatorId: 'A', repeat: 1, value: 1 },
            { partId: 'P1', operatorId: 'A', repeat: 2, value: 1e308 },
            { partId: 'P1', operatorId: 'B', repeat: 1, value: 0 },
            { partId: 'P1', operatorId: 'B', repeat: 2, value: 0 },
            { partId: 'P2', operatorId: 'A', repeat: 1, value: -1e308 },
            { partId: 'P2', operatorId: 'A', repeat: 2, value: 0 },
            { partId: 'P2', operatorId: 'B', repeat: 1, value: 0 },
            { partId: 'P2', operatorId: 'B', repeat: 2, value: 0 }
        ] };
    near(describeRepeatability(mixed).operatorMeanSpread, 0.25);
});
