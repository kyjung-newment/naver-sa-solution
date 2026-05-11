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
 * 5분 타임아웃 가드
 */
async function collectDaData(account, dateRange) {
  const adAccountNo = account.da_account_no || account.customer_id;
  const baseArgs = { adAccountNo, cookie: account.naver_cookie, startDate: dateRange.since, endDate: dateRange.until };

  // 캠페인/그룹/소재 + 성별/연령 병렬
  const [campRows, agRows, crRows, genderRows, ageRows] = await Promise.allSettled([
    fetchReportPerformance({ ...baseArgs, reportAdUnit: 'CAMPAIGN' }),
    fetchReportPerformance({ ...baseArgs, reportAdUnit: 'AD_SET' }),
    fetchReportPerformance({ ...baseArgs, reportAdUnit: 'CREATIVE' }),
    fetchReportPerformanceDetail({ ...baseArgs, reportAdUnit: 'AD_ACCOUNT', reportDimension: 'GENDER' }),
    fetchReportPerformanceDetail({ ...baseArgs, reportAdUnit: 'AD_ACCOUNT', reportDimension: 'AGE' }),
  ]).then(results => results.map(r => r.status === 'fulfilled' ? (r.value || []).map(normalizeRow) : []));

  // 매체 그룹: AD_SET별 호출 → 집계 (병렬 5개씩)
  let placeRows = [];
  if (agRows.length > 0) {
    const adSetIds = [...new Set(agRows.map(r => r.adSetNo).filter(Boolean))];
    const concurrency = 5;
    for (let i = 0; i < adSetIds.length; i += concurrency) {
      const batch = adSetIds.slice(i, i + concurrency);
      const results = await Promise.allSettled(batch.map(no =>
        fetchReportPerformanceDetail({ ...baseArgs, reportAdUnit: 'AD_SET', adUnitNo: no, reportDimension: 'TOTAL', placeUnit: 'PLACEMENT_GROUP' })
      ));
      results.forEach(r => { if (r.status === 'fulfilled' && Array.isArray(r.value)) placeRows.push(...r.value.map(normalizeRow)); });
    }
  }

  // 일별 추이 (계정 단위)
  let dailyRows = [];
  try {
    const daily = await fetchReportPerformance({ ...baseArgs, reportAdUnit: 'AD_ACCOUNT', dateUnit: 'DAY' });
    dailyRows = (daily || []).map(normalizeRow);
  } catch (e) { /* skip */ }

  return {
    total: buildTotals(campRows),
    byCampaign: groupBy(campRows, r => r.campaignNo, r => r.campaignName).sort((a, b) => b.cost - a.cost),
    byAdgroup: groupBy(agRows, r => r.adSetNo, r => r.adSetName).sort((a, b) => b.cost - a.cost),
    byCreative: groupBy(crRows, r => r.creativeNo, r => r.creativeName).sort((a, b) => b.cost - a.cost),
    byGender: groupBy(genderRows, r => r.gender || '_unknown', r => genderLabel(r.gender)).sort((a, b) => b.cost - a.cost),
    byAge: groupBy(ageRows, r => r.ageGroup || '_unknown', r => ageLabel(r.ageGroup)).sort((a, b) => ageSortKey(a._key) - ageSortKey(b._key)),
    byPlacement: groupBy(placeRows, r => r.publisherGroupCode || r.placementGroupCode || '_unknown', r => (r.publisherGroupCode || r.placementGroupCode || '알수없음')).sort((a, b) => b.cost - a.cost),
    byDate: dailyRows.map(r => {
      const date = r.targetDate || r.scheduleString || '';
      return { date, imp: r.imp, clk: r.clk, cost: r.cost, purchaseConvCount: r.purchaseConvCount, purchaseConvSales: r.purchaseConvSales };
    }).filter(d => d.date).sort((a, b) => (a.date || '').localeCompare(b.date || '')),
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
async function collectDaReportData(account, type) {
  const dateRange = getDateRange(type);
  const period = getPeriodLabel(type, dateRange);
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

  // 7. 노출지면별
  if (data.byPlacement.length > 0) {
    const top = data.byPlacement.slice(0, 15);
    const totalCost = data.byPlacement.reduce((s, r) => s + r.cost, 0) || 1;
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

// ─── Excel 리포트 빌더 ─────────────────────────────────────────────
async function buildDaExcelReport({ type, period, accountName, data, prevData }) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NEWMENT';
  wb.created = new Date();
  const typeLabel = { daily: '일간', weekly: '주간', monthly: '월간' }[type] || type;

  const headerStyle = { font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF03C75A' } }, alignment: { horizontal: 'center', vertical: 'middle' } };
  const titleStyle = { font: { bold: true, size: 14 }, alignment: { horizontal: 'left' } };
  const sumStyle = { font: { bold: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } } };

  function addMetricSheet(sheetName, items, labelHeader, includeSum) {
    const ws = wb.addWorksheet(sheetName);
    ws.columns = [
      { header: labelHeader, key: 'label', width: 36 },
      { header: '총비용', key: 'cost', width: 14, style: { numFmt: '#,##0' } },
      { header: '노출수', key: 'imp', width: 12, style: { numFmt: '#,##0' } },
      { header: '클릭수', key: 'clk', width: 10, style: { numFmt: '#,##0' } },
      { header: 'CTR(%)', key: 'ctr', width: 10, style: { numFmt: '0.00' } },
      { header: 'CPC', key: 'cpc', width: 10, style: { numFmt: '#,##0' } },
      { header: '전환', key: 'convCount', width: 8, style: { numFmt: '#,##0' } },
      { header: '구매전환', key: 'purchaseConvCount', width: 10, style: { numFmt: '#,##0' } },
      { header: '구매매출', key: 'purchaseConvSales', width: 14, style: { numFmt: '#,##0' } },
      { header: '구매ROAS(%)', key: 'purchaseRoas', width: 12, style: { numFmt: '0.00' } },
    ];
    ws.getRow(1).eachCell(c => Object.assign(c, headerStyle));
    items.forEach(d => ws.addRow({
      label: d._label || '-', cost: d.cost, imp: d.imp, clk: d.clk, ctr: d.ctr,
      cpc: d.cpc, convCount: d.convCount, purchaseConvCount: d.purchaseConvCount,
      purchaseConvSales: d.purchaseConvSales, purchaseRoas: d.purchaseRoas,
    }));
    if (includeSum && data.total) {
      const sumRow = ws.addRow({
        label: '합계', cost: data.total.cost, imp: data.total.imp, clk: data.total.clk,
        ctr: data.total.ctr, cpc: data.total.cpc, convCount: data.total.convCount,
        purchaseConvCount: data.total.purchaseConvCount, purchaseConvSales: data.total.purchaseConvSales,
        purchaseRoas: data.total.purchaseRoas,
      });
      sumRow.eachCell(c => Object.assign(c, sumStyle));
    }
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  // Summary 시트
  const ws0 = wb.addWorksheet('요약');
  ws0.mergeCells('A1:C1');
  ws0.getCell('A1').value = `${accountName} · ${typeLabel} DA 성과 리포트`;
  ws0.getCell('A1').style = titleStyle;
  ws0.getCell('A2').value = `기간: ${period}`;
  ws0.getCell('A3').value = `발송일: ${new Date().toLocaleString('ko-KR')}`;
  const t = data.total;
  const rows = [
    ['총비용', t.cost], ['노출수', t.imp], ['클릭수', t.clk], ['CTR(%)', Number((t.ctr || 0).toFixed(2))],
    ['CPC', t.cpc], ['CPM', t.cpm], ['전환수', t.convCount], ['구매전환수', t.purchaseConvCount],
    ['구매전환매출', t.purchaseConvSales], ['구매ROAS(%)', Number((t.purchaseRoas || 0).toFixed(2))],
    ['장바구니수', t.cartConvCount], ['장바구니매출', t.cartConvSales],
  ];
  ws0.addRow([]);
  ws0.addRow(['지표', '값']);
  ws0.getRow(5).eachCell(c => Object.assign(c, headerStyle));
  rows.forEach(r => ws0.addRow(r));
  ws0.getColumn(1).width = 24;
  ws0.getColumn(2).width = 18;
  ws0.getColumn(2).numFmt = '#,##0';

  if (data.byCampaign.length) addMetricSheet('캠페인별', data.byCampaign, '캠페인', true);
  if (data.byAdgroup.length) addMetricSheet('광고그룹별', data.byAdgroup, '광고그룹');
  if (data.byCreative.length) addMetricSheet('소재별', data.byCreative, '소재');
  if (data.byGender.length) addMetricSheet('성별', data.byGender, '성별');
  if (data.byAge.length) addMetricSheet('연령대', data.byAge, '연령대');
  if (data.byPlacement.length) addMetricSheet('노출지면', data.byPlacement, '매체/지면');

  return await wb.xlsx.writeBuffer();
}

// ─── Preview / Excel buffer / Send ──────────────────────────────────
async function generateDaPreview(account, type) {
  const { data, prevData, period } = await collectDaReportData(account, type);
  return buildDaHtmlReport({ type, period, accountName: account.name, data, prevData });
}
async function generateDaExcelBuffer(account, type) {
  const { data, prevData, period } = await collectDaReportData(account, type);
  return { buffer: await buildDaExcelReport({ type, period, accountName: account.name, data, prevData }), period };
}
async function generateAndSendDa(account, type) {
  const typeLabel = { daily: '일간', weekly: '주간', monthly: '월간' }[type];
  const { sendMailWithFallback } = require('../email/sender');
  const { data, prevData, period } = await collectDaReportData(account, type);
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
