import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANGE_STATES, INCIDENT_STATES, assertStateTransition, nextStates } from '../src/domain/state.mjs';

test('Change follows the approved forward path without skipping gates', () => {
    const path = [
        'Draft', 'Submitted', 'Risk Classified', 'Plan Approved',
        'Verification In Progress', 'Evidence Ready', 'Independent Review',
        'Accepted', 'Effectiveness Monitoring', 'Closed'
    ];
    assert.deepEqual(CHANGE_STATES.slice(0, path.length), path);
    for (let index = 0; index < path.length - 1; index++) {
        assert.doesNotThrow(() => assertStateTransition('change', path[index], path[index + 1]));
    }
    assert.throws(() => assertStateTransition('change', 'Draft', 'Accepted'), /transition|gate/i);
    assert.throws(() => assertStateTransition('change', 'Plan Approved', 'Accepted'), /transition|gate/i);
});

test('Change rework and reopen require a new revision or cycle', () => {
    assert.doesNotThrow(() => assertStateTransition('change', 'Evidence Ready', 'Needs Rework'));
    assert.throws(() => assertStateTransition('change', 'Needs Rework', 'Draft'), /revision/i);
    assert.doesNotThrow(() => assertStateTransition('change', 'Needs Rework', 'Draft', { newRevision: true }));
    assert.throws(() => assertStateTransition('change', 'Closed', 'Reopened'), /cycle/i);
    assert.doesNotThrow(() => assertStateTransition('change', 'Closed', 'Reopened', { newCycle: true }));
    assert.equal(assertStateTransition('change', 'Closed', 'Reopened', { newCycle: true }).newCycle, true);
    assert.throws(() => assertStateTransition('change', 'Reopened', 'Draft'), /revision/i);
    assert.equal(assertStateTransition('change', 'Reopened', 'Draft',
        { newRevision: true }).newCycle, false);
    assert.deepEqual(nextStates('change', 'Rejected'), []);
});

test('FabTrace follows containment, independent scope review, CAPA and effectiveness', () => {
    const path = ['Open', 'Contained', 'Trace Proposed', 'Scope Reviewed', 'CAPA In Progress', 'Effectiveness Check', 'Closed'];
    assert.deepEqual(INCIDENT_STATES.slice(0, path.length), path);
    for (let index = 0; index < path.length - 1; index++) {
        assert.doesNotThrow(() => assertStateTransition('incident', path[index], path[index + 1]));
    }
    assert.throws(() => assertStateTransition('incident', 'Open', 'Closed'), /transition|gate/i);
    assert.throws(() => assertStateTransition('incident', 'Trace Proposed', 'CAPA In Progress'), /transition|gate/i);
    assert.throws(() => assertStateTransition('incident', 'Closed', 'Reopened'), /cycle/i);
    assert.doesNotThrow(() => assertStateTransition('incident', 'Closed', 'Reopened', { newCycle: true }));
    assert.equal(assertStateTransition('incident', 'Closed', 'Reopened', { newCycle: true }).newCycle, true);
    assert.equal(assertStateTransition('incident', 'Reopened', 'Contained').newCycle, false);
});

test('unknown kind, unknown state and no-op transitions are rejected', () => {
    assert.throws(() => assertStateTransition('unknown', 'Draft', 'Submitted'), /workflow|kind/i);
    assert.throws(() => assertStateTransition('change', 'Bogus', 'Submitted'), /state/i);
    assert.throws(() => assertStateTransition('change', 'Draft', 'Draft'), /transition|same/i);
    assert.throws(() => nextStates('incident', 'Bogus'), /state/i);
});
