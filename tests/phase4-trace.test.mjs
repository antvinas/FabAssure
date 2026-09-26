import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateExposure } from '../src/domain/trace.mjs';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';

const at = (day, hour) => `2026-08-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const run = (lotId, day, startHour, endHour, extra = {}) => ({
    id: `RUN-${lotId}`, lotId, equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
    recipeRevisionId: 'REC-ALIGN-R3', startAt: at(day, startHour), endAt: at(day, endHour),
    defects: [], ...extra
});
const defect = (id, day, time, count) => ({
    sourceId: id, defectCodeId: 'DEF-FIDUCIAL',
    observedAt: `2026-08-${String(day).padStart(2, '0')}T${time}.000Z`, count
});
const context = {
    equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A', recipeRevisionId: 'REC-ALIGN-R3',
    defectCodeId: 'DEF-FIDUCIAL',
    earliestLkgAt: at(25, 8), latestLkgAt: at(25, 12), cutoffAt: at(27, 10)
};

test('half-open LKG uncertainty classifies excluded, ambiguous, confirmed and partial lots', () => {
    const result = calculateExposure({ ...context, runs: [
        run('LOT-A-024', 24, 9, 11),
        run('LOT-A-025', 25, 9, 11),
        run('LOT-A-026', 26, 9, 11, { defects: [defect('AOI-A-026', 26, '10:30:00', 5)] }),
        run('LOT-A-027', 27, 9, 11, { defects: [defect('AOI-A-027', 27, '10:30:00', 4)] }),
        run('LOT-A-028', 28, 9, 11)
    ] });
    assert.equal(result.window.startAt, at(25, 8));
    assert.equal(result.window.endAt, at(27, 10));
    assert.equal(result.window.uncertainUntilAt, at(25, 12));
    assert.deepEqual(result.lots.map(item => [item.lotId, item.classification]), [
        ['LOT-A-024', 'excluded'], ['LOT-A-025', 'ambiguous'],
        ['LOT-A-026', 'confirmed-affected'], ['LOT-A-027', 'potentially-exposed'],
        ['LOT-A-028', 'excluded']
    ]);
    assert.equal(result.lots[1].overlap.startAt, at(25, 9));
    assert.equal(result.lots[1].overlap.endAt, at(25, 11));
    assert.equal(result.lots[3].overlap.endAt, at(27, 10));
    assert.equal(result.lots[2].certainIntervalDefects, 5);
    assert.equal(result.lots[3].certainIntervalDefects, 0);
    assert.equal(result.lots[3].targetedDefects, 4);
    assert.equal(result.lots[3].defectSources[0].insideCertainExposure, false);
    assert.match(result.lots[0].reason, /before/i);
    assert.match(result.lots[1].reason, /uncertain/i);
    assert.match(result.lots[3].reason, /partial/i);
});

test('exact interval boundaries do not overlap and recipe/module context remains explicit', () => {
    const result = calculateExposure({ ...context, runs: [
        run('END-AT-START', 25, 7, 8),
        run('START-AT-CUTOFF', 27, 10, 11),
        run('START-AT-LATEST', 25, 12, 13),
        run('OTHER-RECIPE', 26, 9, 11, { recipeRevisionId: 'REC-ALIGN-R2' }),
        run('OTHER-MODULE', 26, 9, 11, { moduleId: 'MOD-ALIGN-B' })
    ] });
    assert.deepEqual(result.lots.map(item => item.classification), [
        'excluded', 'excluded', 'potentially-exposed', 'excluded', 'excluded'
    ]);
    assert.match(result.lots[3].reason, /recipe/i);
    assert.match(result.lots[4].reason, /module/i);
});

test('unknown LKG start uses the earliest trace boundary without inventing confidence', () => {
    const result = calculateExposure({
        ...context, earliestLkgAt: null, latestLkgAt: null,
        earliestTraceAt: at(24, 20), runs: [run('LOT-A-025', 25, 9, 11)]
    });
    assert.equal(result.window.startAt, at(24, 20));
    assert.equal(result.window.unknownStart, true);
    assert.equal(result.lots[0].classification, 'ambiguous');
    assert.match(result.lots[0].reason, /unknown/i);
});

test('a run spanning both LKG bounds preserves uncertain and certain segments', () => {
    const result = calculateExposure({ ...context, runs: [
        run('LOT-SPANNING', 25, 9, 13, { defects: [defect('AOI-SPANNING', 25, '10:30:00', 2)] })
    ] });
    const lot = result.lots[0];
    assert.equal(lot.classification, 'potentially-exposed');
    assert.deepEqual(lot.runDetails[0].uncertainOverlap, { startAt: at(25, 9), endAt: at(25, 12) });
    assert.deepEqual(lot.runDetails[0].certainOverlap, { startAt: at(25, 12), endAt: at(25, 13) });
    assert.match(lot.reason, /uncertain/i);
    assert.equal(lot.certainIntervalDefects, 0);
});

test('multiple runs of one lot preserve separate intersections and do not count excluded defects', () => {
    const result = calculateExposure({ ...context, runs: [
        run('LOT-MULTI', 24, 9, 11, { id: 'RUN-OUTSIDE',
            defects: [defect('AOI-OUTSIDE', 24, '10:30:00', 3)] }),
        run('LOT-MULTI', 25, 9, 11, { id: 'RUN-UNCERTAIN' }),
        run('LOT-MULTI', 26, 9, 11, { id: 'RUN-CERTAIN',
            defects: [defect('AOI-CERTAIN', 26, '10:30:00', 1)] }),
        run('LOT-MULTI', 27, 9, 11, { id: 'RUN-CERTAIN-2',
            defects: [defect('AOI-LATER', 27, '09:30:00', 4)] })
    ] });
    assert.equal(result.lots.length, 1);
    assert.equal(result.lots[0].classification, 'confirmed-affected');
    assert.equal(result.lots[0].targetedDefects, 5);
    assert.equal(result.lots[0].certainIntervalDefects, 5);
    assert.match(result.lots[0].reason, /5 targeted/i);
    assert.deepEqual(result.lots[0].runIds,
        ['RUN-OUTSIDE', 'RUN-UNCERTAIN', 'RUN-CERTAIN', 'RUN-CERTAIN-2']);
    assert.equal(result.lots[0].overlap, null);
    assert.equal(result.lots[0].overlaps.length, 3);
    assert.deepEqual(result.lots[0].defectSources.map(item => item.sourceId),
        ['AOI-CERTAIN', 'AOI-LATER']);
});

test('invalid bounds and inconsistent source intervals are rejected', () => {
    assert.throws(() => calculateExposure({ ...context, latestLkgAt: at(28, 12), runs: [] }), /LKG|cutoff/i);
    assert.throws(() => calculateExposure({ ...context, runs: [run('BAD', 26, 11, 9)] }), /interval/i);
    assert.throws(() => calculateExposure({ ...context, earliestLkgAt: null, latestLkgAt: null,
        earliestTraceAt: null, runs: [] }), /boundary/i);
    assert.throws(() => calculateExposure({ ...context, runs: [
        run('BAD-DEFECT', 26, 9, 11, { defects: [defect('AOI-BAD', 26, '10:30:00', -1)] })
    ] }), /defect/i);
    assert.throws(() => calculateExposure({ ...context, runs: [
        run('WRONG-CODE', 26, 9, 11, { defects: [{ ...defect('AOI-WRONG', 26, '10:30:00', 1),
            defectCodeId: 'DEF-ALIGN' }] })
    ] }), /defect code/i);
    assert.throws(() => calculateExposure({ ...context, runs: [
        run('UNSAFE-SUM', 26, 9, 11, { defects: [
            defect('AOI-HUGE', 26, '10:30:00', Number.MAX_SAFE_INTEGER),
            defect('AOI-EXTRA', 26, '10:31:00', 1)
        ] })
    ] }), /safe|precision|sum/i);
    assert.throws(() => calculateExposure({ ...context, earliestLkgAt: null,
        latestLkgAt: null, earliestTraceAt: at(25, 8), runs: [run('EARLIER', 24, 9, 11)]
    }), /earliest trace boundary/i);
    assert.throws(() => calculateExposure({ ...context, runs: [
        run('SAME-LOT', 26, 9, 11, { id: 'RUN-SAFE-1',
            defects: [defect('AOI-SAFE-1', 26, '10:30:00', Number.MAX_SAFE_INTEGER)] }),
        run('SAME-LOT', 27, 9, 11, { id: 'RUN-SAFE-2',
            defects: [defect('AOI-SAFE-2', 27, '09:30:00', 1)] })
    ] }), /safe|precision|sum/i);
    assert.throws(() => calculateExposure({ ...context, runs: [
        run('LATE-OBSERVATION', 26, 9, 11, {
            defects: [defect('AOI-LATE', 26, '11:30:00', 1)] })
    ] }), /observation.*run interval/i);
    assert.throws(() => calculateExposure({ ...context, runs: [
        run('END-OBSERVATION', 26, 9, 11, {
            defects: [defect('AOI-END', 26, '11:00:00', 1)] })
    ] }), /observation.*run interval/i);
    assert.throws(() => calculateExposure({ ...context, runs: [
        run('LOT-DUP-1', 26, 9, 11, { defects: [defect('AOI-DUP', 26, '10:30:00', 1)] }),
        run('LOT-DUP-2', 27, 9, 11, { defects: [defect('AOI-DUP', 27, '10:30:00', 1)] })
    ] }), /duplicate defect source/i);
});

test('seeded post-maintenance Scenario B preserves the AOI-after-cutoff uncertainty', () => {
    const db = openDatabase(':memory:');
    try {
        seedDatabase(db, { instanceId: 'DATASET-TRACE-TEST' });
        const eventAt = id => db.prepare('SELECT occurred_at FROM equipment_events WHERE id=?').get(id).occurred_at;
        const defectRows = db.prepare(`
            SELECT d.id AS sourceId,d.defect_code_id AS defectCodeId,
                a.inspected_at AS observedAt,d.defect_count AS count
            FROM aoi_defects d JOIN aoi_inspections a ON a.id=d.aoi_inspection_id
            WHERE a.process_run_id=? AND d.defect_code_id='DEF-FIDUCIAL' ORDER BY d.id
        `);
        const runs = db.prepare(`
            SELECT id,lot_id AS lotId,equipment_id AS equipmentId,module_id AS moduleId,
                recipe_revision_id AS recipeRevisionId,start_at AS startAt,end_at AS endAt
            FROM process_runs WHERE lot_id BETWEEN 'LOT-A-024' AND 'LOT-A-028'
            ORDER BY lot_id,start_at
        `).all().map(row => ({ ...row, defects: defectRows.all(row.id) }));
        assert.equal(db.prepare("SELECT end_at FROM maintenance_actions WHERE id='MA-VISION-2'").get().end_at,
            at(24, 20));
        const result = calculateExposure({
            equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
            recipeRevisionId: 'REC-ALIGN-R3', defectCodeId: 'DEF-FIDUCIAL',
            earliestLkgAt: eventAt('EV-LKG-EARLIEST'),
            latestLkgAt: eventAt('EV-LKG-LATEST'), cutoffAt: eventAt('EV-DETECTION'), runs
        });
        assert.deepEqual(result.lots.map(item => [item.lotId, item.classification]), [
            ['LOT-A-024', 'excluded'], ['LOT-A-025', 'ambiguous'],
            ['LOT-A-026', 'confirmed-affected'], ['LOT-A-027', 'potentially-exposed'],
            ['LOT-A-028', 'excluded']
        ]);
        assert.equal(result.lots[2].defectSources[0].sourceId, 'AOIDEF-A-026-1');
        assert.equal(result.lots[2].certainIntervalDefects, 5);
        assert.equal(result.lots[3].defectSources[0].observedAt, '2026-08-27T10:30:00.000Z');
        assert.equal(result.lots[3].certainIntervalDefects, 0);
        assert.equal(result.lots[3].overlap.endAt, eventAt('EV-DETECTION'));
    } finally {
        db.close();
    }
});
