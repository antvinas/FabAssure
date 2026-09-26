import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync,
    mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { assertDataIntegrity, openDatabase } from '../data/db.mjs';
import { seedDatabase } from '../data/seed.mjs';
import { acquireApplianceLock } from './appliance-lock.mjs';

const defaultRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function inside(parent, target) {
    const path = relative(parent, target);
    return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function entry(path) { return lstatSync(path, { throwIfNoEntry: false }); }
function digest(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function flush(path) {
    const fd = openSync(path, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
}
function assertNoSidecars(path) {
    for (const suffix of ['-wal', '-shm', '-journal']) {
        if (entry(path + suffix)) throw new Error('Close and recover the SQLite dataset; a journal sidecar remains');
    }
}
function assertPlainFile(path, parent, label) {
    const item = entry(path);
    if (!item) return false;
    if (!item.isFile() || item.isSymbolicLink() || !inside(parent, realpathSync(path))) {
        throw new Error(`${label} must be a regular file inside the portable data directory`);
    }
    return true;
}
function ensurePlainDirectory(path, parent, label) {
    const item = entry(path);
    if (item?.isSymbolicLink() || (item && !item.isDirectory())) {
        throw new Error(`${label} must be an ordinary local directory, not a link`);
    }
    if (!item) mkdirSync(path);
    const real = realpathSync(path);
    if (!inside(parent, real)) throw new Error(`${label} must stay inside the portable root`);
    return real;
}
function validateBackup(path, expectedDatasetId) {
    if (typeof expectedDatasetId !== 'string' || !expectedDatasetId) {
        throw new Error('Old SQLite dataset has no initialized instance identity');
    }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        db.exec('PRAGMA foreign_keys = ON');
        assertDataIntegrity(db);
        if (db.prepare('SELECT id FROM dataset_instances WHERE slot=1').get()?.id !== expectedDatasetId) {
            throw new Error('Local backup dataset identity differs from the active dataset');
        }
    } finally {
        db.close();
    }
}

export async function resetDemo({ root = defaultRoot } = {}) {
    if (typeof root !== 'string' || !root) throw new TypeError('Portable root is required');
    const localRoot = resolve(root);
    const realRoot = realpathSync(localRoot);
    const lock = await acquireApplianceLock(realRoot);
    let stagedFile;
    let replacementAttempted = false;
    try {
        const realDataDir = ensurePlainDirectory(join(localRoot, 'data'), realRoot, 'SQLite data root directory');
        const activeFile = join(realDataDir, 'fabassure-demo.sqlite');
        const hadActive = assertPlainFile(activeFile, realDataDir, 'Active SQLite file');
        assertNoSidecars(activeFile);
        const realBackupsDir = ensurePlainDirectory(join(realDataDir, 'backups'), realDataDir, 'SQLite backups directory');
        const token = randomUUID().toUpperCase();
        const datasetInstanceId = `DATASET-${token}`;
        stagedFile = join(realDataDir, `.fabassure-reset-${token}.sqlite`);
        const backupName = `fabassure-demo-${new Date().toISOString().replace(/[:.]/g, '-')}-${token}.sqlite`;
        const backupFile = join(realBackupsDir, backupName);
        const fresh = openDatabase(stagedFile);
        try {
            seedDatabase(fresh, { instanceId: datasetInstanceId });
            assertDataIntegrity(fresh);
        } finally {
            fresh.close();
        }
        assertPlainFile(stagedFile, realDataDir, 'Staged SQLite file');
        assertNoSidecars(stagedFile);
        flush(stagedFile);

        if (assertPlainFile(activeFile, realDataDir, 'Active SQLite file') !== hadActive) {
            throw new Error('Active SQLite dataset changed during reset');
        }
        assertNoSidecars(activeFile);
        ensurePlainDirectory(realBackupsDir, realDataDir, 'SQLite backups directory');
        if (hadActive) {
            const size = statSync(activeFile).size;
            const hash = digest(activeFile);
            const oldId = new DatabaseSync(activeFile, { readOnly: true });
            let oldDatasetId;
            try {
                oldDatasetId = oldId.prepare('SELECT id FROM dataset_instances WHERE slot=1').get()?.id;
            } finally {
                oldId.close();
            }
            if (typeof oldDatasetId !== 'string' || !oldDatasetId) {
                throw new Error('Old SQLite dataset has no initialized instance identity');
            }
            const pendingBackup = backupFile + '.pending';
            copyFileSync(activeFile, pendingBackup, constants.COPYFILE_EXCL);
            flush(pendingBackup);
            if (statSync(pendingBackup).size !== size || digest(pendingBackup) !== hash ||
                statSync(activeFile).size !== size || digest(activeFile) !== hash) {
                throw new Error('Local backup and active SQLite dataset no longer match');
            }
            validateBackup(pendingBackup, oldDatasetId);
            if (statSync(pendingBackup).size !== size || digest(pendingBackup) !== hash) {
                throw new Error('Backup validation changed the copied SQLite bytes');
            }
            renameSync(pendingBackup, backupFile);
        }
        assertNoSidecars(activeFile);
        assertNoSidecars(stagedFile);
        assertPlainFile(activeFile, realDataDir, 'Active SQLite file');
        assertPlainFile(stagedFile, realDataDir, 'Staged SQLite file');
        replacementAttempted = true;
        renameSync(stagedFile, activeFile);
        stagedFile = undefined;
        const current = openDatabase(activeFile);
        try {
            assertDataIntegrity(current);
            if (current.prepare('SELECT id FROM dataset_instances WHERE slot=1').get()?.id !== datasetInstanceId) {
                throw new Error('Reset dataset identity differs from the staged dataset');
            }
        } finally {
            current.close();
        }
        return { datasetInstanceId, backupFile: hadActive ? backupFile : null };
    } catch (error) {
        // Keep both local copies whenever replacement was attempted and its outcome may be uncertain.
        if (!replacementAttempted && stagedFile && existsSync(stagedFile)) unlinkSync(stagedFile);
        throw error;
    } finally {
        await lock.close();
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    resetDemo().then(result => {
        process.stdout.write(JSON.stringify({ status: 'pass', synthetic: true, datasetInstanceId: result.datasetInstanceId, backupFile: result.backupFile ? 'data/backups/' + result.backupFile.split(/[\\/]/).at(-1) : null }) + '\n');
    }).catch(error => {
        process.stderr.write(`FabAssure reset failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}
