import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';

test('an alarm is resolved only by an explicit same-module, later repair link', () => {
    const db = openDatabase(':memory:');
    try {
        seedDatabase(db, { instanceId: 'DATASET-ALARM-LINK' });
        db.prepare(`INSERT INTO equipment_events(id,equipment_id,module_id,event_type,
            occurred_at,duration_seconds) VALUES (?,?,?,?,?,?)`)
            .run('EV-ALARM-LINK', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'alarm',
                '2026-09-01T14:00:00.000Z', 0);
        const insertRepair = db.prepare(`INSERT INTO maintenance_actions(id,equipment_id,
            module_id,code,summary,start_at,end_at) VALUES (?,?,?,?,?,?,?)`);
        insertRepair.run('MA-WRONG-TOOL', 'EQ-ALIGN-B', 'MOD-ALIGN-B-R2', 'REPAIR',
            'Other synthetic cell', '2026-09-01T15:00:00.000Z',
            '2026-09-01T16:00:00.000Z');
        insertRepair.run('MA-EARLY', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'REPAIR',
            'Repair predates alarm', '2026-09-01T12:00:00.000Z',
            '2026-09-01T13:00:00.000Z');
        insertRepair.run('MA-ALARM-LINK', 'EQ-ALIGN-A', 'MOD-ALIGN-A', 'REPAIR',
            'Explicit synthetic alarm repair', '2026-09-01T15:00:00.000Z',
            '2026-09-01T16:00:00.000Z');
        const insertLink = db.prepare(`INSERT INTO equipment_event_resolutions(id,
            equipment_event_id,maintenance_action_id,recorded_by,recorded_at)
            VALUES (?,?,?,?,?)`);
        assert.throws(() => insertLink.run('RES-WRONG', 'EV-ALARM-LINK',
            'MA-WRONG-TOOL', 'ACT-EQP', '2026-09-01T17:00:00.000Z'),
        /resolution|event|repair/i);
        assert.throws(() => insertLink.run('RES-EARLY', 'EV-ALARM-LINK',
            'MA-EARLY', 'ACT-EQP', '2026-09-01T17:00:00.000Z'),
        /resolution|event|repair/i);
        insertLink.run('RES-VALID', 'EV-ALARM-LINK', 'MA-ALARM-LINK', 'ACT-EQP',
            '2026-09-01T17:00:00.000Z');
        assert.throws(() => db.prepare(`UPDATE equipment_event_resolutions
            SET maintenance_action_id='MA-EARLY' WHERE id='RES-VALID'`).run(), /immutable/i);
    } finally {
        db.close();
    }
});
