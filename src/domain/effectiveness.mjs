// Pure demonstration rule calculation. Persisted gates must independently select
// source rows and validate this result before changing a cycle state.
export const EFFECTIVENESS_RULE_VERSION = 'FA-DEMO-EFF-1.0';

const changeWindows = Object.freeze({
    L1: Object.freeze({ requiredLots: 2, minCalendarDays: 0 }),
    L2: Object.freeze({ requiredLots: 5, minCalendarDays: 0 }),
    L3: Object.freeze({ requiredLots: 10, minCalendarDays: 7 })
});

function utc(value, label) {
    if (typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
        throw new TypeError(`${label} must be canonical UTC`);
    }
    return value;
}

function named(value, label) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
    return value.trim();
}

function count(value, label, allowZero = true) {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
        throw new RangeError(`${label} must be a ${allowZero ? 'nonnegative' : 'positive'} safe integer`);
    }
    return value;
}

function checkedSum(total, value, label) {
    const sum = total + value;
    if (!Number.isSafeInteger(sum)) throw new RangeError(`${label} exceeds safe integer precision`);
    return sum;
}

function requirements(input) {
    if (input.cycleType === 'change') {
        const window = typeof input.finalLevel === 'string' &&
            Object.hasOwn(changeWindows, input.finalLevel) ?
            changeWindows[input.finalLevel] : null;
        if (!window) throw new TypeError('Change final L1/L2/L3 level is required');
        if (!Number.isFinite(input.absoluteOffsetLimitMm) ||
            input.absoluteOffsetLimitMm <= 0 ||
            input.absoluteOffsetLimitMm > 0.08) {
            throw new RangeError('Approved absolute offset limit is required');
        }
        return window;
    }
    if (input.cycleType === 'incident') {
        if (typeof input.criticalIncident !== 'boolean' ||
            typeof input.linkedL3 !== 'boolean') {
            throw new TypeError('Incident critical and linked L3 flags must be explicit');
        }
        return { requiredLots: input.criticalIncident || input.linkedL3 ? 10 : 5,
            minCalendarDays: 7 };
    }
    throw new TypeError('Change or incident effectiveness cycle is required');
}

function dayIndex(timestamp) {
    return Math.floor(Date.parse(`${timestamp.slice(0, 10)}T00:00:00.000Z`) / 86_400_000);
}

export function assessEffectiveness(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('Effectiveness evidence is required');
    }
    const { requiredLots, minCalendarDays } = requirements(input);
    const afterAt = utc(input.afterAt, 'Cycle decision time');
    named(input.targetedDefectCodeId, 'Targeted defect code');
    if (typeof input.unresolvedRelatedAlarm !== 'boolean' ||
        typeof input.unresolvedBlockingDeviation !== 'boolean') {
        throw new TypeError('Alarm and deviation statuses must be explicit');
    }
    if (!Array.isArray(input.lots)) throw new TypeError('Subsequent source lots are required');

    const seenLots = new Set();
    const seenMeasurements = new Set();
    let inspectedUnits = 0;
    let rejectedUnits = 0;
    let targetedDefects = 0;
    let criticalDefects = 0;
    let incompleteAoi = false;
    let missingMeasurements = false;
    let failedMeasurement = false;
    let previousStart = null;
    let firstStart = null;
    let lastEnd = null;

    for (const lot of input.lots) {
        if (!lot || typeof lot !== 'object' || Array.isArray(lot)) {
            throw new TypeError('Lot source summary is invalid');
        }
        const lotId = named(lot.lotId, 'Lot ID');
        if (seenLots.has(lotId)) throw new Error('Duplicate effectiveness lot');
        seenLots.add(lotId);
        const startAt = utc(lot.startAt, 'Lot start');
        const endAt = utc(lot.endAt, 'Lot end');
        if (startAt >= endAt || startAt <= afterAt ||
            (previousStart && startAt < previousStart)) {
            throw new RangeError('Effectiveness lots must be completed, ordered and subsequent');
        }
        previousStart = startAt;
        firstStart ??= startAt;
        if (!lastEnd || endAt > lastEnd) lastEnd = endAt;
        const processed = count(lot.processedUnits, 'Processed unit count', false);
        const inspected = count(lot.inspectedUnits, 'AOI inspected unit count');
        const rejected = count(lot.rejectedUnits, 'AOI rejected unit count');
        const target = count(lot.targetedDefects, 'Target defect count');
        const critical = count(lot.criticalDefects, 'Critical defect count');
        if (inspected > processed || rejected > inspected || target > rejected ||
            critical > rejected) throw new RangeError('AOI inspection and defect counts disagree');
        if (inspected !== processed) incompleteAoi = true;
        inspectedUnits = checkedSum(inspectedUnits, inspected, 'AOI denominator');
        rejectedUnits = checkedSum(rejectedUnits, rejected, 'AOI rejected count');
        targetedDefects = checkedSum(targetedDefects, target, 'Target defect count');
        criticalDefects = checkedSum(criticalDefects, critical, 'Critical defect count');

        if (input.cycleType === 'change') {
            if (!Array.isArray(lot.measurements)) {
                throw new TypeError('Change effectiveness measurements are required');
            }
            if (lot.measurements.length === 0) missingMeasurements = true;
            for (const measurement of lot.measurements) {
                const id = named(measurement?.id, 'Measurement ID');
                if (seenMeasurements.has(id)) throw new Error('Duplicate effectiveness measurement');
                seenMeasurements.add(id);
                const value = measurement.absoluteOffsetMm;
                if (!Number.isFinite(value) || value < 0) {
                    throw new RangeError('Absolute offset measurement must be nonnegative');
                }
                if (value > input.absoluteOffsetLimitMm) failedMeasurement = true;
            }
        }
    }

    const observedCalendarDays = firstStart ?
        dayIndex(new Date(Date.parse(lastEnd) - 1).toISOString()) - dayIndex(firstStart) : 0;
    const aoiRejectRate = inspectedUnits === 0 ? null : rejectedUnits / inspectedUnits;
    const failures = [];
    if (targetedDefects > 0) failures.push('Target defect recurrence');
    if (criticalDefects > 0) failures.push('Critical AOI defect');
    if (inspectedUnits > 0 && BigInt(rejectedUnits) * 100n >
        BigInt(inspectedUnits) * 2n) failures.push('AOI reject rate exceeds 2%');
    if (failedMeasurement) failures.push('Alignment measurement outside approved limit');
    if (input.unresolvedRelatedAlarm) failures.push('Unresolved related equipment alarm');
    if (input.unresolvedBlockingDeviation) failures.push('Unresolved blocking deviation');
    const pending = [];
    if (input.lots.length < requiredLots) pending.push('Insufficient subsequent lots');
    if (observedCalendarDays < minCalendarDays) pending.push('Insufficient calendar-day span');
    if (incompleteAoi || inspectedUnits === 0) pending.push('AOI coverage incomplete');
    if (missingMeasurements) pending.push('Measurement evidence missing');
    const status = failures.length ? 'Reopen Required' : pending.length ? 'Monitoring' : 'Pass';
    return { ruleVersion: EFFECTIVENESS_RULE_VERSION, cycleType: input.cycleType,
        status, requiredLots, minCalendarDays, observedLots: input.lots.length,
        observedCalendarDays, inspectedUnits, rejectedUnits, targetedDefects,
        criticalDefects, aoiRejectRate, reasons: [...failures, ...pending] };
}
