import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';
import { calculateExposure } from '../src/domain/trace.mjs';
import { buildSourceTraceQuery } from '../src/domain/trace-source.mjs';

test('source query selects every overlapping run plus adjacent exclusion witnesses', () => {
    const db = openDatabase(':memory:');
    try {
        seedDatabase(db, { instanceId: 'DATASET-TRACE-SOURCE' });
        const query = buildSourceTraceQuery(db, {
            equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
            recipeRevisionId: 'REC-ALIGN-R3', defectCodeId: 'DEF-FIDUCIAL',
            earliestLkgAt: '2026-08-25T08:00:00.000Z',
            latestLkgAt: '2026-08-25T12:00:00.000Z',
            cutoffAt: '2026-08-27T10:00:00.000Z'
        });
        assert.deepEqual(query.runs.map(run => run.lotId), [
            'LOT-A-024', 'LOT-A-025', 'LOT-A-026', 'LOT-A-027', 'LOT-A-028'
        ]);
        assert.deepEqual(calculateExposure(query).lots.map(lot => lot.classification), [
            'excluded', 'ambiguous', 'confirmed-affected', 'potentially-exposed', 'excluded'
        ]);
    } finally {
        db.close();
    }
});
