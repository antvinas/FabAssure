import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const builder = join(root, 'scripts', 'build-portable.ps1');
const archive = process.env.FABASSURE_NODE_ARCHIVE || '';
const sourceFiles = [
    'src/server/main.mjs', 'src/server/http.mjs', 'src/server/appliance-lock.mjs',
    'src/server/reset.mjs', 'src/server/offline-verify.mjs',
    'src/data/db.mjs', 'src/data/seed.mjs', 'src/data/schema.sql', 'src/data/schema-v2.sql', 'src/data/schema-v3.sql', 'src/data/schema-v4.sql', 'src/data/schema-v5.sql', 'src/data/schema-v6.sql', 'src/data/schema-v7.sql', 'src/data/schema-v8.sql', 'src/data/schema-v9.sql',
    'src/domain/audit.mjs', 'src/domain/capa-service.mjs', 'src/domain/change-service.mjs',
    'src/domain/change-effectiveness-service.mjs',
    'src/domain/change-effectiveness-source.mjs',
    'src/domain/document-service.mjs', 'src/domain/effectiveness.mjs',
    'src/domain/incident-service.mjs', 'src/domain/incident-effectiveness-service.mjs', 'src/domain/equipment-timeline.mjs', 'src/domain/quality-metrics.mjs', 'src/domain/risk.mjs',
    'src/domain/state.mjs', 'src/domain/trace.mjs', 'src/domain/trace-source.mjs',
    'assets/ui/index.html', 'assets/ui/app.js', 'assets/ui/styles.css',
    'start-fabassure.cmd', 'reset-demo.cmd', 'verify-offline.cmd',
    'README_FIRST_KO.md'
];

function allFiles(directory, relativePath = '') {
    return readdirSync(join(directory, relativePath), { withFileTypes: true }).flatMap(entry => {
        const path = join(relativePath, entry.name);
        return entry.isDirectory() ? allFiles(directory, path) : [path.replaceAll('\\', '/')];
    });
}

function runBuilder(source, target, script = builder) {
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-NodeArchive', source, '-OutputDirectory', target], {
        encoding: 'utf8', timeout: 120000
    });
}

test('portable package contains the pinned local Node runtime, license and only runtime source', () => {
    assert.ok(existsSync(archive), `Provide the official Node archive via FABASSURE_NODE_ARCHIVE: ${archive}`);
    const temporary = mkdtempSync(join(tmpdir(), 'fabassure-package-'));
    const output = join(temporary, 'FabAssure');
    try {
        const built = runBuilder(archive, output);
        assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
        const version = spawnSync(join(output, 'runtime', 'node.exe'), ['--version'], { encoding: 'utf8' });
        assert.equal(version.status, 0);
        assert.equal(version.stdout.trim(), 'v24.19.0');
        assert.ok(readFileSync(join(output, 'runtime', 'LICENSE'), 'utf8').includes('Node.js'));
        assert.deepEqual(allFiles(output).sort(), [...sourceFiles, 'runtime/node.exe', 'runtime/LICENSE', 'manifest.json'].sort());
        const guide = readFileSync(join(output, 'README_FIRST_KO.md'), 'utf8');
        for (const expected of ['start-fabassure.cmd', 'reset-demo.cmd',
            'verify-offline.cmd', 'Ctrl+C', 'data/backups', '127.0.0.1:4310']) {
            assert.ok(guide.includes(expected), `missing Korean launch guidance: ${expected}`);
        }
        const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
        assert.equal(manifest.nodeVersion, 'v24.19.0');
        assert.deepEqual(manifest.files.map(item => item.path).sort(), [...sourceFiles].sort());
        for (const item of manifest.files) {
            assert.match(item.sha256, /^[a-f0-9]{64}$/);
            assert.equal(item.sha256, createHash('sha256').update(readFileSync(join(output, item.path))).digest('hex'), item.path);
        }
        assert.match(readFileSync(join(output, 'src/server/main.mjs'), 'utf8'), /127\.0\.0\.1|listenLocal/);
    } finally {
        assert.ok(resolve(temporary).startsWith(resolve(tmpdir())), 'Cleanup escaped temporary root');
        rmSync(temporary, { recursive: true, force: true });
    }
});

test('portable builder rejects a junction that redirects an output under dist outside the project', t => {
    assert.ok(existsSync(archive), `Provide the official Node archive via FABASSURE_NODE_ARCHIVE: ${archive}`);
    const temporary = mkdtempSync(join(tmpdir(), 'fabassure-package-link-'));
    const isolated = join(temporary, 'project');
    const external = join(temporary, 'external');
    const junction = join(isolated, 'dist');
    try {
        mkdirSync(join(isolated, 'scripts'), { recursive: true });
        mkdirSync(external);
        copyFileSync(builder, join(isolated, 'scripts', 'build-portable.ps1'));
        try {
            symlinkSync(external, junction, 'junction');
        } catch (error) {
            if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
                t.skip(`Windows junction unavailable: ${error.code}`);
                return;
            }
            throw error;
        }
        const output = join(junction, 'FabAssure');
        const built = runBuilder(archive, output, join(isolated, 'scripts', 'build-portable.ps1')).status;
        assert.notEqual(built, 0);
        assert.ok(!existsSync(join(external, 'FabAssure')), 'Package escaped through the dist junction');
    } finally {
        if (existsSync(junction)) unlinkSync(junction);
        assert.ok(resolve(temporary).startsWith(resolve(tmpdir())), 'Cleanup escaped temporary root');
        rmSync(temporary, { recursive: true, force: true });
    }
});

test('portable builder rejects an archive with an unapproved digest before writing output', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'fabassure-package-negative-'));
    try {
        const badArchive = join(temporary, 'node.zip');
        writeFileSync(badArchive, 'not the pinned Node archive');
        const output = join(temporary, 'FabAssure');
        const built = runBuilder(badArchive, output);
        assert.notEqual(built.status, 0);
        assert.match(`${built.stdout}\n${built.stderr}`, /SHA-?256|digest|checksum/i);
        assert.ok(!existsSync(output));
    } finally {
        assert.ok(resolve(temporary).startsWith(resolve(tmpdir())), 'Cleanup escaped temporary root');
        rmSync(temporary, { recursive: true, force: true });
    }
});
