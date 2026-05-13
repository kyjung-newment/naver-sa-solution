/**
 * DA (디스플레이/GFA) 리포트 생성기
 * - SA 리포트와 동일한 디자인 톤 (네이버 그린 헤더 + KPI 카드 + 섹션)
 * - DA 데이터 구조에 맞춰 캠페인/그룹/소재/성별/연령/지면 섹션 구성
 */
const { fetchReportPerformance, fetchReportPerformanceDetail, normalizeRow } = require('../api/naverDaApi');

const f = {
  num: n => Number(n || 0).toLocaleString('ko-KR'),
  pct: n => `${Number(n || 0).toFixed(2)}%`,
  won: n => `₩${Number(n || 0).toLocaleString('ko-KR')}`,
};

// ── 기간 계산 (KST 기준) ──────────────────────────────────────────
function fmtKST(d) {
  const k = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return k.toISOString().slice(0, 10);
}
function getDateRange(type) {
  const now = new Date();
  if (type === 'daily') {
    const d = new Date(now); d.setDate(d.getDate() - 1);
    return { since: fmtKST(d), until: fmtKST(d) };
  }
  if (type === 'weekly') {
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const today = new Date(kst.toISOString().slice(0, 10));
    const dow = today.getDay(); // 0=일
    const lastSunday = new Date(today); lastSunday.setDate(today.getDate() - (dow === 0 ? 7 : dow));
    const lastMonday = new Date(lastSunday); lastMonday.setDate(lastSunday.getDate() - 6);
    return { since: lastMonday.toISOString().slice(0, 10), until: lastSunday.toISOString().slice(0, 10) };
  }
  if (type === 'monthly') {
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const y = kst.getUTCFullYear(), m = kst.getUTCMonth();
    const first = new Date(Date.UTC(y, m - 1, 1));
    const last = new Date(Date.UTC(y, m, 0));
    return { since: first.toISOString().slice(0, 10), until: last.toISOString().slice(0, 10) };
  }
  const d = new Date(now); d.setDate(d.getDate() - 1);
  return { since: fmtKST(d), until: fmtKST(d) };
}
function getPrevDateRange(type, dateRange) {
  if (type === 'daily') {
    const d = new Date(dateRange.since); d.setDate(d.getDate() - 1);
    const p = d.toISOString().slice(0, 10);
    return { since: p, until: p };
  }
  if (type === 'weekly') {
    const ps = new Date(dateRange.since); ps.setDate(ps.getDate() - 7);
    const pu = new Date(dateRange.until); pu.setDate(pu.getDate() - 7);
    return { since: ps.toISOString().slice(0, 10), until: pu.toISOString().slice(0, 10) };
  }
  if (type === 'monthly') {
    const cs = new Date(dateRange.since);
    const pe = new Date(cs); pe.setDate(pe.getDate() - 1);
    const ps = new Date(pe.getFullYear(), pe.getMonth(), 1);
    return { since: ps.toISOString().slice(0, 10), until: pe.toISOString().slice(0, 10) };
  }
  return null;
}
function getPeriodLabel(type, dr) {
  const fmt = s => { const [y, m, d] = s.split('-'); return `${y}.${m}.${d}`; };
  const lab = { daily: '일간', weekly: '주간', monthly: '월간' }[type] || '';
  return dr.since === dr.until ? `${fmt(dr.since)} (${lab})` : `${fmt(dr.since)} ~ ${fmt(dr.until)} (${lab})`;
}

// ── 데이터 집계 ──────────────────────────────────────────────────
function buildTotals(rows) {
  const t = { imp: 0, clk: 0, cost: 0, convCount: 0, purchaseConvCount: 0, purchaseConvSales: 0, cartConvCount: 0, cartConvSales: 0 };
  rows.forEach(r => {
    t.imp += r.imp; t.clk += r.clk; t.cost += r.cost;
    t.convCount += r.convCount;
    t.purchaseConvCount += r.purchaseConvCount;
    t.purchaseConvSales += r.purchaseConvSales;
    t.cartConvCount += r.cartConvCount;
    t.cartConvSales += r.cartConvSales;
  });
  t.ctr = t.imp > 0 ? t.clk / t.imp * 100 : 0;
  t.cpc = t.clk > 0 ? Math.round(t.cost / t.clk) : 0;
  t.cpm = t.imp > 0 ? Math.round(t.cost / t.imp * 1000) : 0;
  t.cvr = t.clk > 0 ? t.convCount / t.clk * 100 : 0;
  t.purchaseRoas = t.cost > 0 ? t.purchaseConvSales / t.cost * 100 : 0;
  t.roas = t.cost > 0 ? t.convSales !== undefined ? t.convSales / t.cost * 100 : (t.purchaseConvSales / t.cost * 100) : 0;
  return t;
}
function groupBy(rows, keyFn, labelFn) {
  const map = {};
  rows.forEach(r => {
    const k = keyFn(r); if (k === null || k === undefined) return;
    if (!map[k]) map[k] = { _key: k, _label: labelFn ? labelFn(r) : k, imp: 0, clk: 0, cost: 0, convCount: 0, purchaseConvCount: 0, purchaseConvSales: 0, cartConvCount: 0, cartConvSales: 0 };
    map[k].imp += r.imp; map[k].clk += r.clk; map[k].cost += r.cost;
    map[k].convCount += r.convCount;
    map[k].purchaseConvCount += r.purchaseConvCount;
    map[k].purchaseConvSales += r.purchaseConvSales;
    map[k].cartConvCount += r.cartConvCount;
    map[k].cartConvSales += r.cartConvSales;
  });
  return Object.values(map).map(d => {
    d.ctr = d.imp > 0 ? d.clk / d.imp * 100 : 0;
    d.cpc = d.clk > 0 ? Math.round(d.cost / d.clk) : 0;
    d.purchaseRoas = d.cost > 0 ? d.purchaseConvSales / d.cost * 100 : 0;
    return d;
  });
}

/**
 * 모든 데이터 수집 (캠페인/그룹/소재/성별/연령/지면)
 * 캠페인+그룹별 인구통계/지면도 추가 수집
 */
async function collectDaData(account, dateRange) {
  const adAccountNo = account.da_account_no || account.customer_id;
  const baseArgs = { adAccountNo, cookie: account.naver_cookie, startDate: dateRange.since, endDate: dateRange.until };

  // 1) 캠페인/그룹/소재 + 계정전체 성별/연령 병렬
  const [campRows, agRows, crRows, accGenderRows, accAgeRows] = await Promise.allSettled([
    fetchReportPerformance({ ...baseArgs, reportAdUnit: 'CAMPAIGN' }),
    fetchReportPerformance({ ...baseArgs, reportAdUnit: 'AD_SET' }),
    fetchReportPerformance({ ...baseArgs, reportAdUnit: 'CREATIVE' }),
    fetchReportPerformanceDetail({ ...baseArgs, reportAdUnit: 'AD_ACCOUNT', reportDimension: 'GENDER' }),
    fetchReportPerformanceDetail({ ...baseArgs, reportAdUnit: 'AD_ACCOUNT', reportDimension: 'AGE' }),
  ]).then(results => results.map(r => r.status === 'fulfilled' ? (r.value || []).map(normalizeRow) : []));

  // 2) 캠페인 ID 목록 추출 (캠페인별 브레이크다운용)
  const campIds = [...new Set(campRows.map(r => r.campaignNo).filter(Boolean))];
  const agIds = [...new Set(agRows.map(r => r.adSetNo).filter(Boolean))];

  // 캠페인 ID → 이름 매핑
  const campNameMap = {};
  campRows.forEach(r => { if (r.campaignNo) campNameMap[r.campaignNo] = r.campaignName || r.campaignNo; });
  const agNameMap = {};
  agRows.forEach(r => { if (r.adSetNo) agNameMap[r.adSetNo] = { name: r.adSetName || r.adSetNo, campId: r.campaignNo, campName: r.campaignName }; });

  // 3) 캠페인별 성별/연령/지면 (병렬, 5개씩)
  async function fetchPerCampaign(dimension, placeUnit) {
    const out = [];
    const concurrency = 5;
    for (let i = 0; i < campIds.length; i += concurrency) {
      const batch = campIds.slice(i, i + concurrency);
      const results = await Promise.allSettled(batch.map(no => fetchReportPerformanceDetail({
        ...baseArgs, reportAdUnit: 'CAMPAIGN', adUnitNo: no,
        reportDimension: dimension, placeUnit,
      })));
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled' && Array.isArray(r.value)) {
          const cId = batch[idx];
          r.value.forEach(row => {
            const n = normalizeRow(row);
            n._campId = cId; n._campName = campNameMap[cId] || cId;
            out.push(n);
          });
        }
      });
    }
    return out;
  }
  async function fetchPerAdgroup(dimension, placeUnit) {
    const out = [];
    const concurrency = 5;
    for (let i = 0; i < agIds.length; i += concurrency) {
      const batch = agIds.slice(i, i + concurrency);
      const results = await Promise.allSettled(batch.map(no => fetchReportPerformanceDetail({
        ...baseArgs, reportAdUnit: 'AD_SET', adUnitNo: no,
        reportDimension: dimension, placeUnit,
      })));
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled' && Array.isArray(r.value)) {
          const aId = batch[idx]; const meta = agNameMap[aId] || {};
          r.value.forEach(row => {
            const n = normalizeRow(row);
            n._agId = aId; n._agName = meta.name || aId;
            n._campId = meta.campId; n._campName = meta.campName;
            out.push(n);
          });
        }
      });
    }
    return out;
  }

  // 4) 모두 병렬 호출
  const [
    campGenderRows, campAgeRows, campPlaceRows,
    agGenderRows, agAgeRows, agPlaceRows,
  ] = await Promise.all([
    fetchPerCampaign('GENDER', undefined).catch(() => []),
    fetchPerCampaign('AGE', undefined).catch(() => []),
    fetchPerCampaign('TOTAL', 'PLACEMENT_GROUP').catch(() => []),
    fetchPerAdgroup('GENDER', undefined).catch(() => []),
    fetchPerAdgroup('AGE', undefined).catch(() => []),
    fetchPerAdgroup('TOTAL', 'PLACEMENT_GROUP').catch(() => []),
  ]);

  // 5) 일별 추이 (캠페인+DAY)
  let dailyRows = [];
  try {
    const daily = await fetchReportPerformance({ ...baseArgs, reportAdUnit: 'CAMPAIGN', dateUnit: 'DAY' });
    dailyRows = (daily || []).map(normalizeRow);
  } catch (e) { /* skip */ }
  const byDateMap = {};
  dailyRows.forEach(r => {
    let date = r.targetDate;
    if (!date && r.targetYear) date = `${r.targetYear}-${String(r.targetMonth || 1).padStart(2, '0')}-${String(r.targetDay || 1).padStart(2, '0')}`;
    if (!date) return;
    if (!byDateMap[date]) byDateMap[date] = { date, imp: 0, clk: 0, cost: 0, purchaseConvCount: 0, purchaseConvSales: 0, convCount: 0 };
    byDateMap[date].imp += r.imp; byDateMap[date].clk += r.clk; byDateMap[date].cost += r.cost;
    byDateMap[date].purchaseConvCount += r.purchaseConvCount;
    byDateMap[date].purchaseConvSales += r.purchaseConvSales;
    byDateMap[date].convCount += r.convCount;
  });
  const byDate = Object.values(byDateMap).map(d => {
    d.ctr = d.imp > 0 ? d.clk / d.imp * 100 : 0;
    d.purchaseRoas = d.cost > 0 ? d.purchaseConvSales / d.cost * 100 : 0;
    return d;
  }).sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  return {
    total: buildTotals(campRows),
    byCampaign: groupBy(campRows, r => r.campaignNo, r => r.campaignName).sort((a, b) => b.cost - a.cost),
    byAdgroup: groupBy(agRows, r => r.adSetNo, r => r.adSetName).sort((a, b) => b.cost - a.cost),
    byCreative: groupBy(crRows, r => r.creativeNo, r => r.creativeName).sort((a, b) => b.cost - a.cost),
    byGender: groupBy(accGenderRows, r => r.gender || '_unknown', r => genderLabel(r.gender)).sort((a, b) => b.cost - a.cost),
    byAge: groupBy(accAgeRows, r => r.ageGroup || '_unknown', r => ageLabel(r.ageGroup)).sort((a, b) => ageSortKey(a._key) - ageSortKey(b._key)),

    // 캠페인+세그먼트 단위 (Excel 시트용 raw rows, _campName 포함)
    byCampaignGender: campGenderRows,
    byCampaignAge: campAgeRows,
    byCampaignPlacement: campPlaceRows,
    byAdgroupGender: agGenderRows,
    byAdgroupAge: agAgeRows,
    byAdgroupPlacement: agPlaceRows,

    byDate,
  };
}

function genderLabel(g) {
  if (!g || g === 'U' || g === 'UNKNOWN' || g === 'GROUP_UNKNOWN') return '알수없음';
  return ({ M: '남성', F: '여성' })[g] || g;
}
function ageLabel(a) {
  if (!a || a === 'GROUP_UNKNOWN' || a === 'UNKNOWN') return '알수없음';
  const m = String(a).match(/(\d+)/);
  return m ? m[1] + '대' : a;
}
function ageSortKey(a) {
  if (!a || a === 'GROUP_UNKNOWN' || a === 'UNKNOWN') return 9999;
  const m = String(a).match(/(\d+)/);
  return m ? parseInt(m[1]) : 9998;
}

/**
 * 전체 리포트 데이터 (현재 + 이전 기간)
 */
async function collectDaReportData(account, type, customRange) {
  const dateRange = customRange && customRange.since && customRange.until ? customRange : getDateRange(type);
  const period = customRange && customRange.since && customRange.until
    ? `${customRange.since.replace(/-/g,'.')} ~ ${customRange.until.replace(/-/g,'.')} (맞춤)`
    : getPeriodLabel(type, dateRange);
  const overallTimeout = type === 'monthly' ? 240000 : 120000;
  const timeoutPromise = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`DA 리포트 시간 초과(${overallTimeout / 1000}s)`)), overallTimeout)
  );
  const data = await Promise.race([collectDaData(account, dateRange), timeoutPromise]);

  let prevData = null;
  const prevRange = getPrevDateRange(type, dateRange);
  if (prevRange) {
    try {
      prevData = await Promise.race([
        collectDaData(account, prevRange),
        new Promise((_, rej) => setTimeout(() => rej(new Error('prev timeout')), 60000)),
      ]);
    } catch (e) { console.log('  ⚠️ DA 이전기간 스킵:', e.message); }
  }
  return { data, prevData, period };
}

// ─── HTML 헬퍼 (sender.js와 같은 디자인 톤) ────────────────────────
function trendBadge(curr, prev) {
  if (prev === null || prev === undefined) return '';
  const diff = curr - prev;
  if (diff > 0) return `<span style="color:#16a34a;font-size:11px">▲${f.num(Math.abs(diff))}</span>`;
  if (diff < 0) return `<span style="color:#dc2626;font-size:11px">▼${f.num(Math.abs(diff))}</span>`;
  return `<span style="color:#9ca3af;font-size:11px">-</span>`;
}
function cmpPctBadge(curr, prev) {
  if (prev === null || prev === undefined) return '';
  const diff = curr - prev;
  const pct = prev !== 0 ? Math.round((curr - prev) / Math.abs(prev) * 100) : (curr > 0 ? 100 : 0);
  if (diff > 0) return `<span style="color:#16a34a;font-size:11px">▲${pct}%</span>`;
  if (diff < 0) return `<span style="color:#dc2626;font-size:11px">▼${Math.abs(pct)}%</span>`;
  return `<span style="color:#9ca3af;font-size:11px">-</span>`;
}
function barChart(items, maxVal, color = '#3b82f6') {
  if (!maxVal) maxVal = 1;
  return items.map(it => {
    const w = Math.max(Math.round(it.value / maxVal * 100), 1);
    return `<div style="margin-bottom:6px;display:flex;align-items:center;gap:8px">
      <div style="width:120px;font-size:11px;color:#374151;text-align:right;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${it.label}</div>
      <div style="flex:1;background:#f3f4f6;border-radius:4px;height:18px;overflow:hidden">
        <div style="width:${w}%;background:${color};height:100%;border-radius:4px;min-width:2px"></div>
      </div>
      <div style="width:90px;font-size:11px;font-weight:600;text-align:right;flex-shrink:0">${it.display}</div>
    </div>`;
  }).join('');
}
function makeTable(headers, rows) {
  const thStyle = 'padding:8px 10px;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.03em;border-bottom:2px solid #e5e7eb;background:#f9fafb';
  const tdStyle = 'padding:8px 10px;font-size:12px;border-bottom:1px solid #f3f4f6';
  let html = '<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:12px">';
  html += '<thead><tr>';
  headers.forEach(h => { html += `<th style="${thStyle};text-align:${h.align || 'left'}">${h.label}</th>`; });
  html += '</tr></thead><tbody>';
  rows.forEach((row, i) => {
    const bg = i % 2 === 0 ? '#ffffff' : '#fafbfc';
    html += `<tr style="background:${bg}">`;
    row.forEach((cell, j) => {
      const align = headers[j]?.align || 'left';
      const color = cell.color || '#111827';
      const bold = cell.bold ? 'font-weight:600;' : '';
      const cellBg = cell.bg ? `background:${cell.bg};` : '';
      const val = typeof cell === 'object' ? cell.v : cell;
      html += `<td style="${tdStyle};text-align:${align};color:${color};${bold}${cellBg}">${val}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  return html;
}
function section(title, icon, content) {
  return `
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;margin-bottom:16px;overflow:hidden">
    <div style="padding:14px 20px;border-bottom:1px solid #f3f4f6;display:flex;align-items:center;gap:8px">
      <span style="font-size:16px">${icon}</span>
      <span style="font-size:14px;font-weight:700;color:#111827">${title}</span>
    </div>
    <div style="padding:16px 20px">${content}</div>
  </div>`;
}

// ─── HTML 리포트 빌더 ─────────────────────────────────────────────
function buildDaHtmlReport({ type, period, accountName, data, prevData }) {
  const typeLabel = { daily: '일간', weekly: '주간', monthly: '월간' }[type] || type;
  const now = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
  const t = data.total;
  const pt = prevData?.total || null;

  const metricHeaders = [
    { label: '총비용', align: 'right' },
    { label: '노출수', align: 'right' },
    { label: '클릭수', align: 'right' },
    { label: 'CTR', align: 'right' },
    { label: 'CPC', align: 'right' },
    { label: '전환', align: 'right' },
    { label: '구매전환', align: 'right' },
    { label: '구매매출', align: 'right' },
    { label: '구매ROAS', align: 'right' },
  ];
  function metricRow(d) {
    return [
      { v: f.won(d.cost) },
      { v: f.num(d.imp) },
      { v: f.num(d.clk), color: '#1d4ed8', bold: true },
      { v: f.pct(d.ctr) },
      { v: f.won(d.cpc) },
      { v: f.num(d.convCount) },
      { v: f.num(d.purchaseConvCount), color: '#7c3aed', bold: true },
      { v: f.won(d.purchaseConvSales), color: '#16a34a' },
      { v: (d.purchaseRoas || 0).toFixed(2) + '%', color: (d.purchaseRoas || 0) >= 100 ? '#16a34a' : '#dc2626', bold: true },
    ];
  }

  // 1. 헤더 (네이버 그린 + DA 표시)
  let html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${accountName} ${typeLabel} DA 리포트</title>
<style>*{box-sizing:border-box}body{margin:0;padding:0;background:#f0f2f5;font-family:'Apple SD Gothic Neo','Noto Sans KR','Malgun Gothic',sans-serif;color:#111827;font-size:13px}</style>
</head><body>
<div style="max-width:900px;margin:0 auto;padding:20px 12px">

<div style="background:linear-gradient(135deg,#03c75a,#02a84e);border-radius:14px 14px 0 0;padding:28px 28px 22px">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px">
    <div>
      <p style="margin:0;color:rgba(255,255,255,0.7);font-size:12px;letter-spacing:.05em">NAVER DISPLAY AD REPORT</p>
      <h1 style="margin:6px 0 0;color:#fff;font-size:22px;font-weight:800">${accountName} · ${typeLabel} DA 성과 리포트</h1>
      <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:13px">📅 ${period}</p>
    </div>
    <div style="text-align:right">
      <p style="margin:0;color:rgba(255,255,255,0.6);font-size:11px">발송일</p>
      <p style="margin:2px 0 0;color:#fff;font-size:13px;font-weight:600">${now}</p>
    </div>
  </div>
</div>
`;

  // 2. KPI 카드
  const kpiCards = [
    { icon: '💰', label: '총비용', value: f.won(t.cost), trend: pt ? trendBadge(t.cost, pt.cost) : '', color: '#ef4444' },
    { icon: '👁', label: '노출수', value: f.num(t.imp), trend: pt ? trendBadge(t.imp, pt.imp) : '' },
    { icon: '🖱', label: '클릭수', value: f.num(t.clk), trend: pt ? trendBadge(t.clk, pt.clk) : '', color: '#2563eb' },
    { icon: '📊', label: 'CTR', value: f.pct(t.ctr), trend: '' },
    { icon: '💵', label: 'CPC', value: f.won(t.cpc), trend: '' },
    { icon: '📈', label: 'CPM', value: f.won(t.cpm), trend: '' },
    { icon: '🛒', label: '구매전환매출', value: f.won(t.purchaseConvSales), trend: pt ? trendBadge(t.purchaseConvSales, pt.purchaseConvSales) : '', color: '#16a34a' },
    { icon: '🎯', label: '구매ROAS', value: (t.purchaseRoas || 0).toFixed(2) + '%', trend: '', color: (t.purchaseRoas || 0) >= 100 ? '#16a34a' : '#ef4444' },
    { icon: '🔄', label: '구매전환수', value: f.num(t.purchaseConvCount), trend: pt ? trendBadge(t.purchaseConvCount, pt.purchaseConvCount) : '', color: '#7c3aed' },
    { icon: '🧺', label: '장바구니', value: f.num(t.cartConvCount), trend: '' },
  ];
  html += `<div style="background:#fff;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;padding:20px 20px 10px">
  <table width="100%" cellspacing="0" cellpadding="0"><tr>`;
  kpiCards.forEach((card, i) => {
    if (i > 0 && i % 5 === 0) html += '</tr></table><table width="100%" cellspacing="0" cellpadding="0" style="margin-top:8px"><tr>';
    html += `<td style="width:20%;padding:4px 5px;vertical-align:top">
      <table width="100%" cellspacing="0" cellpadding="0" style="background:#f9fafb;border-radius:10px;border:1px solid #f0f0f0;height:110px">
        <tr><td style="text-align:center;padding:12px 8px;vertical-align:middle">
          <div style="font-size:18px;margin-bottom:4px">${card.icon}</div>
          <div style="font-size:10px;color:#6b7280;margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap">${card.label}</div>
          <div style="font-size:17px;font-weight:800;color:${card.color || '#111827'}">${card.value}</div>
          ${card.trend ? `<div style="margin-top:2px;font-size:11px">${card.trend}</div>` : ''}
        </td></tr>
      </table>
    </td>`;
  });
  html += '</tr></table></div>';

  // 3. 캠페인별 성과
  if (data.byCampaign.length > 0) {
    const maxCost = Math.max(...data.byCampaign.map(d => d.cost), 1);
    const chartHtml = barChart(
      data.byCampaign.slice(0, 15).map(d => ({ label: d._label, value: d.cost, display: f.won(d.cost) })),
      maxCost, '#ef4444'
    );
    const rows = data.byCampaign.map(d => [{ v: d._label, bold: true }, ...metricRow(d)]);
    rows.push([{ v: '합계', bold: true, color: '#111827', bg: '#f1f5f9' }, ...metricRow(t).map(c => ({ ...c, bg: '#f1f5f9', bold: true }))]);
    const tableHtml = makeTable([{ label: '캠페인', align: 'left' }, ...metricHeaders], rows);
    html += section('캠페인별 성과', '📋', `
      <div style="margin-bottom:16px">${chartHtml}</div>
      <div style="overflow-x:auto">${tableHtml}</div>
    `);
  }

  // 4. 광고그룹별 성과 (상위 15개)
  if (data.byAdgroup.length > 0) {
    const top = data.byAdgroup.slice(0, 15);
    const rows = top.map(d => [{ v: d._label, bold: true }, ...metricRow(d)]);
    const tableHtml = makeTable([{ label: '광고그룹', align: 'left' }, ...metricHeaders], rows);
    html += section('광고그룹별 성과 (상위 15개)', '📁', `<div style="overflow-x:auto">${tableHtml}</div>`);
  }

  // 5. 소재별 성과 (상위 10개)
  if (data.byCreative.length > 0) {
    const top = data.byCreative.slice(0, 10);
    const rows = top.map(d => [{ v: d._label, bold: true }, ...metricRow(d)]);
    const tableHtml = makeTable([{ label: '소재', align: 'left' }, ...metricHeaders], rows);
    html += section('소재별 성과 (상위 10개)', '🎨', `<div style="overflow-x:auto">${tableHtml}</div>`);
  }

  // 6. 성별 + 연령 (2개 column)
  let demHtml = '';
  if (data.byGender.length > 0) {
    const rows = data.byGender.map(d => [{ v: d._label, bold: true }, ...metricRow(d)]);
    demHtml += '<div style="margin-bottom:16px"><div style="font-size:13px;font-weight:600;margin-bottom:8px;color:#374151">👥 성별</div>';
    demHtml += '<div style="overflow-x:auto">' + makeTable([{ label: '성별', align: 'left' }, ...metricHeaders], rows) + '</div></div>';
  }
  if (data.byAge.length > 0) {
    const rows = data.byAge.map(d => [{ v: d._label, bold: true }, ...metricRow(d)]);
    demHtml += '<div><div style="font-size:13px;font-weight:600;margin-bottom:8px;color:#374151">🎂 연령대</div>';
    demHtml += '<div style="overflow-x:auto">' + makeTable([{ label: '연령대', align: 'left' }, ...metricHeaders], rows) + '</div></div>';
  }
  if (demHtml) html += section('인구통계 분석', '👥', demHtml);

  // 7. 노출지면별 (캠페인별 데이터에서 집계)
  const placeAgg = {};
  (data.byCampaignPlacement || []).forEach(r => {
    const k = r.publisherGroupCode || r.placementGroupCode || '_unknown';
    if (!placeAgg[k]) placeAgg[k] = { _key: k, _label: k === '_unknown' ? '알수없음' : k, imp: 0, clk: 0, cost: 0, convCount: 0, purchaseConvCount: 0, purchaseConvSales: 0 };
    placeAgg[k].imp += r.imp; placeAgg[k].clk += r.clk; placeAgg[k].cost += r.cost;
    placeAgg[k].convCount += r.convCount;
    placeAgg[k].purchaseConvCount += r.purchaseConvCount;
    placeAgg[k].purchaseConvSales += r.purchaseConvSales;
  });
  const byPlace = Object.values(placeAgg).map(d => {
    d.ctr = d.imp > 0 ? d.clk / d.imp * 100 : 0;
    d.cpc = d.clk > 0 ? Math.round(d.cost / d.clk) : 0;
    d.purchaseRoas = d.cost > 0 ? d.purchaseConvSales / d.cost * 100 : 0;
    return d;
  }).sort((a, b) => b.cost - a.cost);
  if (byPlace.length > 0) {
    const top = byPlace.slice(0, 15);
    const totalCost = byPlace.reduce((s, r) => s + r.cost, 0) || 1;
    top.forEach(r => { r._costPct = (r.cost / totalCost * 100).toFixed(1); });
    const rows = top.map(d => [{ v: d._label, bold: true }, ...metricRow(d), { v: d._costPct + '%' }]);
    const tableHtml = makeTable([{ label: '매체/지면', align: 'left' }, ...metricHeaders, { label: '비용비중', align: 'right' }], rows);
    html += section('노출지면별 성과 (상위 15개)', '📍', `<div style="overflow-x:auto">${tableHtml}</div>`);
  }

  // 8. 기간 비교 (주간/월간만)
  if (prevData && type !== 'daily') {
    const cmpLabel = { weekly: '전주 대비', monthly: '전월 대비' }[type] || '전기 대비';
    const currLabel = { weekly: '금주', monthly: '당월' }[type] || '당기';
    const prevLabelStr = { weekly: '전주', monthly: '전월' }[type] || '전기';
    // 캠페인별 비교 (top 5 by current cost)
    const currMap = {}; data.byCampaign.forEach(c => { currMap[c._key] = c; });
    const prevMap = {}; prevData.byCampaign.forEach(c => { prevMap[c._key] = c; });
    const allKeys = [...new Set([...Object.keys(currMap), ...Object.keys(prevMap)])];
    const sorted = allKeys.sort((a, b) => ((currMap[b] || {}).cost || 0) - ((currMap[a] || {}).cost || 0)).slice(0, 5);
    if (sorted.length > 0) {
      const cmpHeaders = [
        { label: '캠페인', align: 'left' }, { label: '기간', align: 'center' },
        { label: '총비용', align: 'right' }, { label: '클릭', align: 'right' },
        { label: 'CTR', align: 'right' }, { label: '구매전환', align: 'right' },
        { label: '구매매출', align: 'right' }, { label: '구매ROAS', align: 'right' },
      ];
      const empty = { cost: 0, clk: 0, ctr: 0, purchaseConvCount: 0, purchaseConvSales: 0, purchaseRoas: 0, _label: '' };
      const cmpRows = [];
      for (const k of sorted) {
        const c = currMap[k] || empty;
        const p = prevMap[k] || empty;
        const label = c._label || p._label || k;
        cmpRows.push([
          { v: label, bold: true }, { v: currLabel },
          { v: f.won(c.cost) }, { v: f.num(c.clk), color: '#1d4ed8', bold: true },
          { v: f.pct(c.ctr) }, { v: f.num(c.purchaseConvCount), color: '#7c3aed', bold: true },
          { v: f.won(c.purchaseConvSales), color: '#16a34a' }, { v: (c.purchaseRoas || 0).toFixed(2) + '%', color: (c.purchaseRoas || 0) >= 100 ? '#16a34a' : '#dc2626', bold: true },
        ]);
        cmpRows.push([
          { v: label, color: '#9ca3af' }, { v: prevLabelStr, color: '#9ca3af' },
          { v: f.won(p.cost), color: '#9ca3af' }, { v: f.num(p.clk), color: '#9ca3af' },
          { v: f.pct(p.ctr), color: '#9ca3af' }, { v: f.num(p.purchaseConvCount), color: '#9ca3af' },
          { v: f.won(p.purchaseConvSales), color: '#9ca3af' }, { v: (p.purchaseRoas || 0).toFixed(2) + '%', color: '#9ca3af' },
        ]);
        cmpRows.push([
          { v: '' }, { v: cmpLabel, color: '#6b7280' },
          { v: cmpPctBadge(c.cost, p.cost) }, { v: cmpPctBadge(c.clk, p.clk) },
          { v: cmpPctBadge(c.ctr, p.ctr) }, { v: cmpPctBadge(c.purchaseConvCount, p.purchaseConvCount) },
          { v: cmpPctBadge(c.purchaseConvSales, p.purchaseConvSales) }, { v: cmpPctBadge(c.purchaseRoas, p.purchaseRoas) },
        ]);
      }
      html += section(`캠페인별 ${cmpLabel} (상위 5개)`, '📊', `<div style="overflow-x:auto">${makeTable(cmpHeaders, cmpRows)}</div>`);
    }
  }

  // 9. 푸터
  html += `
  <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 14px 14px;padding:20px;text-align:center;color:#6b7280;font-size:11px;line-height:1.6">
    이 리포트는 <strong>네이버 디스플레이광고(GFA)</strong>에서 자동 수집된 데이터를 기반으로 생성되었습니다.<br>
    문의는 광고 담당자에게 연락해주세요. · NEWMENT
  </div>
</div></body></html>`;
  return html;
}

// ─── Excel 리포트 빌더 (SA 스타일 컬러/포맷) ───────────────────────
async function buildDaExcelReport({ type, period, accountName, data, prevData }) {
  const ExcelJS = require('exceljs');
  const path = require('path');
  const fs = require('fs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NEWMENT';
  wb.created = new Date();
  const typeLabel = { daily: '일간', weekly: '주간', monthly: '월간' }[type] || type;

  // 로고
  let logoId = null;
  try {
    const lp = path.join(__dirname, '..', 'assets', 'logo.png');
    if (fs.existsSync(lp)) logoId = wb.addImage({ buffer: fs.readFileSync(lp), extension: 'png' });
  } catch (e) {}

  const C = {
    green: 'FF03C75A', dark: 'FF111827', white: 'FFFFFFFF',
    headerBg: 'FFF3F4F6', border: 'FFD9D9D9', altRow: 'FFFAFBFC',
    totalBg: 'FFF1F5F9', red: 'FFDC2626', blue: 'FF1D4ED8',
    gray: 'FF6B7280', purple: 'FF7C3AED', greenT: 'FF16A34A',
  };
  const FMT = { num: '#,##0', won: '₩#,##0', pct: '0.00"%"', roas: '0.00"%"' };
  const border = { top: { style: 'thin', color: { argb: C.border } }, bottom: { style: 'thin', color: { argb: C.border } }, left: { style: 'thin', color: { argb: C.border } }, right: { style: 'thin', color: { argb: C.border } } };
  const cm = { horizontal: 'center', vertical: 'middle' };

  function setupSheet(ws) {
    ws.properties.defaultRowHeight = 20;
    ws.views = [{ showGridLines: false }];
    ws.getColumn(1).width = 2;
  }
  function sectionHeader(ws, r, text, span) {
    const row = ws.getRow(r); row.height = 32;
    ws.mergeCells(r, 2, r, span);
    for (let c = 2; c <= span; c++) { row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.green } }; row.getCell(c).border = border; }
    const cell = row.getCell(2);
    cell.value = text; cell.font = { bold: true, size: 13, color: { argb: C.white } }; cell.alignment = cm;
    return r + 1;
  }
  function tableHeaderRow(ws, r, headers) {
    const row = ws.getRow(r); row.height = 26;
    headers.forEach((h, i) => {
      const c = row.getCell(i + 2);
      c.value = h; c.font = { bold: true, size: 10, color: { argb: C.dark } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
      c.alignment = cm; c.border = border;
    });
    return r + 1;
  }
  // 메트릭 헤더 (DA 표준 11열)
  const M_HEADERS = ['총비용', '노출수', '클릭수', 'CTR', 'CPC', 'CPM', '전환수', '구매전환', '구매매출', '구매ROAS', '장바구니'];
  const M_FMTS = [FMT.won, FMT.num, FMT.num, FMT.pct, FMT.won, FMT.won, FMT.num, FMT.num, FMT.won, FMT.roas, FMT.num];
  function dataRowMetric(ws, r, d, opts = {}) {
    const row = ws.getRow(r); row.height = 22;
    const sc = opts.startCol || 2;
    const labels = opts.labels || [];
    labels.forEach((lb, li) => {
      const c = row.getCell(sc + li);
      c.value = lb; c.font = { size: 10, bold: !!opts.bold, color: { argb: opts.labelColor || C.dark } };
      c.alignment = { horizontal: 'left', vertical: 'middle', wrapText: false }; c.border = border;
      if (opts.bg) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } };
      else if (opts.stripe) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.altRow } };
    });
    const ms = sc + labels.length;
    const vals = [d.cost || 0, d.imp || 0, d.clk || 0, d.ctr || 0, d.cpc || 0, d.cpm || 0, d.convCount || 0, d.purchaseConvCount || 0, d.purchaseConvSales || 0, d.purchaseRoas || 0, d.cartConvCount || 0];
    vals.forEach((v, i) => {
      const c = row.getCell(ms + i);
      c.value = v; c.numFmt = M_FMTS[i];
      c.font = { size: 10, bold: !!opts.bold, color: { argb: opts.bold ? C.dark : C.gray } };
      c.alignment = cm; c.border = border;
      if (opts.bg) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } };
      else if (opts.stripe) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.altRow } };
    });
    return r + 1;
  }

  // ──────────────────── 표지 시트 (요약) ────────────────────
  const ws0 = wb.addWorksheet('요약');
  setupSheet(ws0);
  // 컬럼 너비
  [22, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16].forEach((w, i) => ws0.getColumn(i + 2).width = w);
  // 로고 + 타이틀
  if (logoId !== null) ws0.addImage(logoId, { tl: { col: 1, row: 1 }, ext: { width: 350, height: 37 } });
  let r = 4;
  ws0.mergeCells(r, 2, r, 12);
  const titleCell = ws0.getRow(r).getCell(2);
  titleCell.value = `${accountName} · DA ${typeLabel} 성과 리포트`;
  titleCell.font = { bold: true, size: 18, color: { argb: C.dark } };
  titleCell.alignment = { horizontal: 'left', vertical: 'middle' };
  ws0.getRow(r).height = 32;
  r++;
  ws0.getRow(r).getCell(2).value = `📅 기간: ${period}    📤 발송일: ${new Date().toLocaleString('ko-KR')}`;
  ws0.getRow(r).getCell(2).font = { size: 11, color: { argb: C.gray } };
  ws0.mergeCells(r, 2, r, 12);
  r += 2;
  // 섹션: 핵심 지표
  r = sectionHeader(ws0, r, '🔑 핵심 지표', 12);
  // KPI 카드 형식 (각 셀)
  const t = data.total;
  const kpis = [
    ['총비용', t.cost, FMT.won, C.red],
    ['노출수', t.imp, FMT.num, C.dark],
    ['클릭수', t.clk, FMT.num, C.blue],
    ['CTR', t.ctr, FMT.pct, C.dark],
    ['CPC', t.cpc, FMT.won, C.dark],
    ['CPM', t.cpm, FMT.won, C.dark],
    ['전환수', t.convCount, FMT.num, C.purple],
    ['구매전환', t.purchaseConvCount, FMT.num, C.purple],
    ['구매매출', t.purchaseConvSales, FMT.won, C.greenT],
    ['구매ROAS', t.purchaseRoas, FMT.roas, t.purchaseRoas >= 100 ? C.greenT : C.red],
    ['장바구니', t.cartConvCount, FMT.num, C.dark],
  ];
  // 라벨 행
  const labelRow = ws0.getRow(r); labelRow.height = 24;
  kpis.forEach((k, i) => {
    const c = labelRow.getCell(i + 2);
    c.value = k[0]; c.font = { size: 10, color: { argb: C.gray } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
    c.alignment = cm; c.border = border;
  });
  r++;
  // 값 행
  const valRow = ws0.getRow(r); valRow.height = 32;
  kpis.forEach((k, i) => {
    const c = valRow.getCell(i + 2);
    c.value = k[1]; c.numFmt = k[2];
    c.font = { bold: true, size: 12, color: { argb: k[3] } };
    c.alignment = cm; c.border = border;
  });
  r += 2;

  // 캠페인별 표
  if (data.byCampaign.length) {
    r = sectionHeader(ws0, r, '📋 캠페인별 성과', 12);
    r = tableHeaderRow(ws0, r, ['캠페인', ...M_HEADERS]);
    data.byCampaign.forEach((c, i) => { r = dataRowMetric(ws0, r, c, { labels: [c._label || '-'], stripe: i % 2 === 1 }); });
    r = dataRowMetric(ws0, r, t, { labels: ['합계'], bold: true, bg: C.totalBg });
    r += 1;
  }

  // ──────────────────── 개별 시트 헬퍼 ────────────────────
  function addMetricSheet(sheetName, items, labelHeader, includeSum) {
    if (!items || !items.length) return;
    const ws = wb.addWorksheet(sheetName);
    setupSheet(ws);
    ws.getColumn(2).width = 32;
    for (let i = 0; i < M_HEADERS.length; i++) ws.getColumn(i + 3).width = 14;
    let rr = 1;
    rr = sectionHeader(ws, rr, sheetName, 12);
    rr = tableHeaderRow(ws, rr, [labelHeader, ...M_HEADERS]);
    items.forEach((d, i) => { rr = dataRowMetric(ws, rr, d, { labels: [d._label || '-'], stripe: i % 2 === 1 }); });
    if (includeSum && data.total) rr = dataRowMetric(ws, rr, data.total, { labels: ['합계'], bold: true, bg: C.totalBg });
    ws.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }];
  }

  // 캠페인+세그먼트 단위 시트 (캠페인 → 광고그룹 → 세그먼트 + 메트릭)
  function addSegmentedSheet(sheetName, items, segHeader, segFn) {
    if (!items || !items.length) return;
    const ws = wb.addWorksheet(sheetName);
    setupSheet(ws);
    [28, 24, 14, ...M_HEADERS.map(() => 14)].forEach((w, i) => ws.getColumn(i + 2).width = w);
    let rr = 1;
    rr = sectionHeader(ws, rr, sheetName, 14);
    rr = tableHeaderRow(ws, rr, ['캠페인', '광고그룹', segHeader, ...M_HEADERS]);
    items.forEach((d, i) => {
      rr = dataRowMetric(ws, rr, d, {
        labels: [d._campName || '-', d._agName || '-', segFn(d)],
        stripe: i % 2 === 1,
      });
    });
    ws.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }];
  }

  if (data.byAdgroup.length) addMetricSheet('광고그룹별', data.byAdgroup, '광고그룹');
  if (data.byCreative.length) addMetricSheet('소재별', data.byCreative, '소재');
  // 캠페인 단위 인구통계/지면
  addSegmentedSheet('캠페인별_성별', data.byCampaignGender, '성별', d => genderLabel(d.gender));
  addSegmentedSheet('캠페인별_연령', data.byCampaignAge, '연령대', d => ageLabel(d.ageGroup));
  addSegmentedSheet('캠페인별_노출지면', data.byCampaignPlacement, '매체/지면', d => d.publisherGroupCode || d.placementGroupCode || '알수없음');
  // 광고그룹 단위
  addSegmentedSheet('광고그룹별_성별', data.byAdgroupGender, '성별', d => genderLabel(d.gender));
  addSegmentedSheet('광고그룹별_연령', data.byAdgroupAge, '연령대', d => ageLabel(d.ageGroup));
  addSegmentedSheet('광고그룹별_노출지면', data.byAdgroupPlacement, '매체/지면', d => d.publisherGroupCode || d.placementGroupCode || '알수없음');

  return await wb.xlsx.writeBuffer();
}

// ─── Preview / Excel buffer / Send ──────────────────────────────────
async function generateDaPreview(account, type, customRange) {
  const { data, prevData, period } = await collectDaReportData(account, type, customRange);
  return buildDaHtmlReport({ type, period, accountName: account.name, data, prevData });
}
async function generateDaExcelBuffer(account, type, customRange) {
  const { data, prevData, period } = await collectDaReportData(account, type, customRange);
  return { buffer: await buildDaExcelReport({ type, period, accountName: account.name, data, prevData }), period };
}
async function generateAndSendDa(account, type, customRange) {
  const typeLabel = { daily: '일간', weekly: '주간', monthly: '월간' }[type];
  const { sendMailWithFallback } = require('../email/sender');
  const { data, prevData, period } = await collectDaReportData(account, type, customRange);
  const html = buildDaHtmlReport({ type, period, accountName: account.name, data, prevData });
  const excelBuffer = await buildDaExcelReport({ type, period, accountName: account.name, data, prevData });

  const recipients = (account.report_emails || '').split(',').map(e => e.trim()).filter(Boolean);
  if (!recipients.length) { console.warn(`⚠️ [${account.name}] DA 수신자 미설정`); return false; }
  if (!account.email_user || !account.email_pass) { console.warn(`⚠️ [${account.name}] SMTP 미설정`); return false; }
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safeName = (account.name || 'account').replace(/[\\/:*?"<>|]/g, '_');
  const mailOptions = {
    from: account.email_user,
    to: recipients.join(', '),
    subject: `📺 [${account.name}] DA ${typeLabel} 성과 리포트 - ${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6)}`,
    html,
    attachments: [{
      filename: `${safeName}_DA_${typeLabel}_리포트_${dateStr}.xlsx`,
      content: Buffer.from(excelBuffer),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }],
  };
  await sendMailWithFallback(account, mailOptions);
  console.log(`✅ [${account.name}] DA ${typeLabel} 리포트 → ${recipients.join(', ')}`);
  return true;
}

module.exports = { collectDaReportData, generateDaPreview, generateDaExcelBuffer, generateAndSendDa, buildDaHtmlReport, buildDaExcelReport };
