import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../assets/ui/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../assets/ui/app.js', import.meta.url), 'utf8');

test('product shell presents one sample-data cue and a dedicated demo-information view', () => {
    assert.equal((html.match(/샘플 데이터/g) ?? []).length, 1);
    assert.match(html, /data-view="demoInfo"/);
    assert.match(app, /function renderDemoInfo\(\)/);
    for (const fact of ['샘플 데이터', 'MES', '로컬', '모의 사용자']) {
        assert.match(app, new RegExp(fact));
    }
    assert.doesNotMatch(html, /REVIEW_PENDING|Claude|Codex|Sol|Luna|SHA-256/);
    assert.doesNotMatch(app, /REVIEW_PENDING/);
});
