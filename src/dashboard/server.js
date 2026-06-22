const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { config } = require('../../config');
const db = require('../db/database');
const { createApiClient } = require('../api/naverApi');
const { generateAndSend } = require('../report/generator');

const router = express.Router();

// ─── 기능 플래그 ────────────────────────────────────────────────────
// DA(GFA) 대시보드/리포트: 쿠키 세션 기반이라 자동 토큰 갱신이 불가능하여
//   공식 GFA 마케팅 API가 연동될 때까지 비활성화. (코드는 보존 → 플래그만 true로 재활성화)
// 자동입찰(파워링크/쇼핑): 자동 입찰 대신 '원클릭 계정분석 제안'의 증액/감액 제안으로 대체.
//   auto_bid_keywords / shopping_bid_keywords 데이터는 보존되므로 재활성화 시 그대로 복구됨.
const FEATURES = {
  DA: false,        // DA 성과 대시보드 + DA 리포트
  AUTOBID: false,   // 파워링크 자동입찰
  SHOPPING_BID: false, // 쇼핑검색 자동입찰
};

// ─── 세션 미들웨어 (Supabase PostgreSQL에 세션 저장) ───────────────
router.use(session({
  store: new pgSession({
    pool: db.pool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
  }),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));

router.use(express.json({ limit: '20mb' })); // 이미지 base64 업로드 대응
router.use(express.urlencoded({ extended: true, limit: '20mb' }));

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect('/smart-sa/login');
  // 승인 대기 상태면 대기 페이지로
  if ((req.session.approved === 0 || req.session.approved === -1) && req.path !== '/pending' && req.path !== '/logout') {
    return res.redirect('/smart-sa/pending');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.redirect('/smart-sa');
  next();
}

// API 자격증명 등록 여부 체크 미들웨어
async function requireApi(req, res, next) {
  const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
  if (!creds) return res.redirect('/smart-sa/api-settings?msg=need');
  req.apiCreds = creds;
  next();
}

// ─── 공통 HTML 레이아웃 ────────────────────────────────────────────
const logoBase64 = (() => { try { const fs = require('fs'); const p = require('path'); return 'data:image/png;base64,' + fs.readFileSync(p.join(__dirname, '..', 'assets', 'logo.png')).toString('base64'); } catch(e) { return ''; } })();

const css = `
  @import url('https://fonts.googleapis.com/css2?family=Pretendard:wght@300;400;500;600;700;800&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif;background:#f5f6fa;color:#1e293b;font-size:14px}
  a{text-decoration:none;color:inherit}
  input,select,textarea{padding:10px 14px;border:1px solid #e5e7eb;border-radius:10px;font-size:14px;width:100%;background:#fff;outline:none;transition:all .2s;font-family:inherit}
  input:focus,select:focus,textarea:focus{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.1)}
  label{display:block;font-size:12px;font-weight:600;color:#6b7280;margin-bottom:6px;letter-spacing:.02em}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:10px 20px;border-radius:10px;border:none;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s;font-family:inherit}
  .btn-primary{background:#6366f1;color:#fff} .btn-primary:hover{background:#4f46e5;box-shadow:0 4px 12px rgba(99,102,241,.3)}
  .btn-danger{background:#ef4444;color:#fff} .btn-danger:hover{background:#dc2626}
  .btn-outline{background:#fff;color:#374151;border:1px solid #e5e7eb} .btn-outline:hover{background:#f9fafb;border-color:#d1d5db}
  .btn-sm{padding:7px 14px;font-size:12px}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .card{background:#fff;border-radius:16px;border:none;box-shadow:0 1px 3px rgba(0,0,0,.04);overflow:hidden}
  .card-header{padding:18px 24px;border-bottom:1px solid #f3f4f6;display:flex;align-items:center;justify-content:space-between}
  .card-title{font-size:15px;font-weight:700;color:#111827}
  .card-body{padding:24px}
  table{width:100%;border-collapse:collapse}
  th{padding:12px 16px;text-align:left;font-size:11px;color:#9ca3af;font-weight:600;background:#fafbfc;border-bottom:1px solid #f3f4f6;text-transform:uppercase;letter-spacing:.05em}
  td{padding:13px 16px;border-bottom:1px solid #f9fafb;font-size:13px;color:#374151}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#fafbfe}
  .badge{display:inline-flex;align-items:center;padding:3px 10px;border-radius:99px;font-size:11px;font-weight:600}
  .badge-green{background:#ecfdf5;color:#059669} .badge-gray{background:#f3f4f6;color:#6b7280}
  .badge-blue{background:#eef2ff;color:#4f46e5} .badge-red{background:#fef2f2;color:#dc2626}
  .toggle{width:40px;height:22px;border-radius:11px;position:relative;cursor:default;flex-shrink:0;transition:background .2s}
  .toggle-on{background:#6366f1} .toggle-off{background:#d1d5db}
  .toggle-dot{position:absolute;top:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.15);transition:left .15s}
  .toggle-on .toggle-dot{left:21px} .toggle-off .toggle-dot{left:3px}
  .form-group{margin-bottom:18px}
  .form-row{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  .alert{padding:14px 18px;border-radius:10px;margin-bottom:16px;font-size:13px;font-weight:500}
  .alert-err{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
  .alert-ok{background:#ecfdf5;color:#059669;border:1px solid #a7f3d0}
  .alert-info{background:#eef2ff;color:#4f46e5;border:1px solid #c7d2fe}
  .sidebar{width:260px;min-height:100vh;background:#ffffff;position:fixed;top:0;left:0;display:flex;flex-direction:column;border-right:1px solid #e5e7eb;z-index:200}
  .sidebar-header{padding:20px 24px 18px;border-bottom:1px solid #f3f4f6;display:flex;align-items:center;gap:12px}
  .sidebar-logo-img{height:32px;max-width:160px;object-fit:contain}
  .sidebar-logo{font-size:16px;font-weight:700;color:#111827}
  .sidebar-sub{font-size:11px;color:#9ca3af;margin-top:2px}
  .sidebar-section{padding:16px 16px 6px;font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.1em;font-weight:600}
  .sidebar-link{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;font-size:13px;font-weight:500;color:#6b7280;cursor:pointer;transition:all .15s;margin:2px 10px;border:none;background:transparent;width:calc(100% - 20px)}
  .sidebar-link:hover{background:#f5f6fa;color:#374151}
  .sidebar-link.active{background:#eef2ff;color:#4f46e5;font-weight:600}
  .sidebar-link .sidebar-icon{width:20px;text-align:center;font-size:15px}
  .sidebar-footer{margin-top:auto;padding:16px;border-top:1px solid #f3f4f6}
  .sidebar-user{font-size:13px;color:#6b7280}
  .main{margin-left:260px;min-height:100vh;background:#f5f6fa}
  .topbar{background:#fff;border-bottom:1px solid #f3f4f6;padding:0 28px;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
  .topbar-title{font-size:17px;font-weight:700;color:#111827}
  .content{padding:28px}
  .kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}
  @media(max-width:1100px){.kpi-grid{grid-template-columns:repeat(2,1fr)}}
  .kpi-card{background:#fff;border-radius:16px;padding:22px 24px;border:none;box-shadow:0 1px 3px rgba(0,0,0,.04);position:relative;overflow:hidden}
  .kpi-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:16px 16px 0 0}
  .kpi-card.kpi-blue::before{background:linear-gradient(90deg,#6366f1,#818cf8)}
  .kpi-card.kpi-green::before{background:linear-gradient(90deg,#10b981,#34d399)}
  .kpi-card.kpi-red::before{background:linear-gradient(90deg,#f43f5e,#fb7185)}
  .kpi-card.kpi-purple::before{background:linear-gradient(90deg,#8b5cf6,#a78bfa)}
  .kpi-card.kpi-orange::before{background:linear-gradient(90deg,#f59e0b,#fbbf24)}
  .kpi-card.kpi-cyan::before{background:linear-gradient(90deg,#06b6d4,#22d3ee)}
  .kpi-label{font-size:12px;color:#9ca3af;font-weight:500;margin-bottom:10px;letter-spacing:.02em}
  .kpi-value{font-size:26px;font-weight:800;color:#111827;letter-spacing:-.02em}
  .kpi-sub{font-size:11px;margin-top:6px;font-weight:500}
  .kpi-up{color:#059669} .kpi-down{color:#dc2626} .kpi-flat{color:#9ca3af}
  .period-tabs{display:flex;background:#fff;border-radius:10px;padding:4px;border:1px solid #e5e7eb;gap:2px}
  .period-btn{padding:7px 18px;border-radius:8px;border:none;background:transparent;font-size:13px;font-weight:500;cursor:pointer;color:#9ca3af;transition:all .15s}
  .period-btn.active{background:#6366f1;color:#fff;box-shadow:0 2px 8px rgba(99,102,241,.2)}
  .period-btn:hover:not(.active){background:#f5f6fa;color:#374151}
  .spinner{width:20px;height:20px;border:2px solid #e5e7eb;border-top-color:#6366f1;border-radius:50%;animation:spin .6s linear infinite;display:inline-block}
  @keyframes spin{to{transform:rotate(360deg)}}
  .empty{text-align:center;padding:48px;color:#9ca3af;font-size:14px}
  .toast-wrap{position:fixed;bottom:24px;right:24px;display:flex;flex-direction:column;gap:8px;z-index:999}
  .toast{padding:14px 22px;border-radius:12px;font-size:13px;font-weight:500;box-shadow:0 8px 24px rgba(0,0,0,.12);animation:toastIn .25s ease}
  .toast-ok{background:#111827;color:#fff} .toast-err{background:#dc2626;color:#fff}
  @keyframes toastIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
  th.sortable{cursor:pointer;user-select:none;position:relative;padding-right:18px!important}
  th.sortable:hover{background:#f0f1ff}
  th.sortable::after{content:'⇅';position:absolute;right:4px;top:50%;transform:translateY(-50%);font-size:10px;color:#cbd5e1}
  th.sortable.sort-asc::after{content:'▲';color:#6366f1}
  th.sortable.sort-desc::after{content:'▼';color:#6366f1}
  .section-title{font-size:16px;font-weight:700;color:#111827;margin-bottom:16px;display:flex;align-items:center;gap:8px}
  td{font-variant-numeric:tabular-nums}
  /* ── 데이터 테이블 (전략/분석 공용) ── */
  .dtable-wrap{border:1px solid #eef2f7;border-radius:12px;overflow:auto;background:#fff;max-height:560px}
  .dtable{width:100%;border-collapse:collapse;font-size:12.5px}
  .dtable th{position:sticky;top:0;background:#f8fafc;color:#64748b;font-size:11px;font-weight:700;text-transform:none;letter-spacing:0;padding:11px 12px;border-bottom:1px solid #e5e7eb;white-space:nowrap;text-align:left;z-index:1}
  .dtable td{padding:11px 12px;border-bottom:1px solid #f1f5f9;color:#334155;vertical-align:middle}
  .dtable tbody tr:last-child td{border-bottom:none}
  .dtable tbody tr:nth-child(even){background:#fafbfc}
  .dtable tbody tr:hover td{background:#f5f7ff}
  .dtable td.num,.dtable th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .dtable td.kw{font-weight:600;color:#1e293b}
  .dtable td.reason{color:#94a3b8;font-size:11.5px;line-height:1.5;min-width:240px;max-width:440px}
  /* ── 전략 결과 섹션/요약 ── */
  .st-section{font-weight:700;font-size:14px;margin:22px 0 9px;display:flex;align-items:center;gap:7px}
  .st-section .st-count{font-weight:400;color:#94a3b8;font-size:12px}
  .st-summary{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}
  .st-sc{flex:1;min-width:160px;background:#fff;border:1px solid #eef2f7;border-left-width:4px;border-radius:10px;padding:14px 16px}
  .st-sc .st-l{font-size:12px;color:#64748b;margin-bottom:5px}
  .st-sc .st-v{font-size:21px;font-weight:800;letter-spacing:-.01em}
  .st-empty{font-size:12.5px;color:#94a3b8;padding:14px;background:#fafbfc;border:1px dashed #e5e7eb;border-radius:10px}
  .tab-bar{display:flex;gap:4px;background:#f5f6fa;border-radius:10px;padding:4px;margin-bottom:16px}
  .tab-btn{padding:8px 18px;border-radius:8px;border:none;background:transparent;font-size:13px;font-weight:500;cursor:pointer;color:#6b7280;transition:all .15s}
  .tab-btn.active{background:#fff;color:#111827;box-shadow:0 1px 3px rgba(0,0,0,.08);font-weight:600}
`;

function layout(title, body, user = null) {
  return `<!DOCTYPE html><html lang="ko"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - 뉴먼트 솔루션</title>
<style>${css}</style></head><body>${body}
<div class="toast-wrap" id="toast-wrap"></div>
<script>
function toast(msg, isErr=false){
  const w=document.getElementById('toast-wrap');
  const el=document.createElement('div');
  el.className='toast '+(isErr?'toast-err':'toast-ok');
  el.textContent=msg; w.appendChild(el);
  setTimeout(()=>el.remove(),3500);
}
</script></body></html>`;
}

function appLayout(title, content, user, activeMenu, opts = {}) {
  const accounts = opts.accounts || [];
  const selectedAccountId = opts.selectedAccountId || '';

  const menuItems = [
    { id: 'dashboard', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>', label: 'SA 성과 대시보드', href: '/smart-sa' },
  ];
  // DA 성과 대시보드: 공식 GFA API 연동 전까지 비활성화
  if (FEATURES.DA) {
    menuItems.push({ id: 'da-dashboard', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><polyline points="7 13 10 9 13 12 17 7"/></svg>', label: 'DA 성과 대시보드', href: '/smart-sa/da-dashboard' });
  }
  // 자동입찰: '원클릭 계정분석 제안'(증액/감액)으로 대체하여 비활성화
  if (FEATURES.AUTOBID) {
    menuItems.push({ id: 'autobid', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>', label: '파워링크 자동입찰', href: '/smart-sa/autobid' });
  }
  if (FEATURES.SHOPPING_BID) {
    menuItems.push({ id: 'shopping-bid', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>', label: '쇼핑검색 자동입찰', href: '/smart-sa/shopping-bid' });
  }
  menuItems.push(
    { id: 'reports', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>', label: '자동리포트', href: '/smart-sa/reports' },
    { id: 'accounts', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>', label: '광고주 관리', href: '/smart-sa/accounts' },
    { id: 'api', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>', label: 'API 설정', href: '/smart-sa/api-settings' },
  );
  if (user?.is_admin) {
    menuItems.push({ id: 'admin', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>', label: '직원 관리', href: '/smart-sa/admin/users' });
  }

  // ─── 성과개선 전략 메뉴 그룹 ──────────────────────────────────────
  const strategyItems = [
    { id: 'strategy-upsell', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>', label: '증액 (Upselling)', href: '/smart-sa/strategy/upsell' },
    { id: 'strategy-downsell', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>', label: '감액 (Downselling)', href: '/smart-sa/strategy/downsell' },
    { id: 'strategy-oneclick', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>', label: '원클릭 계정분석 제안', href: '/smart-sa/strategy/analysis' },
  ];

  // 광고 유형 라벨: [SA   ] / [   DA] / [SA·DA] (5자 고정으로 정렬)
  function typeBadge(a) {
    var sa = a.has_sa !== false; // 기본 true
    var da = !!a.has_da;
    if (sa && da) return '[SA·DA]';
    if (sa) return '[SA   ]';
    if (da) return '[   DA]';
    return '[     ]';
  }
  const accountSelector = accounts.length > 0 ? `
    <div style="padding:12px 16px;border-bottom:1px solid #f3f4f6">
      <label style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.08em;display:block;margin-bottom:6px;font-weight:600">광고주 선택</label>
      <select id="account-selector" onchange="switchAccount(this.value)"
        style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid #e5e7eb;background:#f9fafb;color:#374151;font-size:13px;cursor:pointer;font-family:'Consolas','Monaco',monospace;outline:none">
        <option value="" style="font-family:inherit">전체 광고주</option>
        ${accounts.map(a => `<option value="${a.id}" ${String(a.id) === String(selectedAccountId) ? 'selected' : ''}>${typeBadge(a)} ${a.name} (${a.customer_id})</option>`).join('')}
      </select>
    </div>
    <script>
    function switchAccount(accountId) {
      fetch('/smart-sa/api/select-account', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({accountId})
      }).then(() => location.reload());
    }
    </script>
  ` : '';

  const sidebar = `
  <div class="sidebar">
    <div class="sidebar-header">
      ${logoBase64 ? `<img src="${logoBase64}" class="sidebar-logo-img" alt="NEWMENT">` : '<div class="sidebar-logo">NEWMENT</div>'}
    </div>
    ${accountSelector}
    <div class="sidebar-section">메뉴</div>
    <div style="padding:0 6px">
      ${menuItems.map(m => `
        <a href="${m.href}" class="sidebar-link ${activeMenu === m.id ? 'active' : ''}">
          <span class="sidebar-icon">${m.icon}</span><span>${m.label}</span>
        </a>
      `).join('')}
    </div>
    <div class="sidebar-section">성과개선 전략</div>
    <div style="padding:0 6px;flex:1">
      ${strategyItems.map(m => `
        <a href="${m.href}" class="sidebar-link ${activeMenu === m.id ? 'active' : ''}">
          <span class="sidebar-icon">${m.icon}</span><span>${m.label}</span>
        </a>
      `).join('')}
    </div>
    <div class="sidebar-footer">
      <a href="/smart-sa/profile" class="sidebar-link ${activeMenu === 'profile' ? 'active' : ''}" style="margin-bottom:4px">
        <span class="sidebar-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>
        <span>${user?.name || user?.username}</span>
      </a>
      <a href="/smart-sa/logout" class="sidebar-link" style="padding:8px 14px">
        <span class="sidebar-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg></span>
        <span>로그아웃</span>
      </a>
    </div>
  </div>`;

  return layout(title, `
    ${sidebar}
    <div class="main">
      <div class="topbar">
        <div class="topbar-title">${title}</div>
      </div>
      <div class="content">${content}</div>
    </div>
  `, user);
}

// ─── 로그인 ─────────────────────────────────────────────────────────
router.get('/login', async (req, res) => {
  if (req.session.userId) return res.redirect('/smart-sa');
  const userCount = await db.countUsers();
  const isFirst = userCount === 0;
  const err = req.query.err || '';

  res.send(layout('로그인', `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f6fa">
      <div style="width:100%;max-width:420px;padding:16px">
        <div style="text-align:center;margin-bottom:36px">
          ${logoBase64 ? `<img src="${logoBase64}" style="height:40px;margin-bottom:12px" alt="NEWMENT">` : '<h1 style="font-size:24px;font-weight:800;color:#111827;margin-bottom:8px">NEWMENT</h1>'}
          <p style="color:#9ca3af;font-size:13px;font-weight:500">Naver Search Ad Solution</p>
        </div>
        <div class="card">
          <div class="card-body">
            ${err === 'invalid' ? '<div class="alert alert-err">아이디 또는 비밀번호가 올바르지 않습니다.</div>' : ''}
            ${isFirst ? '<div class="alert alert-ok">최초 실행입니다. 관리자 계정을 생성해주세요.</div>' : ''}
            <form method="POST" action="${isFirst ? '/smart-sa/register' : '/smart-sa/login'}">
              <div class="form-group">
                <label>${isFirst ? '아이디 (영문)' : '아이디'}</label>
                <input name="username" id="login-username" required placeholder="username" autocomplete="username">
              </div>
              ${isFirst ? `<div class="form-group"><label>이름</label><input name="name" required placeholder="홍길동"></div>` : ''}
              <div class="form-group">
                <label>비밀번호</label>
                <input type="password" name="password" required placeholder="••••••••" autocomplete="current-password">
              </div>
              ${!isFirst ? `
              <div style="display:flex;gap:16px;margin-top:8px;font-size:13px;color:#64748b;white-space:nowrap">
                <label style="display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap">
                  <input type="checkbox" id="save-id" style="accent-color:#6366f1"> 아이디 저장
                </label>
                <label style="display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap">
                  <input type="checkbox" name="remember" value="1" style="accent-color:#6366f1"> 로그인 유지
                </label>
              </div>` : ''}
              <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:12px">
                ${isFirst ? '계정 생성 후 로그인' : '로그인'}
              </button>
            </form>
            ${!isFirst ? `
            <div style="text-align:center;margin-top:16px;padding-top:16px;border-top:1px solid #f1f5f9">
              <span style="font-size:13px;color:#64748b">계정이 없으신가요?</span>
              <a href="/smart-sa/signup" style="font-size:13px;color:#6366f1;font-weight:600;margin-left:6px">회원가입</a>
            </div>
            <div style="text-align:center;margin-top:8px">
              <a href="/smart-sa/reset-password" style="font-size:12px;color:#94a3b8">비밀번호를 잊으셨나요?</a>
            </div>
            <script>
            (function(){
              var saved = localStorage.getItem('savedUsername');
              if(saved){document.getElementById('login-username').value=saved;document.getElementById('save-id').checked=true;}
              document.querySelector('form').addEventListener('submit',function(){
                var cb=document.getElementById('save-id');
                if(cb&&cb.checked) localStorage.setItem('savedUsername',document.getElementById('login-username').value);
                else localStorage.removeItem('savedUsername');
              });
            })();
            </script>` : ''}
          </div>
        </div>
      </div>
    </div>
  `));
});

router.post('/login', async (req, res) => {
  const { username, password, remember } = req.body;
  const user = await db.authenticateUser(username, password);
  if (!user) return res.redirect(303, '/smart-sa/login?err=invalid');
  // 로그인 유지: 30일, 기본: 8시간
  if (remember === '1') req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
  req.session.userId = user.id;
  req.session.userName = user.name;
  req.session.isAdmin = !!user.is_admin;
  req.session.approved = user.approved;
  req.session.save(() => res.redirect(303, '/smart-sa'));
});

router.post('/register', async (req, res) => {
  const { username, password, name } = req.body;
  try {
    const count = await db.countUsers();
    if (count > 0) return res.redirect(303, '/smart-sa/login');
    // 최초 사용자는 관리자 + 승인 완료
    const id = await db.createUser(username, password, name || username, { isAdmin: true, approved: true });
    req.session.userId = id;
    req.session.userName = name || username;
    req.session.isAdmin = true;
    req.session.approved = 1;
    req.session.save(() => res.redirect(303, '/smart-sa'));
  } catch (e) {
    res.redirect(303, '/smart-sa/login?err=taken');
  }
});

router.get('/signup', (req, res) => {
  if (req.session.userId) return res.redirect('/smart-sa');
  const err = req.query.err || '';
  res.send(layout('회원가입', `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#f0f9ff,#f0fdf4)">
      <div style="width:100%;max-width:440px;padding:16px">
        <div style="text-align:center;margin-bottom:32px">
          <div style="font-size:40px;margin-bottom:8px">📊</div>
          <h1 style="font-size:22px;font-weight:700;color:#111827">뉴먼트 솔루션</h1>
          <p style="color:#9ca3af;margin-top:6px;font-size:13px">Newment solution Naver SA</p>
        </div>
        <div class="card">
          <div class="card-body">
            ${err === 'taken' ? '<div class="alert alert-err">이미 사용 중인 아이디입니다.</div>' : ''}
            <form method="POST" action="/smart-sa/signup">
              <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #e5e7eb">솔루션 계정</div>
              <div class="form-group">
                <label>아이디 (영문)</label>
                <input name="username" required placeholder="username" autocomplete="username">
              </div>
              <div class="form-group">
                <label>이름</label>
                <input name="name" required placeholder="홍길동">
              </div>
              <div class="form-group">
                <label>비밀번호</label>
                <input type="password" name="password" required placeholder="••••••••" autocomplete="new-password">
              </div>

              <div style="font-size:13px;font-weight:600;color:#374151;margin:20px 0 8px;padding-bottom:6px;border-bottom:1px solid #e5e7eb">다우오피스 연동</div>
              <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:12px;color:#92400e;line-height:1.6">
                <strong>⚠️ 리포트 이메일 발송에 사용됩니다.</strong><br>
                다우오피스 정보가 정확해야 리포트 발송이 정상적으로 진행됩니다.
              </div>
              <div class="form-group">
                <label>다우오피스 이메일</label>
                <input name="daou_email" required placeholder="user@newment.co.kr" type="email">
              </div>
              <div class="form-group">
                <label>다우오피스 비밀번호</label>
                <input type="password" name="daou_pass" required placeholder="다우오피스 로그인 비밀번호">
              </div>

              <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:12px">계정 생성</button>
            </form>
            <div style="text-align:center;margin-top:16px;padding-top:16px;border-top:1px solid #f1f5f9">
              <a href="/smart-sa/login" style="font-size:13px;color:#6366f1;font-weight:600">← 로그인으로 돌아가기</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  `));
});

router.post('/signup', async (req, res) => {
  const { username, password, name, daou_email, daou_pass } = req.body;
  try {
    // 승인 대기(approved=0) 상태로 생성 + 다우오피스 정보 함께 저장
    const id = await db.createUser(username, password, name || username, {
      isAdmin: false, approved: false,
      daouEmail: daou_email || '', daouPass: daou_pass || '',
    });
    req.session.userId = id;
    req.session.userName = name || username;
    req.session.isAdmin = false;
    req.session.approved = 0;
    req.session.save(() => res.redirect(303, '/smart-sa/pending'));
  } catch (e) {
    res.redirect(303, '/smart-sa/signup?err=taken');
  }
});

// ─── 내 정보 ──────────────────────────────────────────────────────────
router.get('/profile', requireLogin, async (req, res) => {
  const user = await getUser(req);
  const smtp = await db.getSmtpCredentials(req.session.userId);
  const msg = req.query.msg || '';
  const content = `
    <h2>내 정보</h2>
    ${msg === 'saved' ? '<div class="alert alert-ok">저장되었습니다.</div>' : ''}
    ${msg === 'smtp_ok' ? '<div class="alert alert-ok">다우오피스 정보가 업데이트되었습니다.</div>' : ''}
    ${msg === 'pw_err' ? '<div class="alert alert-err">현재 비밀번호가 올바르지 않습니다.</div>' : ''}
    ${msg === 'pw_ok' ? '<div class="alert alert-ok">솔루션 비밀번호가 변경되었습니다.</div>' : ''}
    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><span class="card-title">계정 정보</span></div>
      <div class="card-body">
        <div class="form-row">
          <div class="form-group"><label>아이디</label><input value="${user.username}" disabled></div>
          <div class="form-group"><label>이름</label><input value="${user.name}" disabled></div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><span class="card-title">다우오피스 연동 (이메일 발송용)</span></div>
      <div class="card-body">
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:#92400e;line-height:1.6">
          <strong>⚠️ 다우오피스 정보가 정확해야 리포트 이메일 발송이 정상적으로 진행됩니다.</strong><br>
          다우오피스 비밀번호를 변경한 경우, 아래에서 반드시 업데이트해주세요.
        </div>
        <form method="POST" action="/smart-sa/profile/smtp">
          <div class="form-row">
            <div class="form-group"><label>SMTP 서버</label>
              <select name="smtp_host" style="font-size:13px">
                <option value="outbound.daouoffice.com" ${(smtp?.smtp_host||'outbound.daouoffice.com')==='outbound.daouoffice.com'?'selected':''}>outbound.daouoffice.com (포트 465)</option>
                <option value="send.daouoffice.com" ${smtp?.smtp_host==='send.daouoffice.com'?'selected':''}>send.daouoffice.com (포트 465)</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group"><label>다우오피스 이메일</label><input name="daou_email" value="${smtp?.daou_email || ''}" required placeholder="user@newment.co.kr" type="email"></div>
            <div class="form-group"><label>다우오피스 비밀번호</label><input type="password" name="daou_pass" value="${smtp?.smtp_pass || ''}" required placeholder="다우오피스 로그인 비밀번호"></div>
          </div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn btn-primary">저장</button>
            <button type="button" class="btn btn-outline" onclick="testSmtp()">📧 SMTP 연결 테스트</button>
          </div>
        </form>
        <div id="smtp-test-result" style="margin-top:10px;display:none;padding:10px;border-radius:8px;font-size:12px"></div>
        <script>
        async function testSmtp(){
          const btn=event.target; btn.disabled=true; btn.textContent='테스트 중...';
          const res=document.getElementById('smtp-test-result');
          try{
            const r=await fetch('/smart-sa/profile/smtp-test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
            const j=await r.json();
            res.style.display='block';
            if(j.ok){res.style.background='#f0fdf4';res.style.border='1px solid #bbf7d0';res.style.color='#166534';res.textContent='✅ '+j.message;}
            else{res.style.background='#fef2f2';res.style.border='1px solid #fecaca';res.style.color='#991b1b';res.textContent='❌ '+j.error;}
          }catch(e){res.style.display='block';res.style.background='#fef2f2';res.style.border='1px solid #fecaca';res.style.color='#991b1b';res.textContent='❌ '+e.message;}
          finally{btn.disabled=false;btn.textContent='📧 SMTP 연결 테스트';}
        }
        </script>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><span class="card-title">솔루션 비밀번호 변경</span></div>
      <div class="card-body">
        <form method="POST" action="/smart-sa/profile/password">
          <div class="form-group"><label>현재 비밀번호</label><input type="password" name="current_pw" required></div>
          <div class="form-row">
            <div class="form-group"><label>새 비밀번호</label><input type="password" name="new_pw" required minlength="6"></div>
            <div class="form-group"><label>새 비밀번호 확인</label><input type="password" name="new_pw2" required minlength="6"></div>
          </div>
          <button class="btn btn-outline" style="margin-top:8px">비밀번호 변경</button>
        </form>
      </div>
    </div>
  `;
  res.send(appLayout('내 정보', content, user, 'profile', await getLayoutOpts(req)));
});

router.post('/profile/smtp', requireLogin, async (req, res) => {
  const { daou_email, daou_pass, smtp_host } = req.body;
  await db.pool.query('UPDATE users SET daou_email = $1, smtp_pass = $2, smtp_host = $3 WHERE id = $4', [daou_email, daou_pass, smtp_host || 'outbound.daouoffice.com', req.session.userId]);
  res.redirect(303, '/smart-sa/profile?msg=smtp_ok');
});

router.post('/profile/smtp-test', requireLogin, async (req, res) => {
  try {
    const smtp = await db.getSmtpCredentials(req.session.userId);
    if (!smtp?.daou_email || !smtp?.smtp_pass) {
      return res.json({ ok: false, error: 'SMTP 설정이 없습니다. 먼저 저장해주세요.' });
    }
    const nodemailer = require('nodemailer');
    const servers = [
      { host: smtp.smtp_host || 'outbound.daouoffice.com', port: 465, secure: true },
      { host: 'send.daouoffice.com', port: 465, secure: true },
      { host: smtp.smtp_host || 'outbound.daouoffice.com', port: 587, secure: false },
      { host: 'send.daouoffice.com', port: 587, secure: false },
      { host: 'smtp.daouoffice.com', port: 465, secure: true },
      { host: 'smtp.daouoffice.com', port: 587, secure: false },
    ];
    const errors = [];
    for (const srv of servers) {
      try {
        const t = nodemailer.createTransport({ ...srv, auth: { user: smtp.daou_email, pass: smtp.smtp_pass }, connectionTimeout: 8000, greetingTimeout: 8000 });
        await t.verify();
        return res.json({ ok: true, message: `SMTP 연결 성공! (${srv.host}:${srv.port}, ${smtp.daou_email})` });
      } catch (e) { errors.push(`${srv.host}:${srv.port} → ${e.message}`); }
    }
    res.json({ ok: false, error: `모든 SMTP 서버 연결 실패:\n${errors.join('\n')}` });
  } catch (e) {
    res.json({ ok: false, error: `SMTP 테스트 오류: ${e.message}` });
  }
});

router.post('/profile/password', requireLogin, async (req, res) => {
  const { current_pw, new_pw, new_pw2 } = req.body;
  if (new_pw !== new_pw2) return res.redirect(303, '/smart-sa/profile?msg=pw_err');
  const user = await db.getUserByUsername((await getUser(req)).username);
  const { verifyPassword, hashPassword } = require('../db/database');
  // verifyPassword is not exported, check inline
  const [salt, hash] = user.password_hash.split(':');
  const crypto = require('crypto');
  const attempt = crypto.scryptSync(current_pw, salt, 64).toString('hex');
  if (attempt !== hash) return res.redirect(303, '/smart-sa/profile?msg=pw_err');
  const newHash = (() => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(new_pw, s, 64).toString('hex'); })();
  await db.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.session.userId]);
  res.redirect(303, '/smart-sa/profile?msg=pw_ok');
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/smart-sa/login'));
});

// ─── 관리자 비밀번호 초기화 (CRON_SECRET 필요) ───────────────────────
router.get('/reset-password', (req, res) => {
  const secret = req.query.secret || '';
  const msg = req.query.msg || '';
  const validSecret = secret === process.env.CRON_SECRET;

  res.send(layout('비밀번호 초기화', `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#fff7ed,#fef2f2)">
      <div style="width:100%;max-width:420px;padding:16px">
        <div style="text-align:center;margin-bottom:24px">
          <div style="font-size:40px">🔑</div>
          <h1 style="font-size:20px;font-weight:700;color:#111827;margin-top:8px">관리자 비밀번호 초기화</h1>
          <p style="color:#64748b;font-size:13px;margin-top:4px">보안 코드가 있어야 사용 가능합니다</p>
        </div>
        <div class="card">
          <div class="card-body">
            ${msg === 'done' ? '<div class="alert alert-ok">✅ 비밀번호가 초기화되었습니다. 새 비밀번호로 로그인하세요.</div>' : ''}
            ${msg === 'fail' ? '<div class="alert alert-err">❌ 보안 코드가 올바르지 않습니다.</div>' : ''}
            ${msg === 'err' ? '<div class="alert alert-err">❌ 초기화 중 오류가 발생했습니다.</div>' : ''}
            <form method="POST" action="/smart-sa/reset-password">
              <div class="form-group">
                <label>보안 코드 (CRON_SECRET)</label>
                <input name="secret" type="password" required placeholder="보안 코드 입력" value="${validSecret ? secret : ''}">
              </div>
              <div class="form-group">
                <label>새 비밀번호</label>
                <input name="new_password" type="password" required placeholder="새 비밀번호 (8자 이상)" minlength="8">
              </div>
              <div class="form-group">
                <label>새 비밀번호 확인</label>
                <input name="confirm_password" type="password" required placeholder="비밀번호 재입력">
              </div>
              <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:8px;background:#ef4444;border-color:#ef4444">비밀번호 초기화</button>
            </form>
            <div style="text-align:center;margin-top:16px">
              <a href="/smart-sa/login" style="font-size:13px;color:#64748b">← 로그인으로 돌아가기</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  `));
});

router.post('/reset-password', async (req, res) => {
  const { secret, new_password, confirm_password } = req.body;
  if (secret !== process.env.CRON_SECRET) return res.redirect(303, '/smart-sa/reset-password?msg=fail');
  if (new_password !== confirm_password || new_password.length < 8) return res.redirect(303, '/smart-sa/reset-password?msg=err');
  try {
    await db.resetAdminPassword(new_password);
    res.redirect(303, '/smart-sa/reset-password?msg=done');
  } catch (e) {
    console.error('비밀번호 초기화 오류:', e);
    res.redirect(303, '/smart-sa/reset-password?msg=err');
  }
});

// ─── 승인 대기 페이지 ──────────────────────────────────────────────
router.get('/pending', (req, res) => {
  if (!req.session.userId) return res.redirect('/smart-sa/login');
  const isRejected = req.session.approved === -1;
  res.send(layout(isRejected ? '가입 거부' : '승인 대기', `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,${isRejected ? '#fef2f2,#fff1f2' : '#f0f9ff,#f0fdf4'})">
      <div style="width:100%;max-width:420px;padding:16px;text-align:center">
        <div style="font-size:48px;margin-bottom:16px">${isRejected ? '🚫' : '⏳'}</div>
        <h1 style="font-size:22px;font-weight:700;color:#111827;margin-bottom:8px">${isRejected ? '가입이 거부되었습니다' : '승인 대기 중'}</h1>
        <p style="color:#64748b;font-size:14px;line-height:1.7;margin-bottom:24px">
          ${isRejected
            ? '관리자가 가입을 거부하였습니다.<br>문의사항이 있으시면 관리자에게 연락해주세요.'
            : '회원가입이 완료되었습니다.<br>관리자가 승인하면 솔루션을 사용할 수 있습니다.<br>승인 후 다시 로그인해주세요.'}
        </p>
        <a href="/smart-sa/logout" class="btn btn-outline" style="justify-content:center">로그아웃</a>
      </div>
    </div>
  `));
});

// ─── 관리자: 직원 관리 ─────────────────────────────────────────────
router.get('/admin/users', requireLogin, requireAdmin, async (req, res) => {
  const user = await getUser(req);
  const allUsers = await db.getAllUsers();
  const msg = req.query.msg || '';

  // 직원별 광고주 수, 자동입찰 키워드 수 조회
  const userStats = {};
  try {
    const accountCounts = await db.all(`
      SELECT a.user_id, COUNT(*)::int AS account_cnt
      FROM ad_accounts a GROUP BY a.user_id
    `);
    for (const r of accountCounts) userStats[r.user_id] = { accounts: r.account_cnt, autobidKw: 0, shoppingBidKw: 0 };

    const autobidCounts = await db.all(`
      SELECT a.user_id, COUNT(*)::int AS kw_cnt
      FROM auto_bid_keywords abk
      JOIN ad_accounts a ON a.id = abk.account_id
      WHERE abk.enabled = 1
      GROUP BY a.user_id
    `);
    for (const r of autobidCounts) {
      if (!userStats[r.user_id]) userStats[r.user_id] = { accounts: 0, autobidKw: 0, shoppingBidKw: 0 };
      userStats[r.user_id].autobidKw = r.kw_cnt;
    }

    const shoppingBidCounts = await db.all(`
      SELECT a.user_id, COUNT(*)::int AS kw_cnt
      FROM shopping_bid_keywords sbk
      JOIN ad_accounts a ON a.id = sbk.account_id
      WHERE sbk.enabled = 1
      GROUP BY a.user_id
    `);
    for (const r of shoppingBidCounts) {
      if (!userStats[r.user_id]) userStats[r.user_id] = { accounts: 0, autobidKw: 0, shoppingBidKw: 0 };
      userStats[r.user_id].shoppingBidKw = r.kw_cnt;
    }
  } catch (e) { console.log('직원 통계 조회 실패:', e.message); }

  const content = `
    ${msg === 'approved' ? '<div class="alert alert-ok">승인되었습니다.</div>' : ''}
    ${msg === 'rejected' ? '<div class="alert alert-err">거부되었습니다.</div>' : ''}
    ${msg === 'reapproved' ? '<div class="alert alert-ok">재승인되었습니다.</div>' : ''}

    <div class="card" style="margin-bottom:20px">
      <div class="card-header">
        <span class="card-title">⏳ 승인 대기</span>
        <span style="font-size:12px;color:#94a3b8">${allUsers.filter(u => u.approved === 0).length}명</span>
      </div>
      ${allUsers.filter(u => u.approved === 0).length === 0
        ? '<div class="card-body"><div class="empty" style="padding:20px">승인 대기 중인 직원이 없습니다.</div></div>'
        : `<table>
            <thead><tr><th>이름</th><th>아이디</th><th>가입일</th><th style="text-align:center">관리</th></tr></thead>
            <tbody>
              ${allUsers.filter(u => u.approved === 0).map(u => `
                <tr>
                  <td><strong>${u.name}</strong></td>
                  <td style="color:#64748b">${u.username}</td>
                  <td style="font-size:12px;color:#94a3b8">${new Date(u.created_at).toLocaleDateString('ko-KR')}</td>
                  <td style="text-align:center">
                    <form method="POST" action="/smart-sa/admin/users/${u.id}/approve" style="display:inline">
                      <button class="btn btn-primary btn-sm">승인</button>
                    </form>
                    <form method="POST" action="/smart-sa/admin/users/${u.id}/reject" style="display:inline;margin-left:4px">
                      <button class="btn btn-danger btn-sm">거부</button>
                    </form>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>`
      }
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="card-header">
        <span class="card-title">🚫 거부 목록</span>
        <span style="font-size:12px;color:#94a3b8">${allUsers.filter(u => u.approved === -1).length}명</span>
      </div>
      ${allUsers.filter(u => u.approved === -1).length === 0
        ? '<div class="card-body"><div class="empty" style="padding:20px">거부된 직원이 없습니다.</div></div>'
        : `<table>
            <thead><tr><th>이름</th><th>아이디</th><th>가입일</th><th style="text-align:center">관리</th></tr></thead>
            <tbody>
              ${allUsers.filter(u => u.approved === -1).map(u => `
                <tr>
                  <td><strong>${u.name}</strong></td>
                  <td style="color:#64748b">${u.username}</td>
                  <td style="font-size:12px;color:#94a3b8">${new Date(u.created_at).toLocaleDateString('ko-KR')}</td>
                  <td style="text-align:center">
                    <form method="POST" action="/smart-sa/admin/users/${u.id}/approve" style="display:inline">
                      <button class="btn btn-primary btn-sm">재승인</button>
                    </form>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>`
      }
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">👥 전체 직원</span>
        <span style="font-size:12px;color:#94a3b8">${allUsers.filter(u => u.approved === 1).length}명</span>
      </div>
      <table>
        <thead><tr><th>이름</th><th>아이디</th><th>권한</th><th>광고주</th><th>자동입찰</th><th>가입일</th></tr></thead>
        <tbody>
          ${allUsers.filter(u => u.approved === 1).map(u => {
            const st = userStats[u.id] || { accounts: 0, autobidKw: 0, shoppingBidKw: 0 };
            const totalBid = st.autobidKw + st.shoppingBidKw;
            return `
            <tr>
              <td><strong>${u.name}</strong></td>
              <td style="color:#64748b">${u.username}</td>
              <td>${u.is_admin ? '<span class="badge badge-blue">관리자</span>' : '<span class="badge badge-gray">직원</span>'}</td>
              <td style="text-align:center">${st.accounts > 0 ? `<span class="badge badge-green">${st.accounts}개</span>` : '<span style="color:#cbd5e1">-</span>'}</td>
              <td style="text-align:center">${totalBid > 0 ? `<span class="badge badge-blue">${totalBid}개</span>${st.shoppingBidKw > 0 ? `<span style="font-size:11px;color:#94a3b8;margin-left:4px">(쇼핑 ${st.shoppingBidKw})</span>` : ''}` : '<span style="color:#cbd5e1">-</span>'}</td>
              <td style="font-size:12px;color:#94a3b8">${new Date(u.created_at).toLocaleDateString('ko-KR')}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
  res.send(appLayout('직원 관리', content, user, 'admin', await getLayoutOpts(req)));
});

router.post('/admin/users/:id/approve', requireLogin, requireAdmin, async (req, res) => {
  await db.approveUser(req.params.id);
  res.redirect(303, '/smart-sa/admin/users?msg=approved');
});

router.post('/admin/users/:id/reject', requireLogin, requireAdmin, async (req, res) => {
  await db.rejectUser(req.params.id);
  res.redirect(303, '/smart-sa/admin/users?msg=rejected');
});

// ─── 헬퍼 ──────────────────────────────────────────────────────────
async function getUser(req) {
  return db.getUserById(req.session.userId);
}

// 사용자의 API 자격증명으로 특정 광고주(customerId)용 API 클라이언트 생성
// 레이아웃에 전달할 공통 옵션 (광고주 목록 + 선택된 광고주)
async function getLayoutOpts(req) {
  if (!req.session.userId) return {};
  try {
    const accounts = await db.getAccountsByUser(req.session.userId);
    // 세션에 저장된 selectedAccountId가 현재 사용자의 광고주 목록에 존재하는지 검증
    let selId = req.session.selectedAccountId || '';
    if (selId && !accounts.find(a => String(a.id) === String(selId))) {
      // 유효하지 않은 광고주 ID → 무시 (세션 쓰기 실패해도 안전)
      selId = '';
      try { req.session.selectedAccountId = ''; req.session.save(() => {}); } catch(_){}
    }
    return {
      accounts,
      selectedAccountId: selId,
    };
  } catch (e) { return {}; }
}

function makeClient(creds, customerId) {
  return createApiClient({
    apiKey: creds.api_key,
    secretKey: creds.secret_key,
    customerId,
  });
}

// ─── API 설정 페이지 ───────────────────────────────────────────────
router.get('/api-settings', requireLogin, async (req, res) => {
  const user = await getUser(req);
  const creds = await db.getApiCredentials(user.id);
  const msg = req.query.msg || '';

  const content = `
    ${msg === 'need' ? '<div class="alert alert-info">솔루션을 사용하려면 먼저 네이버 검색광고 API 계정을 등록해주세요.</div>' : ''}
    ${msg === 'saved' ? '<div class="alert alert-ok">API 계정이 저장되었습니다.</div>' : ''}
    ${msg === 'invalid' ? '<div class="alert alert-err">API 인증에 실패했습니다. 입력 정보를 확인해주세요.</div>' : ''}

    <div class="card" style="margin-bottom:20px">
      <div class="card-header">
        <span class="card-title">🔑 네이버 검색광고 API 계정</span>
        ${creds ? '<span class="badge badge-green">등록됨</span>' : '<span class="badge badge-gray">미등록</span>'}
      </div>
      <div class="card-body">
        <p style="color:#64748b;font-size:13px;margin-bottom:16px">
          네이버 검색광고 시스템의 API 키를 등록하면, 해당 계정에 연결된 모든 광고주에 접근할 수 있습니다.<br>
          <a href="https://searchad.naver.com" target="_blank" style="color:#6366f1">검색광고 시스템</a> → 도구 → API 사용 관리에서 발급받으세요.<br>
          <strong style="color:#374151">⚠ 솔루션 계정 1개당 대행사 담당자 계정은 1개만 등록할 수 있습니다.</strong> 대행사가 여러 개라면 솔루션 계정을 별도로 생성하세요.
        </p>
        <form method="POST" action="/smart-sa/api-settings">
          <div class="form-group">
            <label>API Key (액세스라이선스) *</label>
            <input name="api_key" required value="${creds?.api_key || ''}" placeholder="01000000-0000-0000-0000-000000000000">
          </div>
          <div class="form-group">
            <label>Secret Key (비밀키) *</label>
            <input name="secret_key" required value="${creds?.secret_key || ''}" placeholder="AQAAAABk...">
          </div>
          <div class="form-group">
            <label>매니저 Customer ID (내 계정 ID) *</label>
            <input name="manager_customer_id" required value="${creds?.manager_customer_id || ''}" placeholder="1234567">
          </div>
          <button class="btn btn-primary">저장</button>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><span class="card-title">📖 설정 안내</span></div>
      <div class="card-body" style="font-size:13px;color:#64748b;line-height:1.8">
        <strong>1단계:</strong> 위에 API 계정 정보를 입력하고 저장합니다.<br>
        <strong>2단계:</strong> <a href="/smart-sa/accounts" style="color:#6366f1">광고주 관리</a> 페이지에서 광고주 목록을 불러옵니다.<br>
        <strong>3단계:</strong> 솔루션을 적용할 광고주를 선택합니다.<br>
        <strong>4단계:</strong> 각 광고주별로 리포트, 자동입찰 등 활용 기능을 설정합니다.
      </div>
    </div>
  `;

  res.send(appLayout('API 설정', content, user, 'api', await getLayoutOpts(req)));
});

router.post('/api-settings', requireLogin, async (req, res) => {
  const { api_key, secret_key, manager_customer_id } = req.body;
  // API 연결 테스트
  try {
    const testClient = createApiClient({ apiKey: api_key, secretKey: secret_key, customerId: manager_customer_id });
    await testClient.getCampaigns();
  } catch (e) {
    console.log('API 테스트 실패:', e.message);
    return res.redirect(303, '/smart-sa/api-settings?msg=invalid');
  }
  // users 테이블 + agency_credentials 둘 다 갱신 (1개 유지)
  await db.updateApiCredentials(req.session.userId, api_key, secret_key, manager_customer_id);
  // 기존 모든 agency_credentials 삭제 후 새로 1개 등록 (1대1 정책)
  try {
    await db.pool.query('DELETE FROM agency_credentials WHERE user_id = $1', [req.session.userId]);
    await db.addAgencyCredential(req.session.userId, { label: '기본 대행사', api_key, secret_key, manager_customer_id });
  } catch (e) { console.warn('agency_credentials 갱신 실패:', e.message); }
  res.redirect(303, '/smart-sa/api-settings?msg=saved');
});

// ─── 광고주 관리 (불러오기 + 선택 + 기능 설정) ──────────────────────
router.get('/accounts', requireLogin, requireApi, async (req, res) => {
  const user = await getUser(req);
  const accounts = await db.getAccountsByUser(user.id);
  const creds = req.apiCreds;
  const msg = req.query.msg || '';

  const content = `
    ${msg === 'saved' ? '<div class="alert alert-ok">저장되었습니다.</div>' : ''}
    ${msg === 'deleted' ? '<div class="alert alert-err">삭제되었습니다.</div>' : ''}
    ${msg === 'added' ? '<div class="alert alert-ok">광고주가 추가되었습니다.</div>' : ''}

    <p style="color:#64748b;font-size:13px;margin-bottom:16px">광고주를 Customer ID로 등록하고, 솔루션 적용 대상을 관리합니다.</p>

    <!-- 광고주 추가 -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-header">
        <span class="card-title">➕ 광고주 추가</span>
      </div>
      <div class="card-body">
        <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:14px 18px;font-size:13px;color:#0369a1;margin-bottom:16px">
          <strong>📌 Customer ID 확인 방법</strong>
          <div style="display:flex;gap:20px;margin-top:10px;flex-wrap:wrap">
            <div style="flex:1;min-width:260px">
              <ol style="margin:0 0 0 16px;line-height:2;color:#0c4a6e">
                <li>네이버 <a href="https://searchad.naver.com" target="_blank" style="color:#0284c7;font-weight:600">검색광고 센터</a>에 로그인</li>
                <li>좌측 메뉴 하단 <strong>도구 → SA API 사용 관리</strong> 클릭</li>
                <li>우측 상단 <strong>검색광고 Key?</strong> 버튼 클릭</li>
                <li>표시된 <strong>CUSTOMER_ID</strong> 숫자를 복사</li>
              </ol>
            </div>
            <div style="flex:0 0 auto;background:#fff;border:1px solid #e0e7ff;border-radius:8px;padding:12px 16px;text-align:center">
              <div style="font-size:11px;color:#64748b;margin-bottom:6px">검색광고 Key? 버튼 위치</div>
              <div style="border:1px solid #e2e8f0;border-radius:6px;padding:8px 14px;font-size:12px;background:#fafbfc">
                <span style="border:1px solid #94a3b8;border-radius:4px;padding:3px 8px;font-size:11px;color:#374151">검색광고 Key ⓘ</span>
                <div style="margin-top:8px;background:#fff;border:1px solid #dc2626;border-radius:4px;padding:6px 10px;text-align:left;font-size:11px">
                  <div style="font-weight:600;color:#374151;margin-bottom:4px">검색광고 Key?</div>
                  <div style="font-family:monospace;font-size:13px;color:#1e293b;background:#f1f5f9;padding:4px 8px;border-radius:3px">242566 📋</div>
                  <div style="margin-top:4px;color:#64748b;font-size:10px;line-height:1.4">검색광고주센터의 대용량보고서와<br>API 서비스에서 사용되는<br>'CUSTOMER_ID' 입니다.</div>
                </div>
              </div>
            </div>
          </div>
          <p style="margin-top:10px;color:#b45309;font-size:12px;background:#fffbeb;padding:6px 10px;border-radius:4px;border:1px solid #fde68a">⚠️ 광고계정 ID(예: 1737106)와 Customer ID(예: 242566)는 서로 다른 값입니다. 반드시 검색광고 Key에서 확인한 값을 입력하세요.</p>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <div style="flex:1;min-width:200px">
            <label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:2px">광고주명</label>
            <input id="add-name" placeholder="예: egojin" style="width:100%;height:42px">
          </div>
          <div style="flex:1;min-width:150px">
            <label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:2px">Customer ID</label>
            <input id="add-cid" placeholder="검색광고 Key에서 확인한 숫자" style="width:100%;height:42px">
          </div>
          <button class="btn btn-primary" id="add-btn" onclick="testAndAddCustomer()" style="height:42px;white-space:nowrap">🔍 확인 및 추가</button>
        </div>
        <div id="add-result" style="margin-top:8px"></div>
      </div>
    </div>

    <!-- 솔루션 적용 광고주 목록 -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-header">
        <span class="card-title">🏢 솔루션 적용 광고주</span>
        <span style="font-size:12px;color:#94a3b8">${accounts.length}개</span>
      </div>
      ${accounts.length === 0
        ? '<div class="empty">위에서 광고주를 추가하여<br>솔루션을 적용할 광고주를 등록해주세요.</div>'
        : `<table>
            <thead><tr><th>광고주명</th><th>Customer ID</th><th>네이버 마스터</th><th>활용 기능</th><th style="text-align:center">관리</th></tr></thead>
            <tbody>
              ${accounts.map(a => {
                const syncBadge = a.sync_status === 'synced'
                  ? `<span class="badge badge-green">동기화 완료</span><br><span style="font-size:10px;color:#94a3b8">캠페인 ${a.campaign_count || 0} / 그룹 ${a.adgroup_count || 0} / 키워드 ${a.keyword_count || 0}</span>`
                  : a.sync_status === 'syncing'
                  ? '<span class="badge badge-blue">동기화 중...</span>'
                  : '<span class="badge badge-gray">미동기화</span>';
                return `
                <tr>
                  <td><strong>${a.name}</strong><br>
                    ${a.has_sa === false ? '' : '<span class="badge" style="background:#dbeafe;color:#1e40af;font-size:10px;margin-right:3px;padding:1px 6px">SA</span>'}
                    ${a.has_da ? '<span class="badge" style="background:#fce7f3;color:#9f1239;font-size:10px;padding:1px 6px">DA</span>' : ''}
                  </td>
                  <td style="font-family:monospace;font-size:13px;color:#64748b">${a.customer_id}</td>
                  <td>
                    ${syncBadge}<br>
                    <button class="btn btn-outline btn-sm" style="margin-top:4px;font-size:11px" onclick="syncMaster(${a.id},'${a.name}',this)">🔄 동기화</button>
                  </td>
                  <td>
                    ${a.feat_daily_report ? '<span class="badge badge-green" style="margin:2px">일간</span>' : ''}
                    ${a.feat_weekly_report ? '<span class="badge badge-green" style="margin:2px">주간</span>' : ''}
                    ${a.feat_monthly_report ? '<span class="badge badge-green" style="margin:2px">월간</span>' : ''}
                    ${a.feat_keyword_monitor ? '<span class="badge badge-blue" style="margin:2px">순위모니터</span>' : ''}
                    ${!a.feat_daily_report && !a.feat_weekly_report && !a.feat_monthly_report && !a.feat_keyword_monitor ? '<span class="badge badge-gray">미설정</span>' : ''}
                  </td>
                  <td style="text-align:center">
                    <a href="/smart-sa/accounts/${a.id}/edit" class="btn btn-outline btn-sm">설정</a>
                    <button class="btn btn-danger btn-sm" style="margin-left:4px" onclick="deleteAccount(${a.id},'${a.name}')">제거</button>
                  </td>
                </tr>
              `}).join('')}
            </tbody>
          </table>`
      }
    </div>

    <!-- 마케터 API 연동 정보 -->
    <div class="card">
      <div class="card-header" style="display:flex;align-items:center;gap:8px">
        <span class="card-title">🔗 마케터 API 연동 정보</span>
        ${creds ? '<span class="badge badge-green">연동됨</span>' : '<span class="badge badge-gray">미연동</span>'}
      </div>
      <div class="card-body" style="font-size:13px">
        ${creds ? `
          <table style="width:100%;max-width:500px">
            <tr>
              <td style="padding:6px 12px;color:#64748b;font-weight:600;width:160px;border-bottom:1px solid #f1f5f9">마케터 Customer ID</td>
              <td style="padding:6px 12px;font-family:monospace;border-bottom:1px solid #f1f5f9">${creds.manager_customer_id}</td>
            </tr>
            <tr>
              <td style="padding:6px 12px;color:#64748b;font-weight:600;border-bottom:1px solid #f1f5f9">API Key</td>
              <td style="padding:6px 12px;font-family:monospace;font-size:11px;border-bottom:1px solid #f1f5f9">${creds.api_key.substring(0, 20)}...</td>
            </tr>
            <tr>
              <td style="padding:6px 12px;color:#64748b;font-weight:600">연동 상태</td>
              <td style="padding:6px 12px"><span class="badge badge-green">정상</span></td>
            </tr>
          </table>
          <p style="margin-top:10px;font-size:12px;color:#94a3b8">
            이 마케터 API로 권한이 부여된 광고주 계정에 접근할 수 있습니다.
            <a href="/smart-sa/api-settings" style="color:#6366f1;margin-left:4px">설정 변경 →</a>
          </p>
        ` : `
          <p style="color:#ef4444">마케터 API가 연동되지 않았습니다. <a href="/smart-sa/api-settings" style="color:#6366f1;font-weight:600">API 설정</a>에서 먼저 등록해주세요.</p>
        `}
      </div>
    </div>

    <script>
    async function testAndAddCustomer() {
      const nameEl = document.getElementById('add-name');
      const cidEl = document.getElementById('add-cid');
      const agencyEl = document.getElementById('add-agency');
      const btn = document.getElementById('add-btn');
      const result = document.getElementById('add-result');
      const name = nameEl.value.trim();
      const customerId = cidEl.value.trim();
      const agencyId = agencyEl ? agencyEl.value : '';

      if (!name || !customerId) {
        result.innerHTML = '<div class="alert alert-err">광고주명과 Customer ID를 모두 입력해주세요.</div>';
        return;
      }

      btn.disabled = true; btn.textContent = '확인 중...';
      result.innerHTML = '<div style="color:#64748b;font-size:13px">🔄 API 접근 권한 확인 중...</div>';

      try {
        const res = await fetch('/smart-sa/api/test-customer', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ customerId, agencyId })
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);

        if (json.accessible) {
          const addRes = await fetch('/smart-sa/api/add-customer', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ customerId, name, agencyId })
          });
          const addJson = await addRes.json();
          if (!addJson.ok) throw new Error(addJson.error);
          result.innerHTML = '<div class="alert alert-ok">✅ ' + name + ' — API 연동 성공!</div>';
          toast(name + ' 광고주가 추가되었습니다.');
          setTimeout(() => location.reload(), 1500);
        } else {
          result.innerHTML = '<div class="alert alert-err">❌ 해당 Customer ID에 API 접근 권한이 없습니다.</div>';
        }
      } catch(e) {
        result.innerHTML = '<div class="alert alert-err">오류: ' + e.message + '</div>';
      } finally {
        btn.disabled = false; btn.textContent = '🔍 확인 및 추가';
      }
    }

    async function syncMaster(accountId, name, btnEl) {
      btnEl.disabled = true; btnEl.textContent = '동기화 중...';
      try {
        const res = await fetch('/smart-sa/api/sync-master', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ accountId })
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        toast(name + ' 네이버 마스터 동기화 완료!');
        setTimeout(() => location.reload(), 1500);
      } catch(e) {
        toast('동기화 실패: ' + e.message, true);
        btnEl.disabled = false; btnEl.textContent = '🔄 동기화';
      }
    }

    async function deleteAccount(id, name) {
      if (!confirm(name+' 광고주를 솔루션에서 제거할까요?')) return;
      const res = await fetch('/smart-sa/accounts/'+id, {method:'DELETE'});
      const json = await res.json();
      if (json.ok) location.href='/smart-sa/accounts?msg=deleted';
      else toast('삭제 실패: '+json.error, true);
    }
    </script>
  `;
  res.send(appLayout('광고주 관리', content, user, 'accounts', { accounts, selectedAccountId: req.session.selectedAccountId || '' }));
});

// API: 연결된 광고주 목록 불러오기
router.get('/api/customer-links', requireLogin, async (req, res) => {
  try {
    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정을 먼저 등록해주세요.' });

    // 특정 Customer ID로 API 접근 가능 여부 테스트
    const client = makeClient(creds, creds.manager_customer_id);
    const campaigns = await client.getCampaigns();
    return res.json({
      ok: true,
      customers: [{
        customerId: parseInt(creds.manager_customer_id),
        customerName: `내 계정 (${creds.manager_customer_id})`,
        campaignCount: campaigns.length,
      }]
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: 광고주 선택 (세션에 저장)
router.post('/api/select-account', requireLogin, (req, res) => {
  const { accountId } = req.body;
  req.session.selectedAccountId = accountId || '';
  req.session.save((err) => {
    if (err) return res.json({ ok: false, error: 'session save failed: ' + err.message });
    res.json({ ok: true });
  });
});

// API: 연동 광고주 자동 조회 (customer-links + 마스터 리포트 기반 스캔)
router.post('/api/list-customers', requireLogin, async (req, res) => {
  try {
    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정을 먼저 등록해주세요.' });

    const customers = [];
    const seenCids = new Set();

    // 1. 마케터 자신의 계정
    try {
      const selfClient = makeClient(creds, creds.manager_customer_id);
      const camps = await selfClient.getCampaigns();
      customers.push({
        customerId: creds.manager_customer_id,
        name: '마케터 계정 (' + creds.manager_customer_id + ')',
        accessible: true,
        campaignCount: camps.length,
      });
      seenCids.add(creds.manager_customer_id);
    } catch (e) {}

    // 2. customer-links API 시도 (매니저 계정용)
    try {
      const client = makeClient(creds, creds.manager_customer_id);
      const links = await client.getCustomerLinks();
      if (Array.isArray(links)) {
        for (const link of links) {
          const cid = String(link.clientCustomerId || link.customerId || link.id);
          if (seenCids.has(cid)) continue;
          seenCids.add(cid);
          let accessible = false;
          let campCount = 0;
          let accountName = link.clientLoginId || link.loginId || cid;
          try {
            const c = makeClient(creds, cid);
            const camps = await c.getCampaigns();
            accessible = true;
            campCount = camps.length;
          } catch (e) {}
          customers.push({ customerId: cid, name: accountName, accessible, campaignCount: campCount });
        }
      }
    } catch (e) {
      // customer-links 미지원 계정 — 무시
    }

    // 3. 추가 Customer ID 스캔 (요청 body에 테스트할 ID 목록 포함 시)
    const { testIds } = req.body || {};
    if (Array.isArray(testIds)) {
      for (const cid of testIds) {
        const cidStr = String(cid).trim();
        if (!cidStr || seenCids.has(cidStr)) continue;
        seenCids.add(cidStr);
        try {
          const c = makeClient(creds, cidStr);
          const camps = await c.getCampaigns();
          // 캠페인 이름에서 공통 접두어 추출하여 광고주명 유추
          let accountName = cidStr;
          if (camps.length > 0) {
            const firstName = camps[0].name || '';
            const match = firstName.match(/^[^_]+_(.+)$/);
            accountName = match ? match[1] : firstName;
          }
          customers.push({ customerId: cidStr, name: accountName, accessible: true, campaignCount: camps.length });
        } catch (e) {
          // 접근 불가 — 스킵
        }
      }
    }

    res.json({ ok: true, customers, source: customers.length > 1 ? 'scan' : 'self' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: 광고주 Customer ID 접근 권한 테스트
router.post('/api/test-customer', requireLogin, async (req, res) => {
  try {
    const { customerId, agencyId } = req.body;
    if (!customerId) return res.status(400).json({ ok: false, error: 'Customer ID를 입력해주세요.' });

    let creds;
    if (agencyId) {
      creds = await db.getAgencyCredentialById(parseInt(agencyId), req.session.userId);
    }
    if (!creds) creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정을 먼저 등록해주세요.' });

    // 해당 Customer ID로 캠페인 조회 시도
    const client = makeClient(creds, String(customerId));
    try {
      const campaigns = await client.getCampaigns();
      return res.json({ ok: true, accessible: true, campaignCount: campaigns.length });
    } catch (apiErr) {
      const status = apiErr.message.match(/\[(\d+)\]/)?.[1];
      if (status === '403') {
        return res.json({ ok: true, accessible: false, error: 'API 접근 권한 없음' });
      }
      return res.json({ ok: true, accessible: false, error: apiErr.message });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: 네이버 마스터 동기화
router.post('/api/sync-master', requireLogin, async (req, res) => {
  try {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ ok: false, error: 'Account ID 필요' });

    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주를 찾을 수 없습니다.' });

    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정을 먼저 등록해주세요.' });

    // 동기화 상태 업데이트
    await db.updateSyncStatus(accountId, 'syncing');

    const client = makeClient(creds, account.customer_id);

    // 캠페인 마스터 동기화
    let campaignCount = 0, adgroupCount = 0, keywordCount = 0;
    try {
      const campRows = await client.syncMaster('Campaign');
      await db.upsertMasterCampaigns(accountId, campRows);
      campaignCount = campRows.length;
    } catch (e) { console.log('캠페인 마스터 동기화 실패:', e.message); }

    // 광고그룹 마스터 동기화
    try {
      const agRows = await client.syncMaster('Adgroup');
      await db.upsertMasterAdgroups(accountId, agRows);
      adgroupCount = agRows.length;
    } catch (e) { console.log('광고그룹 마스터 동기화 실패:', e.message); }

    // 키워드 마스터 동기화
    try {
      const kwRows = await client.syncMaster('Keyword');
      await db.upsertMasterKeywords(accountId, kwRows);
      keywordCount = kwRows.length;
    } catch (e) { console.log('키워드 마스터 동기화 실패:', e.message); }

    await db.updateSyncStatus(accountId, 'synced', {
      campaigns: campaignCount,
      adgroups: adgroupCount,
      keywords: keywordCount,
    });

    res.json({
      ok: true,
      counts: { campaigns: campaignCount, adgroups: adgroupCount, keywords: keywordCount },
    });
  } catch (err) {
    console.error('마스터 동기화 오류:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: 광고주 선택(추가)
router.post('/api/add-customer', requireLogin, async (req, res) => {
  try {
    const { customerId, name, agencyId } = req.body;
    if (!customerId) return res.status(400).json({ ok: false, error: 'Customer ID 필요' });
    const id = await db.addSelectedAccount(req.session.userId, String(customerId), name || String(customerId));
    // 대행사 연결
    if (agencyId) {
      await db.pool.query('UPDATE ad_accounts SET agency_credential_id = $1 WHERE id = $2 AND user_id = $3',
        [parseInt(agencyId), id, req.session.userId]);
    }
    res.json({ ok: true, id });

    // 백그라운드: 60일 데이터 + 마스터 데이터 동기화
    (async () => {
      try {
        const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
        if (!creds) return;
        const account = await db.getAccountById(id, req.session.userId);
        if (!account) return;
        const enriched = { ...account, api_key: creds.api_key, secret_key: creds.secret_key };

        // 1. 마스터 데이터 동기화 (캠페인/광고그룹/키워드 이름)
        try {
          const client = makeClient(creds, account.customer_id);
          const campRows = await client.syncMaster('Campaign');
          await db.upsertMasterCampaigns(id, campRows);
          const agRows = await client.syncMaster('Adgroup');
          await db.upsertMasterAdgroups(id, agRows);
          const kwRows = await client.syncMaster('Keyword');
          await db.upsertMasterKeywords(id, kwRows);
          console.log(`📋 [${name}] 마스터 동기화 완료: 캠페인 ${campRows.length}, 광고그룹 ${agRows.length}, 키워드 ${kwRows.length}`);
        } catch (e) {
          console.log(`⚠️ [${name}] 마스터 동기화 실패:`, e.message);
        }

        // 2. 60일 데이터 백필
        const now = new Date();
        const DAYS = 60;
        let synced = 0;
        for (let i = 1; i <= DAYS; i++) {
          try {
            const d = new Date(now.getTime() + 9 * 60 * 60 * 1000 - i * 24 * 60 * 60 * 1000);
            const dateStr = d.toISOString().slice(0, 10);
            await syncAccountDate(enriched, dateStr);
            synced++;
            if (i % 10 === 0) console.log(`  📥 [${name}] ${synced}/${DAYS}일 동기화 완료...`);
          } catch (e) {
            console.log(`  ⚠️ [${name}] ${i}일전 동기화 실패:`, e.message);
          }
        }
        console.log(`✅ [${name}] 신규 광고주 ${synced}일 데이터 동기화 완료`);
      } catch (e) {
        console.error(`⚠️ [${name}] 신규 광고주 즉시 동기화 실패:`, e.message);
      }
    })();
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 광고주 기능 설정 폼
function accountSettingsForm(account = {}, smtpInfo = {}, user = {}) {
  const v = (k, def = '') => account[k] ?? def;
  const chk = k => account[k] ? 'checked' : '';
  return `
    <form method="POST">
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">📌 광고주 정보</span></div>
        <div class="card-body">
          <div class="form-row">
            <div class="form-group">
              <label>광고주명</label>
              <input name="name" required value="${v('name')}" placeholder="광고주명">
            </div>
            <div class="form-group">
              <label>Customer ID</label>
              <input value="${v('customer_id')}" disabled style="background:#f8fafc;color:#64748b">
            </div>
          </div>
          <div class="form-group">
            <label>비즈채널 URL (자동입찰 순위 매칭용, 쉼표로 구분)</label>
            <input name="site_url" value="${v('site_url')}" placeholder="예: wedrawing.co.kr, smartstore.naver.com/siseongot">
            <p style="font-size:11px;color:#94a3b8;margin-top:4px">네이버 광고주센터 > 구성요소 관리 > 비즈채널에서 웹사이트로 등록된 URL을 입력하세요</p>
          </div>
          <div class="form-group">
            <label>리포트 수신 이메일 (쉼표로 구분)</label>
            <input name="report_emails" value="${v('report_emails')}" placeholder="a@a.com,b@b.com">
          </div>
        </div>
      </div>

      <!-- 광고 유형 선택 (SA / DA) -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">광고 유형 + 데이터 수신 확인</span></div>
        <div class="card-body">
          <p style="font-size:12px;color:#94a3b8;margin:0 0 12px">이 계정에서 집행 중인 광고 유형을 선택하세요. <strong>"확인" 버튼</strong>으로 데이터가 정상 수신되는지 즉시 테스트할 수 있습니다.</p>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">
            <div style="padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0">
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
                <input type="checkbox" name="has_sa" value="1" ${(account.has_sa === false ? '' : 'checked')} style="width:16px;height:16px;flex-shrink:0">
                <div style="flex:1"><div style="font-size:13px;font-weight:500">🔍 SA (검색광고)</div>
                  <div style="font-size:11px;color:#94a3b8">파워링크/쇼핑검색/브랜드/파워콘텐츠</div></div>
              </label>
              <div style="margin-top:10px;display:flex;align-items:center;gap:8px">
                <button type="button" class="btn btn-outline btn-sm" id="check-sa-btn" style="font-size:11px;padding:4px 10px">🔄 확인</button>
                <span id="check-sa-status" style="font-size:11px;color:#94a3b8">미확인</span>
              </div>
            </div>
            <div style="padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0">
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
                <input type="checkbox" name="has_da" value="1" ${account.has_da ? 'checked' : ''} style="width:16px;height:16px;flex-shrink:0">
                <div style="flex:1"><div style="font-size:13px;font-weight:500">📺 DA (디스플레이광고)</div>
                  <div style="font-size:11px;color:#94a3b8">성과형 디스플레이 (GFA)</div></div>
              </label>
              <div style="margin-top:10px;display:flex;align-items:center;gap:8px">
                <button type="button" class="btn btn-outline btn-sm" id="check-da-btn" style="font-size:11px;padding:4px 10px">🔄 확인</button>
                <span id="check-da-status" style="font-size:11px;color:#94a3b8">미확인</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <script>
        (function(){
          var accountId = ${account.id || 'null'};
          async function check(kind){
            var btn = document.getElementById('check-'+kind+'-btn');
            var status = document.getElementById('check-'+kind+'-status');
            btn.disabled = true; var orig = btn.innerHTML; btn.innerHTML = '<span class="spinner"></span> 확인 중...';
            status.textContent = '확인 중...'; status.style.color = '#94a3b8';
            try {
              var res = await fetch('/smart-sa/api/account/check-'+kind+'-status?accountId='+accountId);
              var json = await res.json();
              if (json.status === 'ok') { status.textContent = '✅ ' + json.message; status.style.color = '#16a34a'; }
              else if (json.status === 'disabled') { status.textContent = '⚪ ' + json.message; status.style.color = '#94a3b8'; }
              else { status.textContent = '❌ ' + (json.message || '오류'); status.style.color = '#ef4444'; }
            } catch(e) { status.textContent = '❌ ' + e.message; status.style.color = '#ef4444'; }
            finally { btn.disabled = false; btn.innerHTML = orig; }
          }
          document.getElementById('check-sa-btn').onclick = function(){ check('sa'); };
          document.getElementById('check-da-btn').onclick = function(){ check('da'); };
        })();
      </script>

      <!-- DA 자격증명 (광고관리 쿠키 + XSRF 토큰) -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">📺 DA 연동 정보 (DA 사용 시 필수)</span></div>
        <div class="card-body">
          <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;font-size:12px;color:#78350f;margin-bottom:14px;line-height:1.6">
            <strong>📌 쿠키 확인 방법</strong><br>
            1. <a href="https://ads.naver.com" target="_blank" style="color:#0284c7;font-weight:600">ads.naver.com</a>에 로그인 → 해당 광고주 선택<br>
            2. F12 → <strong>Network</strong> 탭 → 필터에 <code style="background:#fff;padding:1px 4px;border-radius:3px">reportPerformance</code> 입력<br>
            3. 디스플레이 광고 → 보고서 → 성과 보고서 클릭하여 호출 발생<br>
            4. 발생한 요청 → <strong>Headers</strong> 탭 → <strong>Cookie</strong> 헤더 전체 값 복사 → 아래 붙여넣기<br>
            ✅ XSRF 토큰은 쿠키에서 자동 추출됩니다 (별도 입력 불필요)<br>
            ⚠️ 쿠키 만료 시 (보통 며칠) 다시 갱신 필요. 갱신 시 쿠키 전체 재복사.
          </div>
          <div class="form-group">
            <label>DA 광고계정 번호 (ads.naver.com URL의 숫자)</label>
            <input name="da_account_no" value="${v('da_account_no')}" placeholder="예: 2406994" style="font-family:monospace;font-size:12px">
            <p style="font-size:11px;color:#94a3b8;margin-top:4px">URL <code>ads.naver.com/manage/ad-accounts/<strong>2406994</strong>/...</code>의 숫자. Customer ID와 다릅니다.</p>
          </div>
          <div class="form-group">
            <label>광고관리 쿠키 (Cookie 헤더 전체) — XSRF-TOKEN 포함되어야 함</label>
            <textarea name="naver_cookie" rows="5" placeholder="NID_AUT=...; NID_SES=...; JSESSIONID=...; XSRF-TOKEN=..." style="width:100%;font-family:monospace;font-size:11px;resize:vertical">${v('naver_cookie')}</textarea>
          </div>

          <!-- 도움말 이미지 (Admin 업로드, 모든 사용자 조회) -->
          <div class="form-group" style="border-top:1px solid #e5e7eb;padding-top:14px;margin-top:14px">
            <label style="display:flex;align-items:center;gap:8px">📷 DA 설정 도움말 이미지 ${user?.is_admin ? '<span class="badge" style="background:#dbeafe;color:#1e40af;font-size:10px;padding:1px 6px">Admin 업로드</span>' : '<span class="badge badge-gray" style="font-size:10px;padding:1px 6px">Admin만 추가/삭제</span>'}</label>
            <p style="font-size:11px;color:#94a3b8;margin:4px 0 8px">쿠키 갱신 방법, F12 캡처 위치 등을 시각적으로 안내하는 이미지를 업로드합니다.</p>
            <div id="da-helper-images-list" style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px"></div>
            ${user?.is_admin ? `
              <input type="file" id="da-helper-image-input" accept="image/*" style="display:none">
              <button type="button" class="btn btn-outline btn-sm" id="da-helper-upload-btn" style="font-size:12px">+ 이미지 업로드</button>
              <span id="da-helper-upload-status" style="font-size:11px;color:#94a3b8;margin-left:8px"></span>
            ` : ''}
          </div>
        </div>
      </div>
      <script>
        (function(){
          var accountId = ${account.id || 'null'};
          // 전역 도움말 이미지 (모든 광고주 공유)
          var images = ${JSON.stringify(JSON.parse(account._global_da_helper_images || '[]') || [])};
          var isAdmin = ${user?.is_admin ? 'true' : 'false'};
          function openLightbox(src, name){
            var existing = document.getElementById('da-img-lightbox');
            if (existing) existing.remove();
            var lb = document.createElement('div');
            lb.id = 'da-img-lightbox';
            lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:99999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;padding:20px';
            lb.innerHTML = '<div style="position:absolute;top:16px;right:24px;color:#fff;font-size:32px;cursor:pointer;line-height:1;font-weight:300" id="lb-close">×</div>'
              + '<div style="position:absolute;top:20px;left:24px;color:#fff;font-size:13px;background:rgba(0,0,0,0.4);padding:6px 12px;border-radius:6px">'+ (name || '') +'</div>'
              + '<img src="'+src+'" style="max-width:96vw;max-height:92vh;object-fit:contain;border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,0.5);cursor:default" onclick="event.stopPropagation()">';
            document.body.appendChild(lb);
            var close = function(){ lb.remove(); document.removeEventListener('keydown', onKey); };
            var onKey = function(e){ if (e.key === 'Escape') close(); };
            lb.addEventListener('click', close);
            document.getElementById('lb-close').addEventListener('click', close);
            document.addEventListener('keydown', onKey);
          }
          window.__daOpenLightbox = openLightbox;
          function render(){
            var list = document.getElementById('da-helper-images-list');
            if (!list) return;
            if (!images.length) { list.innerHTML = '<div style="color:#94a3b8;font-size:12px;padding:12px;border:1px dashed #e5e7eb;border-radius:8px;width:100%">아직 등록된 도움말 이미지가 없습니다.</div>'; return; }
            list.innerHTML = images.map(function(img, i){
              return '<div style="position:relative;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:#fff;width:200px"><img src="'+img.src+'" alt="'+(img.name||'')+'" data-lb-idx="'+i+'" style="width:100%;height:140px;object-fit:cover;cursor:zoom-in"><div style="padding:6px 8px;font-size:11px;color:#475569;display:flex;justify-content:space-between;align-items:center"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px">'+(img.name||'image_'+(i+1))+'</span>'+(isAdmin?'<button type="button" data-del="'+i+'" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px;padding:0">×</button>':'')+'</div></div>';
            }).join('');
            // 이미지 클릭 → 라이트박스
            list.querySelectorAll('[data-lb-idx]').forEach(function(im){
              im.onclick = function(){
                var idx = parseInt(im.dataset.lbIdx);
                var it = images[idx]; if (it) openLightbox(it.src, it.name);
              };
            });
            if (isAdmin) {
              list.querySelectorAll('[data-del]').forEach(function(b){
                b.onclick = function(e){
                  e.stopPropagation();
                  var idx = parseInt(b.dataset.del);
                  if (!confirm('이미지를 삭제하시겠습니까?')) return;
                  images.splice(idx, 1); save();
                };
              });
            }
          }
          function save(){
            fetch('/smart-sa/api/account/da-helper-images', {
              method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({ images: images })
            }).then(function(r){ return r.json(); }).then(function(j){
              if (j.ok) { render(); }
              else { alert('저장 실패: '+(j.error||'')); }
            });
          }
          if (isAdmin) {
            var btn = document.getElementById('da-helper-upload-btn');
            var input = document.getElementById('da-helper-image-input');
            var status = document.getElementById('da-helper-upload-status');
            if (btn && input) {
              btn.onclick = function(){ input.click(); };
              input.onchange = function(){
                var file = input.files[0]; if (!file) return;
                if (file.size > 1024*1024) { status.textContent='⚠️ 1MB 이하만 허용'; status.style.color='#ef4444'; return; }
                status.textContent = '업로드 중...'; status.style.color = '#94a3b8';
                var reader = new FileReader();
                reader.onload = function(e){
                  images.push({ name: file.name, src: e.target.result });
                  save();
                  input.value = '';
                  status.textContent = '업로드 완료'; status.style.color = '#16a34a';
                  setTimeout(function(){ status.textContent = ''; }, 2000);
                };
                reader.readAsDataURL(file);
              };
            }
          }
          render();
        })();
      </script>

      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">이메일 발송 설정</span></div>
        <div class="card-body">
          <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:14px 18px;margin-bottom:16px">
            <div style="font-size:13px;font-weight:600;color:#b45309">⚠️ 다우오피스 비밀번호 변경 시 주의</div>
            <div style="font-size:12px;color:#78350f;margin-top:4px">다우오피스 계정 비밀번호를 변경한 경우, 리포트 이메일 발송이 실패할 수 있습니다.</div>
            <div style="font-size:12px;color:#78350f;margin-top:2px">비밀번호 변경 후 <a href="/smart-sa/profile" style="color:#0284c7;font-weight:600">내 정보</a>에서 다우오피스 비밀번호를 업데이트해주세요.</div>
            <div style="font-size:12px;color:#64748b;margin-top:6px">발신: <strong>${smtpInfo?.daou_email || '미설정'}</strong> → 수신: 위 리포트 수신 이메일</div>
          </div>
          <input type="hidden" name="email_host" value="${v('email_host','outbound.daouoffice.com')}">
          <input type="hidden" name="email_port" value="${v('email_port',465)}">
          <input type="hidden" name="email_user" value="${v('email_user','')}">
          <input type="hidden" name="email_pass" value="${v('email_pass','')}">
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">활용 기능 ON/OFF</span></div>
        <div class="card-body" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
          ${[
            ['feat_daily_report','일간 리포트 자동발송','매일 08:00'],
            ['feat_weekly_report','주간 리포트 자동발송','월요일 09:00'],
            ['feat_monthly_report','월간 리포트 자동발송','매월 1일 09:00'],
            ['feat_keyword_monitor','키워드 순위 모니터',''],
          ].map(([k,label,desc]) => `
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:10px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0">
              <input type="checkbox" name="${k}" ${chk(k)} style="width:16px;height:16px;flex-shrink:0">
              <div>
                <div style="font-size:13px;font-weight:500">${label}</div>
                ${desc ? `<div style="font-size:11px;color:#94a3b8">${desc}</div>` : ''}
              </div>
            </label>
          `).join('')}
        </div>
      </div>

      <div style="display:flex;gap:10px">
        <button class="btn btn-primary">저장</button>
        <a href="/smart-sa/accounts" class="btn btn-outline">취소</a>
      </div>
    </form>
  `;
}

router.get('/accounts/:id/edit', requireLogin, async (req, res) => {
  const user = await getUser(req);
  const account = await db.getAccountById(req.params.id, user.id);
  if (!account) return res.redirect('/smart-sa/accounts');
  ['feat_daily_report','feat_weekly_report','feat_monthly_report','feat_keyword_monitor']
    .forEach(k => { account[k] = !!account[k]; });
  const smtpInfo = await db.getSmtpCredentials(user.id);
  // 전역 DA 도움말 이미지 (system_settings)
  const settingRow = await db.get('SELECT value FROM system_settings WHERE key = $1', ['da_helper_images']).catch(() => null);
  account._global_da_helper_images = settingRow?.value || '[]';
  res.send(appLayout(account.name + ' 설정', accountSettingsForm(account, smtpInfo, user), user, 'accounts', await getLayoutOpts(req)));
});

router.post('/accounts/:id/edit', requireLogin, async (req, res) => {
  const user = await getUser(req);
  const data = { ...req.body };
  ['feat_daily_report','feat_weekly_report','feat_monthly_report','feat_keyword_monitor']
    .forEach(k => { data[k] = k in req.body; });
  // SA/DA 체크박스 (체크 안 하면 키 자체가 안 옴)
  data.has_sa = 'has_sa' in req.body;
  data.has_da = 'has_da' in req.body;
  await db.updateAccount(req.params.id, user.id, data);
  res.redirect(303, '/smart-sa/accounts?msg=saved');
});

// DA 도움말 이미지 저장 (admin만, 전역 공유)
router.post('/api/account/da-helper-images', requireLogin, async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user?.is_admin) return res.status(403).json({ ok: false, error: '관리자 권한 필요' });
    const { images } = req.body;
    if (!Array.isArray(images)) return res.status(400).json({ ok: false, error: 'images 배열 필요' });
    // 안전 제한: 최대 15장, 총 15MB
    const total = images.reduce((s, i) => s + (i?.src?.length || 0), 0);
    if (images.length > 15) return res.status(400).json({ ok: false, error: '최대 15장' });
    if (total > 15 * 1024 * 1024) return res.status(400).json({ ok: false, error: '총 용량 15MB 초과' });
    const json = JSON.stringify(images);
    // system_settings에 저장 (전역 공유)
    await db.pool.query(`
      INSERT INTO system_settings (key, value, updated_at) VALUES ('da_helper_images', $1, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP
    `, [json]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DA 데이터 수신 확인 (즉시 호출 → 정상 여부 반환)
router.get('/api/account/check-da-status', requireLogin, async (req, res) => {
  try {
    const { accountId } = req.query;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    if (!account.has_da) return res.json({ ok: true, status: 'disabled', message: 'DA 비활성 계정' });
    if (!account.naver_cookie) return res.json({ ok: false, status: 'no_cookie', message: '쿠키 미등록' });
    const adAccountNo = account.da_account_no || account.customer_id;
    if (!adAccountNo) return res.json({ ok: false, status: 'no_account_no', message: 'DA 광고계정 번호 미등록' });
    const { fetchReportPerformance } = require('../api/naverDaApi');
    const today = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    try {
      const rows = await fetchReportPerformance({
        adAccountNo, cookie: account.naver_cookie,
        startDate: today, endDate: today,
        reportAdUnit: 'AD_ACCOUNT',
      });
      res.json({ ok: true, status: 'ok', message: `정상 수신 (${rows.length}건)`, sampleCount: rows.length });
    } catch (err) {
      res.json({ ok: false, status: 'auth_fail', message: err.message });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// SA 데이터 수신 확인
router.get('/api/account/check-sa-status', requireLogin, async (req, res) => {
  try {
    const { accountId } = req.query;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    if (account.has_sa === false) return res.json({ ok: true, status: 'disabled', message: 'SA 비활성 계정' });
    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.json({ ok: false, status: 'no_creds', message: 'API 자격증명 미등록' });
    if (!account.customer_id) return res.json({ ok: false, status: 'no_cid', message: 'Customer ID 미등록' });
    try {
      const { createApiClient } = require('../api/naverApi');
      const client = createApiClient({ apiKey: creds.api_key, secretKey: creds.secret_key, customerId: account.customer_id });
      const today = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const stats = await client.getStats({ startDate: today, endDate: today });
      const cnt = stats?.campStats?.length || 0;
      res.json({ ok: true, status: 'ok', message: `정상 수신 (캠페인 ${cnt}개)`, sampleCount: cnt });
    } catch (err) {
      res.json({ ok: false, status: 'auth_fail', message: err.message });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete('/accounts/:id', requireLogin, async (req, res) => {
  const user = await getUser(req);
  await db.deleteAccount(req.params.id, user.id);
  res.json({ ok: true });
});

// ─── DA 성과 대시보드 ──────────────────────────────────────────────
router.get('/da-dashboard', requireLogin, async (req, res) => {
  if (!FEATURES.DA) {
    const user = await getUser(req);
    const layoutOpts = await getLayoutOpts(req);
    return res.send(appLayout('DA 성과 대시보드', `
      <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:12px;padding:32px;text-align:center;color:#92400e;max-width:640px;margin:40px auto">
        <div style="font-size:18px;font-weight:700;margin-bottom:8px">DA 성과 대시보드는 현재 비활성화되어 있습니다</div>
        <div style="font-size:14px;line-height:1.7">네이버 DA(GFA)는 로그인 세션 쿠키 기반이라 토큰 자동 갱신이 불가능해,<br>공식 GFA 마케팅 API 연동 완료 시까지 잠시 중단합니다.<br>대신 <b>자동리포트</b>와 <b>원클릭 계정분석 제안</b>을 이용해주세요.</div>
      </div>`, user, '', layoutOpts));
  }
  const user = await getUser(req);
  const layoutOpts = await getLayoutOpts(req);
  const selId = layoutOpts.selectedAccountId || '';
  const selAccount = selId ? (layoutOpts.accounts || []).find(a => String(a.id) === String(selId)) : null;

  // DA 미설정 안내
  if (!selAccount) {
    return res.send(appLayout('DA 성과 대시보드', `
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:32px;text-align:center;color:#64748b">
        사이드바에서 DA가 활성화된 광고주를 선택해주세요.
      </div>`, user, 'da-dashboard', layoutOpts));
  }
  if (!selAccount.has_da) {
    return res.send(appLayout('DA 성과 대시보드', `
      <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:12px;padding:32px;text-align:center;color:#78350f">
        <div style="font-size:48px;margin-bottom:8px">📺</div>
        <strong>${selAccount.name}</strong>은(는) DA가 활성화되지 않은 계정입니다.<br>
        <a href="/smart-sa/accounts/${selAccount.id}/edit" style="color:#0284c7;font-weight:600">광고주 설정</a>에서 "광고 유형 → DA"를 체크해주세요.
      </div>`, user, 'da-dashboard', layoutOpts));
  }
  if (!selAccount.naver_cookie) {
    return res.send(appLayout('DA 성과 대시보드', `
      <div style="background:#fee2e2;border:1px solid #fecaca;border-radius:12px;padding:32px;text-align:center;color:#7f1d1d">
        <div style="font-size:48px;margin-bottom:8px">🔒</div>
        DA 광고관리 쿠키가 등록되지 않았습니다.<br>
        <a href="/smart-sa/accounts/${selAccount.id}/edit" style="color:#0284c7;font-weight:600">광고주 설정</a>에서 등록해주세요.
      </div>`, user, 'da-dashboard', layoutOpts));
  }

  const content = `
    <!-- 기간 선택 -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <div class="period-tabs">
          <button class="period-btn active" data-period="yesterday">어제</button>
          <button class="period-btn" data-period="7days">최근 7일</button>
          <button class="period-btn" data-period="30days">최근 30일</button>
          <button class="period-btn" data-period="lastMonth">전월</button>
          <button class="period-btn" id="da-custom-period-btn" data-period="custom">기간 선택</button>
        </div>
        <div id="da-custom-date-wrap" style="display:none;align-items:center;gap:6px">
          <input type="date" id="da-date-start" style="padding:6px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px">
          <span>~</span>
          <input type="date" id="da-date-end" style="padding:6px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px">
          <button class="btn btn-outline btn-sm" onclick="daApplyCustomDate()">적용</button>
        </div>
        <span style="color:#64748b;font-size:12px">현재 광고주: <strong>${selAccount.name}</strong> (${selAccount.customer_id})</span>
      </div>
    </div>

    <!-- 탭 메뉴 -->
    <div class="tab-bar" style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
      <div style="display:flex;flex-wrap:wrap">
      ${['summary','campaigns','adgroups','creatives','gender','age','placement'].map((tab, i) => {
        const labels = ['요약','캠페인별','그룹별','소재별','성별','연령대','노출지면'];
        return `<button class="tab-btn dash-tab ${i===0?'active':''}" data-tab="${tab}" onclick="daSwitchTab('${tab}')">${labels[i]}</button>`;
      }).join('')}
      </div>
      <button id="da-csv-btn" class="btn btn-outline btn-sm" onclick="daDownloadCsv()" style="font-size:12px;padding:6px 12px;display:none">📥 CSV 다운로드</button>
    </div>

    <div id="da-tab-summary" class="da-tab-content">
      <!-- 성과지표 추이 차트 (3개 지표 동시) -->
      <div class="card" style="margin-bottom:20px">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <span class="card-title">성과지표 추이 (일별)</span>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11px">
            <div style="display:flex;align-items:center;gap:5px">
              <span style="width:8px;height:8px;border-radius:50%;background:#ef4444;display:inline-block"></span>
              <select id="da-trend-metric-1" style="border:1px solid #e2e8f0;border-radius:6px;padding:3px 6px;font-size:11px;background:#fff;cursor:pointer">
                <option value="cost" selected>총비용</option><option value="imp">노출수</option><option value="clk">클릭수</option><option value="ctr">CTR</option>
                <option value="purchaseConvSales">구매매출</option><option value="purchaseConvCount">구매전환</option><option value="purchaseRoas">구매ROAS</option>
              </select>
            </div>
            <div style="display:flex;align-items:center;gap:5px">
              <span style="width:8px;height:8px;border-radius:50%;background:#16a34a;display:inline-block"></span>
              <select id="da-trend-metric-2" style="border:1px solid #e2e8f0;border-radius:6px;padding:3px 6px;font-size:11px;background:#fff;cursor:pointer">
                <option value="cost">총비용</option><option value="imp">노출수</option><option value="clk">클릭수</option><option value="ctr">CTR</option>
                <option value="purchaseConvSales" selected>구매매출</option><option value="purchaseConvCount">구매전환</option><option value="purchaseRoas">구매ROAS</option>
              </select>
            </div>
            <div style="display:flex;align-items:center;gap:5px">
              <span style="width:8px;height:8px;border-radius:50%;background:#3b82f6;display:inline-block"></span>
              <select id="da-trend-metric-3" style="border:1px solid #e2e8f0;border-radius:6px;padding:3px 6px;font-size:11px;background:#fff;cursor:pointer">
                <option value="">선택안함</option><option value="cost">총비용</option><option value="imp">노출수</option><option value="clk">클릭수</option><option value="ctr">CTR</option>
                <option value="purchaseConvSales">구매매출</option><option value="purchaseConvCount">구매전환</option><option value="purchaseRoas" selected>구매ROAS</option>
              </select>
            </div>
          </div>
        </div>
        <div class="card-body">
          <div id="da-trend-chart" style="min-height:240px"><div class="empty"><span class="spinner"></span> 추이 데이터 로딩...</div></div>
        </div>
      </div>

      <div class="kpi-grid" id="da-kpi-grid">
        ${['노출수','클릭수','CTR','총비용','구매전환','구매전환매출','구매ROAS','전환수']
          .map(l => `<div class="kpi-card"><div class="kpi-label">${l}</div><div class="kpi-value" style="color:#e5e7eb">—</div></div>`).join('')}
      </div>

      <!-- 캠페인별 비용 vs 구매매출 -->
      <div class="card" style="margin-top:20px">
        <div class="card-header"><span class="card-title">캠페인별 비용 vs 구매매출</span></div>
        <div class="card-body">
          <div id="da-camp-bars"><div class="empty"><span class="spinner"></span> 캠페인 데이터 로딩...</div></div>
        </div>
      </div>
    </div>
    <div id="da-tab-campaigns" class="da-tab-content" style="display:none"><div id="da-campaigns-content"><div class="empty">탭을 선택하면 데이터를 로딩합니다.</div></div></div>
    <div id="da-tab-adgroups" class="da-tab-content" style="display:none"><div id="da-adgroups-content"><div class="empty">탭을 선택하면 데이터를 로딩합니다.</div></div></div>
    <div id="da-tab-creatives" class="da-tab-content" style="display:none"><div id="da-creatives-content"><div class="empty">탭을 선택하면 데이터를 로딩합니다.</div></div></div>
    <div id="da-tab-gender" class="da-tab-content" style="display:none"><div id="da-gender-content"><div class="empty">탭을 선택하면 데이터를 로딩합니다.</div></div></div>
    <div id="da-tab-age" class="da-tab-content" style="display:none"><div id="da-age-content"><div class="empty">탭을 선택하면 데이터를 로딩합니다.</div></div></div>
    <div id="da-tab-placement" class="da-tab-content" style="display:none"><div id="da-placement-content"><div class="empty">탭을 선택하면 데이터를 로딩합니다.</div></div></div>

    <script>
    var daAccountId = '${selId}';
    var daPeriod = 'yesterday';
    var daCustomStart = '', daCustomEnd = '';
    var daCurrentTab = 'summary';
    var daTabLoaded = {};
    var daRawData = {}; // 탭별 원본 데이터 캐시 (CSV용)

    function daNum(v){return Number(v||0).toLocaleString('ko-KR')}
    function daWon(v){return '₩'+Number(v||0).toLocaleString('ko-KR')}
    function daPct(v){return Number(v||0).toFixed(2)+'%'}
    function daRoas(v){var n=Number(v||0);return '<span style="color:'+(n>=100?'#16a34a':'#ef4444')+';font-weight:600">'+n.toFixed(2)+'%</span>';}

    // ─── DA 컬럼/정렬 프레임워크 (SA와 분리) ───
    var DA_COL_DEFS = {};
    var DA_COL_STATE = {};
    var DA_SORT_STATE = {};
    var DA_RERENDER = {};
    function daRegisterCols(tabId, defaults){
      DA_COL_DEFS[tabId] = defaults;
      var defs = defaults.map(function(c){return Object.assign({}, c);});
      try {
        var saved = JSON.parse(localStorage.getItem('smartDa.colOrder.'+tabId)||'null');
        if (Array.isArray(saved) && saved.length>0){
          var byKey={}; defs.forEach(function(d){byKey[d.key]=d;});
          var ordered=[], seen={};
          saved.forEach(function(s){ if(byKey[s.key]){ var d=byKey[s.key]; if(typeof s.visible==='boolean') d.visible=s.visible; ordered.push(d); seen[s.key]=true; }});
          defs.forEach(function(d){if(!seen[d.key]) ordered.push(d);});
          defs = ordered;
        }
      } catch(e){}
      DA_COL_STATE[tabId] = defs;
    }
    function daSaveCols(tabId){
      try {
        var snap = DA_COL_STATE[tabId].map(function(c){return {key:c.key, visible:c.visible!==false};});
        localStorage.setItem('smartDa.colOrder.'+tabId, JSON.stringify(snap));
      } catch(e){}
    }
    function daGetVisibleCols(tabId){ return (DA_COL_STATE[tabId]||[]).filter(function(c){return c.visible!==false;}); }
    function daApplySort(tabId, items){
      var st = DA_SORT_STATE[tabId];
      if (!st || !st.field) return items;
      var col = (DA_COL_DEFS[tabId]||[]).find(function(c){return c.key===st.field;});
      var isStr = col && col.tp==='s';
      var dir = st.dir==='asc'?1:-1;
      return items.slice().sort(function(a,b){
        var va=a[st.field], vb=b[st.field];
        if (isStr) return ((va||'').toString().localeCompare((vb||'').toString())) * dir;
        return ((Number(va)||0)-(Number(vb)||0)) * dir;
      });
    }
    function daRenderColTable(tabId, items){
      var cols = daGetVisibleCols(tabId);
      var sorted = daApplySort(tabId, items);
      var st = DA_SORT_STATE[tabId]||{};
      var html = '<table style="table-layout:auto"><thead><tr>';
      for (var i=0;i<cols.length;i++){
        var c=cols[i]; var isR=c.tp==='n';
        var arr = (st.field===c.key)?(st.dir==='asc'?' ▲':' ▼'):'';
        html += '<th data-da-sort="'+tabId+'" data-sort-field="'+c.key+'" style="cursor:pointer;user-select:none;'+(isR?'text-align:right;':'')+'white-space:nowrap">'+c.label+arr+'</th>';
      }
      html += '</tr></thead><tbody>';
      for (var j=0;j<sorted.length;j++){
        var row=sorted[j];
        html += '<tr>';
        for (var k=0;k<cols.length;k++) html += cols[k].render(row);
        html += '</tr>';
      }
      html += '</tbody></table>';
      return html;
    }
    if (!window.__daSortBound){
      window.__daSortBound = true;
      document.addEventListener('click', function(e){
        var th = e.target && (e.target.tagName==='TH' ? e.target : (e.target.closest && e.target.closest('th[data-da-sort]')));
        if (!th || !th.dataset || !th.dataset.daSort) return;
        var tabId=th.dataset.daSort; var field=th.dataset.sortField;
        var st=DA_SORT_STATE[tabId];
        if (st && st.field===field) st.dir = st.dir==='desc'?'asc':'desc';
        else {
          var col=(DA_COL_DEFS[tabId]||[]).find(function(c){return c.key===field;});
          DA_SORT_STATE[tabId] = { field:field, dir: col && col.tp==='s' ? 'asc' : 'desc' };
        }
        var rer = DA_RERENDER[tabId]; if (typeof rer==='function') rer();
      });
    }
    function daOpenColSettings(tabId, onApply){
      var existing = document.getElementById('da-col-modal-'+tabId);
      if (existing) existing.remove();
      var working = (DA_COL_STATE[tabId]||[]).map(function(c){return {key:c.key, label:c.label, visible:c.visible!==false};});
      var modal = document.createElement('div');
      modal.id = 'da-col-modal-'+tabId;
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:9999;display:flex;align-items:center;justify-content:center';
      modal.innerHTML = '<div style="background:#fff;width:420px;max-width:92vw;max-height:85vh;display:flex;flex-direction:column;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.2);overflow:hidden">'
        + '<div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #e2e8f0">'
        +   '<div><div style="font-size:16px;font-weight:700;color:#0f172a">열 맞춤 설정</div><div style="font-size:12px;color:#94a3b8;margin-top:2px">드래그 순서 변경, 체크 표시/숨김</div></div>'
        +   '<button class="da-modal-close" style="background:none;border:none;font-size:22px;cursor:pointer;color:#64748b;padding:0">×</button></div>'
        + '<div class="da-modal-list" style="padding:12px 16px;overflow-y:auto;flex:1"></div>'
        + '<div style="display:flex;gap:8px;justify-content:space-between;padding:14px 20px;border-top:1px solid #e2e8f0;background:#f8fafc">'
        +   '<button class="da-modal-reset btn btn-outline" style="font-size:13px;padding:8px 14px">기본값 복원</button>'
        +   '<div style="display:flex;gap:8px"><button class="da-modal-cancel btn btn-outline" style="font-size:13px;padding:8px 14px">취소</button>'
        +   '<button class="da-modal-save btn btn-primary" style="font-size:13px;padding:8px 18px">적용</button></div>'
        + '</div></div>';
      document.body.appendChild(modal);
      var listEl = modal.querySelector('.da-modal-list');
      function renderList(){
        listEl.innerHTML = working.map(function(c, idx){
          return '<div class="da-col-row" draggable="true" data-idx="'+idx+'" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:6px;background:#fff;cursor:move">'
            + '<span style="color:#94a3b8;font-size:12px">⋮⋮</span>'
            + '<input type="checkbox" '+(c.visible?'checked':'')+' data-vis-idx="'+idx+'" style="cursor:pointer;accent-color:#6366f1">'
            + '<span style="flex:1;font-size:13px">'+c.label+'</span></div>';
        }).join('');
      }
      renderList();
      // 드래그 정렬
      var dragIdx = null;
      listEl.addEventListener('dragstart', function(e){ var r=e.target.closest('.da-col-row'); if(r){ dragIdx=parseInt(r.dataset.idx); e.dataTransfer.effectAllowed='move'; }});
      listEl.addEventListener('dragover', function(e){ e.preventDefault(); });
      listEl.addEventListener('drop', function(e){
        e.preventDefault();
        var r=e.target.closest('.da-col-row'); if(!r||dragIdx===null) return;
        var dropIdx = parseInt(r.dataset.idx);
        if (dragIdx===dropIdx) return;
        var moved = working.splice(dragIdx,1)[0];
        working.splice(dropIdx,0,moved);
        dragIdx = null; renderList();
      });
      listEl.addEventListener('change', function(e){
        if (e.target.matches('input[type=checkbox]')){ var i=parseInt(e.target.dataset.visIdx); if(working[i]) working[i].visible=e.target.checked; }
      });
      modal.querySelector('.da-modal-close').onclick = function(){ modal.remove(); };
      modal.querySelector('.da-modal-cancel').onclick = function(){ modal.remove(); };
      modal.querySelector('.da-modal-reset').onclick = function(){
        working = (DA_COL_DEFS[tabId]||[]).map(function(c){return {key:c.key, label:c.label, visible:true};});
        renderList();
      };
      modal.querySelector('.da-modal-save').onclick = function(){
        var byKey = {}; (DA_COL_STATE[tabId]||[]).forEach(function(c){byKey[c.key]=c;});
        var newDefs = working.map(function(w){ var d=byKey[w.key]; if(d){ d.visible=w.visible; return d;} return null; }).filter(Boolean);
        DA_COL_STATE[tabId] = newDefs;
        daSaveCols(tabId);
        modal.remove();
        if (typeof onApply==='function') onApply();
      };
    }

    // ─── DA 컬럼 정의 ───
    var DA_CAMPAIGN_COLS = [
      { key:'campaignName', label:'캠페인', tp:'s', visible:true, render:function(r){
        var b=''; if(r.campaignObjective){
          var map={PMAX:['#dbeafe','#1e40af','PMAX'],CATALOG:['#fef3c7','#92400e','카탈로그'],CONVERSION:['#dcfce7','#166534','전환'],TRAFFIC:['#e0e7ff','#3730a3','트래픽'],REACH:['#fce7f3','#9f1239','도달'],VIDEO_VIEWS:['#ffedd5','#9a3412','동영상']};
          var m=map[r.campaignObjective]||['#f1f5f9','#475569',r.campaignObjective];
          b=' <span class="badge" style="background:'+m[0]+';color:'+m[1]+';font-size:10px;padding:1px 6px">'+m[2]+'</span>';
        }
        return '<td style="white-space:nowrap"><strong>'+(r.campaignName||'-')+'</strong>'+b+'</td>';
      }},
      { key:'imp', label:'노출', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap">'+daNum(r.imp)+'</td>';}},
      { key:'clk', label:'클릭', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap;color:#2563eb;font-weight:600">'+daNum(r.clk)+'</td>';}},
      { key:'ctr', label:'CTR', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap">'+daPct(r.ctr)+'</td>';}},
      { key:'cost', label:'총비용', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap">'+daWon(r.cost)+'</td>';}},
      { key:'cpc', label:'CPC', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap">'+daWon(r.cpc)+'</td>';}},
      { key:'convCount', label:'전환', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap">'+daNum(r.convCount)+'</td>';}},
      { key:'purchaseConvCount', label:'구매전환', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap;color:#7c3aed;font-weight:600">'+daNum(r.purchaseConvCount)+'</td>';}},
      { key:'purchaseConvSales', label:'구매매출', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap;color:#16a34a;font-weight:600">'+daWon(r.purchaseConvSales)+'</td>';}},
      { key:'purchaseRoas', label:'구매ROAS', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap">'+daRoas(r.purchaseRoas)+'</td>';}},
      { key:'resultCount', label:'결과', tp:'n', visible:false, render:function(r){return '<td style="text-align:right;white-space:nowrap;font-size:11px;color:#64748b">'+daNum(r.resultCount)+' '+(r.resultString||'')+'</td>';}},
    ];
    daRegisterCols('campaigns', DA_CAMPAIGN_COLS);

    var DA_ADGROUP_COLS = [
      { key:'campaignName', label:'캠페인', tp:'s', visible:true, render:function(r){return '<td style="white-space:nowrap;font-size:12px;color:#6b7280">'+(r.campaignName||'-')+'</td>';}},
      { key:'adSetName', label:'광고그룹', tp:'s', visible:true, render:function(r){return '<td style="white-space:nowrap"><strong>'+(r.adSetName||r.assetGroupName||'-')+'</strong></td>';}},
      { key:'imp', label:'노출', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap">'+daNum(r.imp)+'</td>';}},
      { key:'clk', label:'클릭', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap;color:#2563eb;font-weight:600">'+daNum(r.clk)+'</td>';}},
      { key:'ctr', label:'CTR', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap">'+daPct(r.ctr)+'</td>';}},
      { key:'cost', label:'총비용', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap">'+daWon(r.cost)+'</td>';}},
      { key:'cpc', label:'CPC', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap">'+daWon(r.cpc)+'</td>';}},
      { key:'convCount', label:'전환', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap">'+daNum(r.convCount)+'</td>';}},
      { key:'purchaseConvCount', label:'구매전환', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap;color:#7c3aed;font-weight:600">'+daNum(r.purchaseConvCount)+'</td>';}},
      { key:'purchaseConvSales', label:'구매매출', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap;color:#16a34a;font-weight:600">'+daWon(r.purchaseConvSales)+'</td>';}},
      { key:'purchaseRoas', label:'구매ROAS', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap">'+daRoas(r.purchaseRoas)+'</td>';}},
    ];
    daRegisterCols('adgroups', DA_ADGROUP_COLS);

    var DA_CREATIVE_COLS = [
      { key:'campaignName', label:'캠페인', tp:'s', visible:true, render:function(r){return '<td style="white-space:nowrap;font-size:12px;color:#6b7280">'+(r.campaignName||'-')+'</td>';}},
      { key:'adSetName', label:'광고그룹', tp:'s', visible:true, render:function(r){return '<td style="white-space:nowrap;font-size:12px;color:#6b7280">'+(r.adSetName||r.assetGroupName||'-')+'</td>';}},
      { key:'creativeName', label:'소재', tp:'s', visible:true, render:function(r){return '<td style="white-space:nowrap"><strong>'+(r.creativeName||'-')+'</strong></td>';}},
      { key:'imp', label:'노출', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap">'+daNum(r.imp)+'</td>';}},
      { key:'clk', label:'클릭', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap;color:#2563eb;font-weight:600">'+daNum(r.clk)+'</td>';}},
      { key:'ctr', label:'CTR', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap">'+daPct(r.ctr)+'</td>';}},
      { key:'cost', label:'총비용', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap">'+daWon(r.cost)+'</td>';}},
      { key:'cpc', label:'CPC', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap">'+daWon(r.cpc)+'</td>';}},
      { key:'convCount', label:'전환', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap">'+daNum(r.convCount)+'</td>';}},
      { key:'purchaseConvCount', label:'구매전환', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap;color:#7c3aed;font-weight:600">'+daNum(r.purchaseConvCount)+'</td>';}},
      { key:'purchaseConvSales', label:'구매매출', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap;color:#16a34a;font-weight:600">'+daWon(r.purchaseConvSales)+'</td>';}},
      { key:'purchaseRoas', label:'구매ROAS', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;white-space:nowrap">'+daRoas(r.purchaseRoas)+'</td>';}},
    ];
    daRegisterCols('creatives', DA_CREATIVE_COLS);

    var DA_BREAKDOWN_COLS = [
      { key:'_campName', label:'캠페인', tp:'s', visible:true, render:function(r){return '<td style="white-space:nowrap;font-size:12px;color:#6b7280">'+(r._campName||'-')+'</td>';}},
      { key:'_agName', label:'광고그룹', tp:'s', visible:true, render:function(r){return '<td style="white-space:nowrap;font-size:12px;color:#6b7280">'+(r._agName||'-')+'</td>';}},
      { key:'_label', label:'구분', tp:'s', visible:true, render:function(r){return '<td><strong>'+(r._label||r._key||'-')+'</strong></td>';}},
      { key:'imp', label:'노출', tp:'n', visible:true, render:function(r){return '<td style="text-align:right">'+daNum(r.imp)+'</td>';}},
      { key:'clk', label:'클릭', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;color:#2563eb;font-weight:600">'+daNum(r.clk)+'</td>';}},
      { key:'ctr', label:'CTR', tp:'n', visible:true, render:function(r){return '<td style="text-align:right">'+daPct(r.ctr)+'</td>';}},
      { key:'cost', label:'총비용', tp:'n', visible:true, render:function(r){return '<td style="text-align:right">'+daWon(r.cost)+'</td>';}},
      { key:'cpc', label:'CPC', tp:'n', visible:true, render:function(r){return '<td style="text-align:right">'+daWon(r.cpc)+'</td>';}},
      { key:'convCount', label:'전환', tp:'n', visible:true, render:function(r){return '<td style="text-align:right">'+daNum(r.convCount)+'</td>';}},
      { key:'purchaseConvCount', label:'구매전환', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;color:#7c3aed;font-weight:600">'+daNum(r.purchaseConvCount)+'</td>';}},
      { key:'purchaseConvSales', label:'구매매출', tp:'n', visible:true, render:function(r){return '<td style="text-align:right;color:#16a34a;font-weight:600">'+daWon(r.purchaseConvSales)+'</td>';}},
      { key:'purchaseRoas', label:'구매ROAS', tp:'n', visible:true, render:function(r){return '<td style="text-align:right">'+daRoas(r.purchaseRoas)+'</td>';}},
      { key:'_costPct', label:'비용비중', tp:'n', visible:true, render:function(r){
        var pct = r._costPct||0;
        return '<td style="white-space:nowrap"><div style="display:flex;align-items:center;gap:6px"><div style="background:#e2e8f0;border-radius:4px;height:12px;width:80px;overflow:hidden"><div style="width:'+pct+'%;background:#3b82f6;height:100%"></div></div><span style="font-size:11px;color:#64748b">'+pct.toFixed(1)+'%</span></div></td>';
      }},
    ];
    ['gender','age','placement'].forEach(function(t){ daRegisterCols(t, DA_BREAKDOWN_COLS); });

    // ── DA 다중 선택 위젯 ──
    function renderMultiSelect(opts){
      var label = opts.placeholder;
      if (opts.selected.length > 0) label = opts.selected.length + '개 선택됨';
      var maxLen = Math.max.apply(null, opts.items.map(function(it){ return (it.name || it.id || '').length; }).concat([20]));
      var winW = (typeof window !== 'undefined' ? window.innerWidth : 1200);
      var popWidth = Math.min(Math.max(maxLen * 14 + 60, 380), Math.round(winW * 0.9));
      var html = '<div class="ms-wrap" id="'+opts.id+'-wrap" style="position:relative;display:inline-block">';
      html += '<button type="button" id="'+opts.id+'-btn" style="border:1px solid #e2e8f0;border-radius:6px;padding:5px 12px;font-size:12px;background:#fff;cursor:pointer;min-width:160px;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:8px"><span>'+label+'</span><span style="color:#94a3b8;font-size:10px">▼</span></button>';
      html += '<div id="'+opts.id+'-pop" class="ms-pop" style="display:none;position:absolute;top:100%;left:0;margin-top:4px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;box-shadow:0 8px 24px rgba(15,23,42,0.12);z-index:1000;width:'+popWidth+'px;max-width:90vw">';
      html += '<div style="padding:8px;border-bottom:1px solid #e2e8f0;display:flex;gap:6px;align-items:center">';
      html += '<input type="text" id="'+opts.id+'-search" placeholder="검색..." style="flex:1;min-width:120px;padding:4px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px">';
      html += '<button type="button" data-act="all" style="padding:4px 10px;font-size:11px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer;white-space:nowrap">전체</button>';
      html += '<button type="button" data-act="none" style="padding:4px 10px;font-size:11px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer;white-space:nowrap">해제</button>';
      html += '<button type="button" data-act="close" title="닫기" style="padding:4px 8px;font-size:14px;line-height:1;background:#fff;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer;color:#64748b">×</button>';
      html += '</div>';
      html += '<div id="'+opts.id+'-list" style="max-height:320px;overflow-y:auto;overflow-x:hidden;padding:4px 0">';
      opts.items.forEach(function(it){
        var checked = opts.selected.indexOf(it.id) >= 0;
        html += '<label class="ms-item" data-name="'+(it.name||'').toLowerCase().replace(/"/g,'&quot;')+'" style="display:grid;grid-template-columns:18px 1fr;align-items:center;gap:10px;padding:6px 14px;font-size:12px;cursor:pointer">';
        html += '<input type="checkbox" value="'+String(it.id).replace(/"/g,'&quot;')+'" '+(checked?'checked':'')+' style="cursor:pointer;accent-color:#6366f1;width:16px;height:16px;margin:0">';
        html += '<span style="text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+(it.name||it.id)+'</span></label>';
      });
      html += '</div>';
      html += '<div style="padding:8px;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:6px">';
      html += '<button type="button" data-act="apply" style="padding:5px 14px;font-size:12px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600">적용</button>';
      html += '</div></div></div>';
      return html;
    }
    function bindMultiSelect(id, onApply){
      var wrap = document.getElementById(id+'-wrap');
      if (!wrap) return;
      var btn = document.getElementById(id+'-btn');
      var pop = document.getElementById(id+'-pop');
      var search = document.getElementById(id+'-search');
      var list = document.getElementById(id+'-list');
      function closeOthers(){ document.querySelectorAll('.ms-pop').forEach(function(p){ if(p.id!==id+'-pop') p.style.display='none'; }); }
      function show(){ closeOthers(); pop.style.display='block'; setTimeout(function(){search&&search.focus();},50); }
      function hide(){ pop.style.display='none'; }
      btn.onclick = function(e){ e.stopPropagation(); pop.style.display==='block'?hide():show(); };
      var onDoc = function(e){ if (!wrap.contains(e.target)) hide(); };
      document.addEventListener('click', onDoc);
      if (search) search.oninput = function(){
        var q = search.value.toLowerCase();
        list.querySelectorAll('.ms-item').forEach(function(el){ el.style.display = (!q || (el.dataset.name||'').indexOf(q)>=0) ? '' : 'none'; });
      };
      pop.querySelectorAll('button[data-act]').forEach(function(b){
        b.onclick = function(e){
          e.stopPropagation();
          var act = b.dataset.act;
          if (act==='all') list.querySelectorAll('input[type=checkbox]').forEach(function(c){ if(c.closest('.ms-item').style.display!=='none') c.checked=true; });
          else if (act==='none') list.querySelectorAll('input[type=checkbox]').forEach(function(c){c.checked=false;});
          else if (act==='close') hide();
          else if (act==='apply'){
            var sel=[]; list.querySelectorAll('input[type=checkbox]:checked').forEach(function(c){sel.push(c.value);});
            hide(); document.removeEventListener('click', onDoc); onApply(sel);
          }
        };
      });
    }

    function daPeriodParams(){
      var p = 'period='+daPeriod;
      if (daPeriod==='custom') p += '&startDate='+daCustomStart+'&endDate='+daCustomEnd;
      return p;
    }

    document.querySelectorAll('.period-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        if (btn.dataset.period === 'custom') {
          document.getElementById('da-custom-date-wrap').style.display = 'flex';
          var today = new Date();
          var end = new Date(today); end.setDate(end.getDate()-1);
          var start = new Date(today); start.setDate(start.getDate()-7);
          document.getElementById('da-date-start').value = start.toISOString().slice(0,10);
          document.getElementById('da-date-end').value = end.toISOString().slice(0,10);
          return;
        }
        document.getElementById('da-custom-date-wrap').style.display = 'none';
        document.querySelectorAll('.period-btn').forEach(function(b){b.classList.remove('active')});
        btn.classList.add('active');
        daPeriod = btn.dataset.period;
        daResetTabs();
        daLoadCurrentTab();
      });
    });

    function daApplyCustomDate(){
      var s = document.getElementById('da-date-start').value;
      var e = document.getElementById('da-date-end').value;
      if (!s||!e) return toast('시작/종료일을 선택해주세요.', true);
      if (s>e) return toast('시작일이 종료일보다 큽니다.', true);
      daCustomStart=s; daCustomEnd=e; daPeriod='custom';
      document.querySelectorAll('.period-btn').forEach(function(b){b.classList.remove('active')});
      document.getElementById('da-custom-period-btn').classList.add('active');
      daResetTabs(); daLoadCurrentTab();
    }

    function daResetTabs(){ for(var k in daTabLoaded) daTabLoaded[k]=false; daRawData={}; }

    function daSwitchTab(name){
      daCurrentTab = name;
      document.querySelectorAll('.da-tab-content').forEach(function(el){el.style.display='none'});
      document.getElementById('da-tab-'+name).style.display='block';
      document.querySelectorAll('.dash-tab').forEach(function(b){
        if (b.dataset.tab===name) b.classList.add('active'); else b.classList.remove('active');
      });
      document.getElementById('da-csv-btn').style.display = (name==='summary')?'none':'inline-flex';
      daLoadCurrentTab();
    }

    function daLoadCurrentTab(){
      if (daCurrentTab==='summary') daLoadSummary();
      else if (!daTabLoaded[daCurrentTab]) daLoadTab(daCurrentTab);
    }

    setTimeout(function(){ daLoadSummary(); }, 200);

    var daTrendData = null;
    async function daLoadSummary(){
      var grid = document.getElementById('da-kpi-grid');
      grid.innerHTML = ['노출수','클릭수','CTR','총비용','구매전환','구매전환매출','구매ROAS','전환수']
        .map(function(l){return '<div class="kpi-card"><div class="kpi-label">'+l+'</div><div class="kpi-value"><span class="spinner"></span></div></div>';}).join('');
      try {
        var res = await fetch('/smart-sa/api/da/summary?accountId='+daAccountId+'&'+daPeriodParams());
        var json = await res.json();
        if (!json.ok) throw new Error(json.error);
        var s = json.summary;
        var fields = [
          ['노출수', daNum(s.imp), 'kpi-blue'],
          ['클릭수', daNum(s.clk), 'kpi-cyan'],
          ['CTR', daPct(s.ctr), 'kpi-green'],
          ['총비용', daWon(s.cost), 'kpi-red'],
          ['구매전환', daNum(s.purchaseConvCount), 'kpi-purple'],
          ['구매전환매출', daWon(s.purchaseConvSales), 'kpi-purple'],
          ['구매ROAS', daRoas(s.purchaseRoas), 'kpi-green'],
          ['전환수', daNum(s.convCount), 'kpi-orange'],
        ];
        grid.innerHTML = fields.map(function(f){
          return '<div class="kpi-card '+f[2]+'"><div class="kpi-label">'+f[0]+'</div><div class="kpi-value">'+f[1]+'</div></div>';
        }).join('');
      } catch(e){
        grid.innerHTML = '<div class="empty" style="grid-column:1/-1;color:#ef4444">조회 실패: '+e.message+'</div>';
      }
      // 차트 2개 병렬 로드
      daLoadTrend();
      daLoadCampBars();
    }

    async function daLoadTrend(){
      var wrap = document.getElementById('da-trend-chart');
      try {
        var res = await fetch('/smart-sa/api/da/trend?accountId='+daAccountId+'&'+daPeriodParams());
        var json = await res.json();
        if (!json.ok) throw new Error(json.error);
        daTrendData = json.rows;
        daRenderTrend();
      } catch(e){ wrap.innerHTML = '<div class="empty" style="color:#ef4444">추이 조회 실패: '+e.message+'</div>'; }
    }
    function daRenderTrend(){
      var wrap = document.getElementById('da-trend-chart');
      if (!daTrendData || !daTrendData.length) { wrap.innerHTML = '<div class="empty">추이 데이터가 없습니다 (최소 2일 이상 기간 선택 필요).</div>'; return; }
      var labelMap = {cost:'총비용', imp:'노출수', clk:'클릭수', ctr:'CTR', purchaseConvSales:'구매매출', purchaseConvCount:'구매전환', purchaseRoas:'구매ROAS'};
      var fmtMap = {cost:daWon, imp:daNum, clk:daNum, ctr:daPct, purchaseConvSales:daWon, purchaseConvCount:daNum, purchaseRoas:function(v){return Number(v||0).toFixed(2)+'%';}};
      var colors = ['#ef4444','#16a34a','#3b82f6'];
      var metrics = [
        document.getElementById('da-trend-metric-1').value,
        document.getElementById('da-trend-metric-2').value,
        document.getElementById('da-trend-metric-3').value,
      ].filter(Boolean);
      if (!metrics.length) { wrap.innerHTML = '<div class="empty">표시할 지표를 1개 이상 선택해주세요.</div>'; return; }

      // 각 지표별 max 값 (0 나누기 방지)
      var maxMap = {};
      metrics.forEach(function(m){
        maxMap[m] = Math.max.apply(null, daTrendData.map(function(d){return Number(d[m])||0;}).concat([1]));
      });

      var html = '<div style="display:flex;flex-direction:column;gap:6px;font-size:11px">';
      // 헤더 라인
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;color:#94a3b8;font-size:11px;font-weight:600">';
      html += '<span style="width:80px">날짜</span><span style="flex:1">지표 추이</span>';
      metrics.forEach(function(m, i){
        html += '<span style="width:90px;text-align:right;color:'+colors[i]+'">'+labelMap[m]+'</span>';
      });
      html += '</div>';
      // 데이터 행
      daTrendData.forEach(function(d){
        html += '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #f1f5f9">';
        html += '<span style="width:80px;color:#64748b;font-weight:500">'+(d.date||'-').slice(5)+'</span>';
        // 막대 영역 (3개 지표 겹쳐서)
        html += '<div style="flex:1;display:flex;flex-direction:column;gap:3px">';
        metrics.forEach(function(m, i){
          var v = Number(d[m])||0;
          var w = Math.max(v/maxMap[m]*100, 0.5);
          html += '<div style="height:8px;background:#f1f5f9;border-radius:3px;overflow:hidden"><div style="width:'+w+'%;height:100%;background:'+colors[i]+';border-radius:3px;min-width:1px"></div></div>';
        });
        html += '</div>';
        // 값 표시 (3개 지표 각각)
        metrics.forEach(function(m, i){
          var v = Number(d[m])||0;
          var fmt = fmtMap[m] || daNum;
          html += '<span style="width:90px;text-align:right;font-weight:600;color:'+colors[i]+'">'+fmt(v)+'</span>';
        });
        html += '</div>';
      });
      html += '</div>';
      wrap.innerHTML = html;
    }
    ['da-trend-metric-1','da-trend-metric-2','da-trend-metric-3'].forEach(function(id){
      var el = document.getElementById(id); if (el) el.addEventListener('change', daRenderTrend);
    });

    async function daLoadCampBars(){
      var wrap = document.getElementById('da-camp-bars');
      try {
        var res = await fetch('/smart-sa/api/da/tab/campaigns?accountId='+daAccountId+'&'+daPeriodParams());
        var json = await res.json();
        if (!json.ok) throw new Error(json.error);
        var camps = (json.rows||[]).filter(function(c){return c.cost>0||c.purchaseConvSales>0;}).sort(function(a,b){return b.cost-a.cost;}).slice(0, 15);
        if (!camps.length) { wrap.innerHTML = '<div class="empty">데이터 없음</div>'; return; }
        var maxCost = Math.max.apply(null, camps.map(function(c){return c.cost;}).concat([1]));
        var maxPurch = Math.max.apply(null, camps.map(function(c){return c.purchaseConvSales;}).concat([1]));
        var html = '';
        camps.forEach(function(c){
          var costW = Math.max(c.cost/maxCost*100, 2);
          var purchW = Math.max(c.purchaseConvSales/maxPurch*100, 2);
          html += '<div style="margin-bottom:12px"><div style="font-size:12px;font-weight:500;margin-bottom:4px;color:#374151">'+(c.campaignName||'-')+'</div>';
          html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px"><span style="width:64px;font-size:10px;color:#94a3b8">총비용</span><div style="flex:1;background:#fee2e2;border-radius:4px;height:14px;overflow:hidden"><div style="width:'+costW+'%;background:#ef4444;height:100%;min-width:2px"></div></div><span style="width:90px;text-align:right;font-size:11px;font-weight:600">'+daWon(c.cost)+'</span></div>';
          html += '<div style="display:flex;align-items:center;gap:6px"><span style="width:64px;font-size:10px;color:#94a3b8">구매매출</span><div style="flex:1;background:#d1fae5;border-radius:4px;height:14px;overflow:hidden"><div style="width:'+purchW+'%;background:#16a34a;height:100%;min-width:2px"></div></div><span style="width:90px;text-align:right;font-size:11px;font-weight:600">'+daWon(c.purchaseConvSales)+'</span></div>';
          html += '</div>';
        });
        wrap.innerHTML = html;
      } catch(e){ wrap.innerHTML = '<div class="empty" style="color:#ef4444">캠페인 막대 차트 조회 실패: '+e.message+'</div>'; }
    }

    async function daLoadTab(tab){
      var wrap = document.getElementById('da-'+tab+'-content');
      wrap.innerHTML = '<div class="empty"><span class="spinner"></span> '+
        ({campaigns:'캠페인별',adgroups:'그룹별',creatives:'소재별',gender:'성별',age:'연령대',placement:'노출지면'}[tab])+
        ' 데이터 로딩 중...</div>';
      try {
        var res = await fetch('/smart-sa/api/da/tab/'+tab+'?accountId='+daAccountId+'&'+daPeriodParams());
        var json = await res.json();
        if (!json.ok) throw new Error(json.error);
        daTabLoaded[tab] = true;
        daRawData[tab] = json.rows;
        if (tab==='campaigns') daRenderCampaigns(json.rows);
        else if (tab==='adgroups') daRenderAdgroups(json.rows);
        else if (tab==='creatives') daRenderCreatives(json.rows);
        else if (tab==='gender') daRenderBreakdown(wrap, json.rows, 'gender', '성별', daGenderLabel, null, 'gender');
        else if (tab==='age') daRenderBreakdown(wrap, json.rows, 'ageGroup', '연령대', daAgeLabel, daAgeSortKey, 'age');
        else if (tab==='placement') daRenderBreakdown(wrap, json.rows, 'publisherGroupCode', '매체/지면', function(v){return v||'알수없음';}, null, 'placement');
      } catch(e){
        wrap.innerHTML = '<div class="empty" style="color:#ef4444">조회 실패: '+e.message+'</div>';
      }
    }

    var daCampaignsFilter = []; // 캠페인별 탭 필터 (캠페인명 다중)
    function daRenderCampaigns(rows){
      var wrap = document.getElementById('da-campaigns-content');
      if (!rows || !rows.length) { wrap.innerHTML='<div class="empty">캠페인 데이터가 없습니다.</div>'; return; }
      DA_RERENDER['campaigns'] = function(){ if (daRawData.campaigns) daRenderCampaigns(daRawData.campaigns); };
      var campOpts = rows.map(function(r){return {id:r.campaignName, name:r.campaignName};});
      var filtered = (!daCampaignsFilter.length) ? rows : rows.filter(function(r){return daCampaignsFilter.indexOf(r.campaignName)>=0;});
      var html = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:8px 12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;flex-wrap:wrap">';
      html += renderMultiSelect({ id:'da-camp-filter', placeholder:'전체 캠페인', items:campOpts, selected:daCampaignsFilter.slice() });
      html += '<span style="font-size:12px;color:#94a3b8;margin-left:auto">표시: '+filtered.length+'개 / 전체: '+rows.length+'개</span>';
      html += '<button class="btn btn-outline btn-sm" onclick="daOpenColSettings(\\\'campaigns\\\', function(){ if(daRawData.campaigns) daRenderCampaigns(daRawData.campaigns); })" style="font-size:11px;padding:5px 10px">⚙ 열 설정</button>';
      html += '</div>';
      html += '<div class="card"><div class="card-header"><span class="card-title">캠페인별 성과 ('+filtered.length+'개)</span></div><div class="card-body" style="overflow-x:auto">';
      html += daRenderColTable('campaigns', filtered);
      html += '</div></div>';
      wrap.innerHTML = html;
      bindMultiSelect('da-camp-filter', function(sel){ daCampaignsFilter=sel; daRenderCampaigns(daRawData.campaigns); });
    }

    var daCrCampFilter = []; var daCrAgFilter = []; // 소재별 탭 필터
    function daRenderCreatives(rows){
      var wrap = document.getElementById('da-creatives-content');
      if (!rows || !rows.length) { wrap.innerHTML='<div class="empty">소재 데이터가 없습니다.</div>'; return; }
      DA_RERENDER['creatives'] = function(){ if (daRawData.creatives) daRenderCreatives(daRawData.creatives); };
      var campMap = {}; rows.forEach(function(r){ if(r.campaignName && !campMap[r.campaignName]) campMap[r.campaignName]=true; });
      var campOpts = Object.keys(campMap).sort().map(function(n){return {id:n,name:n};});
      var afterCamp = (!daCrCampFilter.length) ? rows : rows.filter(function(r){return daCrCampFilter.indexOf(r.campaignName)>=0;});
      var agSet = {}; afterCamp.forEach(function(r){ var n=r.adSetName||r.assetGroupName; if(n && !agSet[n]) agSet[n]=true; });
      var agOpts = Object.keys(agSet).sort().map(function(n){return {id:n,name:n};});
      daCrAgFilter = daCrAgFilter.filter(function(n){return !!agSet[n];});
      var filtered = afterCamp.filter(function(r){
        if (daCrAgFilter.length) { var n=r.adSetName||r.assetGroupName; if(daCrAgFilter.indexOf(n)<0) return false; }
        return true;
      });
      var html = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:8px 12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;flex-wrap:wrap">';
      html += renderMultiSelect({ id:'da-cr-camp-filter', placeholder:'전체 캠페인', items:campOpts, selected:daCrCampFilter.slice() });
      html += renderMultiSelect({ id:'da-cr-ag-filter', placeholder:'전체 광고그룹', items:agOpts, selected:daCrAgFilter.slice() });
      html += '<span style="font-size:12px;color:#94a3b8;margin-left:auto">표시: '+filtered.length+'개 / 전체: '+rows.length+'개</span>';
      html += '<button class="btn btn-outline btn-sm" onclick="daOpenColSettings(\\\'creatives\\\', function(){ if(daRawData.creatives) daRenderCreatives(daRawData.creatives); })" style="font-size:11px;padding:5px 10px">⚙ 열 설정</button>';
      html += '</div>';
      html += '<div class="card"><div class="card-header"><span class="card-title">소재별 성과</span></div><div class="card-body" style="overflow-x:auto">';
      html += daRenderColTable('creatives', filtered);
      html += '</div></div>';
      wrap.innerHTML = html;
      bindMultiSelect('da-cr-camp-filter', function(sel){ daCrCampFilter=sel; daRenderCreatives(daRawData.creatives); });
      bindMultiSelect('da-cr-ag-filter', function(sel){ daCrAgFilter=sel; daRenderCreatives(daRawData.creatives); });
    }

    var daAgCampFilter = []; // 그룹별 탭 - 캠페인 필터
    var daAgFilter = [];     // 그룹별 탭 - 광고그룹 필터
    function daRenderAdgroups(rows){
      var wrap = document.getElementById('da-adgroups-content');
      if (!rows || !rows.length) { wrap.innerHTML='<div class="empty">광고그룹 데이터가 없습니다.</div>'; return; }
      DA_RERENDER['adgroups'] = function(){ if (daRawData.adgroups) daRenderAdgroups(daRawData.adgroups); };
      // 캠페인 옵션
      var campMap = {};
      rows.forEach(function(r){ if(r.campaignName && !campMap[r.campaignName]) campMap[r.campaignName]=true; });
      var campOpts = Object.keys(campMap).sort().map(function(n){return {id:n,name:n};});
      // 캠페인 필터 적용 후 그룹 옵션
      var afterCamp = (!daAgCampFilter.length) ? rows : rows.filter(function(r){return daAgCampFilter.indexOf(r.campaignName)>=0;});
      var agSet = {};
      afterCamp.forEach(function(r){ var n=r.adSetName||r.assetGroupName; if(n && !agSet[n]) agSet[n]=true; });
      var agOpts = Object.keys(agSet).sort().map(function(n){return {id:n,name:n};});
      daAgFilter = daAgFilter.filter(function(n){return !!agSet[n];});
      var filtered = afterCamp.filter(function(r){
        if (daAgFilter.length) { var n=r.adSetName||r.assetGroupName; if(daAgFilter.indexOf(n)<0) return false; }
        return true;
      });

      var html = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:8px 12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;flex-wrap:wrap">';
      html += renderMultiSelect({ id:'da-ag-camp-filter', placeholder:'전체 캠페인', items:campOpts, selected:daAgCampFilter.slice() });
      html += renderMultiSelect({ id:'da-ag-ag-filter', placeholder:'전체 광고그룹', items:agOpts, selected:daAgFilter.slice() });
      html += '<span style="font-size:12px;color:#94a3b8;margin-left:auto">표시: '+filtered.length+'개 / 전체: '+rows.length+'개</span>';
      html += '<button class="btn btn-outline btn-sm" onclick="daOpenColSettings(\\\'adgroups\\\', function(){ if(daRawData.adgroups) daRenderAdgroups(daRawData.adgroups); })" style="font-size:11px;padding:5px 10px">⚙ 열 설정</button>';
      html += '</div>';
      html += '<div class="card"><div class="card-header"><span class="card-title">광고그룹별 성과</span></div><div class="card-body" style="overflow-x:auto">';
      html += daRenderColTable('adgroups', filtered);
      html += '</div></div>';
      wrap.innerHTML = html;
      bindMultiSelect('da-ag-camp-filter', function(sel){ daAgCampFilter=sel; daRenderAdgroups(daRawData.adgroups); });
      bindMultiSelect('da-ag-ag-filter', function(sel){ daAgFilter=sel; daRenderAdgroups(daRawData.adgroups); });
    }

    function daGenderLabel(g){
      if (!g || g === 'U' || g === 'UNKNOWN' || g === 'GROUP_UNKNOWN') return '알수없음';
      return ({M:'남성',F:'여성'})[g] || g;
    }
    function daAgeLabel(a){
      if (!a || a === 'GROUP_UNKNOWN' || a === 'UNKNOWN') return '알수없음';
      var m = String(a).match(/(\\d+)/);
      return m ? m[1]+'대' : a;
    }
    function daAgeSortKey(a){
      if (!a || a === 'GROUP_UNKNOWN' || a === 'UNKNOWN') return 9999; // 알수없음 마지막
      var m = String(a).match(/(\\d+)/);
      return m ? parseInt(m[1]) : 9998;
    }

    function daBuildBreakdownArr(rows, key, fmtKey, sortKeyFn){
      var byKey = {};
      rows.forEach(function(r){
        var k = r[key] || '_unknown';
        if (!byKey[k]) byKey[k] = { _key:k, _label:fmtKey(k), imp:0, clk:0, cost:0, convCount:0, purchaseConvCount:0, purchaseConvSales:0 };
        byKey[k].imp += r.imp; byKey[k].clk += r.clk; byKey[k].cost += r.cost;
        byKey[k].convCount += r.convCount;
        byKey[k].purchaseConvCount += r.purchaseConvCount;
        byKey[k].purchaseConvSales += r.purchaseConvSales;
      });
      var arr = Object.values(byKey).map(function(d){
        d.ctr = d.imp>0 ? d.clk/d.imp*100 : 0;
        d.cpc = d.clk>0 ? Math.round(d.cost/d.clk) : 0;
        d.purchaseRoas = d.cost>0 ? d.purchaseConvSales/d.cost*100 : 0;
        return d;
      });
      var totalCost = arr.reduce(function(s,r){return s+r.cost;},0) || 1;
      arr.forEach(function(r){ r._costPct = r.cost/totalCost*100; });
      // 디폴트 정렬 (sortKeyFn이 있고 사용자 정렬이 없을 때만 적용)
      if (typeof sortKeyFn === 'function' && !DA_SORT_STATE['__currentBreakdownTab__']) {
        arr.sort(function(a,b){ return sortKeyFn(a._key) - sortKeyFn(b._key); });
      } else if (!DA_SORT_STATE['__currentBreakdownTab__']) {
        arr.sort(function(a,b){return b.cost-a.cost;});
      }
      return arr;
    }
    function daRenderBreakdown(wrap, rows, key, label, fmtKey, sortKeyFn, tabId){
      if (!rows || !rows.length) { wrap.innerHTML='<div class="empty">'+label+' 데이터가 없습니다.</div>'; return; }
      DA_RERENDER[tabId] = function(){ if (daRawData[tabId]) daRenderBreakdown(wrap, daRawData[tabId], key, label, fmtKey, sortKeyFn, tabId); };
      // 캠페인 + 광고그룹 + 세그먼트 단위로 집계 (캠페인/광고그룹 정보 보존)
      var arr = (function(){
        var byKey = {};
        rows.forEach(function(r){
          var seg = r[key] || '_unknown';
          var k = (r._campId||'_nocamp') + '|' + (r._agId||'_noag') + '|' + seg;
          if (!byKey[k]) byKey[k] = {
            _key:seg, _label:fmtKey(seg),
            _campId:r._campId, _campName:r._campName,
            _agId:r._agId, _agName:r._agName,
            imp:0, clk:0, cost:0, convCount:0, purchaseConvCount:0, purchaseConvSales:0
          };
          byKey[k].imp += r.imp; byKey[k].clk += r.clk; byKey[k].cost += r.cost;
          byKey[k].convCount += r.convCount;
          byKey[k].purchaseConvCount += r.purchaseConvCount;
          byKey[k].purchaseConvSales += r.purchaseConvSales;
        });
        var a = Object.values(byKey).map(function(d){
          d.ctr = d.imp>0 ? d.clk/d.imp*100 : 0;
          d.cpc = d.clk>0 ? Math.round(d.cost/d.clk) : 0;
          d.purchaseRoas = d.cost>0 ? d.purchaseConvSales/d.cost*100 : 0;
          return d;
        });
        var totalCost = a.reduce(function(s,r){return s+r.cost;},0) || 1;
        a.forEach(function(r){ r._costPct = r.cost/totalCost*100; });
        // 디폴트 정렬: 캠페인 ↑ → 광고그룹 ↑ → 세그먼트 (연령은 나이순)
        if (!DA_SORT_STATE[tabId]) {
          a.sort(function(x,y){
            var c = (x._campName||'').localeCompare(y._campName||'');
            if (c!==0) return c;
            var g = (x._agName||'').localeCompare(y._agName||'');
            if (g!==0) return g;
            if (typeof sortKeyFn==='function') return sortKeyFn(x._key)-sortKeyFn(y._key);
            return (x._label||'').localeCompare(y._label||'');
          });
        }
        return a;
      })();

      var html = '<div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-bottom:12px">';
      html += '<button class="btn btn-outline btn-sm" onclick="daOpenColSettings(\\\''+tabId+'\\\', function(){ if(daRawData[\\\''+tabId+'\\\']) DA_RERENDER[\\\''+tabId+'\\\'](); })" style="font-size:11px;padding:5px 10px">⚙ 열 설정</button>';
      html += '</div>';
      html += '<div class="card"><div class="card-header"><span class="card-title">'+label+'별 성과 ('+arr.length+'개)</span></div><div class="card-body" style="overflow-x:auto">';
      html += daRenderColTable(tabId, arr);
      html += '</div></div>';
      wrap.innerHTML = html;
    }

    // CSV 다운로드 (현재 탭)
    function daDownloadCsv(){
      var pane = document.getElementById('da-tab-'+daCurrentTab);
      if (!pane) return;
      var tables = pane.querySelectorAll('table');
      if (!tables.length) return toast('다운로드할 데이터가 없습니다.', true);
      var lines = [];
      tables.forEach(function(tbl, idx){
        if (idx>0) lines.push('');
        var heads=[]; tbl.querySelectorAll('thead th').forEach(function(th){heads.push('"'+th.textContent.replace(/[▲▼]/g,'').trim().replace(/"/g,'""')+'"')});
        lines.push(heads.join(','));
        tbl.querySelectorAll('tbody tr').forEach(function(tr){
          var row=[]; tr.querySelectorAll('td').forEach(function(td){
            var t=(td.innerText||'').trim().replace(/[₩￦]/g,'').replace(/\\n/g,' ');
            row.push('"'+t.replace(/"/g,'""')+'"');
          });
          if (row.length) lines.push(row.join(','));
        });
      });
      var csv = lines.join('\\r\\n');
      var blob = new Blob(['\\ufeff'+csv], {type:'text/csv;charset=utf-8'});
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var ts = new Date();
      var labelMap={summary:'요약',campaigns:'캠페인별',adgroups:'그룹별',gender:'성별',age:'연령대',placement:'노출지면'};
      a.href=url; a.download='DA_'+(labelMap[daCurrentTab]||daCurrentTab)+'_'+ts.toISOString().slice(0,10).replace(/-/g,'')+'.csv';
      document.body.appendChild(a); a.click();
      setTimeout(function(){document.body.removeChild(a);URL.revokeObjectURL(url);},100);
      toast('CSV 다운로드 시작');
    }
    </script>
  `;
  res.send(appLayout('DA 성과 대시보드', content, user, 'da-dashboard', layoutOpts));
});

// ─── DA API: 요약 ───────────────────────────────────────────────────
router.get('/api/da/summary', requireLogin, async (req, res) => {
  try {
    const { accountId, period = 'yesterday' } = req.query;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    if (!account.has_da) return res.status(400).json({ ok: false, error: 'DA가 활성화되지 않은 계정입니다.' });
    if (!account.naver_cookie) return res.status(400).json({ ok: false, error: 'DA 쿠키 미등록' });
    const dr = resolvePeriodDates(period, req.query.startDate, req.query.endDate);
    const { fetchReportPerformance, normalizeRow } = require('../api/naverDaApi');
    const adAccountNo = account.da_account_no || account.customer_id;
    const rows = await fetchReportPerformance({
      adAccountNo,
      cookie: account.naver_cookie,
      startDate: dr.since, endDate: dr.until,
      reportAdUnit: 'AD_ACCOUNT',
    });
    const summary = rows.map(normalizeRow).reduce((acc, r) => {
      acc.imp += r.imp; acc.clk += r.clk; acc.cost += r.cost;
      acc.convCount += r.convCount;
      acc.purchaseConvCount += r.purchaseConvCount;
      acc.purchaseConvSales += r.purchaseConvSales;
      return acc;
    }, { imp:0, clk:0, cost:0, convCount:0, purchaseConvCount:0, purchaseConvSales:0 });
    summary.ctr = summary.imp > 0 ? summary.clk / summary.imp * 100 : 0;
    summary.cpc = summary.clk > 0 ? Math.round(summary.cost / summary.clk) : 0;
    summary.purchaseRoas = summary.cost > 0 ? summary.purchaseConvSales / summary.cost * 100 : 0;
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── DA API: 일별 추이 (reportPerformanceDetail + DAY) ──────────────
router.get('/api/da/trend', requireLogin, async (req, res) => {
  try {
    const { accountId, period = 'yesterday' } = req.query;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    if (!account.has_da) return res.status(400).json({ ok: false, error: 'DA 미활성' });
    if (!account.naver_cookie) return res.status(400).json({ ok: false, error: 'DA 쿠키 미등록' });
    const dr = resolvePeriodDates(period, req.query.startDate, req.query.endDate);
    const { fetchReportPerformanceDetail, normalizeRow } = require('../api/naverDaApi');
    const adAccountNo = account.da_account_no || account.customer_id;
    // reportPerformanceDetail + reportDateUnit=DAY (계정 단위)
    const raw = await fetchReportPerformanceDetail({
      adAccountNo,
      cookie: account.naver_cookie,
      startDate: dr.since, endDate: dr.until,
      reportAdUnit: 'AD_ACCOUNT',
      reportDimension: 'TOTAL',
      reportDateUnit: 'DAY',
    });
    // 일자별 집계 (응답 필드명 다양한 후보 대응)
    const byDate = {};
    raw.forEach(r => {
      let date = r.targetDate || r.statDate || r.date || r.targetDateString || '';
      if (!date && r.targetYear && r.targetMonth) {
        const day = r.targetDay || 1;
        date = `${r.targetYear}-${String(r.targetMonth).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      }
      if (!date) return;
      if (!byDate[date]) byDate[date] = { date, imp:0, clk:0, cost:0, purchaseConvCount:0, purchaseConvSales:0, convCount:0 };
      const n = normalizeRow(r);
      byDate[date].imp += n.imp;
      byDate[date].clk += n.clk;
      byDate[date].cost += n.cost;
      byDate[date].purchaseConvCount += n.purchaseConvCount;
      byDate[date].purchaseConvSales += n.purchaseConvSales;
      byDate[date].convCount += n.convCount;
    });
    const out = Object.values(byDate).map(d => {
      d.ctr = d.imp > 0 ? d.clk / d.imp * 100 : 0;
      d.purchaseRoas = d.cost > 0 ? d.purchaseConvSales / d.cost * 100 : 0;
      return d;
    }).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    res.json({
      ok: true, rows: out,
      _debug: out.length === 0 ? {
        rawCount: raw.length,
        sample: raw[0],
        sampleKeys: raw[0] ? Object.keys(raw[0]).filter(k => raw[0][k] !== null && raw[0][k] !== 0).slice(0, 30) : [],
      } : undefined
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── DA API: 탭 데이터 ──────────────────────────────────────────────
router.get('/api/da/tab/:tab', requireLogin, async (req, res) => {
  try {
    const { tab } = req.params;
    const { accountId, period = 'yesterday' } = req.query;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    if (!account.has_da) return res.status(400).json({ ok: false, error: 'DA가 활성화되지 않은 계정입니다.' });
    if (!account.naver_cookie) return res.status(400).json({ ok: false, error: 'DA 쿠키 미등록' });

    const dr = resolvePeriodDates(period, req.query.startDate, req.query.endDate);
    const { fetchReportPerformance, fetchReportPerformanceDetail, normalizeRow } = require('../api/naverDaApi');
    const adAccountNo = account.da_account_no || account.customer_id;
    const baseArgs = {
      adAccountNo,
      cookie: account.naver_cookie,
      startDate: dr.since, endDate: dr.until,
    };

    let rows;
    if (tab === 'campaigns') {
      rows = await fetchReportPerformance({ ...baseArgs, reportAdUnit: 'CAMPAIGN' });
    } else if (tab === 'adgroups') {
      rows = await fetchReportPerformance({ ...baseArgs, reportAdUnit: 'AD_SET' });
    } else if (tab === 'creatives') {
      rows = await fetchReportPerformance({ ...baseArgs, reportAdUnit: 'CREATIVE' });
    } else if (tab === 'gender' || tab === 'age' || tab === 'placement') {
      // AD_SET 단위로 호출 (캠페인/광고그룹 정보 포함) → 클라이언트에서 집계
      const adSets = await fetchReportPerformance({ ...baseArgs, reportAdUnit: 'AD_SET' });
      const adSetMeta = {};
      adSets.forEach(a => { if (a.adSetNo) adSetMeta[a.adSetNo] = { name: a.adSetName, campId: a.campaignNo, campName: a.campaignName }; });
      const adSetIds = Object.keys(adSetMeta);
      const dimMap = { gender: 'GENDER', age: 'AGE', placement: 'TOTAL' };
      const placeMap = { placement: 'PLACEMENT_GROUP' };
      const allRows = [];
      const concurrency = 5;
      for (let i = 0; i < adSetIds.length; i += concurrency) {
        const batch = adSetIds.slice(i, i + concurrency);
        const results = await Promise.allSettled(batch.map(adSetNo =>
          fetchReportPerformanceDetail({
            ...baseArgs, reportAdUnit: 'AD_SET', adUnitNo: adSetNo,
            reportDimension: dimMap[tab], placeUnit: placeMap[tab],
          })
        ));
        results.forEach((r, idx) => {
          if (r.status === 'fulfilled' && Array.isArray(r.value)) {
            const aId = batch[idx]; const meta = adSetMeta[aId] || {};
            r.value.forEach(row => {
              const n = normalizeRow(row);
              n._agId = aId; n._agName = meta.name;
              n._campId = meta.campId; n._campName = meta.campName;
              allRows.push(n);
            });
          }
        });
      }
      rows = allRows;
    } else {
      return res.status(400).json({ ok: false, error: '알 수 없는 탭' });
    }
    res.json({ ok: true, rows: rows.map(normalizeRow) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── SA 성과 대시보드 ───────────────────────────────────────────────
router.get('/', requireLogin, requireApi, async (req, res) => {
  const user = await getUser(req);
  const accounts = await db.getAccountsByUser(user.id);

  const content = `
    <!-- 기간 선택 + 광고주 -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <div class="period-tabs">
          <button class="period-btn active" data-period="yesterday">어제</button>
          <button class="period-btn" data-period="7days">최근 7일</button>
          <button class="period-btn" data-period="30days">최근 30일</button>
          <button class="period-btn" data-period="lastMonth">전월</button>
          <button class="period-btn" data-period="custom" id="custom-period-btn">기간 선택</button>
        </div>
        <div id="custom-date-wrap" style="display:none;align-items:center;gap:6px">
          <input type="date" id="date-start" style="width:140px;padding:6px 10px;font-size:13px">
          <span style="color:#94a3b8">~</span>
          <input type="date" id="date-end" style="width:140px;padding:6px 10px;font-size:13px">
          <button class="btn btn-primary btn-sm" onclick="applyCustomDate()">적용</button>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:13px;color:#64748b" id="selected-account-label">
          ${req.session.selectedAccountId
            ? accounts.find(a => String(a.id) === String(req.session.selectedAccountId))?.name || '전체'
            : '전체 광고주'}
        </span>
      </div>
    </div>

    <!-- 탭 메뉴 -->
    <div class="tab-bar" style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
      <div style="display:flex;flex-wrap:wrap">
      ${['summary','campaigns','adgroups','keywords','target','hourly'].map((tab, i) => {
        const labels = ['요약','캠페인별','그룹별','키워드별','타겟별','시간대별'];
        return `<button class="tab-btn dash-tab ${i===0?'active':''}" data-tab="${tab}" onclick="switchTab('${tab}')">${labels[i]}</button>`;
      }).join('')}
      </div>
      <button id="csv-download-btn" class="btn btn-outline btn-sm" onclick="downloadCurrentTabCSV()" style="font-size:12px;padding:6px 12px;display:none" title="현재 탭의 표 데이터를 CSV로 다운로드 (Excel 호환)">📥 CSV 다운로드</button>
    </div>

    <!-- 요약 탭 -->
    <div id="tab-summary" class="tab-content">
      <!-- 성과지표 추이 차트 -->
      <div class="card" style="margin-bottom:20px" id="trend-chart-wrap">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <span class="card-title">성과지표</span>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:5px">
              <span style="width:8px;height:8px;border-radius:50%;background:#ef4444;display:inline-block"></span>
              <select id="trend-metric-1" style="border:1px solid #e2e8f0;border-radius:6px;padding:3px 6px;font-size:11px;background:#fff;cursor:pointer;color:#374151;font-weight:500;min-width:76px">
                <option value="imp">노출수</option>
                <option value="clk">클릭수</option>
                <option value="cost">비용</option>
                <option value="purchaseAmt">구매전환매출</option>
                <option value="roas">ROAS</option>
                <option value="cpc">CPC</option>
                <option value="ctr">클릭률</option>
              </select>
            </div>
            <div style="display:flex;align-items:center;gap:5px">
              <span style="width:8px;height:8px;border-radius:50%;background:#f59e0b;display:inline-block"></span>
              <select id="trend-metric-2" style="border:1px solid #e2e8f0;border-radius:6px;padding:3px 6px;font-size:11px;background:#fff;cursor:pointer;color:#374151;font-weight:500;min-width:76px">
                <option value="imp">노출수</option>
                <option value="clk">클릭수</option>
                <option value="cost">비용</option>
                <option value="purchaseAmt">구매전환매출</option>
                <option value="roas">ROAS</option>
                <option value="cpc" selected>CPC</option>
                <option value="ctr">클릭률</option>
              </select>
            </div>
            <div style="display:flex;align-items:center;gap:5px">
              <span style="width:8px;height:8px;border-radius:50%;background:#3b82f6;display:inline-block"></span>
              <select id="trend-metric-3" style="border:1px solid #e2e8f0;border-radius:6px;padding:3px 6px;font-size:11px;background:#fff;cursor:pointer;color:#374151;font-weight:500;min-width:76px">
                <option value="">선택안함</option>
                <option value="imp">노출수</option>
                <option value="clk">클릭수</option>
                <option value="cost">비용</option>
                <option value="purchaseAmt">구매전환매출</option>
                <option value="roas">ROAS</option>
                <option value="cpc">CPC</option>
                <option value="ctr">클릭률</option>
              </select>
            </div>
            <div style="display:flex;align-items:center;gap:5px">
              <span style="width:8px;height:8px;border-radius:50%;background:#10b981;display:inline-block"></span>
              <select id="trend-metric-4" style="border:1px solid #e2e8f0;border-radius:6px;padding:3px 6px;font-size:11px;background:#fff;cursor:pointer;color:#374151;font-weight:500;min-width:76px">
                <option value="">선택안함</option>
                <option value="imp">노출수</option>
                <option value="clk">클릭수</option>
                <option value="cost">비용</option>
                <option value="purchaseAmt">구매전환매출</option>
                <option value="roas">ROAS</option>
                <option value="cpc">CPC</option>
                <option value="ctr">클릭률</option>
              </select>
            </div>
          </div>
        </div>
        <div class="card-body" style="padding:12px 16px 16px">
          <div id="trend-sub" style="font-size:11px;color:#94a3b8;margin-bottom:8px"></div>
          <div style="position:relative;width:100%;height:240px" id="trend-canvas-wrap">
            <canvas id="trend-canvas" style="width:100%;height:100%"></canvas>
            <div id="trend-tooltip" style="display:none;position:absolute;background:rgba(30,41,59,0.95);color:#fff;padding:8px 12px;border-radius:8px;font-size:11px;pointer-events:none;z-index:100;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,0.15)"></div>
          </div>
        </div>
      </div>

      <div class="kpi-grid" id="kpi-grid">
        ${[
          {l:'노출수',c:'kpi-blue'},{l:'클릭수',c:'kpi-cyan'},{l:'CTR',c:'kpi-green'},{l:'총비용',c:'kpi-red'},
          {l:'구매완료전환매출',c:'kpi-purple'},{l:'ROAS',c:'kpi-green'},{l:'전환당비용',c:'kpi-orange'},{l:'구매완료전환수',c:'kpi-purple'}
        ].map(k => `
          <div class="kpi-card ${k.c}"><div class="kpi-label">${k.l}</div><div class="kpi-value" style="color:#e5e7eb">—</div></div>
        `).join('')}
      </div>
      <div id="chart-wrap" class="card" style="margin-bottom:20px;display:none">
        <div class="card-header"><span class="card-title">캠페인별 비용 vs 구매완료매출</span></div>
        <div class="card-body" id="chart-body"></div>
      </div>
    </div>

    <!-- 캠페인별 탭 -->
    <div id="tab-campaigns" class="tab-content" style="display:none">
      <div id="campaigns-tab-content"><div class="empty">탭을 선택하면 데이터를 로딩합니다.</div></div>
    </div>

    <!-- 그룹별 탭 -->
    <div id="tab-adgroups" class="tab-content" style="display:none">
      <div id="adgroups-tab-content"><div class="empty">탭을 선택하면 데이터를 로딩합니다.</div></div>
    </div>

    <!-- 키워드별 탭 -->
    <div id="tab-keywords" class="tab-content" style="display:none">
      <div id="kw-tab-content"><div class="empty">탭을 선택하면 데이터를 로딩합니다.</div></div>
    </div>

    <!-- 타겟별 탭 -->
    <div id="tab-target" class="tab-content" style="display:none">
      <div id="target-tab-content"><div class="empty">탭을 선택하면 데이터를 로딩합니다.</div></div>
    </div>

    <!-- 시간대별 탭 -->
    <div id="tab-hourly" class="tab-content" style="display:none">
      <div id="hourly-tab-content"><div class="empty">탭을 선택하면 데이터를 로딩합니다.</div></div>
    </div>

    <script>
    let currentPeriod = 'yesterday';
    let customStart = '', customEnd = '';
    const tabLoaded = {};
    const selectedAccountId = '${req.session.selectedAccountId || ''}';
    // firstAccountId 제거 - 광고주 선택 필수

    function getAccountId() { return selectedAccountId; }
    function periodParams() {
      let p = 'period='+currentPeriod+'&accountId='+getAccountId();
      if (currentPeriod === 'custom') p += '&startDate='+customStart+'&endDate='+customEnd;
      return p;
    }

    // 기간 버튼
    document.querySelectorAll('.period-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.period === 'custom') {
          document.getElementById('custom-date-wrap').style.display = 'flex';
          // 기본값: 최근 7일
          const today = new Date();
          const end = new Date(today); end.setDate(end.getDate()-1);
          const start = new Date(today); start.setDate(start.getDate()-7);
          document.getElementById('date-start').value = start.toISOString().slice(0,10);
          document.getElementById('date-end').value = end.toISOString().slice(0,10);
          return;
        }
        document.getElementById('custom-date-wrap').style.display = 'none';
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentPeriod = btn.dataset.period;
        resetTabs();
        loadCurrentTab();
      });
    });

    function applyCustomDate() {
      const s = document.getElementById('date-start').value;
      const e = document.getElementById('date-end').value;
      if (!s || !e) return toast('시작/종료일을 선택해주세요.', true);
      if (s > e) return toast('시작일이 종료일보다 큽니다.', true);
      customStart = s; customEnd = e;
      currentPeriod = 'custom';
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('custom-period-btn').classList.add('active');
      resetTabs();
      loadCurrentTab();
    }

    function resetTabs() { for (const k in tabLoaded) tabLoaded[k] = false; }

    let currentTab = 'summary';
    function switchTab(name) {
      currentTab = name;
      document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
      document.getElementById('tab-'+name).style.display = 'block';
      document.querySelectorAll('.dash-tab').forEach(b => {
        if (b.dataset.tab === name) b.classList.add('active'); else b.classList.remove('active');
      });
      loadCurrentTab();
    }

    function loadCurrentTab() {
      if (!getAccountId()) { toast('사이드바에서 광고주를 선택해주세요.', true); return; }
      if (currentTab === 'summary') loadSummary();
      else if (currentTab === 'campaigns' && !tabLoaded.campaigns) loadCampaigns();
      else if (currentTab === 'adgroups' && !tabLoaded.adgroups) loadAdgroups();
      else if (currentTab === 'keywords' && !tabLoaded.keywords) loadKeywords();
      else if (currentTab === 'target' && !tabLoaded.target) loadDevice();
      else if (currentTab === 'hourly' && !tabLoaded.hourly) loadHourly();
    }

    // 페이지 로드 시 자동 조회 (광고주 선택된 경우만)
    if (getAccountId()) {
      setTimeout(() => loadSummary(), 300);
    } else {
      document.getElementById('kpi-grid').innerHTML = '<div class="empty" style="grid-column:1/-1;padding:40px">사이드바에서 광고주를 선택해주세요.</div>';
    }

    // ── 요약 탭 ──
    async function loadSummary() {
      const grid = document.getElementById('kpi-grid');
      grid.innerHTML = ${JSON.stringify(
        [
          {l:'노출수',c:'kpi-blue'},{l:'클릭수',c:'kpi-cyan'},{l:'CTR',c:'kpi-green'},{l:'총비용',c:'kpi-red'},
          {l:'구매완료전환매출',c:'kpi-purple'},{l:'ROAS',c:'kpi-green'},{l:'전환당비용',c:'kpi-orange'},{l:'구매완료전환수',c:'kpi-purple'}
        ].map(k =>
          `<div class="kpi-card ${k.c}"><div class="kpi-label">${k.l}</div><div class="kpi-value"><span class="spinner"></span></div></div>`
        ).join('')
      )};
      try {
        const res = await fetch('/smart-sa/api/stats?'+periodParams());
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        renderKpi(json.stats);
      } catch(e) { toast('조회 실패: '+e.message, true); }
      // 트렌드 차트 로딩 (병렬)
      loadTrendChart();
    }

    // ── 성과지표 추이 차트 (최대 4개 지표) ──
    let trendData = [];
    const metricLabels = { imp: '노출수', clk: '클릭수', cost: '비용', purchaseAmt: '구매전환매출', roas: 'ROAS', cpc: 'CPC', ctr: '클릭률' };
    const metricFormats = {
      imp: v => num(v), clk: v => num(v), cost: v => won(v),
      purchaseAmt: v => won(v), roas: v => v+'%', cpc: v => won(v), ctr: v => v.toFixed(2)+'%'
    };
    const metricColorList = ['#ef4444','#f59e0b','#3b82f6','#10b981'];
    const metricTipColors = ['#fca5a5','#fcd34d','#93c5fd','#6ee7b7'];

    function getActiveMetrics() {
      const arr = [];
      for (let i = 1; i <= 4; i++) {
        const sel = document.getElementById('trend-metric-'+i);
        if (sel && sel.value) arr.push({ idx: i, key: sel.value, color: metricColorList[i-1], tipColor: metricTipColors[i-1] });
      }
      return arr;
    }

    function updateTrendSub() {
      const sub = document.getElementById('trend-sub');
      if (!sub || !trendData.length) return;
      const names = getActiveMetrics().map(m => metricLabels[m.key]).filter(Boolean);
      sub.textContent = names.join(', ') + ' 기준 ' + trendData.length + '일간 추이';
    }

    async function loadTrendChart() {
      const sub = document.getElementById('trend-sub');
      if (sub) sub.textContent = '데이터 로딩 중...';
      try {
        const res = await fetch('/smart-sa/api/stats/trend?'+periodParams());
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        trendData = json.trend || [];
        if (trendData.length < 2) {
          if (sub) sub.textContent = '추이 차트는 2일 이상의 데이터가 필요합니다.';
          return;
        }
        updateTrendSub();
        drawTrendChart();
      } catch(e) {
        if (sub) sub.textContent = '추이 데이터 로딩 실패: ' + e.message;
      }
    }

    function drawTrendChart() {
      const canvas = document.getElementById('trend-canvas');
      if (!canvas || !trendData.length) return;
      const wrap = document.getElementById('trend-canvas-wrap');
      const dpr = window.devicePixelRatio || 1;
      canvas.width = wrap.offsetWidth * dpr;
      canvas.height = wrap.offsetHeight * dpr;
      canvas.style.width = wrap.offsetWidth + 'px';
      canvas.style.height = wrap.offsetHeight + 'px';
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      const W = wrap.offsetWidth, H = wrap.offsetHeight;
      ctx.clearRect(0, 0, W, H);

      const metrics = getActiveMetrics();
      if (!metrics.length) return;
      const n = trendData.length;

      // 각 지표의 값과 범위 계산
      function niceRange(arr) {
        const mn = Math.min(...arr), mx = Math.max(...arr);
        if (mx === mn) return { min: 0, max: mx > 0 ? mx * 1.5 : 10, step: mx > 0 ? mx * 0.3 : 2 };
        const range = mx - mn;
        const mag = Math.pow(10, Math.floor(Math.log10(range)));
        let step = mag;
        if (range / step < 3) step = mag / 2;
        if (range / step > 8) step = mag * 2;
        const nMin = Math.floor(mn / step) * step;
        const nMax = Math.ceil(mx / step) * step;
        return { min: Math.max(0, nMin), max: nMax || 10, step: step || 1 };
      }

      const mData = metrics.map(m => {
        const vals = trendData.map(d => Number(d[m.key]) || 0);
        return { ...m, vals, range: niceRange(vals) };
      });

      // 레이아웃: 좌측에 1번, 우측에 2번 Y축 표시, 3~4번은 Y축 없음
      const padL = 70, padR = 70, padT = 20, padB = 36;
      const chartW = W - padL - padR;
      const chartH = H - padT - padB;

      // 그리드
      ctx.strokeStyle = '#f1f5f9'; ctx.lineWidth = 1;
      const ySteps = 5;
      for (let i = 0; i <= ySteps; i++) {
        const y = padT + chartH - (i / ySteps) * chartH;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        // 왼쪽 Y축: 1번 지표
        if (mData[0]) {
          const v = mData[0].range.min + (i / ySteps) * (mData[0].range.max - mData[0].range.min);
          ctx.fillStyle = mData[0].color; ctx.font = '10px -apple-system,sans-serif'; ctx.textAlign = 'right';
          ctx.fillText(shortNum(v, mData[0].key), padL - 8, y + 4);
        }
        // 오른쪽 Y축: 2번 지표
        if (mData[1]) {
          const v = mData[1].range.min + (i / ySteps) * (mData[1].range.max - mData[1].range.min);
          ctx.fillStyle = mData[1].color; ctx.font = '10px -apple-system,sans-serif'; ctx.textAlign = 'left';
          ctx.fillText(shortNum(v, mData[1].key), W - padR + 8, y + 4);
        }
      }

      // X축 라벨
      ctx.fillStyle = '#94a3b8'; ctx.font = '10px -apple-system,sans-serif'; ctx.textAlign = 'center';
      const maxLabels = Math.min(n, Math.floor(chartW / 55));
      const labelStep = Math.max(1, Math.ceil(n / maxLabels));
      trendData.forEach((d, i) => {
        if (i % labelStep !== 0 && i !== n - 1) return;
        const x = padL + (i / (n - 1)) * chartW;
        const dt = d.date.slice(5);
        const dayNames = ['일','월','화','수','목','금','토'];
        const dow = dayNames[new Date(d.date).getDay()];
        ctx.fillText(dt.replace('-','.') + '(' + dow + ')', x, H - 6);
      });

      // 라인 그리기
      function drawLine(vals, range, color) {
        ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath();
        vals.forEach((v, i) => {
          const x = padL + (i / (n - 1)) * chartW;
          const y = padT + chartH - ((v - range.min) / (range.max - range.min || 1)) * chartH;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
        vals.forEach((v, i) => {
          const x = padL + (i / (n - 1)) * chartW;
          const y = padT + chartH - ((v - range.min) / (range.max - range.min || 1)) * chartH;
          ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
        });
      }
      mData.forEach(m => drawLine(m.vals, m.range, m.color));

      // 마우스 호버 이벤트
      canvas.onmousemove = function(e) {
        const rect = canvas.getBoundingClientRect();
        const mx = (e.clientX - rect.left) * (W / rect.width);
        const idx = Math.round(((mx - padL) / chartW) * (n - 1));
        if (idx < 0 || idx >= n) { document.getElementById('trend-tooltip').style.display = 'none'; return; }
        const d = trendData[idx];
        const tip = document.getElementById('trend-tooltip');
        const dayNames = ['일','월','화','수','목','금','토'];
        const dow = dayNames[new Date(d.date).getDay()];
        let html = '<div style="font-weight:600;margin-bottom:4px">' + d.date + ' (' + dow + ')</div>';
        mData.forEach(m => {
          html += '<div style="color:' + m.tipColor + '">' + metricLabels[m.key] + ': ' + metricFormats[m.key](m.vals[idx]) + '</div>';
        });
        tip.innerHTML = html;
        tip.style.display = 'block';
        // 가장 높은(위쪽) 점 기준 툴팁 배치
        const dotX = padL + (idx / (n - 1)) * chartW;
        let minY = H;
        mData.forEach(m => {
          const yy = padT + chartH - ((m.vals[idx] - m.range.min) / (m.range.max - m.range.min || 1)) * chartH;
          if (yy < minY) minY = yy;
        });
        tip.style.left = (dotX + 12) + 'px';
        tip.style.top = (minY - 10) + 'px';
        const tipRect = tip.getBoundingClientRect();
        const wrapRect = wrap.getBoundingClientRect();
        if (tipRect.right > wrapRect.right - 4) {
          tip.style.left = (dotX - tip.offsetWidth - 12) + 'px';
        }
        drawTrendChart.__highlight = idx;
        drawTrendChartWithHighlight(idx);
      };
      canvas.onmouseleave = function() {
        document.getElementById('trend-tooltip').style.display = 'none';
        drawTrendChart.__highlight = -1;
        drawTrendChart();
      };
    }

    function drawTrendChartWithHighlight(idx) {
      drawTrendChart();
      if (idx < 0 || idx >= trendData.length) return;
      const canvas = document.getElementById('trend-canvas');
      const wrap = document.getElementById('trend-canvas-wrap');
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const W = wrap.offsetWidth, H = wrap.offsetHeight;
      const n = trendData.length;
      const padL = 70, padR = 70, padT = 20, padB = 36;
      const chartW = W - padL - padR;
      const x = padL + (idx / (n - 1)) * chartW;
      ctx.save(); ctx.scale(dpr, dpr);
      ctx.strokeStyle = 'rgba(148,163,184,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    function shortNum(v, key) {
      if (key === 'ctr' || key === 'roas') return v.toFixed(1) + '%';
      if (Math.abs(v) >= 1e8) return (v/1e8).toFixed(1) + '억';
      if (Math.abs(v) >= 1e4) return (v/1e4).toFixed(1) + '만';
      if (Math.abs(v) >= 1e3) return (v/1e3).toFixed(1) + 'K';
      return v.toFixed(key === 'cpc' ? 0 : (Number.isInteger(v) ? 0 : 1));
    }

    // 드롭다운 변경 시 차트 다시 그리기
    [1,2,3,4].forEach(function(i) {
      document.getElementById('trend-metric-'+i).addEventListener('change', function() {
        updateTrendSub();
        drawTrendChart();
      });
    });
    // 창 리사이즈 시 차트 재그리기
    window.addEventListener('resize', function() { if (trendData.length) drawTrendChart(); });

    function renderKpi(s) {
      const roas = s?.roas || 0;
      const cards = [
        {l:'노출수', v:num(s?.impCnt), c:'kpi-blue'},
        {l:'클릭수', v:num(s?.clkCnt), c:'kpi-cyan'},
        {l:'CTR',    v:pct(s?.ctr), c:'kpi-green'},
        {l:'총비용', v:won(s?.salesAmt), c:'kpi-red'},
        {l:'구매완료전환매출',v:won(s?.purchaseAmt), c:'kpi-purple'},
        {l:'ROAS',   v:roas+'%', c:'kpi-green'},
        {l:'전환당비용',v:won(s?.purchaseCnt ? s.salesAmt/s.purchaseCnt : 0), c:'kpi-orange'},
        {l:'구매완료전환수', v:num(s?.purchaseCnt), c:'kpi-purple'},
      ];
      document.getElementById('kpi-grid').innerHTML = cards.map(c =>
        '<div class="kpi-card '+c.c+'"><div class="kpi-label">'+c.l+'</div><div class="kpi-value">'+c.v+'</div></div>'
      ).join('');
      if (s?.campStats?.length) renderChart(s.campStats);
    }

    function renderChart(campStats) {
      const chartWrap = document.getElementById('chart-wrap');
      const chartBody = document.getElementById('chart-body');
      if (!chartWrap || !chartBody) return;
      chartWrap.style.display = 'block';
      const maxCost = Math.max(...campStats.map(c => c.salesAmt || 0), 1);
      const maxPurchase = Math.max(...campStats.map(c => c.purchaseAmt || 0), 1);
      let html = '<div style="display:flex;gap:20px;flex-wrap:wrap">';
      html += '<div style="flex:1;min-width:300px">';
      campStats.forEach(c => {
        const costW = Math.max((c.salesAmt||0)/maxCost*100, 2);
        const purchW = maxPurchase > 0 ? Math.max((c.purchaseAmt||0)/maxPurchase*100, 2) : 2;
        html += '<div style="margin-bottom:10px"><div style="font-size:12px;font-weight:500;margin-bottom:3px;color:#374151">'+c.name+'</div>';
        html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px"><span style="font-size:10px;color:#94a3b8;width:60px">총비용</span><div style="flex:1;background:#fee2e2;border-radius:4px;height:16px;overflow:hidden"><div style="width:'+costW+'%;background:#ef4444;height:100%;border-radius:4px;min-width:2px"></div></div><span style="font-size:11px;font-weight:500;width:80px;text-align:right">'+won(c.salesAmt)+'</span></div>';
        html += '<div style="display:flex;align-items:center;gap:6px"><span style="font-size:10px;color:#94a3b8;width:60px">구매매출</span><div style="flex:1;background:#d1fae5;border-radius:4px;height:16px;overflow:hidden"><div style="width:'+purchW+'%;background:#10b981;height:100%;border-radius:4px;min-width:2px"></div></div><span style="font-size:11px;font-weight:500;width:80px;text-align:right">'+won(c.purchaseAmt)+'</span></div>';
        html += '</div>';
      });
      html += '</div>';
      html += '<div style="flex:1;min-width:280px"><h4 style="font-size:13px;font-weight:600;margin-bottom:12px;color:#374151">캠페인별 주요 지표</h4>';
      html += '<table style="width:100%;font-size:12px"><thead><tr><th style="text-align:left">캠페인</th><th style="text-align:right">클릭</th><th style="text-align:right">총비용</th><th style="text-align:right">구매매출</th><th style="text-align:right">ROAS</th></tr></thead><tbody>';
      campStats.forEach(c => {
        const roas = c.salesAmt > 0 ? Math.round((c.purchaseAmt||0)/c.salesAmt*100) : 0;
        html += '<tr><td>'+c.name+'</td><td style="text-align:right">'+num(c.clkCnt)+'</td><td style="text-align:right">'+won(c.salesAmt)+'</td><td style="text-align:right;color:#16a34a">'+won(c.purchaseAmt)+'</td><td style="text-align:right;color:'+(roas>=100?'#16a34a':'#ef4444')+'">'+roas+'%</td></tr>';
      });
      html += '</tbody></table></div></div>';
      chartBody.innerHTML = html;
    }

    // ── 키워드별 탭 ──
    let kwShowAll = { powerlink: false, shopping: false };
    let kwData = null;
    let kwFilterClk = true; // 기본: 클릭 1 미만 숨김
    let kwFilterCampNames = []; // 캠페인 필터 (다중) - 빈 배열 = 전체
    let kwFilterAgNames = [];   // 광고그룹 필터 (다중) - 빈 배열 = 전체

    async function loadKeywords(showAll) {
      const wrap = document.getElementById('kw-tab-content');
      if (!kwData || showAll === undefined) {
        wrap.innerHTML = '<div class="empty"><span class="spinner"></span> 키워드 데이터 로딩 중... (10~30초 소요)</div>';
        try {
          const lim = (showAll === 'powerlink' || showAll === 'shopping') ? 'all' : '10';
          const res = await fetch('/smart-sa/api/tab/keywords?'+periodParams()+'&limit='+lim);
          const json = await res.json();
          if (!json.ok) throw new Error(json.error);
          kwData = json;
          tabLoaded.keywords = true;
        } catch(e) { wrap.innerHTML = '<div class="empty">키워드 조회 실패: '+e.message+'</div>'; return; }
      }
      renderKeywordTab(kwData);
    }

    function renderKeywordTab(d) {
      const wrap = document.getElementById('kw-tab-content');
      let html = '';

      // 캠페인/광고그룹 필터 옵션 추출 (전체 데이터 기준)
      var allKws = [].concat(d.powerlink||[], d.shopping||[], d.other||[]);
      var campSet = {};
      allKws.forEach(function(k){ if(k.campaignName) campSet[k.campaignName] = true; });
      var campOpts = Object.keys(campSet).sort().map(function(n){ return { id:n, name:n }; });
      var agSet = {};
      allKws.forEach(function(k){
        if (kwFilterCampNames.length && kwFilterCampNames.indexOf(k.campaignName) < 0) return;
        if (k.adgroupName) agSet[k.adgroupName] = true;
      });
      var agOpts = Object.keys(agSet).sort().map(function(n){ return { id:n, name:n }; });
      // 선택한 광고그룹이 더 이상 옵션에 없으면 자동 정리
      kwFilterAgNames = kwFilterAgNames.filter(function(n){ return !!agSet[n]; });

      // 필터 바
      html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:8px 12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;flex-wrap:wrap">';
      html += '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;color:#475569;user-select:none">';
      html += '<input type="checkbox" id="kw-filter-clk" '+(kwFilterClk?'checked':'')+' style="cursor:pointer;width:16px;height:16px;accent-color:#2563eb"> ';
      html += '<span>클릭 1 미만 숨김</span></label>';
      // 캠페인/광고그룹 다중 선택
      html += renderMultiSelect({ id:'kw-camp-filter', placeholder:'전체 캠페인', items:campOpts, selected:kwFilterCampNames.slice() });
      html += renderMultiSelect({ id:'kw-ag-filter', placeholder:'전체 광고그룹', items:agOpts, selected:kwFilterAgNames.slice() });

      function applyFilter(arr) {
        return (arr||[]).filter(function(k){
          if (kwFilterClk && !(k.clk >= 1)) return false;
          if (kwFilterCampNames.length && kwFilterCampNames.indexOf(k.campaignName) < 0) return false;
          if (kwFilterAgNames.length && kwFilterAgNames.indexOf(k.adgroupName) < 0) return false;
          return true;
        });
      }
      var plF = applyFilter(d.powerlink);
      var spF = applyFilter(d.shopping);
      var otF = applyFilter(d.other);
      var totalAll = (d.powerlinkTotal||0)+(d.shoppingTotal||0)+(d.otherTotal||0);
      var shownAll = plF.length+spF.length+otF.length;
      html += '<span style="font-size:12px;color:#94a3b8;margin-left:auto">표시: '+shownAll+'개 / 전체: '+totalAll+'개</span>';
      html += '<button id="kw-col-settings-btn" class="btn btn-outline" style="font-size:12px;padding:6px 12px;white-space:nowrap">⚙ 열 설정</button>';
      html += '</div>';
      // 파워링크
      html += kwSection('파워링크', plF, d.powerlinkTotal, 'powerlink');
      // 쇼핑검색
      html += kwSection('쇼핑검색', spF, d.shoppingTotal, 'shopping');
      if (otF.length) html += kwSection('기타', otF, d.otherTotal, 'other');
      wrap.innerHTML = html;

      // 다중 선택 위젯 바인딩
      bindMultiSelect('kw-camp-filter', function(selected){
        kwFilterCampNames = selected;
        renderKeywordTab(kwData);
      });
      bindMultiSelect('kw-ag-filter', function(selected){
        kwFilterAgNames = selected;
        renderKeywordTab(kwData);
      });
    }

    // 정렬 상태: { type: { field, dir } }
    const kwSortState = {};
    // 컬럼 정의 + 렌더러. visible/순서는 localStorage로 영구 저장.
    const KW_COL_DEFAULTS = [
      { key:'campaignName', label:'캠페인', tp:'s', visible:true, render: function(kw){ return '<td style="white-space:nowrap;font-size:12px;color:#6b7280">'+(kw.campaignName||'-')+'</td>'; } },
      { key:'adgroupName', label:'광고그룹', tp:'s', visible:true, render: function(kw){ return '<td style="white-space:nowrap;font-size:12px;color:#6b7280">'+(kw.adgroupName||'-')+'</td>'; } },
      { key:'keyword', label:'키워드', tp:'s', visible:true, render: function(kw){ return '<td style="white-space:nowrap"><strong>'+kw.keyword+'</strong></td>'; } },
      { key:'imp', label:'노출', tp:'n', visible:true, render: function(kw){ return '<td style="text-align:right;white-space:nowrap">'+num(kw.imp)+'</td>'; } },
      { key:'clk', label:'클릭', tp:'n', visible:true, render: function(kw){ return '<td style="text-align:right;white-space:nowrap;color:#2563eb;font-weight:600">'+num(kw.clk)+'</td>'; } },
      { key:'ctr', label:'CTR', tp:'n', visible:true, render: function(kw){ return '<td style="text-align:right;white-space:nowrap">'+pct(kw.ctr)+'</td>'; } },
      { key:'cost', label:'총비용', tp:'n', visible:true, render: function(kw){ return '<td style="text-align:right;white-space:nowrap">'+won(kw.cost)+'</td>'; } },
      { key:'cpc', label:'CPC', tp:'n', visible:true, render: function(kw){ return '<td style="text-align:right;white-space:nowrap">'+won(kw.cpc)+'</td>'; } },
      { key:'purchaseCnt', label:'구매전환수', tp:'n', visible:true, render: function(kw){ return '<td style="text-align:right;white-space:nowrap;color:#7c3aed;font-weight:600">'+num(kw.purchaseCnt)+'</td>'; } },
      { key:'purchaseAmt', label:'구매전환매출', tp:'n', visible:true, render: function(kw){ return '<td style="text-align:right;white-space:nowrap;color:#16a34a;font-weight:600">'+won(kw.purchaseAmt)+'</td>'; } },
      { key:'roas', label:'ROAS', tp:'n', visible:true, render: function(kw){ return '<td style="text-align:right;white-space:nowrap;font-weight:600;color:'+(kw.roas>=100?'#16a34a':'#ef4444')+'">'+kw.roas+'%</td>'; } },
    ];
    // localStorage에서 순서/표시여부 복원
    function loadKwColDefs() {
      var defs = KW_COL_DEFAULTS.map(function(c){ return Object.assign({}, c); });
      try {
        var saved = JSON.parse(localStorage.getItem('smartSa.kwColOrder') || 'null');
        if (Array.isArray(saved) && saved.length > 0) {
          var byKey = {};
          defs.forEach(function(d){ byKey[d.key] = d; });
          var ordered = [];
          var seen = {};
          saved.forEach(function(s){
            if (byKey[s.key]) {
              var d = byKey[s.key];
              if (typeof s.visible === 'boolean') d.visible = s.visible;
              ordered.push(d);
              seen[s.key] = true;
            }
          });
          // 저장되지 않은 신규 컬럼은 뒤에 append
          defs.forEach(function(d){ if (!seen[d.key]) ordered.push(d); });
          return ordered;
        }
      } catch(e){}
      return defs;
    }
    function saveKwColDefs() {
      try {
        var snap = kwColDefs.map(function(c){ return { key: c.key, visible: c.visible !== false }; });
        localStorage.setItem('smartSa.kwColOrder', JSON.stringify(snap));
      } catch(e){}
    }
    let kwColDefs = loadKwColDefs();

    function sortKwItems(items, type) {
      const st = kwSortState[type];
      if (!st) return items;
      const sorted = items.slice();
      const col = kwColDefs.find(function(c){ return c.key === st.field; });
      if (!col) return items;
      sorted.sort(function(a, b) {
        var va, vb;
        if (col.tp === 'n') { va = Number(a[st.field]) || 0; vb = Number(b[st.field]) || 0; }
        else { va = String(a[st.field] || '').toLowerCase(); vb = String(b[st.field] || '').toLowerCase(); }
        if (va < vb) return st.dir === 'asc' ? -1 : 1;
        if (va > vb) return st.dir === 'asc' ? 1 : -1;
        return 0;
      });
      return sorted;
    }

    // 이벤트 위임: kw-tab-content 클릭 이벤트에서 정렬 + 필터 처리
    document.getElementById('kw-tab-content').addEventListener('click', function(e) {
      var th = e.target.closest('th[data-sort-key]');
      if (!th) return;
      var field = th.getAttribute('data-sort-key');
      var type = th.getAttribute('data-sort-type');
      if (!field || !type || !kwData) return;
      var st = kwSortState[type];
      if (st && st.field === field) {
        st.dir = st.dir === 'desc' ? 'asc' : 'desc';
      } else {
        var col = kwColDefs.find(function(c){ return c.key === field; });
        kwSortState[type] = { field: field, dir: col && col.tp === 's' ? 'asc' : 'desc' };
      }
      renderKeywordTab(kwData);
    });
    document.getElementById('kw-tab-content').addEventListener('change', function(e) {
      if (e.target && e.target.id === 'kw-filter-clk') {
        kwFilterClk = e.target.checked;
        renderKeywordTab(kwData);
      }
    });
    document.getElementById('kw-tab-content').addEventListener('click', function(e){
      if (e.target && e.target.id === 'kw-col-settings-btn') {
        openKwColSettings();
      }
    });

    // ── 열 설정 모달 (드래그 앤 드롭 순서 변경 + 표시/숨김) ──
    function openKwColSettings() {
      var existing = document.getElementById('kw-col-modal');
      if (existing) existing.remove();
      // 현재 순서/표시여부를 로컬 스냅샷으로 복제
      var working = kwColDefs.map(function(c){ return { key: c.key, label: c.label, visible: c.visible !== false }; });
      var modal = document.createElement('div');
      modal.id = 'kw-col-modal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:9999;display:flex;align-items:center;justify-content:center';
      modal.innerHTML = '<div style="background:#fff;width:420px;max-width:92vw;max-height:85vh;display:flex;flex-direction:column;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.2);overflow:hidden">'
        + '<div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #e2e8f0">'
        +   '<div><div style="font-size:16px;font-weight:700;color:#0f172a">열 맞춤 설정</div><div style="font-size:12px;color:#94a3b8;margin-top:2px">드래그하여 순서 변경, 체크박스로 표시/숨김</div></div>'
        +   '<button id="kw-col-close" style="background:none;border:none;font-size:22px;cursor:pointer;color:#64748b;padding:0;line-height:1">×</button>'
        + '</div>'
        + '<div id="kw-col-list" style="padding:12px 16px;overflow-y:auto;flex:1"></div>'
        + '<div style="display:flex;gap:8px;justify-content:space-between;padding:14px 20px;border-top:1px solid #e2e8f0;background:#f8fafc">'
        +   '<button id="kw-col-reset" class="btn btn-outline" style="font-size:13px;padding:8px 14px">기본값 복원</button>'
        +   '<div style="display:flex;gap:8px">'
        +     '<button id="kw-col-cancel" class="btn btn-outline" style="font-size:13px;padding:8px 14px">취소</button>'
        +     '<button id="kw-col-save" class="btn btn-primary" style="font-size:13px;padding:8px 18px">적용</button>'
        +   '</div>'
        + '</div>'
        + '</div>';
      document.body.appendChild(modal);
      var listEl = modal.querySelector('#kw-col-list');
      function renderList() {
        var html = '';
        working.forEach(function(c, idx){
          html += '<div class="kw-col-item" draggable="true" data-idx="'+idx+'" style="display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:6px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;cursor:grab;user-select:none">'
            + '<span style="color:#94a3b8;font-size:16px;line-height:1">⋮⋮</span>'
            + '<input type="checkbox" class="kw-col-chk" data-idx="'+idx+'" '+(c.visible?'checked':'')+' style="width:16px;height:16px;accent-color:#2563eb;cursor:pointer">'
            + '<span style="flex:1;font-size:13px;color:#0f172a;font-weight:500">'+c.label+'</span>'
            + '</div>';
        });
        listEl.innerHTML = html;
      }
      renderList();
      // 체크박스 이벤트
      listEl.addEventListener('change', function(e){
        if (e.target && e.target.classList.contains('kw-col-chk')) {
          var idx = parseInt(e.target.getAttribute('data-idx'));
          working[idx].visible = e.target.checked;
        }
      });
      // 드래그 앤 드롭
      var draggingIdx = null;
      listEl.addEventListener('dragstart', function(e){
        var item = e.target.closest('.kw-col-item');
        if (!item) return;
        draggingIdx = parseInt(item.getAttribute('data-idx'));
        item.style.opacity = '0.4';
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try{e.dataTransfer.setData('text/plain','');}catch(_){} }
      });
      listEl.addEventListener('dragend', function(e){
        var item = e.target.closest('.kw-col-item');
        if (item) item.style.opacity = '';
        draggingIdx = null;
      });
      listEl.addEventListener('dragover', function(e){
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        var target = e.target.closest('.kw-col-item');
        if (!target || draggingIdx === null) return;
        var targetIdx = parseInt(target.getAttribute('data-idx'));
        if (targetIdx === draggingIdx) return;
        var rect = target.getBoundingClientRect();
        var after = (e.clientY - rect.top) > (rect.height / 2);
        var insertIdx = after ? targetIdx + 1 : targetIdx;
        var moved = working.splice(draggingIdx, 1)[0];
        if (insertIdx > draggingIdx) insertIdx--;
        working.splice(insertIdx, 0, moved);
        draggingIdx = insertIdx;
        renderList();
        // 드래그 중인 item에 opacity 재적용
        var newDragging = listEl.querySelector('.kw-col-item[data-idx="'+draggingIdx+'"]');
        if (newDragging) newDragging.style.opacity = '0.4';
      });
      // 버튼 이벤트
      modal.querySelector('#kw-col-close').onclick = function(){ modal.remove(); };
      modal.querySelector('#kw-col-cancel').onclick = function(){ modal.remove(); };
      modal.addEventListener('click', function(e){ if (e.target === modal) modal.remove(); });
      modal.querySelector('#kw-col-reset').onclick = function(){
        try { localStorage.removeItem('smartSa.kwColOrder'); } catch(_){}
        working = KW_COL_DEFAULTS.map(function(c){ return { key: c.key, label: c.label, visible: true }; });
        renderList();
      };
      modal.querySelector('#kw-col-save').onclick = function(){
        // working 순서대로 kwColDefs 재정렬 + visible 반영
        var byKey = {};
        kwColDefs.forEach(function(c){ byKey[c.key] = c; });
        var next = [];
        working.forEach(function(w){
          var c = byKey[w.key];
          if (c) { c.visible = !!w.visible; next.push(c); }
        });
        // 누락된 컬럼이 있을 경우 뒤에 append (안전망)
        kwColDefs.forEach(function(c){ if (next.indexOf(c) === -1) next.push(c); });
        kwColDefs = next;
        saveKwColDefs();
        modal.remove();
        if (kwData) renderKeywordTab(kwData);
      };
    }

    function kwSection(title, items, total, type) {
      if (!items || !items.length) return '<div class="card" style="margin-bottom:16px"><div class="card-header"><span class="card-title">'+title+'</span></div><div class="card-body"><div class="empty">데이터 없음</div></div></div>';
      var sorted = sortKwItems(items, type);
      var st = kwSortState[type] || {};
      var visibleCols = kwColDefs.filter(function(c){ return c.visible !== false; });
      var html = '<div class="card" style="margin-bottom:16px"><div class="card-header"><span class="card-title">'+title+'</span><span style="font-size:12px;color:#94a3b8">총 '+total+'개 키워드</span></div><div class="card-body" style="overflow-x:auto">';
      html += '<table style="table-layout:auto"><thead><tr><th style="width:30px">#</th>';
      for (var ci = 0; ci < visibleCols.length; ci++) {
        var col = visibleCols[ci];
        var isRight = col.tp === 'n';
        var cls = 'sortable';
        if (st.field === col.key) cls += ' sort-' + st.dir;
        html += '<th class="'+cls+'" data-sort-key="'+col.key+'" data-sort-type="'+type+'" style="'+(isRight?'text-align:right;':'')+'white-space:nowrap">' + col.label + '</th>';
      }
      html += '</tr></thead><tbody>';
      for (var i = 0; i < sorted.length; i++) {
        var kw = sorted[i];
        html += '<tr><td style="color:#94a3b8;text-align:center">'+(i+1)+'</td>';
        for (var cj = 0; cj < visibleCols.length; cj++) {
          html += visibleCols[cj].render(kw);
        }
        html += '</tr>';
      }
      html += '</tbody></table>';
      if (items.length < total) {
        html += '<div style="text-align:center;padding:12px"><button class="btn btn-outline" onclick="loadAllKeywords(\\\''+type+'\\\')">더보기 (전체 '+total+'개)</button></div>';
      }
      html += '</div></div>';
      return html;
    }

    async function loadAllKeywords(type) {
      tabLoaded.keywords = false;
      kwData = null;
      const wrap = document.getElementById('kw-tab-content');
      wrap.innerHTML = '<div class="empty"><span class="spinner"></span> 전체 키워드 로딩 중...</div>';
      try {
        const res = await fetch('/smart-sa/api/tab/keywords?'+periodParams()+'&limit=all');
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        kwData = json;
        tabLoaded.keywords = true;
        renderKeywordTab(kwData);
      } catch(e) { wrap.innerHTML = '<div class="empty">오류: '+e.message+'</div>'; }
    }

    // ═══ 범용 열 설정 시스템 ═══
    // tabId별 컬럼 기본 정의, 현재 상태, 데이터 캐시
    const TAB_COL_DEFS = {};    // { tabId: [colDef, ...] }
    const TAB_COL_STATE = {};   // { tabId: [colDef with visible state, ...] }
    const TAB_DATA_CACHE = {};  // { tabId: data }

    function registerTabCols(tabId, defaults) {
      TAB_COL_DEFS[tabId] = defaults;
      TAB_COL_STATE[tabId] = loadTabColState(tabId, defaults);
    }
    function loadTabColState(tabId, defaults) {
      var defs = defaults.map(function(c){ return Object.assign({}, c); });
      try {
        var saved = JSON.parse(localStorage.getItem('smartSa.colOrder.'+tabId) || 'null');
        if (Array.isArray(saved) && saved.length > 0) {
          var byKey = {}; defs.forEach(function(d){ byKey[d.key] = d; });
          var ordered = [], seen = {};
          saved.forEach(function(s){ if (byKey[s.key]) { var d = byKey[s.key]; if (typeof s.visible === 'boolean') d.visible = s.visible; ordered.push(d); seen[s.key] = true; } });
          defs.forEach(function(d){ if (!seen[d.key]) ordered.push(d); });
          return ordered;
        }
      } catch(e){}
      return defs;
    }
    function saveTabColState(tabId) {
      try {
        var snap = TAB_COL_STATE[tabId].map(function(c){ return { key: c.key, visible: c.visible !== false }; });
        localStorage.setItem('smartSa.colOrder.'+tabId, JSON.stringify(snap));
      } catch(e){}
    }
    function getVisibleCols(tabId) { return (TAB_COL_STATE[tabId] || []).filter(function(c){ return c.visible !== false; }); }

    function openColSettings(tabId, onApply) {
      var existing = document.getElementById('col-modal-'+tabId);
      if (existing) existing.remove();
      var colState = TAB_COL_STATE[tabId] || [];
      var working = colState.map(function(c){ return { key: c.key, label: c.label, visible: c.visible !== false }; });
      var modal = document.createElement('div');
      modal.id = 'col-modal-'+tabId;
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:9999;display:flex;align-items:center;justify-content:center';
      modal.innerHTML = '<div style="background:#fff;width:420px;max-width:92vw;max-height:85vh;display:flex;flex-direction:column;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.2);overflow:hidden">'
        + '<div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #e2e8f0">'
        +   '<div><div style="font-size:16px;font-weight:700;color:#0f172a">열 맞춤 설정</div><div style="font-size:12px;color:#94a3b8;margin-top:2px">드래그하여 순서 변경, 체크박스로 표시/숨김</div></div>'
        +   '<button class="col-modal-close" style="background:none;border:none;font-size:22px;cursor:pointer;color:#64748b;padding:0;line-height:1">×</button>'
        + '</div>'
        + '<div class="col-modal-list" style="padding:12px 16px;overflow-y:auto;flex:1"></div>'
        + '<div style="display:flex;gap:8px;justify-content:space-between;padding:14px 20px;border-top:1px solid #e2e8f0;background:#f8fafc">'
        +   '<button class="col-modal-reset btn btn-outline" style="font-size:13px;padding:8px 14px">기본값 복원</button>'
        +   '<div style="display:flex;gap:8px">'
        +     '<button class="col-modal-cancel btn btn-outline" style="font-size:13px;padding:8px 14px">취소</button>'
        +     '<button class="col-modal-save btn btn-primary" style="font-size:13px;padding:8px 18px">적용</button>'
        +   '</div>'
        + '</div></div>';
      document.body.appendChild(modal);
      var listEl = modal.querySelector('.col-modal-list');
      function renderList() {
        var html = '';
        working.forEach(function(c, idx){
          html += '<div class="col-drag-item" draggable="true" data-idx="'+idx+'" style="display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:6px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;cursor:grab;user-select:none">'
            + '<span style="color:#94a3b8;font-size:16px;line-height:1">⋮⋮</span>'
            + '<input type="checkbox" class="col-drag-chk" data-idx="'+idx+'" '+(c.visible?'checked':'')+' style="width:16px;height:16px;accent-color:#2563eb;cursor:pointer">'
            + '<span style="flex:1;font-size:13px;color:#0f172a;font-weight:500">'+c.label+'</span></div>';
        });
        listEl.innerHTML = html;
      }
      renderList();
      listEl.addEventListener('change', function(e){ if (e.target && e.target.classList.contains('col-drag-chk')) { working[parseInt(e.target.getAttribute('data-idx'))].visible = e.target.checked; } });
      var draggingIdx = null;
      listEl.addEventListener('dragstart', function(e){ var item = e.target.closest('.col-drag-item'); if (!item) return; draggingIdx = parseInt(item.getAttribute('data-idx')); item.style.opacity = '0.4'; if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try{e.dataTransfer.setData('text/plain','');}catch(_){} } });
      listEl.addEventListener('dragend', function(e){ var item = e.target.closest('.col-drag-item'); if (item) item.style.opacity = ''; draggingIdx = null; });
      listEl.addEventListener('dragover', function(e){ e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; var target = e.target.closest('.col-drag-item'); if (!target || draggingIdx === null) return; var targetIdx = parseInt(target.getAttribute('data-idx')); if (targetIdx === draggingIdx) return; var rect = target.getBoundingClientRect(); var after = (e.clientY - rect.top) > (rect.height / 2); var insertIdx = after ? targetIdx + 1 : targetIdx; var moved = working.splice(draggingIdx, 1)[0]; if (insertIdx > draggingIdx) insertIdx--; working.splice(insertIdx, 0, moved); draggingIdx = insertIdx; renderList(); var nd = listEl.querySelector('.col-drag-item[data-idx="'+draggingIdx+'"]'); if (nd) nd.style.opacity = '0.4'; });
      modal.querySelector('.col-modal-close').onclick = function(){ modal.remove(); };
      modal.querySelector('.col-modal-cancel').onclick = function(){ modal.remove(); };
      modal.addEventListener('click', function(e){ if (e.target === modal) modal.remove(); });
      modal.querySelector('.col-modal-reset').onclick = function(){ try { localStorage.removeItem('smartSa.colOrder.'+tabId); } catch(_){} working = TAB_COL_DEFS[tabId].map(function(c){ return { key: c.key, label: c.label, visible: true }; }); renderList(); };
      modal.querySelector('.col-modal-save').onclick = function(){
        var byKey = {}; TAB_COL_STATE[tabId].forEach(function(c){ byKey[c.key] = c; });
        var next = [];
        working.forEach(function(w){ var c = byKey[w.key]; if (c) { c.visible = !!w.visible; next.push(c); } });
        TAB_COL_STATE[tabId].forEach(function(c){ if (next.indexOf(c) === -1) next.push(c); });
        TAB_COL_STATE[tabId] = next;
        saveTabColState(tabId);
        modal.remove();
        if (onApply) onApply();
      };
    }

    var TAB_SORT_STATE = {};
    var TAB_RERENDER = {};
    function applyTabSort(tabId, items) {
      var st = TAB_SORT_STATE[tabId];
      if (!st || !st.field) return items;
      var col = (TAB_COL_DEFS[tabId] || []).find(function(c){ return c.key === st.field; });
      var isStr = col && col.tp === 's';
      var dir = st.dir === 'asc' ? 1 : -1;
      return items.slice().sort(function(a, b){
        var va = a[st.field], vb = b[st.field];
        if (isStr) return ((va||'').toString().localeCompare((vb||'').toString())) * dir;
        return ((Number(va)||0) - (Number(vb)||0)) * dir;
      });
    }
    function renderColTable(tabId, items, opts) {
      opts = opts || {};
      var cols = getVisibleCols(tabId);
      var sorted = applyTabSort(tabId, items);
      var st = TAB_SORT_STATE[tabId] || {};
      var html = '<table style="table-layout:auto"><thead><tr>';
      if (opts.showIndex !== false) html += '<th style="width:30px">#</th>';
      for (var i = 0; i < cols.length; i++) {
        var c = cols[i]; var isR = c.tp === 'n';
        var arrow = (st.field === c.key) ? (st.dir === 'asc' ? ' ▲' : ' ▼') : '';
        html += '<th data-tab-sort="'+tabId+'" data-sort-field="'+c.key+'" style="cursor:pointer;user-select:none;'+(isR?'text-align:right;':'')+'white-space:nowrap">'+c.label+arrow+'</th>';
      }
      html += '</tr></thead><tbody>';
      for (var j = 0; j < sorted.length; j++) {
        var row = sorted[j];
        html += '<tr>';
        if (opts.showIndex !== false) html += '<td style="color:#94a3b8;text-align:center">'+(j+1)+'</td>';
        for (var k = 0; k < cols.length; k++) html += cols[k].render(row);
        html += '</tr>';
      }
      html += '</tbody></table>';
      return html;
    }
    // 헤더 클릭 → 정렬 토글 (한 번만 바인딩)
    if (!window.__tabSortBound) {
      window.__tabSortBound = true;
      document.addEventListener('click', function(e){
        var th = e.target && (e.target.tagName==='TH' ? e.target : (e.target.closest && e.target.closest('th[data-tab-sort]')));
        if (!th || !th.dataset || !th.dataset.tabSort) return;
        var tabId = th.dataset.tabSort;
        var field = th.dataset.sortField;
        var st = TAB_SORT_STATE[tabId];
        if (st && st.field === field) {
          st.dir = st.dir === 'desc' ? 'asc' : 'desc';
        } else {
          var col = (TAB_COL_DEFS[tabId] || []).find(function(c){ return c.key === field; });
          TAB_SORT_STATE[tabId] = { field: field, dir: col && col.tp === 's' ? 'asc' : 'desc' };
        }
        var rer = TAB_RERENDER[tabId];
        if (typeof rer === 'function') rer();
      });
    }

    // ═══ 시간대별 탭 컬럼 정의 ═══
    var HOURLY_COLS = [
      { key:'imp', label:'노출', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right">'+num(r.imp)+'</td>'; } },
      { key:'clk', label:'클릭', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;color:#2563eb">'+num(r.clk)+'</td>'; } },
      { key:'ctr', label:'CTR', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right">'+pct(r.ctr)+'</td>'; } },
      { key:'cost', label:'총비용', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right">'+won(r.cost)+'</td>'; } },
      { key:'cpc', label:'CPC', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right">'+won(r.cpc)+'</td>'; } },
      { key:'purchaseCnt', label:'구매전환', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;color:#7c3aed">'+num(r.purchaseCnt)+'</td>'; } },
      { key:'purchaseAmt', label:'구매매출', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;color:#16a34a">'+won(r.purchaseAmt)+'</td>'; } },
      { key:'roas', label:'ROAS', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;font-weight:600;color:'+(r.roas>=100?'#16a34a':'#ef4444')+'">'+r.roas+'%</td>'; } },
    ];
    registerTabCols('hourly', HOURLY_COLS);

    // ═══ 캠페인별 탭 컬럼 정의 ═══
    var CAMPAIGN_COLS = [
      { key:'campaignName', label:'캠페인', tp:'s', visible:true, render: function(r){
        var typeLabel = '';
        if (r.campaignTp === 1) typeLabel = '<span class="badge" style="background:#dbeafe;color:#1e40af;margin-left:6px;font-size:10px;padding:1px 6px">파워링크</span>';
        else if (r.campaignTp === 2) typeLabel = '<span class="badge" style="background:#fef3c7;color:#92400e;margin-left:6px;font-size:10px;padding:1px 6px">쇼핑</span>';
        else if (r.campaignTp === 4) typeLabel = '<span class="badge" style="background:#fce7f3;color:#9f1239;margin-left:6px;font-size:10px;padding:1px 6px">브랜드</span>';
        return '<td style="white-space:nowrap"><strong>'+(r.campaignName||'-')+'</strong>'+typeLabel+'</td>';
      } },
      { key:'imp', label:'노출', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;white-space:nowrap">'+num(r.imp)+'</td>'; } },
      { key:'clk', label:'클릭', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;white-space:nowrap;color:#2563eb;font-weight:600">'+num(r.clk)+'</td>'; } },
      { key:'ctr', label:'CTR', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;white-space:nowrap">'+pct(r.ctr)+'</td>'; } },
      { key:'cost', label:'총비용', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;white-space:nowrap">'+won(r.cost)+'</td>'; } },
      { key:'cpc', label:'CPC', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;white-space:nowrap">'+won(r.cpc)+'</td>'; } },
      { key:'purchaseCnt', label:'구매전환', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;white-space:nowrap;color:#7c3aed;font-weight:600">'+num(r.purchaseCnt)+'</td>'; } },
      { key:'purchaseAmt', label:'구매매출', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;white-space:nowrap;color:#16a34a;font-weight:600">'+won(r.purchaseAmt)+'</td>'; } },
      { key:'roas', label:'ROAS', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;white-space:nowrap;font-weight:600;color:'+(r.roas>=100?'#16a34a':'#ef4444')+'">'+r.roas+'%</td>'; } },
    ];
    registerTabCols('campaigns', CAMPAIGN_COLS);

    // ═══ 그룹별 탭 컬럼 정의 ═══
    var ADGROUP_COLS = [
      { key:'campaignName', label:'캠페인', tp:'s', visible:true, render: function(r){ return '<td style="white-space:nowrap;font-size:12px;color:#6b7280">'+(r.campaignName||'-')+(r.campaignTp===2?'<span class="badge badge-blue" style="margin-left:4px;font-size:10px">쇼핑</span>':'')+'</td>'; } },
      { key:'adgroupName', label:'광고그룹', tp:'s', visible:true, render: function(r){ return '<td style="white-space:nowrap"><strong>'+r.adgroupName+'</strong></td>'; } },
      { key:'imp', label:'노출', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;white-space:nowrap">'+num(r.imp)+'</td>'; } },
      { key:'clk', label:'클릭', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;white-space:nowrap;color:#2563eb;font-weight:600">'+num(r.clk)+'</td>'; } },
      { key:'ctr', label:'CTR', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;white-space:nowrap">'+pct(r.ctr)+'</td>'; } },
      { key:'cost', label:'총비용', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;white-space:nowrap">'+won(r.cost)+'</td>'; } },
      { key:'cpc', label:'CPC', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;white-space:nowrap">'+won(r.cpc)+'</td>'; } },
      { key:'purchaseCnt', label:'구매전환', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;white-space:nowrap;color:#7c3aed;font-weight:600">'+num(r.purchaseCnt)+'</td>'; } },
      { key:'purchaseAmt', label:'구매매출', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;white-space:nowrap;color:#16a34a;font-weight:600">'+won(r.purchaseAmt)+'</td>'; } },
      { key:'roas', label:'ROAS', tp:'n', visible:true, render: function(r){ return '<td style="text-align:right;white-space:nowrap;font-weight:600;color:'+(r.roas>=100?'#16a34a':'#ef4444')+'">'+r.roas+'%</td>'; } },
    ];
    registerTabCols('adgroups', ADGROUP_COLS);

    // ── 시간대별 탭 ──
    var hourlyData = null;
    var hourlyCampList = []; // 캠페인 목록 (한 번 로드)
    var hourlyFilterCamps = []; // 선택된 캠페인 ID 다중
    async function loadHourly() {
      const wrap = document.getElementById('hourly-tab-content');
      wrap.innerHTML = '<div class="empty"><span class="spinner"></span> 시간대별 데이터 로딩 중... (10~30초 소요)</div>';
      try {
        // 1) 캠페인 목록 (필요할 때만 로드)
        if (!hourlyCampList.length) {
          try {
            const cr = await fetch('/smart-sa/api/tab/campaigns?'+periodParams());
            const cj = await cr.json();
            if (cj.ok) hourlyCampList = (cj.campaigns||[]).map(c => ({ id: String(c.campaignId), name: c.campaignName||c.campaignId }));
          } catch(_){}
        }
        // 2) 시간대별 데이터 호출 (필터 적용)
        var params = periodParams();
        if (hourlyFilterCamps.length) params += '&campaigns=' + encodeURIComponent(hourlyFilterCamps.join(','));
        const res = await fetch('/smart-sa/api/tab/hourly?'+params);
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        tabLoaded.hourly = true;
        hourlyData = json;
        renderHourlyTab(json);
      } catch(e) { wrap.innerHTML = '<div class="empty">시간대별 조회 실패: '+e.message+'</div>'; }
    }

    function renderHourlyTab(d) {
      const wrap = document.getElementById('hourly-tab-content');
      TAB_RERENDER['hourly'] = function(){ if (hourlyData) renderHourlyTab(hourlyData); };
      let html = '';
      // 캠페인 필터 바
      if (hourlyCampList.length > 0) {
        html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:8px 12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;flex-wrap:wrap">';
        html += renderMultiSelect({ id:'hourly-camp-filter', placeholder:'전체 캠페인', items:hourlyCampList, selected:hourlyFilterCamps.slice() });
        html += '<span style="font-size:12px;color:#94a3b8">'+ (hourlyFilterCamps.length ? hourlyFilterCamps.length+'개 캠페인 선택됨' : '전체 캠페인 합산') +'</span>';
        html += '</div>';
      }
      var hCols = getVisibleCols('hourly');
      var hSt = TAB_SORT_STATE['hourly'] || {};
      function sortBy(arr, firstKey) {
        if (!hSt.field) return arr;
        if (hSt.field === '__first__') {
          return arr.slice().sort(function(a,b){ return ((Number(a[firstKey])||0)-(Number(b[firstKey])||0)) * (hSt.dir==='asc'?1:-1); });
        }
        var col = (TAB_COL_DEFS['hourly'] || []).find(function(c){return c.key===hSt.field;});
        var isStr = col && col.tp === 's';
        return arr.slice().sort(function(a,b){
          var va=a[hSt.field], vb=b[hSt.field];
          if (isStr) return ((va||'').toString().localeCompare((vb||'').toString())) * (hSt.dir==='asc'?1:-1);
          return ((Number(va)||0)-(Number(vb)||0)) * (hSt.dir==='asc'?1:-1);
        });
      }
      function arrow(field){ return hSt.field===field ? (hSt.dir==='asc'?' ▲':' ▼') : ''; }

      // 시간대별
      html += '<div class="card" style="margin-bottom:16px"><div class="card-header"><span class="card-title">시간대별 성과</span><button class="btn btn-outline btn-sm" onclick="openColSettings(\\\'hourly\\\', function(){ if(hourlyData) renderHourlyTab(hourlyData); })" style="font-size:11px;padding:5px 10px">⚙ 열 설정</button></div><div class="card-body" style="overflow-x:auto">';
      var sortedHour = sortBy(d.byHour || [], 'hour');
      var maxCost = Math.max.apply(null, (d.byHour||[]).map(function(h){return h.cost}).concat([1]));
      html += '<table><thead><tr><th data-tab-sort="hourly" data-sort-field="__first__" style="cursor:pointer;user-select:none">시간'+arrow('__first__')+'</th>';
      for (var i=0;i<hCols.length;i++) html += '<th data-tab-sort="hourly" data-sort-field="'+hCols[i].key+'" style="cursor:pointer;user-select:none;'+(hCols[i].tp==='n'?'text-align:right;':'')+'white-space:nowrap">'+hCols[i].label+arrow(hCols[i].key)+'</th>';
      html += '<th style="width:120px">비용비중</th></tr></thead><tbody>';
      sortedHour.forEach(function(h) {
        var barW = Math.max((h.cost/maxCost)*100, 1);
        html += '<tr><td style="font-weight:600">'+String(h.hour).padStart(2,'0')+':00</td>';
        for (var j=0;j<hCols.length;j++) html += hCols[j].render(h);
        html += '<td><div style="background:#e2e8f0;border-radius:4px;height:14px;overflow:hidden"><div style="width:'+barW+'%;background:#3b82f6;height:100%;border-radius:4px"></div></div></td>';
        html += '</tr>';
      });
      html += '</tbody></table></div></div>';

      // 요일별
      html += '<div class="card"><div class="card-header"><span class="card-title">요일별 성과</span></div><div class="card-body" style="overflow-x:auto">';
      var sortedDay = sortBy(d.byDay || [], 'dayIdx');
      var maxDayCost = Math.max.apply(null, (d.byDay||[]).map(function(d2){return d2.cost}).concat([1]));
      html += '<table><thead><tr><th data-tab-sort="hourly" data-sort-field="__first__" style="cursor:pointer;user-select:none">요일'+arrow('__first__')+'</th>';
      for (var i2=0;i2<hCols.length;i2++) html += '<th data-tab-sort="hourly" data-sort-field="'+hCols[i2].key+'" style="cursor:pointer;user-select:none;'+(hCols[i2].tp==='n'?'text-align:right;':'')+'white-space:nowrap">'+hCols[i2].label+arrow(hCols[i2].key)+'</th>';
      html += '<th style="width:120px">비용비중</th></tr></thead><tbody>';
      sortedDay.forEach(function(day) {
        var barW = Math.max((day.cost/maxDayCost)*100, 1);
        html += '<tr><td style="font-weight:600">'+day.day+'요일</td>';
        for (var j2=0;j2<hCols.length;j2++) html += hCols[j2].render(day);
        html += '<td><div style="background:#e2e8f0;border-radius:4px;height:14px;overflow:hidden"><div style="width:'+barW+'%;background:#f59e0b;height:100%;border-radius:4px"></div></div></td>';
        html += '</tr>';
      });
      html += '</tbody></table></div></div>';
      wrap.innerHTML = html;
      // 캠페인 필터 바인딩
      bindMultiSelect('hourly-camp-filter', function(sel){
        hourlyFilterCamps = sel;
        loadHourly(); // 서버에서 다시 집계
      });
    }

    // ── 타겟별 탭 ──
    async function loadDevice() {
      const wrap = document.getElementById('target-tab-content');
      wrap.innerHTML = '<div class="empty"><span class="spinner"></span> 타겟별 데이터 로딩 중... (10~30초 소요)</div>';
      try {
        const res = await fetch('/smart-sa/api/tab/device?'+periodParams());
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        tabLoaded.target = true;
        renderDeviceTab(json);
      } catch(e) { wrap.innerHTML = '<div class="empty">타겟별 조회 실패: '+e.message+'</div>'; }
    }

    function renderDeviceTab(d) {
      const wrap = document.getElementById('target-tab-content');
      const total = { imp: d.pc.imp+d.mobile.imp, clk: d.pc.clk+d.mobile.clk, cost: d.pc.cost+d.mobile.cost };
      function devCard(label, icon, data, color) {
        const costShare = total.cost > 0 ? (data.cost/total.cost*100).toFixed(1) : 0;
        const clkShare = total.clk > 0 ? (data.clk/total.clk*100).toFixed(1) : 0;
        return '<div class="card" style="flex:1;min-width:280px"><div class="card-header"><span class="card-title">'+icon+' '+label+'</span><span class="badge" style="background:'+color+'20;color:'+color+'">비용 '+costShare+'%</span></div><div class="card-body">'
          +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
          +'<div><div style="font-size:11px;color:#94a3b8">노출수</div><div style="font-size:18px;font-weight:700">'+num(data.imp)+'</div></div>'
          +'<div><div style="font-size:11px;color:#94a3b8">클릭수</div><div style="font-size:18px;font-weight:700;color:#2563eb">'+num(data.clk)+'</div></div>'
          +'<div><div style="font-size:11px;color:#94a3b8">CTR</div><div style="font-size:18px;font-weight:700">'+pct(data.ctr)+'</div></div>'
          +'<div><div style="font-size:11px;color:#94a3b8">총비용</div><div style="font-size:18px;font-weight:700">'+won(data.cost)+'</div></div>'
          +'<div><div style="font-size:11px;color:#94a3b8">CPC</div><div style="font-size:18px;font-weight:700">'+won(data.cpc)+'</div></div>'
          +'<div><div style="font-size:11px;color:#94a3b8">구매전환수</div><div style="font-size:18px;font-weight:700;color:#7c3aed">'+num(data.purchaseCnt)+'</div></div>'
          +'<div><div style="font-size:11px;color:#94a3b8">구매전환매출</div><div style="font-size:18px;font-weight:700;color:#16a34a">'+won(data.purchaseAmt)+'</div></div>'
          +'<div><div style="font-size:11px;color:#94a3b8">ROAS</div><div style="font-size:18px;font-weight:700;color:'+(data.roas>=100?'#16a34a':'#ef4444')+'">'+data.roas+'%</div></div>'
          +'</div></div></div>';
      }
      let html = '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px">';
      html += devCard('PC', '🖥', d.pc, '#3b82f6');
      html += devCard('모바일', '📱', d.mobile, '#f59e0b');
      html += '</div>';

      // PC vs MO 비교 바
      html += '<div class="card" style="margin-bottom:16px"><div class="card-header"><span class="card-title">PC vs 모바일 비교</span></div><div class="card-body">';
      ['비용','클릭','노출','구매매출'].forEach(metric => {
        const pcV = metric==='비용'?d.pc.cost:metric==='클릭'?d.pc.clk:metric==='노출'?d.pc.imp:d.pc.purchaseAmt;
        const moV = metric==='비용'?d.mobile.cost:metric==='클릭'?d.mobile.clk:metric==='노출'?d.mobile.imp:d.mobile.purchaseAmt;
        const t = pcV+moV||1;
        const pcPct = (pcV/t*100).toFixed(0);
        const moPct = (moV/t*100).toFixed(0);
        html += '<div style="margin-bottom:12px"><div style="font-size:12px;font-weight:600;margin-bottom:4px">'+metric+'</div>';
        html += '<div style="display:flex;height:22px;border-radius:6px;overflow:hidden">';
        html += '<div style="width:'+pcPct+'%;background:#3b82f6;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:600;min-width:30px">PC '+pcPct+'%</div>';
        html += '<div style="width:'+moPct+'%;background:#f59e0b;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:600;min-width:30px">MO '+moPct+'%</div>';
        html += '</div></div>';
      });
      html += '</div></div>';

      wrap.innerHTML = html;
    }

    // ── 캠페인별 탭 ──
    var campaignData = null;
    var campFilterIds = []; // 빈 배열 = 전체
    async function loadCampaigns() {
      const wrap = document.getElementById('campaigns-tab-content');
      wrap.innerHTML = '<div class="empty"><span class="spinner"></span> 캠페인별 데이터 로딩 중... (10~30초 소요)</div>';
      try {
        const res = await fetch('/smart-sa/api/tab/campaigns?'+periodParams());
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        tabLoaded.campaigns = true;
        renderCampaignTab(json.campaigns);
      } catch(e) { wrap.innerHTML = '<div class="empty">캠페인별 조회 실패: '+e.message+'</div>'; }
    }

    function renderCampaignTab(campaigns) {
      const wrap = document.getElementById('campaigns-tab-content');
      if (!campaigns || !campaigns.length) { wrap.innerHTML = '<div class="empty">캠페인 데이터가 없습니다.</div>'; return; }
      campaignData = campaigns;
      TAB_RERENDER['campaigns'] = function(){ if (campaignData) renderCampaignTab(campaignData); };

      var filtered = (!campFilterIds.length) ? campaigns : campaigns.filter(function(c){ return campFilterIds.indexOf(String(c.campaignId)) >= 0; });

      var html = '';
      // 멀티셀렉트 필터 바
      html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:8px 12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;flex-wrap:wrap">';
      html += renderMultiSelect({
        id: 'camp-filter',
        placeholder: '전체 캠페인',
        items: campaigns.map(function(c){ return { id: String(c.campaignId), name: c.campaignName }; }),
        selected: campFilterIds.slice(),
      });
      html += '<span style="font-size:12px;color:#94a3b8;margin-left:auto">표시: '+filtered.length+'개 / 전체: '+campaigns.length+'개</span>';
      html += '<button class="btn btn-outline btn-sm" onclick="openColSettings(\\\'campaigns\\\', function(){ if(campaignData) renderCampaignTab(campaignData); })" style="font-size:11px;padding:5px 10px">⚙ 열 설정</button>';
      html += '</div>';

      html += '<div class="card"><div class="card-header"><span class="card-title">캠페인별 성과</span></div><div class="card-body" style="overflow-x:auto">';
      html += renderColTable('campaigns', filtered);
      html += '</div></div>';
      wrap.innerHTML = html;

      bindMultiSelect('camp-filter', function(selectedIds){
        campFilterIds = selectedIds;
        renderCampaignTab(campaignData);
      });
    }

    // ── 다중 선택 위젯 ──
    function renderMultiSelect(opts) {
      // opts: { id, placeholder, items:[{id,name}], selected:[id,...] }
      var label = opts.placeholder;
      if (opts.selected.length > 0) label = opts.selected.length + '개 선택됨';
      // 가장 긴 항목 길이 기준으로 팝업 너비 계산 (한글 ~14px/문자 + 체크박스+여백 60px)
      var maxLen = Math.max.apply(null, opts.items.map(function(it){ return (it.name || it.id || '').length; }).concat([20]));
      var winW = (typeof window !== 'undefined' ? window.innerWidth : 1200);
      var popWidth = Math.min(Math.max(maxLen * 14 + 60, 380), Math.round(winW * 0.9));
      var html = '<div class="ms-wrap" id="'+opts.id+'-wrap" style="position:relative;display:inline-block">';
      html += '<button type="button" id="'+opts.id+'-btn" style="border:1px solid #e2e8f0;border-radius:6px;padding:5px 12px;font-size:12px;background:#fff;cursor:pointer;min-width:160px;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:8px">';
      html += '<span>'+label+'</span><span style="color:#94a3b8;font-size:10px">▼</span></button>';
      html += '<div id="'+opts.id+'-pop" class="ms-pop" style="display:none;position:absolute;top:100%;left:0;margin-top:4px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;box-shadow:0 8px 24px rgba(15,23,42,0.12);z-index:1000;width:'+popWidth+'px;max-width:90vw">';
      html += '<div style="padding:8px;border-bottom:1px solid #e2e8f0;display:flex;gap:6px;align-items:center">';
      html += '<input type="text" id="'+opts.id+'-search" placeholder="검색..." style="flex:1;min-width:120px;padding:4px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px">';
      html += '<button type="button" data-act="all" style="padding:4px 10px;font-size:11px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer;white-space:nowrap">전체</button>';
      html += '<button type="button" data-act="none" style="padding:4px 10px;font-size:11px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer;white-space:nowrap">해제</button>';
      html += '<button type="button" data-act="close" title="닫기" style="padding:4px 8px;font-size:14px;line-height:1;background:#fff;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer;color:#64748b">×</button>';
      html += '</div>';
      html += '<div id="'+opts.id+'-list" style="max-height:320px;overflow-y:auto;overflow-x:hidden;padding:4px 0">';
      opts.items.forEach(function(it){
        var checked = opts.selected.indexOf(it.id) >= 0;
        // grid 레이아웃: 체크박스는 18px 고정, 이름이 나머지 영역 차지
        html += '<label class="ms-item" data-name="'+(it.name||'').toLowerCase().replace(/"/g,'&quot;')+'" style="display:grid;grid-template-columns:18px 1fr;align-items:center;gap:10px;padding:6px 14px;font-size:12px;cursor:pointer">';
        html += '<input type="checkbox" value="'+it.id.replace(/"/g,'&quot;')+'" '+(checked?'checked':'')+' style="cursor:pointer;accent-color:#6366f1;width:16px;height:16px;margin:0">';
        html += '<span style="text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+(it.name||it.id)+'</span></label>';
      });
      html += '</div>';
      html += '<div style="padding:8px;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:6px">';
      html += '<button type="button" data-act="apply" style="padding:5px 14px;font-size:12px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600">적용</button>';
      html += '</div>';
      html += '</div></div>';
      return html;
    }
    // 전역: 한번에 한 개의 다중 선택 팝업만 열기
    function closeAllMultiSelectsExcept(exceptId) {
      document.querySelectorAll('.ms-pop').forEach(function(p){
        if (p.id !== exceptId+'-pop') p.style.display = 'none';
      });
    }
    function bindMultiSelect(id, onApply) {
      var wrap = document.getElementById(id+'-wrap');
      if (!wrap) return;
      var btn = document.getElementById(id+'-btn');
      var pop = document.getElementById(id+'-pop');
      var search = document.getElementById(id+'-search');
      var list = document.getElementById(id+'-list');
      function show() {
        closeAllMultiSelectsExcept(id);
        pop.style.display = 'block';
        setTimeout(function(){ search && search.focus(); }, 50);
      }
      function hide() { pop.style.display = 'none'; }
      btn.onclick = function(e){ e.stopPropagation(); pop.style.display==='block'?hide():show(); };
      // 외부 클릭 시 닫기 (다른 ms-wrap 클릭 시도 자기 자신은 hide되지 않게 처리)
      var onDoc = function(e){
        if (wrap.contains(e.target)) return;
        // 다른 ms-wrap 안 클릭이면 자기 자신만 닫기 (해당 ms-wrap의 show가 closeAll 처리)
        hide();
      };
      document.addEventListener('click', onDoc);
      // 검색 필터
      if (search) search.oninput = function(){
        var q = search.value.toLowerCase();
        list.querySelectorAll('.ms-item').forEach(function(el){
          el.style.display = (!q || (el.dataset.name||'').indexOf(q) >= 0) ? '' : 'none';
        });
      };
      // 액션 버튼
      pop.querySelectorAll('button[data-act]').forEach(function(b){
        b.onclick = function(e){
          e.stopPropagation();
          var act = b.dataset.act;
          if (act === 'all') {
            list.querySelectorAll('input[type=checkbox]').forEach(function(c){
              if (c.closest('.ms-item').style.display !== 'none') c.checked = true;
            });
          } else if (act === 'none') {
            list.querySelectorAll('input[type=checkbox]').forEach(function(c){ c.checked = false; });
          } else if (act === 'close') {
            hide();
          } else if (act === 'apply') {
            var sel = [];
            list.querySelectorAll('input[type=checkbox]:checked').forEach(function(c){ sel.push(c.value); });
            hide();
            document.removeEventListener('click', onDoc);
            onApply(sel);
          }
        };
      });
    }

    // ── 그룹별 탭 ──
    async function loadAdgroups() {
      const wrap = document.getElementById('adgroups-tab-content');
      wrap.innerHTML = '<div class="empty"><span class="spinner"></span> 광고그룹 데이터 로딩 중... (10~30초 소요)</div>';
      try {
        const res = await fetch('/smart-sa/api/tab/adgroups?'+periodParams());
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        tabLoaded.adgroups = true;
        renderAdgroupTab(json.adgroups);
      } catch(e) { wrap.innerHTML = '<div class="empty">광고그룹 조회 실패: '+e.message+'</div>'; }
    }

    var adgroupData = null;
    var agFilterCampNames = []; // 빈 배열 = 전체 (다중 선택)
    var agFilterAgIds = [];     // 빈 배열 = 전체 (광고그룹 다중 선택)
    function renderAdgroupTab(adgroups) {
      const wrap = document.getElementById('adgroups-tab-content');
      if (!adgroups?.length) { wrap.innerHTML = '<div class="empty">광고그룹 데이터가 없습니다.</div>'; return; }
      adgroupData = adgroups;
      TAB_RERENDER['adgroups'] = function(){ if (adgroupData) renderAdgroupTab(adgroupData); };

      // 캠페인 옵션
      var campMap = {};
      adgroups.forEach(function(a){ if(a.campaignName && !campMap[a.campaignName]) campMap[a.campaignName] = true; });
      var campOpts = Object.keys(campMap).sort().map(function(n){ return { id:n, name:n }; });

      // 캠페인 필터 적용 후 광고그룹 옵션 (선택된 캠페인 안의 그룹만 보여줌)
      var afterCampFilter = (!agFilterCampNames.length) ? adgroups :
        adgroups.filter(function(a){ return agFilterCampNames.indexOf(a.campaignName) >= 0; });
      var agSet = {};
      afterCampFilter.forEach(function(a){ if (a.adgroupId && !agSet[a.adgroupId]) agSet[a.adgroupId] = a.adgroupName || a.adgroupId; });
      var agOpts = Object.entries(agSet).map(function(e){ return { id:String(e[0]), name:e[1] }; })
        .sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); });
      // 선택된 광고그룹이 옵션에 없으면 정리
      agFilterAgIds = agFilterAgIds.filter(function(id){ return !!agSet[id]; });

      var filtered = afterCampFilter.filter(function(a){
        if (agFilterAgIds.length && agFilterAgIds.indexOf(String(a.adgroupId)) < 0) return false;
        return true;
      });

      let html = '';
      // 필터 바 (캠페인 + 광고그룹 다중 선택)
      html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:8px 12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;flex-wrap:wrap">';
      html += renderMultiSelect({ id:'ag-camp-filter', placeholder:'전체 캠페인', items:campOpts, selected:agFilterCampNames.slice() });
      html += renderMultiSelect({ id:'ag-ag-filter', placeholder:'전체 광고그룹', items:agOpts, selected:agFilterAgIds.slice() });
      html += '<span style="font-size:12px;color:#94a3b8;margin-left:auto">표시: '+filtered.length+'개 / 전체: '+adgroups.length+'개</span>';
      html += '<button class="btn btn-outline btn-sm" onclick="openColSettings(\\\'adgroups\\\', function(){ if(adgroupData) renderAdgroupTab(adgroupData); })" style="font-size:11px;padding:5px 10px">⚙ 열 설정</button>';
      html += '</div>';

      html += '<div class="card"><div class="card-header"><span class="card-title">광고그룹별 성과</span></div><div class="card-body" style="overflow-x:auto">';
      html += renderColTable('adgroups', filtered);
      html += '</div></div>';
      wrap.innerHTML = html;

      bindMultiSelect('ag-camp-filter', function(selected){
        agFilterCampNames = selected;
        // 캠페인 필터 변경 시 광고그룹 필터는 유효한 것만 자동 정리
        renderAdgroupTab(adgroupData);
      });
      bindMultiSelect('ag-ag-filter', function(selected){
        agFilterAgIds = selected;
        renderAdgroupTab(adgroupData);
      });
    }

    // ── 공통 유틸 ──
    function num(v){return Number(v||0).toLocaleString('ko-KR')}
    function pct(v){return Number(v||0).toFixed(2)+'%'}
    function won(v){return '₩'+Number(v||0).toLocaleString('ko-KR')}
    function rnk(v){return v?Number(v).toFixed(1)+'위':'-'}

    // ── CSV 다운로드 (현재 탭의 표 데이터 자동 추출) ──
    function csvEscape(v) {
      var s = String(v == null ? '' : v);
      // ₩, 콤마, 퍼센트 기호 제거하여 숫자 셀로 인식되게 함
      s = s.replace(/[₩￦]/g, '').trim();
      // CSV 특수문자 처리
      if (s.indexOf('"') >= 0 || s.indexOf(',') >= 0 || s.indexOf('\\n') >= 0) {
        s = '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }
    function tableToCsv(tbl) {
      var lines = [];
      var heads = [];
      tbl.querySelectorAll('thead tr th').forEach(function(th){
        heads.push(csvEscape(th.textContent.replace(/[▲▼]/g,'').trim()));
      });
      lines.push(heads.join(','));
      tbl.querySelectorAll('tbody tr').forEach(function(tr){
        var row = [];
        tr.querySelectorAll('td').forEach(function(td){
          // 비용비중 바 같은 그래픽만 들어있으면 빈 칸
          var txt = (td.innerText || td.textContent || '').trim();
          row.push(csvEscape(txt));
        });
        if (row.length) lines.push(row.join(','));
      });
      return lines.join('\\r\\n');
    }
    function downloadCurrentTabCSV() {
      var tabId = 'tab-' + currentTab;
      var pane = document.getElementById(tabId);
      if (!pane) return toast('탭을 찾을 수 없습니다.', true);
      var tables = pane.querySelectorAll('table');
      if (!tables.length) return toast('다운로드할 표 데이터가 없습니다. 먼저 데이터를 조회해주세요.', true);

      var labelMap = {summary:'요약', campaigns:'캠페인별', adgroups:'그룹별', keywords:'키워드별', target:'타겟별', hourly:'시간대별'};
      var sectionTitles = pane.querySelectorAll('.card-title');
      var parts = [];
      tables.forEach(function(tbl, idx){
        var title = sectionTitles[idx] ? sectionTitles[idx].textContent.trim() : ('표' + (idx+1));
        parts.push('# ' + title);
        parts.push(tableToCsv(tbl));
        parts.push('');
      });
      var csv = parts.join('\\r\\n');
      // UTF-8 BOM 추가 (Excel 한글 깨짐 방지)
      var blob = new Blob(['\\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var ts = new Date();
      var fname = (labelMap[currentTab] || currentTab) + '_' +
                  ts.getFullYear() + ('0'+(ts.getMonth()+1)).slice(-2) + ('0'+ts.getDate()).slice(-2) +
                  '_' + ('0'+ts.getHours()).slice(-2) + ('0'+ts.getMinutes()).slice(-2) + '.csv';
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click();
      setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
      toast('CSV 다운로드 시작: ' + fname);
    }
    function updateCsvBtnVisibility() {
      var btn = document.getElementById('csv-download-btn');
      if (!btn) return;
      // 요약 탭에는 표가 없으니 숨김, 나머지는 표시
      btn.style.display = (currentTab === 'summary') ? 'none' : 'inline-flex';
    }
    // 탭 전환 시 버튼 표시 갱신 (switchTab 후크)
    var _origSwitchTab = switchTab;
    switchTab = function(name){ _origSwitchTab(name); updateCsvBtnVisibility(); };
    updateCsvBtnVisibility();
    </script>
  `;

  res.send(appLayout('SA 성과 대시보드', content, user, 'dashboard', await getLayoutOpts(req)));
});

// ─── API: 통계 ──────────────────────────────────────────────────────
router.get('/api/stats', requireLogin, async (req, res) => {
  try {
    const { period = 'yesterday', accountId } = req.query;
    if (!accountId) return res.status(400).json({ ok: false, error: '광고주를 선택해주세요.' });

    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주를 찾을 수 없습니다' });

    const dateRange = resolvePeriodDates(period, req.query.startDate, req.query.endDate);

    // DB 동기화 데이터 우선 조회 (빠른 경로)
    const synced = await db.isSynced(account.id, dateRange.since, dateRange.until);
    if (synced) {
      const stats = await db.queryStatsSummary(account.id, dateRange.since, dateRange.until);
      return res.json({ ok: true, stats, source: 'db' });
    }

    // Fallback: 실시간 API 호출
    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });

    const client = makeClient(creds, account.customer_id);

    const [statsResult, convResult] = await Promise.allSettled([
      client.getStats({ startDate: dateRange.since, endDate: dateRange.until }),
      fetchAllStatRows(client, account.customer_id, 'AD_CONVERSION_DETAIL', dateRange),
    ]);

    const stats = statsResult.status === 'fulfilled' ? statsResult.value
      : { impCnt: 0, clkCnt: 0, salesAmt: 0, ctr: 0, avgRnk: 0 };

    // 구매완료 전환 데이터: Stats API purchaseCcnt/purchaseConvAmt 우선 사용 (네이버 대시보드와 일치)
    if (typeof stats.purchaseCcnt === 'number' && typeof stats.purchaseConvAmt === 'number') {
      // Stats API에서 직접 받은 구매완료 데이터 → 대시보드와 100% 일치
      stats.purchaseAmt = stats.purchaseConvAmt;
      stats.purchaseCnt = stats.purchaseCcnt;
      stats.roas = stats.salesAmt > 0 ? Math.round(stats.purchaseConvAmt / stats.salesAmt * 100) : 0;
      if (stats.campStats) {
        for (const cs of stats.campStats) {
          cs.purchaseAmt = cs.purchaseConvAmt || 0;
          cs.purchaseCnt = cs.purchaseCcnt || 0;
        }
      }
    } else if (convResult.status === 'fulfilled') {
      // Fallback: AD_CONVERSION_DETAIL TSV 파싱 (한국어 convType 포함)
      const convRows = convResult.value;
      let purchaseAmt = 0, purchaseCnt = 0;
      const byCampaign = {};
      for (const { cols } of convRows) {
        if (cols.length < 15) continue;
        const convType = (cols[12] || '').trim();
        const convTypeLower = convType.toLowerCase();
        const isPurchase = convTypeLower === 'purchase' || convTypeLower === 'purchase_complete' || convTypeLower === 'complete_purchase'
          || convTypeLower === 'conversion' || convTypeLower === 'conv' || convTypeLower === '1'
          || convType === '구매완료';
        if (isPurchase) {
          const campaignId = cols[2];
          const cnt = parseInt(cols[13]) || 0;
          const amt = parseInt(cols[14]) || 0;
          purchaseAmt += amt;
          purchaseCnt += cnt;
          if (!byCampaign[campaignId]) byCampaign[campaignId] = { amt: 0, cnt: 0 };
          byCampaign[campaignId].amt += amt;
          byCampaign[campaignId].cnt += cnt;
        }
      }
      stats.purchaseAmt = purchaseAmt;
      stats.purchaseCnt = purchaseCnt;
      stats.roas = stats.salesAmt > 0 ? Math.round(purchaseAmt / stats.salesAmt * 100) : 0;
      if (stats.campStats) {
        for (const cs of stats.campStats) {
          const p = byCampaign[cs.id] || { amt: 0, cnt: 0 };
          cs.purchaseAmt = p.amt;
          cs.purchaseCnt = p.cnt;
        }
      }
    }

    res.json({ ok: true, stats, source: 'api' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API: 키워드별 통계 (별도 로딩) ─────────────────────────────────
router.get('/api/keyword-stats', requireLogin, async (req, res) => {
  try {
    const { period = 'yesterday', accountId } = req.query;
    if (!accountId) return res.status(400).json({ ok: false, error: '광고주 ID 필요' });

    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주를 찾을 수 없습니다' });

    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });

    const client = makeClient(creds, account.customer_id);
    const timeMap = { yesterday: 'yesterday', '7days': 'last7days', '30days': 'last30days' };
    const timeRange = timeMap[period] || 'yesterday';

    const keywordStats = await client.getKeywordStats({ timeRange });
    res.json({ ok: true, keywordStats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Stat Report 캐시 레이어 ─────────────────────────────────────────
const statCache = new Map(); // key: "customerId:reportTp:date" → parsed rows
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4시간

function getCacheKey(customerId, reportTp, dt) { return `${customerId}:${reportTp}:${dt}`; }

async function cachedStatReport(client, customerId, reportTp, dt) {
  const key = getCacheKey(customerId, reportTp, dt);
  const cached = statCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.rows;
  const rows = await client.createAndDownloadStatReport(reportTp, dt);
  // ⚠️ 빈 결과는 캐시하지 않음 (데이터 미생성 상태일 수 있음)
  if (rows && rows.length > 0) {
    statCache.set(key, { rows, ts: Date.now() });
  }
  // LRU: 500개 초과 시 오래된 것 제거
  if (statCache.size > 500) {
    const oldest = [...statCache.entries()].sort((a,b) => a[1].ts - b[1].ts)[0];
    if (oldest) statCache.delete(oldest[0]);
  }
  return rows;
}

function getDatesBetween(since, until) {
  const dates = [];
  const s = new Date(since), e = new Date(until);
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) dates.push(d.toISOString().slice(0, 10));
  return dates;
}

// KST(UTC+9) 기준 날짜 포맷
function fmtKST(d) {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function resolvePeriodDates(period, startDate, endDate) {
  if (period === 'custom' && startDate && endDate) {
    return { since: startDate, until: endDate };
  }
  const now = new Date();
  if (period === '7days') {
    const end = new Date(now); end.setDate(end.getDate() - 1);
    const start = new Date(now); start.setDate(start.getDate() - 7);
    return { since: fmtKST(start), until: fmtKST(end) };
  }
  if (period === '30days') {
    const end = new Date(now); end.setDate(end.getDate() - 1);
    const start = new Date(now); start.setDate(start.getDate() - 30);
    return { since: fmtKST(start), until: fmtKST(end) };
  }
  if (period === 'lastMonth') {
    // 전월 1일 ~ 말일 (KST 기준)
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const y = kst.getFullYear(), m = kst.getMonth(); // 현재 월
    const firstDay = new Date(y, m - 1, 1); // 전월 1일
    const lastDay = new Date(y, m, 0); // 전월 마지막 날
    return { since: firstDay.toISOString().slice(0, 10), until: lastDay.toISOString().slice(0, 10) };
  }
  const d = new Date(now); d.setDate(d.getDate() - 1);
  return { since: fmtKST(d), until: fmtKST(d) };
}

async function fetchAllStatRows(client, customerId, reportTp, dateRange) {
  const dates = getDatesBetween(dateRange.since, dateRange.until);
  const allRows = [];
  // 동시 10개씩 병렬 다운로드
  for (let i = 0; i < dates.length; i += 10) {
    const batch = dates.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(dt => cachedStatReport(client, customerId, reportTp, dt).then(rows => rows.map(r => ({ date: dt, cols: r }))))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') allRows.push(...r.value);
    }
  }
  return allRows;
}

// 마스터 데이터 없을 때 API에서 이름 매핑 빌드
// Naver API campaignTp: 정수 또는 문자열 모두 처리
function normalizeCampaignTp(tp) {
  // 공식 API: 1=WEB_SITE(파워링크), 2=SHOPPING(쇼핑검색), 3=POWER_CONTENTS(파워콘텐츠), 4=BRAND(브랜드검색), 6=LOCAL_SMB(로컬)
  if (tp === 1 || tp === '1' || tp === 'WEB_SITE') return 1;
  if (tp === 2 || tp === '2' || tp === 'SHOPPING') return 2;
  if (tp === 3 || tp === '3' || tp === 'POWER_CONTENTS') return 3;
  if (tp === 4 || tp === '4' || tp === 'BRAND' || tp === 'BRAND_SEARCH') return 4;
  if (tp === 6 || tp === '6' || tp === 'LOCAL_SMB') return 6;
  return parseInt(tp) || 1;
}

// 이름 매핑 캐시 (5분 TTL)
const nameMapCache = new Map();
const NAME_MAP_TTL = 5 * 60 * 1000;

/**
 * 마스터 리포트 API로 전체 캠페인/광고그룹/키워드를 한번에 다운로드
 * - 개별 API 호출 대비 10배 이상 빠름 (3개 리포트 동시 다운로드)
 * - DB에도 자동 저장하여 이후 요청은 DB에서 즉시 조회
 */
async function buildNameMapsFromMasterReport(client, accountId) {
  const campMap = {}, agMap = {}, kwMap = {};
  try {
    console.log(`📥 [account:${accountId}] 마스터 리포트 다운로드 시작...`);
    const [campRows, agRows, kwRows] = await Promise.all([
      client.syncMaster('Campaign').catch(e => { console.log('캠페인 마스터 실패:', e.message); return []; }),
      client.syncMaster('Adgroup').catch(e => { console.log('광고그룹 마스터 실패:', e.message); return []; }),
      client.syncMaster('Keyword').catch(e => { console.log('키워드 마스터 실패:', e.message); return []; }),
    ]);

    // TSV → Map 빌드 (캠페인: [0]customerId, [1]campaignId, [2]name, [3]tp)
    for (const r of campRows) {
      if (r.length < 3) continue;
      campMap[r[1]] = { name: r[2], tp: normalizeCampaignTp(parseInt(r[3]) || 1) };
    }
    // 광고그룹: [0]customerId, [1]adgroupId, [2]campaignId, [3]adgroupName
    for (const r of agRows) {
      if (r.length < 4) continue;
      agMap[r[1]] = { name: r[3], campaignId: r[2] || '' };
    }
    // 키워드: [0]customerId, [1]adgroupId, [2]keywordId, [3]keyword(텍스트!)
    for (const r of kwRows) {
      if (r.length < 4) continue;
      const ag = agMap[r[1]] || {};
      const camp = campMap[ag.campaignId] || {};
      kwMap[r[2]] = {
        keyword: r[3] || '', adgroupId: r[1] || '',
        adgroupName: ag.name || '', campaignId: ag.campaignId || '',
        campaignName: camp.name || '', campaignTp: camp.tp || 1,
      };
    }

    console.log(`📋 마스터: 캠페인 ${campRows.length}, 그룹 ${agRows.length}, 키워드 ${kwRows.length}`);

    // DB에 자동 저장 (다음 요청부터 DB에서 즉시 조회)
    if (accountId && (campRows.length > 0 || agRows.length > 0)) {
      try {
        if (campRows.length > 0) await db.upsertMasterCampaigns(accountId, campRows);
        if (agRows.length > 0) await db.upsertMasterAdgroups(accountId, agRows);
        if (kwRows.length > 0) await db.upsertMasterKeywords(accountId, kwRows);
        console.log(`💾 [account:${accountId}] 마스터 DB 자동 저장 완료`);
      } catch (e) { console.log('마스터 DB 저장 실패:', e.message); }
    }
  } catch (e) {
    console.log('마스터 리포트 전체 실패:', e.message);
  }
  return { campMap, agMap, kwMap };
}

async function getNameMaps(client, accountId) {
  // 캐시 확인
  const cacheKey = `nm:${accountId}`;
  const cached = nameMapCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < NAME_MAP_TTL) return cached.data;

  // 1. DB 마스터 데이터 확인
  const master = await db.buildKeywordMaps(accountId);
  const hasMaster = Object.keys(master.kwMap).length > 0;
  if (hasMaster) {
    const data = { ...master, hasMaster: true };
    nameMapCache.set(cacheKey, { data, ts: Date.now() });
    return data;
  }

  // 2. DB에 없으면 마스터 리포트 API로 전체 다운로드 + DB 저장
  const api = await buildNameMapsFromMasterReport(client, accountId);
  const data = { ...api, hasMaster: Object.keys(api.kwMap).length > 0 };
  nameMapCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

// ─── API: 탭 데이터 (키워드별) ──────────────────────────────────────
router.get('/api/tab/keywords', requireLogin, async (req, res) => {
  try {
    const { period = 'yesterday', accountId, limit: lim } = req.query;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });

    const dateRange = resolvePeriodDates(period, req.query.startDate, req.query.endDate);

    // ─── 마스터 데이터 보장: 없으면 먼저 동기화 ───
    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    const masterCheck = await db.get('SELECT COUNT(*)::int AS cnt FROM master_keywords WHERE account_id = $1', [account.id]);
    if (masterCheck.cnt === 0 && creds) {
      console.log(`📥 [${account.id}] 마스터 데이터 없음 → 자동 동기화 시작`);
      try {
        const client = makeClient(creds, account.customer_id);
        await buildNameMapsFromMasterReport(client, account.id);
        nameMapCache.delete(`nm:${account.id}`); // 캐시 초기화
      } catch (e) { console.log('마스터 자동 동기화 실패:', e.message); }
    }

    // DB 동기화 데이터 우선 조회
    const synced = await db.isSynced(account.id, dateRange.since, dateRange.until);
    console.log(`🔍 [키워드탭] account=${account.id} period=${dateRange.since}~${dateRange.until} synced=${synced}`);
    if (synced) {
      const rows = await db.queryStatsKeywords(account.id, dateRange.since, dateRange.until);
      const shopRowCount = rows.filter(r => normalizeCampaignTp(r.campaignTp) === 2).length;
      console.log(`🔍 [키워드탭 DB] 전체 ${rows.length}행, 쇼핑 ${shopRowCount}행`);
      const byKw = {};
      for (const r of rows) {
        const campTp = normalizeCampaignTp(r.campaignTp);
        const groupKey = `kw:${r.keyword_id}`;
        if (!byKw[groupKey]) {
          byKw[groupKey] = {
            keywordId: r.keyword_id,
            keyword: r.keyword,
            campaignTp: campTp,
            campaignName: r.campaignName,
            adgroupName: r.adgroupName,

            imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0,
          };
        }
        byKw[groupKey].imp += r.imp;
        byKw[groupKey].clk += r.clk;
        byKw[groupKey].cost += Number(r.cost);
        byKw[groupKey].purchaseCnt += r.purchaseCnt;
        byKw[groupKey].purchaseAmt += Number(r.purchaseAmt);
      }

      const allKw = Object.values(byKw).map(kw => ({
        ...kw,
        ctr: kw.imp > 0 ? (kw.clk / kw.imp * 100) : 0,
        cpc: kw.clk > 0 ? Math.round(kw.cost / kw.clk) : 0,
        roas: kw.cost > 0 ? Math.round(kw.purchaseAmt / kw.cost * 100) : 0,
      }));

      const powerlink = allKw.filter(k => k.campaignTp === 1).sort((a, b) => b.cost - a.cost);
      const shopping = allKw.filter(k => k.campaignTp === 2).sort((a, b) => b.cost - a.cost);
      const other = allKw.filter(k => k.campaignTp !== 1 && k.campaignTp !== 2).sort((a, b) => b.cost - a.cost);

      const maxItems = lim === 'all' ? 99999 : 10;
      return res.json({
        ok: true, hasMaster: masterCheck.cnt > 0, source: 'db',
        powerlink: powerlink.slice(0, maxItems), shopping: shopping.slice(0, maxItems), other: other.slice(0, maxItems),
        powerlinkTotal: powerlink.length, shoppingTotal: shopping.length, otherTotal: other.length,
      });
    }

    // Fallback: API 실시간 호출
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });

    const client = makeClient(creds, account.customer_id);

    const { kwMap, agMap, campMap, hasMaster } = await getNameMaps(client, account.id);

    // 4개 리포트 병렬 다운로드 (속도 개선)
    const [adRes, convRes, shopRes, shopConvRes] = await Promise.allSettled([
      fetchAllStatRows(client, account.customer_id, 'AD_DETAIL', dateRange),
      fetchAllStatRows(client, account.customer_id, 'AD_CONVERSION_DETAIL', dateRange),
      fetchAllStatRows(client, account.customer_id, 'SHOPPINGKEYWORD_DETAIL', dateRange),
      fetchAllStatRows(client, account.customer_id, 'SHOPPINGKEYWORD_CONVERSION_DETAIL', dateRange),
    ]);
    // AD_DETAIL: 파워링크 키워드 분석용 (keywordId != '-' 행만)
    // SHOPPINGKEYWORD_DETAIL: 쇼핑 키워드 분석용
    // (이전 버그: keywordId='-' 필터가 파워링크 데이터까지 제거)
    const adRows = adRes.status === 'fulfilled' ? adRes.value : [];
    const convRows = convRes.status === 'fulfilled' ? convRes.value : [];
    const shopKwRows = shopRes.status === 'fulfilled' ? shopRes.value : [];
    const shopConvRows = shopConvRes.status === 'fulfilled' ? shopConvRes.value : [];

    // 디버그 로깅: 쇼핑 키워드 데이터 상태 추적
    console.log(`🔍 [키워드탭] AD_DETAIL: ${adRows.length}행, AD_CONV: ${convRows.length}행, SHOP_KW: ${shopKwRows.length}행, SHOP_CONV: ${shopConvRows.length}행`);
    if (shopRes.status === 'rejected') console.error(`❌ SHOPPINGKEYWORD_DETAIL 실패:`, shopRes.reason?.message || shopRes.reason);
    if (shopConvRes.status === 'rejected') console.error(`❌ SHOPPINGKEYWORD_CONVERSION_DETAIL 실패:`, shopConvRes.reason?.message || shopConvRes.reason);
    if (shopKwRows.length > 0) console.log(`  📋 쇼핑 키워드 샘플:`, JSON.stringify(shopKwRows[0]?.cols?.slice(0, 6)));
    if (adRes.status === 'rejected') console.error(`❌ AD_DETAIL 실패:`, adRes.reason?.message || adRes.reason);

    const byKw = {};
    // 파워링크 키워드 (AD_DETAIL에서 keywordId가 실제 키워드인 행)
    for (const { cols } of adRows) {
      if (cols.length < 15) continue;
      const campId = cols[2]; const agId = cols[3]; const kwId = cols[4];
      if (!kwId || kwId === '-' || kwId === '0' || kwId === '') continue;
      const campTp = normalizeCampaignTp(campMap[campId]?.tp || kwMap[kwId]?.campaignTp || 0);
      if (campTp === 2) continue; // 쇼핑검색은 SHOPPINGKEYWORD_DETAIL에서 처리
      const groupKey = `kw:${kwId}`;
      if (!byKw[groupKey]) {
        const info = kwMap[kwId] || {};
        const agInfo = agMap[agId] || {};
        byKw[groupKey] = {
          keywordId: kwId,
          keyword: info.keyword || kwId,
          campaignTp: campTp,
          campaignName: info.campaignName || campMap[campId]?.name || '',
          adgroupName: info.adgroupName || agInfo.name || '',

          imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0,
        };
      }
      byKw[groupKey].imp += parseInt(cols[11]) || 0;
      byKw[groupKey].clk += parseInt(cols[12]) || 0;
      byKw[groupKey].cost += parseInt(cols[13]) || 0;
    }
    // 쇼핑 키워드 (SHOPPINGKEYWORD_DETAIL)
    // 실제 TSV 형식 (16열): [0]date [1]custId [2]campId [3]agId [4]keyword(TEXT) [5]adId [6]bsnId [7]hour [8]code [9]queryGrpId [10]device [11]imp [12]clk [13]cost [14]rank [15]?
    for (const { cols } of shopKwRows) {
      if (cols.length < 14) continue;
      const campId = cols[2]; const agId = cols[3]; const kwText = cols[4];
      if (!kwText || kwText === '-' || kwText === '') continue;
      const groupKey = `kw:shop:${campId}:${agId}:${kwText}`;
      if (!byKw[groupKey]) {
        const agInfo = agMap[agId] || {};
        byKw[groupKey] = {
          keywordId: kwText,
          keyword: kwText,
          campaignTp: 2,
          campaignName: campMap[campId]?.name || '',
          adgroupName: agInfo.name || '',
          imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0,
        };
      }
      byKw[groupKey].imp += parseInt(cols[11]) || 0;
      byKw[groupKey].clk += parseInt(cols[12]) || 0;
      byKw[groupKey].cost += parseInt(cols[13]) || 0;
    }
    // 쇼핑 키워드 폴백: SHOPPINGKEYWORD_DETAIL 실패/빈경우 → AD_DETAIL에서 쇼핑캠페인 그룹별 집계
    if (shopKwRows.length === 0) {
      console.log(`⚠️ SHOPPINGKEYWORD_DETAIL 데이터 없음 → AD_DETAIL 쇼핑 캠페인 폴백`);
      for (const { cols } of adRows) {
        if (cols.length < 15) continue;
        const campId = cols[2]; const agId = cols[3]; const kwId = cols[4];
        const campTp = normalizeCampaignTp(campMap[campId]?.tp || 0);
        if (campTp !== 2) continue; // 쇼핑캠페인만
        // AD_DETAIL에서 쇼핑캠페인은 keyword_id='-' → 그룹별로 집계
        const groupKey = `kw:shop:ag:${agId}`;
        if (!byKw[groupKey]) {
          const agInfo = agMap[agId] || {};
          byKw[groupKey] = {
            keywordId: agId,
            keyword: agInfo.name || `쇼핑그룹_${agId.slice(-6)}`,
            campaignTp: 2,
            campaignName: campMap[campId]?.name || '',
            adgroupName: agInfo.name || '',
            imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0,
          };
        }
        byKw[groupKey].imp += parseInt(cols[11]) || 0;
        byKw[groupKey].clk += parseInt(cols[12]) || 0;
        byKw[groupKey].cost += parseInt(cols[13]) || 0;
      }
    }
    // 구매완료 전환 판별 헬퍼 (영문 + 한국어 + 코드)
    function isPurchaseConv(ct) {
      var lo = (ct || '').trim().toLowerCase();
      var raw = (ct || '').trim();
      return lo === 'purchase' || lo === 'purchase_complete' || lo === 'complete_purchase'
        || lo === 'conversion' || lo === 'conv' || lo === '1'
        || raw === '구매완료';
    }
    // 파워링크 전환 (AD_CONVERSION_DETAIL)
    for (const { cols } of convRows) {
      if (cols.length < 15) continue;
      const kwId = cols[4]; const convType = cols[12];
      if (!kwId || kwId === '-') continue;
      if (!isPurchaseConv(convType)) continue;
      const groupKey = `kw:${kwId}`;
      if (!byKw[groupKey]) continue;
      byKw[groupKey].purchaseCnt += parseInt(cols[13]) || 0;
      byKw[groupKey].purchaseAmt += parseInt(cols[14]) || 0;
    }
    // 쇼핑 전환 (SHOPPINGKEYWORD_CONVERSION_DETAIL)
    // 실제 TSV 형식 (15열): [0]date [1]custId [2]campId [3]agId [4]keyword(TEXT) [5]adId [6]bsnId [7]hour [8]code [9]queryGrpId [10]device [11]directFlag [12]convType [13]convCnt [14]convAmt
    for (const { cols } of shopConvRows) {
      if (cols.length < 15) continue;
      const campId = cols[2]; const agId = cols[3]; const kwText = cols[4];
      const convType = cols[12];
      if (!kwText || kwText === '-') continue;
      if (!isPurchaseConv(convType)) continue;
      const groupKey = `kw:shop:${campId}:${agId}:${kwText}`;
      if (!byKw[groupKey]) continue;
      byKw[groupKey].purchaseCnt += parseInt(cols[13]) || 0;
      byKw[groupKey].purchaseAmt += parseInt(cols[14]) || 0;
    }
    // 쇼핑 전환 폴백: shopConvRows 없으면 AD_CONVERSION_DETAIL에서 쇼핑캠페인 전환 매칭
    if (shopConvRows.length === 0 && shopKwRows.length > 0) {
      // AD_CONVERSION_DETAIL에는 keyword_id가 '-'이므로 campId+agId로 매칭
      const shopAgConv = {};
      for (const { cols } of convRows) {
        if (cols.length < 15) continue;
        const campId = cols[2]; const agId = cols[3]; const convType = cols[12];
        const campTp = normalizeCampaignTp(campMap[campId]?.tp || 0);
        if (campTp !== 2) continue;
        if (!isPurchaseConv(convType)) continue;
        const agKey = `${campId}:${agId}`;
        if (!shopAgConv[agKey]) shopAgConv[agKey] = { cnt: 0, amt: 0 };
        shopAgConv[agKey].cnt += parseInt(cols[13]) || 0;
        shopAgConv[agKey].amt += parseInt(cols[14]) || 0;
      }
      // 그룹별 전환을 해당 그룹의 키워드들에 균등 분배 (또는 첫 키워드에 할당)
      for (const [agKey, conv] of Object.entries(shopAgConv)) {
        const matching = Object.keys(byKw).filter(k => k.startsWith(`kw:shop:${agKey}:`));
        if (matching.length > 0) {
          byKw[matching[0]].purchaseCnt += conv.cnt;
          byKw[matching[0]].purchaseAmt += conv.amt;
        }
      }
    }
    // 쇼핑 키워드 폴백: SHOPPINGKEYWORD_DETAIL 없으면 AD_DETAIL 그룹별 집계
    if (shopKwRows.length === 0) {
      for (const { cols } of convRows) {
        if (cols.length < 15) continue;
        const campId = cols[2]; const agId = cols[3]; const convType = cols[12];
        const campTp = normalizeCampaignTp(campMap[campId]?.tp || 0);
        if (campTp !== 2) continue;
        if (!isPurchaseConv(convType)) continue;
        const groupKey = `kw:shop:ag:${agId}`;
        if (!byKw[groupKey]) continue;
        byKw[groupKey].purchaseCnt += parseInt(cols[13]) || 0;
        byKw[groupKey].purchaseAmt += parseInt(cols[14]) || 0;
      }
    }

    const allKw = Object.values(byKw).map(kw => ({ ...kw, ctr: kw.imp > 0 ? (kw.clk / kw.imp * 100) : 0, cpc: kw.clk > 0 ? Math.round(kw.cost / kw.clk) : 0, roas: kw.cost > 0 ? Math.round(kw.purchaseAmt / kw.cost * 100) : 0 }));
    const powerlink = allKw.filter(k => k.campaignTp === 1).sort((a, b) => b.cost - a.cost);
    const shopping = allKw.filter(k => k.campaignTp === 2).sort((a, b) => b.cost - a.cost);
    const other = allKw.filter(k => k.campaignTp !== 1 && k.campaignTp !== 2).sort((a, b) => b.cost - a.cost);

    const maxItems = lim === 'all' ? 99999 : 10;
    res.json({ ok: true, hasMaster, source: 'api', powerlink: powerlink.slice(0, maxItems), shopping: shopping.slice(0, maxItems), other: other.slice(0, maxItems), powerlinkTotal: powerlink.length, shoppingTotal: shopping.length, otherTotal: other.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API: 성과지표 추이 (트렌드 차트용) ──────────────────────────────
router.get('/api/stats/trend', requireLogin, async (req, res) => {
  try {
    const { period = '7days', accountId } = req.query;
    if (!accountId) return res.status(400).json({ ok: false, error: '광고주 선택 필요' });
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });

    const dateRange = resolvePeriodDates(period, req.query.startDate, req.query.endDate);

    // DB 동기화 데이터 조회
    const synced = await db.isSynced(account.id, dateRange.since, dateRange.until);
    if (synced) {
      const rows = await db.queryStatsTrend(account.id, dateRange.since, dateRange.until);
      const trend = rows.map(r => ({
        date: r.date.slice(0, 10),
        imp: Number(r.imp),
        clk: Number(r.clk),
        cost: Number(r.cost),
        purchaseAmt: Number(r.purchaseAmt),
        purchaseCnt: Number(r.purchaseCnt),
        ctr: r.imp > 0 ? (r.clk / r.imp * 100) : 0,
        cpc: r.clk > 0 ? Math.round(Number(r.cost) / r.clk) : 0,
        roas: Number(r.cost) > 0 ? Math.round(Number(r.purchaseAmt) / Number(r.cost) * 100) : 0,
      }));
      return res.json({ ok: true, trend, source: 'db' });
    }

    // Fallback: API에서 일별 데이터 구성
    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.status(400).json({ ok: false, error: 'API 미등록' });
    const client = makeClient(creds, account.customer_id);

    const adRows = await fetchAllStatRows(client, account.customer_id, 'AD_DETAIL', dateRange);
    const byDate = {};
    for (const { date, cols } of adRows) {
      if (cols.length < 14) continue;
      if (!byDate[date]) byDate[date] = { imp: 0, clk: 0, cost: 0, purchaseAmt: 0, purchaseCnt: 0 };
      byDate[date].imp += parseInt(cols[11]) || 0;
      byDate[date].clk += parseInt(cols[12]) || 0;
      byDate[date].cost += parseInt(cols[13]) || 0;
    }
    const trend = Object.entries(byDate).sort((a,b) => a[0].localeCompare(b[0])).map(([date, d]) => ({
      date,
      ...d,
      ctr: d.imp > 0 ? (d.clk / d.imp * 100) : 0,
      cpc: d.clk > 0 ? Math.round(d.cost / d.clk) : 0,
      roas: d.cost > 0 ? Math.round(d.purchaseAmt / d.cost * 100) : 0,
    }));
    res.json({ ok: true, trend, source: 'api' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API: 탭 데이터 (시간대별) ──────────────────────────────────────
router.get('/api/tab/hourly', requireLogin, async (req, res) => {
  try {
    const { period = 'yesterday', accountId } = req.query;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });

    const dateRange = resolvePeriodDates(period, req.query.startDate, req.query.endDate);
    // 캠페인 필터 (선택사항): ?campaigns=id1,id2
    const campaignIds = (req.query.campaigns || '').toString().split(',').map(s => s.trim()).filter(Boolean);
    const enrich = obj => ({
      ...obj, cost: Number(obj.cost || 0), purchaseAmt: Number(obj.purchaseAmt || 0),
      ctr: obj.imp > 0 ? (obj.clk / obj.imp * 100) : 0,
      cpc: obj.clk > 0 ? Math.round(Number(obj.cost) / obj.clk) : 0,
      roas: Number(obj.cost) > 0 ? Math.round(Number(obj.purchaseAmt) / Number(obj.cost) * 100) : 0,
    });

    // DB 우선 조회
    const synced = await db.isSynced(account.id, dateRange.since, dateRange.until);
    if (synced) {
      const { byHour: dbHour, byDay: dbDay } = await db.queryStatsHourly(account.id, dateRange.since, dateRange.until, campaignIds.length ? campaignIds : null);
      // 시간대 0~23 전체 채우기
      const hourMap = {};
      for (let h = 0; h < 24; h++) hourMap[h] = { hour: h, imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 };
      for (const r of dbHour) hourMap[r.hour] = { hour: r.hour, imp: r.imp, clk: r.clk, cost: r.cost, purchaseCnt: r.purchaseCnt, purchaseAmt: r.purchaseAmt };

      const dayNames = ['일','월','화','수','목','금','토'];
      const dayMap = {};
      for (let d = 0; d < 7; d++) dayMap[d] = { day: dayNames[d], dayIdx: d, imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 };
      for (const r of dbDay) dayMap[r.dow] = { day: dayNames[r.dow], dayIdx: r.dow, imp: r.imp, clk: r.clk, cost: r.cost, purchaseCnt: r.purchaseCnt, purchaseAmt: r.purchaseAmt };

      return res.json({
        ok: true, source: 'db',
        byHour: Object.values(hourMap).map(enrich),
        byDay: [1,2,3,4,5,6,0].map(d => enrich(dayMap[d])),
      });
    }

    // Fallback: API
    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });
    const client = makeClient(creds, account.customer_id);

    const [adRows, convRows] = await Promise.all([
      fetchAllStatRows(client, account.customer_id, 'AD_DETAIL', dateRange),
      fetchAllStatRows(client, account.customer_id, 'AD_CONVERSION_DETAIL', dateRange),
    ]);

    const byHour = {};
    for (let h = 0; h < 24; h++) byHour[h] = { hour: h, imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 };
    const dayNames = ['일','월','화','수','목','금','토'];
    const byDay = {};
    for (let d = 0; d < 7; d++) byDay[d] = { day: dayNames[d], dayIdx: d, imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 };

    const campSet = campaignIds.length ? new Set(campaignIds.map(String)) : null;
    for (const { date, cols } of adRows) {
      if (cols.length < 14) continue;
      if (campSet && !campSet.has(String(cols[2]))) continue;
      const hour = parseInt(cols[7]) || 0;
      byHour[hour].imp += parseInt(cols[11]) || 0;
      byHour[hour].clk += parseInt(cols[12]) || 0;
      byHour[hour].cost += parseInt(cols[13]) || 0;
      const dow = new Date(date).getDay();
      byDay[dow].imp += parseInt(cols[11]) || 0;
      byDay[dow].clk += parseInt(cols[12]) || 0;
      byDay[dow].cost += parseInt(cols[13]) || 0;
    }
    for (const { date, cols } of convRows) {
      if (cols.length < 15) continue;
      if (campSet && !campSet.has(String(cols[2]))) continue;
      const convType = cols[12];
      if (convType !== 'purchase' && convType !== 'purchase_complete' && convType !== 'complete_purchase') continue;
      const hour = parseInt(cols[7]) || 0;
      byHour[hour].purchaseCnt += parseInt(cols[13]) || 0;
      byHour[hour].purchaseAmt += parseInt(cols[14]) || 0;
      const dow = new Date(date).getDay();
      byDay[dow].purchaseCnt += parseInt(cols[13]) || 0;
      byDay[dow].purchaseAmt += parseInt(cols[14]) || 0;
    }

    res.json({ ok: true, source: 'api', byHour: Object.values(byHour).map(enrich), byDay: [1,2,3,4,5,6,0].map(d => enrich(byDay[d])) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API: 탭 데이터 (타겟별 - PC/MO) ───────────────────────────────
router.get('/api/tab/device', requireLogin, async (req, res) => {
  try {
    const { period = 'yesterday', accountId } = req.query;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });

    const dateRange = resolvePeriodDates(period, req.query.startDate, req.query.endDate);
    const enrich = obj => ({
      ...obj, cost: Number(obj.cost || 0), purchaseAmt: Number(obj.purchaseAmt || 0),
      ctr: obj.imp > 0 ? (obj.clk / obj.imp * 100) : 0,
      cpc: obj.clk > 0 ? Math.round(Number(obj.cost) / obj.clk) : 0,
      roas: Number(obj.cost) > 0 ? Math.round(Number(obj.purchaseAmt) / Number(obj.cost) * 100) : 0,
    });

    // DB 우선 조회
    const synced = await db.isSynced(account.id, dateRange.since, dateRange.until);
    if (synced) {
      const rows = await db.queryStatsDevice(account.id, dateRange.since, dateRange.until);
      const byDev = { PC: { imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 }, MO: { imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 } };
      for (const r of rows) byDev[r.device] = { imp: r.imp, clk: r.clk, cost: r.cost, purchaseCnt: r.purchaseCnt, purchaseAmt: r.purchaseAmt };
      return res.json({ ok: true, source: 'db', pc: enrich(byDev.PC), mobile: enrich(byDev.MO) });
    }

    // Fallback: API
    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });
    const client = makeClient(creds, account.customer_id);

    const [adRows, convRows] = await Promise.all([
      fetchAllStatRows(client, account.customer_id, 'AD_DETAIL', dateRange),
      fetchAllStatRows(client, account.customer_id, 'AD_CONVERSION_DETAIL', dateRange),
    ]);

    const byDevice = { PC: { imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 }, MO: { imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 } };
    for (const { cols } of adRows) {
      if (cols.length < 14) continue;
      const dev = cols[10] === 'P' ? 'PC' : 'MO';
      byDevice[dev].imp += parseInt(cols[11]) || 0;
      byDevice[dev].clk += parseInt(cols[12]) || 0;
      byDevice[dev].cost += parseInt(cols[13]) || 0;
    }
    for (const { cols } of convRows) {
      if (cols.length < 15) continue;
      const convType = cols[12];
      if (convType !== 'purchase' && convType !== 'purchase_complete' && convType !== 'complete_purchase') continue;
      const dev = cols[10] === 'P' ? 'PC' : 'MO';
      byDevice[dev].purchaseCnt += parseInt(cols[13]) || 0;
      byDevice[dev].purchaseAmt += parseInt(cols[14]) || 0;
    }

    res.json({ ok: true, source: 'api', pc: enrich(byDevice.PC), mobile: enrich(byDevice.MO) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API: 탭 데이터 (지역별) ────────────────────────────────────────
// Stats API breakdown=regnNo로 지역별 성과 조회 (최근 7일 이내만 가능)
const REGION_NAMES = {
  '01': '서울', '02': '인천', '03': '대전', '04': '대구', '05': '부산',
  '06': '울산', '07': '광주', '08': '경기', '09': '강원', '10': '충북',
  '11': '충남', '12': '전북', '13': '전남', '14': '경북', '15': '경남',
  '16': '제주', '17': '세종',
};
router.get('/api/tab/regional', requireLogin, async (req, res) => {
  try {
    const { period = 'yesterday', accountId } = req.query;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });

    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });

    const dateRange = resolvePeriodDates(period, req.query.startDate, req.query.endDate);
    const client = makeClient(creds, account.customer_id);

    const byRegion = await client.getStatsByBreakdown('regnNo', { startDate: dateRange.since, endDate: dateRange.until });

    // 지역 코드를 한글 이름으로 변환 후 비용순 정렬
    const regions = Object.entries(byRegion).map(([code, data]) => ({
      code,
      name: REGION_NAMES[code] || code,
      ...data,
    })).sort((a, b) => b.salesAmt - a.salesAmt);

    res.json({ ok: true, regions });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API: 탭 데이터 (그룹별) ────────────────────────────────────────
router.get('/api/tab/adgroups', requireLogin, async (req, res) => {
  try {
    const { period = 'yesterday', accountId } = req.query;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });

    const dateRange = resolvePeriodDates(period, req.query.startDate, req.query.endDate);
    const enrich = obj => ({
      ...obj, cost: Number(obj.cost || 0), purchaseAmt: Number(obj.purchaseAmt || 0),
      ctr: obj.imp > 0 ? (obj.clk / obj.imp * 100) : 0,
      cpc: obj.clk > 0 ? Math.round(Number(obj.cost) / obj.clk) : 0,
      roas: Number(obj.cost) > 0 ? Math.round(Number(obj.purchaseAmt) / Number(obj.cost) * 100) : 0,
    });

    // ─── 마스터 데이터 보장: 없으면 먼저 동기화 ───
    const creds0 = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    const masterCheckAg = await db.get('SELECT COUNT(*)::int AS cnt FROM master_adgroups WHERE account_id = $1', [account.id]);
    if (masterCheckAg.cnt === 0 && creds0) {
      try {
        const client0 = makeClient(creds0, account.customer_id);
        await buildNameMapsFromMasterReport(client0, account.id);
        nameMapCache.delete(`nm:${account.id}`);
      } catch (e) { console.log('광고그룹 탭 마스터 자동 동기화 실패:', e.message); }
    }

    // DB 우선 조회
    const synced = await db.isSynced(account.id, dateRange.since, dateRange.until);
    if (synced) {
      const rows = await db.queryStatsAdgroups(account.id, dateRange.since, dateRange.until);
      const adgroups = rows.map(r => enrich({
        adgroupId: r.adgroup_id, adgroupName: r.adgroupName,
        campaignName: r.campaignName, campaignTp: r.campaignTp,
        imp: r.imp, clk: r.clk, cost: r.cost, purchaseCnt: r.purchaseCnt, purchaseAmt: r.purchaseAmt,
      })).sort((a, b) => {
        const cmp = (a.campaignName || '').localeCompare(b.campaignName || '');
        return cmp !== 0 ? cmp : (a.adgroupName || '').localeCompare(b.adgroupName || '');
      });
      return res.json({ ok: true, source: 'db', adgroups });
    }

    // Fallback: API
    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });
    const client = makeClient(creds, account.customer_id);
    const { agMap, campMap } = await getNameMaps(client, account.id);

    const [adRows, convRows] = await Promise.all([
      fetchAllStatRows(client, account.customer_id, 'AD_DETAIL', dateRange),
      fetchAllStatRows(client, account.customer_id, 'AD_CONVERSION_DETAIL', dateRange),
    ]);

    const byAg = {};
    for (const { cols } of adRows) {
      if (cols.length < 14) continue;
      const agId = cols[3]; const campId = cols[2];
      if (!byAg[agId]) {
        const info = agMap[agId] || {}; const camp = campMap[info.campaignId || campId] || {};
        byAg[agId] = { adgroupId: agId, adgroupName: info.name || agId, campaignName: camp.name || campId, campaignTp: camp.tp || 0, imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 };
      }
      byAg[agId].imp += parseInt(cols[11]) || 0;
      byAg[agId].clk += parseInt(cols[12]) || 0;
      byAg[agId].cost += parseInt(cols[13]) || 0;
    }
    for (const { cols } of convRows) {
      if (cols.length < 15) continue;
      const convType = cols[12];
      if (convType !== 'purchase' && convType !== 'purchase_complete' && convType !== 'complete_purchase') continue;
      const agId = cols[3];
      if (!byAg[agId]) continue;
      byAg[agId].purchaseCnt += parseInt(cols[13]) || 0;
      byAg[agId].purchaseAmt += parseInt(cols[14]) || 0;
    }

    const adgroups = Object.values(byAg).map(enrich).sort((a, b) => {
      const cmp = (a.campaignName || '').localeCompare(b.campaignName || '');
      return cmp !== 0 ? cmp : (a.adgroupName || '').localeCompare(b.adgroupName || '');
    });
    res.json({ ok: true, source: 'api', adgroups });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API: 탭 데이터 (캠페인별) ──────────────────────────────────────
router.get('/api/tab/campaigns', requireLogin, async (req, res) => {
  try {
    const { period = 'yesterday', accountId } = req.query;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });

    const dateRange = resolvePeriodDates(period, req.query.startDate, req.query.endDate);
    const enrich = obj => ({
      ...obj, cost: Number(obj.cost || 0), purchaseAmt: Number(obj.purchaseAmt || 0),
      ctr: obj.imp > 0 ? (obj.clk / obj.imp * 100) : 0,
      cpc: obj.clk > 0 ? Math.round(Number(obj.cost) / obj.clk) : 0,
      roas: Number(obj.cost) > 0 ? Math.round(Number(obj.purchaseAmt) / Number(obj.cost) * 100) : 0,
    });

    // 마스터 데이터 보장
    const creds0 = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    const masterCheck = await db.get('SELECT COUNT(*)::int AS cnt FROM master_campaigns WHERE account_id = $1', [account.id]);
    if (masterCheck.cnt === 0 && creds0) {
      try {
        const client0 = makeClient(creds0, account.customer_id);
        await buildNameMapsFromMasterReport(client0, account.id);
        nameMapCache.delete(`nm:${account.id}`);
      } catch (e) { console.log('캠페인 탭 마스터 자동 동기화 실패:', e.message); }
    }

    // DB 우선 조회
    const synced = await db.isSynced(account.id, dateRange.since, dateRange.until);
    if (synced) {
      const rows = await db.queryStatsCampaigns(account.id, dateRange.since, dateRange.until);
      const campaigns = rows.map(r => enrich({
        campaignId: r.campaign_id,
        campaignName: r.campaignName,
        campaignTp: r.campaignTp,
        imp: r.imp, clk: r.clk, cost: r.cost,
        purchaseCnt: r.purchaseCnt, purchaseAmt: r.purchaseAmt,
      })).sort((a, b) => b.cost - a.cost);
      return res.json({ ok: true, source: 'db', campaigns });
    }

    // Fallback: API
    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });
    const client = makeClient(creds, account.customer_id);
    const { campMap } = await getNameMaps(client, account.id);

    const [adRows, convRows] = await Promise.all([
      fetchAllStatRows(client, account.customer_id, 'AD_DETAIL', dateRange),
      fetchAllStatRows(client, account.customer_id, 'AD_CONVERSION_DETAIL', dateRange),
    ]);

    const byCamp = {};
    for (const { cols } of adRows) {
      if (cols.length < 14) continue;
      const campId = cols[2];
      if (!byCamp[campId]) {
        const camp = campMap[campId] || {};
        byCamp[campId] = { campaignId: campId, campaignName: camp.name || campId, campaignTp: camp.tp || 0, imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 };
      }
      byCamp[campId].imp += parseInt(cols[11]) || 0;
      byCamp[campId].clk += parseInt(cols[12]) || 0;
      byCamp[campId].cost += parseInt(cols[13]) || 0;
    }
    for (const { cols } of convRows) {
      if (cols.length < 15) continue;
      const convType = cols[12];
      if (convType !== 'purchase' && convType !== 'purchase_complete' && convType !== 'complete_purchase') continue;
      const campId = cols[2];
      if (!byCamp[campId]) continue;
      byCamp[campId].purchaseCnt += parseInt(cols[13]) || 0;
      byCamp[campId].purchaseAmt += parseInt(cols[14]) || 0;
    }

    const campaigns = Object.values(byCamp).map(enrich).sort((a, b) => b.cost - a.cost);
    res.json({ ok: true, source: 'api', campaigns });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── 키워드 순위 ────────────────────────────────────────────────────
// ─── 자동입찰 ──────────────────────────────────────────────────────
router.get('/autobid', requireLogin, requireApi, async (req, res) => {
  if (!FEATURES.AUTOBID) {
    const user = await getUser(req);
    const layoutOpts = await getLayoutOpts(req);
    return res.send(appLayout('파워링크 자동입찰', `
      <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:12px;padding:32px;text-align:center;color:#92400e;max-width:640px;margin:40px auto">
        <div style="font-size:18px;font-weight:700;margin-bottom:8px">자동입찰은 '원클릭 계정분석 제안'으로 대체되었습니다</div>
        <div style="font-size:14px;line-height:1.7">자동 입찰 대신, 데이터 기반 <b>증액·감액 제안</b>을 검토 후 직접 적용하는 방식으로 전환했습니다.<br><b>자동리포트 → 원클릭 계정분석 제안</b>에서 확인하세요.</div>
      </div>`, user, '', layoutOpts));
  }
  const user = await getUser(req);
  const accounts = await db.getAccountsByUser(user.id);
  const selectedId = req.session.selectedAccountId || req.query.accountId || accounts[0]?.id || '';

  const content = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <div>
        <p style="color:#64748b;font-size:13px;margin:0">키워드별 희망순위에 맞춰 입찰가를 자동으로 조정합니다.</p>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <button class="btn" onclick="checkRanks()" id="rank-btn">📊 순위 조회</button>
        <button class="btn" onclick="runAutoBid()" id="autobid-btn" style="background:#f59e0b;color:#fff">🚀 수동 입찰</button>
        <button class="btn btn-primary" onclick="openModal()">+ 키워드 추가</button>
      </div>
    </div>

    <!-- 등록된 키워드 목록 -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">🎯 자동 입찰 키워드 관리</span>
        <span id="ab-count" style="font-size:12px;color:#94a3b8"></span>
      </div>
      <div id="ab-list"><div class="empty"><span class="spinner"></span> 로딩 중...</div></div>
    </div>

    <!-- 키워드 추가/수정 모달 -->
    <div id="kw-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999;align-items:center;justify-content:center">
      <div style="background:#fff;border-radius:12px;width:100%;max-width:640px;max-height:90vh;overflow-y:auto;padding:24px;margin:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <h3 id="modal-title" style="margin:0;font-size:16px">키워드 추가</h3>
          <button onclick="closeModal()" style="background:none;border:none;font-size:20px;cursor:pointer;color:#94a3b8">&times;</button>
        </div>

        <div id="kw-picker" style="margin-bottom:16px">
          <button class="btn" onclick="loadKeywordList()" id="load-kw-btn" style="width:100%">📋 광고주 키워드 목록 불러오기</button>
          <div id="kw-search-wrap" style="display:none;margin-top:10px">
            <input id="kw-search" placeholder="키워드 검색..." style="width:100%;margin-bottom:8px" oninput="filterKwList()">
            <div id="kw-pick-list" style="max-height:200px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:8px"></div>
          </div>
        </div>

        <div class="form-group"><label>키워드</label><input id="f-keyword" readonly style="background:#f8fafc"></div>
        <input type="hidden" id="f-kwid"><input type="hidden" id="f-edit-id">

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group"><label>지면</label>
            <select id="f-device"><option value="PC">PC</option><option value="MO" selected>MOBILE</option></select>
          </div>
          <div class="form-group"><label>희망순위</label><input id="f-rank" type="number" value="3" min="1" max="5"></div>
          <div class="form-group"><label>최대입찰가 (원)</label><input id="f-maxbid" type="number" value="5000" step="100"></div>
          <div class="form-group"><label>조정입찰가 (원)</label><input id="f-adjust" type="number" value="100" step="10"></div>
          <div class="form-group"><label>실행 간격</label>
            <select id="f-interval"><option value="5">5분</option><option value="10" selected>10분</option><option value="20">20분</option><option value="30">30분</option><option value="60">60분</option></select>
          </div>
        </div>

        <div class="form-group">
          <label>실행 시간대 <span style="font-size:11px;color:#94a3b8">(클릭하여 ON/OFF)</span></label>
          <div id="f-schedule" style="display:grid;grid-template-columns:repeat(12,1fr);gap:3px;margin-top:4px">
            ${Array.from({length:24},(_,h)=>`<div class="hour-btn on" data-h="${h}" onclick="toggleHour(this)" style="text-align:center;padding:6px 0;font-size:11px;border-radius:4px;cursor:pointer;user-select:none">${h}시</div>`).join('')}
          </div>
        </div>

        <div style="display:flex;gap:8px;margin-top:16px">
          <button class="btn btn-primary" onclick="saveKeyword()" style="flex:1" id="modal-save-btn">저장</button>
          <button class="btn" onclick="closeModal()" style="flex:1">취소</button>
        </div>
      </div>
    </div>

    <style>
      .hour-btn.on{background:#dcfce7;color:#166534;border:1px solid #bbf7d0}
      .hour-btn.off{background:#f1f5f9;color:#94a3b8;border:1px solid #e2e8f0}
      #kw-modal[style*="flex"]{display:flex!important}
    </style>

    <script>
    let allKwList = [];
    const accountId = '${selectedId}';
    let editMode = false;

    // ─── 모달 열기/닫기 ─────────────────────────────────────────
    function openModal(editData){
      editMode = !!editData;
      document.getElementById('modal-title').textContent = editMode ? '키워드 설정 수정' : '키워드 추가';
      document.getElementById('modal-save-btn').textContent = editMode ? '수정' : '저장';
      document.getElementById('kw-picker').style.display = editMode ? 'none' : 'block';

      if (editData) {
        document.getElementById('f-kwid').value = editData.keyword_id;
        document.getElementById('f-keyword').value = editData.keyword;
        document.getElementById('f-keyword').dataset.camp = editData.campaign_name;
        document.getElementById('f-keyword').dataset.ag = editData.adgroup_name;
        document.getElementById('f-device').value = editData.device;
        document.getElementById('f-rank').value = editData.target_rank;
        document.getElementById('f-maxbid').value = editData.max_bid;
        document.getElementById('f-adjust').value = editData.adjust_amt;
        document.getElementById('f-edit-id').value = editData.id;
        document.getElementById('f-interval').value = editData.bid_interval || 10;
        // 지면 변경 불가 (수정 모드)
        document.getElementById('f-device').disabled = true;
        // 시간대
        const sch = editData.schedule || '111111111111111111111111';
        document.querySelectorAll('#f-schedule .hour-btn').forEach((b,i) => {
          b.classList.toggle('on', sch[i]==='1');
          b.classList.toggle('off', sch[i]!=='1');
        });
      } else {
        resetForm();
        document.getElementById('f-device').disabled = false;
      }
      document.getElementById('kw-modal').style.display = 'flex';
    }

    function closeModal(){ document.getElementById('kw-modal').style.display='none'; resetForm(); }

    function updateRankMax(){
      const d=document.getElementById('f-device').value;
      const r=document.getElementById('f-rank');
      r.max = d==='PC' ? 15 : 5;
      if(parseInt(r.value) > parseInt(r.max)) r.value=r.max;
    }
    document.getElementById('f-device').addEventListener('change', updateRankMax);

    function resetForm(){
      document.getElementById('f-keyword').value='';
      document.getElementById('f-kwid').value='';
      document.getElementById('f-edit-id').value='';
      document.getElementById('f-rank').value='3';
      document.getElementById('f-maxbid').value='5000';
      document.getElementById('f-adjust').value='100';
      document.getElementById('f-device').value='MO';
      document.getElementById('f-interval').value='10';
      document.getElementById('f-device').disabled=false;
      document.querySelectorAll('#f-schedule .hour-btn').forEach(b=>{b.classList.remove('off');b.classList.add('on');});
      updateRankMax();
    }

    function toggleHour(el){ el.classList.toggle('on'); el.classList.toggle('off'); }

    // ─── 키워드 목록 불러오기 ───────────────────────────────────
    async function loadKeywordList(){
      const btn=document.getElementById('load-kw-btn');
      btn.disabled=true; btn.textContent='불러오는 중...';
      try{
        const r=await fetch('/smart-sa/api/autobid/keywords?accountId='+accountId);
        const j=await r.json();
        if(!j.ok) throw new Error(j.error);
        allKwList=j.keywords;
        document.getElementById('kw-search-wrap').style.display='block';
        renderKwPickList(allKwList);
      }catch(e){toast('오류: '+e.message,true);}
      finally{btn.disabled=false;btn.textContent='📋 키워드 목록 새로고침';}
    }

    function filterKwList(){
      const q=document.getElementById('kw-search').value.toLowerCase();
      renderKwPickList(allKwList.filter(k=>(k.keyword||'').toLowerCase().includes(q)||(k.campaignName||'').toLowerCase().includes(q)));
    }

    function renderKwPickList(list){
      document.getElementById('kw-pick-list').innerHTML=list.slice(0,100).map(k=>
        '<div onclick="pickKw(this)" data-id="'+k.keywordId+'" data-kw="'+k.keyword+'" data-camp="'+k.campaignName+'" data-ag="'+k.adgroupName+'" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid #f1f5f9;font-size:13px;display:flex;justify-content:space-between" onmouseover="this.style.background=\\'#f0f9ff\\'" onmouseout="this.style.background=\\'\\'"><span><strong>'+k.keyword+'</strong></span><span style="color:#94a3b8;font-size:11px">'+k.campaignName+' / '+k.adgroupName+'</span></div>'
      ).join('')||'<div style="padding:12px;color:#94a3b8;text-align:center">검색 결과 없음</div>';
    }

    function pickKw(el){
      document.getElementById('f-kwid').value=el.dataset.id;
      document.getElementById('f-keyword').value=el.dataset.kw;
      document.getElementById('f-keyword').dataset.camp=el.dataset.camp;
      document.getElementById('f-keyword').dataset.ag=el.dataset.ag;
    }

    // ─── 저장 (추가/수정 공용) ──────────────────────────────────
    async function saveKeyword(){
      const kwId=document.getElementById('f-kwid').value;
      if(!kwId) return toast('키워드를 선택해주세요.',true);
      const hours=Array.from(document.querySelectorAll('#f-schedule .hour-btn')).map(b=>b.classList.contains('on')?'1':'0').join('');
      const body={
        accountId, keyword_id:kwId,
        keyword:document.getElementById('f-keyword').value,
        campaign_name:document.getElementById('f-keyword').dataset.camp||'',
        adgroup_name:document.getElementById('f-keyword').dataset.ag||'',
        device:document.getElementById('f-device').value,
        target_rank:parseInt(document.getElementById('f-rank').value)||3,
        max_bid:parseInt(document.getElementById('f-maxbid').value)||5000,
        adjust_amt:parseInt(document.getElementById('f-adjust').value)||100,
        schedule:hours, bid_interval:parseInt(document.getElementById('f-interval').value)||10, enabled:true,
      };
      try{
        const r=await fetch('/smart-sa/api/autobid/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        const j=await r.json();
        if(!j.ok) throw new Error(j.error);
        toast(editMode?'설정 수정 완료':'키워드 저장 완료 (순위 조회 중...)');
        closeModal(); loadList();
        // 백그라운드 순위 조회 완료 후 자동 새로고침
        setTimeout(()=>loadList(), 3000);
        setTimeout(()=>loadList(), 6000);
      }catch(e){toast('오류: '+e.message,true);}
    }

    // ─── 수동 자동입찰 실행 ───────────────────────────────────────
    async function runAutoBid(){
      const btn=document.getElementById('autobid-btn');
      btn.disabled=true; btn.textContent='입찰 조정 중...';
      try{
        const r=await fetch('/smart-sa/api/autobid/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId})});
        const j=await r.json();
        if(!j.ok) throw new Error(j.error);
        if(j.results&&j.results.length){
          const info=j.results.map(d=>d.keyword+' '+d.device+': '+(d.error||(d.changed?d.oldBid+'→'+d.newBid+'원 ('+d.action+')':'변동없음 ('+d.action+')'))).join('\\n');
          toast(j.results.length+'개 키워드 입찰 완료\\n'+info);
        } else {
          toast('실행 대상 키워드 없음');
        }
        loadList();
      }catch(e){toast('오류: '+e.message,true);}
      finally{btn.disabled=false;btn.textContent='🚀 수동 입찰';}
    }

    // ─── 순위 일괄 조회 ─────────────────────────────────────────
    async function checkRanks(){
      const btn=document.getElementById('rank-btn');
      btn.disabled=true; btn.textContent='조회 중...';
      try{
        const r=await fetch('/smart-sa/api/autobid/check-ranks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId})});
        const j=await r.json();
        if(!j.ok) throw new Error(j.error);
        if(j.details&&j.details.length){
          const info=j.details.map(d=>d.keyword+': '+(d.error||((d.rank||0)>0?d.rank.toFixed(1)+'위':'-'))).join(', ');
          toast(j.checked+'개 순위 조회 완료 ('+info+')');
        } else {
          toast(j.checked+'개 키워드 순위 조회 완료 (accountId: '+accountId+')');
        }
        loadList();
      }catch(e){toast('오류: '+e.message,true);}
      finally{btn.disabled=false;btn.textContent='📊 순위 조회';}
    }

    // ─── 목록 로드 ──────────────────────────────────────────────
    async function loadList(){
      try{
        const r=await fetch('/smart-sa/api/autobid/list?accountId='+accountId);
        const j=await r.json();
        if(!j.ok) throw new Error(j.error);
        const kws=j.keywords;
        document.getElementById('ab-count').textContent=kws.length+'개 키워드';
        if(!kws.length){document.getElementById('ab-list').innerHTML='<div class="empty">등록된 자동입찰 키워드가 없습니다.<br><span style="font-size:12px;color:#cbd5e1">+ 키워드 추가 버튼으로 키워드를 등록해주세요.</span></div>';return;}

        const scheduleHtml=(sch)=>{
          if(!sch||sch==='111111111111111111111111') return '<span style="color:#166534;font-size:11px">24시간</span>';
          if(sch==='000000000000000000000000') return '<span style="color:#dc2626;font-size:11px">OFF</span>';
          // 연속 구간 요약: "9-18시" 또는 "9-12,14-18시"
          const ranges=[];let start=null;
          for(let h=0;h<=24;h++){
            if(h<24&&sch[h]==='1'){if(start===null)start=h;}
            else{if(start!==null){ranges.push(start===h-1?start+'시':start+'-'+(h-1)+'시');start=null;}}
          }
          return '<span style="font-size:11px;color:#334155">'+ranges.join(', ')+'</span>';
        };

        const rankBadge=(targetBid,currentBid)=>{
          if(!targetBid||targetBid<=0) return '<span style="color:#cbd5e1">-</span>';
          if(currentBid>=targetBid) return '<span class="badge badge-green">달성</span>';
          return '<span class="badge badge-red">미달</span>';
        };

        const realRankBadge=(r, lastRun)=>{
          if(!lastRun) return '<span style="color:#cbd5e1">-</span>';
          if(!r||r<=0) return '<span class="badge badge-red">순위밖</span>';
          if(r<=3) return '<span class="badge badge-green">'+r+'위</span>';
          if(r<=7) return '<span class="badge badge-blue">'+r+'위</span>';
          return '<span class="badge badge-gray">'+r+'위</span>';
        };

        document.getElementById('ab-list').innerHTML='<div style="overflow-x:auto"><table><thead><tr><th>키워드</th><th>캠페인 / 그룹</th><th style="text-align:center">지면</th><th style="text-align:center">희망순위</th><th style="text-align:center">현재순위</th><th style="text-align:right">현재입찰가</th><th style="text-align:right;font-size:11px">순위 평균<br>입찰가 <span onclick="alert(\\'지난 28일간 희망순위의 평균 입찰가입니다.\\n참고 지표이며, 실제 자동입찰은 실시간 순위 기반으로 작동합니다.\\')" style="cursor:pointer;color:#94a3b8" title="지난 28일간 희망순위의 평균 입찰가">(?)</span></th><th style="text-align:right">최대CPC</th><th style="text-align:center">간격</th><th>실행시간</th><th style="text-align:center">사용</th><th></th></tr></thead><tbody>'
          +kws.map(k=>{
            const kData=JSON.stringify(k).replace(/'/g,"\\\\'").replace(/"/g,"&quot;");
            return '<tr>'
            +'<td><strong>'+k.keyword+'</strong></td>'
            +'<td style="font-size:12px;color:#64748b">'+k.campaign_name+'<br>'+k.adgroup_name+'</td>'
            +'<td style="text-align:center"><span class="badge '+(k.device==='PC'?'badge-blue':'badge-green')+'">'+k.device+'</span></td>'
            +'<td style="text-align:center;font-weight:600">'+k.target_rank+'위</td>'
            +'<td style="text-align:center">'+realRankBadge(k.last_real_rank, k.last_run)+'</td>'
            +'<td style="text-align:right">'+(k.last_bid>0?'₩'+Number(k.last_bid).toLocaleString():'<span style="color:#cbd5e1">-</span>')+'</td>'
            +'<td style="text-align:right;color:#94a3b8;font-size:12px">'+(k.last_rank>0?'₩'+Number(k.last_rank).toLocaleString():'<span style="color:#cbd5e1">-</span>')+'</td>'
            +'<td style="text-align:right">₩'+Number(k.max_bid).toLocaleString()+'</td>'
            +'<td style="text-align:center"><span class="badge badge-gray">'+(k.bid_interval||10)+'분</span></td>'
            +'<td style="font-size:10px">'+scheduleHtml(k.schedule||'111111111111111111111111')+'</td>'
            +'<td style="text-align:center"><label style="cursor:pointer"><input type="checkbox" '+(k.enabled?'checked':'')+' onchange="toggleEnable('+k.id+',this.checked)" style="accent-color:#6366f1"></label></td>'
            +'<td style="white-space:nowrap"><button class="btn" style="padding:4px 8px;font-size:11px" onclick="openModal('+kData+')">수정</button> <button class="btn" style="padding:4px 8px;font-size:11px;color:#dc2626" onclick="deleteKw('+k.id+')">삭제</button></td>'
            +'</tr>';
          }).join('')
          +'</tbody></table></div>';
      }catch(e){document.getElementById('ab-list').innerHTML='<div class="empty">'+e.message+'</div>';}
    }

    async function debugRank(){
      try{
        const r=await fetch('/smart-sa/api/autobid/list?accountId='+accountId);
        const j=await r.json();
        if(!j.ok||!j.keywords.length){toast('키워드 없음',true);return;}
        const kw=j.keywords[0];
        const btn=document.getElementById('debug-btn');
        btn.disabled=true;btn.textContent='테스트 중...';
        const r2=await fetch('/smart-sa/api/autobid/debug-rank',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId,keywordId:kw.keyword_id,device:kw.device})});
        const j2=await r2.json();
        btn.disabled=false;btn.textContent='🔧 API 테스트';
        // 결과를 모달로 표시
        let modal=document.getElementById('debug-modal');
        if(!modal){modal=document.createElement('div');modal.id='debug-modal';modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center';modal.innerHTML='<div style="background:#fff;border-radius:12px;width:90%;max-width:800px;max-height:80vh;overflow:auto;padding:20px"><div style="display:flex;justify-content:space-between;margin-bottom:12px"><h3 style="margin:0">API 테스트 결과 ('+kw.keyword+' / '+kw.device+')</h3><button onclick="this.closest(\\'#debug-modal\\').remove()" style="background:none;border:none;font-size:20px;cursor:pointer">&times;</button></div><pre id="debug-content" style="font-size:11px;white-space:pre-wrap;background:#f8fafc;padding:12px;border-radius:8px;max-height:60vh;overflow:auto"></pre></div>';document.body.appendChild(modal);}
        document.getElementById('debug-content').textContent=JSON.stringify(j2,null,2);
      }catch(e){toast('디버그 오류: '+e.message,true);}
    }

    async function testRealRank(source){
      try{
        const r=await fetch('/smart-sa/api/autobid/list?accountId='+accountId);
        const j=await r.json();
        if(!j.ok||!j.keywords.length){toast('키워드 없음',true);return;}
        const kw=j.keywords[0];
        const btn=document.getElementById('realrank-btn');
        btn.disabled=true;btn.textContent='조회 중...';
        const body={accountId,keyword:kw.keyword,device:kw.device,nccKeywordId:kw.keyword_id};
        if(source==='more') body.source='more';
        const r2=await fetch('/smart-sa/api/autobid/test-realrank',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        const j2=await r2.json();
        btn.disabled=false;btn.textContent='📡 실시간순위 테스트';
        let modal=document.getElementById('debug-modal');
        if(modal) modal.remove();
        modal=document.createElement('div');modal.id='debug-modal';modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center';
        modal.innerHTML='<div style="background:#fff;border-radius:12px;width:90%;max-width:800px;max-height:80vh;overflow:auto;padding:20px"><div style="display:flex;justify-content:space-between;margin-bottom:12px"><h3 style="margin:0">실시간 순위 테스트 ('+kw.keyword+' / '+kw.device+(source==="more"?" / 더보기":"")+' )</h3><button onclick="this.closest(\\'#debug-modal\\').remove()" style="background:none;border:none;font-size:20px;cursor:pointer">&times;</button></div><pre id="debug-content" style="font-size:11px;white-space:pre-wrap;background:#f8fafc;padding:12px;border-radius:8px;max-height:60vh;overflow:auto"></pre></div>';
        document.body.appendChild(modal);
        document.getElementById('debug-content').textContent=JSON.stringify(j2,null,2);
      }catch(e){toast('실시간 순위 오류: '+e.message,true);}
    }

    async function toggleEnable(id,enabled){
      await fetch('/smart-sa/api/autobid/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,accountId,enabled})});
    }

    async function deleteKw(id){
      if(!confirm('이 키워드를 삭제하시겠습니까?')) return;
      const r=await fetch('/smart-sa/api/autobid/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,accountId})});
      const j=await r.json();
      if(j.ok) loadList(); else toast('삭제 실패',true);
    }

    loadList();
    </script>
  `;
  res.send(appLayout('자동입찰', content, user, 'autobid', await getLayoutOpts(req)));
});

// ─── 자동입찰 API ──────────────────────────────────────────────────
// 광고주 키워드 목록 (추가용)
router.get('/api/autobid/keywords', requireLogin, async (req, res) => {
  try {
    const account = await db.getAccountById(req.query.accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });

    const client = makeClient(creds, account.customer_id);
    const campaigns = await client.getCampaigns();
    const keywords = [];

    for (const camp of (campaigns || [])) {
      const ags = await client.getAdGroups(camp.nccCampaignId);
      for (const ag of (ags || [])) {
        const kws = await client.getKeywords(ag.nccAdgroupId);
        for (const kw of (kws || [])) {
          keywords.push({
            keywordId: kw.nccKeywordId, keyword: kw.keyword,
            campaignName: camp.name, adgroupName: ag.name,
            bidAmt: kw.bidAmt,
          });
        }
        await new Promise(r => setTimeout(r, 100));
      }
    }
    res.json({ ok: true, keywords });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 등록 키워드 목록
router.get('/api/autobid/list', requireLogin, async (req, res) => {
  try {
    const account = await db.getAccountById(req.query.accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    const keywords = await db.getAutoBidKeywords(account.id);
    res.json({ ok: true, keywords });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 키워드 저장
router.post('/api/autobid/save', requireLogin, async (req, res) => {
  try {
    const account = await db.getAccountById(req.body.accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    await db.upsertAutoBidKeyword(account.id, req.body);
    res.json({ ok: true });

    // 백그라운드: 저장된 키워드 즉시 조회 (현재입찰가 + 참고입찰가 + 실시간순위)
    (async () => {
      try {
        const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
        if (!creds) return;
        const client = makeClient(creds, account.customer_id);
        const kwId = req.body.keyword_id;
        const device = req.body.device;

        let currentBid = 0;
        try {
          const kwInfo = await client.getKeywordInfo(kwId);
          if (kwInfo?.bidAmt && kwInfo.bidAmt > 0) {
            currentBid = kwInfo.bidAmt;
          } else if (kwInfo?.useGroupBidAmt && kwInfo?.nccAdgroupId) {
            const grp = await client.getAdGroupDetail(kwInfo.nccAdgroupId);
            currentBid = grp?.bidAmt || 0;
          }
        } catch (e) { /* fallback */ }

        // 참고입찰가 (28일 평균) → last_rank 필드에 저장
        let refBid = 0;
        try {
          const targetRank = parseInt(req.body.target_rank) || 3;
          const est = await client.getEstimatedBidForPosition(kwId, device, targetRank);
          refBid = est?.estimate?.[0]?.bid || 0;
        } catch (e) {}

        // 실시간 순위 조회
        let realRank = 0;
        const siteUrls = (account.site_url || '').split(',').map(u => u.trim()).filter(Boolean);
        if (siteUrls.length > 0) {
          const { findAdRank } = require('../api/naverRankScraper');
          try {
            for (const siteUrl of siteUrls) {
              const result = await findAdRank(req.body.keyword, device, siteUrl);
              if (result.rank > 0) { realRank = result.rank; break; }
            }
          } catch (e) {}
        }

        await db.updateAutoBidKeywordStatus(kwId, device, refBid, currentBid, realRank);
        console.log(`✅ [${req.body.keyword}] ${device} 현재:₩${currentBid}, 참고:₩${refBid}, 순위:${realRank||'순위밖'}`);
      } catch (e) {
        console.error(`⚠️ [${req.body.keyword}] 즉시 조회 실패:`, e.message);
      }
    })();
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ON/OFF 토글
router.post('/api/autobid/toggle', requireLogin, async (req, res) => {
  try {
    const account = await db.getAccountById(req.body.accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    await db.pool.query('UPDATE auto_bid_keywords SET enabled = $1 WHERE id = $2 AND account_id = $3',
      [req.body.enabled ? 1 : 0, req.body.id, account.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 키워드 삭제
router.post('/api/autobid/delete', requireLogin, async (req, res) => {
  try {
    const account = await db.getAccountById(req.body.accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    await db.deleteAutoBidKeyword(req.body.id, account.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 순위 조회 API 디버그 (어떤 방법이 동작하는지 테스트)
router.post('/api/autobid/debug-rank', requireLogin, async (req, res) => {
  try {
    const account = await db.getAccountById(req.body.accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });

    const client = makeClient(creds, account.customer_id);
    const kwId = req.body.keywordId;
    const device = req.body.device || 'MO';
    const results = {};

    // 1. getKeywordInfo (전체 raw 응답)
    try {
      const kwInfo = await client.getKeywordInfo(kwId);
      results.keywordInfo = kwInfo; // raw 전체 응답
      // adgroup bid도 조회
      if (kwInfo?.nccAdgroupId) {
        try {
          const grpInfo = await client.getAdGroupDetail(kwInfo.nccAdgroupId);
          results.adGroupInfo = { bidAmt: grpInfo?.bidAmt, name: grpInfo?.name, useGroupBidAmt: kwInfo?.useGroupBidAmt, allFields: Object.keys(grpInfo || {}) };
        } catch (e2) { results.adGroupInfo = { error: e2.message }; }
      }
    } catch (e) { results.keywordInfo = { error: e.message }; }

    // 2. Stats API - 오늘
    try {
      const today = new Date(Date.now() + 9*60*60*1000).toISOString().slice(0,10);
      const stat = await client.getStatById(kwId, { startDate: today, endDate: today });
      results.statsToday = stat;
    } catch (e) { results.statsToday = { error: e.message }; }

    // 3. Stats API - 어제
    try {
      const yesterday = new Date(Date.now() + 9*60*60*1000 - 86400000).toISOString().slice(0,10);
      const stat = await client.getStatById(kwId, { startDate: yesterday, endDate: yesterday });
      results.statsYesterday = stat;
    } catch (e) { results.statsYesterday = { error: e.message }; }

    // 4. Stats API - 최근 7일
    try {
      const end = new Date(Date.now() + 9*60*60*1000).toISOString().slice(0,10);
      const start = new Date(Date.now() + 9*60*60*1000 - 7*86400000).toISOString().slice(0,10);
      const stat = await client.getStatById(kwId, { startDate: start, endDate: end });
      results.stats7days = stat;
    } catch (e) { results.stats7days = { error: e.message }; }

    // 5. estimate/average-position-bid/id (단일 포지션)
    try {
      const { createApiClient } = require('../api/naverApi');
      const rawClient = createApiClient({ apiKey: creds.api_key, secretKey: creds.secret_key, customerId: account.customer_id });
      const est = await rawClient.getEstimatedBidForPosition(kwId, device, 3);
      results.estimatePosition = est;
    } catch (e) { results.estimatePosition = { error: e.message }; }

    // 6. estimate/exposure-minimum-bid/id
    try {
      const { createApiClient } = require('../api/naverApi');
      const rawClient = createApiClient({ apiKey: creds.api_key, secretKey: creds.secret_key, customerId: account.customer_id });
      const est = await rawClient.getExposureMinBid(kwId, device);
      results.exposureMinBid = est;
    } catch (e) { results.exposureMinBid = { error: e.message }; }

    // 7. estimate/median-bid/id
    try {
      const { createApiClient } = require('../api/naverApi');
      const rawClient = createApiClient({ apiKey: creds.api_key, secretKey: creds.secret_key, customerId: account.customer_id });
      const est = await rawClient.getMedianBid(kwId, device);
      results.medianBid = est;
    } catch (e) { results.medianBid = { error: e.message }; }

    // 8. estimate/performance/id
    try {
      const { createApiClient } = require('../api/naverApi');
      const rawClient = createApiClient({ apiKey: creds.api_key, secretKey: creds.secret_key, customerId: account.customer_id });
      const est = await rawClient.getPerformanceEstimate(kwId, device, [70, 500, 1000, 2000]);
      results.performanceEstimate = est;
    } catch (e) { results.performanceEstimate = { error: e.message }; }

    res.json({ ok: true, kwId, device, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 실시간 순위 조회 테스트 (검색결과 HTML 파싱)
router.post('/api/autobid/test-realrank', requireLogin, async (req, res) => {
  try {
    const keyword = req.body.keyword || '일본포스터';
    const device = req.body.device || 'PC';
    const source = req.body.source || 'main'; // 'main' or 'more'

    const { getPowerLinkAds, getMobileAdsMore } = require('../api/naverRankScraper');

    // 더보기 페이지 비교 테스트
    if (source === 'more' && device === 'MO') {
      const { ads, html } = await getMobileAdsMore(keyword);
      // HTML에서 파워링크 관련 태그 추출 (디버깅용)
      const cheerio = require('cheerio');
      const $ = cheerio.load(html);
      const htmlSnippets = [];
      $('li').slice(0, 3).each((i, el) => {
        htmlSnippets.push($(el).html()?.substring(0, 300) || '');
      });
      return res.json({
        ok: true,
        keyword,
        device,
        source: 'more (m.ad.search.naver.com)',
        totalAds: ads.length,
        ads,
        htmlLength: html.length,
        sampleHtml: htmlSnippets,
      });
    }

    const ads = await getPowerLinkAds(keyword, device);

    res.json({
      ok: true,
      keyword,
      device,
      source: device === 'MO' ? 'main (m.search.naver.com)' : 'PC (search.naver.com)',
      totalAds: ads.length,
      ads,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 수동 자동입찰 실행
router.post('/api/autobid/run', requireLogin, async (req, res) => {
  try {
    const account = await db.getAccountById(req.body.accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });

    const client = makeClient(creds, account.customer_id);
    const abKeywords = await db.getEnabledAutoBidKeywords(account.id);
    const siteUrls = (account.site_url || '').split(',').map(u => u.trim()).filter(Boolean);
    const { findAdRank } = require('../api/naverRankScraper');

    const rankCache = {};
    const results = [];

    for (const abKw of abKeywords) {
      try {
        // 1. 현재 입찰가 조회
        let currentBid = abKw.last_bid || 0;
        try {
          const kwInfo = await client.getKeywordInfo(abKw.keyword_id);
          if (kwInfo?.useGroupBidAmt && kwInfo?.nccAdgroupId) {
            const grp = await client.getAdGroupDetail(kwInfo.nccAdgroupId);
            currentBid = grp?.bidAmt || currentBid;
          } else if (kwInfo?.bidAmt && kwInfo.bidAmt > 0) {
            currentBid = kwInfo.bidAmt;
          }
        } catch (e) {}

        // 2. 실시간 순위 조회
        let realRank = 0;
        if (siteUrls.length > 0) {
          const cacheKey = `${abKw.keyword}_${abKw.device}`;
          if (rankCache[cacheKey] !== undefined) {
            realRank = rankCache[cacheKey];
          } else {
            for (const siteUrl of siteUrls) {
              const result = await findAdRank(abKw.keyword, abKw.device, siteUrl);
              if (result.rank > 0) { realRank = result.rank; break; }
            }
            rankCache[cacheKey] = realRank;
          }
        }

        // 3. 입찰가 조정
        let newBid = currentBid;
        let action = '유지';
        const adjust = abKw.adjust_amt || 30;

        if (realRank === 0) {
          const lastRank = abKw.last_rank || 0;
          if (lastRank > 0 && lastRank <= abKw.target_rank) {
            action = '순위조회실패→유지(이전' + lastRank + '위)';
          } else if (currentBid >= abKw.max_bid) {
            action = '순위밖+최대입찰가→유지';
          } else {
            newBid = Math.min(currentBid + adjust, abKw.max_bid);
            action = '순위밖→상향';
          }
        } else if (realRank > abKw.target_rank) {
          newBid = Math.min(currentBid + adjust, abKw.max_bid);
          action = realRank + '위→상향';
        } else if (realRank < abKw.target_rank) {
          newBid = Math.max(currentBid - adjust, 70);
          action = realRank + '위→하향';
        } else {
          action = realRank + '위=목표달성';
        }

        const changed = newBid !== currentBid && newBid > 0;
        if (changed) {
          try {
            await client.updateKeywordBid(abKw.keyword_id, newBid);
            console.log(`  🎯 [${abKw.keyword}] ${abKw.device} ${currentBid}→${newBid}원 (${action})`);
          } catch (bidErr) {
            console.error(`  ❌ 입찰가 변경 실패 [${abKw.keyword}]:`, bidErr.message);
            results.push({ keyword: abKw.keyword, device: abKw.device, oldBid: currentBid, newBid, error: '입찰가 변경 실패: ' + bidErr.message });
            continue;
          }
          // 변경 후 실제 반영된 입찰가 재조회
          await new Promise(r => setTimeout(r, 500));
          try {
            const updatedKw = await client.getKeywordInfo(abKw.keyword_id);
            const confirmedBid = updatedKw?.bidAmt || newBid;
            newBid = confirmedBid;
          } catch (e) {}
        }

        await db.updateAutoBidKeywordStatus(abKw.keyword_id, abKw.device, 0, newBid || currentBid, realRank).catch(() => {});
        results.push({ keyword: abKw.keyword, device: abKw.device, oldBid: currentBid, newBid, realRank, action, changed });
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        results.push({ keyword: abKw.keyword, device: abKw.device, error: e.message });
      }
    }
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 순위 일괄 조회
router.post('/api/autobid/check-ranks', requireLogin, async (req, res) => {
  try {
    const account = await db.getAccountById(req.body.accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });

    const client = makeClient(creds, account.customer_id);
    const abKeywords = await db.getAutoBidKeywords(account.id);
    const siteUrls = (account.site_url || '').split(',').map(u => u.trim()).filter(Boolean);
    console.log(`🔍 check-ranks: accountId=${req.body.accountId}, keywords=${abKeywords.length}, siteUrls=${siteUrls.join(',')}`);

    const { findAdRank } = require('../api/naverRankScraper');

    let checked = 0;
    const details = [];
    // 키워드별 실시간 순위 캐시 (같은 키워드+디바이스 중복 조회 방지)
    const rankCache = {};

    for (const abKw of abKeywords) {
      try {
        // 1. 현재 입찰가 조회 (키워드 레벨 → 그룹 레벨 fallback)
        let currentBid = abKw.last_bid || 0;
        try {
          const kwInfo = await client.getKeywordInfo(abKw.keyword_id);
          if (kwInfo?.useGroupBidAmt && kwInfo?.nccAdgroupId) {
            const grp = await client.getAdGroupDetail(kwInfo.nccAdgroupId);
            currentBid = grp?.bidAmt || currentBid;
          } else if (kwInfo?.bidAmt && kwInfo.bidAmt > 0) {
            currentBid = kwInfo.bidAmt;
          }
        } catch (e) {
          console.log(`  입찰가 조회 실패 [${abKw.keyword}]:`, e.message);
        }

        // 2. 목표 순위에 필요한 입찰가 조회
        let targetBid = 0;
        try {
          const est = await client.getEstimatedBidForPosition(abKw.keyword_id, abKw.device, abKw.target_rank);
          targetBid = est?.estimate?.[0]?.bid || 0;
        } catch (estErr) {
          console.log(`  입찰가 추정 실패 [${abKw.keyword}]:`, estErr.message);
        }

        // 3. 실시간 순위 조회 (검색결과 파싱)
        let realRank = 0;
        if (siteUrls.length > 0) {
          const cacheKey = `${abKw.keyword}_${abKw.device}`;
          if (rankCache[cacheKey] !== undefined) {
            realRank = rankCache[cacheKey];
          } else {
            try {
              for (const siteUrl of siteUrls) {
                const result = await findAdRank(abKw.keyword, abKw.device, siteUrl);
                if (result.rank > 0) {
                  realRank = result.rank;
                  break;
                }
              }
              rankCache[cacheKey] = realRank;
              console.log(`  📡 [${abKw.keyword}] ${abKw.device} 실시간순위: ${realRank > 0 ? realRank + '위' : '순위밖'}`);
            } catch (e) {
              console.log(`  실시간순위 조회 실패 [${abKw.keyword}]:`, e.message);
            }
            await new Promise(r => setTimeout(r, 500)); // rate limit 방지
          }
        }

        console.log(`  📊 [${abKw.keyword}] ${abKw.device} 목표:${abKw.target_rank}위, 현재순위:${realRank||'순위밖'}, 평균입찰가:₩${targetBid}, 현재입찰가:₩${currentBid}`);

        await db.updateAutoBidKeywordStatus(abKw.keyword_id, abKw.device, targetBid, currentBid, realRank);
        details.push({ keyword: abKw.keyword, device: abKw.device, refBid: targetBid, currentBid, realRank });
        checked++;
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.log(`키워드 조회 실패 [${abKw.keyword}]:`, e.message);
        details.push({ keyword: abKw.keyword, device: abKw.device, error: e.message });
      }
    }
    res.json({ ok: true, checked, details });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── 성과개선 전략 페이지 ───────────────────────────────────────────
const STRATEGY_META = {
  upsell:    { kind: 'upsell',    active: 'strategy-upsell',    title: '증액 (Upselling)',        color: '#16a34a', desc: '성과 우수 키워드의 증액 제안 예산 · 예상 상승 매출 · 예상 ROAS를 산출합니다.' },
  downsell:  { kind: 'downsell',  active: 'strategy-downsell',  title: '감액 (Downselling)',      color: '#dc2626', desc: '비효율 예산 감액, 또는 재정 목표 절감액에 맞춰 매출 손실 최소 컷을 제안합니다.' },
  discovery: { kind: 'discovery', active: 'strategy-discovery', title: '키워드 발굴 (Discovery)', color: '#7c3aed', desc: '전환 검색어 + 키워드도구 연관 키워드로 신규 키워드를 발굴합니다. (채널·성격 필터)' },
  oneclick:  { kind: 'oneclick',  active: 'strategy-oneclick',  title: '원클릭 계정분석 제안',     color: '#0ea5e9', desc: '증액·감액·발굴을 한 번에 요약한 월간 제안 리포트를 빠르게 생성합니다. (통화용)' },
};

function strategyControls(kind) {
  // 라벨/입력이 줄바꿈되지 않도록 white-space:nowrap + pill 스타일
  const pill = 'display:inline-flex;align-items:center;gap:7px;font-size:13px;cursor:pointer;white-space:nowrap;padding:7px 13px;border:1px solid #e2e8f0;border-radius:8px;background:#fff';
  const lbl = 'font-size:12px;color:#64748b;white-space:nowrap';
  const sel = 'padding:7px 10px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;min-width:112px;background:#fff';
  if (kind === 'upsell') {
    return `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <span style="${lbl}">채널</span>
      <label style="${pill}"><input type="checkbox" class="st-channel" value="powerlink" checked> 파워링크</label>
      <label style="${pill}"><input type="checkbox" class="st-channel" value="shopping" checked> 쇼핑검색</label>
      <span style="${lbl};margin-left:8px">증액 트랙</span>
      <label style="${pill}"><input type="radio" name="st-track" value="hold_roas" checked> ROAS 유지 증액</label>
      <label style="${pill}"><input type="radio" name="st-track" value="grow_volume"> 볼륨 성장(ROAS 최소화)</label>
    </div>`;
  }
  if (kind === 'downsell') {
    return `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <span style="${lbl}">감액 모드</span>
      <label style="${pill}"><input type="radio" name="st-mode" value="inefficiency" checked onchange="stToggleMode()"> 비효율 감액</label>
      <label style="${pill}"><input type="radio" name="st-mode" value="budget_target" onchange="stToggleMode()"> 재정 목표 감액</label>
      <div id="st-target-box" style="display:none;gap:8px;align-items:center;font-size:13px;flex-wrap:wrap">
        <label style="white-space:nowrap;color:#475569">목표 절감 <input id="st-target-pct" type="number" value="10" min="1" max="90" style="width:60px;padding:6px;border:1px solid #e2e8f0;border-radius:6px"> %</label>
        <span style="color:#94a3b8">또는</span>
        <label style="white-space:nowrap;color:#475569">금액 <input id="st-target-amt" type="number" value="0" min="0" style="width:124px;padding:6px;border:1px solid #e2e8f0;border-radius:6px"> 원</label>
      </div>
    </div>`;
  }
  if (kind === 'discovery') {
    return `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span style="${lbl}">채널</span>
      <select id="st-channel" style="${sel}"><option value="all">전체</option><option value="powerlink">파워링크</option><option value="shopping">쇼핑검색</option></select>
      <span style="${lbl}">키워드 성격</span>
      <select id="st-character" style="${sel}"><option value="all">전체</option><option value="related">연관</option><option value="functional">기능성</option><option value="seasonal">시즌성</option><option value="local">지역성</option></select>
    </div>`;
  }
  return ''; // oneclick: 기간만
}

function strategyPageContent(kind, selAccount) {
  const meta = STRATEGY_META[kind];
  if (!selAccount || !selAccount.id) {
    return `<div class="alert alert-info">좌측 상단에서 광고주를 선택해주세요.</div>`;
  }
  const runLabel = kind === 'oneclick' ? '🚀 분석 실행 (월간 제안 폼)' : '🔎 분석 실행';
  return `
    <div class="card" style="border-left:4px solid ${meta.color}">
      <div class="card-body">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;margin-bottom:12px">
          <div>
            <div style="font-size:16px;font-weight:700">${meta.title}</div>
            <div style="font-size:13px;color:#64748b;margin-top:2px">${meta.desc}</div>
            <div style="font-size:12px;color:#94a3b8;margin-top:4px">광고주: <b>${(selAccount.name||'').replace(/</g,'&lt;')}</b></div>
          </div>
        </div>
        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;background:#f8fafc;border:1px solid #eef2f7;border-radius:8px;padding:14px 16px">
          <div style="display:flex;align-items:center;gap:7px">
            <span style="font-size:12px;color:#64748b;white-space:nowrap">기간</span>
            <select id="st-period" style="padding:7px 10px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;min-width:112px;background:#fff">
              <option value="monthly">최근 30일</option>
              <option value="weekly">최근 7일</option>
              <option value="daily">어제</option>
            </select>
          </div>
          ${strategyControls(kind)}
          <button class="btn btn-primary" id="st-run" onclick="stRun()" style="background:${meta.color};border-color:${meta.color};white-space:nowrap;flex-shrink:0;min-width:128px;margin-left:auto">${runLabel}</button>
        </div>
        <div id="st-result" style="margin-top:16px"></div>
      </div>
    </div>
    <script>
    var ST_KIND='${kind}'; var ST_ACCOUNT='${selAccount.id}'; var ST_COLOR='${meta.color}'; var ST_LAST=null;
    function stToast(m,e){ if(typeof toast==='function') toast(m,e); else if(e) alert(m); }
    function stEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function stWon(n){ return '₩'+Number(n||0).toLocaleString('ko-KR'); }
    function stNum(n){ return Number(n||0).toLocaleString('ko-KR'); }
    function stToggleMode(){ var m=document.querySelector('input[name=st-mode]:checked'); var box=document.getElementById('st-target-box'); if(box) box.style.display=(m&&m.value==='budget_target')?'flex':'none'; }
    function stEndpoint(){ return ST_KIND==='oneclick' ? '/smart-sa/api/strategy/oneclick' : '/smart-sa/api/strategy/'+ST_KIND; }
    function stBody(){
      var b={ accountId:ST_ACCOUNT, type:document.getElementById('st-period').value };
      if(ST_KIND==='upsell'){ var t=document.querySelector('input[name=st-track]:checked'); b.track=t?t.value:'hold_roas'; b.channels=Array.prototype.slice.call(document.querySelectorAll('.st-channel:checked')).map(function(c){return c.value;}); }
      if(ST_KIND==='downsell'){ var m=document.querySelector('input[name=st-mode]:checked'); b.mode=m?m.value:'inefficiency'; if(b.mode==='budget_target'){ b.targetPct=parseInt(document.getElementById('st-target-pct').value)||10; var amt=parseInt(document.getElementById('st-target-amt').value)||0; if(amt>0) b.targetAmt=amt; } }
      if(ST_KIND==='discovery'){ b.channel=document.getElementById('st-channel').value; b.character=document.getElementById('st-character').value; }
      return b;
    }
    async function stRun(){
      if(!ST_ACCOUNT){ stToast('광고주를 먼저 선택하세요.',true); return; }
      var btn=document.getElementById('st-run'); var res=document.getElementById('st-result');
      btn.disabled=true; var old=btn.textContent; btn.textContent='분석 중...';
      res.innerHTML='<div style="padding:16px;color:#64748b;font-size:13px">⏳ 분석 중입니다... <span style="color:#94a3b8">(대시보드 동기화 전 계정은 최초 1~2분 소요될 수 있어요)</span></div>';
      try{
        var r=await fetch(stEndpoint(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(stBody())});
        var j=await r.json(); if(!j.ok) throw new Error(j.error||'분석 실패');
        ST_LAST=j; res.innerHTML=stRender(j);
      }catch(e){ res.innerHTML='<div style="padding:12px;color:#dc2626;font-size:13px">오류: '+stEsc(e.message)+'</div>'; stToast(e.message,true); }
      finally{ btn.disabled=false; btn.textContent=old; }
    }
    function stHead(period, cards, note){
      var h='<div style="font-size:12px;color:#94a3b8;margin-bottom:10px">분석 기간: '+stEsc(period||'')+(note?' · '+stEsc(note):'')+'</div>';
      h+='<div class="st-summary">';
      h+=cards.map(function(c){ return '<div class="st-sc" style="border-left-color:'+ST_COLOR+'"><div class="st-l">'+stEsc(c[0])+'</div><div class="st-v" style="color:'+ST_COLOR+'">'+c[1]+'</div></div>'; }).join('');
      h+='</div>'; return h;
    }
    // aligns[i]: 'l'(기본) | 'r'(숫자 우측정렬) | 'kw'(강조 라벨) | 'reason'(근거)
    function stTable(headers, rows, aligns){
      aligns = aligns || [];
      function cls(a){ return a==='r'?'num':(a==='reason'?'reason':(a==='kw'?'kw':'')); }
      var h='<div class="dtable-wrap"><table class="dtable"><thead><tr>';
      h+=headers.map(function(x,i){ var a=aligns[i]; return '<th class="'+(a==='r'?'num':'')+'">'+stEsc(x)+'</th>'; }).join('');
      h+='</tr></thead><tbody>';
      h+=rows.map(function(r){ return '<tr>'+r.map(function(c,i){ var k=cls(aligns[i]); return '<td'+(k?' class="'+k+'"':'')+'>'+c+'</td>'; }).join('')+'</tr>'; }).join('');
      h+='</tbody></table></div>'; return h;
    }
    function stCsvBtn(){ return '<div style="margin-top:10px"><button class="btn btn-outline btn-sm" onclick="stDownloadCsv()" style="font-size:12px">📥 CSV 다운로드</button></div>'; }
    function stRender(j){
      if(ST_KIND==='upsell') return stRenderUpsell(j);
      if(ST_KIND==='downsell') return stRenderDownsell(j);
      if(ST_KIND==='discovery') return stRenderDiscovery(j);
      return stRenderOneclick(j);
    }
    // dims: 'group'(캠페인/광고그룹) | 'kw'(캠페인/광고그룹/검색어) | 'dev'(기기)
    function stUpsellRows(items, dims){
      return (items||[]).map(function(it){
        var lead=[stEsc(it.campaignType)||'-'];
        if(dims==='group') lead=lead.concat([stEsc(it.campaignName)||'-',(stEsc(it.name)||'-')]);
        else if(dims==='kw') lead=lead.concat([stEsc(it.campaignName)||'-',stEsc(it.adgroupName)||'-',(stEsc(it.name)||'-')]);
        else lead=lead.concat([(stEsc(it.name)||'-')]);
        return lead.concat([stNum(it.clk),stNum(it.cvr)+'%',stWon(it.cpc),stWon(it.cost),stNum(it.roas)+'%','<b style="color:'+ST_COLOR+'">+'+stNum(it.addClicks)+'</b>',stWon(it.addSpend),'<b style="color:'+ST_COLOR+'">'+stWon(it.recBudget)+'</b>','<b style="color:'+ST_COLOR+'">'+stWon(it.expRevenueUplift)+'</b>',stNum(it.expRoas)+'%',stEsc(it.reason)]);
      });
    }
    function stUpsellSection(title, items, dims){
      var head='<div class="st-section" style="color:'+ST_COLOR+'">'+title+' <span class="st-count">'+stNum((items||[]).length)+'건</span></div>';
      if(!items||!items.length) return head+'<div class="st-empty">대상 없음 (전환 0건·저효율 제외)</div>';
      var lead = dims==='group'?['캠페인','광고그룹']:(dims==='kw'?['캠페인','광고그룹','검색어']:['기기']);
      var leadAlign = dims==='group'?['l','kw']:(dims==='kw'?['l','l','kw']:['kw']);
      var headers=['캠페인유형'].concat(lead, ['현재클릭','CVR','CPC','현재비용','현재ROAS','+클릭','추가투입','증액제안예산','예상상승매출','예상ROAS','근거']);
      var aligns=['l'].concat(leadAlign, ['r','r','r','r','r','r','r','r','r','r','reason']);
      return head+stTable(headers, stUpsellRows(items, dims), aligns);
    }
    function stRenderUpsell(j){
      var s=j.summary||{};
      var html=stHead(j.period,[['대상 그룹',stNum(s.count)+'건'],['총 추가투입',stWon(s.totalAddSpend)],['총 예상상승매출',stWon(s.totalExpUplift)],['상향가능 전체 ROAS',stNum(s.blendedExpRoas)+'%']],'트랙: '+(s.trackLabel||'')+' · 채널: '+((s.channels||[]).join(', ')||'전체'));
      html+='<div style="margin:6px 0 8px"><button class="btn btn-primary btn-sm" onclick="stUpsellExcel()" id="st-upx" style="background:'+ST_COLOR+';border-color:'+ST_COLOR+'">📊 엑셀 상세 다운로드 (그룹·키워드·기기)</button></div>';
      html+=stUpsellSection('① 그룹별 (증액 실행 단위)', j.groups, 'group');
      html+=stUpsellSection('② 키워드 · 상품검색어별', j.keywords, 'kw');
      html+=stUpsellSection('③ 기기별 (PC/모바일, 계정 전체)', j.devices, 'dev');
      return html;
    }
    function stUpsellExcel(){
      var type=document.getElementById('st-period').value;
      var chs=Array.prototype.slice.call(document.querySelectorAll('.st-channel:checked')).map(function(c){return c.value;});
      var t=document.querySelector('input[name=st-track]:checked'); var track=t?t.value:'hold_roas';
      var url='/smart-sa/api/strategy/upsell-excel?accountId='+encodeURIComponent(ST_ACCOUNT)+'&type='+encodeURIComponent(type)+'&track='+encodeURIComponent(track)+'&channels='+encodeURIComponent(chs.join(','));
      var a=document.createElement('a'); a.href=url; document.body.appendChild(a); a.click(); document.body.removeChild(a);
      stToast('증액 상세 엑셀을 생성합니다. 잠시 후 다운로드됩니다.');
    }
    function stRenderDownsell(j){
      var s=j.summary||{}; var items=j.items||[];
      var roasCard = ['예상 전체 ROAS', '<span>'+stNum(s.currentRoas)+'% → <b style="color:#16a34a">'+stNum(s.projectedRoas)+'%</b></span>'];
      var cards = s.mode==='budget_target'
        ? [['목표 절감액',stWon(s.targetReduction)],['예상 매출손실',stWon(s.estRevenueLoss)],roasCard,['대상',stNum(s.count)+'건']]
        : [['대상',stNum(s.count)+'건'],['총 감액 제안액',stWon(s.totalCutSpend)],['예상 매출손실',stWon(s.estRevenueLoss)],roasCard];
      var html=stHead(j.period,cards, (s.mode==='budget_target'?'모드: 재정 목표 감액 (ROAS 낮은 순 컷 → 손실 최소)':'모드: 비효율 감액')+' · 감액 적용 시 전체 ROAS '+stNum(s.currentRoas)+'%→'+stNum(s.projectedRoas)+'%');
      html+='<div style="margin:6px 0 8px"><button class="btn btn-primary btn-sm" onclick="stDownsellExcel()" id="st-dnx" style="background:'+ST_COLOR+';border-color:'+ST_COLOR+'">📊 엑셀 상세 다운로드 (키워드·기기)</button></div>';
      // 검색어(키워드) 다운셀링 — 캠페인유형/캠페인/광고그룹/검색어
      var dsAlign=['l','l','l','kw','r','r','r','r','r','reason'];
      var rows=items.map(function(it){ return [stEsc(it.campaignType)||'-',stEsc(it.campaignName)||'-',stEsc(it.adgroupName)||'-',(stEsc(it.name)||'-'),stWon(it.cost),stNum(it.roas)+'%',stNum(it.purchaseCnt),'<b style="color:'+ST_COLOR+'">'+stWon(it.cutSpend)+'</b>',stWon(it.lostRevenue),stEsc(it.reason)]; });
      html+='<div class="st-section" style="color:'+ST_COLOR+'">① 키워드·검색어별 비효율 <span class="st-count">'+stNum(items.length)+'건</span></div>';
      html+=stTable(['캠페인유형','캠페인','광고그룹','검색어','현재비용','ROAS','구매수','감액제안액','예상매출손실','근거'],rows,dsAlign);
      // 기기별 다운셀링
      var dev=j.devices||[];
      html+='<div class="st-section" style="color:'+ST_COLOR+'">② 기기별 비효율 <span class="st-count">매체이름은 SA API 미제공 → 기기로 대체</span></div>';
      if(!dev.length) html+='<div class="st-empty">대상 없음</div>';
      else html+=stTable(['기기','현재비용','ROAS','구매수','감액제안액','예상매출손실','근거'], dev.map(function(it){ return [(stEsc(it.name)||'-'),stWon(it.cost),stNum(it.roas)+'%',stNum(it.purchaseCnt),'<b style="color:'+ST_COLOR+'">'+stWon(it.cutSpend)+'</b>',stWon(it.lostRevenue),stEsc(it.reason)]; }), ['kw','r','r','r','r','r','reason']);
      return html;
    }
    function stDownsellExcel(){
      var type=document.getElementById('st-period').value;
      var m=document.querySelector('input[name=st-mode]:checked'); var mode=m?m.value:'inefficiency';
      var url='/smart-sa/api/strategy/downsell-excel?accountId='+encodeURIComponent(ST_ACCOUNT)+'&type='+encodeURIComponent(type)+'&mode='+encodeURIComponent(mode);
      if(mode==='budget_target'){ url+='&targetPct='+(parseInt((document.getElementById('st-target-pct')||{}).value)||10); var amt=parseInt((document.getElementById('st-target-amt')||{}).value)||0; if(amt>0) url+='&targetAmt='+amt; }
      var a=document.createElement('a'); a.href=url; document.body.appendChild(a); a.click(); document.body.removeChild(a);
      stToast('감액 상세 엑셀을 생성합니다. 잠시 후 다운로드됩니다.');
    }
    function stRenderDiscovery(j){
      var s=j.summary||{}; var items=j.items||[]; var cm={functional:'기능성',seasonal:'시즌성',local:'지역성'};
      var chL=(s.channel==='all'?'전체':(s.channel==='shopping'?'쇼핑검색':'파워링크')); var caL=(s.character==='all'?'전체':(cm[s.character]||(s.character==='related'?'연관':s.character)));
      var html=stHead(j.period,[['대상',stNum(s.count)+'건'],['전환검색어',stNum(s.convertingQueries)+'건'],['키워드도구',stNum(s.toolIdeas)+'건'],['채널/성격',chL+' / '+caL]],'');
      var rows=items.map(function(it){ var chars=(it.characters||[]).map(function(c){return cm[c]||c;}).join(',')||'-'; var ch=it.channel==='shopping'?'쇼핑':(it.channel==='powerlink'?'파워링크':'-');
        return ['<b>'+stEsc(it.keyword)+'</b>',stEsc(it.source),chars,ch,(it.monthlyTotal==null?'-':stNum(it.monthlyTotal)),(it.monthlyPc==null?'-':stNum(it.monthlyPc)),(it.monthlyMobile==null?'-':stNum(it.monthlyMobile)),stNum(it.currentClk),stNum(it.currentPurchase),'<span style="color:#64748b">'+stEsc(it.reason)+'</span>']; });
      html+=stTable(['발굴키워드','출처','성격','채널','월검색량','PC','MO','현재클릭','현재구매','근거'],rows);
      return html+stCsvBtn();
    }
    function stOcSection(title,color,sub,lines){
      var h='<div style="margin-bottom:14px"><div style="font-weight:700;font-size:14px;color:'+color+'">'+title+'</div><div style="font-size:12px;color:#64748b;margin:2px 0 6px">'+sub+'</div>';
      if(!lines.length) h+='<div style="font-size:12px;color:#94a3b8">해당 없음</div>';
      else h+='<ul style="margin:0;padding-left:18px;font-size:12px;color:#334155">'+lines.map(function(l){return '<li style="margin:3px 0">'+l+'</li>';}).join('')+'</ul>';
      return h+'</div>';
    }
    function stPerfTable(title, rows){
      if(!rows||!rows.length) return '';
      var h='<div style="font-weight:700;font-size:12.5px;margin:12px 0 5px;color:#334155">'+title+'</div>';
      var trows=rows.map(function(r){ return [(stEsc(r.name)||'-'),stWon(r.cost),stNum(r.clk),stWon(r.purchaseAmt),stNum(r.roas)+'%']; });
      return h+stTable(['구분','총비용','클릭','구매매출','ROAS'], trows, ['kw','r','r','r','r']);
    }
    function stRenderOneclick(j){
      var s=j.summary||{}; var sug=j.suggestions||{}; var k=j.kpi||{}; var perf=j.performance||{};
      var html='<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px">';
      html+='<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;border-bottom:2px solid '+ST_COLOR+';padding-bottom:10px;margin-bottom:14px">';
      html+='<div><div style="font-size:18px;font-weight:800">'+stEsc(j.accountName||'')+' 월간 제안 리포트</div><div style="font-size:12px;color:#94a3b8">'+stEsc(j.period||'')+'</div></div>';
      html+='<button class="btn btn-outline btn-sm" onclick="window.print()" style="font-size:12px">🖨 인쇄</button></div>';
      html+='<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px;font-size:13px"><div>총비용 <b>'+stWon(k.cost)+'</b></div><div>구매매출 <b>'+stWon(k.purchaseAmt)+'</b></div><div>ROAS <b>'+stNum(k.roas)+'%</b></div><div>클릭 <b>'+stNum(k.clk)+'</b></div></div>';
      // ── 계정 성과 요약 (엑셀 전 미리보기) ──
      html+='<div style="background:#f8fafc;border:1px solid #eef2f7;border-radius:8px;padding:12px;margin:10px 0 16px">';
      html+='<div style="font-weight:700;font-size:13px;color:#0ea5e9;margin-bottom:6px">📊 계정 성과 요약</div>';
      html+='<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">';
      html+='<div style="flex:1;min-width:180px;background:#fff;border:1px solid #fecaca;border-radius:6px;padding:8px"><div style="font-size:11px;color:#64748b">비효율 키워드</div><div style="font-size:16px;font-weight:700;color:#dc2626">'+stNum(s.inefficientCount)+'건 · '+stWon(s.inefficientCost)+'</div></div>';
      html+='<div style="flex:1;min-width:180px;background:#fff;border:1px solid #bbf7d0;border-radius:6px;padding:8px"><div style="font-size:11px;color:#64748b">업셀링 제안</div><div style="font-size:16px;font-weight:700;color:#16a34a">'+stNum(s.upsellCount)+'건 · 상향가능 ROAS '+stNum(s.upsellBlendedRoas)+'%</div></div>';
      html+='<div style="flex:1;min-width:180px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:8px"><div style="font-size:11px;color:#64748b">감액 적용 시 전체 ROAS</div><div style="font-size:16px;font-weight:700;color:#0ea5e9">'+stNum(s.downsellCurrentRoas)+'% → '+stNum(s.downsellProjectedRoas)+'%</div></div>';
      html+='</div>';
      html+=stPerfTable('캠페인 유형별 성과', perf.byCampaignType);
      html+=stPerfTable('캠페인별 성과 (TOP)', perf.byCampaign);
      html+=stPerfTable('기기별 성과', perf.byDevice);
      html+='<div style="font-size:11px;color:#94a3b8;margin-top:4px">* 성별·연령별 성과는 네이버 SA API 미제공으로 제외</div>';
      html+='</div>';
      html+=stOcSection('① 증액(업셀링) 제안 — 그룹 단위','#16a34a','대상 '+stNum(s.upsellCount)+'건 · 추가투입 '+stWon(s.upsellAddSpend)+' → 예상 상승매출 '+stWon(s.upsellExpUplift)+' (상향가능 ROAS '+stNum(s.upsellBlendedRoas)+'%)',(sug.upsell||[]).slice(0,5).map(function(it){return stEsc(it.name)+' — '+stWon(it.recBudget)+' 증액 시 매출 +'+stWon(it.expRevenueUplift)+' (ROAS '+stNum(it.expRoas)+'%)';}));
      html+=stOcSection('② 감액(다운셀링) 제안','#dc2626','대상 '+stNum(s.downsellCount)+'건 · 비효율 절감 '+stWon(s.downsellWasteCost)+' · 적용 시 전체 ROAS '+stNum(s.downsellCurrentRoas)+'%→'+stNum(s.downsellProjectedRoas)+'%',(sug.downsell||[]).slice(0,5).map(function(it){return stEsc(it.name)+' — '+stWon(it.cost)+' (ROAS '+stNum(it.roas)+'%) → '+stEsc(it.action);}));
      html+='</div>';
      html+='<div style="margin-top:12px"><button class="btn btn-primary btn-sm" onclick="stFullExcel()" id="st-fullx" style="font-size:12px;background:'+ST_COLOR+';border-color:'+ST_COLOR+'">📊 전체 리포트+제안 엑셀 추출</button></div>';
      return html;
    }
    function stFullExcel(){
      // GET 스트리밍 다운로드 (base64-in-JSON 대신 파일 직접 다운로드 → 응답크기 한도 회피)
      var type=document.getElementById('st-period').value;
      var url='/smart-sa/api/report/one-click-excel?accountId='+encodeURIComponent(ST_ACCOUNT)+'&type='+encodeURIComponent(type);
      var a=document.createElement('a'); a.href=url; document.body.appendChild(a); a.click(); document.body.removeChild(a);
      stToast('전체 엑셀 생성을 시작했습니다. 대용량 계정은 1~3분 후 다운로드됩니다.');
    }
    function stDownloadCsv(){
      if(!ST_LAST||!ST_LAST.items||!ST_LAST.items.length){ stToast('데이터가 없습니다.',true); return; }
      var headers, rows;
      if(ST_KIND==='upsell'){ headers=['키워드','캠페인','광고그룹','현재비용','현재ROAS','증액제안예산','추가투입','예상상승매출','예상ROAS','근거'];
        rows=ST_LAST.items.map(function(it){return [it.name,it.campaignName,it.adgroupName,it.cost,it.roas,it.recBudget,it.addSpend,it.expRevenueUplift,it.expRoas,it.reason];}); }
      else if(ST_KIND==='downsell'){ headers=['키워드','캠페인','광고그룹','현재비용','ROAS','구매수','감액제안액','예상매출손실','근거'];
        rows=ST_LAST.items.map(function(it){return [it.name,it.campaignName,it.adgroupName,it.cost,it.roas,it.purchaseCnt,it.cutSpend,it.lostRevenue,it.reason];}); }
      else { headers=['발굴키워드','출처','성격','채널','월검색량','PC','모바일','현재클릭','현재구매','근거'];
        rows=ST_LAST.items.map(function(it){return [it.keyword,it.source,(it.characters||[]).join('|'),it.channel,it.monthlyTotal,it.monthlyPc,it.monthlyMobile,it.currentClk,it.currentPurchase,it.reason];}); }
      var bom=String.fromCharCode(0xFEFF); var nl=String.fromCharCode(10);
      var csv=bom+headers.join(',')+nl;
      rows.forEach(function(r){ csv+=r.map(function(v){ var sv=String(v==null?'':v); if(sv.indexOf(',')>=0||sv.indexOf('"')>=0||sv.indexOf(nl)>=0) return '"'+sv.replace(/"/g,'""')+'"'; return sv; }).join(',')+nl; });
      var blob=new Blob([csv],{type:'text/csv;charset=utf-8'}); var url=URL.createObjectURL(blob);
      var a=document.createElement('a'); a.href=url; a.download=ST_KIND+'_'+ST_ACCOUNT+'.csv'; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(function(){URL.revokeObjectURL(url);},2000);
    }
    </script>`;
}

['upsell', 'downsell', 'analysis'].forEach(seg => {  // discovery 제거(사용자 요청)
  const kind = seg === 'analysis' ? 'oneclick' : seg;
  router.get('/strategy/' + seg, requireLogin, requireApi, async (req, res) => {
    const user = await getUser(req);
    const layoutOpts = await getLayoutOpts(req);
    const selId = layoutOpts.selectedAccountId || '';
    const selAccount = selId ? (layoutOpts.accounts || []).find(a => String(a.id) === String(selId)) : null;
    const meta = STRATEGY_META[kind];
    res.send(appLayout(meta.title, strategyPageContent(kind, selAccount), user, meta.active, layoutOpts));
  });
});

// ─── 리포트 ─────────────────────────────────────────────────────────
router.get('/reports', requireLogin, requireApi, async (req, res) => {
  const user = await getUser(req);
  const accounts = await db.getAccountsByUser(user.id);
  const selId = req.session.selectedAccountId || (accounts[0]?.id || '');
  const selAccount = accounts.find(a => String(a.id) === String(selId)) || accounts[0] || {};
  const repCfg = db.parseReportConfig(selAccount); // { sheets:{}, customSheets:[] }

  const content = `
    ${!selId ? '<div class="alert alert-info">좌측 상단에서 광고주를 선택해주세요.</div>' : `
    <p style="color:#64748b;font-size:13px;margin-bottom:16px">현재 광고주: <strong>${selAccount.name || ''}</strong>
      ${selAccount.has_sa === false ? '' : '<span class="badge" style="background:#dbeafe;color:#1e40af;font-size:10px;margin-left:6px;padding:1px 6px">SA</span>'}
      ${FEATURES.DA && selAccount.has_da ? '<span class="badge" style="background:#fce7f3;color:#9f1239;font-size:10px;margin-left:3px;padding:1px 6px">DA</span>' : ''}
    </p>

    <!-- SA / DA 탭 (DA는 공식 GFA API 연동 전까지 비활성화) -->
    <div class="tab-bar" style="margin-bottom:16px">
      <button class="tab-btn dash-tab active" data-rep-tab="sa" onclick="switchRepTab('sa')">🔍 SA 리포트</button>
      ${FEATURES.DA ? `<button class="tab-btn dash-tab ${selAccount.has_sa === false && selAccount.has_da ? 'active' : ''}" data-rep-tab="da" onclick="switchRepTab('da')">📺 DA 리포트</button>` : ''}
    </div>

    <!-- SA 탭 -->
    <div id="rep-tab-sa" class="rep-tab-content">
    ${selAccount.has_sa === false ? '<div class="alert" style="background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0;padding:16px;border-radius:8px">이 광고주는 SA가 활성화되지 않은 계정입니다. 광고주 설정에서 SA를 활성화하세요.</div>' : `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:20px">
      ${['daily','weekly','monthly'].map(t => {
        const label = {daily:'일간',weekly:'주간',monthly:'월간'}[t];
        const desc  = {daily:'어제 하루 성과 (매일 09:00)',weekly:'최근 7일 성과 (월요일 09:00)',monthly:'최근 30일 성과 (매월 1일 09:00)'}[t];
        return `<div class="card">
          <div class="card-body" style="text-align:center">
            <div style="font-size:32px;margin-bottom:12px">${{daily:'🗓',weekly:'📅',monthly:'📆'}[t]}</div>
            <h3 style="font-weight:600;margin-bottom:6px">${label} 리포트</h3>
            <p style="color:#64748b;font-size:12px;margin-bottom:16px">${desc}</p>
            <div style="display:flex;gap:6px">
              <button class="btn btn-outline" style="flex:1;justify-content:center" onclick="downloadReportExcel('${t}')" id="excel-btn-${t}">📥 엑셀 다운로드</button>
              <button class="btn btn-primary" style="flex:1;justify-content:center" onclick="triggerReport('${t}')">이메일 발송</button>
            </div>
          </div>
        </div>`;
      }).join('')}
      <div class="card" style="border:2px dashed #cbd5e1">
        <div class="card-body" style="text-align:center">
          <div style="font-size:32px;margin-bottom:12px">🗓</div>
          <h3 style="font-weight:600;margin-bottom:6px">기간 선택 리포트</h3>
          <p style="color:#64748b;font-size:12px;margin-bottom:16px">월간(전월 비교)·주간(전주 비교)<br>또는 맞춤 기간</p>
          <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="openCustomReportModal('sa')">📅 기간 선택</button>
        </div>
      </div>
    </div>`}
    </div>

    <!-- DA 탭 (FEATURES.DA off면 항상 숨김) -->
    <div id="rep-tab-da" class="rep-tab-content" ${FEATURES.DA && selAccount.has_sa === false && selAccount.has_da ? '' : 'style="display:none"'}>
    ${!selAccount.has_da ? '<div class="alert" style="background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0;padding:16px;border-radius:8px">이 광고주는 DA가 활성화되지 않은 계정입니다. 광고주 설정에서 DA를 활성화하고 광고관리 쿠키를 등록하세요.</div>' : (!selAccount.naver_cookie ? '<div class="alert" style="background:#fee2e2;color:#7f1d1d;border:1px solid #fecaca;padding:16px;border-radius:8px">DA 광고관리 쿠키가 등록되지 않았습니다. <a href="/smart-sa/accounts/'+selAccount.id+'/edit" style="color:#0284c7;font-weight:600">광고주 설정</a>에서 등록해주세요.</div>' : `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:20px">
      ${['daily','weekly','monthly'].map(t => {
        const label = {daily:'일간',weekly:'주간',monthly:'월간'}[t];
        const desc  = {daily:'어제 하루 DA 성과 (매일 09:30)',weekly:'최근 7일 DA 성과 (월요일 09:30)',monthly:'전월 DA 성과 (매월 1일 09:30)'}[t];
        return `<div class="card" style="border-color:#fce7f3">
          <div class="card-body" style="text-align:center">
            <div style="font-size:32px;margin-bottom:12px">${{daily:'📺',weekly:'📺',monthly:'📺'}[t]}</div>
            <h3 style="font-weight:600;margin-bottom:6px">DA ${label} 리포트</h3>
            <p style="color:#64748b;font-size:12px;margin-bottom:16px">${desc}</p>
            <div style="display:flex;gap:6px">
              <button class="btn btn-outline" style="flex:1;justify-content:center" onclick="downloadDaReportExcel('${t}')" id="da-excel-btn-${t}">📥 엑셀 다운로드</button>
              <button class="btn btn-primary" style="flex:1;justify-content:center" onclick="triggerDaReport('${t}')">이메일 발송</button>
            </div>
          </div>
        </div>`;
      }).join('')}
      <div class="card" style="border:2px dashed #fce7f3">
        <div class="card-body" style="text-align:center">
          <div style="font-size:32px;margin-bottom:12px">🛠</div>
          <h3 style="font-weight:600;margin-bottom:6px">DA 맞춤 리포트</h3>
          <p style="color:#64748b;font-size:12px;margin-bottom:16px">원하는 기간 직접 선택<br>월간 폼으로 생성</p>
          <button class="btn btn-primary" style="width:100%;justify-content:center;background:#9f1239" onclick="openCustomReportModal('da')">📅 기간 선택</button>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
        <span class="card-title">⏰ DA 자동 발송 스케줄</span>
        <button class="btn btn-outline btn-sm" onclick="openSchedEdit('da')" style="font-size:12px">⚙ 수정</button>
      </div>
      <div class="card-body">
        <table>
          <thead><tr><th>리포트</th><th>발송 시각</th><th>자동 발송</th><th>최근 발송</th></tr></thead>
          <tbody>
            ${['daily','weekly','monthly'].map(t => {
              const label = {daily:'일간',weekly:'주간',monthly:'월간'}[t];
              const dowNames = ['일','월','화','수','목','금','토'];
              const h = selAccount['sched_da_' + t + '_hour'] ?? 9;
              const dow = selAccount.sched_da_weekly_dow ?? 1;
              const day = selAccount.sched_da_monthly_day ?? 1;
              const hStr = String(h).padStart(2, '0') + ':00 KST';
              const time = t === 'daily' ? `매일 ${hStr}`
                         : t === 'weekly' ? `매주 ${dowNames[dow]}요일 ${hStr}`
                         : `매월 ${day}일 ${hStr}`;
              const featKey = 'feat_da_' + t + '_report';
              const isOn = !!selAccount[featKey];
              const col = 'last_da_' + t + '_report';
              const lastDate = selAccount[col] ? (() => { const d = new Date(new Date(selAccount[col]).getTime() + 9*60*60*1000); return d.getUTCFullYear() + '. ' + (d.getUTCMonth()+1) + '. ' + d.getUTCDate() + '. ' + (d.getUTCHours() >= 12 ? '오후' : '오전') + ' ' + String(d.getUTCHours() > 12 ? d.getUTCHours()-12 : d.getUTCHours() || 12).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0'); })() : '<span style="color:#94a3b8">발송 내역 없음</span>';
              return `<tr>
                <td><strong>DA ${label}</strong></td>
                <td>${time}</td>
                <td>
                  <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer">
                    <input type="checkbox" ${isOn ? 'checked' : ''} onchange="toggleDaReportFeat('${featKey}',this.checked)" style="width:16px;height:16px;accent-color:#9f1239">
                    <span style="font-size:13px;color:${isOn ? '#16a34a' : '#94a3b8'}" id="label-${featKey}">${isOn ? 'ON' : 'OFF'}</span>
                  </label>
                </td>
                <td style="font-size:12px">${lastDate}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
    `)}
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-header">
        <span class="card-title">📧 수신 이메일</span>
        <button class="btn btn-outline btn-sm" id="btn-edit-emails" onclick="toggleEditEmails()">수정</button>
      </div>
      <div class="card-body">
        <div id="emails-display">
          <p style="font-size:13px;color:#374151" id="emails-text">${selAccount.report_emails ? selAccount.report_emails.split(',').map(e => e.trim()).filter(Boolean).map(e => '<span class="badge badge-blue" style="margin-right:6px;margin-bottom:4px;padding:4px 12px">'+e+'</span>').join('') : '<span style="color:#94a3b8">수신 이메일이 설정되지 않았습니다.</span>'}</p>
        </div>
        <div id="emails-edit" style="display:none">
          <div class="form-group" style="margin-bottom:12px">
            <label>수신 이메일 (쉼표로 구분)</label>
            <input type="text" id="emails-input" value="${selAccount.report_emails || ''}" placeholder="user1@example.com, user2@example.com">
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary btn-sm" onclick="saveEmails()">저장</button>
            <button class="btn btn-outline btn-sm" onclick="toggleEditEmails()">취소</button>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
        <span class="card-title">⏰ 자동 발송 스케줄</span>
        <button class="btn btn-outline btn-sm" onclick="openSchedEdit('sa')" style="font-size:12px">⚙ 수정</button>
      </div>
      <div class="card-body">
        <table>
          <thead><tr><th>리포트</th><th>발송 시각</th><th>자동 발송</th><th>최근 발송</th></tr></thead>
          <tbody>
            ${['daily','weekly','monthly'].map(t => {
              const label = {daily:'일간',weekly:'주간',monthly:'월간'}[t];
              const dowNames = ['일','월','화','수','목','금','토'];
              const h = selAccount['sched_' + t + '_hour'] ?? 9;
              const dow = selAccount.sched_weekly_dow ?? 1;
              const day = selAccount.sched_monthly_day ?? 1;
              const hStr = String(h).padStart(2, '0') + ':00 KST';
              const time = t === 'daily' ? `매일 ${hStr}`
                         : t === 'weekly' ? `매주 ${dowNames[dow]}요일 ${hStr}`
                         : `매월 ${day}일 ${hStr}`;
              const featKey = 'feat_' + t + '_report';
              const isOn = !!selAccount[featKey];
              const col = 'last_' + t + '_report';
              const lastDate = selAccount[col] ? (() => { const d = new Date(new Date(selAccount[col]).getTime() + 9*60*60*1000); return d.getUTCFullYear() + '. ' + (d.getUTCMonth()+1) + '. ' + d.getUTCDate() + '. ' + (d.getUTCHours() >= 12 ? '오후' : '오전') + ' ' + String(d.getUTCHours() > 12 ? d.getUTCHours()-12 : d.getUTCHours() || 12).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0'); })() : '<span style="color:#94a3b8">발송 내역 없음</span>';
              return `<tr>
                <td><strong>${label}</strong></td>
                <td>${time}</td>
                <td>
                  <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer">
                    <input type="checkbox" ${isOn ? 'checked' : ''} onchange="toggleReportFeat('${featKey}',this.checked)" style="width:16px;height:16px;accent-color:#6366f1">
                    <span style="font-size:13px;color:${isOn ? '#16a34a' : '#94a3b8'}" id="label-${featKey}">${isOn ? 'ON' : 'OFF'}</span>
                  </label>
                </td>
                <td style="font-size:12px">${lastDate}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- 성과개선 전략 안내 (전용 메뉴로 이동) -->
    <div class="card" style="border-left:4px solid #38ae49;margin-top:4px">
      <div class="card-body" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div style="font-size:13px;color:#475569">💡 <b>증액·감액·키워드 발굴·원클릭 계정분석</b>은 좌측 <b>성과개선 전략</b> 메뉴로 이동했습니다.</div>
        <a class="btn btn-outline btn-sm" href="/smart-sa/strategy/analysis" style="font-size:12px">원클릭 계정분석 제안 →</a>
      </div>
    </div>

    <!-- 리포트 시트 설정 -->
    <div class="card">
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
        <span class="card-title">🧩 리포트 시트 설정 <span style="font-size:12px;color:#94a3b8;font-weight:400">(이 광고주 전용)</span></span>
        <button class="btn btn-primary btn-sm" onclick="saveReportConfig()" id="rcfg-save" style="font-size:12px">💾 설정 저장</button>
      </div>
      <div class="card-body">
        <div style="font-size:12px;color:#64748b;margin-bottom:10px">자동/다운로드 엑셀 리포트에 포함할 시트를 선택하세요. <b>표지·요약</b>은 항상 포함됩니다.</div>
        <div id="rcfg-sheets" style="display:flex;flex-wrap:wrap;gap:16px;margin-bottom:18px">
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;opacity:.55"><input type="checkbox" checked disabled style="width:16px;height:16px"> 요약·캠페인 (항상)</label>
          ${[['comparison','기간비교'],['typeDevice','유형 및 기기별'],['adgroup','광고그룹별'],['keyword','검색어별'],['hourly','시간대별'],['daily','일자별']].map(([k,lbl]) => {
            const on = repCfg.sheets[k] !== false;
            return '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:13px"><input type="checkbox" class="rcfg-sheet" data-key="'+k+'" '+(on?'checked':'')+' style="width:16px;height:16px;accent-color:#38ae49"> '+lbl+'</label>';
          }).join('')}
        </div>
        <div style="border-top:1px solid #f1f5f9;padding-top:14px">
          <div style="font-weight:600;font-size:13px;margin-bottom:4px">커스텀 시트 <span style="color:#94a3b8;font-weight:400">— 네이버 다차원보고서처럼 항목/지표를 선택·정렬</span></div>
          <div style="font-size:11px;color:#94a3b8;margin-bottom:12px">왼쪽 <b>항목 목록</b>에서 항목을 클릭(또는 드래그)해 추가하고, 오른쪽 <b>보고서 설정하기</b>에서 칩을 드래그해 순서를 바꾸세요. 시트마다 차원·지표를 자유롭게 조합합니다.</div>
          <div id="rcfg-panels"></div>
          <button class="btn btn-outline btn-sm" onclick="addPanel()" style="font-size:12px;margin-top:4px">＋ 시트 추가</button>
        </div>
      </div>
    </div>
    `}
    <script>
    const reportAccountId = '${selId}';
    var savedCustomSheets = ${JSON.stringify(repCfg.customSheets || [])};
    // 네이버 다차원보고서 항목 (sup:true만 추가 가능, key 없으면 현재 데이터 범위 미지원)
    var FIELD_DEFS = [
      {cat:'광고 정보', key:'byCampaign', label:'캠페인', type:'dim', sup:true},
      {cat:'광고 정보', key:'byCampaignType', label:'캠페인 유형', type:'dim', sup:true},
      {cat:'광고 정보', key:'byAdgroup', label:'광고그룹', type:'dim', sup:true},
      {cat:'광고 정보', key:null, label:'광고그룹 유형', type:'dim', sup:false},
      {cat:'광고 정보', key:'byKeyword', label:'키워드', type:'dim', sup:true},
      {cat:'광고 정보', key:null, label:'소재', type:'dim', sup:false},
      {cat:'광고 정보', key:null, label:'확장 소재 유형', type:'dim', sup:false},
      {cat:'광고 정보', key:null, label:'확장 소재', type:'dim', sup:false},
      {cat:'광고 정보', key:null, label:'검색 유형', type:'dim', sup:false},
      {cat:'광고 정보', key:'byQuery', label:'검색어', type:'dim', sup:true},
      {cat:'타겟팅 구분', key:null, label:'지역', type:'dim', sup:false},
      {cat:'타겟팅 구분', key:null, label:'상세 지역', type:'dim', sup:false},
      {cat:'타겟팅 구분', key:null, label:'성별', type:'dim', sup:false},
      {cat:'타겟팅 구분', key:null, label:'연령대', type:'dim', sup:false},
      {cat:'타겟팅 구분', key:'byDevice', label:'PC/모바일', type:'dim', sup:true},
      {cat:'광고 성과', key:'imp', label:'노출수', type:'metric', sup:true},
      {cat:'광고 성과', key:'clk', label:'클릭수', type:'metric', sup:true},
      {cat:'광고 성과', key:'ctr', label:'클릭률(%)', type:'metric', sup:true},
      {cat:'광고 성과', key:'cpc', label:'평균 CPC', type:'metric', sup:true},
      {cat:'광고 성과', key:'cost', label:'총비용', type:'metric', sup:true},
      {cat:'전환 성과', key:null, label:'총 전환수', type:'metric', sup:false},
      {cat:'전환 성과', key:null, label:'직접전환수', type:'metric', sup:false},
      {cat:'전환 성과', key:null, label:'간접전환수', type:'metric', sup:false},
      {cat:'전환 성과', key:null, label:'총 전환율(%)', type:'metric', sup:false},
      {cat:'전환 성과', key:null, label:'총 전환매출액', type:'metric', sup:false},
      {cat:'전환 성과', key:null, label:'직접전환매출액', type:'metric', sup:false},
      {cat:'전환 성과', key:null, label:'간접전환매출액', type:'metric', sup:false},
      {cat:'전환 성과', key:null, label:'총 전환당비용', type:'metric', sup:false},
      {cat:'전환 성과', key:null, label:'총 광고수익률(%)', type:'metric', sup:false},
      {cat:'전환 성과', key:'purchaseCnt', label:'구매완료 전환수', type:'metric', sup:true},
      {cat:'전환 성과', key:'purchaseAmt', label:'구매완료 전환매출액', type:'metric', sup:true},
      {cat:'전환 성과', key:'roas', label:'구매완료 광고수익률(%)', type:'metric', sup:true},
      {cat:'전환 성과', key:null, label:'전환 유형', type:'dim', sup:false},
      {cat:'시간구분', key:'byDate', label:'일별', type:'dim', sup:true},
      {cat:'시간구분', key:null, label:'주별', type:'dim', sup:false},
      {cat:'시간구분', key:null, label:'요일별', type:'dim', sup:false},
      {cat:'시간구분', key:'byHour', label:'시간대별', type:'dim', sup:true},
    ];
    var FIELD_BY_KEY={}; FIELD_DEFS.forEach(function(f){ if(f.key) FIELD_BY_KEY[f.key]=f; });
    var FIELD_CATS=['광고 정보','타겟팅 구분','광고 성과','전환 성과','시간구분'];
    function migratePanel(cs){
      var fields = (Array.isArray(cs.fields)&&cs.fields.length) ? cs.fields.slice() : [];
      if(!fields.length){ if(cs.dimension) fields.push(cs.dimension); if(Array.isArray(cs.metrics)) fields=fields.concat(cs.metrics); }
      fields=fields.filter(function(k){ return FIELD_BY_KEY[k]; });
      return { name: cs.name||'', fields: fields, sortBy: cs.sortBy||'', limit: parseInt(cs.limit)||50 };
    }
    var customPanels=(savedCustomSheets||[]).map(migratePanel);
    if(!customPanels.length) customPanels=[{name:'',fields:[],sortBy:'',limit:50}];
    var csDrag=null; // 드래그 상태

    function switchRepTab(name){
      document.querySelectorAll('.rep-tab-content').forEach(function(el){el.style.display='none';});
      document.getElementById('rep-tab-'+name).style.display='block';
      document.querySelectorAll('[data-rep-tab]').forEach(function(b){
        if (b.dataset.repTab===name) b.classList.add('active'); else b.classList.remove('active');
      });
    }

    // ── 공통 유틸 ──
    function ocaToast(m,e){ if(typeof toast==='function') toast(m,e); else if(e) alert(m); }
    function escapeHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function ocaWon(n){ return '₩'+Number(n||0).toLocaleString('ko-KR'); }
    function ocaNum(n){ return Number(n||0).toLocaleString('ko-KR'); }

    // ── 리포트 시트 설정 ──
    // ── 커스텀 시트 빌더 (네이버 다차원보고서 스타일, 다중 패널) ──
    function syncPanelsFromDom(){
      document.querySelectorAll('.cs-panel').forEach(function(el){
        var pi=parseInt(el.dataset.pi); if(isNaN(pi)||!customPanels[pi]) return;
        var nm=el.querySelector('.cs-pname'); if(nm) customPanels[pi].name=nm.value;
        var st=el.querySelector('.cs-psort'); if(st) customPanels[pi].sortBy=st.value;
        var lm=el.querySelector('.cs-plimit'); if(lm) customPanels[pi].limit=Math.max(1,Math.min(500,parseInt(lm.value)||50));
      });
    }
    function csFieldChip(pi, key, idx){
      var f=FIELD_BY_KEY[key]; if(!f) return '';
      var col = f.type==='dim' ? '#2563eb' : '#16a34a';
      var bg = f.type==='dim' ? '#eff6ff' : '#ecfdf5';
      return '<div class="cs-chip" draggable="true" data-pi="'+pi+'" data-idx="'+idx+'"'
        +' ondragstart="csChipDragStart(event,'+pi+','+idx+')" ondragover="event.preventDefault()" ondrop="csChipDrop(event,'+pi+','+idx+')"'
        +' style="display:inline-flex;align-items:center;gap:6px;background:'+bg+';border:1px solid '+col+'33;border-radius:6px;padding:6px 9px;margin:0 8px 8px 0;font-size:12px;cursor:grab">'
        +'<span style="color:'+col+';font-weight:700">⋮⋮</span>'
        +'<span style="font-weight:600;color:#1e293b">'+escapeHtml(f.label)+'</span>'
        +'<span style="cursor:pointer;color:#dc2626;font-weight:700" onclick="csRemoveField('+pi+','+idx+')">×</span></div>';
    }
    function csListItem(pi, f){
      if(!f.sup){
        return '<div title="현재 데이터 범위에서 미지원" style="display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;font-size:13px;color:#cbd5e1;cursor:not-allowed">'
          +'<span style="font-size:11px">○</span>'+escapeHtml(f.label)+'<span style="font-size:10px;margin-left:auto;color:#cbd5e1">준비중</span></div>';
      }
      var sel=(customPanels[pi].fields.indexOf(f.key)>=0);
      return '<div class="cs-listitem" draggable="true" ondragstart="csAddDragStart(event,'+pi+",'"+f.key+"'"+')" onclick="csToggleField('+pi+",'"+f.key+"'"+')"'
        +' style="display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;font-size:13px;cursor:pointer;'+(sel?'background:#f1f5f9;color:#94a3b8':'color:#334155')+'">'
        +'<span style="font-size:11px;color:'+(sel?'#16a34a':'#cbd5e1')+'">'+(sel?'✓':'＋')+'</span>'+escapeHtml(f.label)+'</div>';
    }
    function renderPanel(pi){
      var p=customPanels[pi];
      var metricsSel=p.fields.filter(function(k){ return FIELD_BY_KEY[k] && FIELD_BY_KEY[k].type==='metric'; });
      var sortOpts=metricsSel.map(function(k){ return '<option value="'+k+'"'+(p.sortBy===k?' selected':'')+'>'+escapeHtml(FIELD_BY_KEY[k].label)+'</option>'; }).join('');
      if(!sortOpts) sortOpts='<option value="">지표 선택 시</option>';
      // 왼쪽 항목 목록 (카테고리별)
      var listHtml=FIELD_CATS.map(function(cat){
        var items=FIELD_DEFS.filter(function(f){ return f.cat===cat; });
        return '<div style="font-size:10px;color:#94a3b8;font-weight:700;letter-spacing:.04em;margin:8px 0 2px">'+cat+'</div>'
          +items.map(function(f){ return csListItem(pi,f); }).join('');
      }).join('');
      // 오른쪽 선택 칩
      var chips=p.fields.map(function(k,idx){ return csFieldChip(pi,k,idx); }).join('');
      if(!chips) chips='<div style="font-size:12px;color:#cbd5e1;padding:20px;text-align:center">왼쪽에서 항목을 클릭/드래그해 추가하세요</div>';
      return '<div class="cs-panel" data-pi="'+pi+'" style="border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:14px;background:#fff">'
        +'<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">'
          +'<input class="cs-pname" value="'+escapeHtml(p.name||'')+'" placeholder="시트명 (예: 키워드 ROAS 분석)" style="flex:1;min-width:200px;max-width:340px;padding:8px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px">'
          +'<div style="display:flex;align-items:center;gap:10px;font-size:12px;color:#64748b;white-space:nowrap;flex-shrink:0;flex-wrap:wrap">'
            +'<label style="display:inline-flex;align-items:center;gap:5px;white-space:nowrap">정렬 <select class="cs-psort" style="padding:6px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px;min-width:96px">'+sortOpts+'</select></label>'
            +'<label style="display:inline-flex;align-items:center;gap:5px;white-space:nowrap">행수 <input class="cs-plimit" type="number" value="'+(p.limit||50)+'" min="1" max="500" style="width:68px;padding:6px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px"></label>'
            +'<button class="btn btn-outline btn-sm" onclick="removePanel('+pi+')" style="font-size:11px;color:#dc2626;border-color:#fecaca;white-space:nowrap;flex-shrink:0;padding:6px 12px">시트 삭제</button>'
          +'</div>'
        +'</div>'
        +'<div style="display:grid;grid-template-columns:230px 1fr;gap:12px">'
          +'<div style="border:1px solid #eef2f7;border-radius:8px;padding:8px;max-height:340px;overflow:auto">'
            +'<div style="font-size:11px;font-weight:700;color:#475569;margin-bottom:4px">보고서 항목 목록</div>'
            +'<input class="cs-search" oninput="csFilterList(this,'+pi+')" placeholder="항목 검색" style="width:100%;padding:5px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px;margin-bottom:4px">'
            +'<div class="cs-listwrap">'+listHtml+'</div>'
          +'</div>'
          +'<div ondragover="event.preventDefault()" ondrop="csPanelDrop(event,'+pi+')" style="border:1px dashed #cbd5e1;border-radius:8px;padding:10px;min-height:120px;background:#fafbfc">'
            +'<div style="font-size:11px;font-weight:700;color:#475569;margin-bottom:6px">보고서 설정하기 <span style="font-weight:400;color:#94a3b8">(칩을 드래그해 순서 변경)</span></div>'
            +'<div>'+chips+'</div>'
          +'</div>'
        +'</div>'
      +'</div>';
    }
    function renderPanels(){
      var wrap=document.getElementById('rcfg-panels'); if(!wrap) return;
      wrap.innerHTML=customPanels.map(function(p,pi){ return renderPanel(pi); }).join('');
    }
    function csToggleField(pi, key){
      syncPanelsFromDom();
      var arr=customPanels[pi].fields; var i=arr.indexOf(key);
      if(i>=0) arr.splice(i,1);
      else { if(arr.length>=12){ ocaToast('항목은 시트당 최대 12개입니다.',true); return; } arr.push(key); }
      // sortBy가 더 이상 없으면 초기화
      if(customPanels[pi].sortBy && arr.indexOf(customPanels[pi].sortBy)<0) customPanels[pi].sortBy='';
      renderPanels();
    }
    function csRemoveField(pi, idx){ syncPanelsFromDom(); customPanels[pi].fields.splice(idx,1); renderPanels(); }
    function csChipDragStart(e,pi,idx){ csDrag={pi:pi,idx:idx,mode:'reorder'}; e.dataTransfer.effectAllowed='move'; }
    function csAddDragStart(e,pi,key){ csDrag={pi:pi,key:key,mode:'add'}; e.dataTransfer.effectAllowed='copy'; }
    function csChipDrop(e,pi,toIdx){
      e.preventDefault(); e.stopPropagation(); if(!csDrag||csDrag.pi!==pi) { csDrag=null; return; }
      syncPanelsFromDom(); var arr=customPanels[pi].fields;
      if(csDrag.mode==='reorder'){ var item=arr.splice(csDrag.idx,1)[0]; arr.splice(toIdx,0,item); }
      else if(csDrag.mode==='add'){ if(arr.indexOf(csDrag.key)<0 && arr.length<12) arr.splice(toIdx,0,csDrag.key); }
      csDrag=null; renderPanels();
    }
    function csPanelDrop(e,pi){
      e.preventDefault(); if(!csDrag||csDrag.pi!==pi){ csDrag=null; return; }
      syncPanelsFromDom(); var arr=customPanels[pi].fields;
      if(csDrag.mode==='add'){ if(arr.indexOf(csDrag.key)<0 && arr.length<12) arr.push(csDrag.key); }
      else if(csDrag.mode==='reorder'){ var item=arr.splice(csDrag.idx,1)[0]; arr.push(item); }
      csDrag=null; renderPanels();
    }
    function csFilterList(input,pi){
      var q=(input.value||'').toLowerCase();
      var wrap=input.parentElement.querySelector('.cs-listwrap');
      wrap.querySelectorAll('.cs-listitem,[title]').forEach(function(el){
        var t=el.textContent.toLowerCase(); el.style.display=(!q||t.indexOf(q)>=0)?'':'none';
      });
    }
    function addPanel(){ syncPanelsFromDom(); if(customPanels.length>=10){ ocaToast('커스텀 시트는 최대 10개입니다.',true); return; } customPanels.push({name:'',fields:[],sortBy:'',limit:50}); renderPanels(); }
    function removePanel(pi){ syncPanelsFromDom(); customPanels.splice(pi,1); if(!customPanels.length) customPanels.push({name:'',fields:[],sortBy:'',limit:50}); renderPanels(); }
    async function saveReportConfig(){
      if(!reportAccountId){ ocaToast('광고주를 먼저 선택하세요.',true); return; }
      syncPanelsFromDom();
      var sheets={};
      document.querySelectorAll('.rcfg-sheet').forEach(function(c){ sheets[c.dataset.key]=c.checked; });
      var customSheets=customPanels
        .filter(function(p){ return (p.name||'').trim() && p.fields.length; })
        .map(function(p){ return { name:(p.name||'').trim().slice(0,28), fields:p.fields.slice(0,12), sortBy:p.sortBy||'', limit:Math.max(1,Math.min(500,parseInt(p.limit)||50)) }; });
      var btn=document.getElementById('rcfg-save'); btn.disabled=true; var old=btn.textContent; btn.textContent='저장 중...';
      try{
        var r=await fetch('/smart-sa/api/report/save-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId:reportAccountId,sheets:sheets,customSheets:customSheets})});
        var j=await r.json(); if(!j.ok) throw new Error(j.error||'저장 실패');
        ocaToast('리포트 시트 설정이 저장되었습니다.'+(customSheets.length?(' (커스텀 '+customSheets.length+'개)'):''));
      }catch(e){ ocaToast(e.message,true); }
      finally{ btn.disabled=false; btn.textContent=old; }
    }

    // ── 원클릭 계정분석 제안 ──
    function ocaDownload(b64, filename){
      var bin=atob(b64); var len=bin.length; var bytes=new Uint8Array(len);
      for(var i=0;i<len;i++) bytes[i]=bin.charCodeAt(i);
      var blob=new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      var url=URL.createObjectURL(blob);
      var a=document.createElement('a'); a.href=url; a.download=filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function(){ URL.revokeObjectURL(url); },2000);
    }
    function ocaCard(title,color,count,sub){
      return '<div style="flex:1;min-width:150px;background:#fff;border:1px solid #eef2f7;border-left:4px solid '+color+';border-radius:8px;padding:12px">'
        +'<div style="font-size:12px;color:#64748b">'+title+'</div>'
        +'<div style="font-size:24px;font-weight:700;color:'+color+'">'+ocaNum(count)+'<span style="font-size:13px;color:#94a3b8">건</span></div>'
        +'<div style="font-size:11px;color:#94a3b8">'+sub+'</div></div>';
    }
    function ocaListBlock(title,color,items,kind){
      var head='<div style="font-weight:600;font-size:13px;color:'+color+';margin:10px 0 4px">'+title+'</div>';
      if(!items||!items.length) return head+'<div style="font-size:12px;color:#94a3b8;margin-bottom:6px">해당 없음</div>';
      var rows=items.slice(0,5).map(function(it){
        if(kind==='exp'){
          var vol=(it.monthlyTotal!=null)?(' · 월'+ocaNum(it.monthlyTotal)):'';
          return '<tr><td style="padding:3px 8px;font-size:12px">'+escapeHtml(it.keyword)+'</td>'
            +'<td style="padding:3px 8px;font-size:11px;color:#94a3b8">'+escapeHtml(it.source)+vol+'</td>'
            +'<td style="padding:3px 8px;font-size:11px;color:#64748b">'+escapeHtml(it.reason)+'</td></tr>';
        }
        return '<tr><td style="padding:3px 8px;font-size:12px">'+escapeHtml(it.name)+'</td>'
          +'<td style="padding:3px 8px;font-size:11px;text-align:right;white-space:nowrap">ROAS '+ocaNum(it.roas)+'% / '+ocaWon(it.cost)+'</td>'
          +'<td style="padding:3px 8px;font-size:11px;color:'+color+'">'+escapeHtml(it.action)+'</td></tr>';
      }).join('');
      return head+'<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #f1f5f9;border-radius:6px">'+rows+'</table>';
    }
    function renderOcaSummary(s, sug, period){
      s=s||{}; sug=sug||{};
      var html='<div style="font-size:12px;color:#94a3b8;margin-bottom:8px">분석 기간: '+escapeHtml(period||'')+'</div>';
      html+='<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">';
      html+=ocaCard('증액 제안','#16a34a',s.upsellCount||0,'현재비용 '+ocaWon(s.upsellCurrentCost||0));
      html+=ocaCard('감액 제안','#dc2626',s.downsellCount||0,'비효율 '+ocaWon(s.downsellWasteCost||0));
      html+=ocaCard('키워드 발굴','#7c3aed',s.expansionCount||0,'전환검색어 '+(s.expansionConvertingQueries||0)+' · 도구 '+(s.expansionToolIdeas||0));
      html+='</div>';
      html+=ocaListBlock('증액(업셀링) TOP','#16a34a',sug.upsell,'bid');
      html+=ocaListBlock('감액(다운셀링) TOP','#dc2626',sug.downsell,'bid');
      html+=ocaListBlock('키워드 발굴 TOP','#7c3aed',sug.expansion,'exp');
      html+='<div style="font-size:11px;color:#94a3b8;margin-top:8px">📥 전체 리포트 + 제안 시트가 엑셀로 다운로드되었습니다.</div>';
      return html;
    }
    async function runOneClickAnalysis(){
      if(!reportAccountId){ ocaToast('광고주를 먼저 선택하세요.',true); return; }
      var btn=document.getElementById('oca-btn'); var type=document.getElementById('oca-period').value;
      var res=document.getElementById('oca-result');
      btn.disabled=true; var old=btn.textContent; btn.textContent='분석 중...';
      res.innerHTML='<div style="padding:16px;color:#64748b;font-size:13px">⏳ 데이터 수집 + 제안 생성 중입니다. 대용량 계정은 1~3분 걸릴 수 있어요...</div>';
      try{
        var r=await fetch('/smart-sa/api/report/one-click-analysis',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId:reportAccountId,type:type})});
        var j=await r.json(); if(!j.ok) throw new Error(j.error||'분석 실패');
        if(j.excelBase64) ocaDownload(j.excelBase64, j.filename||'계정분석.xlsx');
        res.innerHTML=renderOcaSummary(j.summary, j.suggestions, j.period);
        ocaToast('분석 완료 — 엑셀이 다운로드되었습니다.');
      }catch(e){ res.innerHTML='<div style="padding:12px;color:#dc2626;font-size:13px">오류: '+escapeHtml(e.message)+'</div>'; ocaToast(e.message,true); }
      finally{ btn.disabled=false; btn.textContent=old; }
    }
    if(document.getElementById('rcfg-panels')) renderPanels();

    // ── 자동 발송 스케줄 수정 모달 ──
    function openSchedEdit(kind){
      // kind: 'sa' or 'da'
      var prefix = kind === 'da' ? 'sched_da_' : 'sched_';
      var current = ${JSON.stringify({
        sched_daily_hour: selAccount?.sched_daily_hour ?? 9,
        sched_weekly_hour: selAccount?.sched_weekly_hour ?? 9,
        sched_weekly_dow: selAccount?.sched_weekly_dow ?? 1,
        sched_monthly_hour: selAccount?.sched_monthly_hour ?? 9,
        sched_monthly_day: selAccount?.sched_monthly_day ?? 1,
        sched_da_daily_hour: selAccount?.sched_da_daily_hour ?? 9,
        sched_da_weekly_hour: selAccount?.sched_da_weekly_hour ?? 9,
        sched_da_weekly_dow: selAccount?.sched_da_weekly_dow ?? 1,
        sched_da_monthly_hour: selAccount?.sched_da_monthly_hour ?? 9,
        sched_da_monthly_day: selAccount?.sched_da_monthly_day ?? 1,
      })};
      var existing = document.getElementById('sched-modal');
      if (existing) existing.remove();
      var dowNames = ['일','월','화','수','목','금','토'];
      function hourSelect(id, val){
        var opts = [];
        for (var i=0;i<24;i++) opts.push('<option value="'+i+'"'+(i===val?' selected':'')+'>'+String(i).padStart(2,'0')+':00 KST</option>');
        return '<select id="'+id+'" style="padding:6px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px">'+opts.join('')+'</select>';
      }
      function dowSelect(id, val){
        var opts = dowNames.map(function(n,i){return '<option value="'+i+'"'+(i===val?' selected':'')+'>'+n+'요일</option>';});
        return '<select id="'+id+'" style="padding:6px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px">'+opts.join('')+'</select>';
      }
      function daySelect(id, val){
        var opts = [];
        for (var i=1;i<=31;i++) opts.push('<option value="'+i+'"'+(i===val?' selected':'')+'>'+i+'일</option>');
        return '<select id="'+id+'" style="padding:6px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px">'+opts.join('')+'</select>';
      }
      var label = kind === 'da' ? 'DA' : 'SA';
      var color = kind === 'da' ? '#9f1239' : '#6366f1';
      var modal = document.createElement('div');
      modal.id = 'sched-modal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:99999;display:flex;align-items:center;justify-content:center';
      modal.innerHTML = '<div style="background:#fff;width:520px;max-width:92vw;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.2);overflow:hidden">'
        + '<div style="padding:18px 22px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center"><div style="font-size:16px;font-weight:700">⏰ '+label+' 자동 발송 스케줄 수정</div><button id="sched-close" style="background:none;border:none;font-size:22px;cursor:pointer;color:#64748b">×</button></div>'
        + '<div style="padding:20px 22px"><p style="color:#64748b;font-size:12px;margin:0 0 16px">계정별 발송 시각을 자유롭게 설정. KST 기준. (정시 단위 매시 정각/30분에 자동 호출)</p>'
        + '<div style="display:grid;grid-template-columns:80px 1fr;gap:12px;align-items:center;font-size:13px">'
        + '<label>일간</label><div style="display:flex;gap:8px;align-items:center">매일 ' + hourSelect('sed-d-hour', current[prefix+'daily_hour']) + '</div>'
        + '<label>주간</label><div style="display:flex;gap:8px;align-items:center">매주 ' + dowSelect('sed-w-dow', current[prefix+'weekly_dow']) + ' ' + hourSelect('sed-w-hour', current[prefix+'weekly_hour']) + '</div>'
        + '<label>월간</label><div style="display:flex;gap:8px;align-items:center">매월 ' + daySelect('sed-m-day', current[prefix+'monthly_day']) + ' ' + hourSelect('sed-m-hour', current[prefix+'monthly_hour']) + '</div>'
        + '</div></div>'
        + '<div style="padding:14px 22px;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:8px;background:#f8fafc">'
        + '<button id="sched-cancel" class="btn btn-outline">취소</button>'
        + '<button id="sched-save" class="btn btn-primary" style="background:'+color+'">저장</button>'
        + '</div></div>';
      document.body.appendChild(modal);
      document.getElementById('sched-close').onclick = function(){ modal.remove(); };
      document.getElementById('sched-cancel').onclick = function(){ modal.remove(); };
      modal.addEventListener('click', function(e){ if (e.target===modal) modal.remove(); });
      document.getElementById('sched-save').onclick = async function(){
        var payload = {
          accountId: reportAccountId, kind: kind,
          daily_hour: parseInt(document.getElementById('sed-d-hour').value),
          weekly_hour: parseInt(document.getElementById('sed-w-hour').value),
          weekly_dow: parseInt(document.getElementById('sed-w-dow').value),
          monthly_hour: parseInt(document.getElementById('sed-m-hour').value),
          monthly_day: parseInt(document.getElementById('sed-m-day').value),
        };
        try {
          var res = await fetch('/smart-sa/api/report/save-schedule', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)});
          var json = await res.json();
          if (!json.ok) throw new Error(json.error);
          toast(label + ' 스케줄 저장됨');
          setTimeout(function(){ location.reload(); }, 800);
        } catch(e){ toast(e.message, true); }
      };
    }

    // ── 맞춤 기간 리포트 모달 ──
    function openCustomReportModal(kind){
      // kind: 'sa' or 'da'
      var existing = document.getElementById('custom-report-modal');
      if (existing) existing.remove();
      var pad=function(n){return (n<10?'0':'')+n;};
      var fmt=function(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());};
      var mdot=function(d){return (d.getMonth()+1)+'.'+d.getDate();};
      var today=new Date(); var endDef=new Date(today); endDef.setDate(today.getDate()-1); var startDef=new Date(today); startDef.setDate(today.getDate()-30);
      // 월간 옵션(최근 12개월)
      var monthOpts=''; for(var i=0;i<12;i++){ var mm=new Date(today.getFullYear(), today.getMonth()-i, 1); monthOpts+='<option value="'+mm.getFullYear()+'-'+pad(mm.getMonth()+1)+'">'+mm.getFullYear()+'년 '+(mm.getMonth()+1)+'월</option>'; }
      // 주간 옵션(최근 12주, 월요일 시작)
      var dow=today.getDay(); var thisMon=new Date(today); thisMon.setDate(today.getDate()-((dow+6)%7));
      var weekOpts=''; for(var j=1;j<=12;j++){ var wm=new Date(thisMon); wm.setDate(thisMon.getDate()-7*j); var ws=new Date(wm); var we=new Date(wm); we.setDate(wm.getDate()+6); weekOpts+='<option value="'+fmt(wm)+'">'+mdot(ws)+'주 ('+mdot(ws)+'~'+mdot(we)+')</option>'; }
      var modal = document.createElement('div');
      modal.id = 'custom-report-modal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:99999;display:flex;align-items:center;justify-content:center';
      var title = (kind==='da' ? 'DA' : 'SA') + ' 기간 리포트';
      var color = kind==='da' ? '#9f1239' : '#6366f1';
      var inp='width:100%;padding:9px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px';
      var lbl='font-size:12px;color:#475569;font-weight:600;display:block;margin-bottom:5px';
      function tabBtn(id,txt){ return '<button id="'+id+'" class="cr-tab" style="flex:1;padding:8px;border:none;background:transparent;font-size:13px;font-weight:600;color:#64748b;cursor:pointer;border-radius:7px">'+txt+'</button>'; }
      modal.innerHTML = '<div style="background:#fff;width:500px;max-width:92vw;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,0.22);overflow:hidden">'
        + '<div style="padding:18px 22px;border-bottom:1px solid #f1f5f9;display:flex;justify-content:space-between;align-items:center"><div style="font-size:16px;font-weight:700">'+title+'</div><button id="cr-close" style="background:none;border:none;font-size:22px;cursor:pointer;color:#94a3b8">×</button></div>'
        + '<div style="padding:20px 22px">'
        + '<div style="display:flex;gap:3px;background:#f5f6fa;border-radius:9px;padding:4px;margin-bottom:16px">'+tabBtn('cr-tab-month','월간')+tabBtn('cr-tab-week','주간')+tabBtn('cr-tab-custom','맞춤 기간')+'</div>'
        + '<div id="cr-panel-month"><label style="'+lbl+'">대상 월</label><select id="cr-month" style="'+inp+'">'+monthOpts+'</select></div>'
        + '<div id="cr-panel-week" style="display:none"><label style="'+lbl+'">대상 주 (월~일)</label><select id="cr-week" style="'+inp+'">'+weekOpts+'</select></div>'
        + '<div id="cr-panel-custom" style="display:none;grid-template-columns:1fr 1fr;gap:12px">'
        + '<div><label style="'+lbl+'">시작일</label><input type="date" id="cr-start" value="'+fmt(startDef)+'" style="'+inp+'"></div>'
        + '<div><label style="'+lbl+'">종료일</label><input type="date" id="cr-end" value="'+fmt(endDef)+'" style="'+inp+'"></div>'
        + '</div>'
        + '<div id="cr-note" style="font-size:12px;color:#64748b;background:#f8fafc;border:1px solid #eef2f7;border-radius:8px;padding:10px 12px;margin:14px 0"></div>'
        + '<div style="display:flex;gap:8px">'
        + '<button id="cr-excel" class="btn btn-outline" style="flex:1">📥 엑셀 다운로드</button>'
        + '<button id="cr-send" class="btn btn-primary" style="flex:1;background:'+color+';border-color:'+color+'">📧 이메일 발송</button>'
        + '</div></div></div>';
      document.body.appendChild(modal);
      var crMode='month';
      function compute(){
        if(crMode==='month'){ var v=document.getElementById('cr-month').value.split('-'); var y=+v[0],m=+v[1]-1;
          return {s:fmt(new Date(y,m,1)),e:fmt(new Date(y,m+1,0)),cs:fmt(new Date(y,m-1,1)),ce:fmt(new Date(y,m,0)),clabel:'전월'}; }
        if(crMode==='week'){ var mon=new Date(document.getElementById('cr-week').value+'T00:00:00'); var e=new Date(mon); e.setDate(mon.getDate()+6); var ps=new Date(mon); ps.setDate(mon.getDate()-7); var pe=new Date(mon); pe.setDate(mon.getDate()-1);
          return {s:fmt(mon),e:fmt(e),cs:fmt(ps),ce:fmt(pe),clabel:'전주'}; }
        var s=document.getElementById('cr-start').value,e2=document.getElementById('cr-end').value;
        if(!s||!e2||s>e2) return null;
        return {s:s,e:e2,cs:'',ce:'',clabel:'동일길이 직전기간'};
      }
      function updateNote(){ var c=compute(); var n=document.getElementById('cr-note');
        if(!c){ n.innerHTML='기간을 선택하세요.'; return; }
        var cmp = c.cs ? (c.cs.replace(/-/g,'.')+'~'+c.ce.replace(/-/g,'.')) : '(자동 계산)';
        n.innerHTML='분석: <b>'+c.s.replace(/-/g,'.')+'~'+c.e.replace(/-/g,'.')+'</b> &nbsp;·&nbsp; 비교('+c.clabel+'): <b>'+cmp+'</b>'; }
      function setMode(m){ crMode=m;
        document.getElementById('cr-panel-month').style.display=(m==='month'?'block':'none');
        document.getElementById('cr-panel-week').style.display=(m==='week'?'block':'none');
        document.getElementById('cr-panel-custom').style.display=(m==='custom'?'grid':'none');
        ['month','week','custom'].forEach(function(x){ var b=document.getElementById('cr-tab-'+x); var on=(x===m); b.style.background=on?'#fff':'transparent'; b.style.color=on?'#111827':'#64748b'; b.style.boxShadow=on?'0 1px 3px rgba(0,0,0,.08)':'none'; });
        updateNote();
      }
      document.getElementById('cr-tab-month').onclick=function(){setMode('month');};
      document.getElementById('cr-tab-week').onclick=function(){setMode('week');};
      document.getElementById('cr-tab-custom').onclick=function(){setMode('custom');};
      ['cr-month','cr-week','cr-start','cr-end'].forEach(function(id){ var el=document.getElementById(id); if(el) el.onchange=updateNote; });
      document.getElementById('cr-close').onclick = function(){ modal.remove(); };
      modal.addEventListener('click', function(e){ if (e.target===modal) modal.remove(); });
      setMode('month');
      function go(send){ var c=compute(); if(!c){ toast('기간을 올바르게 선택해주세요.',true); return; } modal.remove();
        if(kind==='da'){ if(send) triggerDaReportCustom(c.s,c.e); else downloadDaReportCustom(c.s,c.e); }
        else { if(send) triggerSaReportCustom(c.s,c.e,c.cs,c.ce); else downloadSaReportCustom(c.s,c.e,c.cs,c.ce); } }
      document.getElementById('cr-excel').onclick=function(){ go(false); };
      document.getElementById('cr-send').onclick=function(){ go(true); };
    }

    async function downloadSaReportCustom(s, e, cs, ce){
      showReportOverlay('기간 SA 리포트 엑셀 생성 중...');
      try {
        var url='/smart-sa/api/report/download-excel?type=monthly&accountId='+reportAccountId+'&startDate='+s+'&endDate='+e+'&custom=1';
        if(cs&&ce) url+='&compareStart='+cs+'&compareEnd='+ce;
        const res = await fetch(url);
        if (!res.ok) throw new Error(await res.text() || '서버 오류');
        const blob = await res.blob(); triggerDownload(blob, res, 'SA_리포트.xlsx');
        toast('SA 리포트 다운로드 시작');
      } catch(err){ toast(err.message, true); } finally { hideReportOverlay(); }
    }
    async function triggerSaReportCustom(s, e, cs, ce){
      showReportOverlay('기간 SA 리포트 생성 + 발송 중...');
      try {
        var body={type:'monthly', accountId:reportAccountId, startDate:s, endDate:e, custom:true};
        if(cs&&ce){ body.compareStart=cs; body.compareEnd=ce; }
        const res = await fetch('/smart-sa/api/report/trigger', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
        const t = await res.text(); let json; try{json=JSON.parse(t);}catch(_){throw new Error('서버 응답 오류');}
        if (!json.ok) throw new Error(json.error);
        toast(json.message || 'SA 리포트 발송 완료!');
      } catch(err){ toast(err.message, true); } finally { hideReportOverlay(); }
    }
    async function downloadDaReportCustom(s, e){
      showReportOverlay('맞춤 DA 리포트 엑셀 생성 중...', '#9f1239');
      try {
        const res = await fetch('/smart-sa/api/da-report/download-excel?type=monthly&accountId='+reportAccountId+'&startDate='+s+'&endDate='+e+'&custom=1');
        if (!res.ok) throw new Error(await res.text() || '서버 오류');
        const blob = await res.blob(); triggerDownload(blob, res, '맞춤_DA_리포트.xlsx');
        toast('DA 맞춤 리포트 다운로드 시작');
      } catch(err){ toast(err.message, true); } finally { hideReportOverlay(); }
    }
    async function triggerDaReportCustom(s, e){
      showReportOverlay('맞춤 DA 리포트 생성 + 발송 중...', '#9f1239');
      try {
        const res = await fetch('/smart-sa/api/da-report/trigger', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({type:'monthly', accountId:reportAccountId, startDate:s, endDate:e, custom:true})});
        const t = await res.text(); let json; try{json=JSON.parse(t);}catch(_){throw new Error('서버 응답 오류');}
        if (!json.ok) throw new Error(json.error);
        toast(json.message || 'DA 맞춤 리포트 발송 완료!');
      } catch(err){ toast(err.message, true); } finally { hideReportOverlay(); }
    }
    function triggerDownload(blob, res, fallback){
      const cd = res.headers.get('Content-Disposition') || '';
      let fname = fallback;
      var m = cd.match(/filename\\*=UTF-8''([^;]+)/i) || cd.match(/filename="([^"]+)"/);
      if (m) { try { fname = decodeURIComponent(m[1]); } catch(_){} }
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = fname; document.body.appendChild(a); a.click();
      setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    }
    function showReportOverlay(msg, color){
      color = color || '#6366f1';
      let overlay = document.getElementById('report-loading-overlay');
      if (!overlay) {
        overlay = document.createElement('div'); overlay.id='report-loading-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99999;display:flex;align-items:center;justify-content:center';
        document.body.appendChild(overlay);
        if (!document.getElementById('spin-style')) { const s=document.createElement('style'); s.id='spin-style'; s.textContent='@keyframes spin{to{transform:rotate(360deg)}}'; document.head.appendChild(s); }
      }
      overlay.innerHTML = '<div style="background:#fff;border-radius:16px;padding:40px 48px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3);max-width:400px"><div style="width:48px;height:48px;border:4px solid #e2e8f0;border-top-color:'+color+';border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 20px"></div><div style="font-size:16px;font-weight:600;color:#1e293b;margin-bottom:8px">'+msg+'</div><div style="font-size:13px;color:#94a3b8">최대 4분 소요될 수 있습니다.</div></div>';
      overlay.style.display='flex';
    }
    function hideReportOverlay(){ var o=document.getElementById('report-loading-overlay'); if(o) o.style.display='none'; }

    // ── DA 리포트 핸들러 ──
    async function toggleDaReportFeat(feat, enabled) {
      const label = document.getElementById('label-'+feat);
      try {
        const res = await fetch('/smart-sa/api/da-report/toggle-feat', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({accountId: reportAccountId, feat, enabled})
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        label.textContent = enabled ? 'ON' : 'OFF';
        label.style.color = enabled ? '#16a34a' : '#94a3b8';
        if (enabled && json.addedEmail) {
          toast('DA 자동 발송 활성화 (수신자 추가: ' + json.addedEmail + ')');
          setTimeout(() => location.reload(), 1200);
        } else {
          toast('DA ' + (enabled ? '자동 발송 활성화' : '자동 발송 비활성화'));
        }
      } catch(e) { toast(e.message, true); }
    }

    async function downloadDaReportExcel(type) {
      if (!reportAccountId) return toast('광고주를 선택해주세요.', true);
      const btn = document.getElementById('da-excel-btn-'+type);
      const orig = btn ? btn.innerHTML : '';
      const typeLabel = {daily:'일간', weekly:'주간', monthly:'월간'}[type] || type;
      let overlay = document.getElementById('report-loading-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'report-loading-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99999;display:flex;align-items:center;justify-content:center';
        document.body.appendChild(overlay);
        if (!document.getElementById('spin-style')) {
          const style = document.createElement('style');
          style.id = 'spin-style';
          style.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
          document.head.appendChild(style);
        }
      }
      overlay.innerHTML = '<div style="background:#fff;border-radius:16px;padding:40px 48px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3);max-width:400px"><div style="width:48px;height:48px;border:4px solid #e2e8f0;border-top-color:#9f1239;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 20px"></div><div style="font-size:16px;font-weight:600;color:#1e293b;margin-bottom:8px">DA '+typeLabel+' 엑셀 생성 중...</div><div style="font-size:13px;color:#94a3b8">'+(type==='monthly'?'월간은 최대 4분':'최대 1~2분')+' 소요될 수 있습니다.</div></div>';
      overlay.style.display = 'flex';
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 생성 중...'; }
      try {
        const res = await fetch('/smart-sa/api/da-report/download-excel?type='+type+'&accountId='+reportAccountId);
        if (!res.ok) { const t = await res.text(); throw new Error(t || '서버 오류'); }
        const blob = await res.blob();
        const cd = res.headers.get('Content-Disposition') || '';
        let fname = 'DA_'+typeLabel+'_리포트.xlsx';
        var m = cd.match(/filename\\*=UTF-8''([^;]+)/i) || cd.match(/filename="([^"]+)"/);
        if (m) { try { fname = decodeURIComponent(m[1]); } catch(_){} }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = fname;
        document.body.appendChild(a); a.click();
        setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
        toast('DA ' + typeLabel + ' 엑셀 다운로드 시작: ' + fname);
      } catch(e) { toast(e.message || 'DA 엑셀 생성 실패', true); }
      finally { overlay.style.display = 'none'; if (btn) { btn.disabled = false; btn.innerHTML = orig; } }
    }

    async function triggerDaReport(type) {
      if (!reportAccountId) return toast('광고주를 선택해주세요.', true);
      let overlay = document.getElementById('report-loading-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'report-loading-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99999;display:flex;align-items:center;justify-content:center';
        overlay.innerHTML = '<div style="background:#fff;border-radius:16px;padding:40px 48px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3)"><div style="width:48px;height:48px;border:4px solid #e2e8f0;border-top-color:#9f1239;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 20px"></div><div style="font-size:16px;font-weight:600;color:#1e293b;margin-bottom:8px">DA 리포트 생성 중...</div><div style="font-size:13px;color:#94a3b8">엑셀 + 이메일 발송. 최대 1~4분 소요.</div></div>';
        document.body.appendChild(overlay);
        if (!document.getElementById('spin-style')) {
          const style = document.createElement('style');
          style.id = 'spin-style';
          style.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
          document.head.appendChild(style);
        }
      }
      overlay.style.display = 'flex';
      try {
        const res = await fetch('/smart-sa/api/da-report/trigger', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({type, accountId: reportAccountId})
        });
        const text = await res.text();
        let json; try { json = JSON.parse(text); } catch(_) { overlay.style.display='none'; throw new Error('서버 응답 오류'); }
        overlay.style.display = 'none';
        if (!json.ok) throw new Error(json.error);
        toast(json.message || 'DA 리포트 발송 완료!');
      } catch(e) { overlay.style.display='none'; toast(e.message, true); }
    }

    async function toggleReportFeat(feat, enabled) {
      const label = document.getElementById('label-'+feat);
      try {
        const res = await fetch('/smart-sa/api/report/toggle-feat', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({accountId: reportAccountId, feat, enabled})
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        label.textContent = enabled ? 'ON' : 'OFF';
        label.style.color = enabled ? '#16a34a' : '#94a3b8';
        if (enabled && json.addedEmail) {
          toast('자동 발송 활성화 (수신자 추가: ' + json.addedEmail + ')');
          // 수신자 목록 UI도 즉시 갱신: 1초 후 페이지 새로고침으로 반영
          setTimeout(() => location.reload(), 1200);
        } else {
          toast(enabled ? '자동 발송 활성화' : '자동 발송 비활성화');
        }
      } catch(e) { toast(e.message, true); }
    }

    async function triggerReport(type) {
      if (!reportAccountId) return toast('광고주를 선택해주세요.', true);
      // 로딩 오버레이 표시
      let overlay = document.getElementById('report-loading-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'report-loading-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99999;display:flex;align-items:center;justify-content:center';
        overlay.innerHTML = '<div style="background:#fff;border-radius:16px;padding:40px 48px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3)"><div style="width:48px;height:48px;border:4px solid #e2e8f0;border-top-color:#6366f1;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 20px"></div><div style="font-size:16px;font-weight:600;color:#1e293b;margin-bottom:8px">리포트 생성 중...</div><div style="font-size:13px;color:#94a3b8">엑셀 파일 생성 및 이메일 발송 중입니다.<br>최대 1~2분 소요될 수 있습니다.</div></div>';
        document.body.appendChild(overlay);
        if (!document.getElementById('spin-style')) {
          const style = document.createElement('style');
          style.id = 'spin-style';
          style.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
          document.head.appendChild(style);
        }
      }
      overlay.style.display = 'flex';
      try {
        const res = await fetch('/smart-sa/api/report/trigger', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({type, accountId: reportAccountId})
        });
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch(_) {
          overlay.style.display = 'none';
          throw new Error('서버 응답 오류 (데이터가 너무 크거나 시간 초과). 잠시 후 다시 시도해주세요.');
        }
        overlay.style.display = 'none';
        if (!json.ok) throw new Error(json.error);
        toast(json.message || '리포트 발송 완료!');
      } catch(e) { overlay.style.display = 'none'; toast(e.message, true); }
    }

    async function downloadReportExcel(type) {
      if (!reportAccountId) return toast('광고주를 선택해주세요.', true);
      const btn = document.getElementById('excel-btn-'+type);
      const orig = btn ? btn.innerHTML : '';
      const typeLabel = {daily:'일간', weekly:'주간', monthly:'월간'}[type] || type;
      // 로딩 오버레이
      let overlay = document.getElementById('report-loading-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'report-loading-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99999;display:flex;align-items:center;justify-content:center';
        document.body.appendChild(overlay);
        if (!document.getElementById('spin-style')) {
          const style = document.createElement('style');
          style.id = 'spin-style';
          style.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
          document.head.appendChild(style);
        }
      }
      overlay.innerHTML = '<div style="background:#fff;border-radius:16px;padding:40px 48px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3);max-width:400px"><div style="width:48px;height:48px;border:4px solid #e2e8f0;border-top-color:#6366f1;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 20px"></div><div style="font-size:16px;font-weight:600;color:#1e293b;margin-bottom:8px">'+typeLabel+' 엑셀 리포트 생성 중...</div><div style="font-size:13px;color:#94a3b8">데이터 수집 + 엑셀 생성<br>'+(type==='monthly'?'월간은 최대 4분':'최대 1~2분')+' 소요될 수 있습니다.</div></div>';
      overlay.style.display = 'flex';
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 생성 중...'; }
      try {
        const res = await fetch('/smart-sa/api/report/download-excel?type='+type+'&accountId='+reportAccountId);
        if (!res.ok) {
          const t = await res.text();
          throw new Error(t || '서버 오류');
        }
        const blob = await res.blob();
        // 파일명 추출 (Content-Disposition)
        const cd = res.headers.get('Content-Disposition') || '';
        let fname = typeLabel + '_리포트.xlsx';
        var m = cd.match(/filename\\*=UTF-8''([^;]+)/i) || cd.match(/filename="([^"]+)"/);
        if (m) { try { fname = decodeURIComponent(m[1]); } catch(_){} }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = fname;
        document.body.appendChild(a); a.click();
        setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
        toast(typeLabel + ' 엑셀 다운로드 시작: ' + fname);
      } catch(e) {
        toast(e.message || '엑셀 생성 실패', true);
      } finally {
        overlay.style.display = 'none';
        if (btn) { btn.disabled = false; btn.innerHTML = orig; }
      }
    }

    function toggleEditEmails() {
      const disp = document.getElementById('emails-display');
      const edit = document.getElementById('emails-edit');
      const btn = document.getElementById('btn-edit-emails');
      if (edit.style.display === 'none') {
        edit.style.display = 'block'; disp.style.display = 'none'; btn.style.display = 'none';
      } else {
        edit.style.display = 'none'; disp.style.display = 'block'; btn.style.display = '';
      }
    }

    async function saveEmails() {
      const val = document.getElementById('emails-input').value.trim();
      try {
        const res = await fetch('/smart-sa/api/report/update-emails', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({accountId: reportAccountId, emails: val})
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        const emails = val.split(',').map(e => e.trim()).filter(Boolean);
        document.getElementById('emails-text').innerHTML = emails.length
          ? emails.map(e => '<span class="badge badge-blue" style="margin-right:6px;margin-bottom:4px;padding:4px 12px">'+e+'</span>').join('')
          : '<span style="color:#94a3b8">수신 이메일이 설정되지 않았습니다.</span>';
        toggleEditEmails();
        toast('수신 이메일이 저장되었습니다.');
      } catch(e) { toast(e.message, true); }
    }
    </script>
  `;
  res.send(appLayout('리포트', content, user, 'reports', await getLayoutOpts(req)));
});

// API: 리포트 엑셀 다운로드 (이메일 첨부와 동일한 파일)
router.get('/api/report/download-excel', requireLogin, async (req, res) => {
  const { type = 'daily', accountId } = req.query;
  try {
    if (!['daily', 'weekly', 'monthly'].includes(type)) return res.status(400).send('잘못된 타입');
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).send('광고주 없음');

    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.status(400).send('API 계정 미등록');

    const enriched = { ...account, api_key: creds.api_key, secret_key: creds.secret_key };
    const { generateExcelBuffer } = require('../report/generator');
    const customRange = (req.query.custom && req.query.startDate && req.query.endDate) ? { since: req.query.startDate, until: req.query.endDate } : null;
    const comparePeriod = (req.query.compareStart && req.query.compareEnd) ? { since: req.query.compareStart, until: req.query.compareEnd } : null;
    const { buffer } = await generateExcelBuffer(enriched, type, customRange, { comparePeriod });

    const typeLabel = { daily: '일간', weekly: '주간', monthly: '월간' }[type];
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const safeName = (account.name || 'account').replace(/[\\/:*?"<>|]/g, '_');
    const filename = `${safeName}_${typeLabel}_리포트_${dateStr}.xlsx`;

    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // RFC 5987: UTF-8 한글 파일명 안전 인코딩
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error(`❌ 엑셀 다운로드 오류 [${type}]:`, err.message);
    const typeLabel = { daily: '일간', weekly: '주간', monthly: '월간' }[type] || type;
    const isTimeout = /시간 초과|timeout/i.test(err.message);
    const tip = isTimeout
      ? `${typeLabel} 리포트는 데이터 양이 많아 생성에 시간이 오래 걸립니다. 잠시 후 다시 시도하시거나, "이메일 발송"으로 백그라운드 생성 후 받아보세요.`
      : '잠시 후 다시 시도해주세요.';
    res.status(500).set('Content-Type', 'text/plain; charset=utf-8').send(`엑셀 생성 오류: ${err.message}\n\n${tip}`);
  }
});

// API: 리포트 미리보기 (HTML 직접 반환)
router.get('/api/report/preview', requireLogin, async (req, res) => {
  const { type = 'daily', accountId } = req.query;
  try {
    if (!['daily', 'weekly', 'monthly'].includes(type)) return res.status(400).send('잘못된 타입');
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).send('광고주 없음');

    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.status(400).send('API 계정 미등록');

    const enriched = { ...account, api_key: creds.api_key, secret_key: creds.secret_key };
    const { generatePreview } = require('../report/generator');

    res.set('Content-Type', 'text/html; charset=utf-8');
    const html = await generatePreview(enriched, type);
    res.send(html);
  } catch (err) {
    console.error(`❌ 미리보기 오류 [${type}]:`, err.message);
    const typeLabel = { daily: '일간', weekly: '주간', monthly: '월간' }[type] || type;
    const isTimeout = /시간 초과|timeout/i.test(err.message);
    const tip = isTimeout
      ? `<p style="color:#64748b;line-height:1.6">${typeLabel} 리포트는 데이터 양이 많아 생성에 시간이 오래 걸립니다.<br>잠시 후 다시 시도하시거나, <strong>"리포트 발송"</strong> 버튼으로 백그라운드 생성 후 이메일로 받아보세요.</p>`
      : '<p style="color:#64748b">잠시 후 다시 시도해주세요.</p>';
    res.status(500).send(`
      <html><head><meta charset="utf-8"><title>리포트 오류</title></head>
      <body style="font-family:system-ui;padding:40px;max-width:680px;margin:0 auto">
        <h2 style="color:#dc2626">⚠️ ${typeLabel} 리포트 생성 오류</h2>
        ${tip}
        <details style="margin-top:24px"><summary style="cursor:pointer;color:#94a3b8;font-size:13px">상세 오류</summary>
        <pre style="background:#f1f5f9;padding:12px;border-radius:8px;font-size:12px;white-space:pre-wrap">${err.message}</pre>
        </details>
      </body></html>
    `);
  }
});

// 리포트 자동발송 ON/OFF 토글
router.post('/api/report/toggle-feat', requireLogin, async (req, res) => {
  try {
    const { accountId, feat, enabled } = req.body;
    const validFeats = ['feat_daily_report','feat_weekly_report','feat_monthly_report'];
    if (!validFeats.includes(feat)) return res.status(400).json({ ok: false, error: '잘못된 기능' });
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });

    // 1) 기능 토글 업데이트
    await db.pool.query(`UPDATE ad_accounts SET ${feat} = $1 WHERE id = $2 AND user_id = $3`,
      [enabled ? 1 : 0, accountId, req.session.userId]);

    // 2) 기능을 켤 때: 광고담당자(현재 유저)의 다우오피스 이메일을 수신자에 자동 추가
    let addedEmail = null;
    if (enabled) {
      try {
        const smtp = await db.getSmtpCredentials(req.session.userId);
        const daouEmail = (smtp?.daou_email || '').trim().toLowerCase();
        if (daouEmail) {
          const current = (account.report_emails || '').split(',').map(e => e.trim()).filter(Boolean);
          const currentLower = current.map(e => e.toLowerCase());
          if (!currentLower.includes(daouEmail)) {
            const merged = [...current, smtp.daou_email.trim()].join(',');
            await db.pool.query('UPDATE ad_accounts SET report_emails = $1 WHERE id = $2 AND user_id = $3',
              [merged, accountId, req.session.userId]);
            addedEmail = smtp.daou_email.trim();
          }
        }
      } catch (e) {
        console.warn('자동 이메일 추가 실패:', e.message);
      }
    }
    res.json({ ok: true, addedEmail });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/api/report/update-emails', requireLogin, async (req, res) => {
  try {
    const { accountId, emails } = req.body;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    await db.pool.query('UPDATE ad_accounts SET report_emails = $1 WHERE id = $2 AND user_id = $3',
      [emails || '', accountId, req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/api/report/trigger', requireLogin, async (req, res) => {
  const { type, accountId, custom, startDate, endDate, compareStart, compareEnd } = req.body;
  if (!['daily','weekly','monthly'].includes(type)) return res.status(400).json({ ok:false, error:'잘못된 타입' });
  const customRange = (custom && startDate && endDate) ? { since: startDate, until: endDate } : null;
  const comparePeriod = (compareStart && compareEnd) ? { since: compareStart, until: compareEnd } : null;
  const account = await db.getAccountById(accountId, req.session.userId);
  if (!account) return res.status(404).json({ ok:false, error:'광고주 없음' });

  const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
  if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });

  // account에 API 자격증명 + SMTP 자격증명 병합
  const smtp = await db.getSmtpCredentials(req.session.userId);
  console.log(`📧 SMTP 조회: daou_email=${smtp?.daou_email || '없음'}, smtp_pass=${smtp?.smtp_pass ? '설정됨(' + smtp.smtp_pass.length + '자)' : '없음'}, username=${smtp?.username || '없음'}`);

  const emailUser = smtp?.daou_email || smtp?.username || '';
  const emailPass = smtp?.smtp_pass || '';

  if (!emailUser || !emailPass) {
    return res.json({ ok: false, error: `SMTP 미설정: 이메일=${emailUser || '없음'}, 비밀번호=${emailPass ? '설정됨' : '없음'}. 내 정보에서 다우오피스 계정을 설정해주세요.` });
  }

  const enriched = {
    ...account,
    api_key: creds.api_key, secret_key: creds.secret_key,
    // SMTP: 다우오피스 자동 연동
    email_host: smtp?.smtp_host || 'outbound.daouoffice.com',
    email_port: 465,
    email_user: emailUser,
    email_pass: emailPass,
  };
  try {
    // 월간 수동 트리거: 데이터가 너무 많으면 prev 스킵 (단, 맞춤 기간은 비교 데이터 필수이므로 항상 prev 가져옴)
    const skipPrev = customRange ? false : (req.body.skipPrev === true || (type === 'monthly' && !customRange));
    const ok = await generateAndSend(enriched, type, customRange, { skipPrev, comparePeriod });
    if (ok && !customRange) {
      await db.pool.query(`UPDATE ad_accounts SET last_${type}_report = CURRENT_TIMESTAMP WHERE id = $1`, [accountId]).catch(console.error);
      res.json({ ok: true, message: '리포트 발송 완료!' });
    } else if (ok) {
      res.json({ ok: true, message: '맞춤 리포트 발송 완료!' });
    } else {
      res.json({ ok: false, error: '리포트 생성 또는 이메일 발송에 실패했습니다. Vercel 로그를 확인해주세요.' });
    }
  } catch (err) {
    console.error('리포트 발송 오류:', err);
    res.json({ ok: false, error: `발송 실패: ${err.message}` });
  }
});

// 자동 발송 스케줄 저장 (계정별, SA/DA)
router.post('/api/report/save-schedule', requireLogin, async (req, res) => {
  try {
    const { accountId, kind, daily_hour, weekly_hour, weekly_dow, monthly_hour, monthly_day } = req.body;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    const valHour = h => Math.max(0, Math.min(23, parseInt(h) || 0));
    const valDow = d => Math.max(0, Math.min(6, parseInt(d) || 0));
    const valDay = d => Math.max(1, Math.min(31, parseInt(d) || 1));
    const prefix = kind === 'da' ? 'sched_da_' : 'sched_';
    await db.pool.query(`UPDATE ad_accounts SET
      ${prefix}daily_hour = $1,
      ${prefix}weekly_hour = $2,
      ${prefix}weekly_dow = $3,
      ${prefix}monthly_hour = $4,
      ${prefix}monthly_day = $5
      WHERE id = $6 AND user_id = $7`,
      [valHour(daily_hour), valHour(weekly_hour), valDow(weekly_dow), valHour(monthly_hour), valDay(monthly_day), accountId, req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── 리포트 커스터마이징 설정 저장 (시트 on/off + 커스텀 시트) ──────────
router.post('/api/report/save-config', requireLogin, async (req, res) => {
  try {
    const { accountId, sheets, customSheets } = req.body;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });

    // 검증/정제
    const allowedSheets = ['summary', 'comparison', 'typeDevice', 'adgroup', 'keyword', 'hourly', 'daily'];
    const cleanSheets = {};
    for (const k of allowedSheets) {
      if (sheets && typeof sheets[k] === 'boolean') cleanSheets[k] = sheets[k];
    }
    const allowedDims = ['byCampaign','byCampaignType','byAdgroup','byKeyword','byQuery','byDevice','byHour','byDate'];
    const allowedMetrics = ['cost','imp','clk','cpc','ctr','purchaseCnt','purchaseAmt','roas'];
    const allowedFields = new Set([...allowedDims, ...allowedMetrics]);
    const cleanCustom = (Array.isArray(customSheets) ? customSheets : []).slice(0, 10).map(cs => {
      // 신규: fields[] (차원/지표 혼합 순서), 레거시: {dimension, metrics}
      let fields = Array.isArray(cs.fields) ? cs.fields.filter(f => allowedFields.has(f)) : [];
      if (!fields.length && cs.dimension) {
        fields = [cs.dimension, ...(Array.isArray(cs.metrics) ? cs.metrics : [])].filter(f => allowedFields.has(f));
      }
      fields = fields.slice(0, 12);
      return {
        name: String(cs.name || '맞춤').slice(0, 28),
        fields,
        sortBy: allowedMetrics.includes(cs.sortBy) ? cs.sortBy : '',
        limit: Math.max(1, Math.min(500, parseInt(cs.limit) || 50)),
      };
    }).filter(cs => cs.name && cs.fields.length);

    await db.saveReportConfig(accountId, req.session.userId, { sheets: cleanSheets, customSheets: cleanCustom });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── 원클릭 계정분석 제안 (전체 리포트 + 증액/감액/키워드발굴 일괄 추출) ──
// 원클릭 분석 요약(JSON) — 엑셀은 별도 GET 스트리밍 엔드포인트로 분리
// (base64를 JSON에 담으면 Vercel 응답 4.5MB 한도를 넘어 'A server error' 발생)
router.post('/api/report/one-click-analysis', requireLogin, async (req, res) => {
  try {
    const { accountId, type } = req.body;
    const t = ['daily', 'weekly', 'monthly'].includes(type) ? type : 'monthly';
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    if (account.has_sa === false) return res.status(400).json({ ok: false, error: 'SA 미활성 계정' });

    const creds = await db.getApiCredentials(req.session.userId, account.id);
    if (!creds) return res.status(400).json({ ok: false, error: 'API 자격증명 미설정' });
    const enriched = { ...account, api_key: creds.api_key, secret_key: creds.secret_key };

    const { generateAnalysisBrief } = require('../report/generator');
    const r = await generateAnalysisBrief(enriched, t);
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error('원클릭 분석 오류:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 원클릭 전체 엑셀(전체 리포트 + 증액/감액/키워드발굴 시트) 스트리밍 다운로드
router.get('/api/report/one-click-excel', requireLogin, async (req, res) => {
  const t = ['daily', 'weekly', 'monthly'].includes(req.query.type) ? req.query.type : 'monthly';
  try {
    const account = await db.getAccountById(req.query.accountId, req.session.userId);
    if (!account) return res.status(404).send('광고주 없음');
    if (account.has_sa === false) return res.status(400).send('SA 미활성 계정');
    const creds = await db.getApiCredentials(req.session.userId, account.id);
    if (!creds) return res.status(400).send('API 자격증명 미설정');
    const enriched = { ...account, api_key: creds.api_key, secret_key: creds.secret_key };

    const { generateAnalysisBundle } = require('../report/generator');
    const { buffer } = await generateAnalysisBundle(enriched, t, null, { skipPrev: t === 'monthly' });

    const safeName = (account.name || 'account').replace(/[\\/:*?"<>|]/g, '_');
    const filename = `${safeName}_계정분석제안_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`;
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('원클릭 엑셀 오류:', err.message);
    res.status(500).send('엑셀 생성 실패: ' + err.message);
  }
});

// ─── 성과개선 전략 공통: 계정 + 자격증명 로드 ─────────────────────────
async function loadStrategyAccount(req) {
  const { accountId } = req.body;
  const account = await db.getAccountById(accountId, req.session.userId);
  if (!account) return { error: '광고주 없음', status: 404 };
  if (account.has_sa === false) return { error: 'SA 미활성 계정', status: 400 };
  if (!account.customer_id) return { error: 'Customer ID 미등록 — 광고주 설정을 확인하세요', status: 400 };
  const creds = await db.getApiCredentials(req.session.userId, account.id);
  if (!creds) return { error: 'API 자격증명 미설정', status: 400 };
  return { account: { ...account, api_key: creds.api_key, secret_key: creds.secret_key } };
}
function strategyType(t) { return ['daily', 'weekly', 'monthly'].includes(t) ? t : 'monthly'; }

// 증액 (Upselling)
function normChannels(v) {
  const arr = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : []);
  return arr.map(c => String(c).trim()).filter(c => c === 'powerlink' || c === 'shopping');
}
router.post('/api/strategy/upsell', requireLogin, async (req, res) => {
  try {
    const { account, error, status } = await loadStrategyAccount(req);
    if (error) return res.status(status).json({ ok: false, error });
    const track = req.body.track === 'grow_volume' ? 'grow_volume' : 'hold_roas';
    const channels = normChannels(req.body.channels);
    const { runStrategy } = require('../report/generator');
    const r = await runStrategy(account, strategyType(req.body.type), 'upsell', { track, channels });
    res.json({ ok: true, period: r.period, groups: r.groups, keywords: r.keywords, devices: r.devices, summary: r.summary });
  } catch (err) { console.error('증액 분석 오류:', err.message); res.status(500).json({ ok: false, error: err.message }); }
});

// 증액 다차원 엑셀 스트리밍 다운로드 (그룹별/키워드별/기기별)
router.get('/api/strategy/upsell-excel', requireLogin, async (req, res) => {
  const t = strategyType(req.query.type);
  try {
    const account = await db.getAccountById(req.query.accountId, req.session.userId);
    if (!account) return res.status(404).send('광고주 없음');
    if (account.has_sa === false) return res.status(400).send('SA 미활성 계정');
    if (!account.customer_id) return res.status(400).send('Customer ID 미등록');
    const creds = await db.getApiCredentials(req.session.userId, account.id);
    if (!creds) return res.status(400).send('API 자격증명 미설정');
    const enriched = { ...account, api_key: creds.api_key, secret_key: creds.secret_key };
    const track = req.query.track === 'grow_volume' ? 'grow_volume' : 'hold_roas';
    const channels = normChannels(req.query.channels);

    const { generateUpsellExcel } = require('../report/generator');
    const { buffer } = await generateUpsellExcel(enriched, t, { track, channels });

    const safeName = (account.name || 'account').replace(/[\\/:*?"<>|]/g, '_');
    const filename = `${safeName}_증액제안_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`;
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(Buffer.from(buffer));
  } catch (err) { console.error('증액 엑셀 오류:', err.message); res.status(500).send('엑셀 생성 실패: ' + err.message); }
});

// 감액 (Downselling)
router.post('/api/strategy/downsell', requireLogin, async (req, res) => {
  try {
    const { account, error, status } = await loadStrategyAccount(req);
    if (error) return res.status(status).json({ ok: false, error });
    const mode = req.body.mode === 'budget_target' ? 'budget_target' : 'inefficiency';
    const opts = { mode };
    if (mode === 'budget_target') {
      opts.targetPct = Math.max(1, Math.min(90, parseInt(req.body.targetPct) || 10));
      const amt = parseInt(req.body.targetAmt) || 0; if (amt > 0) opts.targetAmt = amt;
    }
    const { runStrategy } = require('../report/generator');
    const r = await runStrategy(account, strategyType(req.body.type), 'downsell', opts);
    res.json({ ok: true, period: r.period, items: r.items, devices: r.devices, summary: r.summary });
  } catch (err) { console.error('감액 분석 오류:', err.message); res.status(500).json({ ok: false, error: err.message }); }
});

// 감액 엑셀 스트리밍 다운로드 (키워드/검색어별 + 기기별)
router.get('/api/strategy/downsell-excel', requireLogin, async (req, res) => {
  const t = strategyType(req.query.type);
  try {
    const account = await db.getAccountById(req.query.accountId, req.session.userId);
    if (!account) return res.status(404).send('광고주 없음');
    if (account.has_sa === false) return res.status(400).send('SA 미활성 계정');
    if (!account.customer_id) return res.status(400).send('Customer ID 미등록');
    const creds = await db.getApiCredentials(req.session.userId, account.id);
    if (!creds) return res.status(400).send('API 자격증명 미설정');
    const enriched = { ...account, api_key: creds.api_key, secret_key: creds.secret_key };
    const mode = req.query.mode === 'budget_target' ? 'budget_target' : 'inefficiency';
    const opts = { mode };
    if (mode === 'budget_target') { opts.targetPct = Math.max(1, Math.min(90, parseInt(req.query.targetPct) || 10)); const amt = parseInt(req.query.targetAmt) || 0; if (amt > 0) opts.targetAmt = amt; }

    const { generateDownsellExcel } = require('../report/generator');
    const { buffer } = await generateDownsellExcel(enriched, t, opts);

    const safeName = (account.name || 'account').replace(/[\\/:*?"<>|]/g, '_');
    const filename = `${safeName}_감액제안_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`;
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(Buffer.from(buffer));
  } catch (err) { console.error('감액 엑셀 오류:', err.message); res.status(500).send('엑셀 생성 실패: ' + err.message); }
});

// 키워드 발굴 (Discovery)
router.post('/api/strategy/discovery', requireLogin, async (req, res) => {
  try {
    const { account, error, status } = await loadStrategyAccount(req);
    if (error) return res.status(status).json({ ok: false, error });
    const channel = ['powerlink', 'shopping'].includes(req.body.channel) ? req.body.channel : 'all';
    const character = ['related', 'functional', 'seasonal', 'local'].includes(req.body.character) ? req.body.character : 'all';
    const { runStrategy } = require('../report/generator');
    const r = await runStrategy(account, strategyType(req.body.type), 'discovery', { channel, character });
    res.json({ ok: true, period: r.period, items: r.items, summary: r.summary });
  } catch (err) { console.error('발굴 분석 오류:', err.message); res.status(500).json({ ok: false, error: err.message }); }
});

// 원클릭 간략 분석 (월간 제안 폼, 통화용 — 엑셀 미생성)
router.post('/api/strategy/oneclick', requireLogin, async (req, res) => {
  try {
    const { account, error, status } = await loadStrategyAccount(req);
    if (error) return res.status(status).json({ ok: false, error });
    const { generateAnalysisBrief } = require('../report/generator');
    const r = await generateAnalysisBrief(account, strategyType(req.body.type));
    res.json({ ok: true, ...r });
  } catch (err) { console.error('원클릭 간략분석 오류:', err.message); res.status(500).json({ ok: false, error: err.message }); }
});

// ─── DA 리포트 API ─────────────────────────────────────────────────
router.post('/api/da-report/toggle-feat', requireLogin, async (req, res) => {
  if (!FEATURES.DA) return res.status(403).json({ ok: false, error: 'DA 기능 비활성화됨' });
  try {
    const { accountId, feat, enabled } = req.body;
    const valid = ['feat_da_daily_report','feat_da_weekly_report','feat_da_monthly_report'];
    if (!valid.includes(feat)) return res.status(400).json({ ok: false, error: '잘못된 기능' });
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    if (!account.has_da) return res.status(400).json({ ok: false, error: 'DA 미활성 계정' });
    await db.pool.query(`UPDATE ad_accounts SET ${feat} = $1 WHERE id = $2 AND user_id = $3`,
      [enabled ? 1 : 0, accountId, req.session.userId]);
    // ON 시 광고담당자 다우오피스 이메일 자동 추가 (SA와 동일 정책)
    let addedEmail = null;
    if (enabled) {
      try {
        const smtp = await db.getSmtpCredentials(req.session.userId);
        const daouEmail = (smtp?.daou_email || '').trim().toLowerCase();
        if (daouEmail) {
          const current = (account.report_emails || '').split(',').map(e => e.trim()).filter(Boolean);
          const currentLower = current.map(e => e.toLowerCase());
          if (!currentLower.includes(daouEmail)) {
            const merged = [...current, smtp.daou_email.trim()].join(',');
            await db.pool.query('UPDATE ad_accounts SET report_emails = $1 WHERE id = $2 AND user_id = $3',
              [merged, accountId, req.session.userId]);
            addedEmail = smtp.daou_email.trim();
          }
        }
      } catch (e) { console.warn('DA 자동 이메일 추가 실패:', e.message); }
    }
    res.json({ ok: true, addedEmail });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/api/da-report/download-excel', requireLogin, async (req, res) => {
  if (!FEATURES.DA) return res.status(403).send('DA 기능 비활성화됨');
  const { type = 'daily', accountId } = req.query;
  try {
    if (!['daily','weekly','monthly'].includes(type)) return res.status(400).send('잘못된 타입');
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).send('광고주 없음');
    if (!account.has_da) return res.status(400).send('DA 미활성 계정');
    if (!account.naver_cookie) return res.status(400).send('DA 쿠키 미등록');
    const { generateDaExcelBuffer } = require('../report/daGenerator');
    const customRange = (req.query.custom && req.query.startDate && req.query.endDate) ? { since: req.query.startDate, until: req.query.endDate } : null;
    const { buffer } = await generateDaExcelBuffer(account, type, customRange);
    const typeLabel = { daily: '일간', weekly: '주간', monthly: '월간' }[type];
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const safeName = (account.name || 'account').replace(/[\\/:*?"<>|]/g, '_');
    const filename = `${safeName}_DA_${typeLabel}_리포트_${dateStr}.xlsx`;
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error(`❌ DA 엑셀 다운로드 [${type}]:`, err.message);
    res.status(500).set('Content-Type', 'text/plain; charset=utf-8').send(`DA 엑셀 생성 오류: ${err.message}`);
  }
});

router.post('/api/da-report/trigger', requireLogin, async (req, res) => {
  if (!FEATURES.DA) return res.status(403).json({ ok: false, error: 'DA 기능 비활성화됨' });
  const { type, accountId, custom, startDate, endDate } = req.body;
  if (!['daily','weekly','monthly'].includes(type)) return res.status(400).json({ ok: false, error: '잘못된 타입' });
  const customRange = (custom && startDate && endDate) ? { since: startDate, until: endDate } : null;
  try {
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    if (!account.has_da) return res.status(400).json({ ok: false, error: 'DA 미활성 계정' });
    if (!account.naver_cookie) return res.status(400).json({ ok: false, error: 'DA 쿠키 미등록' });
    const smtp = await db.getSmtpCredentials(req.session.userId);
    const emailUser = smtp?.daou_email || smtp?.username || '';
    const emailPass = smtp?.smtp_pass || '';
    if (!emailUser || !emailPass) return res.json({ ok: false, error: 'SMTP 미설정. 내 정보에서 다우오피스 계정을 설정해주세요.' });
    const enriched = {
      ...account,
      email_host: smtp?.smtp_host || 'outbound.daouoffice.com',
      email_port: 465,
      email_user: emailUser,
      email_pass: emailPass,
    };
    const { generateAndSendDa } = require('../report/daGenerator');
    const skipPrev = req.body.skipPrev === true || (type === 'monthly' && !customRange);
    const ok = await generateAndSendDa(enriched, type, customRange, { skipPrev });
    if (ok && !customRange) {
      await db.pool.query(`UPDATE ad_accounts SET last_da_${type}_report = CURRENT_TIMESTAMP WHERE id = $1`, [accountId]).catch(console.error);
      res.json({ ok: true, message: 'DA 리포트 발송 완료!' });
    } else if (ok) {
      res.json({ ok: true, message: 'DA 맞춤 리포트 발송 완료!' });
    } else {
      res.json({ ok: false, error: 'DA 리포트 생성/발송 실패. Vercel 로그 확인.' });
    }
  } catch (err) {
    console.error('DA 리포트 발송 오류:', err);
    res.json({ ok: false, error: `DA 발송 실패: ${err.message}` });
  }
});

// ─── DA Cron (UTC 00:30 = KST 09:30) ──────────────────────────────
['daily', 'weekly', 'monthly'].forEach(type => {
  router.get(`/api/cron/da-${type}`, async (req, res) => {
    if (!FEATURES.DA) return res.json({ ok: true, disabled: true, message: 'DA 리포트 비활성화됨' });
    const authHeader = req.headers.authorization;
    if (process.env.VERCEL && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const startedAt = Date.now();
    const MAX_RUNTIME_MS = 700000;
    const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const curHour = nowKst.getUTCHours();
    const curDow = nowKst.getUTCDay();
    const curDay = nowKst.getUTCDate();
    const force = req.query.force === '1';
    try {
      const allAccounts = await db.getAllAccountsWithFeature(`da_${type}_report`);
      const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const accounts = allAccounts.filter(a => {
        const last = a[`last_da_${type}_report`];
        if (last && new Date(last).toISOString() >= sixHoursAgo) return false;
        if (force) return true;
        const h = a[`sched_da_${type}_hour`] ?? 9;
        if (h !== curHour) return false;
        if (type === 'weekly') { if ((a.sched_da_weekly_dow ?? 1) !== curDow) return false; }
        else if (type === 'monthly') { if ((a.sched_da_monthly_day ?? 1) !== curDay) return false; }
        return true;
      });
      console.log(`🔄 DA Cron [${type}] KST ${curHour}시: 대상 ${accounts.length}/${allAccounts.length}개`);

      let sent = 0, failed = 0, skipped = 0;
      const concurrency = 3;
      for (let i = 0; i < accounts.length; i += concurrency) {
        if (Date.now() - startedAt > MAX_RUNTIME_MS) {
          skipped = accounts.length - sent - failed;
          console.warn(`⏰ DA Cron [${type}]: 타임아웃 임박, ${skipped}개 미처리`);
          break;
        }
        const batch = accounts.slice(i, i + concurrency);
        await Promise.all(batch.map(async (account) => {
          if (!account.has_da || !account.naver_cookie) { failed++; return; }
          try {
            const smtp = await db.getSmtpCredentials(account.user_id).catch(() => null);
            account.email_host = smtp?.smtp_host || 'outbound.daouoffice.com';
            account.email_port = 465;
            account.email_user = smtp?.daou_email || smtp?.username || account.email_user || '';
            account.email_pass = smtp?.smtp_pass || account.email_pass || '';
            const { generateAndSendDa } = require('../report/daGenerator');
            const skipPrev = (type === 'monthly');
            const ok = await generateAndSendDa(account, type, null, { skipPrev }).catch(err => { console.error(`❌ DA cron [${account.name}]:`, err.message); return false; });
            if (ok) {
              sent++;
              await db.pool.query(`UPDATE ad_accounts SET last_da_${type}_report = CURRENT_TIMESTAMP WHERE id = $1`, [account.id]).catch(console.error);
            } else { failed++; }
          } catch (e) { failed++; console.error(`❌ DA cron 처리 [${account.name}]:`, e.message); }
        }));
      }
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`✅ DA Cron [${type}]: 발송 ${sent}, 실패 ${failed}, 미처리 ${skipped}, ${elapsed}s`);
      res.json({ ok: true, type, sent, failed, skipped, total: allAccounts.length, elapsed });
    } catch (err) {
      console.error(`❌ DA Cron [${type}]:`, err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
});

// ─── Vercel Cron 엔드포인트 ────────────────────────────────────────
// Vercel이 UTC 기준으로 호출 (한국시간 = UTC+9)
// daily: UTC 23:00 = KST 08:00
// weekly: UTC 00:00 MON = KST 09:00 MON
// monthly: UTC 00:00 1st = KST 09:00 1st
['daily', 'weekly', 'monthly'].forEach(type => {
  router.get(`/api/cron/${type}`, async (req, res) => {
    // Vercel Cron 인증 헤더 확인
    const authHeader = req.headers.authorization;
    if (process.env.VERCEL && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const startedAt = Date.now();
    const MAX_RUNTIME_MS = 700000;
    // 현재 KST 시각/요일/일자 (UTC+9)
    const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const curHour = nowKst.getUTCHours(); // 0~23
    const curDow = nowKst.getUTCDay();    // 0=일, 1=월, ...
    const curDay = nowKst.getUTCDate();   // 1~31
    // ?force=1 → 시간 매칭 무시하고 모두 처리 (수동 재시도)
    const force = req.query.force === '1';
    try {
      const allAccounts = await db.getAllAccountsWithFeature(`${type}_report`);
      const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const accounts = allAccounts.filter(a => {
        const last = a[`last_${type}_report`];
        if (last && new Date(last).toISOString() >= sixHoursAgo) return false; // 최근 6h 발송 제외
        if (force) return true;
        // 계정별 스케줄 매칭 (NULL이면 기본 09:00 / Mon / 1일)
        const h = a[`sched_${type}_hour`] ?? 9;
        if (h !== curHour) return false;
        if (type === 'weekly') {
          const dow = a.sched_weekly_dow ?? 1;
          if (dow !== curDow) return false;
        } else if (type === 'monthly') {
          const day = a.sched_monthly_day ?? 1;
          if (day !== curDay) return false;
        }
        return true;
      });
      console.log(`🔄 Cron [${type}] KST ${curHour}시: 대상 ${accounts.length}/${allAccounts.length}개 (스케줄+6h 제외)`);

      let sent = 0, failed = 0, skipped = 0;
      const concurrency = 3;
      for (let i = 0; i < accounts.length; i += concurrency) {
        if (Date.now() - startedAt > MAX_RUNTIME_MS) {
          skipped = accounts.length - sent - failed;
          console.warn(`⏰ Cron [${type}]: 타임아웃 임박, ${skipped}개 미처리`);
          break;
        }
        const batch = accounts.slice(i, i + concurrency);
        await Promise.all(batch.map(async (account) => {
          try {
            const smtp = await db.getSmtpCredentials(account.user_id).catch(() => null);
            account.email_host = smtp?.smtp_host || 'outbound.daouoffice.com';
            account.email_port = 465;
            account.email_user = smtp?.daou_email || smtp?.username || account.email_user || '';
            account.email_pass = smtp?.smtp_pass || account.email_pass || '';
            const skipPrev = (type === 'monthly');
            const ok = await generateAndSend(account, type, null, { skipPrev }).catch(err => { console.error(`❌ [${account.name}] ${type}:`, err.message); return false; });
            if (ok) {
              sent++;
              await db.pool.query(`UPDATE ad_accounts SET last_${type}_report = CURRENT_TIMESTAMP WHERE id = $1`, [account.id]).catch(console.error);
            } else { failed++; }
          } catch (e) { failed++; console.error(`❌ Cron 계정 처리 [${account.name}]:`, e.message); }
        }));
      }
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`✅ Vercel Cron [${type}] KST ${curHour}시: 발송 ${sent}, 실패 ${failed}, 미처리 ${skipped}, ${elapsed}s`);
      res.json({ ok: true, type, kstHour: curHour, sent, failed, skipped, total: allAccounts.length, elapsed });
    } catch (err) {
      console.error(`❌ Vercel Cron [${type}]:`, err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
});

// ─── 대시보드 데이터 동기화 Cron ──────────────────────────────────────
const { syncAccountDate, runDashboardSync, runBackfill } = require('../sync/dashboardSync');

// ─── 쇼핑 키워드 진단 엔드포인트 ──────────────────────────────────
router.get('/api/debug/shopping-report', async (req, res) => {
  // CRON_SECRET 또는 로그인 인증
  const authHeader = req.headers.authorization;
  const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!isCron && !req.session?.userId) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try {
    // accountId 직접 조회 (CRON 모드에서도 작동)
    const accountRow = await db.pool.query(
      `SELECT a.id, a.customer_id, a.name, u.api_key AS u_api_key, u.secret_key AS u_secret_key, u.manager_customer_id AS u_mgr_cust_id
       FROM ad_accounts a JOIN users u ON u.id = a.user_id WHERE a.id = $1`,
      [req.query.accountId]
    );
    if (accountRow.rows.length === 0) return res.status(404).json({ ok: false, error: '광고주 없음' });
    const account = accountRow.rows[0];
    const creds = { api_key: account.u_api_key, secret_key: account.u_secret_key, manager_customer_id: account.u_mgr_cust_id || account.customer_id };
    const client = makeClient(creds, account.customer_id);
    const testDate = req.query.date || fmtKST((() => { const d = new Date(); d.setDate(d.getDate() - 1); return d; })());

    const reportTypes = [
      'SHOPPINGKEYWORD_DETAIL',
      'SHOPPINGKEYWORD_CONVERSION_DETAIL',
      'AD_DETAIL',
      'AD_CONVERSION_DETAIL',
    ];

    const results = {};
    for (const tp of reportTypes) {
      try {
        const rows = await client.createAndDownloadStatReport(tp, testDate);
        results[tp] = { ok: true, rowCount: rows.length, sample: rows.slice(0, 2).map(r => r.join(' | ')) };
      } catch (e) {
        results[tp] = { ok: false, error: e.message, statusCode: e.statusCode };
      }
    }

    // sync_log 상태 확인
    const syncCheck = await db.pool.query(
      `SELECT stat_date, status, completed_at FROM sync_log WHERE account_id = $1 AND sync_type = 'detail' ORDER BY stat_date DESC LIMIT 10`,
      [account.id]
    );

    // stat_daily_detail에서 쇼핑 캠페인 키워드 확인
    const shopKwCheck = await db.pool.query(
      `SELECT COUNT(*)::int AS cnt FROM stat_daily_detail d
       JOIN master_campaigns mc ON d.campaign_id = mc.campaign_id AND d.account_id = mc.account_id
       WHERE d.account_id = $1 AND mc.campaign_tp = 2 AND d.keyword_id != '-' AND d.keyword_id != ''`,
      [account.id]
    );

    res.json({
      ok: true,
      testDate,
      reportResults: results,
      syncLogRecent: syncCheck.rows,
      shoppingKwInDb: shopKwCheck.rows[0].cnt,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 30분마다 실행: 어제+오늘 데이터 동기화
// ?force=1 로 호출하면 sync_log 삭제 후 강제 재동기화
router.get('/api/cron/sync-dashboard', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (process.env.VERCEL && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    if (req.query.force === '1') {
      const del = await db.pool.query(`DELETE FROM sync_log WHERE sync_type = 'detail'`);
      console.log(`🔄 강제 재동기화: sync_log ${del.rowCount}건 삭제`);
    }
    const result = await runDashboardSync(50000);
    console.log(`✅ Cron [sync-dashboard]: ${result.totalSynced}건, ${result.elapsed}초`);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('❌ Cron [sync-dashboard]:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 매일 자동 정리: 60일 초과 stat_daily_detail 삭제 (디스크 절약)
// 배치 5만 행 단위로 반복하여 락 최소화
router.get('/api/cron/cleanup-old-data', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (process.env.VERCEL && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const startedAt = Date.now();
  const RETENTION_DAYS = parseInt(req.query.days) || 60;
  const BATCH_SIZE = 50000;
  const MAX_BATCHES = 20; // 안전장치: 단일 실행 최대 100만 행 (초과 시 다음날 cron이 마저 정리)
  try {
    let totalDeleted = 0;
    let batches = 0;
    while (batches < MAX_BATCHES) {
      const r = await db.pool.query(`
        DELETE FROM stat_daily_detail
        WHERE id IN (
          SELECT id FROM stat_daily_detail
          WHERE stat_date < CURRENT_DATE - ($1 || ' days')::interval
          LIMIT $2
        )
      `, [RETENTION_DAYS, BATCH_SIZE]);
      const deleted = r.rowCount || 0;
      totalDeleted += deleted;
      batches++;
      if (deleted < BATCH_SIZE) break;
      // 함수 타임아웃 방지: 4분 경과 시 중단
      if (Date.now() - startedAt > 240000) break;
    }
    // 동기화 로그도 보존 기간 적용
    const logRes = await db.pool.query(`
      DELETE FROM sync_log WHERE stat_date < CURRENT_DATE - ($1 || ' days')::interval
    `, [RETENTION_DAYS]).catch(e => ({ rowCount: 0, error: e.message }));
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`✅ Cron [cleanup-old-data]: stat_daily_detail ${totalDeleted}행 (${batches}배치), sync_log ${logRes.rowCount || 0}행, ${elapsed}초`);
    res.json({
      ok: true,
      retentionDays: RETENTION_DAYS,
      statDeleted: totalDeleted,
      batches,
      syncLogDeleted: logRes.rowCount || 0,
      elapsed,
    });
  } catch (err) {
    console.error('❌ Cron [cleanup-old-data]:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 매일 백필: 과거 60일 데이터 보충 (전월 리포트 조회용)
// ?force=1 로 호출하면 sync_log 삭제 후 강제 백필
router.get('/api/cron/sync-backfill', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (process.env.VERCEL && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    if (req.query.force === '1') {
      const del = await db.pool.query(`DELETE FROM sync_log WHERE sync_type = 'detail'`);
      console.log(`🔄 강제 백필: sync_log ${del.rowCount}건 삭제`);
    }
    const result = await runBackfill(50000, 60);
    console.log(`✅ Cron [sync-backfill]: ${result.totalSynced}건, ${result.elapsed}초`);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('❌ Cron [sync-backfill]:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── 쇼핑검색 자동입찰 페이지 ──────────────────────────────────────
router.get('/shopping-bid', requireLogin, requireApi, async (req, res) => {
  if (!FEATURES.SHOPPING_BID) {
    const user = await getUser(req);
    const layoutOpts = await getLayoutOpts(req);
    return res.send(appLayout('쇼핑검색 자동입찰', `
      <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:12px;padding:32px;text-align:center;color:#92400e;max-width:640px;margin:40px auto">
        <div style="font-size:18px;font-weight:700;margin-bottom:8px">자동입찰은 '원클릭 계정분석 제안'으로 대체되었습니다</div>
        <div style="font-size:14px;line-height:1.7">자동 입찰 대신, 데이터 기반 <b>증액·감액 제안</b>을 검토 후 직접 적용하는 방식으로 전환했습니다.<br><b>자동리포트 → 원클릭 계정분석 제안</b>에서 확인하세요.</div>
      </div>`, user, '', layoutOpts));
  }
  const user = await getUser(req);
  const accounts = await db.getAccountsByUser(user.id);
  const selectedId = req.session.selectedAccountId || req.query.accountId || accounts[0]?.id || '';

  const content = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <div>
        <p style="color:#64748b;font-size:13px;margin:0">네이버 쇼핑검색 광고의 노출순위를 실시간으로 모니터링하고 입찰가를 자동 조정합니다.</p>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <button class="btn" onclick="debugShoppingRank()" id="debug-btn">🔧 스크래핑 테스트</button>
        <button class="btn" onclick="checkShoppingRanks()" id="rank-btn">📊 순위 조회</button>
        <button class="btn btn-primary" onclick="openShoppingModal()">+ 키워드 추가</button>
      </div>
    </div>

    <!-- 등록된 키워드 목록 -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">🛒 쇼핑검색 자동입찰 키워드 관리</span>
        <span id="sb-count" style="font-size:12px;color:#94a3b8"></span>
      </div>
      <div id="sb-list"><div class="empty"><span class="spinner"></span> 로딩 중...</div></div>
    </div>

    <!-- 키워드 추가/수정 모달 -->
    <div id="sb-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999;align-items:center;justify-content:center">
      <div style="background:#fff;border-radius:12px;width:100%;max-width:700px;max-height:90vh;overflow-y:auto;padding:24px;margin:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <h3 id="sb-modal-title" style="margin:0;font-size:16px">쇼핑검색 키워드 추가</h3>
          <button onclick="closeShoppingModal()" style="background:none;border:none;font-size:20px;cursor:pointer;color:#94a3b8">&times;</button>
        </div>

        <!-- 소재 선택: 조회 → 캠페인 → 광고그룹 → 소재 -->
        <div id="sf-picker" style="margin-bottom:16px">
          <button class="btn btn-outline" onclick="loadShoppingCampaigns()" id="sf-load-btn" style="width:100%;font-size:12px;margin-bottom:12px">📋 쇼핑검색 캠페인 불러오기</button>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
            <div class="form-group" style="margin:0">
              <label>① 캠페인</label>
              <select id="sf-campaign" onchange="loadShoppingAdgroups()" style="font-size:12px" disabled>
                <option value="">캠페인 조회 필요</option>
              </select>
            </div>
            <div class="form-group" style="margin:0">
              <label>② 광고그룹</label>
              <select id="sf-adgroup" onchange="loadShoppingAds()" style="font-size:12px" disabled>
                <option value="">캠페인 먼저 선택</option>
              </select>
            </div>
            <div class="form-group" style="margin:0">
              <label>③ 소재 <span style="font-size:10px;color:#94a3b8">(nad-ID)</span></label>
              <select id="sf-ad" onchange="pickShoppingAd()" style="font-size:12px" disabled>
                <option value="">광고그룹 먼저 선택</option>
              </select>
            </div>
          </div>
        </div>

        <!-- 선택된 소재 정보 -->
        <div id="sf-ad-info" style="display:none;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px;margin-bottom:16px">
          <div style="font-size:11px;color:#16a34a;font-weight:600;margin-bottom:6px">✅ 선택된 소재</div>
          <div style="font-size:13px;font-weight:600" id="sf-ad-title"></div>
          <div style="font-size:11px;color:#64748b;margin-top:4px" id="sf-ad-detail"></div>
        </div>

        <div class="form-group"><label>검색 키워드</label><input id="sf-keyword" placeholder="예: 유럽포스터"></div>
        <input type="hidden" id="sf-product-url">
        <input type="hidden" id="sf-product-name">
        <input type="hidden" id="sf-edit-id">

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group"><label>지면</label>
            <select id="sf-device"><option value="MO" selected>MOBILE</option><option value="PC">PC</option></select>
          </div>
          <div class="form-group"><label>희망순위</label><input id="sf-rank" type="number" value="1" min="1" max="40"></div>
          <div class="form-group"><label>최대입찰가 (원)</label><input id="sf-maxbid" type="number" value="5000" step="100"></div>
          <div class="form-group"><label>조정입찰가 (원)</label><input id="sf-adjust" type="number" value="100" step="10"></div>
          <div class="form-group"><label>실행 간격</label>
            <select id="sf-interval"><option value="5">5분</option><option value="10" selected>10분</option><option value="20">20분</option><option value="30">30분</option><option value="60">60분</option></select>
          </div>
        </div>

        <div class="form-group">
          <label>실행 시간대 <span style="font-size:11px;color:#94a3b8">(클릭하여 ON/OFF)</span></label>
          <div id="sf-schedule" style="display:grid;grid-template-columns:repeat(12,1fr);gap:3px;margin-top:4px">
            ${Array.from({length:24},(_,h)=>`<div class="hour-btn on" data-h="${h}" onclick="toggleShoppingHour(this)" style="text-align:center;padding:6px 0;font-size:11px;border-radius:4px;cursor:pointer;user-select:none">${h}시</div>`).join('')}
          </div>
        </div>

        <div style="display:flex;gap:8px;margin-top:16px">
          <button class="btn btn-primary" onclick="saveShoppingKeyword()" style="flex:1" id="sb-modal-save-btn">저장</button>
          <button class="btn" onclick="closeShoppingModal()" style="flex:1">취소</button>
        </div>
      </div>
    </div>

    <div class="alert alert-info" style="margin-top:16px">
      <strong>쇼핑검색 자동입찰 안내</strong><br>
      <span style="font-size:12px">
        • 캠페인 → 광고그룹 → 소재를 선택하면 소재 ID(nad-xxx)가 자동으로 등록됩니다.<br>
        • 검색 키워드 입력 후 해당 소재가 검색결과에서 몇 번째 광고에 노출되는지 실시간으로 확인합니다.<br>
        • 목표순위보다 낮으면 조정입찰가만큼 올리고, 높으면 낮춥니다.
      </span>
    </div>

    <style>
      .hour-btn.on{background:#dcfce7;color:#166534;border:1px solid #bbf7d0}
      .hour-btn.off{background:#f1f5f9;color:#94a3b8;border:1px solid #e2e8f0}
      #sb-modal[style*="flex"]{display:flex!important}
    </style>

    <script>
    const accountId = '${selectedId}';
    let sbEditMode = false;
    let campCache = [];
    let agCache = {};
    let adCache = {};

    // ─── 캠페인 → 광고그룹 → 소재 로드 ─────────────────────
    async function loadShoppingCampaigns(){
      const btn=document.getElementById('sf-load-btn');
      btn.disabled=true; btn.textContent='불러오는 중...';
      try{
        const r=await fetch('/smart-sa/api/shopping-bid/campaigns?accountId='+accountId);
        const j=await r.json();
        if(!j.ok) throw new Error(j.error);
        campCache=j.campaigns||[];
        const sel=document.getElementById('sf-campaign');
        sel.innerHTML='<option value="">캠페인 선택 ('+campCache.length+'개)</option>';
        campCache.forEach(c=>{
          sel.innerHTML+='<option value="'+c.id+'">'+c.name+'</option>';
        });
        sel.disabled=false;
        toast(campCache.length+'개 캠페인 로드 완료');
      }catch(e){toast('오류: '+e.message,true);}
      finally{btn.disabled=false;btn.textContent='📋 캠페인 목록 새로고침';}
    }

    async function loadShoppingAdgroups(){
      const campId=document.getElementById('sf-campaign').value;
      const agSel=document.getElementById('sf-adgroup');
      const adSel=document.getElementById('sf-ad');
      agSel.innerHTML='<option value="">로딩 중...</option>'; agSel.disabled=true;
      adSel.innerHTML='<option value="">광고그룹 먼저 선택</option>'; adSel.disabled=true;
      document.getElementById('sf-ad-info').style.display='none';
      if(!campId) return;
      try{
        const r=await fetch('/smart-sa/api/shopping-bid/adgroups?accountId='+accountId+'&campaignId='+campId);
        const j=await r.json();
        if(!j.ok) throw new Error(j.error);
        agCache[campId]=j.adgroups||[];
        agSel.innerHTML='<option value="">광고그룹 선택 ('+agCache[campId].length+'개)</option>';
        agCache[campId].forEach(ag=>{
          agSel.innerHTML+='<option value="'+ag.id+'">'+ag.name+'</option>';
        });
        agSel.disabled=false;
      }catch(e){toast('오류: '+e.message,true);agSel.innerHTML='<option value="">오류</option>';}
    }

    async function loadShoppingAds(){
      const agId=document.getElementById('sf-adgroup').value;
      const adSel=document.getElementById('sf-ad');
      adSel.innerHTML='<option value="">로딩 중...</option>'; adSel.disabled=true;
      document.getElementById('sf-ad-info').style.display='none';
      if(!agId) return;
      try{
        const r=await fetch('/smart-sa/api/shopping-bid/ads?accountId='+accountId+'&adgroupId='+agId);
        const j=await r.json();
        if(!j.ok) throw new Error(j.error);
        adCache[agId]=j.ads||[];
        adSel.innerHTML='<option value="">소재 선택 ('+adCache[agId].length+'개)</option>';
        adCache[agId].forEach(ad=>{
          const label=(ad.name||ad.id||'').slice(0,40);
          adSel.innerHTML+='<option value="'+ad.nadId+'" data-name="'+encodeURIComponent(label)+'" data-nad="'+ad.nadId+'">'+label+'</option>';
        });
        adSel.disabled=false;
      }catch(e){toast('오류: '+e.message,true);adSel.innerHTML='<option value="">오류</option>';}
    }

    function pickShoppingAd(){
      const adSel=document.getElementById('sf-ad');
      const opt=adSel.selectedOptions[0];
      if(!opt||!opt.value){document.getElementById('sf-ad-info').style.display='none';return;}
      const nadId=opt.value;
      const name=decodeURIComponent(opt.dataset.name||'');
      const campName=document.getElementById('sf-campaign').selectedOptions[0]?.text||'';
      const agName=document.getElementById('sf-adgroup').selectedOptions[0]?.text||'';

      document.getElementById('sf-product-url').value=nadId;
      document.getElementById('sf-product-name').value=name;
      document.getElementById('sf-ad-title').textContent=name||nadId;
      document.getElementById('sf-ad-detail').textContent=campName+' / '+agName+' / '+nadId;
      document.getElementById('sf-ad-info').style.display='block';
    }

    // ─── 모달 ───────────────────────────────────────────────
    function openShoppingModal(editData){
      sbEditMode = !!editData;
      document.getElementById('sb-modal-title').textContent = sbEditMode ? '키워드 설정 수정' : '쇼핑검색 키워드 추가';
      document.getElementById('sb-modal-save-btn').textContent = sbEditMode ? '수정' : '저장';

      if (editData) {
        document.getElementById('sf-keyword').value = editData.keyword;
        document.getElementById('sf-keyword').readOnly = true;
        document.getElementById('sf-product-url').value = editData.product_url || '';
        document.getElementById('sf-product-name').value = editData.product_name || '';
        document.getElementById('sf-device').value = editData.device;
        document.getElementById('sf-device').disabled = true;
        document.getElementById('sf-rank').value = editData.target_rank;
        document.getElementById('sf-maxbid').value = editData.max_bid;
        document.getElementById('sf-adjust').value = editData.adjust_amt;
        document.getElementById('sf-edit-id').value = editData.id;
        document.getElementById('sf-interval').value = editData.bid_interval || 10;
        document.getElementById('sf-picker').style.display = 'none';
        // 소재 정보 표시
        if(editData.product_url){
          document.getElementById('sf-ad-title').textContent=editData.product_name||editData.product_url;
          document.getElementById('sf-ad-detail').textContent='소재 ID: '+editData.product_url;
          document.getElementById('sf-ad-info').style.display='block';
        }
        const sch = editData.schedule || '111111111111111111111111';
        document.querySelectorAll('#sf-schedule .hour-btn').forEach((b,i) => {
          b.classList.toggle('on', sch[i]==='1');
          b.classList.toggle('off', sch[i]!=='1');
        });
      } else {
        resetShoppingForm();
        document.getElementById('sf-picker').style.display = 'block';
      }
      document.getElementById('sb-modal').style.display = 'flex';
    }

    function closeShoppingModal(){ document.getElementById('sb-modal').style.display='none'; resetShoppingForm(); }

    function resetShoppingForm(){
      document.getElementById('sf-keyword').value=''; document.getElementById('sf-keyword').readOnly=false;
      document.getElementById('sf-product-url').value='';
      document.getElementById('sf-product-name').value='';
      document.getElementById('sf-edit-id').value='';
      document.getElementById('sf-rank').value='1';
      document.getElementById('sf-maxbid').value='5000';
      document.getElementById('sf-adjust').value='100';
      document.getElementById('sf-device').value='MO'; document.getElementById('sf-device').disabled=false;
      document.getElementById('sf-interval').value='10';
      document.getElementById('sf-ad-info').style.display='none';
      document.getElementById('sf-campaign').value='';
      document.getElementById('sf-adgroup').innerHTML='<option value="">광고그룹 선택...</option>';
      document.getElementById('sf-adgroup').disabled=true;
      document.getElementById('sf-ad').innerHTML='<option value="">소재 선택...</option>';
      document.getElementById('sf-ad').disabled=true;
      document.querySelectorAll('#sf-schedule .hour-btn').forEach(b=>{b.classList.remove('off');b.classList.add('on');});
    }

    function toggleShoppingHour(el){ el.classList.toggle('on'); el.classList.toggle('off'); }

    // ─── 저장 ───────────────────────────────────────────────
    async function saveShoppingKeyword(){
      const kw = document.getElementById('sf-keyword').value.trim();
      if(!kw) return toast('검색 키워드를 입력해주세요.',true);
      const nadId = document.getElementById('sf-product-url').value.trim();
      if(!nadId && !sbEditMode) return toast('소재를 선택해주세요.',true);
      const hours=Array.from(document.querySelectorAll('#sf-schedule .hour-btn')).map(b=>b.classList.contains('on')?'1':'0').join('');
      const body={
        accountId, keyword:kw,
        product_url:nadId,
        product_name:document.getElementById('sf-product-name').value.trim(),
        device:document.getElementById('sf-device').value,
        target_rank:parseInt(document.getElementById('sf-rank').value)||1,
        max_bid:parseInt(document.getElementById('sf-maxbid').value)||5000,
        adjust_amt:parseInt(document.getElementById('sf-adjust').value)||100,
        schedule:hours, bid_interval:parseInt(document.getElementById('sf-interval').value)||10, enabled:true,
      };
      if(sbEditMode) body.id = document.getElementById('sf-edit-id').value;
      try{
        const r=await fetch('/smart-sa/api/shopping-bid/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        const j=await r.json();
        if(!j.ok) throw new Error(j.error);
        toast(sbEditMode?'설정 수정 완료':'키워드 저장 완료');
        closeShoppingModal(); loadShoppingList();
      }catch(e){toast('오류: '+e.message,true);}
    }

    // ─── 순위 조회 ──────────────────────────────────────────
    async function checkShoppingRanks(){
      const btn=document.getElementById('rank-btn');
      btn.disabled=true; btn.textContent='조회 중...';
      try{
        const r=await fetch('/smart-sa/api/shopping-bid/check-ranks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId})});
        const j=await r.json();
        if(!j.ok) throw new Error(j.error);
        toast(j.checked+'개 키워드 순위 조회 완료');
        loadShoppingList();
      }catch(e){toast('오류: '+e.message,true);}
      finally{btn.disabled=false;btn.textContent='📊 순위 조회';}
    }

    // ─── 목록 로드 ──────────────────────────────────────────
    async function loadShoppingList(){
      try{
        const r=await fetch('/smart-sa/api/shopping-bid/list?accountId='+accountId);
        const j=await r.json();
        if(!j.ok) throw new Error(j.error);
        const kws=j.keywords;
        document.getElementById('sb-count').textContent=kws.length+'개 키워드';
        if(!kws.length){document.getElementById('sb-list').innerHTML='<div class="empty">등록된 쇼핑검색 자동입찰 키워드가 없습니다.<br><span style="font-size:12px;color:#cbd5e1">+ 키워드 추가 버튼으로 키워드를 등록해주세요.</span></div>';return;}

        const scheduleHtml=(sch)=>{
          if(!sch||sch==='111111111111111111111111') return '<span style="color:#166534;font-size:11px">24시간</span>';
          if(sch==='000000000000000000000000') return '<span style="color:#dc2626;font-size:11px">OFF</span>';
          const ranges=[];let start=null;
          for(let h=0;h<=24;h++){
            if(h<24&&sch[h]==='1'){if(start===null)start=h;}
            else{if(start!==null){ranges.push(start===h-1?start+'시':start+'-'+(h-1)+'시');start=null;}}
          }
          return '<span style="font-size:11px;color:#334155">'+ranges.join(', ')+'</span>';
        };

        const rankBadge=(r, lastRun)=>{
          if(!lastRun) return '<span style="color:#cbd5e1">-</span>';
          if(!r||r<=0) return '<span class="badge badge-red">순위밖</span>';
          if(r<=3) return '<span class="badge badge-green">'+r+'위</span>';
          if(r<=10) return '<span class="badge badge-blue">'+r+'위</span>';
          return '<span class="badge badge-gray">'+r+'위</span>';
        };

        document.getElementById('sb-list').innerHTML='<div style="overflow-x:auto"><table><thead><tr><th>검색 키워드</th><th>상품명</th><th style="text-align:center">지면</th><th style="text-align:center">희망순위</th><th style="text-align:center">현재순위</th><th style="text-align:right">현재입찰가</th><th style="text-align:right">최대CPC</th><th style="text-align:center">간격</th><th>실행시간</th><th style="text-align:center">사용</th><th></th></tr></thead><tbody>'
          +kws.map(k=>{
            const kData=JSON.stringify(k).replace(/'/g,"\\\\'").replace(/"/g,"&quot;");
            return '<tr>'
            +'<td><strong>'+k.keyword+'</strong></td>'
            +'<td style="font-size:12px;color:#64748b;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+(k.product_url||'')+'">'+(k.product_name||k.product_url||'-')+'</td>'
            +'<td style="text-align:center"><span class="badge '+(k.device==='PC'?'badge-blue':'badge-green')+'">'+k.device+'</span></td>'
            +'<td style="text-align:center;font-weight:600">'+k.target_rank+'위</td>'
            +'<td style="text-align:center">'+rankBadge(k.last_rank, k.last_run)+'</td>'
            +'<td style="text-align:right">'+(k.last_bid>0?'₩'+Number(k.last_bid).toLocaleString():'<span style="color:#cbd5e1">-</span>')+'</td>'
            +'<td style="text-align:right">₩'+Number(k.max_bid).toLocaleString()+'</td>'
            +'<td style="text-align:center"><span class="badge badge-gray">'+(k.bid_interval||10)+'분</span></td>'
            +'<td style="font-size:10px">'+scheduleHtml(k.schedule||'111111111111111111111111')+'</td>'
            +'<td style="text-align:center"><label style="cursor:pointer"><input type="checkbox" '+(k.enabled?'checked':'')+' onchange="toggleShoppingEnable('+k.id+',this.checked)" style="accent-color:#6366f1"></label></td>'
            +'<td style="white-space:nowrap"><button class="btn" style="padding:4px 8px;font-size:11px" onclick="openShoppingModal('+kData+')">수정</button> <button class="btn" style="padding:4px 8px;font-size:11px;color:#dc2626" onclick="deleteShoppingKw('+k.id+')">삭제</button></td>'
            +'</tr>';
          }).join('')
          +'</tbody></table></div>';
      }catch(e){document.getElementById('sb-list').innerHTML='<div class="empty">'+e.message+'</div>';}
    }

    async function toggleShoppingEnable(id,enabled){
      await fetch('/smart-sa/api/shopping-bid/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,accountId,enabled})});
    }

    async function deleteShoppingKw(id){
      if(!confirm('이 키워드를 삭제하시겠습니까?')) return;
      const r=await fetch('/smart-sa/api/shopping-bid/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,accountId})});
      const j=await r.json();
      if(j.ok) loadShoppingList(); else toast('삭제 실패',true);
    }

    // ─── 스크래핑 디버그 ──────────────────────────────────────
    async function debugShoppingRank(){
      const btn=document.getElementById('debug-btn');
      btn.disabled=true; btn.textContent='테스트 중...';
      try{
        const r=await fetch('/smart-sa/api/shopping-bid/list?accountId='+accountId);
        const j=await r.json();
        if(!j.ok||!j.keywords.length){toast('키워드를 먼저 등록해주세요.',true);return;}
        const kw=j.keywords[0];
        const r2=await fetch('/smart-sa/api/shopping-bid/debug',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keyword:kw.keyword,device:kw.device})});
        const j2=await r2.json();
        let modal=document.getElementById('debug-modal');
        if(modal) modal.remove();
        modal=document.createElement('div');modal.id='debug-modal';
        modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center';
        modal.innerHTML='<div style="background:#fff;border-radius:12px;width:90%;max-width:800px;max-height:80vh;overflow:auto;padding:20px"><div style="display:flex;justify-content:space-between;margin-bottom:12px"><h3 style="margin:0">쇼핑검색 스크래핑 결과 ('+kw.keyword+' / '+kw.device+')</h3><button onclick="this.closest(\\'#debug-modal\\').remove()" style="background:none;border:none;font-size:20px;cursor:pointer">&times;</button></div><pre id="debug-content" style="font-size:11px;white-space:pre-wrap;background:#f8fafc;padding:12px;border-radius:8px;max-height:60vh;overflow:auto"></pre></div>';
        document.body.appendChild(modal);
        document.getElementById('debug-content').textContent=JSON.stringify(j2,null,2);
      }catch(e){toast('디버그 오류: '+e.message,true);}
      finally{btn.disabled=false;btn.textContent='🔧 스크래핑 테스트';}
    }

    loadShoppingList();

    // 페이지 로드 후 현재입찰가 자동 조회
    async function fetchCurrentBids() {
      try {
        const r = await fetch('/smart-sa/api/shopping-bid/fetch-bids', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ accountId })
        });
        const j = await r.json();
        if (j.ok && j.bids) {
          // 테이블 새로고침하여 DB에 저장된 최신 입찰가 반영
          loadShoppingList();
        }
      } catch(e) {}
    }
    // 리스트 로드 완료 후 3초 뒤 입찰가 조회
    setTimeout(fetchCurrentBids, 3000);
    </script>
  `;
  res.send(appLayout('쇼핑검색 자동입찰', content, user, 'shopping-bid', await getLayoutOpts(req)));
});

// ─── 쇼핑검색 자동입찰 API ─────────────────────────────────────────
router.get('/api/shopping-bid/list', requireLogin, async (req, res) => {
  try {
    const accountId = req.query.accountId || req.session.selectedAccountId;
    if (!accountId) return res.json({ ok: false, error: '광고주를 선택해주세요.' });
    const keywords = await db.getShoppingBidKeywords(accountId);
    res.json({ ok: true, keywords });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.post('/api/shopping-bid/save', requireLogin, async (req, res) => {
  try {
    const { accountId, keyword, product_url, product_name, device, target_rank, max_bid, adjust_amt, schedule, bid_interval, enabled } = req.body;
    if (!accountId || !keyword) return res.json({ ok: false, error: '필수 항목이 누락되었습니다.' });
    await db.upsertShoppingBidKeyword(accountId, { keyword, product_url, product_name, device, target_rank, max_bid, adjust_amt, schedule, bid_interval, enabled });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.post('/api/shopping-bid/toggle', requireLogin, async (req, res) => {
  try {
    const { id, accountId, enabled } = req.body;
    await db.pool.query('UPDATE shopping_bid_keywords SET enabled = $1 WHERE id = $2 AND account_id = $3', [enabled ? 1 : 0, id, accountId]);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── 쇼핑검색: 캠페인 → 광고그룹 → 소재 조회 API ──────────────────
router.get('/api/shopping-bid/campaigns', requireLogin, async (req, res) => {
  try {
    const { accountId } = req.query;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.json({ ok: false, error: 'API 계정 미등록' });
    const client = createApiClient({ apiKey: creds.api_key, secretKey: creds.secret_key, customerId: account.customer_id });
    const campaigns = await client.getCampaigns();
    // 쇼핑검색 캠페인만 필터 (공식 API: campaignTp 2=쇼핑검색)
    const active = (campaigns || []).filter(c => {
      const isActive = c.status === 'ELIGIBLE' || !c.status;
      // 쇼핑검색 캠페인 타입: 2 (공식), 또는 이름에 '쇼핑' 포함 (fallback)
      const isShopping = c.campaignTp === 2 || c.campaignTp === '2' || (c.name && c.name.includes('쇼핑'));
      return isActive && isShopping;
    });
    // 쇼핑검색 캠페인이 없으면 전체 활성 캠페인 반환 (fallback)
    const result = active.length > 0 ? active : (campaigns || []).filter(c => c.status === 'ELIGIBLE' || !c.status);
    res.json({ ok: true, campaigns: result.map(c => ({ id: c.nccCampaignId, name: c.name, type: c.campaignTp })), shoppingOnly: active.length > 0 });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.get('/api/shopping-bid/adgroups', requireLogin, async (req, res) => {
  try {
    const { accountId, campaignId } = req.query;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.json({ ok: false, error: 'API 계정 미등록' });
    const client = createApiClient({ apiKey: creds.api_key, secretKey: creds.secret_key, customerId: account.customer_id });
    const adgroups = await client.getAdGroups(campaignId);
    const active = (adgroups || []).filter(g => g.status === 'ELIGIBLE' || !g.status);
    res.json({ ok: true, adgroups: active.map(g => ({ id: g.nccAdgroupId, name: g.name })) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.get('/api/shopping-bid/ads', requireLogin, async (req, res) => {
  try {
    const { accountId, adgroupId } = req.query;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.json({ ok: false, error: 'API 계정 미등록' });
    const client = createApiClient({ apiKey: creds.api_key, secretKey: creds.secret_key, customerId: account.customer_id });
    const ads = await client.getAds(adgroupId);
    // 소재 목록: nadId, 상품명, 상태
    const items = (ads || []).map(ad => ({
      id: ad.nccAdId,
      name: ad.ad?.headline || ad.ad?.subject || ad.adAttr?.headline || ad.nccAdId,
      nadId: ad.nccAdId,
      pcLandingUrl: ad.ad?.pc?.final || ad.ad?.pcLandingUrl || '',
      moLandingUrl: ad.ad?.mobile?.final || ad.ad?.mobileLandingUrl || '',
      status: ad.status,
    }));
    res.json({ ok: true, ads: items.filter(a => a.status === 'ELIGIBLE' || !a.status) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.post('/api/shopping-bid/delete', requireLogin, async (req, res) => {
  try {
    const { id, accountId } = req.body;
    await db.deleteShoppingBidKeyword(id, accountId);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.post('/api/shopping-bid/check-ranks', requireLogin, async (req, res) => {
  try {
    const { accountId } = req.body;
    if (!accountId) return res.json({ ok: false, error: '광고주를 선택해주세요.' });

    const keywords = await db.getShoppingBidKeywords(accountId);
    if (!keywords.length) return res.json({ ok: true, checked: 0 });

    const { findShoppingRank } = require('../api/shoppingRankScraper');
    let checked = 0;
    const details = [];

    // 현재입찰가도 함께 조회
    const account = await db.getAccountById(accountId, req.session.userId);
    let client = null;
    if (account) {
      const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
      if (creds) client = createApiClient({ apiKey: creds.api_key, secretKey: creds.secret_key, customerId: account.customer_id });
    }
    const bidCache = {};

    for (const kw of keywords) {
      try {
        const result = await findShoppingRank(kw.keyword, kw.device, kw.product_url);
        // 현재입찰가 조회 (소재 ID 기반, adAttr.bidAmt 우선)
        let currentBid = kw.last_bid || 0;
        if (client && kw.product_url && !bidCache[kw.product_url]) {
          try {
            const adDetail = await client.getAdDetail(kw.product_url);
            const adBid = adDetail?.adAttr?.bidAmt || adDetail?.bidAmt || 0;
            if (adBid > 0) {
              bidCache[kw.product_url] = adBid;
            } else if (adDetail?.useGroupBidAmt && adDetail?.nccAdgroupId) {
              const grp = await client.getAdGroupDetail(adDetail.nccAdgroupId);
              bidCache[kw.product_url] = grp?.bidAmt || 0;
            }
          } catch (e) {}
        }
        if (bidCache[kw.product_url]) currentBid = bidCache[kw.product_url];

        await db.updateShoppingBidKeywordStatus(kw.id, result.rank || 0, currentBid);
        details.push({ keyword: kw.keyword, device: kw.device, rank: result.rank || 0, totalAds: result.totalAds, matched: result.matched, currentBid });
        checked++;
      } catch (e) {
        details.push({ keyword: kw.keyword, device: kw.device, error: e.message });
      }
      await new Promise(r => setTimeout(r, 300));
    }

    res.json({ ok: true, checked, details });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 쇼핑검색 현재입찰가 일괄 조회
router.post('/api/shopping-bid/fetch-bids', requireLogin, async (req, res) => {
  try {
    const { accountId } = req.body;
    if (!accountId) return res.json({ ok: false, error: '광고주를 선택해주세요.' });

    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    const creds = await db.getApiCredentials(req.session.userId, (typeof account!=="undefined" && account ? account.id : null));
    if (!creds) return res.json({ ok: false, error: 'API 계정 미등록' });

    const client = createApiClient({ apiKey: creds.api_key, secretKey: creds.secret_key, customerId: account.customer_id });
    const keywords = await db.getShoppingBidKeywords(accountId);
    if (!keywords.length) return res.json({ ok: true, bids: {} });

    const bids = {};
    // nadId(product_url)별로 그룹핑하여 중복 조회 방지
    const nadIds = [...new Set(keywords.filter(k => k.product_url).map(k => k.product_url))];

    for (const nadId of nadIds) {
      try {
        const adDetail = await client.getAdDetail(nadId);
        if (adDetail) {
          // 쇼핑검색 소재는 adAttr.bidAmt에 입찰가 저장
          const adBid = adDetail.adAttr?.bidAmt || adDetail.bidAmt || 0;
          bids[nadId] = {
            bidAmt: adBid,
            useGroupBidAmt: adDetail.useGroupBidAmt || false,
            adAttr: adDetail.adAttr || {},
          };
          // 소재 입찰가가 0이고 그룹 입찰가 사용 시
          if ((!adBid || adDetail.useGroupBidAmt) && adDetail.nccAdgroupId) {
            try {
              const grp = await client.getAdGroupDetail(adDetail.nccAdgroupId);
              if (grp?.bidAmt > 0) {
                bids[nadId].bidAmt = grp.bidAmt;
                bids[nadId].groupBidAmt = grp.bidAmt;
              }
            } catch (e) {}
          }
          console.log(`💰 [${nadId}] 입찰가: ₩${bids[nadId].bidAmt} (adAttr.bidAmt=${adDetail.adAttr?.bidAmt}, bidAmt=${adDetail.bidAmt}, useGroup=${adDetail.useGroupBidAmt})`);
        }
      } catch (e) {
        console.log(`쇼핑 소재 입찰가 조회 실패 [${nadId}]:`, e.message);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    // DB에 현재입찰가 업데이트
    for (const kw of keywords) {
      if (kw.product_url && bids[kw.product_url]?.bidAmt > 0) {
        await db.updateShoppingBidKeywordStatus(kw.id, kw.last_rank || 0, bids[kw.product_url].bidAmt);
      }
    }

    res.json({ ok: true, bids });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 쇼핑검색 디버그 (HTML 분석)
router.post('/api/shopping-bid/debug', requireLogin, async (req, res) => {
  try {
    const { keyword, device } = req.body;
    const { getShoppingAds } = require('../api/shoppingRankScraper');
    const ads = await getShoppingAds(keyword, device || 'PC');
    res.json({ ok: true, keyword, device, totalAds: ads.length, ads });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 5분마다 실행: 자동입찰
router.get('/api/cron/autobid', async (req, res) => {
  if (!FEATURES.AUTOBID) return res.json({ ok: true, disabled: true, message: '자동입찰 비활성화됨' });
  const authHeader = req.headers.authorization;
  if (process.env.VERCEL && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    const { runAutoBiddingForAccount } = require('../scheduler/autoBid');
    const accounts = await db.all(`
      SELECT ad_accounts.*, users.api_key, users.secret_key
      FROM ad_accounts
      JOIN users ON users.id = ad_accounts.user_id
      WHERE users.api_key != '' AND users.secret_key != ''
    `);

    let totalAdjusted = 0;
    for (const account of accounts) {
      try {
        await runAutoBiddingForAccount(account);
        totalAdjusted++;
      } catch (e) {
        console.error(`❌ 자동입찰 [${account.name}]:`, e.message);
      }
    }
    console.log(`✅ Cron [autobid]: ${accounts.length}개 계정 처리`);
    res.json({ ok: true, accounts: accounts.length });
  } catch (err) {
    console.error('❌ Cron [autobid]:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── 쇼핑검색 자동입찰 Cron ──────────────────────────────────────────
router.get('/api/cron/shopping-autobid', async (req, res) => {
  if (!FEATURES.SHOPPING_BID) return res.json({ ok: true, disabled: true, message: '쇼핑 자동입찰 비활성화됨' });
  const authHeader = req.headers.authorization;
  if (process.env.VERCEL && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    const { runShoppingAutoBidForAccount } = require('../scheduler/shoppingAutoBid');
    const accounts = await db.all(`
      SELECT ad_accounts.*, users.api_key, users.secret_key
      FROM ad_accounts
      JOIN users ON users.id = ad_accounts.user_id
      WHERE users.api_key != '' AND users.secret_key != ''
      AND ad_accounts.shopping_auto_bidding = 1
    `);

    for (const account of accounts) {
      try {
        await runShoppingAutoBidForAccount(account);
      } catch (e) {
        console.error(`❌ 쇼핑 자동입찰 [${account.name}]:`, e.message);
      }
    }
    console.log(`✅ Cron [shopping-autobid]: ${accounts.length}개 계정 처리`);
    res.json({ ok: true, accounts: accounts.length });
  } catch (err) {
    console.error('❌ Cron [shopping-autobid]:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 수동 동기화 트리거 (관리자용)
router.post('/api/sync/trigger', requireLogin, async (req, res) => {
  try {
    const result = await runDashboardSync(50000);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = { router };
