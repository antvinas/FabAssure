import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const launcher = join(root, 'start-fabassure.cmd');
const cmd = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');

function fixture() {
    const temporary = mkdtempSync(join(tmpdir(), 'fabassure launch '));
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

test('Windows launcher uses its bundled runtime from a different working directory without PATH', () => {
    const { portable, cleanup } = fixture();
    try {
        const runtime = join(portable, 'runtime');
        const server = join(portable, 'src', 'server');
        mkdirSync(runtime);
        mkdirSync(server, { recursive: true });
        copyFileSync(process.execPath, join(runtime, 'node.exe'));
        copyFileSync(launcher, join(portable, 'start-fabassure.cmd'));
        writeFileSync(join(server, 'main.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync('launch.json', JSON.stringify({ cwd: process.cwd(), main: process.argv[1] }));\n`);
        const child = spawnSync(cmd, ['/d', '/c', join(portable, 'start-fabassure.cmd')], {
            cwd: tmpdir(), env: { ...process.env, PATH: '' }, encoding: 'utf8', timeout: 30000
        });
        assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
        const launch = JSON.parse(readFileSync(join(portable, 'launch.json'), 'utf8'));
        assert.equal(resolve(launch.cwd), resolve(portable));
        assert.equal(resolve(launch.main), resolve(join(server, 'main.mjs')));
    } finally {
        cleanup();
    }
});

test('Windows launcher fails clearly when the bundled runtime is absent', () => {
    const { portable, cleanup } = fixture();
    try {
        copyFileSync(launcher, join(portable, 'start-fabassure.cmd'));
        const child = spawnSync(cmd, ['/d', '/c', join(portable, 'start-fabassure.cmd')], {
            cwd: tmpdir(), env: { ...process.env, PATH: '' }, encoding: 'utf8', timeout: 30000
        });
        assert.notEqual(child.status, 0);
        assert.match(`${child.stdout}\n${child.stderr}`, /bundled Node runtime is missing/i);
        assert.ok(!existsSync(join(portable, 'launch.json')));
    } finally {
        cleanup();
    }
});
