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

test('product copy uses one six-step flow and Korean operator messages', () => {
    const steps = ['변경', '검증', '근거', '검토', '수락', '효과성'];
    const chain = app.slice(app.indexOf('const decisionChain'), app.indexOf('function chainStepIndex'));
    assert.deepEqual([...chain.matchAll(/ko: '([^']+)'/g)].map(match => match[1]), steps);
    assert.match(app, /변경 → 검증 → 근거 → 검토 → 수락 → 효과성/);
    assert.doesNotMatch(app, /recorded: \$\{|source records linked|CHANGE · EVIDENCE · DECISION/);
    assert.doesNotMatch(app, /cannot (evaluate|close|reopen) Change/);
    assert.doesNotMatch(html, /127\.0\.0\.1|엔지니어링 결정과 그 증거|app-footer/);
    assert.match(html, />영향 추적</);
    assert.match(html, />설비 이력</);
    assert.doesNotMatch(app, /'카메라 /);
});
