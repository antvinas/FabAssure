export const CHANGE_STATES = Object.freeze([
    'Draft', 'Submitted', 'Risk Classified', 'Plan Approved',
    'Verification In Progress', 'Evidence Ready', 'Independent Review',
    'Accepted', 'Effectiveness Monitoring', 'Closed',
    'Needs Rework', 'Rejected', 'Reopened'
]);

export const INCIDENT_STATES = Object.freeze([
    'Open', 'Contained', 'Trace Proposed', 'Scope Reviewed',
    'CAPA In Progress', 'Effectiveness Check', 'Closed', 'Reopened'
]);

const transitions = Object.freeze({
    change: Object.freeze({
        Draft: ['Submitted'],
        Submitted: ['Risk Classified', 'Rejected'],
        'Risk Classified': ['Plan Approved', 'Needs Rework', 'Rejected'],
        'Plan Approved': ['Verification In Progress', 'Needs Rework'],
        'Verification In Progress': ['Evidence Ready', 'Needs Rework'],
        'Evidence Ready': ['Independent Review', 'Needs Rework'],
        'Independent Review': ['Accepted', 'Needs Rework', 'Rejected'],
        Accepted: ['Effectiveness Monitoring', 'Reopened'],
        'Effectiveness Monitoring': ['Closed', 'Reopened'],
        Closed: ['Reopened'],
        'Needs Rework': ['Draft'],
        Rejected: [],
        Reopened: ['Draft']
    }),
    incident: Object.freeze({
        Open: ['Contained'],
        Contained: ['Trace Proposed'],
        'Trace Proposed': ['Scope Reviewed'],
        'Scope Reviewed': ['CAPA In Progress', 'Trace Proposed'],
        'CAPA In Progress': ['Effectiveness Check'],
        'Effectiveness Check': ['Closed', 'Reopened'],
        Closed: ['Reopened'],
        Reopened: ['Contained', 'CAPA In Progress']
    })
});

function graphFor(kind) {
    if (!Object.hasOwn(transitions, kind)) throw new TypeError('Unknown workflow kind');
    return transitions[kind];
}

export function nextStates(kind, from) {
    const graph = graphFor(kind);
    if (!Object.hasOwn(graph, from)) throw new RangeError(`Unknown ${kind} state`);
    return [...graph[from]];
}

export function assertStateTransition(kind, from, to, context = {}) {
    const allowed = nextStates(kind, from);
    if (!allowed.includes(to)) throw new Error(`Invalid ${kind} transition from ${from} to ${to}`);
    const needsRevision = (kind === 'change' &&
        (from === 'Needs Rework' || from === 'Reopened') && to === 'Draft') ||
        (kind === 'incident' && from === 'Scope Reviewed' && to === 'Trace Proposed');
    // Reopening creates one cycle on entry; leaving Reopened continues that cycle.
    const needsCycle = to === 'Reopened';
    if (needsRevision && context.newRevision !== true) {
        throw new Error('A new revision is required for rework');
    }
    if (needsCycle && context.newCycle !== true) {
        throw new Error('A new cycle is required for reopening');
    }
    return { kind, from, to, newRevision: needsRevision, newCycle: needsCycle };
}
