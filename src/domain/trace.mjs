// Deterministic demonstration exposure classification. The result is a proposal;
// a separate simulated actor must review scope before any lot disposition.
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

const rank = Object.freeze({ excluded: 0, ambiguous: 1, 'potentially-exposed': 2, 'confirmed-affected': 3 });

function checkedSum(total, count) {
    const sum = total + count;
    if (!Number.isSafeInteger(sum)) throw new RangeError('Defect count sum exceeds safe integer precision');
    return sum;
}

function intersection(left, right) {
    if (!right) return null;
    const startAt = left.startAt > right.startAt ? left.startAt : right.startAt;
    const endAt = left.endAt < right.endAt ? left.endAt : right.endAt;
    return startAt < endAt ? { startAt, endAt } : null;
}

function classifyRun(run, context) {
    const startAt = utc(run.startAt, 'Run start');
    const endAt = utc(run.endAt, 'Run end');
    if (startAt >= endAt) throw new RangeError('Run interval must have start before end');
    if (Object.hasOwn(run, 'targetedDefects') || !Array.isArray(run.defects)) {
        throw new TypeError('Timestamped defect sources are required in place of a run total');
    }
    const id = named(run.id, 'Run ID');
    const lotId = named(run.lotId, 'Lot ID');
    const equipmentId = named(run.equipmentId, 'Run equipment');
    const moduleId = named(run.moduleId, 'Run module');
    const recipeRevisionId = named(run.recipeRevisionId, 'Run recipe');
    const defects = run.defects.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new TypeError('Defect source is invalid');
        }
        const sourceId = named(item.sourceId, 'Defect source ID');
        if (named(item.defectCodeId, 'Defect code') !== context.defectCodeId) {
            throw new Error('Defect code differs from the trace target');
        }
        if (!Number.isSafeInteger(item.count) || item.count <= 0) {
            throw new RangeError('Defect count must be a positive safe integer');
        }
        const observedAt = utc(item.observedAt, 'Defect observation');
        if (observedAt < startAt || observedAt >= endAt) {
            throw new RangeError('Defect observation must fall within its source run interval');
        }
        return { sourceId, observedAt, count: item.count };
    });
    const base = { id, lotId, classification: 'excluded', overlap: null,
        uncertainOverlap: null, certainOverlap: null, defectSources: defects,
        targetedDefects: defects.reduce((sum, item) => checkedSum(sum, item.count), 0),
        certainIntervalDefects: 0, reason: '' };
    if (equipmentId !== context.equipmentId) return { ...base, reason: 'Different equipment from the trace context' };
    if (moduleId !== context.moduleId) return { ...base, reason: 'Different module from the trace context' };
    if (recipeRevisionId !== context.recipeRevisionId) return { ...base, reason: 'Different recipe revision from the trace context' };
    if (endAt <= context.startAt) return { ...base, reason: 'Run ended before the exposure window' };
    if (startAt >= context.cutoffAt) return { ...base, reason: 'Run started at or after the exposure cutoff' };
    const overlap = { startAt: startAt > context.startAt ? startAt : context.startAt,
        endAt: endAt < context.cutoffAt ? endAt : context.cutoffAt };
    const uncertainOverlap = intersection(overlap, { startAt: context.startAt,
        endAt: context.uncertainUntilAt });
    const certainOverlap = context.unknownStart ? null : intersection(overlap, {
        startAt: context.uncertainUntilAt, endAt: context.cutoffAt
    });
    const defectSources = defects.map(item => ({ ...item,
        insideCertainExposure: !!certainOverlap &&
            item.observedAt >= certainOverlap.startAt && item.observedAt < certainOverlap.endAt,
        insideUncertainExposure: !!uncertainOverlap &&
            item.observedAt >= uncertainOverlap.startAt && item.observedAt < uncertainOverlap.endAt
    }));
    const certainIntervalDefects = defectSources.filter(item => item.insideCertainExposure)
        .reduce((sum, item) => checkedSum(sum, item.count), 0);
    const partial = startAt < context.startAt || endAt > context.cutoffAt;
    const classification = certainIntervalDefects > 0 ? 'confirmed-affected' :
        certainOverlap ? 'potentially-exposed' : 'ambiguous';
    const basis = context.unknownStart ? 'LKG start unknown; exposure cannot be bounded confidently' :
        uncertainOverlap && certainOverlap ? 'Run spans uncertain and later exposure segments' :
            uncertainOverlap ? 'Run overlaps only the uncertain LKG segment' :
                'Run overlaps the exposure segment after the latest possible LKG';
    return { ...base, classification, overlap, uncertainOverlap, certainOverlap,
        defectSources, certainIntervalDefects,
        reason: `${basis}${partial ? '; partial interval overlap' : ''}` };
}

export function calculateExposure(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Trace input is required');
    const equipmentId = named(input.equipmentId, 'Trace equipment');
    const moduleId = named(input.moduleId, 'Trace module');
    const recipeRevisionId = named(input.recipeRevisionId, 'Trace recipe');
    const defectCodeId = named(input.defectCodeId, 'Target defect code');
    const cutoffAt = utc(input.cutoffAt, 'Exposure cutoff');
    const unknownStart = input.earliestLkgAt == null && input.latestLkgAt == null;
    if (!unknownStart && (input.earliestLkgAt == null || input.latestLkgAt == null)) {
        throw new TypeError('Both LKG bounds are required when an LKG observation exists');
    }
    if (unknownStart && input.earliestTraceAt == null) {
        throw new TypeError('Earliest trace boundary is required when LKG start is unknown');
    }
    const startAt = utc(unknownStart ? input.earliestTraceAt : input.earliestLkgAt, 'Exposure start');
    const uncertainUntilAt = unknownStart ? cutoffAt : utc(input.latestLkgAt, 'Latest LKG');
    if (startAt >= cutoffAt || uncertainUntilAt < startAt || uncertainUntilAt > cutoffAt) {
        throw new RangeError('LKG bounds must be ordered before the exposure cutoff');
    }
    if (!Array.isArray(input.runs)) throw new TypeError('Process runs are required');
    const context = { equipmentId, moduleId, recipeRevisionId, defectCodeId, cutoffAt,
        startAt, uncertainUntilAt, unknownStart };
    const seen = new Set();
    const seenSources = new Set();
    const byLot = new Map();
    for (const run of input.runs) {
        if (!run || typeof run !== 'object' || Array.isArray(run)) throw new TypeError('Process run is invalid');
        const classified = classifyRun(run, context);
        if (unknownStart && run.equipmentId.trim() === equipmentId &&
            run.moduleId.trim() === moduleId && run.recipeRevisionId.trim() === recipeRevisionId &&
            run.startAt < startAt) {
            throw new RangeError('Matching run precedes the claimed earliest trace boundary');
        }
        if (seen.has(classified.id)) throw new Error(`Duplicate process run: ${classified.id}`);
        seen.add(classified.id);
        for (const source of classified.defectSources) {
            if (seenSources.has(source.sourceId)) throw new Error(`Duplicate defect source: ${source.sourceId}`);
            seenSources.add(source.sourceId);
        }
        const lot = byLot.get(classified.lotId) ?? { lotId: classified.lotId,
            classification: 'excluded', reason: '', runIds: [], runDetails: [],
            overlaps: [], defectSources: [], targetedDefects: 0, certainIntervalDefects: 0 };
        lot.runIds.push(classified.id);
        lot.runDetails.push(classified);
        if (classified.overlap) lot.overlaps.push({ runId: classified.id, ...classified.overlap });
        if (classified.overlap) {
            lot.targetedDefects = checkedSum(lot.targetedDefects, classified.targetedDefects);
            lot.certainIntervalDefects = checkedSum(lot.certainIntervalDefects, classified.certainIntervalDefects);
            lot.defectSources.push(...classified.defectSources.map(item => ({ runId: classified.id, ...item })));
        }
        if (rank[classified.classification] > rank[lot.classification]) lot.classification = classified.classification;
        byLot.set(classified.lotId, lot);
    }
    const lots = [...byLot.values()].map(lot => {
        const uncertain = lot.runDetails.some(item => item.uncertainOverlap);
        const partial = lot.runDetails.some(item => item.reason.includes('partial interval overlap'));
        const reason = lot.classification === 'excluded'
            ? [...new Set(lot.runDetails.map(item => item.reason))].join('; ')
            : `${lot.classification}: ${lot.targetedDefects} targeted defect(s) on intersecting runs; ` +
                `${lot.certainIntervalDefects} timestamped in the certain exposure segment` +
                `${unknownStart ? '; LKG start unknown; uncertainty retained' : uncertain ? '; uncertain LKG segment retained' : ''}` +
                `${partial ? '; partial interval overlap' : ''}` +
                '; targeted-code presence does not prove the incident cause';
        return { ...lot, reason,
        overlap: lot.overlaps.length === 1 ? { startAt: lot.overlaps[0].startAt,
            endAt: lot.overlaps[0].endAt } : null };
    });
    return { window: { startAt, endAt: cutoffAt, uncertainUntilAt,
        unknownStart, intervalConvention: '[start,end)' }, lots };
}
