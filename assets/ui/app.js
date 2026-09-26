const state = { view: 'overview', bootstrap: null, actorId: 'ACT-MFG',
    changeId: null, detail: null, incidentId: null, incidentDetail: null,
    equipmentList: null, equipmentId: null, equipmentDetail: null,
    navigationRequestNo: 0, pendingNavigationNo: null,
    bootstrapDirty: false, sourceWriteNo: 0, bootstrapWriteNo: 0 };
let startupPromise;
const view = document.getElementById('view');
const actorSelect = document.getElementById('actor-select');
const crumb = document.getElementById('crumb');
const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toast-message');
const toastClose = document.getElementById('toast-close');
const liveRegion = document.getElementById('live-region');
const actorName = document.querySelector('[data-actor-name]');
const actorRole = document.querySelector('[data-actor-role]');
// Display labels do not change the stored workflow values used by server gates.
const labels = Object.freeze({
    states: Object.freeze({
        'Draft': '초안', 'Submitted': '제출됨', 'Risk Classified': '위험 분류됨',
        'Plan Approved': '계획 승인됨', 'Verification In Progress': '검증 진행 중',
        'Evidence Ready': '증거 준비 완료', 'Independent Review': '독립 검토', 'Accepted': '수락됨',
        'Effectiveness Monitoring': '효과성 모니터링', 'Closed': '종결', 'Needs Rework': '재작업 필요',
        'Rejected': '반려', 'Reopened': '재개', 'Open': '발생', 'Contained': '봉쇄됨',
        'Trace Proposed': '추적 제안됨', 'Scope Reviewed': '범위 검토됨', 'CAPA In Progress': 'CAPA 진행 중',
        'Effectiveness Check': '효과성 확인', 'Pass': '합격', 'Hypothesis': '가설', 'Confirmed': '확정',
        'Corrective': '시정', 'Preventive': '예방', 'included': '포함', 'excluded': '제외', 'ambiguous': '불확실'
    }),
    roles: Object.freeze({
        'Manufacturing Engineer': '제조 엔지니어', 'Equipment / Automation Engineer': '설비·자동화 엔지니어',
        'Quality Engineer': '품질 엔지니어', 'Verification Engineer': '검증 엔지니어',
        'Reviewer': '독립 검토자', 'Approver': '승인자', 'Production Manager': '생산 관리자',
        'Proposer': '요청자'
    }),
    views: Object.freeze({
        overview: '개요', changes: '변경 관리', changeDetail: '변경 상세', fabtrace: 'FabTrace',
        equipment: '설비', evidence: '증거', documents: '관리 문서', review: '검토 대기열', audit: '감사 기록',
        demoInfo: '데모 정보'
    })
});
const labelFor = (group, value) => Object.hasOwn(group, value) ? group[value] : null;
const roleLabel = role => labelFor(labels.roles, role) ?? String(role ?? '—');
const actorDisplayName = actor => {
    const position = state.bootstrap?.actors.findIndex(item => item.id === actor?.id) ?? -1;
    return position >= 0 ? `담당자 ${position + 1}` : '담당자';
};
const roleDisplay = role => {
    const value = String(role ?? '—');
    if (labelFor(labels.roles, value)) return roleLabel(value);
    return value.replace('Separate ', '요청자·평가자와 다른 ').replace('Independent ', '독립 ')
        .replaceAll('Quality Engineer', '품질 엔지니어').replaceAll('Verification Engineer', '검증 엔지니어')
        .replaceAll('Manufacturing Engineer', '제조 엔지니어').replaceAll('Equipment Engineer', '설비 엔지니어')
        .replaceAll('Production Manager', '생산 관리자').replaceAll('Reviewer', '검토자')
        .replaceAll('Approver', '승인자').replaceAll(' or ', ' 또는 ').replaceAll(' (not the evaluator or proposer)', '');
};
const actionLabels = Object.freeze({
    submitChange: '변경 제출', classifyChange: '위험 분류', approvePlan: '검증 계획 승인',
    startVerification: '검증 시작', recordBaselineSet: '기준 근거 연결', linkSourceSet: '변경 후 근거 연결',
    linkPassingSourceSet: '변경 후 근거 연결', addMeasurementEvidence: '측정 근거 연결',
    recordAlignmentResult: '정렬 기준 평가', recordAoiResults: 'AOI 기준 평가',
    markEvidenceReady: '증거 준비 완료', reviseFailedChange: '재작업 개정 생성',
    beginIndependentReview: '독립 검토 시작', recordIndependentReview: '독립 검토 기록',
    acceptChange: '변경 수락', classifyLegacyAcceptance: '과거 수락 분류',
    reviseFailedEffectivenessChange: '효과성 불합격 후 새 개정 시작',
    reviseExpiredChange: '만료 후 새 개정 시작', containIncident: '봉쇄 기록',
    recordIncidentLkg: '마지막 정상 관측 기록', proposeIncidentTrace: '영향 범위 계산',
    reviseIncidentTrace: '추적 범위 수정', reviewIncidentScope: '영향 범위 검토'
});
const actionLabel = next => actionLabels[next?.action] ?? next?.label ?? '다음 작업';
const auditActionLabels = Object.freeze({
    'change-created': '변경 등록', 'change-submitted': '변경 제출', 'risk-classified': '위험 분류',
    'plan-approved': '검증 계획 승인', 'verification-started': '검증 시작',
    'baseline-evidence-added': '기준 근거 연결', 'measurement-evidence-added': '측정 근거 연결',
    'aoi-evidence-added': 'AOI 근거 연결', 'criterion-passed': '기준 합격',
    'aoi-criteria-passed': 'AOI 기준 합격', 'evidence-ready': '증거 준비 완료',
    'independent-review-started': '독립 검토 시작', 'independent-review-passed': '독립 검토 합격',
    'change-accepted': '변경 수락', 'change-effectiveness-evaluated': '효과성 확인',
    'change-monitoring-closed': '모니터링 종결', 'change-monitoring-reopened': '변경 재개',
    'incident-closed': '사건 종결', 'incident-reopened': '사건 재개'
});

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
const text = escapeHtml;
const dateText = value => value ? escapeHtml(String(value).replace('T', ' ').replace('.000Z', ' UTC')) : '—';
const number = value => value == null ? '—' : Number(value).toLocaleString('en-US');
const percent = value => value == null ? '—' : `${(Number(value) * 100).toFixed(2)}%`;
const shortHash = value => value ? `${String(value).slice(0, 10)}…` : '—';
const statusClass = value => /Accepted|Closed|Pass/.test(value) ? 'good' :
    /Failed|Needs Rework|Rejected/.test(value) ? 'bad' :
        /Review|Progress|Submitted/.test(value) ? 'warn' : '';
const chip = value => {
    const stored = String(value ?? '');
    const korean = labelFor(labels.states, stored);
    return `<span class="status-chip ${statusClass(stored)}"${korean ? ` title="${text(stored)}"` : ''}>${text(korean ?? stored)}</span>`;
};
const row = (label, value) => `<div class="field"><span class="field-label">${text(label)}</span><span class="field-value">${text(value ?? '—')}</span></div>`;
const empty = (title, description) => `<div class="empty-state"><strong>${text(title)}</strong><p>${text(description)}</p></div>`;

async function request(path, options = {}) {
    const response = await fetch(path, { cache: 'no-store', ...options });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || '요청을 처리하지 못했습니다.');
    return body;
}

async function reload() {
    const requestNo = ++state.navigationRequestNo;
    const writeNo = state.sourceWriteNo;
    let bootstrap;
    try { bootstrap = await request('/api/bootstrap'); }
    catch (error) {
        if (requestNo !== state.navigationRequestNo) return;
        throw error;
    }
    if (requestNo !== state.navigationRequestNo) {
        if (!state.bootstrap) {
            // A navigation made during startup still needs the first local snapshot.
            installBootstrap(bootstrap);
            state.bootstrapWriteNo = writeNo;
            state.bootstrapDirty = true;
            render();
        }
        return;
    }
    let changeId = state.changeId;
    let detail = state.detail;
    if (changeId) {
        try { detail = await request(`/api/changes/${encodeURIComponent(changeId)}`); }
        catch { changeId = null; detail = null; }
        if (requestNo !== state.navigationRequestNo) return;
    }
    let incidentId = state.incidentId;
    let incidentDetail = state.incidentDetail;
    if (incidentId) {
        try { incidentDetail = await request(`/api/incidents/${encodeURIComponent(incidentId)}`); }
        catch { incidentId = null; incidentDetail = null; }
        if (requestNo !== state.navigationRequestNo) return;
    }
    installBootstrap(bootstrap);
    state.bootstrapWriteNo = writeNo;
    state.bootstrapDirty = writeNo !== state.sourceWriteNo;
    state.changeId = changeId;
    state.detail = detail;
    state.incidentId = incidentId;
    state.incidentDetail = incidentDetail;
    if (state.view === 'equipment') {
        return loadEquipment(state.equipmentId, requestNo);
    }
    render();
}

function installBootstrap(bootstrap) {
    state.bootstrap = bootstrap;
    const actors = bootstrap.actors;
    if (!actors.some(actor => actor.id === state.actorId)) state.actorId = actors[0]?.id ?? '';
    actorSelect.innerHTML = actors.map(actor => `<option value="${text(actor.id)}">${text(roleLabel(actor.role))} · ${text(actorDisplayName(actor))}</option>`).join('');
    actorSelect.value = state.actorId;
    updateActorIdentity();
}

function updateActorIdentity() {
    const actor = state.bootstrap?.actors.find(item => item.id === state.actorId);
    actorName.textContent = actor ? actorDisplayName(actor) : '—';
    actorRole.textContent = actor ? roleLabel(actor.role) : '—';
}

function announce(message) {
    liveRegion.textContent = message;
}

async function refreshIfCurrent(originNo) {
    if (originNo !== state.navigationRequestNo) {
        await refreshAfterWrite();
        return false;
    }
    const pending = reload();
    const refreshNo = state.navigationRequestNo;
    try { await pending; }
    catch (error) {
        state.bootstrapDirty = true;
        if (refreshNo !== state.navigationRequestNo) {
            await refreshAfterWrite();
            return false;
        }
        throw error;
    }
    if (refreshNo !== state.navigationRequestNo) {
        await refreshAfterWrite();
        return false;
    }
    return true;
}

async function refreshAfterWrite() {
    state.bootstrapDirty = true;
    if (!state.bootstrap || state.pendingNavigationNo !== null) return;
    try { await reload(); }
    catch { state.bootstrapDirty = true; }
}

function settleNavigation(requestNo) {
    if (state.pendingNavigationNo !== requestNo) return;
    state.pendingNavigationNo = null;
    if (state.bootstrap && state.bootstrapDirty &&
        state.sourceWriteNo > state.bootstrapWriteNo) {
        void reload().catch(() => { state.bootstrapDirty = true; });
    }
}

async function commitAndRefresh(pending, originNo) {
    let body;
    try { body = await pending; }
    catch (error) {
        if (originNo !== state.navigationRequestNo) {
            await refreshAfterWrite();
            return { body: null, refreshed: false };
        }
        throw error;
    }
    return { body, refreshed: await refreshIfCurrent(originNo) };
}

function showToast(message, isError = false) {
    clearTimeout(showToast.timer);
    toast.hidden = true;
    // Errors are assertive and stay until dismissed; confirmations are polite and time out.
    toast.setAttribute('role', isError ? 'alert' : 'status');
    toast.className = `toast${isError ? ' error' : ''}`;
    toastMessage.textContent = message;
    toastClose.hidden = !isError;
    toast.hidden = false;
    if (!isError) showToast.timer = setTimeout(() => { toast.hidden = true; }, 6200);
}

function dismissToast() {
    clearTimeout(showToast.timer);
    toast.hidden = true;
    view.focus();
}

function changeButton(change) {
    return `<button type="button" class="table-button" data-open-change="${text(change.id)}">상세 보기</button><details><summary>기록 ID</summary><span class="mono">${text(change.id)}</span></details>`;
}

// Lifecycle steps for the Overview chain. Each saved change or incident sits on exactly one step by its stored state.
const decisionChain = Object.freeze([
    { ko: '변경 초안', en: 'Draft', change: ['Draft'] },
    { ko: '제출·위험 분류', en: 'Submitted · Risk', change: ['Submitted', 'Risk Classified'] },
    { ko: '계획·검증', en: 'Plan · Verification', change: ['Plan Approved', 'Verification In Progress', 'Needs Rework'] },
    { ko: '증거 동결', en: 'Evidence Ready', change: ['Evidence Ready'] },
    { ko: '독립 검토', en: 'Independent Review', change: ['Independent Review'] },
    { ko: '변경 수용', en: 'Change Accepted', change: ['Accepted'] },
    { ko: '이상 추적', en: 'Incident · Trace', incident: ['Open', 'Contained', 'Trace Proposed', 'Scope Reviewed'] },
    { ko: 'CAPA', en: 'CAPA In Progress', incident: ['CAPA In Progress'] },
    { ko: '효과성 확인', change: ['Effectiveness Monitoring'], incident: ['Effectiveness Check'] },
    { ko: '종결', change: ['Closed'], incident: ['Closed'] },
    { ko: '재개', change: ['Reopened'], incident: ['Reopened'] }
]);

function chainStepIndex(kind, stored) {
    return decisionChain.findIndex(step => (step[kind] ?? []).includes(stored));
}

// The current step is where the most recently saved record sits. No saved record means no current step.
function renderDecisionChain(data) {
    const records = [
        ...data.changes.map(item => ({ id: item.id, updatedAt: item.updated_at, index: chainStepIndex('change', item.state) })),
        ...data.incidents.map(item => ({ id: item.id, updatedAt: item.updated_at, index: chainStepIndex('incident', item.state) }))
    ].filter(item => item.index >= 0)
        .sort((a, b) => a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1);
    const latest = records[0] ?? null;
    const steps = decisionChain.map((step, index) => {
        const count = records.filter(item => item.index === index).length;
        const current = latest?.index === index;
        return `<li class="workflow-step${current ? ' current' : ''}"${current ? ' aria-current="step"' : ''}><span class="step-no">${String(index + 1).padStart(2, '0')}</span><strong>${text(step.ko)}</strong><small>${number(count)}건${current ? ' · 현재 단계' : ''}</small></li>`;
    }).join('');
    const summary = latest
        ? `<p class="chain-summary">가장 최근 기록은 ${text(decisionChain[latest.index].ko)} 단계에 있습니다.</p>`
        : '<p class="chain-summary">아직 저장된 결정 기록이 없습니다. 어떤 단계도 현재로 표시하지 않습니다.</p>';
    return `<ol class="workflow decision-chain" aria-label="결정 사슬">${steps}</ol>${summary}`;
}

function renderOverview() {
    const data = state.bootstrap;
    const metrics = data.metrics;
    const awaiting = data.changes.filter(change => ['Evidence Ready', 'Independent Review'].includes(change.state)).length;
    const active = data.changes.filter(change => !['Closed', 'Rejected'].includes(change.state)).length;
    return `<section class="hero"><div class="hero-content"><p class="eyebrow">변경부터 결과까지</p>
        <h1>기록이 판단을 증명합니다</h1>
        <p>제조 변경의 위험 분류, 검증 기준, 측정 근거와 승인 결정을 하나의 이력으로 연결합니다. 이후 이상이 발생하면 영향 LOT과 관리 문서까지 추적합니다.</p>
        <div class="hero-actions"><button type="button" class="button primary hero-start" data-view="changes">변경 관리 시작 →</button><button type="button" class="button subtle" data-view="fabtrace">FabTrace 보기 →</button></div></div>
        <div class="hero-seal">CHANGE · EVIDENCE · DECISION</div></section>
        <div class="stat-grid overview-stats">
            <div class="stat-card emphasis"><span class="label">진행 중인 변경</span><strong class="value">${number(active)}</strong><span class="foot">위험·계획·증거가 연결된 변경 기록</span></div>
            <div class="stat-card teal"><span class="label">독립 결정 대기</span><strong class="value">${number(awaiting)}</strong><span class="foot">검토자와 승인자는 서로 다른 역할</span></div>
            <div class="stat-card muted"><span class="label">검사 단위</span><strong class="value">${number(metrics.inspectedUnits)}</strong><span class="foot">불량 ${number(metrics.rejectedUnits)} · 불량률 ${percent(metrics.rejectRate)}</span></div>
            <div class="stat-card teal"><span class="label">설비 MTBF</span><strong class="value">${number(metrics.mtbfHours)} <small>h</small></strong><span class="foot">고장 ${number(metrics.failureCount)}건 · 관측 ${number(metrics.observationHours)} h</span></div>
        </div>
        <div class="section-head"><div><h2>결정 흐름</h2><p>변경·이상 기록의 현재 단계를 보여줍니다. 각 결정의 역할과 근거는 이력에 남습니다.</p></div></div>
        ${renderDecisionChain(data)}
        <div class="section-head"><div><h2>대표 업무 흐름</h2><p>변경 검증부터 영향 추적과 효과성 확인까지 이어집니다.</p></div></div>
        <div class="three-column overview-paths">
            <div class="card"><div class="card-kicker">변경 검증</div><h3>레시피·정렬 변경</h3><p>핵심 특성의 변경은 L3로 분류됩니다. 첫 측정이 불합격이면 기록을 보존하고 새 개정에서 다시 검증합니다.</p><div class="card-footer"><span class="scenario-tag">위험 분류 · 검증</span><button type="button" class="button subtle" data-view="changes">변경 관리 열기 →</button></div></div>
            <div class="card"><div class="card-kicker">영향 추적</div><h3>정비 후 결함 이탈</h3><p>마지막 정상 관측(LKG), 노출 구간과 설비 이력으로 영향 LOT과 불확실성을 식별합니다.</p><div class="card-footer"><span class="scenario-tag">추적 · CAPA</span><button type="button" class="button subtle" data-view="fabtrace">FabTrace 열기 →</button></div></div>
            <div class="card"><div class="card-kicker">효과성 확인</div><h3>이력을 지우지 않는 재개</h3><p>재발로 새 사이클을 시작해도 원래 범위, CAPA, 종결과 결정 이력을 보존합니다.</p><div class="card-footer"><span class="scenario-tag">모니터링 · 재개</span><button type="button" class="button subtle" data-view="fabtrace">흐름 확인하기 →</button></div></div>
        </div>
        <div class="section-head"><div><h2>최근 변경 기록</h2><p>기록을 열어 결정과 연결된 근거를 확인합니다.</p></div><button type="button" class="button subtle" data-view="changes">전체 변경 보기 →</button></div>
        ${data.changes.length ? renderChangeTable(data.changes.slice(0, 5))
        : empty('아직 변경 기록이 없습니다', '변경 관리에서 새 변경을 등록하세요.')}`;
}

function renderChangeTable(changes) {
    if (!changes.length) return empty('변경 기록이 없습니다', '새 변경을 등록해 검증을 시작하세요.');
    return `<div class="table-wrap"><table><thead><tr><th>기록</th><th>변경</th><th>설비 / 레시피</th><th>상태</th><th>수정 시각 (UTC)</th></tr></thead><tbody>${changes.map(change => `<tr><td>${changeButton(change)}</td><td class="strong">${text(change.title)}</td><td><span class="mono">${text(change.equipment_id)}</span><br><span class="muted mono">${text(change.recipe_revision_id)}</span></td><td>${chip(change.state)}</td><td class="nowrap muted">${dateText(change.updated_at)}</td></tr>`).join('')}</tbody></table></div>`;
}

// Seeded Line B L1 module contrast (see tests/phase3-l1-contrast). Scope, baseline and times are fixed by the seed:
// baseline LOT-B-002 ran on MOD-ALIGN-B, EV-B-MODULE switched to MOD-ALIGN-B-R2 at 2026-08-05 00:00 UTC, and
// LOT-B-003 is the first post-change lot. Only revision 1 has seeded post-change source at these times.
const lineBContrastScope = Object.freeze({ lineId: 'LINE-B', equipmentId: 'EQ-ALIGN-B',
    moduleId: 'MOD-ALIGN-B-R2', recipeRevisionId: 'REC-B-R2', baselineRef: 'AOI-B-002',
    at: '2026-08-04T13:00:00.000Z' });
const lineBContrastTimes = Object.freeze({
    submit: '2026-08-04T13:10:00.000Z', classify: '2026-08-04T13:20:00.000Z', plan: '2026-08-04T13:30:00.000Z',
    start: '2026-08-05T07:00:00.000Z', baseline: '2026-08-05T07:01:00.000Z',
    measurements: '2026-08-05T11:10:00.000Z', aoi: '2026-08-05T11:20:00.000Z',
    alignment: '2026-08-05T12:01:00.000Z', aoiResults: '2026-08-05T12:02:00.000Z',
    ready: '2026-08-05T12:03:00.000Z', reviewStart: '2026-08-05T12:04:00.000Z',
    review: '2026-08-05T12:05:00.000Z', accept: '2026-08-05T12:06:00.000Z' });
const lineBL1RiskInputs = Object.freeze({ severity: 1, occurrence: 1, detectability: 1, scope: 1,
    criticalCharacteristic: false, safetyRelevance: false,
    bases: Object.freeze({ severity: '영향 범위가 해당 모듈로 제한됨',
        occurrence: '기준 검사 불량률 1% 미만', detectability: '출하 전 AOI 전수 검사',
        scope: '설비 모듈 한정', criticalCharacteristic: '핵심 특성 영향 없음',
        safetyRelevance: '안전 영향 없음' }) });
const isLineBContrast = change => change.current_revision_no === 1 &&
    change.line_id === lineBContrastScope.lineId && change.equipment_id === lineBContrastScope.equipmentId &&
    change.module_id === lineBContrastScope.moduleId && change.recipe_revision_id === lineBContrastScope.recipeRevisionId &&
    change.baseline_ref === lineBContrastScope.baselineRef;

// Last seeded process-run end per module (seed.mjs: Line A day 40, Line B LOT-B-005 on the revised module).
const seededRunEnd = Object.freeze({ 'MOD-ALIGN-A': '2026-09-09T11:00:00.000Z',
    'MOD-ALIGN-B-R2': '2026-08-07T11:00:00.000Z' });

// A fixed walkthrough time is kept only if the server would accept it: after the last stored Change event and not
// after server UTC now. Otherwise (e.g. a revision started after Reopen or expiry) the loaded server time is used.
function decisionAt(detail, fixed) {
    const floor = detail.change.updated_at;
    const ceiling = detail.serverNowUtc;
    if (!ceiling || ceiling < floor || (fixed > floor && fixed <= ceiling)) return fixed;
    return ceiling;
}

// Verification needs real later source. When the seeded rows cannot follow this revision, show a reasoned blocked
// step naming the next required source. Nothing is linked and no result is recorded from here.
function postRevisionSourceGap(detail, current, force = false) {
    const change = detail.change;
    const revisionNo = change.current_revision_no;
    const createdAt = current.revision.created_at;
    const seededEnd = Object.hasOwn(seededRunEnd, change.module_id) ? seededRunEnd[change.module_id] : null;
    const afterSeed = !seededEnd || createdAt > seededEnd;
    if (!force && !afterSeed) return null;
    const plan = current.plans?.at(-1) ?? null;
    const started = (detail.audit ?? []).filter(item => item.action === 'verification-started' &&
        item.entity_revision_id === current.revision.id).at(-1)?.recorded_at ?? null;
    const seedFact = !seededEnd ? `모듈 ${change.module_id}에 연결 가능한 원천 기록이 없습니다.` : afterSeed
        ? `${change.module_id}의 마지막 실행(${dateText(seededEnd)})이 개정 R${revisionNo} 생성(${dateText(createdAt)})보다 앞섭니다.`
        : `개정 R${revisionNo}에 연결할 ${change.module_id} / ${change.recipe_revision_id} 원천 기록이 없습니다.`;
    return { action: 'awaitPostRevisionSource', input: null, role: 'Verification Engineer',
        label: `Link post-change source for R${revisionNo}`,
        blocked: `개정 후 근거가 필요합니다. ${seedFact} 이후 원천 기록이 연결될 때까지 합격으로 판정할 수 없습니다.`,
        description: `개정 후 근거가 필요합니다. ${change.equipment_id} / ${change.module_id}의 ${change.recipe_revision_id} 레시피로 LOT ${plan?.post_change_lots ?? '계획된 수'}건, LOT당 정렬 측정 ${plan?.samples_per_lot ?? '계획된 수'}건과 완전한 AOI 검사를 연결하세요. 검증 시작 ${started ? dateText(started) : '이후'}의 실행만 사용합니다. 이전 이력은 보존됩니다.` };
}

function renderChanges() {
    const proposer = state.bootstrap.actors.find(actor => actor.id === state.actorId);
    const mayPropose = ['Manufacturing Engineer', 'Equipment / Automation Engineer',
        'Quality Engineer', 'Production Manager'].includes(proposer?.role);
    return `<div class="page-heading"><div><p class="eyebrow">변경 관리</p><h1>변경 검증</h1><p>범위를 분류하고 검증 계획, 원천 근거와 승인 결정을 연결합니다.</p></div></div>
        <div class="panel-grid"><div class="stack"><div class="section-head no-top-margin"><div><h2>변경 목록</h2><p>${number(state.bootstrap.changes.length)}건</p></div></div>${renderChangeTable(state.bootstrap.changes)}</div>
        <aside class="card"><div class="card-kicker">새 변경</div><h2>변경 등록</h2><p>대상 레시피와 변경 이유를 입력하세요.</p>
            <form id="create-change-form" class="form-grid"><label>제목<input name="title" required maxlength="120" value="정렬 레시피 변경 검증"></label>
            <label>대상 레시피<select name="recipe"><option value="REC-ALIGN-R2">R2 · 정렬 변경</option><option value="REC-ALIGN-R3">R3 · 개선된 정렬 기준</option><option value="REC-B-R2">Line B · 모듈 교체 L1 검증</option></select></label>
            <label>변경 이유<textarea name="reason" required maxlength="400">정렬 편차를 줄이고 AOI 검증을 유지합니다.</textarea></label>
            <details><summary>대상 범위와 연결된 근거</summary><div class="hint-box"><strong>R2 / R3:</strong> LINE-A / EQ-ALIGN-A / MOD-ALIGN-A · 기준 AOI-A-001.<br><strong>Line B L1:</strong> LINE-B / EQ-ALIGN-B / MOD-ALIGN-B-R2 · REC-B-R2 · 기준 AOI-B-002. 모듈 변경 EV-B-MODULE과 이후 LOT-B-003~005가 연결됩니다.</div></details>
            ${mayPropose ? '' : '<div class="warning-box">변경을 등록할 수 있는 역할을 선택하세요.</div>'}
            <button type="submit" class="button primary" ${mayPropose ? '' : 'disabled'}>변경 등록 →</button></form></aside></div>`;
}

function actionFor(detail) {
    const change = detail.change;
    const current = detail.revisions.at(-1);
    const revision = current?.revision;
    const day = revision?.created_at?.slice(0, 10) || '2026-08-05';
    const nextDay = new Date(`${day}T00:00:00.000Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const verificationDay = nextDay.toISOString().slice(0, 10);
    const base = { changeId: change.id, actorId: state.actorId, expectedRevisionNo: change.current_revision_no };
    const riskInputs = { severity: 2, occurrence: 1, detectability: 2, scope: 1,
        criticalCharacteristic: true, safetyRelevance: false,
        bases: { severity: '정렬 특성 영향', occurrence: '기준 LOT 3개에서 불량률 1% 미만',
            detectability: 'AOI 및 표본 정렬 검사', scope: '모듈·레시피 한정',
            criticalCharacteristic: 'ALIGN-X 핵심 특성', safetyRelevance: '안전 영향 없음' } };
    const id = change.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 55);
    // Seeded Line B L1 contrast: fixed source times from the seed (LOT-B-003 on MOD-ALIGN-B-R2 on 2026-08-05).
    const guided = isLineBContrast(change) ? lineBContrastTimes : null;
    const at = fixed => decisionAt(detail, fixed);
    if (change.state === 'Draft') return { action: 'submitChange', input: { ...base, at: guided?.submit ?? at(`${day}T12:10:00.000Z`) }, label: 'Submit change', role: 'Proposer' };
    if (change.state === 'Submitted') return { action: 'classifyChange', input: { ...base, assessmentId: `RISK-${id}-R${change.current_revision_no}`, riskInputs: guided ? lineBL1RiskInputs : riskInputs, at: guided?.classify ?? at(`${day}T12:20:00.000Z`) }, label: guided ? 'Classify with R06 · L1' : 'Classify with R02', role: 'Quality Engineer',
        ...(guided ? { description: 'Line B 모듈 변경: 심각도·발생도·검출도·범위가 각각 1이며, 핵심 특성과 안전 영향은 없습니다. 적용 규칙과 위험 수준이 기록됩니다.' } : {}) };
    if (change.state === 'Risk Classified') return { action: 'approvePlan', input: { ...base, planId: `PLAN-${id}-R${change.current_revision_no}`, at: guided?.plan ?? at(`${day}T12:30:00.000Z`) }, label: 'Approve verification plan', role: 'Quality Engineer' };
    if (change.state === 'Plan Approved') return { action: 'startVerification', input: { ...base, at: guided?.start ?? at(`${verificationDay}T08:00:00.000Z`) }, label: 'Start verification', role: 'Verification Engineer' };
    if (change.state === 'Verification In Progress') {
        if (!current.evidence.some(item => item.evidence_type === 'baseline-set')) {
            return { action: 'recordBaselineSet', input: { ...base,
                evidenceId: `EVID-${id}-R${change.current_revision_no}-BASE`,
                at: guided?.baseline ?? at(`${verificationDay}T08:01:00.000Z`) },
            label: guided ? 'Link prior-module baseline' : 'Link three-lot baseline', role: 'Verification Engineer',
            ...(guided ? { description: '이전 모듈 MOD-ALIGN-B의 AOI-B-002를 기준 LOT으로 사용하고, 모듈 변경 EV-B-MODULE을 연결합니다.' } : {}) };
        }
        if (guided) {
            const prefix = `EVID-${id}-R${change.current_revision_no}`;
            const sources = [1, 2, 3, 4, 5].map(unit => {
                const suffix = String(unit).padStart(2, '0');
                return { action: 'addMeasurementEvidence', input: { evidenceId: `${prefix}-B003-${suffix}`,
                    measurementId: `MEAS-B-003-${suffix}`, at: guided.measurements } };
            }).concat({ action: 'addAoiEvidence', input: { evidenceId: `${prefix}-AOI-B003`,
                inspectionId: 'AOI-B-003', at: guided.aoi } });
            const recorded = new Set(current.evidence.map(item => item.id));
            const linked = sources.filter(item => recorded.has(item.input.evidenceId)).length;
            if (linked < sources.length) {
                return { action: 'linkSourceSet', input: base, sources,
                    label: 'Link one-lot post-change source set', role: 'Verification Engineer',
                    description: `${linked}/${sources.length}건 연결됨. 새 모듈과 레시피의 첫 LOT인 LOT-B-003의 측정 및 AOI 근거를 연결합니다.` };
            }
            if (!current.results.some(item => item.criterion_code === 'ALIGN-X')) {
                return { action: 'recordAlignmentResult', input: { ...base,
                    resultId: `RESULT-${id}-R${change.current_revision_no}-ALIGN`,
                    evidenceId: `${prefix}-B003-05`, at: guided.alignment },
                label: 'Evaluate 5 alignment samples', role: 'Verification Engineer' };
            }
            if (!current.results.some(item => item.criterion_code === 'AOI-RATE')) {
                return { action: 'recordAoiResults', input: { ...base,
                    resultPrefix: `RESULT-${id}-R${change.current_revision_no}-AOI`,
                    at: guided.aoiResults },
                label: 'Evaluate AOI and critical defects', role: 'Verification Engineer' };
            }
            return { action: 'markEvidenceReady', input: { ...base, at: guided.ready },
                label: 'Freeze evidence package', role: 'Verification Engineer' };
        }
        const sourceGap = postRevisionSourceGap(detail, current);
        if (sourceGap) return sourceGap;
        if (change.recipe_revision_id === 'REC-ALIGN-R2') {
            const failedEvidenceId = `EVID-${id}-R${change.current_revision_no}-FAIL`;
            if (!current.evidence.some(item => item.id === failedEvidenceId)) {
                return { action: 'addMeasurementEvidence', input: { ...base,
                    evidenceId: failedEvidenceId, measurementId: 'MEAS-A-006-07',
                    at: `${verificationDay}T10:01:00.000Z` },
                label: 'Link 0.10 mm observation', role: 'Verification Engineer' };
            }
            if (!current.results.some(item => item.criterion_code === 'ALIGN-X')) {
                return { action: 'recordAlignmentResult', input: { ...base,
                    resultId: `RESULT-${id}-R${change.current_revision_no}-ALIGN`,
                    evidenceId: failedEvidenceId, at: `${verificationDay}T10:02:00.000Z` },
                label: 'Evaluate failing criterion', role: 'Verification Engineer' };
            }
        }
        if (change.recipe_revision_id === 'REC-ALIGN-R3') {
            const measurements = current.evidence.filter(item => item.source_table === 'measurements');
            const inspections = current.evidence.filter(item => item.evidence_type === 'aoi');
            if (measurements.length < 100 || inspections.length < 5) {
                return { action: 'linkPassingSourceSet', input: base,
                    label: 'Link five-lot source set', role: 'Verification Engineer',
                    description: `측정 ${measurements.length}/100건 · AOI 검사 ${inspections.length}/5건 연결됨.` };
            }
            if (!current.results.some(item => item.criterion_code === 'ALIGN-X')) {
                return { action: 'recordAlignmentResult', input: { ...base,
                    resultId: `RESULT-${id}-R${change.current_revision_no}-ALIGN`,
                    evidenceId: `EVID-${id}-R${change.current_revision_no}-012-20`,
                    at: '2026-08-12T12:01:00.000Z' },
                label: 'Evaluate 100 alignment samples', role: 'Verification Engineer' };
            }
            if (!current.results.some(item => item.criterion_code === 'AOI-RATE')) {
                return { action: 'recordAoiResults', input: { ...base,
                    resultPrefix: `RESULT-${id}-R${change.current_revision_no}-AOI`,
                    at: '2026-08-12T12:02:00.000Z' },
                label: 'Evaluate AOI and critical defects', role: 'Verification Engineer' };
            }
            return { action: 'markEvidenceReady', input: { ...base,
                at: '2026-08-12T12:03:00.000Z' },
            label: 'Freeze evidence package', role: 'Verification Engineer' };
        }
        // No guided seeded source set exists for this scope; explain instead of dead-ending silently.
        if (!(change.recipe_revision_id === 'REC-ALIGN-R2' && current.results.some(item => item.criterion_code === 'ALIGN-X'))) {
            return postRevisionSourceGap(detail, current, true);
        }
    }
    if (change.state === 'Needs Rework') {
        const failed = current.results.find(item => item.passed === 0);
        if (failed && change.recipe_revision_id === 'REC-ALIGN-R2') {
            return { action: 'reviseFailedChange', input: { ...base,
                failedResultId: failed.id, newRecipeRevisionId: 'REC-ALIGN-R3',
                reason: 'R2 정렬 편차를 수정하고 검증을 다시 수행',
                at: '2026-08-07T12:00:00.000Z' },
            label: 'Create rework revision with R3 recipe', role: 'Proposer' };
        }
    }
    if (change.state === 'Evidence Ready') return { action: 'beginIndependentReview',
        input: { ...base, at: guided?.reviewStart ?? at('2026-08-12T12:04:00.000Z') },
        label: 'Begin independent review', role: 'Reviewer' };
    if (change.state === 'Independent Review' && current.reviews.length === 0) {
        return { action: 'recordIndependentReview', input: { ...base,
            reviewId: `REVIEW-${id}-R${change.current_revision_no}`,
            decision: 'Pass', at: guided?.review ?? at('2026-08-12T12:05:00.000Z') },
        label: 'Record independent Pass', role: 'Reviewer', needsReason: true };
    }
    if (change.state === 'Independent Review' && current.reviews.some(item => item.decision === 'Pass')) {
        return { action: 'acceptChange', input: { ...base,
            acceptanceId: `ACCEPT-${id}-R${change.current_revision_no}`,
            reviewId: current.reviews.find(item => item.decision === 'Pass').id,
            at: guided?.accept ?? at('2026-08-12T12:06:00.000Z') },
        label: 'Accept verified change', role: 'Approver', needsReason: true };
    }
    const unknown = current.acceptances.find(item => item.status?.classificationRequired);
    if (unknown) return { action: 'classifyLegacyAcceptance',
        input: { acceptanceId: unknown.id, id: `CLASS-${unknown.id}`,
            actorId: state.actorId, at: detail.serverNowUtc },
        label: 'Classify legacy Acceptance', role: 'Approver', needsReason: true };
    const failedReopen = change.state === 'Reopened' ? detail.audit.filter(item =>
        item.action === 'change-monitoring-reopened' &&
        item.entity_revision_id === current.revision.id).at(-1) : null;
    if (failedReopen && failedReopen.recorded_at === change.updated_at) {
        const payload = failedReopen.payload ?? {};
        return { action: 'reviseFailedEffectivenessChange', input: { ...base,
            at: detail.serverNowUtc }, label: 'Start new revision after failed effectiveness',
        role: 'Proposer', needsReason: true,
        description: '효과성 불합격 후 새 개정은 다시 검증하고 독립 검토와 승인 결정을 받아야 합니다. 이전 수락과 확인·결정 이력은 보존됩니다.' };
    }
    if (change.state === 'Reopened' && current.acceptances.some(item => item.expiryEvent)) {
        return { action: 'reviseExpiredChange', input: { ...base,
            at: detail.serverNowUtc }, label: 'Start new revision after expiry',
        role: 'Proposer', needsReason: true,
        description: '새 개정에는 새 근거, 독립 검토와 승인 결정이 필요합니다. 원래 수락은 이력에 남습니다.' };
    }
    return null;
}

function actorEligible(next, detail) {
    const actor = state.bootstrap.actors.find(item => item.id === state.actorId);
    if (!actor || !next || next.blocked) return false;
    if (['submitChange', 'reviseFailedChange', 'reviseExpiredChange',
        'reviseFailedEffectivenessChange'].includes(next.action)) {
        return actor.id === detail.change.proposer_actor_id;
    }
    if (next.action === 'classifyChange') return actor.role === 'Quality Engineer';
    if (next.action === 'approvePlan') {
        const level = detail.revisions.at(-1)?.risk?.computed_level;
        return actor.role === 'Quality Engineer' &&
            (level !== 'L3' || actor.id !== detail.change.proposer_actor_id);
    }
    if (['startVerification', 'recordBaselineSet', 'addMeasurementEvidence',
        'linkPassingSourceSet', 'linkSourceSet', 'recordAlignmentResult', 'recordAoiResults',
        'markEvidenceReady'].includes(next.action)) return actor.role === 'Verification Engineer';
    if (['beginIndependentReview', 'recordIndependentReview'].includes(next.action)) {
        const current = detail.revisions.at(-1);
        return actor.role === 'Reviewer' && actor.id !== detail.change.proposer_actor_id &&
            !current.evidence.some(item => item.recorded_by === actor.id);
    }
    if (next.action === 'classifyLegacyAcceptance') return actor.role === 'Approver';
    if (next.action === 'acceptChange') {
        const current = detail.revisions.at(-1);
        return actor.role === 'Approver' && actor.id !== detail.change.proposer_actor_id &&
            !current.evidence.some(item => item.recorded_by === actor.id) &&
            !current.reviews.some(item => item.reviewer_actor_id === actor.id);
    }
    return false;
}

function renderCriteria(revision) {
    if (!revision.criteria.length) return empty('검증 기준 미설정', '검증 계획이 승인되면 기준을 확인할 수 있습니다.');
    return `<div class="table-wrap"><table><thead><tr><th>기준</th><th>허용 한계</th><th>관측값</th><th>판정</th></tr></thead><tbody>${revision.criteria.map(criterion => {
        const result = revision.results.find(item => item.plan_id === criterion.plan_id && item.criterion_code === criterion.code);
        return `<tr><td class="strong">${text(criterion.code)}</td><td class="mono">${text(criterion.comparison)} ${text(criterion.threshold ?? '—')} ${text(criterion.unit ?? '')}</td><td class="mono">${result ? text(result.observed_value ?? '—') + ' ' + text(result.unit ?? '') : '—'}</td><td>${result ? `<span class="${result.passed ? 'result-pass' : 'result-fail'}">${result.passed ? 'PASS' : 'FAIL'}</span>` : '<span class="muted">Pending</span>'}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

function renderEvidence(revision) {
    if (!revision.evidence.length) return empty('연결된 근거 없음', '검증 담당자가 측정·AOI 원천 기록을 연결하면 여기에 표시됩니다.');
    return `<details><summary class="button">연결된 근거 ${number(revision.evidence.length)}건 보기</summary>
        <div class="table-wrap evidence-gap"><table><thead><tr><th>근거 ID</th><th>유형 / 원천</th><th>관측값</th><th>기록 시각 (UTC)</th><th>검증값</th></tr></thead><tbody>${revision.evidence.map(item => {
            const source = item.source;
            const baseline = item.evidence_type === 'baseline-set' && Array.isArray(item.payload?.lotIds) ? item.payload : null;
            const observation = baseline
                ? `${baseline.lotIds.join(', ')} · ${baseline.sampledUnits} samples · ${baseline.rejectedUnits}/${baseline.inspectedUnits} AOI rejects · max ${baseline.maxAbsOffset} mm` :
                source?.value != null ? `${source.value} ${source.unit ?? ''} · ${source.lot_id ?? ''}` :
                    source?.rejected_units != null ? `${source.rejected_units}/${source.inspected_units} rejects · ${source.lot_id ?? ''}` : source?.id ?? 'Embedded note';
            return `<tr><td class="mono">${text(item.id)}</td><td>${text(item.evidence_type)}<br><span class="muted mono">${text(item.source_table)} / ${text(item.source_id)}</span></td><td>${text(observation)}</td><td class="muted">${dateText(item.recorded_at)}</td><td class="mono" title="${text(item.sha256)}">${text(shortHash(item.sha256))}</td></tr>`;
        }).join('')}</tbody></table></div></details>`;
}

function renderRevision(revision, isCurrent, detail) {
    const risk = revision.risk;
    const plan = revision.plans.at(-1);
    const acceptanceSummary = revision.acceptances.map(item => {
        const status = item.status;
        if (status?.classificationRequired) return '분류 확인 필요 · 운영 승인에 사용할 수 없음';
        if (status?.type === 'Conditional') return `조건부 수락 · ${status.expired ? '만료됨' : '유효'} · ${status.condition} · 만료 ${status.expiresAt} (UTC)`;
        return `일반 수락 · ${item.accepted_at} (UTC)`;
    }).join(' / ') || '기록 없음';
    return `<section class="revision-card${isCurrent ? ' current' : ''}"><div class="revision-head"><strong>개정 R${number(revision.revision.revision_no)} ${isCurrent ? '· 현재' : '· 이전 이력'}</strong>${risk ? `<span class="risk-chip${plan?.final_level === 'L1' ? ' low' : ''}">${text(plan?.final_level ?? risk.computed_level)} · ${text(risk.matched_rule)}</span>` : '<span class="small-chip">위험 분류 대기</span>'}</div>
        <div class="revision-body"><div class="field-grid">${row('개정 이유', revision.revision.reason)}${row('등록 시각 (UTC)', dateText(revision.revision.created_at))}${row('적용 위험 규칙', risk ? `${risk.matched_rule} / ${risk.rule_version} / score ${risk.score}` : '대기 중')}</div><details><summary>기술 정보</summary><div class="field-grid">${row('승인 계획 ID', plan?.id ?? '없음')}${row('개정 ID', revision.revision.id)}</div></details>
        ${revision.overrides.length ? `<div class="warning-box top-gap"><strong>위험 등급 조정:</strong> ${revision.overrides.map(item => `${text(item.from_level)} → ${text(item.to_level)} · ${text(item.rationale)} · 요청 ${text(item.requester_actor_id)}${item.approver_actor_id ? ` · 승인 ${text(item.approver_actor_id)}` : ''}`).join('<br>')}</div>` : ''}
        <h4>검증 기준</h4>${renderCriteria(revision)}<h4>연결된 근거</h4>${renderEvidence(revision)}
        <h4>독립 결정</h4>${revision.reviews.length || revision.acceptances.length ? `<div class="field-grid">${row('검토', revision.reviews.map(item => `${item.decision} · ${item.reason}`).join(' / ') || '대기 중')}${row('수락', acceptanceSummary)}</div><details><summary>승인 상세</summary>${revision.acceptances.map(item => row('수락 ID / 승인자', `${item.id} / ${item.approver_actor_id}`)).join('')}</details>${revision.acceptances.some(item => item.status?.classificationRequired) ? '<div class="warning-box top-gap">분류 확인 필요 · 과거 수락 유형이 기록되지 않아 현재 운영 승인에 사용할 수 없습니다. 원본과 감사 이력은 조회할 수 있습니다.</div>' : ''}` : '<p>아직 검토 또는 승인 기록이 없습니다.</p>'}
        ${renderChangeMonitoringLedger(revision, detail)}</div></section>`;
}

function renderAudit(events) {
    if (!events?.length) return empty('감사 기록 없음', '결정이 저장되면 감사 이력이 표시됩니다.');
    return `<ol class="audit-list">${events.map(item => `<li><strong>${text(auditActionLabels[item.action] ?? '결정 기록')} ${item.new_state ? `· ${text(labelFor(labels.states, item.new_state) ?? item.new_state)}` : ''}</strong><span class="muted">${dateText(item.recorded_at)} · ${text(roleLabel(item.simulated_role))}</span><details><summary>감사 상세</summary><span class="muted mono">${text(item.id)} · ${text(item.action)} · ${text(item.actor_id ?? item.system_principal_id)} · ${text(item.entity_revision_id ?? '—')}</span><span class="muted mono" title="${text(item.digest)}">CHAIN ${text(item.digest)} · PRIOR ${text(item.previous_digest)}</span></details></li>`).join('')}</ol>`;
}

// Shared "다음 허용 단계" card. A blocked gate keeps its button focusable and links it to the visible reason.
function renderNextStepCard(prefix, next, blockReason) {
    const actor = state.bootstrap.actors.find(item => item.id === state.actorId);
    const titleId = `${prefix}-next-step-title`;
    const reasonId = `${prefix}-gate-block-reason`;
    const card = `<div class="next-step-card${blockReason ? ' blocked' : ''}" role="group" aria-labelledby="${titleId}"><p class="next-step-kicker" id="${titleId}">다음 작업</p><strong class="next-step-action">${text(actionLabel(next))}</strong><dl class="next-step-facts"><div><dt>필요 역할</dt><dd>${text(roleDisplay(next.role))}</dd></div><div><dt>현재 역할</dt><dd>${text(actor ? roleLabel(actor.role) : '—')}</dd></div></dl>${blockReason ? `<p class="next-step-reason" id="${reasonId}"><strong>차단 사유:</strong> ${text(blockReason)}</p>` : '<p class="next-step-ready">진행 가능</p>'}</div>`;
    const gateState = blockReason ? `aria-disabled="true" aria-describedby="${reasonId}"` : '';
    return { card, gateState };
}

// Explains why actorEligible refused the persona. Display only; the server still enforces every gate.
function changeBlockReason(next, detail) {
    if (!next || actorEligible(next, detail)) return null;
    if (next.blocked) return next.blocked;
    const actor = state.bootstrap.actors.find(item => item.id === state.actorId);
    if (!actor) return '현재 역할을 선택하세요.';
    const change = detail.change;
    const proposer = change.proposer_actor_id;
    const current = detail.revisions.at(-1);
    const wrongRole = role => `이 작업은 ${roleLabel(role)} 역할에서 수행할 수 있습니다.`;
    if (['submitChange', 'reviseFailedChange', 'reviseExpiredChange',
        'reviseFailedEffectivenessChange'].includes(next.action)) {
        return '이 변경을 등록한 요청자만 다음 단계로 진행할 수 있습니다.';
    }
    if (next.action === 'classifyChange') return wrongRole('Quality Engineer');
    if (next.action === 'approvePlan') {
        if (actor.role !== 'Quality Engineer') return wrongRole('Quality Engineer');
        return 'L3 검증 계획은 요청자와 다른 품질 엔지니어가 승인해야 합니다.';
    }
    if (['beginIndependentReview', 'recordIndependentReview'].includes(next.action)) {
        if (actor.role !== 'Reviewer') return wrongRole('Reviewer');
        if (actor.id === proposer) return '요청자는 자신의 변경을 독립 검토할 수 없습니다.';
        return '근거를 기록한 사람은 같은 개정을 독립 검토할 수 없습니다.';
    }
    if (next.action === 'classifyLegacyAcceptance') return wrongRole('Approver');
    if (next.action === 'acceptChange') {
        if (actor.role !== 'Approver') return wrongRole('Approver');
        if (actor.id === proposer) return '요청자는 자신의 변경을 수락할 수 없습니다.';
        if (current.evidence.some(item => item.recorded_by === actor.id)) {
            return '근거를 기록한 사람은 같은 개정을 수락할 수 없습니다.';
        }
        return '독립 검토자는 같은 변경을 수락할 수 없습니다.';
    }
    return wrongRole(next.role);
}

function renderGateControls(next, eligible, detail) {
    if (!next && changeMonitoringStates.includes(detail.change.state)) {
        return '<div class="hint-box">효과성 확인·종결·재개 작업은 아래의 효과성 모니터링에서 진행합니다.</div>';
    }
    if (!next) return '<div class="hint-box">현재 단계에서 가능한 작업이 없습니다. 이전 기록은 계속 조회할 수 있습니다.</div>';
    const blockReason = eligible ? null : changeBlockReason(next, detail);
    const { card, gateState } = renderNextStepCard('change', next, blockReason);
    return `${card}
        ${next.description ? `<details class="top-gap"><summary>작업 근거</summary><div class="hint-box">${text(next.description)}</div></details>` : ''}
        ${next.needsReason ? '<label class="gate-reason">판단 이유<textarea id="gate-reason" required maxlength="500" placeholder="근거와 판단 이유를 입력하세요"></textarea></label>' : ''}
        ${['acceptChange', 'classifyLegacyAcceptance'].includes(next.action) ? `<div class="field-grid top-gap"><label>수락 유형<select id="acceptance-type" required><option value="" selected>선택하세요</option><option value="Ordinary">일반 수락</option><option value="Conditional">조건부 수락</option></select></label><label>조건 (조건부 수락)<textarea id="acceptance-condition" maxlength="500" placeholder="적용 조건을 구체적으로 입력하세요"></textarea></label><label>만료 시각 (UTC, 조건부 수락)<input id="acceptance-expiry" type="text" placeholder="YYYY-MM-DDTHH:MM:SS.000Z" autocomplete="off"></label></div><p class="muted">시간대: UTC · 조건부 수락에는 명시적 만료 시각이 필요합니다.</p>` : ''}
        <button type="button" class="button primary top-gap" data-action="next-gate" ${gateState}>${text(actionLabel(next))} →</button>`;
}

// Monitoring views use persisted checks and audit payloads.
const changeMonitoringStates = Object.freeze(['Accepted', 'Effectiveness Monitoring', 'Closed']);
const changeDecisionActions = Object.freeze(['change-monitoring-closed', 'change-monitoring-reopened',
    'change-revised-after-effectiveness-failure']);
const changeClosureRoles = Object.freeze(['Quality Engineer', 'Approver']);
const noActorReason = '현재 역할을 선택하세요.';
const stableIdPart = value => String(value ?? '').toUpperCase().replace(/[^A-Z0-9-]/g, '-');
const idChips = values => Array.isArray(values) && values.length
    ? `<ul class="lot-list">${values.map(value => `<li class="small-chip mono">${text(value)}</li>`).join('')}</ul>`
    : '<p class="muted">기록 없음</p>';

function changeCheckEvents(detail) {
    return new Map((detail.audit ?? []).filter(item => item.action === 'change-effectiveness-evaluated' &&
        item.payload?.checkId).map(item => [item.payload.checkId, item]));
}

function changeCheckChip(status) {
    if (status === 'Pass') return '<span class="status-chip good">합격</span>';
    if (status === 'Reopen Required') return '<span class="status-chip bad">재개 필요</span>';
    if (status === 'Monitoring') return '<span class="status-chip uncertain">데이터 부족</span>';
    return '<span class="status-chip warn">판정 기록 확인 필요</span>';
}

function renderChangeCheck(check, event) {
    const payload = event?.payload ?? null;
    const reasons = Array.isArray(payload?.reasons) && payload.reasons.length ? payload.reasons : [check.reason].filter(Boolean);
    const runs = Array.isArray(payload?.sourceRunIds) ? payload.sourceRunIds : [];
    const aois = Array.isArray(payload?.aoiInspectionIds) ? payload.aoiInspectionIds : [];
    const path = payload ? `<ol class="monitoring-path" aria-label="평가 경로">
        <li>평가 구간 ${dateText(check.window_start)} → ${dateText(check.window_end)}</li>
        <li>후속 LOT ${number(check.lot_count)} / 필요 ${number(payload.requiredLots)}</li>
        <li>공정 실행 ${number(runs.length)}건 · AOI 검사 ${number(aois.length)}건</li></ol>`
        : '<p class="muted">연결된 평가 감사 기록을 확인할 수 없습니다.</p>';
    return `<li class="ledger-entry" data-change-check-id="${text(check.id)}"><div class="ledger-entry-head"><span class="ledger-kind">효과성 평가</span>${changeCheckChip(payload?.status)}</div>
        ${ledgerBlock('평가 경로', path)}
        <div class="field-grid">${ledgerFact('평가자 · 시각', `${check.recorded_by} · ${dateText(check.recorded_at)}`)}${ledgerFact('후속 LOT', `${number(check.lot_count)}건${payload?.requiredLots != null ? ` · 필요 ${number(payload.requiredLots)}건` : ''}${payload?.observedCalendarDays != null ? ` · ${number(payload.observedCalendarDays)}일` : ''}`)}${ledgerFact('AOI 검사 / 불합격', `${number(payload?.inspectedUnits)} / ${number(payload?.rejectedUnits)}`)}${ledgerFact('대상 / 중대 결함', `${number(payload?.targetedDefects)} / ${number(payload?.criticalDefects)}`)}</div>
        ${ledgerBlock('판정 근거', reasons.length ? `<ul class="gap-list">${reasons.map(reason => `<li>${text(reason)}</li>`).join('')}</ul>` : '<p>미충족 요건 없음</p>')}
        <details><summary>상세 근거</summary><div class="field-grid">${ledgerFact('확인 ID', check.id, true)}${ledgerFact('수락 · 계획 · 사이클', payload ? `${payload.acceptanceId ?? '—'} · ${payload.planId ?? '—'} · ${payload.cycleNo ?? '—'}` : '—', true)}</div>${ledgerBlock(`LOT ID (${number(payload?.sourceLotIds?.length ?? 0)})`, idChips(payload?.sourceLotIds))}${ledgerBlock(`공정 실행 ID (${number(runs.length)})`, idChips(runs))}${ledgerBlock(`AOI 검사 ID (${number(aois.length)})`, idChips(aois))}${payload && (payload.unresolvedAlarmIds?.length || payload.blockingDeviationIds?.length) ? ledgerBlock('미해결 경보 / 차단 편차', idChips([...(payload.unresolvedAlarmIds ?? []), ...(payload.blockingDeviationIds ?? [])])) : ''}${ledgerBlock('원천 검증값', `<span class="digest">${text(payload?.sourceDigest ?? '—')}</span>`)}${event ? ledgerBlock('감사 기록', `<p class="mono">${text(event.id)} · CHAIN ${text(shortHash(event.digest))} · PRIOR ${text(shortHash(event.previous_digest))}</p>`) : ''}</details></li>`;
}

function renderChangeDecision(event) {
    const payload = event.payload ?? {};
    const who = ledgerFact('결정자 · 시각', `${event.actor_id ?? event.system_principal_id ?? '—'} · ${dateText(event.recorded_at)}`);
    const reason = ledgerBlock('판단 이유', `<p>${text(event.reason ?? '—')}</p>`);
    const head = (ko, en, id, status) => `<div class="ledger-entry-head"><span class="ledger-kind">${ko}</span>${status}<details><summary>결정 ID</summary><span class="mono">${text(id)}</span></details></div>`;
    if (event.action === 'change-monitoring-closed') {
        return `<li class="ledger-entry" data-change-decision-id="${text(payload.decisionId ?? event.id)}">${head('종결 결정', 'Closure decision', payload.decisionId ?? event.id, chip('Closed'))}
            <div class="field-grid">${who}${ledgerFact('합격 확인', payload.checkId, true)}${ledgerFact('수락', payload.acceptanceId, true)}${ledgerFact('모니터링 사이클', payload.cycleNo)}</div>
            ${reason}<details><summary>상세 근거</summary>${ledgerBlock('원천 검증값', `<span class="digest">${text(payload.sourceDigest ?? '—')}</span>`)}</details></li>`;
    }
    if (event.action === 'change-monitoring-reopened') {
        return `<li class="ledger-entry" data-change-decision-id="${text(payload.decisionId ?? event.id)}">${head('재개 결정', 'Reopen decision', payload.decisionId ?? event.id, chip('Reopened'))}
            <div class="field-grid">${who}${ledgerFact('불합격 확인', payload.failedCheckId, true)}${ledgerFact('이전 종결', payload.priorClosureId ?? '종결 전 재개', Boolean(payload.priorClosureId))}${ledgerFact('사이클', `${payload.priorCycleNo ?? '—'} → ${payload.nextCycleNo ?? '—'}`)}${ledgerFact('재발 근거 (AOI 결함)', payload.recurrenceAoiDefectId ?? '기록 없음', Boolean(payload.recurrenceAoiDefectId))}${ledgerFact('보존된 수락', payload.acceptanceId, true)}</div>
            ${reason}<details><summary>상세 근거</summary>${ledgerBlock('원천 검증값', `<span class="digest">${text(payload.sourceDigest ?? '—')}</span>`)}</details></li>`;
    }
    return `<li class="ledger-entry" data-change-decision-id="${text(event.id)}">${head('실패 후 새 개정', 'Revision after failed effectiveness', event.entity_revision_id ?? event.id, chip('Draft'))}
        <div class="field-grid">${who}${ledgerFact('이전 개정', payload.priorRevisionId, true)}${ledgerFact('재개 결정', payload.reopenDecisionId, true)}${ledgerFact('불합격 확인', payload.failedCheckId, true)}${ledgerFact('보존된 이전 수락', payload.priorAcceptanceId, true)}${ledgerFact('이전 종결', payload.priorClosureId ?? '없음', Boolean(payload.priorClosureId))}</div>${reason}</li>`;
}

// Append-only monitoring ledger for one revision: checks plus closure, reopen and new-revision decisions.
function renderChangeMonitoringLedger(revision, detail) {
    if (!detail) return '';
    const revisionId = revision.revision.id;
    const checks = revision.effectivenessChecks ?? [];
    const events = changeCheckEvents(detail);
    const decisions = (detail.audit ?? []).filter(item => item.entity_revision_id === revisionId &&
        changeDecisionActions.includes(item.action));
    if (!checks.length && !decisions.length) return '';
    const entries = [
        ...checks.map(item => ({ at: item.recorded_at, id: item.id, html: renderChangeCheck(item, events.get(item.id)) })),
        ...decisions.map(item => ({ at: item.recorded_at, id: item.id, html: renderChangeDecision(item) }))
    ].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1);
    return `<h4><span lang="ko">효과성 모니터링 이력</span> · Effectiveness monitoring history</h4>
        <p>Append-only. Earlier Acceptance, checks, closure and reopen decisions stay visible after a reopen or new revision. All times UTC.</p>
        <ol class="ledger-entries">${entries.map(item => item.html).join('')}</ol>`;
}

// Operating Acceptance gate shared by evaluate, close and reopen. UNKNOWN legacy types are never guessed.
function changeAcceptanceGate(current) {
    const acceptance = current?.acceptances?.at(-1) ?? null;
    const status = acceptance?.status ?? null;
    if (!acceptance) return { summary: '현재 개정 Acceptance 없음 · No current-revision Acceptance',
        block: '운영 Acceptance 없음 · The current revision has no Acceptance, so no monitoring decision can rely on an operating approval.' };
    if (status?.classificationRequired || status?.type === 'UNKNOWN') return {
        summary: `${acceptance.id} · 분류 확인 필요 · UNKNOWN (type not recorded, not guessed)`,
        block: `분류 확인 필요 · ${acceptance.id} is a legacy Acceptance whose type was never recorded. It cannot be used for this operating gate until an Approver records a separate classification; the original record and audit history remain inspectable.` };
    if (status?.expired) return {
        summary: `${acceptance.id} · 조건부 수락 · 만료됨 · ${dateText(status.expiresAt)}`,
        block: `조건부 수락이 ${dateText(status.expiresAt)}에 만료되었습니다. 새 개정에서 근거, 독립 검토와 승인 결정을 다시 기록해야 합니다.` };
    if (status?.type === 'Conditional') return {
        summary: `${acceptance.id} · 조건부 수락 · 유효 · ${status.condition ?? '—'} · 만료 ${dateText(status.expiresAt)}`, block: null };
    return { summary: `${acceptance.id} · 일반 수락 · Ordinary · ${acceptance.approver_actor_id} · ${dateText(acceptance.accepted_at)}`, block: null };
}

function changeMonitoringContext(detail) {
    const change = detail.change;
    const current = detail.revisions.find(item => item.revision.revision_no === change.current_revision_no) ?? null;
    const checks = current?.effectivenessChecks ?? [];
    const events = changeCheckEvents(detail);
    // The API orders checks by recorded_at,id; the server treats the last one as latest.
    const latest = checks.at(-1) ?? null;
    const latestEvent = latest ? events.get(latest.id) ?? null : null;
    const closure = detail.audit.filter(item => item.action === 'change-monitoring-closed' &&
        item.entity_revision_id === current?.revision.id && item.payload?.cycleNo === change.cycle_no).at(-1) ?? null;
    return { change, current, checks, events, latest, latestEvent,
        latestStatus: latestEvent?.payload?.status ?? null, closure, gate: changeAcceptanceGate(current) };
}

function nextChangeRecordId(detail, prefix, used) {
    const base = `${prefix}-${stableIdPart(detail.change.id)}-R${detail.change.current_revision_no}`.slice(0, 74);
    let sequence = 1;
    while (used.has(`${base}-${sequence}`)) sequence++;
    return `${base}-${sequence}`;
}

const usedChangeCheckIds = detail => new Set(detail.revisions.flatMap(item => (item.effectivenessChecks ?? []).map(check => check.id)));
const usedChangeDecisionIds = detail => new Set(detail.audit.map(item => item.payload?.decisionId).filter(Boolean));

function changeActor() {
    return state.bootstrap.actors.find(item => item.id === state.actorId) ?? null;
}

// Display-only explanations. The server re-checks every gate and stays authoritative.
function changeEvaluateBlock(ctx) {
    const actor = changeActor();
    if (!actor) return noActorReason;
    if (!effectivenessRoles.includes(actor.role)) {
        return `역할 불일치 · ${actor.role} (${actor.id}) cannot evaluate Change effectiveness. Only a Quality Engineer or Verification Engineer may do this.`;
    }
    return ctx.gate.block;
}

function changeCloseBlock(ctx) {
    const actor = changeActor();
    if (!actor) return noActorReason;
    if (!changeClosureRoles.includes(actor.role)) {
        return `역할 불일치 · ${actor.role} (${actor.id}) cannot close Change monitoring. Only a separate Quality Engineer or Approver may do this.`;
    }
    if (actor.id === ctx.change.proposer_actor_id) {
        return `제안자 ≠ 종결 승인자 · ${actor.id} proposed this Change and cannot approve its closure.`;
    }
    if (ctx.gate.block) return ctx.gate.block;
    if (!ctx.latest) return '효과성 확인 없음 · The current revision has no effectiveness check. Record a source-derived evaluation first.';
    if (ctx.latestStatus === 'Monitoring') {
        return `최신 확인 미합격 · Latest check ${ctx.latest.id} is Monitoring (insufficient later data). Closure needs the latest check to Pass; record a later evaluation.`;
    }
    if (ctx.latestStatus === 'Reopen Required') {
        return `최신 확인 실패 · Latest check ${ctx.latest.id} requires Reopen and cannot support closure.`;
    }
    if (ctx.latestStatus !== 'Pass') return `감사 상태 없음 · Latest check ${ctx.latest.id} has no matching passing audit status.`;
    if (actor.id === ctx.latest.recorded_by) {
        return `평가자 ≠ 종결 승인자 · ${actor.id} evaluated ${ctx.latest.id} and cannot also approve closure.`;
    }
    return null;
}

function changeReopenBlock(ctx) {
    const actor = changeActor();
    if (!actor) return noActorReason;
    if (actor.role !== 'Quality Engineer') {
        return `역할 불일치 · ${actor.role} (${actor.id}) cannot reopen Change monitoring. Only a Quality Engineer may do this.`;
    }
    if (ctx.gate.block) return ctx.gate.block;
    if (!ctx.latest) return '효과성 확인 없음 · The current revision has no effectiveness check to reopen from.';
    if (ctx.latestStatus === 'Monitoring') {
        return `데이터 부족 · Latest check ${ctx.latest.id} is Monitoring (insufficient later data). An insufficient-data check cannot reopen; only a source-derived Reopen Required result can.`;
    }
    if (ctx.latestStatus === 'Pass') return `최신 확인 합격 · Latest check ${ctx.latest.id} passed, so there is no failed source-derived result to reopen from.`;
    if (ctx.latestStatus !== 'Reopen Required') return `감사 상태 없음 · Latest check ${ctx.latest.id} has no matching Reopen Required audit status.`;
    if (ctx.change.state === 'Closed' && (!ctx.closure || ctx.latest.recorded_at <= ctx.closure.recorded_at)) {
        return `종결 이후 실패 확인 필요 · After closure ${ctx.closure?.payload?.decisionId ?? '—'}, reopen needs a failed check recorded later than the closure. Evaluate the later source first.`;
    }
    return null;
}

const utcHint = (detail, extra = '') => `<p class="muted">시간대: UTC · 마지막 변경 시각 이후, 현재 서버 시각 이내여야 합니다.${text(extra)}</p>`;

function changeCheckOption(ctx, check, eligible) {
    const status = ctx.events.get(check.id)?.payload?.status ?? 'no audit status';
    return `<option value="${text(check.id)}" ${eligible ? '' : 'disabled'}>${text(check.id)} · ${text(status)} · LOT ${text(number(check.lot_count))}건 · ${dateText(check.recorded_at)} · ${check === ctx.latest ? '최신' : '이전'}</option>`;
}

function renderChangeEvaluate(detail, ctx) {
    const { card, gateState } = renderNextStepCard('change-evaluate', {
        label: '효과성 평가', role: '품질 엔지니어 또는 검증 엔지니어'
    }, changeEvaluateBlock(ctx));
    const postClose = ctx.change.state === 'Closed'
        ? ' 종결 후 확인 결과도 이력에 추가되며 기존 종결 결정은 바뀌지 않습니다.' : '';
    return `<div class="effectiveness-action" aria-labelledby="change-evaluate-title"><h4 id="change-evaluate-title">효과성 평가</h4>${card}
        <form id="change-evaluate-form" class="form-grid capa-form" data-change-monitoring-form="evaluate"><p>평가 시각까지의 후속 LOT을 확인합니다.${text(postClose)}</p>
        <details><summary>기록 ID</summary><label>확인 ID<input name="id" required maxlength="80" pattern="[A-Z](?:[A-Z0-9]|-){2,79}" autocomplete="off" spellcheck="false" class="mono" value="${text(nextChangeRecordId(detail, 'EFF', usedChangeCheckIds(detail)))}"></label></details>
        <label>평가 시각 / 구간 끝 (UTC)<input name="at" required maxlength="24" autocomplete="off" spellcheck="false" class="mono" placeholder="2026-08-20T12:00:00.000Z" value="${text(laterUtc(ctx.change.updated_at))}"></label>
        ${utcHint(detail)}
        <button type="button" class="button primary" data-change-monitoring-submit="evaluate" ${gateState}>효과성 평가 →</button></form></div>`;
}

function renderChangeClose(detail, ctx) {
    const { card, gateState } = renderNextStepCard('change-close', {
        label: '모니터링 종결', role: '평가자·요청자와 다른 품질 엔지니어 또는 승인자'
    }, changeCloseBlock(ctx));
    const options = ctx.checks.map(check => changeCheckOption(ctx, check,
        check === ctx.latest && ctx.latestStatus === 'Pass')).join('');
    return `<div class="effectiveness-action" aria-labelledby="change-close-title"><h4 id="change-close-title">모니터링 종결</h4>${card}
        <form id="change-close-form" class="form-grid capa-form" data-change-monitoring-form="close"><p>최신 합격 확인을 선택해 종결 이유를 기록하세요.</p>
        <details><summary>기록 ID</summary><label>종결 결정 ID<input name="id" required maxlength="80" pattern="[A-Z](?:[A-Z0-9]|-){2,79}" autocomplete="off" spellcheck="false" class="mono" value="${text(nextChangeRecordId(detail, 'CLOSE', usedChangeDecisionIds(detail)))}"></label></details>
        <label>종결 시각 (UTC)<input name="at" required maxlength="24" autocomplete="off" spellcheck="false" class="mono" value="${text(laterUtc(ctx.change.updated_at))}"></label>
        <label class="span-all">합격 확인<select name="checkId" required><option value="" selected>선택하세요</option>${options}</select></label>
        <label class="span-all">종결 이유<textarea name="reason" required maxlength="500" placeholder="후속 근거와 종결 판단 이유를 입력하세요"></textarea></label>
        ${utcHint(detail)}
        <button type="button" class="button primary" data-change-monitoring-submit="close" ${gateState}>모니터링 종결 →</button></form></div>`;
}

function renderChangeReopen(detail, ctx) {
    const { card, gateState } = renderNextStepCard('change-reopen', {
        label: '변경 재개', role: 'Quality Engineer'
    }, changeReopenBlock(ctx));
    const options = ctx.checks.map(check => changeCheckOption(ctx, check,
        check === ctx.latest && ctx.latestStatus === 'Reopen Required')).join('');
    const lineage = ctx.change.state === 'Closed'
        ? '이전 종결 결정과 확인 근거는 그대로 보존됩니다.'
        : '<strong>종결 전 재개:</strong> 종결 기록을 만들지 않고 실패한 모니터링 사이클을 남깁니다.';
    const recurrenceNeeded = ctx.latestStatus === 'Reopen Required' && Number(ctx.latestEvent?.payload?.targetedDefects) > 0;
    const recurrence = recurrenceNeeded
        ? `<label class="span-all">재발 AOI 결함 ID (필수)<input name="recurrenceAoiDefectId" required maxlength="80" pattern="[A-Z](?:[A-Z0-9]|-){2,79}" autocomplete="off" spellcheck="false" class="mono" placeholder="AOI 결함 ID"></label>
            <p class="muted">최신 확인에서 대상 결함 ${text(number(ctx.latestEvent.payload.targetedDefects))}건이 발견되었습니다. 설비 AOI 원천 기록에서 연결된 결함 ID를 확인하세요.</p>`
        : '<p class="muted">최신 확인에 대상 결함 재발이 없어 AOI 결함 ID는 필요하지 않습니다.</p>';
    return `<div class="effectiveness-action" aria-labelledby="change-reopen-title"><h4 id="change-reopen-title">모니터링 재개</h4>${card}
        <form id="change-reopen-form" class="form-grid capa-form" data-change-monitoring-form="reopen"><p>${lineage} 최신 불합격 확인을 선택하세요.</p>
        <details><summary>기록 ID</summary><label>재개 결정 ID<input name="id" required maxlength="80" pattern="[A-Z](?:[A-Z0-9]|-){2,79}" autocomplete="off" spellcheck="false" class="mono" value="${text(nextChangeRecordId(detail, 'REOPEN', usedChangeDecisionIds(detail)))}"></label></details>
        <label>재개 시각 (UTC)<input name="at" required maxlength="24" autocomplete="off" spellcheck="false" class="mono" value="${text(laterUtc(ctx.change.updated_at))}"></label>
        <label class="span-all">불합격 확인<select name="checkId" required><option value="" selected>선택하세요</option>${options}</select></label>
        ${recurrence}
        <label class="span-all">재개 이유<textarea name="reason" required maxlength="500" placeholder="후속 근거와 재개 이유를 입력하세요"></textarea></label>
        ${utcHint(detail, ' 재개 후 다음 개정은 원래 요청자가 시작합니다.')}
        <button type="button" class="button primary" data-change-monitoring-submit="reopen" ${gateState}>변경 재개 →</button></form></div>`;
}

function renderChangeMonitoring(detail) {
    if (!changeMonitoringStates.includes(detail.change.state)) return '';
    const ctx = changeMonitoringContext(detail);
    const latest = ctx.latestStatus ?? '기록 없음';
    const showReopen = ['Effectiveness Monitoring', 'Closed'].includes(ctx.change.state) && ctx.checks.length > 0;
    return `<section class="detail-section change-monitoring" data-change-monitoring aria-labelledby="change-monitoring-title">
        <h3 id="change-monitoring-title">효과성 모니터링</h3>
        <p>후속 LOT·공정 실행·AOI 기록으로 효과를 확인합니다. 표시 시각은 UTC입니다.</p>
        <div class="field-grid">${row('운영 수락 상태', ctx.gate.summary)}${row('확인 회차', ctx.change.cycle_no ?? '—')}${row('최근 확인 결과', latest)}${row('종결 여부', ctx.closure ? '종결됨' : '진행 중')}</div>
        <details><summary>기술 정보</summary><div class="field-grid">${row('최근 확인 ID', ctx.latest?.id ?? '없음')}${row('종결 결정 ID', ctx.closure?.payload?.decisionId ?? '없음')}${row('마지막 변경 시각 (UTC)', dateText(ctx.change.updated_at))}${row('서버 현재 시각 (UTC)', dateText(detail.serverNowUtc))}</div></details>
        ${ctx.gate.block ? `<div class="warning-box">${text(ctx.gate.block)}</div>` : ''}
        ${renderChangeEvaluate(detail, ctx)}
        ${ctx.change.state === 'Effectiveness Monitoring' ? renderChangeClose(detail, ctx) : ''}
        ${showReopen ? renderChangeReopen(detail, ctx) : ''}</section>`;
}

async function runChangeMonitoring(kind, button) {
    if (state.busy) return;
    const detail = state.detail;
    const form = document.getElementById(`change-${kind}-form`);
    if (!detail || !form || !changeMonitoringStates.includes(detail.change.state)) {
        throw new Error('Change monitoring is not available in the current Change state');
    }
    const ctx = changeMonitoringContext(detail);
    const blocked = kind === 'evaluate' ? changeEvaluateBlock(ctx) :
        kind === 'close' ? changeCloseBlock(ctx) : changeReopenBlock(ctx);
    if (blocked) throw new Error(blocked);
    const values = new FormData(form);
    const value = name => String(values.get(name) ?? '').trim();
    const input = { changeId: detail.change.id, expectedRevisionNo: detail.change.current_revision_no,
        id: value('id'), actorId: state.actorId, at: value('at') };
    if (!input.id || !input.at) throw new Error('Enter a record ID and a canonical UTC time');
    assertStableId(input.id, 'Record ID');
    if (kind === 'evaluate') {
        await submitEffectivenessAction(button, 'evaluateChangeEffectiveness', input, result =>
            `Effectiveness check ${result.checkId} recorded: ${result.status} · ${number(result.lotCount)} later lots${result.lotIds?.length ? ` (${result.lotIds.join(', ')})` : ''} · state ${result.state}.${result.reasons?.length ? ` Findings: ${result.reasons.join('; ')}` : ''}`);
        return;
    }
    input.checkId = value('checkId');
    input.reason = value('reason');
    if (!input.checkId || !input.reason) throw new Error('Choose the latest check and enter a reason');
    if (input.checkId !== ctx.latest?.id) throw new Error('Choose the latest effectiveness check of the current revision');
    if (kind === 'close') {
        await submitEffectivenessAction(button, 'closeChangeMonitoring', input, result =>
            `Change monitoring closed by ${result.decisionId} citing passing check ${result.checkId}. Check records are unchanged.`);
        return;
    }
    const recurrence = value('recurrenceAoiDefectId');
    if (form.elements?.recurrenceAoiDefectId && !recurrence) {
        throw new Error('Enter the target recurrence AOI defect ID linked to the failed check');
    }
    if (recurrence) {
        assertStableId(recurrence, 'Target recurrence AOI defect ID');
        input.recurrenceAoiDefectId = recurrence;
    }
    await submitEffectivenessAction(button, 'reopenChangeMonitoring', input, result =>
        `Change reopened by ${result.decisionId} from failed check ${result.failedCheckId}; cycle ${result.nextCycleNo} begins. Earlier Acceptance, checks and decisions stay in history. The original proposer may start the next revision.`);
}

function renderChangeDetail() {
    const detail = state.detail;
    if (!detail) return empty('선택한 변경이 없습니다', '변경 목록에서 기록을 열어 주세요.');
    const change = detail.change;
    const current = detail.revisions.find(item => item.revision.revision_no === change.current_revision_no);
    const next = actionFor(detail);
    const eligible = actorEligible(next, detail);
    return `<div class="page-heading"><div><p class="eyebrow">변경 관리</p><h1>변경 상세</h1><p>현재 단계, 검증 기준과 승인 이력을 확인합니다.</p></div><div class="heading-actions"><button type="button" class="button" data-view="changes">← 변경 목록</button></div></div>
        <div class="record-header"><div><h2>${text(change.title)}</h2><p>${text(change.reason)}</p><details><summary>기술 정보</summary><span class="mono muted">${text(change.id)} · 개정 R${number(change.current_revision_no)}</span></details></div><div class="record-meta">${chip(change.state)}<span class="small-chip">${text(change.equipment_id)}</span><span class="small-chip">${text(change.recipe_revision_id)}</span></div></div>
        <div class="panel-grid top-gap"><div class="stack"><section class="detail-section"><h3>변경 이력 및 근거</h3><p>불합격 기록과 이후 개정을 함께 보존합니다.</p>${detail.revisions.map(item => renderRevision(item, item.revision.revision_no === change.current_revision_no, detail)).join('')}</section></div>
        <div class="stack"><section class="detail-section"><h3>현재 단계</h3><div class="field-grid">${row('상태', labelFor(labels.states, change.state) ?? change.state)}${row('요청자', detail.change.proposer_actor_id)}${row('대상 레시피', change.recipe_revision_id)}</div><details><summary>기술 정보</summary>${row('현재 계획 ID', current?.plans.at(-1)?.id ?? '없음')}</details><hr class="divider">${renderGateControls(next, eligible, detail)}</section>
        ${renderChangeMonitoring(detail)}
        <section class="detail-section"><h3>감사 이력</h3><p>각 결정의 역할과 시각을 확인할 수 있습니다. 내부 ID와 검증값은 감사 상세에 있습니다.</p>${renderAudit(detail.audit)}</section></div></div>`;
}

function renderModule(name, subtitle, explanation, count = null) {
    return `<div class="page-heading"><div><p class="eyebrow">관리 문서</p><h1>${text(name)}</h1><p>${text(subtitle)}</p></div></div>
        <div class="card"><div class="card-kicker">연결된 문서</div><h2>${count == null ? 'CAPA와 문서 개정' : `${number(count)}건`}</h2><p>${text(explanation)}</p><button type="button" class="button subtle" data-view="fabtrace">FabTrace에서 확인 →</button></div>`;
}

function incidentGate(detail) {
    const incident = detail.incident;
    const base = { incidentId: incident.id, expectedRevisionNo: detail.revisions.at(-1)?.revision_no,
        actorId: state.actorId };
    const nextAt = new Date(Date.parse(incident.updated_at) + 120_000).toISOString();
    if (incident.state === 'Open') return { action: 'containIncident', role: 'Production Manager or Quality Engineer',
        label: 'Record containment', needsReason: true,
        input: { ...base, ownerActorId: state.actorId,
            heldLotIds: ['LOT-A-025', 'LOT-A-026', 'LOT-A-027'], at: '2026-08-27T10:04:00.000Z' } };
    if (incident.state === 'Contained' && !detail.lkg) return {
        action: 'recordIncidentLkg', role: 'Quality or Verification Engineer',
        label: 'Record sampled LKG', input: { ...base,
            aoiInspectionId: 'AOI-A-025', earliestPossibleAt: '2026-08-25T08:00:00.000Z',
            latestPossibleAt: '2026-08-25T12:00:00.000Z',
            method: 'AOI 대상 코드 검사', sampleScope: '100개 단위 검사',
            limitation: 'Sampled AOI does not prove all intervening units good',
            at: '2026-08-27T10:06:00.000Z' } };
    if (incident.state === 'Contained') return { action: 'proposeIncidentTrace',
        role: 'Quality, Manufacturing or Equipment Engineer', label: 'Calculate exposure scope',
        input: { ...base, at: '2026-08-27T10:08:00.000Z' } };
    if (incident.state === 'Trace Proposed' && detail.scopeReview?.decision === 'Needs Rework') {
        return { action: 'reviseIncidentTrace',
            role: 'Quality, Manufacturing or Equipment Engineer',
            label: 'Revise trace proposal', needsReason: true,
            input: { ...base, at: nextAt } };
    }
    if (incident.state === 'Trace Proposed') return { action: 'reviewIncidentScope',
        role: 'Independent Reviewer or Quality Engineer', label: 'Review candidate scope',
        needsReason: true, input: { ...base, proposalId: detail.proposal?.id,
            at: nextAt } };
    return null;
}

function incidentActorEligible(next, detail) {
    const actor = state.bootstrap.actors.find(item => item.id === state.actorId);
    if (!actor || !next) return false;
    if (next.action === 'containIncident') return ['Production Manager', 'Quality Engineer'].includes(actor.role);
    if (next.action === 'recordIncidentLkg') return ['Quality Engineer', 'Verification Engineer'].includes(actor.role);
    if (next.action === 'proposeIncidentTrace') return [
        'Quality Engineer', 'Manufacturing Engineer', 'Equipment / Automation Engineer'
    ].includes(actor.role);
    if (next.action === 'reviseIncidentTrace') return [
        'Quality Engineer', 'Manufacturing Engineer', 'Equipment / Automation Engineer'
    ].includes(actor.role);
    if (next.action === 'reviewIncidentScope') return ['Reviewer', 'Quality Engineer'].includes(actor.role) &&
        actor.id !== detail.proposal?.proposer_actor_id;
    return false;
}

// Explains why the selected persona is blocked. Display only; the server still enforces every gate.
function incidentBlockReason(next, detail) {
    if (!next || incidentActorEligible(next, detail)) return null;
    const actor = state.bootstrap.actors.find(item => item.id === state.actorId);
    if (!actor) return '현재 역할을 선택하세요.';
    if (next.action === 'reviewIncidentScope' && actor.id === detail.proposal?.proposer_actor_id) {
        return `제안자 ≠ 검토자 · ${actor.id} proposed trace ${detail.proposal.id}, so the same actor cannot review its scope. Select a different Reviewer or Quality Engineer.`;
    }
    const decision = {
        containIncident: 'record containment and hold candidate lots',
        recordIncidentLkg: 'record the sampled last known good observation',
        proposeIncidentTrace: 'calculate the exposure scope',
        reviseIncidentTrace: 'revise the trace proposal',
        reviewIncidentScope: 'review the candidate scope'
    }[next.action] ?? 'make this decision';
    return `역할 불일치 · ${actor.role} (${actor.id}) cannot ${decision}. Only ${next.role} may do this.`;
}

function actorHasRole(roles) {
    const actor = state.bootstrap.actors.find(item => item.id === state.actorId);
    return Boolean(actor && roles.includes(actor.role));
}

// Same contract as the server stableId rule and the rendered pattern attributes (valid under the browser v flag).
const stableIdRule = /^[A-Z](?:[A-Z0-9]|-){2,79}$/;
function assertStableId(value, label) {
    if (!stableIdRule.test(value)) {
        throw new Error(`ID 형식 오류 · ${label} must be 3–80 characters: an uppercase letter, then uppercase letters, digits or hyphens.`);
    }
}

function laterUtc(value, seconds = 120) {
    return new Date(Date.parse(value) + seconds * 1000).toISOString();
}

function renderCapaForm(kind, label, fields, eligible, explanation = '') {
    const formId = `capa-${kind}-form`;
    const controls = fields.map(field => {
        // Every CAPA choice starts empty so a human must pick source, cause, type, owner or decision explicitly.
        if (field.type === 'select') return `<label>${text(field.label)}<select name="${text(field.name)}" required><option value="" selected>선택하세요</option>${field.options.map(option => `<option value="${text(option.value)}">${text(option.label)}</option>`).join('')}</select></label>`;
        const type = field.type || 'text';
        return `<label>${text(field.label)}<input name="${text(field.name)}" type="${text(type)}" ${field.required === false ? '' : 'required'} maxlength="${field.maxlength ?? 500}" placeholder="${text(field.placeholder ?? '')}"></label>`;
    }).join('');
    return `<form id="${formId}" class="form-grid capa-form" data-capa-form="${text(kind)}">${explanation ? `<p>${text(explanation)}</p>` : ''}${controls}<button type="button" class="button primary" data-capa-submit="${text(kind)}" ${eligible ? '' : 'disabled'}>${text(label)} →</button>${eligible ? '' : '<p class="warning-box">이 작업을 수행할 수 있는 역할을 선택하세요.</p>'}</form>`;
}

function renderCapaWorkflow(detail) {
    const cycle = openCapaCycle(detail);
    const priorCycle = detail.capaCycles.at(-1) ?? null;
    const awaitingReopenedCycle = detail.incident.state === 'Reopened' && !cycle;
    const causes = detail.causeAssessments;
    const actions = detail.capaActions;
    const feedback = detail.documentFeedback;
    const latest = detail.revisions.at(-1)?.revision_no;
    const cycleFields = item => `<div class="field-grid">${row('사이클 번호', item.cycle_no)}${row('시작자 · 시각', `${item.opened_by} · ${dateText(item.opened_at)}`)}</div><details><summary>기술 정보</summary><div class="field-grid">${row('사이클 ID', item.id)}${row('이전 사이클', item.parent_cycle_id ?? '첫 사이클')}</div></details>`;
    const reopenDecision = awaitingReopenedCycle && priorCycle
        ? detail.cycleDecisions.find(item => item.cycle_id === priorCycle.id && item.decision === 'Reopened') : null;
    const cycleHeader = cycle ? cycleFields(cycle) : awaitingReopenedCycle && priorCycle
        ? `${cycleFields(priorCycle)}<div class="hint-box">이전 사이클이 재개되었습니다. 다음 사이클을 시작하면 이전 결정과 근거가 보존됩니다.${reopenDecision ? `<details><summary>재개 결정 ID</summary><span class="mono">${text(reopenDecision.id)}</span></details>` : ''}</div>`
        : '<p class="muted">독립 범위 검토가 합격한 뒤 CAPA 사이클을 시작할 수 있습니다.</p>';
    const startForm = !cycle && (detail.incident.state === 'Scope Reviewed' || awaitingReopenedCycle)
        ? renderCapaForm('start', 'CAPA 사이클 시작', [
            { name: 'reason', label: 'CAPA 시작 이유', placeholder: '수락된 영향 범위에 CAPA가 필요한 이유' }
        ], actorHasRole(['Quality Engineer', 'Production Manager'])) : '';
    const causeList = causes.length ? `<div class="table-wrap"><table><thead><tr><th>원인</th><th>판정</th><th>연결된 근거</th><th>판정자 · 시각</th></tr></thead><tbody>${causes.map(item => `<tr><td class="mono">${text(item.id)}</td><td>${chip(item.status)}<br>${text(item.statement)}</td><td>${text(item.evidence_kind)} · <span class="mono">${text(item.evidence_id)}</span></td><td>${text(item.assessed_by)}<br><span class="muted">${dateText(item.assessed_at)}</span></td></tr>`).join('')}</tbody></table></div>` : empty('원인 기록 없음', '원천 근거와 연결된 가설 또는 확인된 원인을 기록하세요.');
    const confirmed = causes.filter(item => item.status === 'Confirmed');
    const causeForm = cycle ? renderCapaForm('cause', '근본 원인 기록', [
        { name: 'id', label: '원인 ID', placeholder: 'CAUSE-001' },
        { name: 'status', label: '판정 상태', type: 'select', options: [
            { value: 'Hypothesis', label: '가설' }, { value: 'Confirmed', label: '확인됨' }] },
        { name: 'statement', label: '근본 원인 · 이유', placeholder: '원천 근거로 뒷받침되는 원인을 적으세요' },
        { name: 'evidenceKind', label: '근거 유형', type: 'select', options: [
            { value: 'equipment-event', label: '설비 이벤트' }, { value: 'aoi-inspection', label: 'AOI 검사' },
            { value: 'measurement', label: '측정' }] },
        { name: 'evidenceId', label: '원천 근거 ID', placeholder: 'EV-001' }
    ], actorHasRole(['Quality Engineer', 'Manufacturing Engineer', 'Equipment / Automation Engineer'])) : '';
    const actionList = actions.length ? `<div class="table-wrap"><table><thead><tr><th>CAPA 조치</th><th>담당자 · 기한</th><th>근본 원인</th><th>독립 검토</th></tr></thead><tbody>${actions.map(item => `<tr><td><span class="mono">${text(item.id)}</span><br>${chip(item.action_type)}<br>${text(item.action_text)}</td><td>${text(item.owner_actor_id)}<br><span class="muted">기한 ${dateText(item.due_at)}</span></td><td class="mono">${text(item.cause_id)}</td><td>${item.review ? `${chip(item.review.decision)} · ${text(item.review.reviewer_actor_id)}<br>${text(item.review.reason)}<br><span class="muted">${text(item.review.evidence_kind)} · ${text(item.review.evidence_id)}</span>` : '<span class="status-chip warn">검토 대기</span>'}</td></tr>`).join('')}</tbody></table></div>` : empty('시정·예방 조치 없음', '확인된 원인에 조치를 연결하고 담당자를 지정하세요.');
    const causeOptions = confirmed.map(item => ({ value: item.id, label: `${item.id} · ${item.statement}` }));
    const ownerOptions = state.bootstrap.actors.filter(item => ['Quality Engineer', 'Manufacturing Engineer', 'Equipment / Automation Engineer', 'Production Manager', 'Verification Engineer'].includes(item.role)).map(item => ({ value: item.id, label: `${roleLabel(item.role)} · ${actorDisplayName(item)}` }));
    const actionForm = cycle && causeOptions.length ? renderCapaForm('action', 'CAPA 조치 기록', [
        { name: 'id', label: '조치 ID', placeholder: 'CAPA-001' },
        { name: 'causeId', label: '확인된 근본 원인', type: 'select', options: causeOptions },
        { name: 'actionType', label: '조치 유형', type: 'select', options: [
            { value: 'Corrective', label: '시정 조치' }, { value: 'Preventive', label: '예방 · 표준화 조치' }] },
        { name: 'ownerActorId', label: '조치 담당자', type: 'select', options: ownerOptions },
        { name: 'actionText', label: '조치 내용', placeholder: '검증 가능한 조치 내용을 적으세요' },
        { name: 'dueAt', label: '완료 기한 (UTC)', placeholder: '2026-09-01T00:00:00.000Z' }
    ], actorHasRole(['Quality Engineer', 'Manufacturing Engineer', 'Equipment / Automation Engineer'])) : '';
    const reviewable = actions.filter(item => !item.review);
    const reviewForm = cycle && reviewable.length ? renderCapaForm('action-review', '독립 조치 검토 기록', [
        { name: 'actionId', label: '검토할 조치', type: 'select', options: reviewable.map(item => ({ value: item.id, label: `${item.id} · ${item.action_type}` })) },
        { name: 'decision', label: '검토 결정', type: 'select', options: [
            { value: 'Pass', label: '합격' }, { value: 'Needs Rework', label: '재작업 필요' }] },
        { name: 'evidenceKind', label: '검증 근거 유형', type: 'select', options: [
            { value: 'aoi-inspection', label: 'AOI 검사' }, { value: 'measurement', label: '측정' },
            { value: 'equipment-event', label: '설비 이벤트' }] },
        { name: 'evidenceId', label: '후속 원천 근거 ID', placeholder: 'AOI-A-028' },
        { name: 'reviewedAt', label: '검토 시각 (UTC)', placeholder: '2026-08-29T10:00:00.000Z' },
        { name: 'reason', label: '독립 검토 이유', placeholder: '후속 원천 근거와 판정 결과를 적으세요' }
    ], actorHasRole(['Reviewer', 'Quality Engineer']) && reviewable.some(item => item.created_by !== state.actorId && item.owner_actor_id !== state.actorId)) : '';
    const passedActions = actions.filter(item => item.review?.decision === 'Pass');
    const currentDocs = detail.controlledDocuments.map(doc => {
        const current = doc.revisions.at(-1);
        return current ? { value: `${doc.id}|${current.id}`, label: `${doc.doc_type} · ${doc.code} · ${current.id}` } : null;
    }).filter(Boolean);
    const feedbackList = feedback.length ? `<div class="table-wrap"><table><thead><tr><th>문서 피드백</th><th>원천 조치 · 사건 사이클</th><th>원천 검토</th><th>개정 결과</th></tr></thead><tbody>${feedback.map(item => {
        const doc = detail.controlledDocuments.find(candidate => candidate.id === item.document_id);
        const revisions = doc?.revisions ?? [];
        const sourceRevision = revisions.find(revision => revision.source_feedback_id === item.id);
        return `<tr><td><span class="mono">${text(item.id)}</span><br>${text(doc?.title ?? item.document_id)}<br>${text(item.proposed_summary)}</td><td class="mono">${text(item.capa_action_id)}<br>${text(item.incident_id)} / ${text(item.cycle_id)}</td><td>${item.review ? `${chip(item.review.decision)} · ${text(item.review.reviewer_actor_id)}<br>${text(item.review.reason)}` : '<span class="status-chip warn">검토 대기</span>'}</td><td>${text(item.base_revision_id)} → ${text(sourceRevision?.id ?? '승인 대기')}<br>${sourceRevision ? `승인자 ${text(sourceRevision.approved_by)}` : ''}</td></tr>`;
    }).join('')}</tbody></table></div>` : empty('관리 문서 피드백 없음', '독립 검토를 통과한 CAPA 조치에서 문서 개정을 제안할 수 있습니다.');
    const feedbackForm = cycle && passedActions.length && currentDocs.length ? renderCapaForm('feedback', '문서 피드백 제안', [
        { name: 'id', label: '피드백 ID', placeholder: 'FB-001' },
        { name: 'documentRevision', label: '관리 문서 · 현재 개정', type: 'select', options: currentDocs },
        { name: 'capaActionId', label: '검토된 조치', type: 'select', options: passedActions.map(item => ({ value: item.id, label: `${item.id} · ${item.action_type}` })) },
        { name: 'proposedSummary', label: '제안 변경 요약', placeholder: '관리 문서 변경 내용을 적으세요' }
    ], actorHasRole(['Quality Engineer', 'Manufacturing Engineer', 'Equipment / Automation Engineer'])) : '';
    const pendingFeedback = feedback.filter(item => !item.review);
    const feedbackReviewForm = pendingFeedback.length ? renderCapaForm('feedback-review', '문서 피드백 검토', [
        { name: 'feedbackId', label: '검토할 피드백', type: 'select', options: pendingFeedback.map(item => ({ value: item.id, label: `${item.id} · ${item.document_id}` })) },
        { name: 'decision', label: '검토 결정', type: 'select', options: [
            { value: 'Pass', label: '합격' }, { value: 'Needs Rework', label: '재작업 필요' }] },
        { name: 'verificationId', label: '검증 기록 ID', placeholder: 'CAPA 조치 검토 ID' },
        { name: 'reason', label: '독립 검토 이유', placeholder: '제안 개정과 검토된 CAPA의 관계를 적으세요' }
    ], actorHasRole(['Reviewer', 'Quality Engineer', 'Approver']) && pendingFeedback.some(item => item.proposed_by !== state.actorId)) : '';
    const approvableFeedback = feedback.filter(item => item.review?.decision === 'Pass' &&
        item.proposed_by !== state.actorId && item.review.reviewer_actor_id !== state.actorId);
    const approvalForm = approvableFeedback.length ? renderCapaForm('document-approval', '관리 문서 개정 승인', [
        { name: 'feedbackId', label: '검토된 피드백', type: 'select', options: approvableFeedback.map(item => ({ value: item.id, label: `${item.id} · ${item.document_id}` })) },
        { name: 'reason', label: '승인 이유', placeholder: '검토된 문서 변경을 확인하세요' }
    ], actorHasRole(['Approver', 'Quality Engineer'])) : '';
    const documentRevisions = detail.controlledDocuments.map(doc => `<div class="revision-card"><div class="revision-head"><strong>${text(doc.doc_type)} · ${text(doc.code)}</strong><span class="small-chip">${text(doc.scope_equipment_id)} / ${text(doc.defect_code_id)}</span></div><div class="revision-body">${doc.revisions.map(revision => `<div class="field-grid document-lineage">${row('개정', `R${revision.revision_no}`)}${row('개정 요약', revision.summary)}${row('승인자 · 시각', `${revision.approved_by} · ${dateText(revision.approved_at)}`)}</div><details><summary>개정 기술 정보</summary><div class="field-grid">${row('개정 ID', revision.id)}${row('이전 개정', revision.parent_revision_id ?? '기준 개정')}${row('원천 피드백', revision.source_feedback_id ?? '기준 데이터')}${row('원천 사건', revision.source_incident_id ?? '기준 데이터')}${row('원천 사이클', revision.source_cycle_id ?? '기준 데이터')}</div></details>`).join('')}</div></div>`).join('');
    const audit = detail.audit.filter(item => ['capa-started', 'cause-assessed', 'capa-action-recorded', 'capa-action-reviewed', 'document-feedback-proposed', 'document-feedback-reviewed', 'document-revision-approved'].includes(item.action));
    const reviewedActions = actions.filter(item => item.review);
    const actionReviewList = reviewedActions.length ? `<div class="table-wrap"><table><thead><tr><th>검토된 조치</th><th>결정</th><th>후속 원천 근거</th><th>검토자 · 이유</th></tr></thead><tbody>${reviewedActions.map(item => `<tr><td class="mono">${text(item.id)}</td><td>${chip(item.review.decision)}</td><td>${text(item.review.evidence_kind)} · <span class="mono">${text(item.review.evidence_id)}</span></td><td>${text(item.review.reviewer_actor_id)}<br>${text(item.review.reason)}</td></tr>`).join('')}</tbody></table></div>` : empty('독립 조치 검토 없음', '별도 검토자가 후속 원천 근거로 조치를 확인합니다.');
    const reviewedFeedback = feedback.filter(item => item.review);
    const feedbackReviewList = reviewedFeedback.length ? `<div class="table-wrap"><table><thead><tr><th>검토된 피드백</th><th>결정</th><th>검토자 · 이유</th></tr></thead><tbody>${reviewedFeedback.map(item => `<tr><td class="mono">${text(item.id)}</td><td>${chip(item.review.decision)}</td><td>${text(item.review.reviewer_actor_id)}<br>${text(item.review.reason)}</td></tr>`).join('')}</tbody></table></div>` : empty('문서 피드백 검토 없음', '제안자와 다른 검토자가 CAPA 근거로 피드백을 확인합니다.');
    const feedbackIds = new Set(feedback.map(item => item.id));
    const approvedCount = detail.controlledDocuments.reduce((total, doc) =>
        total + doc.revisions.filter(revision => feedbackIds.has(revision.source_feedback_id)).length, 0);
    const current = currentCapaStage(detail);
    const stages = [
        { key: 'cycle', ko: '사이클', en: 'CAPA cycle', count: detail.capaCycles.length, body: `${cycleHeader}${startForm}` },
        { key: 'cause', ko: '원인', en: 'Root cause', count: causes.length,
            body: cycle ? `${causeList}${causeForm}` : `${causeList}<p class="muted">원인을 기록하려면 CAPA 사이클을 먼저 시작하세요.</p>` },
        { key: 'action', ko: '조치', en: 'Corrective and preventive actions', count: actions.length,
            body: `${actionList}${actionForm || (cycle ? '<p class="muted">조치를 계획하려면 근본 원인을 먼저 확인하세요.</p>' : '')}` },
        { key: 'action-review', ko: '조치 검토', en: 'Independent action review', count: reviewedActions.length, body: `${actionReviewList}${reviewForm}` },
        { key: 'feedback', ko: '문서 피드백', en: 'Controlled-document feedback', count: feedback.length,
            body: `${feedbackList}${feedbackForm || (cycle ? '<p class="muted">문서 피드백에는 독립 검토를 통과한 CAPA 조치가 필요합니다.</p>' : '')}` },
        { key: 'feedback-review', ko: '피드백 검토', en: 'Feedback review', count: reviewedFeedback.length, body: `${feedbackReviewList}${feedbackReviewForm}` },
        { key: 'approval', ko: '승인', en: 'Controlled-document approval', count: approvedCount,
            body: `${approvalForm}<h4>공유 설비 · 결함 기준 문서 개정</h4>${documentRevisions || empty('연결된 관리 문서 없음', '이 설비와 결함 범위의 관리 문서가 없습니다.')}` }
    ];
    const currentIndex = stages.findIndex(item => item.key === current);
    const stageList = stages.map((item, index) => {
        const status = index === currentIndex ? 'current' : index < currentIndex ? 'done' : 'pending';
        const statusText = { current: '현재', done: '완료', pending: '대기' }[status];
        return `<details class="capa-stage ${status}" data-capa-stage="${item.key}"${status === 'current' ? ' open aria-current="step"' : ''}><summary><span class="stage-no">0${index + 1}</span><span class="stage-title">${text(item.ko)}</span><span class="stage-count">${number(item.count)}건</span><span class="stage-status">${statusText}</span></summary><div class="capa-stage-body">${item.body}</div></details>`;
    }).join('');
    return `<section class="detail-section capa-workflow" aria-label="CAPA 및 관리 문서 흐름"><h3>CAPA 단계</h3><p>현재 단계가 펼쳐져 있습니다. 완료·대기 단계와 과거 결정도 확인할 수 있습니다.</p><div class="capa-stages">${stageList}</div><h3 class="top-gap">CAPA 감사 이력</h3>${audit.length ? renderAudit(audit) : empty('CAPA 감사 결정 없음', 'CAPA와 문서 결정은 사건 감사 이력에 기록됩니다.')}</section>`;
}

// Picks the single open CAPA stage from persisted records. Presentation only; the server decides what is allowed.
function currentCapaStage(detail) {
    const cycle = openCapaCycle(detail);
    const actions = detail.capaActions;
    const feedback = detail.documentFeedback;
    if (!cycle) return 'cycle';
    if (!detail.causeAssessments.some(item => item.status === 'Confirmed')) return 'cause';
    if (!actions.length) return 'action';
    if (actions.some(item => !item.review)) return 'action-review';
    if (!actions.some(item => item.review.decision === 'Pass')) return 'action';
    if (!feedback.length) return 'feedback';
    if (feedback.some(item => !item.review)) return 'feedback-review';
    if (!feedback.some(item => item.review.decision === 'Pass')) return 'feedback';
    return 'approval';
}

const ledgerFact = (label, value, mono = false) => `<div class="field"><span class="field-label">${text(label)}</span><span class="field-value${mono ? ' mono' : ''}">${text(value ?? '—')}</span></div>`;
const ledgerBlock = (label, html) => `<div class="field ledger-block"><span class="field-label">${text(label)}</span>${html}</div>`;

function renderEffectivenessCheck(check, payload) {
    const result = check.passed ? '<span class="status-chip good">합격</span>' :
        Number(check.recurrence_count) > 0 ? '<span class="status-chip bad">재발 · 불합격</span>' :
            '<span class="status-chip uncertain">데이터 부족 · 모니터링</span>';
    const lots = Array.isArray(check.source?.lotIds) ? check.source.lotIds : [];
    const gaps = Array.isArray(payload?.gaps) ? payload.gaps : null;
    const missing = gaps == null ? '<p class="muted">연결된 감사 상세가 없습니다.</p>' :
        gaps.length ? `<ul class="gap-list">${gaps.map(gap => `<li>${text(gap)}</li>`).join('')}</ul>` :
            '<p>누락 요건 없음</p>';
    return `<li class="ledger-entry" data-check-id="${text(check.id)}"><div class="ledger-entry-head"><span class="ledger-kind">효과성 확인</span>${result}</div>
        <div class="field-grid">${ledgerFact('확인 시각 (UTC)', dateText(check.evaluated_at))}${ledgerFact('후속 LOT', `${number(check.lot_count)}건${payload?.requiredLots ? ` · 필요 ${number(payload.requiredLots)}건` : ''}`)}${ledgerFact('AOI 검사 / 불량', `${number(check.inspected_units)} / ${number(check.rejected_units)}`)}${ledgerFact('재발 / 미해결 경보', `${number(check.recurrence_count)} / ${number(check.unresolved_alarm_count)}`)}</div>
        ${ledgerBlock('판정 사유', missing)}<details><summary>상세 근거</summary><div class="field-grid">${ledgerFact('확인 ID', check.id, true)}${ledgerFact('확인자', check.evaluated_by)}${ledgerFact('출처 구간 (UTC)', `${dateText(check.window_start)} → ${dateText(check.window_end)}`)}${ledgerFact('규칙 버전', check.rule_version, true)}</div>
        ${ledgerBlock(`출처 LOT (${number(lots.length)})`, lots.length ? `<ul class="lot-list">${lots.map(lot => `<li class="small-chip mono">${text(lot)}</li>`).join('')}</ul>` : '<p class="muted">해당 구간의 LOT 없음</p>')}${ledgerBlock('출처 검증값', `<span class="digest">${text(check.source_digest)}</span>`)}</details></li>`;
}

function renderCycleDecision(decision, check, payload) {
    const kind = decision.decision === 'Closed' ? '종결 결정' : decision.decision === 'Reopened' ? '재개 결정' : '사이클 결정';
    return `<li class="ledger-entry" data-decision-id="${text(decision.id)}"><div class="ledger-entry-head"><span class="ledger-kind">${kind}</span>${chip(decision.decision)}</div>
        <div class="field-grid">${ledgerFact('결정 시각 (UTC)', dateText(decision.decided_at))}${ledgerFact('판단 이유', decision.reason)}</div>
        <details><summary>결정 상세</summary><div class="field-grid">${ledgerFact('결정 ID', decision.id, true)}${ledgerFact('결정자', decision.actor_id)}${ledgerFact('연결된 확인', decision.effectiveness_check_id, true)}${ledgerFact('재발 근거 (AOI)', decision.recurrence_aoi_defect_id ?? '해당 없음', Boolean(decision.recurrence_aoi_defect_id))}${payload?.priorClosureId ? ledgerFact('이전 종결', payload.priorClosureId, true) : ''}${payload?.nextCycleNo ? ledgerFact('다음 사이클', payload.nextCycleNo) : ''}</div>${check ? ledgerBlock('연결된 출처 검증값', `<span class="digest">${text(check.source_digest)}</span>`) : ''}</details></li>`;
}

// Read-only Phase 5 ledger built from persisted checks, decisions and audit payloads. No action is sent from here.
function renderEffectivenessHistory(detail) {
    const cycles = detail.capaCycles ?? [];
    if (!cycles.length) return '';
    const checks = detail.effectivenessChecks ?? [];
    const decisions = detail.cycleDecisions ?? [];
    const auditPayloads = (action, key) => new Map(detail.audit
        .filter(item => item.action === action && item.payload?.[key])
        .map(item => [item.payload[key], item.payload]));
    const checkAudit = auditPayloads('effectiveness-evaluated', 'checkId');
    const reopenAudit = auditPayloads('incident-reopened', 'reopenDecisionId');
    const checksById = new Map(checks.map(item => [item.id, item]));
    const panels = cycles.map(cycle => {
        const entries = [
            ...checks.filter(item => item.cycle_id === cycle.id).map(item => ({ at: item.evaluated_at, id: item.id,
                html: renderEffectivenessCheck(item, checkAudit.get(item.id)) })),
            ...decisions.filter(item => item.cycle_id === cycle.id).map(item => ({ at: item.decided_at, id: item.id,
                html: renderCycleDecision(item, checksById.get(item.effectiveness_check_id), reopenAudit.get(item.id)) }))
        ].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1);
        const parent = cycle.parent_cycle_id;
        const reopenedBy = parent ? decisions.find(item => item.cycle_id === parent && item.decision === 'Reopened') : null;
        const closure = decisions.find(item => item.cycle_id === cycle.id && item.decision === 'Closed');
        const lineage = parent
            ? `이전 사이클에서 재개됨${reopenedBy ? ` · 결정 ${text(reopenedBy.id)}` : ''}`
            : '첫 사이클';
        return `<article class="cycle-panel" id="effectiveness-${text(cycle.id)}" data-cycle-id="${text(cycle.id)}"><header class="cycle-panel-head"><div><span class="ledger-kind">사이클 ${number(cycle.cycle_no)}</span></div>${closure ? '<span class="small-chip">종결됨</span>' : ''}</header>
            <p class="cycle-lineage">${lineage} · ${dateText(cycle.opened_at)}</p><details><summary>사이클 기술 정보</summary><span class="mono">${text(cycle.id)} · ${text(cycle.opened_by)}${closure ? ` · ${text(closure.id)}` : ''}</span>${parent ? ` · <a class="text-link mono" href="#effectiveness-${text(parent)}">${text(parent)}</a>` : ''}</details>
            ${entries.length ? `<ol class="ledger-entries">${entries.map(item => item.html).join('')}</ol>` : empty('효과성 확인 기록 없음', '확인과 종결·재개 결정이 저장되면 여기에 표시됩니다.')}</article>`;
    }).join('');
    return `<section class="detail-section effectiveness-history top-gap" data-effectiveness-history aria-labelledby="effectiveness-history-title">
        <h3 id="effectiveness-history-title">효과성 및 사이클 이력</h3>
        <p>재개 후에도 이전 확인과 종결 결정은 보존됩니다. 원천 ID와 검증값은 상세 근거에서 확인할 수 있습니다.</p>
        ${renderEffectivenessClose(detail)}${renderEffectivenessEvaluate(detail)}${renderEffectivenessReopen(detail)}
        <div class="cycle-stack">${panels}</div></section>`;
}

const monitoringStates = Object.freeze(['CAPA In Progress', 'Effectiveness Check', 'Closed']);
const effectivenessRoles = Object.freeze(['Quality Engineer', 'Verification Engineer']);

function activeIncidentCycle(detail) {
    return detail.capaCycles.find(item => item.cycle_no === detail.incident.cycle_no) ?? null;
}

// The cycle CAPA forms act on. After a reopen, no cycle exists until a human starts the next one.
function openCapaCycle(detail) {
    return detail.incident.state === 'Reopened' ? activeIncidentCycle(detail) : detail.capaCycles.at(-1) ?? null;
}

function nextEffectivenessCheckId(detail, cycle) {
    const used = new Set(detail.effectivenessChecks.map(item => item.id));
    const base = `EFF-${detail.incident.id}-C${cycle.cycle_no}`.slice(0, 72);
    let sequence = detail.effectivenessChecks.filter(item => item.cycle_id === cycle.id).length + 1;
    while (used.has(`${base}-${sequence}`)) sequence++;
    return `${base}-${sequence}`;
}

// Only the record ID and evaluation time are prefilled. Lots, AOI counts and recurrence are derived by the server.
function renderEffectivenessEvaluate(detail) {
    const cycle = activeIncidentCycle(detail);
    if (!cycle || !monitoringStates.includes(detail.incident.state)) return '';
    const actor = state.bootstrap.actors.find(item => item.id === state.actorId);
    const blockReason = !actor ? '현재 역할을 선택하세요.' :
        effectivenessRoles.includes(actor.role) ? null : '품질 또는 검증 담당 역할만 효과성을 평가할 수 있습니다.';
    const { card, gateState } = renderNextStepCard('effectiveness', {
        label: '효과성 평가', role: '품질 또는 검증 엔지니어'
    }, blockReason);
    const postClose = detail.incident.state === 'Closed'
        ? '종결 후 확인 결과도 이전 종결 이력을 변경하지 않습니다.' : '';
    return `<div class="effectiveness-action" aria-labelledby="effectiveness-evaluate-title"><h4 id="effectiveness-evaluate-title">효과성 평가</h4>${card}
        <form id="effectiveness-evaluate-form" class="form-grid capa-form" data-effectiveness-form="evaluate"><p>평가 시각까지 연결된 LOT과 AOI 근거로 판정합니다. ${text(postClose)}</p>
        <label>확인 ID<input name="id" required maxlength="80" pattern="[A-Z](?:[A-Z0-9]|-){2,79}" autocomplete="off" spellcheck="false" class="mono" value="${text(nextEffectivenessCheckId(detail, cycle))}"></label>
        <label>평가 시각 (UTC)<input name="at" required maxlength="24" autocomplete="off" spellcheck="false" class="mono" placeholder="2026-10-06T10:00:00.000Z" value="${text(laterUtc(detail.incident.updated_at))}"></label>
        <button type="button" class="button primary" data-effectiveness-submit="evaluate" ${gateState}>근거 평가 →</button></form></div>`;
}

function effectivenessMessage(result) {
    const summary = `후속 LOT ${number(result.lotCount)}건 · AOI 검사 ${number(result.inspectedUnits)}건 · 불합격 ${number(result.rejectedUnits)}건 · 대상 결함 재발 ${number(result.recurrenceCount)}건`;
    if (result.passed) return `효과성 확인이 합격으로 기록되었습니다. ${summary}`;
    return `효과성 확인이 불합격으로 기록되었습니다. ${summary}. 판정 근거는 이력을 확인하세요.`;
}

async function runEffectivenessEvaluation(button) {
    if (state.busy) return;
    const detail = state.incidentDetail;
    const form = document.getElementById('effectiveness-evaluate-form');
    const cycle = detail ? activeIncidentCycle(detail) : null;
    if (!detail || !form || !cycle || !monitoringStates.includes(detail.incident.state)) {
        throw new Error('Effectiveness evaluation is not available in the current incident state');
    }
    if (!actorHasRole(effectivenessRoles)) throw new Error('Select a Quality Engineer or Verification Engineer');
    const values = new FormData(form);
    const id = String(values.get('id') ?? '').trim();
    const at = String(values.get('at') ?? '').trim();
    if (!id || !at) throw new Error('Enter a check ID and a canonical UTC evaluation time');
    assertStableId(id, 'Check ID');
    await submitEffectivenessAction(button, 'evaluateIncidentEffectiveness', {
        incidentId: detail.incident.id, expectedRevisionNo: detail.revisions.at(-1)?.revision_no,
        cycleId: cycle.id, id, actorId: state.actorId, at }, effectivenessMessage);
}

// Shared write discipline for Phase 5 actions: one request at a time, then refresh from persisted records.
async function submitEffectivenessAction(button, action, input, message) {
    const originNo = state.navigationRequestNo;
    state.busy = true;
    actorSelect.disabled = true;
    button?.setAttribute('aria-disabled', 'true');
    button?.setAttribute('aria-busy', 'true');
    try {
        const outcome = await commitAndRefresh(sendAction(action, input), originNo);
        if (outcome.refreshed) showToast(message(outcome.body.result));
    } finally {
        state.busy = false;
        actorSelect.disabled = false;
        // A successful refresh replaces the button; restore it only if it is still on screen.
        if (button?.isConnected) {
            button.removeAttribute('aria-disabled');
            button.removeAttribute('aria-busy');
        }
    }
}

const closureRoles = Object.freeze(['Approver', 'Quality Engineer']);

// Explains why the persona cannot close. Display only; closeIncidentCycle re-checks role, separation and timing.
function closeBlockReason(detail, checks) {
    const actor = state.bootstrap.actors.find(item => item.id === state.actorId);
    if (!actor) return '현재 역할을 선택하세요.';
    if (!closureRoles.includes(actor.role)) {
        return '별도 승인자 또는 품질 엔지니어만 사이클을 종결할 수 있습니다.';
    }
    if (actor.id === detail.incident.proposer_actor_id) {
        return '사건 요청자는 자신의 사이클 종결을 승인할 수 없습니다.';
    }
    if (!checks.length) {
        return '현재 사이클에 합격한 효과성 확인이 필요합니다.';
    }
    if (checks.every(item => item.evaluated_by === actor.id)) {
        return '효과성 평가자와 다른 승인자가 종결해야 합니다.';
    }
    return null;
}

function renderEffectivenessClose(detail) {
    const cycle = activeIncidentCycle(detail);
    if (!cycle || detail.incident.state !== 'Effectiveness Check') return '';
    const checks = detail.effectivenessChecks.filter(item => item.cycle_id === cycle.id && item.passed);
    const blockReason = closeBlockReason(detail, checks);
    const { card, gateState } = renderNextStepCard('close', {
        label: '사이클 종결', role: '별도 승인자 또는 품질 엔지니어'
    }, blockReason);
    const checkOptions = checks.map(item => `<option value="${text(item.id)}">${text(item.id)} · LOT ${text(number(item.lot_count))}건 · ${dateText(item.evaluated_at)}</option>`).join('');
    return `<div class="effectiveness-action" aria-labelledby="effectiveness-close-title"><h4 id="effectiveness-close-title">사이클 종결</h4>${card}
        <form id="effectiveness-close-form" class="form-grid capa-form" data-effectiveness-form="close"><p>합격한 효과성 확인을 선택해 종결 이유를 기록합니다.</p>
        <label>종결 결정 ID<input name="id" required maxlength="80" pattern="[A-Z](?:[A-Z0-9]|-){2,79}" autocomplete="off" spellcheck="false" class="mono" value="${text(nextCycleDecisionId(detail, cycle, 'CLOSE'))}"></label>
        <label>종결 시각 (UTC)<input name="at" required maxlength="24" autocomplete="off" spellcheck="false" class="mono" placeholder="2026-09-21T11:00:00.000Z" value="${text(laterUtc(detail.incident.updated_at))}"></label>
        <label class="span-all">합격한 효과성 확인<select name="checkId" required><option value="" selected>선택하세요</option>${checkOptions}</select></label>
        <label class="span-all">종결 이유<textarea name="reason" required maxlength="500" placeholder="합격 근거와 종결 판단을 적으세요"></textarea></label>
        <button type="button" class="button primary" data-effectiveness-submit="close" ${gateState}>사이클 종결 →</button></form></div>`;
}

async function runEffectivenessClose(button) {
    if (state.busy) return;
    const detail = state.incidentDetail;
    const form = document.getElementById('effectiveness-close-form');
    const cycle = detail ? activeIncidentCycle(detail) : null;
    if (!form || !cycle || detail.incident.state !== 'Effectiveness Check') {
        throw new Error('Closure is available only in Effectiveness Check with a current cycle');
    }
    const checks = detail.effectivenessChecks.filter(item => item.cycle_id === cycle.id && item.passed);
    const blocked = closeBlockReason(detail, checks);
    if (blocked) throw new Error(blocked);
    const values = new FormData(form);
    const value = name => String(values.get(name) ?? '').trim();
    const input = { incidentId: detail.incident.id, expectedRevisionNo: detail.revisions.at(-1)?.revision_no,
        cycleId: cycle.id, id: value('id'), checkId: value('checkId'), actorId: state.actorId,
        reason: value('reason'), at: value('at') };
    if (['id', 'checkId', 'reason', 'at'].some(key => !input[key])) {
        throw new Error('Choose the passing check and enter a decision ID, reason and time');
    }
    assertStableId(input.id, 'Closure decision ID');
    const check = checks.find(item => item.id === input.checkId);
    if (!check) throw new Error('Choose a passing check from the current cycle');
    if (check.evaluated_by === state.actorId) {
        throw new Error(`${state.actorId} evaluated ${check.id} and cannot also approve closure`);
    }
    await submitEffectivenessAction(button, 'closeIncidentCycle', input, result =>
        '합격 확인을 근거로 사이클이 종결되었습니다. 이전 확인 기록은 보존됩니다.');
}

// A reopen needs the Closed current cycle, a later failed check with recurrence, and linked same-code AOI source.
function reopenContext(detail) {
    if (detail.incident.state !== 'Closed') return null;
    const cycle = activeIncidentCycle(detail);
    const close = cycle ? detail.cycleDecisions.find(item => item.cycle_id === cycle.id && item.decision === 'Closed') : null;
    if (!close) return null;
    const checks = detail.effectivenessChecks.filter(item => item.cycle_id === cycle.id && !item.passed &&
        item.evaluated_at > close.decided_at && Number(item.recurrence_count) >= 1);
    if (!checks.length) return null;
    const evidence = (detail.recurrenceEvidence ?? []).filter(item => item.cycle_id === cycle.id &&
        item.prior_close_id === close.id);
    return { cycle, close, checks, evidence };
}

function nextReopenDecisionId(detail, cycle) {
    return nextCycleDecisionId(detail, cycle, 'REOPEN');
}

function nextCycleDecisionId(detail, cycle, prefix) {
    const used = new Set(detail.cycleDecisions.map(item => item.id));
    const base = `${prefix}-${detail.incident.id}-C${cycle.cycle_no}`.slice(0, 72);
    if (!used.has(base)) return base;
    let sequence = 2;
    while (used.has(`${base}-${sequence}`)) sequence++;
    return `${base}-${sequence}`;
}

function renderEffectivenessReopen(detail) {
    const context = reopenContext(detail);
    if (!context) return '';
    const { cycle, close, checks, evidence } = context;
    const latestWindowEnd = checks.map(item => item.evaluated_at).sort().at(-1);
    const usable = evidence.filter(item => item.inspected_at <= latestWindowEnd);
    const actor = state.bootstrap.actors.find(item => item.id === state.actorId);
    const blockReason = !actor ? '현재 역할을 선택하세요.' :
        actor.role !== 'Quality Engineer' ? '품질 엔지니어만 종결된 사이클을 재개할 수 있습니다.' :
            !usable.length ? '불합격 확인 구간 안에 연결된 동일 결함 AOI 재발 근거가 없습니다.' : null;
    const { card, gateState } = renderNextStepCard('reopen', {
        label: '사이클 재개', role: '품질 엔지니어'
    }, blockReason);
    const checkOptions = checks.map(item => `<option value="${text(item.id)}" data-window-end="${text(item.evaluated_at)}">${text(item.id)} · 재발 ${text(number(item.recurrence_count))}건 · ${dateText(item.evaluated_at)}</option>`).join('');
    const evidenceOptions = evidence.map(item => `<option value="${text(item.defect_id)}" data-inspected-at="${text(item.inspected_at)}">${text(item.defect_id)} · ${text(item.lot_id)} · ${dateText(item.inspected_at)} · ${text(number(item.defect_count))}건</option>`).join('');
    return `<div class="effectiveness-action" aria-labelledby="effectiveness-reopen-title"><h4 id="effectiveness-reopen-title">사이클 재개</h4>${card}
        <form id="effectiveness-reopen-form" class="form-grid capa-form" data-effectiveness-form="reopen"><p>종결 후 불합격 확인과 동일 결함의 AOI 재발 근거를 선택하세요. 이전 종결과 확인 기록은 보존됩니다.</p>
        <label>재개 결정 ID<input name="id" required maxlength="80" pattern="[A-Z](?:[A-Z0-9]|-){2,79}" autocomplete="off" spellcheck="false" class="mono" value="${text(nextReopenDecisionId(detail, cycle))}"></label>
        <label>재개 시각 (UTC)<input name="at" required maxlength="24" autocomplete="off" spellcheck="false" class="mono" placeholder="2026-10-06T11:00:00.000Z" value="${text(laterUtc(detail.incident.updated_at))}"></label>
        <label>종결 후 불합격 확인<select name="checkId" required><option value="" selected>선택하세요</option>${checkOptions}</select></label>
        <label>동일 결함 AOI 재발 근거<select name="recurrenceAoiDefectId" required><option value="" selected>선택하세요</option>${evidenceOptions}</select></label>
        <label class="span-all">재개 이유<textarea name="reason" required maxlength="500" placeholder="재발 근거와 재개 판단을 적으세요"></textarea></label>
        <button type="button" class="button primary" data-effectiveness-submit="reopen" ${gateState}>사이클 재개 →</button></form></div>`;
}

// Limits recurrence choices to AOI defects inspected inside the chosen check window.
function syncReopenEvidence(form) {
    const windowEnd = form.elements.checkId?.selectedOptions[0]?.dataset.windowEnd ?? '';
    const select = form.elements.recurrenceAoiDefectId;
    if (!select) return;
    for (const option of select.options) {
        if (!option.value) continue;
        const outside = Boolean(windowEnd) && option.dataset.inspectedAt > windowEnd;
        option.disabled = outside;
        option.hidden = outside;
    }
    if (select.selectedOptions[0]?.disabled) select.value = '';
}

async function runEffectivenessReopen(button) {
    if (state.busy) return;
    const detail = state.incidentDetail;
    const form = document.getElementById('effectiveness-reopen-form');
    const context = detail ? reopenContext(detail) : null;
    if (!form || !context) throw new Error('Reopen needs a Closed cycle with a later failed recurrence check');
    if (!actorHasRole(['Quality Engineer'])) throw new Error('Select a Quality Engineer to reopen the cycle');
    const values = new FormData(form);
    const value = name => String(values.get(name) ?? '').trim();
    const input = { incidentId: detail.incident.id, expectedRevisionNo: detail.revisions.at(-1)?.revision_no,
        cycleId: context.cycle.id, id: value('id'), checkId: value('checkId'),
        recurrenceAoiDefectId: value('recurrenceAoiDefectId'), actorId: state.actorId,
        reason: value('reason'), at: value('at') };
    if (['id', 'checkId', 'recurrenceAoiDefectId', 'reason', 'at'].some(key => !input[key])) {
        throw new Error('Choose the failed check and recurrence source, and enter a decision ID, reason and time');
    }
    assertStableId(input.id, 'Reopen decision ID');
    const check = context.checks.find(item => item.id === input.checkId);
    const source = context.evidence.find(item => item.defect_id === input.recurrenceAoiDefectId);
    if (!check || !source || source.inspected_at > check.evaluated_at) {
        throw new Error('The recurrence source must fall inside the chosen check window');
    }
    await submitEffectivenessAction(button, 'reopenIncidentCycle', input, result =>
        `Cycle ${result.priorCycleId} reopened by ${result.decisionId} from recurrence ${result.recurrenceAoiDefectId}. Earlier closures and checks are unchanged; starting cycle ${result.nextCycleNo} is a separate CAPA decision.`);
}

function renderIncidentTable(incidents) {
    if (!incidents.length) return empty('사건 기록이 없습니다', '결함 신호가 있으면 FabTrace에서 사건을 등록하세요.');
    return `<div class="table-wrap"><table><thead><tr><th>기록</th><th>사건</th><th>설비 / 모듈</th><th>상태</th><th>발견 시각 (UTC)</th></tr></thead><tbody>${incidents.map(item => `<tr><td><button type="button" class="table-button" data-open-incident="${text(item.id)}">상세 보기</button><details><summary>기록 ID</summary><span class="mono">${text(item.id)}</span></details></td><td>${text(item.title)}<br><span class="muted mono">${text(item.defect_code_id)}</span></td><td class="mono">${text(item.equipment_id)} / ${text(item.module_id)}</td><td>${chip(item.state)}</td><td class="nowrap muted">${dateText(item.detected_at)}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderIncidentGate(next, eligible, detail) {
    if (!next) return '<div class="hint-box">범위 검토가 기록되었습니다. 이후 CAPA와 효과성 확인을 진행하세요.</div>';
    const review = next.action === 'reviewIncidentScope';
    const lotChoices = review ? `<div id="incident-lot-decisions" class="form-grid top-gap"><p>각 후보 LOT의 범위와 봉쇄 조치, 이유를 기록하세요. 제외 LOT은 제외 상태로 유지됩니다.</p>${detail.candidates.map(candidate => {
        const excluded = candidate.classification === 'excluded';
        return `<div class="card form-grid lot-decision" data-lot-id="${text(candidate.lot_id)}"><h4>${text(candidate.lot_id)} · ${text(labelFor(labels.states, candidate.classification) ?? candidate.classification)}</h4><p>${text(candidate.reason)}</p><label>범위 판정<select class="lot-scope-status" required>${excluded ? '<option value="excluded">원천 구간에서 제외</option>' : `<option value="" selected>선택하세요</option><option value="${candidate.classification === 'ambiguous' ? 'ambiguous' : 'included'}">${candidate.classification === 'ambiguous' ? '불확실' : '포함'}</option><option value="${candidate.classification === 'ambiguous' ? 'included' : 'ambiguous'}">${candidate.classification === 'ambiguous' ? '포함' : '불확실'}</option>`}</select></label><label>봉쇄 조치<select class="lot-containment" required>${excluded ? '<option value="No Change">변경 없음</option>' : '<option value="" selected>선택하세요</option><option value="Held">보류</option><option value="Additional Inspection">추가 검사</option>'}</select></label><label>LOT 판정 이유<textarea class="lot-decision-reason" maxlength="500" placeholder="원천 구간과 AOI 근거를 설명하세요"></textarea></label></div>`;
    }).join('')}</div>` : '';
    const blockReason = eligible ? null : incidentBlockReason(next, detail);
    const { card, gateState } = renderNextStepCard('incident', next, blockReason);
    return `${card}${review ? '<label class="gate-reason">범위 검토 결정<select id="incident-review-decision" required><option value="" selected>선택하세요</option><option value="Pass">합격 · LOT별 결정 기록</option><option value="Needs Rework">재작업 필요 · 추적 범위 수정</option></select></label>' : ''}${next.needsReason ? `<label class="gate-reason">${review ? '검토' : next.action === 'reviseIncidentTrace' ? '개정' : '봉쇄'} 이유<textarea id="incident-gate-reason" required maxlength="500" placeholder="판단 이유를 입력하세요"></textarea></label>` : ''}${lotChoices}<button type="button" class="button primary top-gap" data-action="incident-gate" ${gateState}>${text(actionLabel(next))} →</button>`;
}

function renderIncidentDetail() {
    const detail = state.incidentDetail;
    if (!detail) return empty('선택한 사건이 없습니다', '사건 목록에서 기록을 열어 주세요.');
    const incident = detail.incident;
    const next = incidentGate(detail);
    const eligible = incidentActorEligible(next, detail);
    const window = detail.proposal?.result?.window;
    return `<div class="page-heading"><div><p class="eyebrow">FabTrace</p><h1>영향 추적 상세</h1><p>결함 신호, 영향 LOT, 봉쇄와 독립 검토 결정을 확인합니다.</p></div><div class="heading-actions"><button type="button" class="button" data-view="fabtrace">← 사건 목록</button></div></div>
        <div class="record-header"><div><h2>${text(incident.title)}</h2><p>관측 LOT ${text(detail.observedLotId ?? '—')} · 레시피 ${text(detail.recipeRevisionId ?? '—')}</p><details><summary>기술 정보</summary><span class="mono muted">${text(incident.id)} · ${text(incident.defect_code_id)}</span></details></div><div class="record-meta">${chip(incident.state)}<span class="small-chip">${text(incident.equipment_id)}</span><span class="small-chip">${text(incident.module_id)}</span></div></div>
        <div class="panel-grid top-gap"><div class="stack"><section class="detail-section"><h3>발견·봉쇄·마지막 정상 관측(LKG)</h3><div class="field-grid">${row('발견 시각 (UTC)', dateText(incident.detected_at))}${row('봉쇄 LOT', detail.containment.at(-1)?.heldLotIds?.join(', ') ?? '봉쇄 전')}${row('봉쇄 담당자', detail.containment.at(-1)?.ownerActorId ?? '대기 중')}${row('봉쇄 이유', detail.containment.at(-1)?.reason ?? '대기 중')}${row('가능한 LKG 시작', dateText(detail.lkg?.earliest_possible_at))}${row('가능한 LKG 끝', dateText(detail.lkg?.latest_possible_at))}</div><details><summary>기술 정보</summary>${row('발견 이벤트', detail.detectionEvent?.id ?? '없음')}${row('LKG AOI 관측', detail.lkg?.aoi_inspection_id ?? '없음')}</details>${detail.lkg ? `<div class="warning-box top-gap"><strong>관측 한계:</strong> ${text(detail.lkg.limitation)}</div>` : ''}</section>
        <section class="detail-section"><h3>노출 구간과 영향 LOT</h3>${window ? `<p class="muted">${dateText(window.startAt)} → ${dateText(window.endAt)} · [시작, 끝) · ${window.unknownStart ? 'LKG 시작 불명' : `${dateText(window.uncertainUntilAt)}까지 불확실`}</p>` : '<p class="muted">LKG를 기록한 뒤 영향 범위를 제안할 수 있습니다.</p>'}
        ${detail.candidates.length ? `<div class="table-wrap"><table><thead><tr><th>LOT</th><th>출처 분류</th><th>대상 AOI</th><th>확정 구간 AOI</th><th>처분</th><th>출처 이유</th><th>검토 이유</th></tr></thead><tbody>${detail.candidates.map(item => {
            const decision = detail.scopeDecisions.find(entry => entry.lot_id === item.lot_id);
            return `<tr><td class="mono">${text(item.lot_id)}</td><td>${chip(item.classification)}</td><td>${number(item.targeted_defects)}</td><td>${number(item.certain_interval_defects)}</td><td>${text(decision ? `${decision.scope_status} · ${decision.containment}` : 'Pending independent review')}</td><td>${text(item.reason)}</td><td>${text(decision?.reason ?? 'Pending')}</td></tr>`;
        }).join('')}</tbody></table></div>` : empty('영향 LOT 없음', '출처 추적 후 제외·불확실·포함 LOT과 이유가 표시됩니다.')}</section></div>
        <div class="stack"><section class="detail-section"><h3>현재 단계</h3><div class="field-grid">${row('상태', labelFor(labels.states, incident.state) ?? incident.state)}${row('범위 검토', detail.scopeReview?.decision ?? '대기 중')}${row('검토 이유', detail.scopeReview?.reason ?? '대기 중')}</div><details><summary>기술 정보</summary>${row('추적 요청자', detail.proposal?.proposer_actor_id ?? '없음')}${row('범위 검토자', detail.scopeReview?.reviewer_actor_id ?? '없음')}</details><hr class="divider">${renderIncidentGate(next, eligible, detail)}</section>
        ${detail.traceProposals.length ? `<section class="detail-section"><h3>추적 개정 이력</h3>${detail.traceProposals.map(proposal => `<div class="hint-box top-gap"><p>개정 이유: ${text(detail.revisions.find(item => item.id === proposal.incident_revision_id)?.reason ?? '없음')}</p><p>검토 결과: ${text(proposal.scopeReview?.decision ?? '대기 중')} · 이유: ${text(proposal.scopeReview?.reason ?? '대기 중')}</p><details><summary>기술 정보</summary><span class="mono">${text(proposal.incident_revision_id)} · ${text(proposal.id)} · ${text(proposal.resultDigest)}</span></details></div>`).join('')}</section>` : ''}
        <section class="detail-section"><h3>감사 이력</h3><p>결정의 역할·시각과 상세 근거를 확인할 수 있습니다.</p>${renderAudit(detail.audit)}</section></div></div>${renderCapaWorkflow(detail)}${renderEffectivenessHistory(detail)}`;
}

function renderFabTrace() {
    if (state.incidentId) return renderIncidentDetail();
    const actor = state.bootstrap.actors.find(item => item.id === state.actorId);
    const mayOpen = ['Quality Engineer', 'Production Manager'].includes(actor?.role);
    return `<div class="page-heading"><div><p class="eyebrow">영향 추적</p><h1>FabTrace</h1><p>결함 신호를 설비·레시피 이력, 영향 LOT과 봉쇄 결정에 연결합니다.</p></div></div>
        <div class="panel-grid"><div class="stack"><div class="section-head no-top-margin"><div><h2>사건 목록</h2><p>${number(state.bootstrap.incidents.length)}건</p></div></div>${renderIncidentTable(state.bootstrap.incidents)}</div>
        <aside class="card"><div class="card-kicker">새 사건</div><h2>정비 후 이상 등록</h2><p>결함 발견 후 영향을 추적합니다.</p><form id="create-incident-form" class="form-grid"><label>제목<input name="title" required maxlength="120" value="모듈 정비 후 정렬 결함 증가"></label><details><summary>연결된 근거</summary><div class="hint-box">EV-DETECTION · LOT-A-026 · REC-ALIGN-R3 · 2026-08-27 10:00 UTC</div></details>${mayOpen ? '' : '<div class="warning-box">품질 엔지니어 또는 생산 관리자 역할을 선택하세요.</div>'}<button type="submit" class="button primary" ${mayOpen ? '' : 'disabled'}>사건 등록 →</button></form></aside></div>`;
}

function renderDemoInfo() {
    return `<div class="page-heading"><div><p class="eyebrow">FabAssure</p><h1>데모 정보</h1><p>이 작업 공간의 데이터와 실행 범위를 확인하세요.</p></div></div>
        <div class="card"><div class="field-grid">
            ${row('데이터', '모든 회사·설비·LOT·측정값은 샘플 데이터입니다.')}
            ${row('연동', '실제 MES 또는 설비와 연결되지 않습니다.')}
            ${row('실행', '이 PC의 로컬 주소에서만 실행됩니다.')}
            ${row('역할', '역할 전환은 모의 사용자를 이용하며 실제 신원 인증이 아닙니다.')}
        </div></div>`;
}

function renderEquipment() {
    const detail = state.equipmentDetail;
    if (!detail) return empty('설비를 선택하세요', '설비를 선택하면 이력과 검사 결과를 볼 수 있습니다.');
    const { equipment, observationWindow, reliability, timeline, recentRuns, aoi,
        aoiInspections, aoiCohort } = detail;
    const choices = state.equipmentList.equipment.map(item => `<button type="button"
        class="button ${item.id === equipment.id ? 'dark' : ''}"
        data-open-equipment="${text(item.id)}">${text(item.code)} · ${text(item.lineId)}</button>`).join('');
    const eventRows = timeline.map(item => `<tr><td class="nowrap">${dateText(item.at)}</td>
        <td><span class="mono">${text(item.id)}</span><br><span class="muted">${text(item.kind)}</span></td>
        <td>${text(item.kind === 'maintenance-action' ? item.code : item.eventType)}</td>
        <td class="mono">${text(item.moduleId)}</td>
        <td>${item.kind === 'maintenance-action' ? `${dateText(item.startAt)} → ${dateText(item.endAt)}` :
            item.durationSeconds == null ? '—' : `${number(item.durationSeconds / 3600)} h`}</td>
        <td>${text(item.summary ?? '—')}</td></tr>`).join('');
    const runRows = recentRuns.map(item => `<tr><td class="mono">${text(item.id)}</td>
        <td class="mono">${text(item.lotId)}</td><td class="mono">${text(item.moduleId)}</td>
        <td class="mono">${text(item.recipeRevisionId)}</td><td>${dateText(item.startAt)}</td>
        <td>${number(item.processedUnits)}</td></tr>`).join('');
    const aoiRows = aoiInspections.map(item => `<tr><td class="mono">${text(item.id)}</td>
        <td class="mono">${text(item.lotId)}</td><td class="mono">${text(item.processRunId)}</td>
        <td>${dateText(item.inspectedAt)}</td><td>${number(item.inspectedUnits)}</td>
        <td>${number(item.rejectedUnits)}</td><td>${item.defects.map(defect =>
            `${text(defect.id)} · ${text(defect.defectCodeId)}: ${number(defect.defectCount)}`).join(', ') || '—'}</td></tr>`).join('');
    const rate = aoi.inspectedUnits ? aoi.rejectedUnits / aoi.inspectedUnits : null;
    return `<div class="page-heading"><div><p class="eyebrow">설비 신뢰성</p>
        <h1>설비 이력</h1><p>설비 이벤트, 수리, 레시피와 공정 기록을 같은 관측 구간에서 확인합니다.</p></div></div>
        <div class="heading-actions">${choices}</div>
        <div class="record-header top-gap"><div><h2>${text(equipment.name)}</h2><p>모듈 ${equipment.modules.map(item => text(item.id)).join(', ')}</p><details><summary>기술 정보</summary><span class="mono muted">${text(equipment.id)} · ${text(equipment.lineId)}</span></details></div>
        <div class="record-meta"><span class="small-chip">조회 전용</span></div></div>
        <div class="stat-grid"><div class="stat-card teal"><span class="label">관측 구간</span>
        <strong class="value">${number(observationWindow.hours)} <small>h</small></strong>
        <span class="foot">${dateText(observationWindow.startAt)} → ${dateText(observationWindow.endExclusiveAt)} (끝 제외)</span></div>
        <div class="stat-card emphasis"><span class="label">고장 / 수리 시간</span>
        <strong class="value">${number(reliability.failureCount)} / ${number(reliability.downtimeHours)} <small>h</small></strong>
        <span class="foot">연결된 고장·수리 기록</span></div>
        <div class="stat-card muted"><span class="label">MTBF</span><strong class="value">${number(reliability.mtbfHours)} <small>h</small></strong>
        <span class="foot">(관측 시간 − 수리 시간) / 고장 건수</span></div>
        <div class="stat-card muted"><span class="label">MTTR</span><strong class="value">${number(reliability.mttrHours)} <small>h</small></strong>
        <span class="foot">수리 시간 / 고장 건수</span></div></div>
        ${reliability.notCalculatedReason ? `<div class="warning-box top-gap">${text(reliability.notCalculatedReason)}.
        <details><summary>경계 수리 기록</summary>${reliability.boundaryRepairActionIds.map(text).join(', ')}</details></div>` :
            reliability.failureCount ? '' : '<div class="hint-box top-gap">이 구간에 고장 기록이 없어 MTBF와 MTTR을 계산하지 않습니다.</div>'}
        <div class="card top-gap"><h2>설비·정비·AOI 이력</h2>
        <p>레시피 변경과 고장·수리 기록, AOI 결함 발생 시각을 함께 확인합니다.</p>
        <div class="table-wrap"><table><thead><tr><th>시각 (UTC)</th><th>원천</th><th>유형 / 코드</th><th>모듈</th><th>지속 시간 / 구간</th><th>기록 요약</th></tr></thead>
        <tbody>${eventRows || '<tr><td colspan="6">해당 구간에 이벤트가 없습니다.</td></tr>'}</tbody></table></div></div>
        <div class="card top-gap"><h2>공정·AOI 결과</h2><p>공정 실행 ${number(detail.processRunCount)}건 · AOI 검사 ${number(aoi.inspectionCount)}건 · 검사 ${number(aoi.inspectedUnits)}개 · 불량 ${number(aoi.rejectedUnits)}개 (${percent(rate)}). ${text(aoiCohort)}.</p>
        <div class="table-wrap"><table><thead><tr><th>실행</th><th>LOT</th><th>모듈</th><th>레시피</th><th>시작 (UTC)</th><th>처리 수량</th></tr></thead>
        <tbody>${runRows || '<tr><td colspan="6">해당 구간에 공정 실행이 없습니다.</td></tr>'}</tbody></table></div>
        <h3 class="top-gap">AOI 검사 기록</h3><div class="table-wrap"><table><thead><tr>
        <th>검사</th><th>LOT</th><th>실행</th><th>시각 (UTC)</th><th>검사 수량</th><th>불량 수량</th><th>결함 코드: 건수</th></tr></thead>
        <tbody>${aoiRows || '<tr><td colspan="7">해당 구간에 AOI 검사가 없습니다.</td></tr>'}</tbody></table></div></div>`;
}

function render() {
    const viewKey = state.view === 'changes' && state.changeId ? 'changeDetail' : state.view;
    const viewName = labelFor(labels.views, viewKey) || labels.views.overview;
    crumb.textContent = viewName;
    document.querySelectorAll('[data-view].nav-link').forEach(button => {
        const active = button.dataset.view === state.view;
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    });
    if (!state.bootstrap) return;
    if (state.view === 'overview') view.innerHTML = renderOverview();
    else if (state.view === 'changes') view.innerHTML = state.changeId ? renderChangeDetail() : renderChanges();
    else if (state.view === 'review') {
        const pending = state.bootstrap.changes.filter(change => ['Evidence Ready', 'Independent Review'].includes(change.state));
        view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">독립 결정</p><h1>검토 대기열</h1><p>증거가 준비된 변경을 확인하고 독립 검토와 수락을 기록합니다.</p></div></div>${renderChangeTable(pending)}`;
    } else if (state.view === 'audit') view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">결정 이력</p><h1>감사 기록</h1><p>변경 상세에서 결정 순서와 역할·시각을 확인할 수 있습니다.</p></div></div>${state.detail ? `<div class="card">${renderAudit(state.detail.audit)}</div>` : empty('선택한 변경이 없습니다', '변경 목록에서 기록을 연 뒤 감사 이력을 확인하세요.')}`;
    else if (state.view === 'evidence') view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">원천에서 결정까지</p><h1>연결된 근거</h1><p>근거는 원천 기록, 검증 기준과 개정에 연결됩니다.</p></div></div>${state.detail ? `<div class="card"><h2>${text(state.detail.change.title)}</h2>${state.detail.revisions.map(item => `<h3>개정 R${number(item.revision.revision_no)}</h3>${renderEvidence(item)}`).join('')}</div>` : empty('선택한 변경이 없습니다', '변경 목록에서 기록을 열어 연결된 근거를 확인하세요.')}`;
    else if (state.view === 'equipment') view.innerHTML = renderEquipment();
    else if (state.view === 'fabtrace') view.innerHTML = renderFabTrace();
    else if (state.view === 'documents') view.innerHTML = renderModule('관리 문서', '검토된 CAPA 조치는 문서 피드백과 개정에 연결됩니다.', 'FabTrace의 CAPA 이력에서 PFMEA 등 관리 문서의 검토·승인 기록을 확인할 수 있습니다.');
    else if (state.view === 'demoInfo') view.innerHTML = renderDemoInfo();
    if (state.announcedView !== viewName) {
        state.announcedView = viewName;
        announce(`${viewName} 화면`);
    }
}

async function openChange(id) {
    const requestNo = ++state.navigationRequestNo;
    state.pendingNavigationNo = requestNo;
    try {
        let detail;
        try { detail = await request(`/api/changes/${encodeURIComponent(id)}`); }
        catch (error) {
            if (requestNo !== state.navigationRequestNo) return false;
            throw error;
        }
        if (requestNo !== state.navigationRequestNo) return false;
        state.detail = detail;
        state.changeId = id;
        state.view = 'changes';
        render();
        view.focus();
        return true;
    } finally { settleNavigation(requestNo); }
}

async function openIncident(id) {
    const requestNo = ++state.navigationRequestNo;
    state.pendingNavigationNo = requestNo;
    try {
        let incidentDetail;
        try { incidentDetail = await request(`/api/incidents/${encodeURIComponent(id)}`); }
        catch (error) {
            if (requestNo !== state.navigationRequestNo) return false;
            throw error;
        }
        if (requestNo !== state.navigationRequestNo) return false;
        state.incidentDetail = incidentDetail;
        state.incidentId = id;
        state.view = 'fabtrace';
        render();
        view.focus();
        return true;
    } finally { settleNavigation(requestNo); }
}

async function loadEquipment(id, requestNo) {
    state.pendingNavigationNo = requestNo;
    try {
        let equipmentList;
        try { equipmentList = await request('/api/equipment'); }
        catch (error) {
            if (requestNo !== state.navigationRequestNo) return false;
            throw error;
        }
        if (requestNo !== state.navigationRequestNo) return false;
        const selectedId = id ?? state.equipmentId ?? equipmentList.equipment[0]?.id;
        if (!selectedId) throw new Error('선택할 수 있는 설비가 없습니다.');
        let equipmentDetail;
        try { equipmentDetail = await request(`/api/equipment/${encodeURIComponent(selectedId)}`); }
        catch (error) {
            if (requestNo !== state.navigationRequestNo) return false;
            throw error;
        }
        if (requestNo !== state.navigationRequestNo) return false;
        state.equipmentList = equipmentList;
        state.equipmentDetail = equipmentDetail;
        state.equipmentId = selectedId;
        state.view = 'equipment';
        render();
        view.focus();
        return true;
    } finally { settleNavigation(requestNo); }
}

async function openEquipment(id = null) {
    if (!state.bootstrap) await startupPromise;
    if (!state.bootstrap) return false;
    return loadEquipment(id, ++state.navigationRequestNo);
}

async function sendAction(action, input) {
    state.bootstrapDirty = true;
    const body = await request('/api/actions', { method: 'POST', headers: {
        'content-type': 'application/json', 'x-fabassure-local': '1'
    }, body: JSON.stringify({ action, input }) });
    state.sourceWriteNo++;
    return body;
}

async function linkPassingSourceSet(next, originNo) {
    const change = state.detail.change;
    const revision = state.detail.revisions.at(-1);
    const id = change.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 55);
    const prefix = `EVID-${id}-R${change.current_revision_no}`;
    const recorded = new Set(revision.evidence.map(item => item.id));
    let added = 0;
    try {
        for (let day = 8; day <= 12; day++) {
            const daySuffix = String(day).padStart(3, '0');
            for (let unit = 1; unit <= 20; unit++) {
                if (originNo !== state.navigationRequestNo) return { added, refreshed: false };
                const unitSuffix = String(unit).padStart(2, '0');
                const evidenceId = `${prefix}-${daySuffix}-${unitSuffix}`;
                if (recorded.has(evidenceId)) continue;
                await sendAction('addMeasurementEvidence', { ...next.input, evidenceId,
                    measurementId: `MEAS-A-${daySuffix}-${unitSuffix}`,
                    at: `2026-08-${String(day).padStart(2, '0')}T10:01:00.000Z` });
                added++;
                if (originNo !== state.navigationRequestNo) return { added, refreshed: false };
                if (added % 20 === 0) showToast(`${added} source records linked in this run…`);
            }
            const evidenceId = `${prefix}-AOI-${daySuffix}`;
            if (!recorded.has(evidenceId)) {
                if (originNo !== state.navigationRequestNo) return { added, refreshed: false };
                await sendAction('addAoiEvidence', { ...next.input, evidenceId,
                    inspectionId: `AOI-A-${daySuffix}`,
                    at: `2026-08-${String(day).padStart(2, '0')}T10:31:00.000Z` });
                added++;
                if (originNo !== state.navigationRequestNo) return { added, refreshed: false };
            }
        }
    } catch (error) {
        if (originNo !== state.navigationRequestNo) return { added, refreshed: false };
        const refreshed = await refreshIfCurrent(originNo);
        if (!refreshed) return { added, refreshed: false };
        throw error;
    }
    return { added, refreshed: await refreshIfCurrent(originNo) };
}

// Links an explicit list of seeded source records, one server action each. Already linked IDs are skipped, so it resumes.
async function linkSourceSet(next, originNo) {
    const recorded = new Set(state.detail.revisions.at(-1).evidence.map(item => item.id));
    let added = 0;
    try {
        for (const source of next.sources) {
            if (originNo !== state.navigationRequestNo) return { added, refreshed: false };
            if (recorded.has(source.input.evidenceId)) continue;
            await sendAction(source.action, { ...next.input, ...source.input });
            added++;
        }
    } catch (error) {
        if (originNo !== state.navigationRequestNo) return { added, refreshed: false };
        const refreshed = await refreshIfCurrent(originNo);
        if (!refreshed) return { added, refreshed: false };
        throw error;
    }
    return { added, refreshed: await refreshIfCurrent(originNo) };
}

async function runNextGate() {
    if (state.busy) return;
    const next = actionFor(state.detail);
    if (!next) return;
    if (next.blocked) throw new Error(next.blocked);
    if (!actorEligible(next, state.detail)) throw new Error('이 작업을 수행할 수 있는 역할을 선택하세요.');
    const reason = next.needsReason ? document.getElementById('gate-reason')?.value.trim() : null;
    if (next.needsReason && !reason) throw new Error('Enter a decision rationale before proceeding');
    const originNo = state.navigationRequestNo;
    state.busy = true;
    actorSelect.disabled = true;
    try {
        if (next.action === 'linkPassingSourceSet') {
            const result = await linkPassingSourceSet(next, originNo);
            if (result.refreshed) showToast(`${result.added} source observations linked. Review the evidence before evaluating criteria.`);
            return;
        }
        if (next.action === 'linkSourceSet') {
            const result = await linkSourceSet(next, originNo);
            if (result.refreshed) showToast(`${result.added} source records linked. Review the evidence before evaluating criteria.`);
            return;
        }
        const terms = ['acceptChange', 'classifyLegacyAcceptance'].includes(next.action) ? (() => {
            const acceptanceType = document.getElementById('acceptance-type')?.value;
            if (!acceptanceType) throw new Error('일반 또는 조건부 수락을 명시적으로 선택하세요.');
            if (acceptanceType !== 'Conditional') return { acceptanceType: 'Ordinary' };
            const condition = document.getElementById('acceptance-condition')?.value;
            const expiresAt = document.getElementById('acceptance-expiry')?.value.trim();
            if (!condition?.trim() || !expiresAt) {
                throw new Error('조건부 수락에는 정확한 조건과 UTC 만료 시각이 필요합니다.');
            }
            return { acceptanceType, condition, expiresAt };
        })() : {};
        const outcome = await commitAndRefresh(sendAction(next.action,
            { ...next.input, ...(next.needsReason ? { reason } : {}), ...terms }), originNo);
        if (outcome.refreshed) showToast(`${next.label} recorded: ${outcome.body.result.state ?? 'decision saved'}`);
    } finally {
        state.busy = false;
        actorSelect.disabled = false;
    }
}

async function runIncidentGate() {
    if (state.busy) return;
    const next = incidentGate(state.incidentDetail);
    if (!next || !incidentActorEligible(next, state.incidentDetail)) {
        throw new Error('이 작업을 수행할 수 있는 역할을 선택하세요.');
    }
    const reason = next.needsReason ? document.getElementById('incident-gate-reason')?.value.trim() : null;
    if (next.needsReason && !reason) throw new Error('Enter a decision rationale before proceeding');
    let input = next.needsReason ? { ...next.input, reason } : next.input;
    if (next.action === 'reviewIncidentScope') {
        const decision = document.getElementById('incident-review-decision')?.value;
        if (!['Pass', 'Needs Rework'].includes(decision)) throw new Error('Select a scope review decision');
        const lotDecisions = decision === 'Pass' ? [...document.querySelectorAll('.lot-decision')]
            .map(item => ({ lotId: item.dataset.lotId,
                scopeStatus: item.querySelector('.lot-scope-status')?.value,
                containment: item.querySelector('.lot-containment')?.value,
                reason: item.querySelector('.lot-decision-reason')?.value.trim() })) : [];
        if (decision === 'Pass' && (lotDecisions.length !== state.incidentDetail.candidates.length ||
            lotDecisions.some(item => !item.reason))) {
            throw new Error('Record a reason for every candidate lot before passing scope review');
        }
        if (lotDecisions.some(item => !item.scopeStatus || !item.containment)) {
            throw new Error('Choose scope status and containment for every candidate lot');
        }
        input = { ...input, decision, lotDecisions };
    }
    const originNo = state.navigationRequestNo;
    state.busy = true;
    actorSelect.disabled = true;
    try {
        const outcome = await commitAndRefresh(sendAction(next.action, input), originNo);
        if (outcome.refreshed) showToast(`${next.label} recorded: ${outcome.body.result.state ?? 'decision saved'}`);
    } finally {
        state.busy = false;
        actorSelect.disabled = false;
    }
}

async function runCapaDecision(kind) {
    if (state.busy) return;
    const detail = state.incidentDetail;
    const form = document.getElementById(`capa-${kind}-form`);
    if (!detail || !form) throw new Error('CAPA decision form is no longer available');
    const values = new FormData(form);
    const actor = state.bootstrap.actors.find(item => item.id === state.actorId);
    const cycleId = openCapaCycle(detail)?.id ?? null;
    const expectedRevisionNo = detail.revisions.at(-1)?.revision_no;
    const at = kind === 'action-review' && values.get('reviewedAt')
        ? String(values.get('reviewedAt')).trim() : laterUtc(detail.incident.updated_at);
    const common = { incidentId: detail.incident.id, expectedRevisionNo,
        actorId: state.actorId, cycleId, at };
    const value = name => String(values.get(name) ?? '').trim();
    let action;
    let input;
    if (kind === 'start') {
        if (!['Quality Engineer', 'Production Manager'].includes(actor?.role)) throw new Error('CAPA 사이클을 시작할 수 있는 역할을 선택하세요.');
        action = 'startIncidentCapa'; input = { ...common, reason: value('reason') };
    } else if (kind === 'cause') {
        if (!['Quality Engineer', 'Manufacturing Engineer', 'Equipment / Automation Engineer'].includes(actor?.role)) throw new Error('원인을 기록할 수 있는 역할을 선택하세요.');
        action = 'assessIncidentCause'; input = { ...common, id: value('id'), status: value('status'),
            statement: value('statement'), evidenceKind: value('evidenceKind'), evidenceId: value('evidenceId') };
    } else if (kind === 'action') {
        if (!['Quality Engineer', 'Manufacturing Engineer', 'Equipment / Automation Engineer'].includes(actor?.role)) throw new Error('조치를 기록할 수 있는 역할을 선택하세요.');
        const createdAt = at;
        const dueAt = value('dueAt') || laterUtc(createdAt, 86_400);
        action = 'planCapaAction'; input = { ...common, id: value('id'), causeId: value('causeId'),
            ownerActorId: value('ownerActorId'), actionType: value('actionType'),
            actionText: value('actionText'), dueAt };
    } else if (kind === 'action-review') {
        const selected = detail.capaActions.find(item => item.id === value('actionId'));
        if (!selected || !['Reviewer', 'Quality Engineer'].includes(actor?.role) ||
            actor.id === selected.created_by || actor.id === selected.owner_actor_id) {
            throw new Error('별도 독립 조치 검토자를 선택하세요.');
        }
        action = 'reviewCapaAction'; input = { ...common, actionId: selected.id,
            decision: value('decision'), evidenceKind: value('evidenceKind'),
            evidenceId: value('evidenceId'), reason: value('reason') };
    } else if (kind === 'feedback') {
        if (!['Quality Engineer', 'Manufacturing Engineer', 'Equipment / Automation Engineer'].includes(actor?.role)) throw new Error('문서 피드백을 기록할 수 있는 역할을 선택하세요.');
        const [documentId, baseRevisionId] = value('documentRevision').split('|');
        action = 'proposeDocumentFeedback'; input = { ...common, id: value('id'), documentId,
            baseRevisionId, capaActionId: value('capaActionId'), proposedSummary: value('proposedSummary') };
    } else if (kind === 'feedback-review') {
        const selected = detail.documentFeedback.find(item => item.id === value('feedbackId'));
        if (!selected || !['Reviewer', 'Quality Engineer', 'Approver'].includes(actor?.role) || actor.id === selected.proposed_by) {
            throw new Error('별도 독립 문서 검토자를 선택하세요.');
        }
        const capaAction = detail.capaActions.find(item => item.id === selected.capa_action_id);
        const verificationId = value('verificationId') || capaAction?.review?.id;
        action = 'reviewDocumentFeedback'; input = { ...common, feedbackId: selected.id,
            decision: value('decision'), verificationKind: 'capa-review', verificationId,
            reason: value('reason') };
    } else if (kind === 'document-approval') {
        const selected = detail.documentFeedback.find(item => item.id === value('feedbackId'));
        if (!selected || !['Approver', 'Quality Engineer'].includes(actor?.role) ||
            actor.id === selected.proposed_by || actor.id === selected.review?.reviewer_actor_id) {
            throw new Error('별도 문서 승인자를 선택하세요.');
        }
        action = 'approveDocumentRevision'; input = { ...common, feedbackId: selected.id, reason: value('reason') };
    } else throw new Error('Unknown CAPA decision form');
    if (Object.entries(input).some(([key, item]) => key !== 'cycleId' && key !== 'expectedRevisionNo' && key !== 'actorId' && key !== 'incidentId' && key !== 'at' && (item == null || item === ''))) {
        throw new Error('Complete every required CAPA decision field');
    }
    const originNo = state.navigationRequestNo;
    state.busy = true;
    actorSelect.disabled = true;
    try {
        const outcome = await commitAndRefresh(sendAction(action, input), originNo);
        if (outcome.refreshed) showToast(`${action} recorded for ${detail.incident.id}`);
    } finally {
        state.busy = false;
        actorSelect.disabled = false;
    }
}

document.addEventListener('click', async event => {
    const target = event.target.closest('button');
    if (!target) return;
    // aria-disabled buttons stay focusable but never submit; repeat their visible reason instead.
    if (target.getAttribute('aria-disabled') === 'true') {
        const reason = document.getElementById(target.getAttribute('aria-describedby') ?? '');
        if (reason) announce(reason.textContent.trim());
        return;
    }
    try {
        if (target.dataset.openChange) await openChange(target.dataset.openChange);
        else if (target.dataset.openIncident) await openIncident(target.dataset.openIncident);
        else if (target.dataset.openEquipment) await openEquipment(target.dataset.openEquipment);
        else if (target.dataset.view === 'equipment') await openEquipment();
        else if (target.dataset.view) {
            if (state.bootstrap) state.navigationRequestNo++;
            state.view = target.dataset.view;
            if (state.view === 'changes') state.changeId = null;
            if (state.view === 'fabtrace') state.incidentId = null;
            if (!state.bootstrap) { await startupPromise; return; }
            if (state.bootstrapDirty) await reload();
            else render();
            view.focus();
        } else if (target.dataset.action === 'next-gate') await runNextGate();
        else if (target.dataset.action === 'incident-gate') await runIncidentGate();
        else if (target.dataset.capaSubmit) await runCapaDecision(target.dataset.capaSubmit);
        else if (target.dataset.effectivenessSubmit === 'evaluate') await runEffectivenessEvaluation(target);
        else if (target.dataset.effectivenessSubmit === 'reopen') await runEffectivenessReopen(target);
        else if (target.dataset.effectivenessSubmit === 'close') await runEffectivenessClose(target);
        else if (target.dataset.changeMonitoringSubmit) await runChangeMonitoring(target.dataset.changeMonitoringSubmit, target);
    } catch (error) { showToast(error.message, true); }
});

document.addEventListener('change', event => {
    if (event.target.id === 'incident-review-decision') {
        const lotChoices = document.getElementById('incident-lot-decisions');
        if (lotChoices) lotChoices.hidden = event.target.value !== 'Pass';
    }
    if (event.target.name === 'checkId' && event.target.form?.id === 'effectiveness-reopen-form') {
        syncReopenEvidence(event.target.form);
    }
});

document.addEventListener('submit', async event => {
    if (event.target.id === 'create-incident-form') {
        event.preventDefault();
        if (state.busy) return;
        const form = new FormData(event.target);
        const id = `INC-${crypto.randomUUID().toUpperCase()}`;
        const originNo = state.navigationRequestNo;
        state.busy = true;
        actorSelect.disabled = true;
        try {
            const outcome = await commitAndRefresh(sendAction('createIncident', { id, title: String(form.get('title')).trim(),
                actorId: state.actorId, defectCodeId: 'DEF-FIDUCIAL',
                detectionEventId: 'EV-DETECTION', observedLotId: 'LOT-A-026',
                recipeRevisionId: 'REC-ALIGN-R3', detectedAt: '2026-08-27T10:00:00.000Z',
                at: '2026-08-27T10:02:00.000Z' }), originNo);
            if (outcome.refreshed && await openIncident(id)) showToast('사건이 등록되었습니다.');
        } catch (error) { showToast(error.message, true); }
        finally { state.busy = false; actorSelect.disabled = false; }
        return;
    }
    if (event.target.id !== 'create-change-form') return;
    event.preventDefault();
    if (state.busy) return;
    const form = new FormData(event.target);
    const recipeRevisionId = String(form.get('recipe'));
    const id = `CHG-${crypto.randomUUID().toUpperCase()}`;
    const day = recipeRevisionId === 'REC-ALIGN-R2' ? '2026-08-05' : '2026-08-07';
    const scope = recipeRevisionId === lineBContrastScope.recipeRevisionId ? lineBContrastScope : {
        lineId: 'LINE-A', equipmentId: 'EQ-ALIGN-A', moduleId: 'MOD-ALIGN-A',
        recipeRevisionId, baselineRef: 'AOI-A-001', at: `${day}T12:00:00.000Z` };
    const originNo = state.navigationRequestNo;
    state.busy = true;
    actorSelect.disabled = true;
    try {
        const outcome = await commitAndRefresh(sendAction('createChange', {
            id, title: String(form.get('title')).trim(), actorId: state.actorId,
            lineId: scope.lineId, equipmentId: scope.equipmentId, moduleId: scope.moduleId,
            recipeRevisionId: scope.recipeRevisionId, baselineRef: scope.baselineRef,
            reason: String(form.get('reason')).trim(), at: scope.at
        }), originNo);
        if (outcome.refreshed && await openChange(id)) showToast('변경이 등록되었습니다.');
    } catch (error) { showToast(error.message, true); }
    finally { state.busy = false; actorSelect.disabled = false; }
});

actorSelect.addEventListener('change', () => {
    if (state.busy) { actorSelect.value = state.actorId; return; }
    state.actorId = actorSelect.value;
    updateActorIdentity();
    render();
    showToast(`현재 역할: ${actorSelect.selectedOptions[0]?.textContent ?? state.actorId}`);
});

toastClose.addEventListener('click', event => {
    event.stopPropagation();
    dismissToast();
});

startupPromise = reload().catch(error => {
    view.innerHTML = `<div class="empty-state"><strong>기록을 불러오지 못했습니다</strong><p>${text(error.message)}</p></div>`;
});
