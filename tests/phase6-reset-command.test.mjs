import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/data/db.mjs';
import { seedDatabase } from '../src/data/seed.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const commandFile = join(root, 'reset-demo.cmd');
const cmd = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');

function fixture() {
    const temporary = mkdtempSync(join(tmpdir(), 'fabassure reset command '));
    const portable = join(temporary, 'portable demo');
    mkdirSync(portable);
    return {
        portable,
        cleanup() {
            assert.ok(resolve(temporary).startsWith(resolve(tmpdir())), 'Cleanup escaped temporary root');
            rmSync(temporary, { recursive: true, force: true });
        }
    };
}

test('Windows reset command uses bundled Node and creates a new local dataset from any working directory', () => {
    const item = fixture();
    try {
        mkdirSync(join(item.portable, 'runtime'));
        mkdirSync(join(item.portable, 'data'));
        copyFileSync(process.execPath, join(item.portable, 'runtime', 'node.exe'));
        cpSync(join(root, 'src'), join(item.portable, 'src'), { recursive: true });
        copyFileSync(commandFile, join(item.portable, 'reset-demo.cmd'));
        const db = openDatabase(join(item.portable, 'data', 'fabassure-demo.sqlite'));
        try {
            seedDatabase(db, { instanceId: 'DATASET-COMMAND-OLD' });
        } finally {
            db.close();
        }
        const child = spawnSync(cmd, ['/d', '/c', join(item.portable, 'reset-demo.cmd')], {
            cwd: tmpdir(), env: { ...process.env, PATH: '' }, encoding: 'utf8', timeout: 30000
        });
        assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
        const result = JSON.parse(child.stdout.trim());
        assert.equal(result.status, 'pass');
        assert.equal(result.synthetic, true);
        assert.match(result.datasetInstanceId, /^DATASET-/);
        assert.notEqual(result.datasetInstanceId, 'DATASET-COMMAND-OLD');
        assert.ok(existsSync(join(item.portable, result.backupFile)));
        const active = openDatabase(join(item.portable, 'data', 'fabassure-demo.sqlite'));
        try {
            assert.equal(active.prepare('SELECT id FROM dataset_instances WHERE slot=1').get().id, result.datasetInstanceId);
        } finally {
            active.close();
        }
    } finally {
        item.cleanup();
    }
});

test('Windows reset command fails clearly without its bundled runtime', () => {
    const item = fixture();
    try {
        copyFileSync(commandFile, join(item.portable, 'reset-demo.cmd'));
        const child = spawnSync(cmd, ['/d', '/c', join(item.portable, 'reset-demo.cmd')], {
            cwd: tmpdir(), env: { ...process.env, PATH: '' }, encoding: 'utf8', timeout: 30000
        });
        assert.notEqual(child.status, 0);
        assert.match(`${child.stdout}\n${child.stderr}`, /bundled Node runtime is missing/i);
    } finally {
        item.cleanup();
    }
});
