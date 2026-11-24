/**
 * 관리자 → 보안 점검 화면 (3중 보안 현황)
 *  1차 접근 차단: 잠금 현황, 최근 로그인 실패
 *  2차 데이터 보호: 민감정보 암호화 현황, 키 상태
 *  3차 감시·추적: 감사 로그 (필터)
 */
const guard = require('./guard');
const secretBox = require('./secretBox');

const EVENT_LABEL = {
  login_ok: '로그인', login_fail: '로그인 실패', login_blocked: '잠금 중 로그인 시도', login_locked: '로그인 잠금 발생', logout: '로그아웃',
  signup: '회원가입', password_change: '비밀번호 변경', password_reset_code: '재설정 코드 발송', password_reset_fail: '재설정 코드 오입력',
  password_reset_done: '비밀번호 재설정', admin_reset_ok: '보안코드 관리자 초기화', admin_reset_fail: '보안코드 초기화 실패',
  smtp_change: '발신 메일 변경', api_credential_change: 'API 키 변경', viewer_invite_accept: '열람 초대 수락',
  export_report_excel: '리포트 엑셀 내려받기', view_report_preview: '리포트 미리보기', export_analysis_excel: '분석 엑셀 내려받기',
  export_da_excel: 'DA 엑셀 내려받기', view_da_preview: 'DA 미리보기', export_strategy_excel: '전략 엑셀 내려받기',
  export_account_template: '광고주 양식 내려받기', reveal_reset_secret: '보안코드 조회', change: '설정·데이터 변경',
  security_alert: '보안 알림 발송', security_unlock: '잠금 해제', security_seal: '암호화 실행', cron_auth_fail: '크론 인증 실패',
};

function registerSecurityAdmin(router, { requireLogin, requireAdmin, appLayout, getUser, getLayoutOpts, escHtml }) {
  router.get('/admin/security', requireLogin, requireAdmin, async (req, res) => {
    const pool = require('../db/database').pool;
    const user = await getUser(req);
    const ev = String(req.query.event || '');
    const who = String(req.query.who || '').trim();
    const params = [];
    let where = 'WHERE 1=1';
    if (ev === 'fail') where += ' AND ok = false';
    else if (ev === 'export') where += " AND event LIKE 'export_%'";
    else if (ev === 'login') where += " AND event LIKE 'login_%'";
    else if (ev) { params.push(ev); where += ` AND event = $${params.length}`; }
    if (who) { params.push(`%${who}%`); where += ` AND (username ILIKE $${params.length} OR ip ILIKE $${params.length})`; }
    const logs = await pool.query(`SELECT created_at::text AS t, username, role, event, ok, ip, path, target, detail FROM security_audit_log ${where} ORDER BY id DESC LIMIT 200`, params).then(r => r.rows).catch(() => []);
    const stats = await pool.query(`SELECT
        COUNT(*) FILTER (WHERE event = 'login_fail' AND created_at > NOW() - INTERVAL '24 hours')::int AS fails24,
        COUNT(*) FILTER (WHERE event = 'login_locked' AND created_at > NOW() - INTERVAL '7 days')::int AS locks7,
        COUNT(*) FILTER (WHERE event LIKE 'export_%' AND created_at > NOW() - INTERVAL '24 hours')::int AS exports24,
        COUNT(*) FILTER (WHERE event = 'login_ok' AND created_at > NOW() - INTERVAL '24 hours')::int AS logins24
      FROM security_audit_log`).then(r => r.rows[0]).catch(() => ({}));
    const locks = await guard.activeLocks();
    const cov = await secretBox.coverageReport(pool);
    const st = secretBox.getStatus();
    const plainLeft = cov.reduce((s, c) => s + c.plain, 0);
    const encDone = cov.reduce((s, c) => s + c.enc, 0);
    const env = {
      session: !!process.env.SESSION_SECRET && process.env.SESSION_SECRET !== 'naver-sa-secret-change-me',
      dataKey: !!process.env.DATA_ENC_KEY,
      cron: !!process.env.CRON_SECRET && process.env.CRON_SECRET.length >= 16,
    };
    const msg = String(req.query.msg || '');
    const chip = (ok, okText, ngText) => `<span class="badge ${ok ? 'badge-green' : ''}" style="${ok ? '' : 'background:#fef3c7;color:#92400e'}">${ok ? okText : ngText}</span>`;
    const card = (title, body) => `<div class="card" style="margin-bottom:16px"><div class="card-header"><span class="card-title">${title}</span></div><div class="card-body" style="font-size:13px;line-height:1.7">${body}</div></div>`;
    const kv = rows => `<table style="width:100%">${rows.map(([k, v]) => `<tr><td style="color:#64748b;width:260px;padding:6px 8px">${k}</td><td style="padding:6px 8px">${v}</td></tr>`).join('')}</table>`;

    const layer1 = kv([
      ['로그인 시도 제한', '아이디별 15분 5회 · IP별 15분 20회 실패 시 잠금'],
      ['비밀번호 재설정 시도 제한', 'IP별 15분 10회 · 보안코드 초기화 IP별 1시간 5회'],
      ['세션', '로그인 시 세션 ID 재발급 · HttpOnly · HTTPS 전용 쿠키'],
      ['보안 헤더', '외부 사이트 화면 삽입 차단 · MIME 위장 차단 · HTTPS 강제 · 로그인 화면 캐시 금지'],
      ['비밀번호 정책', '새 비밀번호 8자 이상, 영문+숫자'],
      ['최근 24시간', `로그인 ${stats.logins24 || 0}회 · 실패 ${stats.fails24 || 0}회 · 최근 7일 잠금 ${stats.locks7 || 0}건`],
      ['현재 잠금', locks.length ? `${locks.length}건 <form method="POST" action="/smart-sa/admin/security/unlock" style="display:inline;margin-left:8px"><button class="btn btn-outline btn-sm">전체 잠금 해제</button></form>` : '없음'],
    ]);
    const layer2 = kv([
      ['민감정보 암호화', st.active ? chip(true, `사용 중 (AES-256-GCM)`) : chip(false, '', `꺼짐 — ${escHtml(st.reason)}`)],
      ['암호화 대상', 'API 키·시크릿, 다우오피스/SMTP 비밀번호, 전역 발신 비밀번호, DA 쿠키'],
      ['암호화 현황', `암호화 ${encDone}건 · 평문 남음 ${plainLeft}건${plainLeft && st.active ? ' <form method="POST" action="/smart-sa/admin/security/seal" style="display:inline;margin-left:8px"><button class="btn btn-outline btn-sm">지금 암호화</button></form>' : ''}`],
      ['화면 노출 차단', '저장된 비밀번호·API 시크릿·쿠키는 화면에 다시 싣지 않음 (마스킹 표시)'],
      ['키 지문', st.fingerprint ? `<code>${escHtml(st.fingerprint)}</code> (${escHtml(st.reason)})` : '-'],
      ['SESSION_SECRET', chip(env.session, '설정됨', '미설정 또는 기본값 — Vercel 환경변수에 설정 필요')],
      ['DATA_ENC_KEY', chip(env.dataKey, '설정됨', '미설정 — SESSION_SECRET 파생 키 사용 중 (권장: 별도 키 설정)')],
      ['CRON_SECRET', chip(env.cron, '설정됨', '미설정 또는 짧음')],
    ]);
    const filters = [['', '전체'], ['login', '로그인'], ['fail', '실패만'], ['export', '내려받기'], ['change', '변경'], ['security_alert', '보안 알림']]
      .map(([k, l]) => `<a class="btn btn-sm ${ev === k ? 'btn-primary' : 'btn-outline'}" href="/smart-sa/admin/security?event=${k}${who ? '&who=' + encodeURIComponent(who) : ''}">${l}</a>`).join(' ');
    const rows = logs.map(l => `<tr>
        <td style="white-space:nowrap;font-size:12px">${escHtml(l.t.slice(0, 19))}</td>
        <td>${escHtml(l.username || '-')}<div style="font-size:11px;color:#94a3b8">${escHtml(l.role || '')}</div></td>
        <td>${l.ok ? '' : '<span style="color:#dc2626">✕ </span>'}${escHtml(EVENT_LABEL[l.event] || l.event)}</td>
        <td style="font-size:12px;color:#475569;max-width:280px;word-break:break-all">${escHtml(l.path || '')}${l.target ? ' · ' + escHtml(l.target) : ''}${l.detail ? '<div style="color:#94a3b8">' + escHtml(l.detail) + '</div>' : ''}</td>
        <td style="font-size:12px">${escHtml(l.ip || '')}</td></tr>`).join('');
    const layer3 = `<p style="margin-bottom:10px">로그인·비밀번호·자격증명 변경, 리포트 내려받기·미리보기, 모든 설정 변경을 400일 보관합니다. 잠금 발생, 1시간 30회 이상 내려받기, 보안코드 초기화 반복은 관리자 메일로 알립니다 (사안별 1시간 1회).</p>
      <form method="GET" action="/smart-sa/admin/security" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
        ${filters}
        <input type="hidden" name="event" value="${escHtml(ev)}">
        <input name="who" value="${escHtml(who)}" placeholder="아이디 또는 IP" style="width:180px;height:30px;font-size:12px">
        <button class="btn btn-outline btn-sm">검색</button>
      </form>
      <div style="overflow-x:auto"><table><thead><tr><th>시각(UTC)</th><th>사용자</th><th>이벤트</th><th>대상</th><th>IP</th></tr></thead><tbody>${rows || '<tr><td colspan="5" style="color:#94a3b8">기록이 없습니다.</td></tr>'}</tbody></table></div>`;

    const content = `
      ${msg === 'unlocked' ? '<div class="alert alert-ok">잠금을 모두 해제했습니다.</div>' : ''}
      ${msg === 'sealed' ? `<div class="alert alert-ok">평문으로 남아 있던 민감정보를 암호화했습니다 (${parseInt(req.query.n) || 0}건).</div>` : ''}
      <p style="color:#64748b;font-size:13px;margin-bottom:16px">개인정보 유출을 막는 3중 보안 계층의 현재 상태입니다.</p>
      ${card('🛡 1차 · 접근 차단', layer1)}
      ${card('🔐 2차 · 데이터 보호', layer2)}
      ${card('🕵 3차 · 감시·추적 (감사 로그 최근 200건)', layer3)}`;
    res.send(appLayout('보안 점검', content, user, 'admin-security', await getLayoutOpts(req)));
  });

  router.post('/admin/security/unlock', requireLogin, requireAdmin, async (req, res) => {
    const n = await guard.unlockAll();
    guard.audit(req, 'security_unlock', { detail: `${n}건 해제` });
    res.redirect(303, '/smart-sa/admin/security?msg=unlocked');
  });
  router.post('/admin/security/seal', requireLogin, requireAdmin, async (req, res) => {
    const n = await secretBox.sealPlaintextRows(require('../db/database').pool);
    guard.audit(req, 'security_seal', { detail: `${n}건 암호화` });
    res.redirect(303, `/smart-sa/admin/security?msg=sealed&n=${n}`);
  });
}

module.exports = { registerSecurityAdmin };
