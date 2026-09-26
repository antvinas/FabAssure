import { createHash, randomUUID } from 'node:crypto';
import { assertValidatedTransaction } from '../data/db.mjs';

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

function canonicalValue(value, depth = 0) {
    if (depth > 16) throw new RangeError('Audit payload nesting is too deep');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
        if (Reflect.ownKeys(value).length !== value.length + 1) {
            throw new TypeError('Audit payload array cannot be sparse or have extra properties');
        }
        return Array.from({ length: value.length }, (_, index) => {
            if (!Object.hasOwn(value, index)) throw new TypeError('Audit payload array cannot be sparse');
            return canonicalValue(value[index], depth + 1);
        });
    }
    if (typeof value === 'object' &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
        const ordered = Object.create(null);
        const keys = Reflect.ownKeys(value);
        for (const key of keys) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
                throw new TypeError('Audit payload object has an unsupported property');
            }
        }
        for (const key of keys.sort()) ordered[key] = canonicalValue(value[key], depth + 1);
        return ordered;
    }
    throw new TypeError('Audit payload must contain JSON values only');
}

function canonicalJson(value) {
    return JSON.stringify(canonicalValue(value));
}

function requiredText(value, label) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new TypeError(`${label} is required`);
    }
    return value.trim();
}

function optionalText(value, label) {
    return value == null ? null : requiredText(value, label);
}

function canonicalUtc(value) {
    const text = requiredText(value, 'Audit UTC time');
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/.test(text) ||
        Number.isNaN(Date.parse(text)) || new Date(text).toISOString() !== text) {
        throw new TypeError('Audit time must be canonical UTC');
    }
    return text;
}

function digestEnvelope(row) {
    const envelope = {
        id: row.id,
        datasetInstanceId: row.dataset_instance_id,
        recordedAt: row.recorded_at,
        actorId: row.actor_id,
        simulatedRole: row.simulated_role,
        entityType: row.entity_type,
        entityId: row.entity_id,
        entityRevisionId: row.entity_revision_id,
        action: row.action,
        priorState: row.prior_state,
        newState: row.new_state,
        reason: row.reason,
        payloadSha256: row.payload_sha256,
        previousDigest: row.previous_digest
    };
    if (row.system_principal_id != null) {
        envelope.principalKind = 'System';
        envelope.systemPrincipalId = row.system_principal_id;
    }
    return canonicalJson(envelope);
}

export function appendAuditEvent(db, input) {
    assertValidatedTransaction(db);
    if (!input || typeof input !== 'object') throw new TypeError('Audit event is required');
    const dataset = db.prepare('SELECT id FROM dataset_instances WHERE slot=1').get();
    if (!dataset) throw new Error('Audit dataset instance is missing');
    const systemPrincipalId = input.systemPrincipalId == null ? null :
        requiredText(input.systemPrincipalId, 'System principal ID');
    if (systemPrincipalId && input.actorId != null) {
        throw new Error('Audit event has exactly one principal');
    }
    const actorId = systemPrincipalId ? null : requiredText(input.actorId, 'Audit actor ID');
    const actor = actorId ? db.prepare('SELECT role FROM demo_actors WHERE id=?').get(actorId) : null;
    if (actorId && !actor) throw new Error('Audit actor is unknown');
    if (systemPrincipalId && !db.prepare('SELECT id FROM system_principals WHERE id=?')
        .get(systemPrincipalId)) throw new Error('Audit system principal is unknown');
    const payload = canonicalValue(Object.hasOwn(input, 'payload') ? input.payload : {});
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
        throw new TypeError('Audit payload must be a JSON object');
    }
    if (input.ruleVersion != null) payload.ruleVersion = requiredText(input.ruleVersion, 'Audit rule version');
    if (input.linkedEvidenceIds != null) {
        if (!Array.isArray(input.linkedEvidenceIds) ||
            input.linkedEvidenceIds.some(id => typeof id !== 'string' || id.trim().length === 0)) {
            throw new TypeError('Audit linked evidence IDs must be nonempty strings');
        }
        payload.linkedEvidenceIds = [...input.linkedEvidenceIds];
    }
    const payloadJson = canonicalJson(payload);
    if (payloadJson.length > 32768) throw new RangeError('Audit payload is too large');
    const previous = db.prepare(
        'SELECT digest FROM audit_events WHERE dataset_instance_id=? ORDER BY sequence DESC LIMIT 1'
    ).get(dataset.id)?.digest ?? null;
    const row = {
        id: optionalText(input.id, 'Audit ID') ?? `AUD-${randomUUID()}`,
        dataset_instance_id: dataset.id,
        recorded_at: canonicalUtc(input.recordedAt),
        actor_id: actorId,
        simulated_role: systemPrincipalId ? 'System' : actor.role,
        system_principal_id: systemPrincipalId,
        entity_type: requiredText(input.entityType, 'Audit entity type'),
        entity_id: requiredText(input.entityId, 'Audit entity ID'),
        entity_revision_id: optionalText(input.entityRevisionId, 'Audit revision ID'),
        action: requiredText(input.action, 'Audit action'),
        prior_state: optionalText(input.priorState, 'Audit prior state'),
        new_state: optionalText(input.newState, 'Audit new state'),
        reason: optionalText(input.reason, 'Audit reason'),
        payload_json: payloadJson,
        payload_sha256: sha256(payloadJson),
        previous_digest: previous
    };
    row.digest = sha256(digestEnvelope(row));
    db.prepare(`
        INSERT INTO audit_events (
            id,dataset_instance_id,recorded_at,actor_id,simulated_role,system_principal_id,
            entity_type,entity_id,entity_revision_id,action,prior_state,new_state,
            reason,payload_json,payload_sha256,previous_digest,digest
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
        row.id, row.dataset_instance_id, row.recorded_at, row.actor_id, row.simulated_role,
        row.system_principal_id,
        row.entity_type, row.entity_id, row.entity_revision_id, row.action, row.prior_state,
        row.new_state, row.reason, row.payload_json, row.payload_sha256,
        row.previous_digest, row.digest
    );
    return { id: row.id, digest: row.digest, payloadSha256: row.payload_sha256 };
}

export function verifyAuditChain(db, expectedHead = null) {
    const rows = db.prepare('SELECT * FROM audit_events ORDER BY sequence').all();
    const previousByDataset = new Map();
    for (const row of rows) {
        let parsed;
        try { parsed = JSON.parse(row.payload_json); } catch { throw new Error(`Audit payload integrity failure: ${row.id}`); }
        if (canonicalJson(parsed) !== row.payload_json || sha256(row.payload_json) !== row.payload_sha256) {
            throw new Error(`Audit payload digest mismatch: ${row.id}`);
        }
        if (row.system_principal_id != null) {
            if (row.actor_id != null || row.simulated_role !== 'System' ||
                !db.prepare('SELECT id FROM system_principals WHERE id=?')
                    .get(row.system_principal_id)) {
                throw new Error(`Audit system principal integrity failure: ${row.id}`);
            }
        } else {
            const actor = db.prepare('SELECT role FROM demo_actors WHERE id=?').get(row.actor_id);
            if (!actor || actor.role !== row.simulated_role) {
                throw new Error(`Audit actor integrity failure: ${row.id}`);
            }
        }
        const previous = previousByDataset.get(row.dataset_instance_id) ?? null;
        if (row.previous_digest !== previous || sha256(digestEnvelope(row)) !== row.digest) {
            throw new Error(`Audit chain digest mismatch: ${row.id}`);
        }
        previousByDataset.set(row.dataset_instance_id, row.digest);
    }
    const lastDigest = rows.at(-1)?.digest ?? null;
    if (expectedHead !== null) {
        if (!expectedHead || !Number.isInteger(expectedHead.count) || expectedHead.count < 0 ||
            expectedHead.lastDigest !== lastDigest || expectedHead.count !== rows.length) {
            throw new Error('Audit local head anchor mismatch');
        }
    }
    return { valid: true, count: rows.length, lastDigest, anchored: expectedHead !== null };
}
