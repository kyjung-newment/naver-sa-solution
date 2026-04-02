const express = require('express');
const { config } = require('../../config');
const { initDb, insertVisit, insertConversion, queryStats } = require('./db');
const { classifySource, detectDevice, getGeoInfo, extractIp, getSessionId } = require('./parser');

const router = express.Router();

// ─── 1px GIF 추적 비콘 ────────────────────────────────────────────
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

/**
 * GET /tracker/collect
 * 브라우저에서 <img> 태그로 호출하는 1px 추적 픽셀
 *
 * 파라미터:
 *   url  - 현재 페이지 URL (encodeURIComponent)
 *   ref  - referrer URL
 *   sid  - 세션 ID (없으면 서버에서 생성)
 */
router.get('/collect', async (req, res) => {
  // 응답 먼저 (UX 영향 없게)
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
  });
  res.end(TRANSPARENT_GIF);

  // 비동기로 저장
  try {
    const pageUrl  = decodeURIComponent(req.query.url || '');
    const referrer = decodeURIComponent(req.query.ref || '');
    const ip       = extractIp(req);
    const ua       = req.headers['user-agent'] || '';
    const { source, keyword, campaignId, adGroupId, keywordId } = classifySource(pageUrl, referrer);
    const { country, city } = getGeoInfo(ip);
    const device   = detectDevice(ua);
    const sessionId = req.query.sid || `auto-${Date.now()}`;

    await insertVisit({
      ip, userAgent: ua, pageUrl, referrer,
      source, keyword, campaignId, adGroupId, keywordId,
      device, country, city, sessionId,
    });
  } catch (err) {
    console.error('방문 기록 저장 오류:', err.message);
  }
});

/**
 * POST /tracker/collect
 * JavaScript fetch()로 호출하는 JSON 방식 (더 많은 데이터 수집 가능)
 */
router.post('/collect', express.json(), async (req, res) => {
  res.json({ ok: true });

  try {
    const { url: pageUrl, referrer, sessionId } = req.body;
    const ip  = extractIp(req);
    const ua  = req.headers['user-agent'] || '';
    const { source, keyword, campaignId, adGroupId, keywordId } = classifySource(pageUrl, referrer);
    const { country, city } = getGeoInfo(ip);
    const device = detectDevice(ua);

    await insertVisit({
      ip, userAgent: ua, pageUrl: pageUrl || '', referrer: referrer || '',
      source, keyword, campaignId, adGroupId, keywordId,
      device, country, city, sessionId: sessionId || `post-${Date.now()}`,
    });
  } catch (err) {
    console.error('POST 방문 기록 오류:', err.message);
  }
});

/**
 * POST /tracker/conversion
 * 전환 이벤트 (구매완료, 회원가입 등)
 *
 * Body: { sessionId, eventType, value, keyword, source }
 */
router.post('/conversion', express.json(), async (req, res) => {
  try {
    const { sessionId, eventType = 'purchase', value = 0, keyword, source } = req.body;
    const ip = extractIp(req);

    await insertConversion({ sessionId, ip, eventType, value, keyword, source });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /tracker/stats?days=7
 * 대시보드용 통계 API
 */
router.get('/stats', async (req, res) => {
  // 간단한 토큰 인증
  const token = req.headers['x-tracker-token'] || req.query.token;
  if (token !== config.tracker.secret) {
    return res.status(401).json({ error: '인증 실패' });
  }

  try {
    const days = parseInt(req.query.days) || 7;
    const stats = await queryStats(days);
    res.json({ ok: true, days, stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /tracker/dashboard
 * 웹 대시보드 (HTML)
 */
router.get('/dashboard', (req, res) => {
  const token = req.query.token;
  const domain = config.tracker.domain;

  res.send(`<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>방문자 로그 분석 대시보드</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;background:#f8fafc;color:#1e293b}
  .header{background:#03c75a;color:#fff;padding:20px 32px;display:flex;align-items:center;gap:12px}
  .header h1{font-size:20px;font-weight:700}
  .container{max-width:1100px;margin:0 auto;padding:24px 20px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px}
  .card{background:#fff;border-radius:12px;padding:20px;border:1px solid #e2e8f0}
  .card h3{font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px}
  .card .num{font-size:28px;font-weight:700;color:#1e293b}
  .section{background:#fff;border-radius:12px;padding:24px;border:1px solid #e2e8f0;margin-bottom:20px}
  .section h2{font-size:15px;font-weight:600;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #f1f5f9}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:8px 12px;color:#64748b;font-weight:500;background:#f8fafc;font-size:12px}
  td{padding:10px 12px;border-bottom:1px solid #f1f5f9}
  tr:hover td{background:#f8fafc}
  .badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:500}
  .badge-green{background:#dcfce7;color:#16a34a}
  .badge-blue{background:#dbeafe;color:#2563eb}
  .badge-gray{background:#f1f5f9;color:#64748b}
  .badge-red{background:#fee2e2;color:#dc2626}
  select,input{padding:6px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;background:#fff}
  button{padding:8px 16px;background:#03c75a;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500}
  button:hover{background:#02b350}
  .filter-bar{display:flex;gap:10px;align-items:center;margin-bottom:20px}
  #loading{text-align:center;padding:40px;color:#94a3b8}
</style>
</head>
<body>
<div class="header">
  <span style="font-size:24px">📊</span>
  <div>
    <h1>방문자 로그 분석</h1>
    <p style="font-size:12px;opacity:0.8">네이버SA 유입 키워드 & IP 추적</p>
  </div>
</div>

<div class="container">
  <div class="filter-bar">
    <label style="font-size:13px;color:#64748b">분석 기간:</label>
    <select id="days">
      <option value="1">오늘</option>
      <option value="7" selected>최근 7일</option>
      <option value="30">최근 30일</option>
    </select>
    <button onclick="loadData()">조회</button>
    <span id="last-updated" style="font-size:12px;color:#94a3b8;margin-left:auto"></span>
  </div>

  <div id="loading">데이터 로딩 중...</div>
  <div id="content" style="display:none">

    <!-- KPI 카드 -->
    <div class="grid" id="kpi-grid"></div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">

      <!-- 유입 소스별 -->
      <div class="section">
        <h2>🔀 유입 소스별 방문</h2>
        <table>
          <thead><tr><th>소스</th><th style="text-align:right">방문수</th><th>비율</th></tr></thead>
          <tbody id="source-table"></tbody>
        </table>
      </div>

      <!-- 상위 키워드 -->
      <div class="section">
        <h2>🔑 상위 유입 키워드</h2>
        <table>
          <thead><tr><th>키워드</th><th>소스</th><th style="text-align:right">방문수</th></tr></thead>
          <tbody id="keyword-table"></tbody>
        </table>
      </div>
    </div>

    <!-- IP 목록 (이상 트래픽 감지) -->
    <div class="section">
      <h2>🌐 방문자 IP Top 20 <span style="font-size:12px;font-weight:400;color:#94a3b8">(이상 트래픽 감지용)</span></h2>
      <table>
        <thead><tr><th>IP</th><th style="text-align:right">방문수</th><th>마지막 방문</th><th>상태</th></tr></thead>
        <tbody id="ip-table"></tbody>
      </table>
    </div>

    <!-- 일별 추이 -->
    <div class="section">
      <h2>📈 일별 방문 추이</h2>
      <div id="trend-chart" style="padding:10px 0"></div>
    </div>

  </div>
</div>

<script>
const TOKEN = '${token || ''}';
const API   = '${domain}/tracker/stats';

const sourceBadge = {
  naver_sa:       '<span class="badge badge-green">네이버SA</span>',
  naver_organic:  '<span class="badge badge-blue">네이버 자연검색</span>',
  google_organic: '<span class="badge badge-gray">구글 자연검색</span>',
  google_ads:     '<span class="badge badge-red">구글 광고</span>',
  direct:         '<span class="badge badge-gray">직접</span>',
  daum:           '<span class="badge badge-gray">다음</span>',
  referral:       '<span class="badge badge-gray">레퍼럴</span>',
};

async function loadData() {
  const days = document.getElementById('days').value;
  document.getElementById('loading').style.display = 'block';
  document.getElementById('content').style.display = 'none';

  try {
    const res = await fetch(\`\${API}?days=\${days}&token=\${TOKEN}\`);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
    renderData(json.stats, days);
  } catch(e) {
    document.getElementById('loading').textContent = '❌ 오류: ' + e.message;
    return;
  }

  document.getElementById('loading').style.display = 'none';
  document.getElementById('content').style.display = 'block';
  document.getElementById('last-updated').textContent = '업데이트: ' + new Date().toLocaleTimeString('ko-KR');
}

function renderData(stats, days) {
  const total = stats.bySource.reduce((s, r) => s + r.cnt, 0);
  const nsa   = stats.bySource.find(r => r.source === 'naver_sa')?.cnt || 0;
  const kwCnt = stats.topKeywords.length;

  // KPI
  document.getElementById('kpi-grid').innerHTML = [
    { label:'총 방문수',        val: total.toLocaleString() },
    { label:'네이버SA 유입',    val: nsa.toLocaleString() },
    { label:'수집된 키워드 수', val: kwCnt + '개' },
    { label:'고유 IP 수',       val: stats.topIps.length + '개+' },
  ].map(c => \`<div class="card"><h3>\${c.label}</h3><div class="num">\${c.val}</div></div>\`).join('');

  // 소스별
  document.getElementById('source-table').innerHTML = stats.bySource.map(r => \`
    <tr>
      <td>\${sourceBadge[r.source] || '<span class="badge badge-gray">'+r.source+'</span>'}</td>
      <td style="text-align:right;font-weight:600">\${r.cnt.toLocaleString()}</td>
      <td style="color:#64748b">\${total > 0 ? Math.round(r.cnt/total*100) : 0}%</td>
    </tr>
  \`).join('') || '<tr><td colspan="3" style="color:#94a3b8;text-align:center">데이터 없음</td></tr>';

  // 키워드별
  document.getElementById('keyword-table').innerHTML = stats.topKeywords.map(r => \`
    <tr>
      <td><strong>\${r.keyword || '-'}</strong></td>
      <td>\${sourceBadge[r.source] || r.source}</td>
      <td style="text-align:right">\${r.cnt.toLocaleString()}</td>
    </tr>
  \`).join('') || '<tr><td colspan="3" style="color:#94a3b8;text-align:center">데이터 없음</td></tr>';

  // IP별
  document.getElementById('ip-table').innerHTML = stats.topIps.map(r => {
    const isBot = r.cnt > 100;
    return \`<tr>
      <td style="font-family:monospace">\${r.ip}</td>
      <td style="text-align:right;font-weight:600">\${r.cnt.toLocaleString()}</td>
      <td style="color:#64748b;font-size:12px">\${r.last_seen}</td>
      <td>\${isBot ? '<span class="badge badge-red">⚠ 이상감지</span>' : '<span class="badge badge-green">정상</span>'}</td>
    </tr>\`;
  }).join('') || '<tr><td colspan="4" style="color:#94a3b8;text-align:center">데이터 없음</td></tr>';

  // 간단한 막대 차트 (CSS)
  const trend = stats.dailyTrend;
  const maxVal = Math.max(...trend.map(r => r.cnt), 1);
  document.getElementById('trend-chart').innerHTML = trend.map(r => \`
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <span style="font-size:12px;color:#64748b;width:80px;text-align:right">\${r.day}</span>
      <div style="flex:1;background:#f1f5f9;border-radius:4px;height:20px;position:relative">
        <div style="background:#03c75a;height:100%;border-radius:4px;width:\${Math.round(r.cnt/maxVal*100)}%"></div>
      </div>
      <span style="font-size:12px;font-weight:600;width:40px">\${r.cnt.toLocaleString()}</span>
    </div>
  \`).join('') || '<p style="color:#94a3b8;text-align:center">데이터 없음</p>';
}

loadData();
setInterval(loadData, 60000); // 1분마다 자동 갱신
</script>
</body>
</html>`);
});

module.exports = { router, initDb };
