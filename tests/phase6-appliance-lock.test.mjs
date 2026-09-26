import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireApplianceLock } from '../src/server/appliance-lock.mjs';

test('one portable folder permits one local appliance process and releases after close', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fabassure-pipe-lock-'));
    let first;
    let second;
    try {
        first = await acquireApplianceLock(root);
        await assert.rejects(() => acquireApplianceLock(root), /already active|already using/i);
        await first.close();
        first = null;
        second = await acquireApplianceLock(root);
        assert.ok(second);
    } finally {
        await second?.close();
        await first?.close();
        assert.ok(resolve(root).startsWith(resolve(tmpdir())), 'Cleanup escaped temporary root');
        rmSync(root, { recursive: true, force: true });
    }
});

test('two close callers both wait until the portable-folder lock is released', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fabassure-pipe-close-'));
    const originalClose = NetServer.prototype.close;
    let lock;
    let reopened;
    let firstClose;
    NetServer.prototype.close = function (callback) {
        return originalClose.call(this, error => setTimeout(() => callback?.(error), 80));
    };
    try {
        lock = await acquireApplianceLock(root);
        firstClose = lock.close();
        let firstSettled = false;
        firstClose.then(() => { firstSettled = true; });
        await lock.close();
        assert.equal(firstSettled, true, 'Second close returned before the first finished');
        reopened = await acquireApplianceLock(root);
        assert.ok(reopened);
    } finally {
        await firstClose;
        await reopened?.close();
        await lock?.close();
        NetServer.prototype.close = originalClose;
        assert.ok(resolve(root).startsWith(resolve(tmpdir())), 'Cleanup escaped temporary root');
        rmSync(root, { recursive: true, force: true });
    }
});
