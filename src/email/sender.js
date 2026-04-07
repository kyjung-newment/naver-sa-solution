const nodemailer = require('nodemailer');

const transporterCache = new Map();

function getTransporter(account) {
  const key = `${account.email_host}:${account.email_user}`;
  if (!transporterCache.has(key)) {
    transporterCache.set(key, nodemailer.createTransport({
      host: account.email_host || 'smtp.gmail.com',
      port: account.email_port || 587,
      secure: false,
      auth: { user: account.email_user, pass: account.email_pass },
    }));
  }
  return transporterCache.get(key);
}

// ─── 포맷 헬퍼 ────────────────────────────────────────────────────
const f = {
  num: n => Number(n || 0).toLocaleString('ko-KR'),
  pct: n => `${Number(n || 0).toFixed(2)}%`,
  won: n => `₩${Number(n || 0).toLocaleString('ko-KR')}`,
  rank: n => n ? `${Number(n).toFixed(1)}` : '-',
};

function trendBadge(curr, prev) {
  if (prev === null || prev === undefined) return '';
  const diff = curr - prev;
  if (diff > 0) return `<span style="color:#16a34a;font-size:11px">▲${f.num(Math.abs(diff))}</span>`;
  if (diff < 0) return `<span style="color:#dc2626;font-size:11px">▼${f.num(Math.abs(diff))}</span>`;
  return `<span style="color:#9ca3af;font-size:11px">-</span>`;
}

// ─── CSS 바 차트 (이메일 호환) ──────────────────────────────────────
function barChart(items, maxVal, color = '#3b82f6') {
  if (!maxVal) maxVal = 1;
  return items.map(it => {
    const w = Math.max(Math.round(it.value / maxVal * 100), 1);
    return `<div style="margin-bottom:6px;display:flex;align-items:center;gap:8px">
      <div style="width:90px;font-size:11px;color:#374151;text-align:right;flex-shrink:0">${it.label}</div>
      <div style="flex:1;background:#f3f4f6;border-radius:4px;height:18px;overflow:hidden">
        <div style="width:${w}%;background:${color};height:100%;border-radius:4px;min-width:2px"></div>
      </div>
      <div style="width:75px;font-size:11px;font-weight:600;text-align:right;flex-shrink:0">${it.display}</div>
    </div>`;
  }).join('');
}

// ─── 테이블 생성 헬퍼 ──────────────────────────────────────────────
function makeTable(headers, rows) {
  const thStyle = 'padding:8px 10px;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.03em;border-bottom:2px solid #e5e7eb;background:#f9fafb';
  const tdStyle = 'padding:8px 10px;font-size:12px;border-bottom:1px solid #f3f4f6';

  let html = '<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:12px">';
  html += '<thead><tr>';
  headers.forEach(h => {
    const align = h.align || 'left';
    html += `<th style="${thStyle};text-align:${align}">${h.label}</th>`;
  });
  html += '</tr></thead><tbody>';
  rows.forEach((row, i) => {
    const bg = i % 2 === 0 ? '#ffffff' : '#fafbfc';
    html += `<tr style="background:${bg}">`;
    row.forEach((cell, j) => {
      const align = headers[j]?.align || 'left';
      const color = cell.color || '#111827';
      const bold = cell.bold ? 'font-weight:600;' : '';
      const val = typeof cell === 'object' ? cell.v : cell;
      html += `<td style="${tdStyle};text-align:${align};color:${color};${bold}">${val}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  return html;
}

// ─── 섹션 래퍼 ────────────────────────────────────────────────────
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

// ─── 메인 HTML 리포트 빌더 ─────────────────────────────────────────
function buildHtmlReport({ type, period, accountName, data, prevData }) {
  const typeLabel = { daily: '일간', weekly: '주간', monthly: '월간' }[type] || type;
  const now = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
  const t = data.total;
  const pt = prevData?.total || null;

  // ── 공통 테이블 헤더 ────────────────────────────────────────────
  const metricHeaders = [
    { label: '총비용', align: 'right' },
    { label: '노출수', align: 'right' },
    { label: '평균순위', align: 'right' },
    { label: '클릭수', align: 'right' },
    { label: 'CPC', align: 'right' },
    { label: 'CTR', align: 'right' },
    { label: '구매완료', align: 'right' },
    { label: '구매매출', align: 'right' },
    { label: 'ROAS', align: 'right' },
    { label: '장바구니', align: 'right' },
    { label: '장바구니매출', align: 'right' },
  ];

  function metricRow(d) {
    return [
      { v: f.won(d.cost) },
      { v: f.num(d.imp) },
      { v: f.rank(d.avgRank) },
      { v: f.num(d.clk), color: '#1d4ed8', bold: true },
      { v: f.won(d.cpc) },
      { v: f.pct(d.ctr) },
      { v: f.num(d.purchaseCnt), color: '#16a34a', bold: true },
      { v: f.won(d.purchaseAmt), color: '#16a34a' },
      { v: d.roas + '%', color: d.roas >= 100 ? '#16a34a' : '#dc2626', bold: true },
      { v: f.num(d.cartCnt) },
      { v: f.won(d.cartAmt) },
    ];
  }

  // ══════════════════════════════════════════════════════════════
  // 1. 헤더
  // ══════════════════════════════════════════════════════════════
  let html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${accountName} ${typeLabel} 리포트</title>
<style>*{box-sizing:border-box}body{margin:0;padding:0;background:#f0f2f5;font-family:'Apple SD Gothic Neo','Noto Sans KR','Malgun Gothic',sans-serif;color:#111827;font-size:13px}</style>
</head><body>
<div style="max-width:900px;margin:0 auto;padding:20px 12px">

<!-- 헤더 배너 -->
<div style="background:linear-gradient(135deg,#03c75a,#02a84e);border-radius:14px 14px 0 0;padding:28px 28px 22px">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px">
    <div>
      <p style="margin:0;color:rgba(255,255,255,0.7);font-size:12px;letter-spacing:.05em">NAVER SEARCH AD REPORT</p>
      <h1 style="margin:6px 0 0;color:#fff;font-size:22px;font-weight:800">${accountName} · ${typeLabel} 성과 리포트</h1>
      <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:13px">📅 ${period}</p>
    </div>
    <div style="text-align:right">
      <p style="margin:0;color:rgba(255,255,255,0.6);font-size:11px">발송일</p>
      <p style="margin:2px 0 0;color:#fff;font-size:13px;font-weight:600">${now}</p>
    </div>
  </div>
</div>
`;

  // ══════════════════════════════════════════════════════════════
  // 2. 요약 KPI 카드
  // ══════════════════════════════════════════════════════════════
  const kpiCards = [
    { icon: '💰', label: '총비용', value: f.won(t.cost), trend: pt ? trendBadge(t.cost, pt.cost) : '', color: '#ef4444' },
    { icon: '👁', label: '노출수', value: f.num(t.imp), trend: pt ? trendBadge(t.imp, pt.imp) : '' },
    { icon: '🖱', label: '클릭수', value: f.num(t.clk), trend: pt ? trendBadge(t.clk, pt.clk) : '', color: '#2563eb' },
    { icon: '📊', label: 'CTR', value: f.pct(t.ctr), trend: '' },
    { icon: '🎯', label: '평균순위', value: f.rank(t.avgRank) + '위', trend: '' },
    { icon: '💵', label: 'CPC', value: f.won(t.cpc), trend: '' },
    { icon: '🛒', label: '구매완료전환매출', value: f.won(t.purchaseAmt), trend: pt ? trendBadge(t.purchaseAmt, pt.purchaseAmt) : '', color: '#16a34a' },
    { icon: '📈', label: 'ROAS', value: t.roas + '%', trend: '', color: t.roas >= 100 ? '#16a34a' : '#ef4444' },
    { icon: '🔄', label: '구매완료전환수', value: f.num(t.purchaseCnt), trend: pt ? trendBadge(t.purchaseCnt, pt.purchaseCnt) : '' },
    { icon: '🧺', label: '장바구니수', value: f.num(t.cartCnt), trend: '' },
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

  // ══════════════════════════════════════════════════════════════
  // 3. 캠페인별 성과
  // ══════════════════════════════════════════════════════════════
  const campEntries = Object.entries(data.byCampaign).sort((a, b) => b[1].cost - a[1].cost);
  if (campEntries.length > 0) {
    const maxCost = Math.max(...campEntries.map(([, d]) => d.cost), 1);
    const chartHtml = barChart(
      campEntries.map(([, d]) => ({ label: d.name, value: d.cost, display: f.won(d.cost) })),
      maxCost, '#ef4444'
    );

    const rows = campEntries.map(([, d]) => [{ v: d.name, bold: true }, ...metricRow(d)]);
    const tableHtml = makeTable([{ label: '캠페인', align: 'left' }, ...metricHeaders], rows);

    html += section('캠페인별 성과', '📋', `
      <div style="margin-bottom:16px">${chartHtml}</div>
      <div style="overflow-x:auto">${tableHtml}</div>
    `);
  }

  // ══════════════════════════════════════════════════════════════
  // 4. 광고그룹별 성과 (Top 20)
  // ══════════════════════════════════════════════════════════════
  const agEntries = Object.entries(data.byAdgroup).sort((a, b) => b[1].cost - a[1].cost).slice(0, 20);
  if (agEntries.length > 0) {
    const rows = agEntries.map(([, d]) => [
      { v: d.campaignName, color: '#6b7280' },
      { v: d.name, bold: true },
      ...metricRow(d),
    ]);
    const tableHtml = makeTable([
      { label: '캠페인', align: 'left' },
      { label: '광고그룹', align: 'left' },
      ...metricHeaders,
    ], rows);
    html += section('광고그룹별 성과 (Top 20)', '📂', `<div style="overflow-x:auto">${tableHtml}</div>`);
  }

  // ══════════════════════════════════════════════════════════════
  // 5. PC / 모바일 성과
  // ══════════════════════════════════════════════════════════════
  const deviceEntries = Object.entries(data.byDevice).sort((a, b) => b[1].cost - a[1].cost);
  if (deviceEntries.length > 0) {
    // 파이 차트 대용: 비율 바
    const totalDeviceCost = deviceEntries.reduce((s, [, d]) => s + d.cost, 0) || 1;
    const totalDeviceClk = deviceEntries.reduce((s, [, d]) => s + d.clk, 0) || 1;
    let deviceChart = '<div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap">';
    deviceEntries.forEach(([device, d]) => {
      const costPct = Math.round(d.cost / totalDeviceCost * 100);
      const clkPct = Math.round(d.clk / totalDeviceClk * 100);
      const color = device === 'PC' ? '#3b82f6' : '#f97316';
      deviceChart += `<div style="flex:1;min-width:150px;background:#f9fafb;border-radius:10px;padding:16px;text-align:center;border:1px solid #f0f0f0">
        <div style="font-size:24px;margin-bottom:6px">${device === 'PC' ? '🖥' : '📱'}</div>
        <div style="font-size:16px;font-weight:800;color:${color}">${device}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:4px">비용 ${costPct}% · 클릭 ${clkPct}%</div>
        <div style="font-size:11px;color:#374151;margin-top:6px">CTR ${f.pct(d.ctr)} · CPC ${f.won(d.cpc)}</div>
      </div>`;
    });
    deviceChart += '</div>';

    const rows = deviceEntries.map(([device, d]) => [{ v: device, bold: true }, ...metricRow(d)]);
    const tableHtml = makeTable([{ label: '매체', align: 'left' }, ...metricHeaders], rows);
    html += section('PC / 모바일 성과', '📱', deviceChart + `<div style="overflow-x:auto">${tableHtml}</div>`);
  }

  // ══════════════════════════════════════════════════════════════
  // 6. 시간대별 성과
  // ══════════════════════════════════════════════════════════════
  const hourEntries = Object.entries(data.byHour).sort((a, b) => a[0].localeCompare(b[0]));
  if (hourEntries.length > 0) {
    const maxHourClk = Math.max(...hourEntries.map(([, d]) => d.clk), 1);
    const maxHourImp = Math.max(...hourEntries.map(([, d]) => d.imp), 1);

    // 시간대 히트맵 스타일 바 차트
    let hourChart = '<div style="margin-bottom:16px">';
    hourChart += '<div style="display:flex;align-items:flex-end;gap:2px;height:80px">';
    for (let h = 0; h < 24; h++) {
      const hKey = String(h).padStart(2, '0');
      const d = data.byHour[hKey];
      const clk = d ? d.clk : 0;
      const barH = Math.max(Math.round(clk / maxHourClk * 70), 2);
      const opacity = clk > 0 ? Math.max(0.3, clk / maxHourClk) : 0.1;
      hourChart += `<div style="flex:1;display:flex;flex-direction:column;align-items:center">
        <div style="width:100%;height:${barH}px;background:rgba(59,130,246,${opacity});border-radius:3px 3px 0 0"></div>
        <div style="font-size:9px;color:#9ca3af;margin-top:2px">${h}</div>
      </div>`;
    }
    hourChart += '</div>';
    hourChart += '<div style="text-align:center;font-size:10px;color:#9ca3af;margin-top:4px">시간대별 클릭수 분포 (0~23시)</div>';
    hourChart += '</div>';

    // 주요 시간대 Top 5
    const topHours = [...hourEntries].sort((a, b) => b[1].clk - a[1].clk).slice(0, 8);
    const rows = topHours.map(([h, d]) => [{ v: `${h}시`, bold: true }, ...metricRow(d)]);
    const tableHtml = makeTable([{ label: '시간', align: 'left' }, ...metricHeaders], rows);

    html += section('시간대별 성과', '🕐', hourChart + `<div style="overflow-x:auto">${tableHtml}</div>`);
  }

  // ══════════════════════════════════════════════════════════════
  // 7. 일자별 추이 (주간/월간만)
  // ══════════════════════════════════════════════════════════════
  const dateEntries = Object.entries(data.byDate).sort((a, b) => a[0].localeCompare(b[0]));
  if (dateEntries.length > 1) {
    const maxDateCost = Math.max(...dateEntries.map(([, d]) => d.cost), 1);
    const dateChart = barChart(
      dateEntries.map(([dt, d]) => {
        const dayOfWeek = ['일', '월', '화', '수', '목', '금', '토'][new Date(dt).getDay()];
        return { label: `${dt.slice(5)} (${dayOfWeek})`, value: d.cost, display: f.won(d.cost) };
      }),
      maxDateCost, '#8b5cf6'
    );

    const rows = dateEntries.map(([dt, d]) => {
      const dayOfWeek = ['일', '월', '화', '수', '목', '금', '토'][new Date(dt).getDay()];
      return [{ v: `${dt.slice(5)} (${dayOfWeek})`, bold: true }, ...metricRow(d)];
    });
    const tableHtml = makeTable([{ label: '일자', align: 'left' }, ...metricHeaders], rows);

    html += section('일자별 성과 추이', '📆', `
      <div style="margin-bottom:16px">${dateChart}</div>
      <div style="overflow-x:auto">${tableHtml}</div>
    `);
  }

  // ══════════════════════════════════════════════════════════════
  // 8. 핵심 인사이트 요약
  // ══════════════════════════════════════════════════════════════
  let insights = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">';

  // 비용 TOP 3 광고그룹
  const topCostAg = Object.entries(data.byAdgroup).sort((a, b) => b[1].cost - a[1].cost).slice(0, 3);
  insights += '<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px">';
  insights += '<div style="font-size:12px;font-weight:700;color:#dc2626;margin-bottom:8px">💸 비용 TOP 3 광고그룹</div>';
  topCostAg.forEach(([, d], i) => {
    insights += `<div style="font-size:12px;margin-bottom:3px;color:#374151">${i + 1}. <strong>${d.name}</strong> — ${f.won(d.cost)}</div>`;
  });
  insights += '</div>';

  // 클릭 TOP 3 광고그룹
  const topClkAg = Object.entries(data.byAdgroup).sort((a, b) => b[1].clk - a[1].clk).slice(0, 3);
  insights += '<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:14px">';
  insights += '<div style="font-size:12px;font-weight:700;color:#2563eb;margin-bottom:8px">🖱 클릭 TOP 3 광고그룹</div>';
  topClkAg.forEach(([, d], i) => {
    insights += `<div style="font-size:12px;margin-bottom:3px;color:#374151">${i + 1}. <strong>${d.name}</strong> — ${f.num(d.clk)}회 (CTR ${f.pct(d.ctr)})</div>`;
  });
  insights += '</div>';

  // CTR TOP 3 (최소 10 노출)
  const topCtrAg = Object.entries(data.byAdgroup).filter(([, d]) => d.imp >= 10).sort((a, b) => b[1].ctr - a[1].ctr).slice(0, 3);
  insights += '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px">';
  insights += '<div style="font-size:12px;font-weight:700;color:#16a34a;margin-bottom:8px">📊 CTR TOP 3 광고그룹</div>';
  topCtrAg.forEach(([, d], i) => {
    insights += `<div style="font-size:12px;margin-bottom:3px;color:#374151">${i + 1}. <strong>${d.name}</strong> — CTR ${f.pct(d.ctr)}</div>`;
  });
  insights += '</div>';

  // 구매전환 TOP 3 (있는 경우)
  const topPurchaseAg = Object.entries(data.byAdgroup).filter(([, d]) => d.purchaseAmt > 0).sort((a, b) => b[1].purchaseAmt - a[1].purchaseAmt).slice(0, 3);
  insights += '<div style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:10px;padding:14px">';
  insights += '<div style="font-size:12px;font-weight:700;color:#7c3aed;margin-bottom:8px">🏆 구매매출 TOP 광고그룹</div>';
  if (topPurchaseAg.length > 0) {
    topPurchaseAg.forEach(([, d], i) => {
      insights += `<div style="font-size:12px;margin-bottom:3px;color:#374151">${i + 1}. <strong>${d.name}</strong> — ${f.won(d.purchaseAmt)} (ROAS ${d.roas}%)</div>`;
    });
  } else {
    insights += '<div style="font-size:12px;color:#9ca3af">해당 기간 구매완료 전환 없음</div>';
  }
  insights += '</div>';
  insights += '</div>';

  // 최적 시간대
  if (hourEntries.length > 0) {
    const bestHours = [...hourEntries].sort((a, b) => b[1].clk - a[1].clk).slice(0, 3);
    insights += `<div style="margin-top:12px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:14px">
      <div style="font-size:12px;font-weight:700;color:#d97706;margin-bottom:8px">⏰ 클릭 최적 시간대</div>
      <div style="font-size:12px;color:#374151">${bestHours.map(([h, d]) => `<strong>${h}시</strong>(${f.num(d.clk)}회)`).join(' · ')}</div>
    </div>`;
  }

  html += section('핵심 인사이트 요약', '💡', insights);

  // ══════════════════════════════════════════════════════════════
  // 9. 푸터
  // ══════════════════════════════════════════════════════════════
  html += `
<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:0 0 14px 14px;padding:14px 20px;text-align:center">
  <p style="margin:0;font-size:11px;color:#9ca3af">이 리포트는 네이버 SA 솔루션에서 자동 발송되었습니다 · ${accountName}</p>
  <p style="margin:4px 0 0;font-size:10px;color:#d1d5db">데이터 출처: 네이버 검색광고 API (AD_DETAIL + AD_CONVERSION_DETAIL)</p>
</div>
</div></body></html>`;

  return html;
}

// ─── 이메일 발송 ────────────────────────────────────────────────────
async function sendReport({ account, type, period, data, prevData }) {
  const typeLabel = { daily: '일간', weekly: '주간', monthly: '월간' }[type] || type;
  const today = new Date().toLocaleDateString('ko-KR');
  const recipients = (account.report_emails || '').split(',').map(e => e.trim()).filter(Boolean);

  if (!recipients.length) {
    console.warn(`⚠️  [${account.name}] 수신 이메일 미설정`);
    return;
  }
  if (!account.email_user || !account.email_pass) {
    console.warn(`⚠️  [${account.name}] SMTP 미설정`);
    return;
  }

  const html = buildHtmlReport({ type, period, accountName: account.name, data, prevData });

  await getTransporter(account).sendMail({
    from: account.email_user,
    to: recipients.join(', '),
    subject: `📊 [${account.name}] ${typeLabel} 성과 리포트 - ${today}`,
    html,
    text: `네이버 SA ${typeLabel} 리포트\n광고주: ${account.name}\n기간: ${period}\n총비용: ${f.won(data.total.cost)}\n클릭: ${f.num(data.total.clk)}`,
  });

  console.log(`✅ [${account.name}] ${typeLabel} 리포트 → ${recipients.join(', ')}`);
}

module.exports = { sendReport, buildHtmlReport };
