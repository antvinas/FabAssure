// Descriptive calculations for synthetic portfolio evidence, not release gates.
function label(value, name) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError(`${name} is required`);
    }
    return value.trim();
}

function finite(value, name) {
    if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
    return value;
}

function average(values, name) {
    // Accumulate finite IEEE-754 readings exactly before dividing, so input order
    // cannot erase a small residual between large values of opposite signs.
    const bits = new DataView(new ArrayBuffer(8));
    let exact = 0n;
    for (const value of values) {
        bits.setFloat64(0, value, false);
        const high = bits.getUint32(0, false);
        const low = bits.getUint32(4, false);
        const exponent = (high >>> 20) & 0x7ff;
        const fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
        const mantissa = exponent === 0 ? fraction : (1n << 52n) | fraction;
        const units = mantissa << BigInt(exponent === 0 ? 0 : exponent - 1);
        exact += high >>> 31 ? -units : units;
    }
    if (exact === 0n) return 0;
    const negative = exact < 0n;
    const magnitude = negative ? -exact : exact;
    const count = BigInt(values.length);
    const integerUnits = magnitude / count;
    const shift = Math.max(0, integerUnits.toString(2).length - 53);
    const divisor = count << BigInt(shift);
    let rounded = magnitude / divisor;
    const remainder = magnitude % divisor;
    if (remainder * 2n > divisor ||
        (remainder * 2n === divisor && (rounded & 1n) === 1n)) {
        rounded += 1n;
    }
    const result = Number(rounded) * 2 ** (shift - 1074);
    if (result === 0) return null;
    if (!Number.isFinite(result)) throw new RangeError(`${name} mean is not finite`);
    return negative ? -result : result;
}

function spread(values) {
    if (values.some(value => value === null)) return null;
    let smallest = Infinity;
    let largest = -Infinity;
    for (const value of values) {
        if (value < smallest) smallest = value;
        if (value > largest) largest = value;
    }
    const result = largest - smallest;
    return Number.isFinite(result) ? result : null;
}

export function calculateCapability(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('Capability sample is required');
    }
    const sampleSetId = label(input.sampleSetId, 'Sample set ID');
    const unit = label(input.unit, 'Unit');
    const method = label(input.method, 'Measurement method');
    const lsl = finite(input.lsl, 'Lower specification limit');
    const usl = finite(input.usl, 'Upper specification limit');
    if (lsl >= usl) throw new RangeError('Capability limits must be ordered');
    if (!Array.isArray(input.readings) || input.readings.length < 2) {
        throw new RangeError('At least two individual capability readings are required');
    }
    const ids = new Set();
    const values = input.readings.map(reading => {
        const id = label(reading?.id, 'Reading ID');
        if (ids.has(id)) throw new Error('Duplicate capability reading ID');
        ids.add(id);
        return finite(reading.value, 'Capability reading');
    });
    const scale = values.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
    const normalized = scale === 0 ? values.map(() => 0) : values.map(value => value / scale);
    const normalizedMean = average(normalized, 'Normalized capability');
    const mean = average(values, 'Capability');
    const normalizedVariance = normalized.reduce((sum, value) =>
        sum + (value - normalizedMean) ** 2, 0) / (values.length - 1);
    const rawStdDev = Math.sqrt(normalizedVariance) * scale;
    const sampleStdDev = !Number.isFinite(rawStdDev) ||
        (rawStdDev === 0 && normalizedVariance > 0) ? null : rawStdDev;
    let cpk = null;
    if (mean !== null && sampleStdDev !== null && sampleStdDev > 0) {
        const cpkScale = Math.max(Math.abs(lsl), Math.abs(usl), Math.abs(mean),
            sampleStdDev);
        const denominator = 3 * (sampleStdDev / cpkScale);
        const lowerIndex = (mean / cpkScale - lsl / cpkScale) / denominator;
        const upperIndex = (usl / cpkScale - mean / cpkScale) / denominator;
        const estimate = Math.min(lowerIndex, upperIndex);
        if (Number.isFinite(estimate)) cpk = estimate;
    }
    const precisionLimited = mean === null || sampleStdDev === null ||
        (sampleStdDev > 0 && cpk === null);
    const limitation = precisionLimited ?
        'Numeric precision limits prevent a reliable mean, spread, or Cpk; stability and MSA are unverified.' :
        sampleStdDev === 0 ?
            'Zero observed variation: Cpk is not estimable; stability and MSA are unverified.' :
            'Descriptive sample Cpk only; stability and MSA are not established by this calculation.';
    return { sampleSetId, unit, method, n: values.length, lsl, usl,
        mean, sampleStdDev, cpk, decision: null, limitation };
}

export function describeRepeatability(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('Repeatability study is required');
    }
    const studyId = label(input.studyId, 'Study ID');
    const unit = label(input.unit, 'Unit');
    const method = label(input.method, 'Measurement method');
    if (!Array.isArray(input.readings) || input.readings.length === 0) {
        throw new TypeError('Repeatability readings are required');
    }
    const parts = new Set();
    const operators = new Set();
    const cells = new Map();
    for (const reading of input.readings) {
        const partId = label(reading?.partId, 'Part ID');
        const operatorId = label(reading?.operatorId, 'Operator ID');
        const repeat = reading.repeat;
        if (!Number.isSafeInteger(repeat) || repeat < 1) {
            throw new RangeError('Repeat index must be a positive integer');
        }
        const value = finite(reading.value, 'Repeatability reading');
        parts.add(partId);
        operators.add(operatorId);
        const key = JSON.stringify([partId, operatorId]);
        if (!cells.has(key)) cells.set(key, new Map());
        const cell = cells.get(key);
        if (cell.has(repeat)) throw new Error('Duplicate part/operator/repeat reading');
        cell.set(repeat, value);
    }
    if (parts.size < 2 || operators.size < 2) {
        throw new RangeError('At least two parts and two operators are required');
    }
    if (cells.size !== parts.size * operators.size) {
        throw new Error('Balanced repeatability study has a missing part/operator cell');
    }
    const repeatsPerCell = cells.values().next().value.size;
    if (repeatsPerCell < 2) throw new RangeError('At least two repeats per cell are required');
    const withinRanges = [];
    const operatorValues = new Map([...operators].map(id => [id, []]));
    const partValues = new Map([...parts].map(id => [id, []]));
    for (const partId of parts) {
        for (const operatorId of operators) {
            const cell = cells.get(JSON.stringify([partId, operatorId]));
            if (!cell || cell.size !== repeatsPerCell) {
                throw new Error('Balanced repeatability study has missing readings');
            }
            const values = [];
            for (let repeat = 1; repeat <= repeatsPerCell; repeat++) {
                if (!cell.has(repeat)) {
                    throw new Error('Balanced repeatability study has a missing repeat');
                }
                values.push(cell.get(repeat));
            }
            withinRanges.push(spread(values));
            operatorValues.get(operatorId).push(...values);
            partValues.get(partId).push(...values);
        }
    }
    const operatorMeans = [...operatorValues.values()].map(values => average(values, 'Operator'));
    const partMeans = [...partValues.values()].map(values => average(values, 'Part'));
    const averageWithinCellRange = withinRanges.includes(null) ? null :
        average(withinRanges, 'Within-cell range');
    const operatorMeanSpread = spread(operatorMeans);
    const partMeanSpread = spread(partMeans);
    const precisionLimited = averageWithinCellRange === null ||
        operatorMeanSpread === null || partMeanSpread === null;
    return { studyId, unit, method, partCount: parts.size,
        operatorCount: operators.size, repeatsPerCell,
        readingCount: input.readings.length,
        averageWithinCellRange, operatorMeanSpread, partMeanSpread,
        decision: null,
        limitation: precisionLimited ?
            'Numeric precision prevents a reliable spread estimate; this small study is not a full Gage R&R or measurement-system acceptance.' :
            'Descriptive range summary only; this small study is not a full Gage R&R or measurement-system acceptance.' };
}
