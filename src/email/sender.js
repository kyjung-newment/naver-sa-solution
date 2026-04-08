const nodemailer = require('nodemailer');
const ExcelJS = require('exceljs');

const transporterCache = new Map();

function getTransporter(account) {
  // 캐시 키에 비밀번호 해시 포함 → 비밀번호 변경 시 자동으로 새 transporter 생성
  const passHash = (account.email_pass || '').slice(0, 4) + (account.email_pass || '').length;
  const key = `${account.email_host}:${account.email_user}:${passHash}`;
  if (!transporterCache.has(key)) {
    const port = parseInt(account.email_port) || 587;
    transporterCache.set(key, nodemailer.createTransport({
      host: account.email_host || 'smtp.gmail.com',
      port,
      secure: port === 465, // 465=SSL/TLS, 587=STARTTLS
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
    // 합계 행 추가
    rows.push([{ v: '합계', bold: true, color: '#111827', bg: '#f1f5f9' }, ...metricRow(data.total).map(c => ({ ...c, bg: '#f1f5f9', bold: true }))]);
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

    // 00시~23시 순서대로 전체 표시
    const rows = hourEntries.map(([h, d]) => [{ v: `${parseInt(h)}시`, bold: true }, ...metricRow(d)]);
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
  <p style="margin:0;font-size:11px;color:#9ca3af">이 리포트는 뉴먼트 솔루션에서 자동 발송되었습니다 · ${accountName}</p>
  <p style="margin:4px 0 0;font-size:10px;color:#d1d5db">데이터 출처: 네이버 검색광고 API (AD_DETAIL + AD_CONVERSION_DETAIL)</p>
</div>
</div></body></html>`;

  return html;
}

// ─── 엑셀 리포트 빌더 (프로페셔널 디자인) ─────────────────────────────────
async function buildExcelReport({ type, period, accountName, data, prevData }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '뉴먼트 솔루션';
  workbook.created = new Date();

  const typeLabel = { daily: '일간', weekly: '주간', monthly: '월간' }[type] || type;
  const t = data.total;
  const pt = prevData?.total || null;
  const now = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });

  // ─── 브랜드 컬러 ─────────────────────────────────────────────────
  const C = {
    primary: 'FF38AE49',      // 뉴먼트 그린
    primaryDark: 'FF2D9440',
    headerBg: 'FF212121',     // 다크 헤더
    headerText: 'FFFFFFFF',
    sectionBg: 'FF38AE49',    // 섹션 타이틀 (뉴먼트 그린)
    sectionText: 'FFFFFFFF',
    subHeaderBg: 'FFF7FAFC',  // 서브 헤더 (연회색)
    subHeaderText: 'FF212121',
    tableBorder: 'FFE2E8F0',
    altRow: 'FFF8FAFC',       // 줄무늬
    white: 'FFFFFFFF',
    topRankBg: 'FFFFFBEB',    // TOP 순위 하이라이트
    topRankBorder: 'FFFDE68A',
    totalBg: 'FFEDF2F7',
    red: 'FFDC2626',
    green: 'FF38AE49',        // 뉴먼트 그린
    blue: 'FF2563EB',
    gray: 'FF718096',
  };

  // ─── 포맷 상수 ───────────────────────────────────────────────────
  const FMT = {
    num: '#,##0', won: '₩#,##0', pct: '0.00"%"', rank: '0.0', roas: '0"%"',
  };

  // ─── 공통 스타일 헬퍼 ──────────────────────────────────────────────
  const thinBorder = (color = C.tableBorder) => ({
    top: { style: 'thin', color: { argb: color } },
    bottom: { style: 'thin', color: { argb: color } },
    left: { style: 'thin', color: { argb: color } },
    right: { style: 'thin', color: { argb: color } },
  });

  function addSectionTitle(sheet, rowNum, text, colSpan = 13) {
    const row = sheet.getRow(rowNum);
    row.height = 42;
    const cell = row.getCell(2);
    cell.value = text;
    cell.font = { bold: true, size: 14, color: { argb: C.sectionText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.sectionBg } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    if (colSpan > 1) {
      sheet.mergeCells(rowNum, 2, rowNum, colSpan);
      for (let c = 2; c <= colSpan; c++) {
        row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.sectionBg } };
      }
    }
    return rowNum + 1;
  }

  function addSubTitle(sheet, rowNum, text, colSpan = 13) {
    const row = sheet.getRow(rowNum);
    row.height = 28;
    const cell = row.getCell(2);
    cell.value = text;
    cell.font = { bold: true, size: 11, color: { argb: C.subHeaderText } };
    cell.alignment = { vertical: 'middle' };
    if (colSpan > 1) sheet.mergeCells(rowNum, 2, rowNum, colSpan);
    return rowNum + 1;
  }

  const metricHeaders = ['총비용', '노출수', '평균순위', '클릭수', 'CPC', 'CTR', '구매완료', '구매매출', 'ROAS', '장바구니', '장바구니매출'];
  const metricFmts = [FMT.won, FMT.num, FMT.rank, FMT.num, FMT.won, FMT.pct, FMT.num, FMT.won, FMT.roas, FMT.num, FMT.won];

  function addTableHeader(sheet, rowNum, firstHeaders = ['구분']) {
    const row = sheet.getRow(rowNum);
    row.height = 26;
    const allHeaders = [...firstHeaders, ...metricHeaders];
    allHeaders.forEach((h, i) => {
      const cell = row.getCell(i + 2);
      cell.value = h;
      cell.font = { bold: true, size: 10, color: { argb: C.subHeaderText } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.subHeaderBg } };
      cell.alignment = { horizontal: i === 0 ? 'left' : 'center', vertical: 'middle' };
      cell.border = thinBorder();
    });
    return rowNum + 1;
  }

  function addMetricRow(sheet, rowNum, label, d, opts = {}) {
    const row = sheet.getRow(rowNum);
    row.height = 23;
    const startCol = opts.startCol || 2;
    const labelCols = opts.labels || [label];

    // 라벨 셀
    labelCols.forEach((lb, li) => {
      const cell = row.getCell(startCol + li);
      cell.value = lb;
      cell.font = { size: 10, bold: !!opts.bold, color: { argb: opts.labelColor || C.subHeaderText } };
      cell.alignment = { vertical: 'middle' };
      cell.border = thinBorder();
      if (opts.bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } };
    });

    // 메트릭 셀
    const mStart = startCol + labelCols.length;
    const vals = [d.cost||0, d.imp||0, d.avgRank||0, d.clk||0, d.cpc||0, d.ctr||0, d.purchaseCnt||0, d.purchaseAmt||0, d.roas||0, d.cartCnt||0, d.cartAmt||0];
    vals.forEach((v, i) => {
      const cell = row.getCell(mStart + i);
      cell.value = v;
      cell.numFmt = metricFmts[i];
      cell.font = { size: 10, bold: !!opts.bold, color: { argb: opts.bold ? C.subHeaderText : C.gray } };
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
      cell.border = thinBorder();
      if (opts.bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } };
      else if (opts.stripe) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.altRow } };
    });

    return rowNum + 1;
  }

  function addDiffRow(sheet, rowNum, label, curr, prev, opts = {}) {
    const row = sheet.getRow(rowNum);
    row.height = 23;
    const startCol = opts.startCol || 2;
    const cell = row.getCell(startCol);
    cell.value = label;
    cell.font = { size: 10, italic: true, color: { argb: C.gray } };
    cell.alignment = { vertical: 'middle' };
    cell.border = thinBorder();

    const diffs = [
      curr.cost - prev.cost, curr.imp - prev.imp, (curr.avgRank||0) - (prev.avgRank||0),
      curr.clk - prev.clk, (curr.cpc||0) - (prev.cpc||0), (curr.ctr||0) - (prev.ctr||0),
      (curr.purchaseCnt||0) - (prev.purchaseCnt||0), (curr.purchaseAmt||0) - (prev.purchaseAmt||0),
      (curr.roas||0) - (prev.roas||0), (curr.cartCnt||0) - (prev.cartCnt||0), (curr.cartAmt||0) - (prev.cartAmt||0),
    ];
    const mStart = startCol + 1;
    diffs.forEach((v, i) => {
      const cell = row.getCell(mStart + i);
      cell.value = v;
      cell.numFmt = metricFmts[i];
      const isPositive = v > 0;
      // 비용/CPC: 증가=빨강, 감소=초록 / 나머지: 증가=초록, 감소=빨강
      const isCostLike = [0, 4].includes(i);
      cell.font = { size: 10, italic: true, color: { argb: v === 0 ? C.gray : ((isPositive === isCostLike) ? C.red : C.green) } };
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
      cell.border = thinBorder();
    });
    return rowNum + 1;
  }

  function setupSheetDefaults(sheet) {
    sheet.properties.defaultRowHeight = 20;
    sheet.views = [{ showGridLines: false }];
    // A열은 여백
    sheet.getColumn(1).width = 2;
  }

  function setMetricColumnWidths(sheet, firstColWidths = [22]) {
    firstColWidths.forEach((w, i) => { sheet.getColumn(i + 2).width = w; });
    const mStart = firstColWidths.length + 2;
    const mWidths = [14, 13, 10, 12, 12, 10, 10, 14, 10, 10, 14];
    mWidths.forEach((w, i) => { sheet.getColumn(mStart + i).width = w; });
  }

  // ══════════════════════════════════════════════════════════════════
  // 1. 표지 시트
  // ══════════════════════════════════════════════════════════════════
  const coverSheet = workbook.addWorksheet('표지');
  setupSheetDefaults(coverSheet);
  coverSheet.getColumn(2).width = 20;
  coverSheet.getColumn(3).width = 45;
  coverSheet.getColumn(4).width = 45;

  // 타이틀 배너
  let cr = 4;
  coverSheet.getRow(cr).height = 55;
  coverSheet.mergeCells(cr, 2, cr, 4);
  const titleCell = coverSheet.getRow(cr).getCell(2);
  titleCell.value = `${accountName} 네이버 검색광고 ${typeLabel} 보고서`;
  titleCell.font = { bold: true, size: 17, color: { argb: C.headerText } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.primary } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  for (let c = 2; c <= 4; c++) {
    coverSheet.getRow(cr).getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.primary } };
  }
  cr += 2;

  // 광고주 정보
  const coverInfo = [
    ['광고주', accountName],
    ['보고서 기간', period],
    ['보고서 유형', typeLabel + ' 리포트'],
    ['발행일', now],
    ['제작', '뉴먼트 솔루션 자동 리포트'],
  ];
  coverInfo.forEach(([label, value]) => {
    const row = coverSheet.getRow(cr);
    row.height = 26;
    const lc = row.getCell(2);
    lc.value = label;
    lc.font = { bold: true, size: 11, color: { argb: C.subHeaderText } };
    lc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.subHeaderBg } };
    lc.border = thinBorder();
    lc.alignment = { vertical: 'middle' };
    const vc = row.getCell(3);
    vc.value = value;
    vc.font = { size: 11, color: { argb: C.subHeaderText } };
    vc.border = thinBorder();
    vc.alignment = { vertical: 'middle' };
    cr++;
  });
  cr += 2;

  // INDEX
  const idxTitle = coverSheet.getRow(cr);
  idxTitle.height = 30;
  idxTitle.getCell(2).value = 'INDEX';
  idxTitle.getCell(2).font = { bold: true, size: 13, color: { argb: C.subHeaderText } };
  cr++;
  const idxHeader = coverSheet.getRow(cr);
  ['Sheet 순서', 'Sheet 명', '설명'].forEach((h, i) => {
    const cell = idxHeader.getCell(i + 2);
    cell.value = h;
    cell.font = { bold: true, size: 10, color: { argb: C.subHeaderText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.subHeaderBg } };
    cell.border = thinBorder();
  });
  cr++;
  const sheets = [
    ['요약', '전체 KPI 요약 및 전기 비교'],
    ['캠페인별', '캠페인별 성과 현황 (TOP 5 표시)'],
    ['광고그룹별', '광고그룹별 성과 현황 (TOP 10 표시)'],
    ['PC_모바일', 'PC/모바일 디바이스별 성과 비교'],
    ['시간대별', '시간대별(0~23시) 성과 분포'],
    ['일자별', '일자별 성과 추이'],
  ];
  sheets.forEach(([name, desc], i) => {
    const row = coverSheet.getRow(cr + i);
    row.height = 22;
    [{ v: `sheet${i + 1}`, bold: false }, { v: name, bold: true }, { v: desc, bold: false }].forEach((item, j) => {
      const cell = row.getCell(j + 2);
      cell.value = item.v;
      cell.font = { size: 10, bold: item.bold, color: { argb: C.subHeaderText } };
      cell.border = thinBorder();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 2. 요약 시트
  // ══════════════════════════════════════════════════════════════════
  const sumSheet = workbook.addWorksheet('요약');
  setupSheetDefaults(sumSheet);
  sumSheet.getColumn(2).width = 18;
  sumSheet.getColumn(3).width = 20;
  sumSheet.getColumn(4).width = 20;
  sumSheet.getColumn(5).width = 18;
  sumSheet.getColumn(6).width = 3;
  sumSheet.getColumn(7).width = 18;
  sumSheet.getColumn(8).width = 20;
  sumSheet.getColumn(9).width = 20;
  sumSheet.getColumn(10).width = 18;

  let sr = 3;
  sr = addSectionTitle(sumSheet, sr, `${accountName} · ${typeLabel} 성과 요약`, 10);
  sr++;

  // KPI 카드 (2행 x 5열)
  const kpis = [
    { label: '총비용', value: t.cost||0, fmt: FMT.won, prev: pt?.cost, isCost: true },
    { label: '노출수', value: t.imp||0, fmt: FMT.num, prev: pt?.imp },
    { label: '클릭수', value: t.clk||0, fmt: FMT.num, prev: pt?.clk },
    { label: 'CTR', value: t.ctr||0, fmt: FMT.pct, prev: pt?.ctr },
    { label: '평균순위', value: t.avgRank||0, fmt: FMT.rank, prev: pt?.avgRank, isCost: true },
    { label: 'CPC', value: t.cpc||0, fmt: FMT.won, prev: pt?.cpc, isCost: true },
    { label: '구매매출', value: t.purchaseAmt||0, fmt: FMT.won, prev: pt?.purchaseAmt },
    { label: 'ROAS', value: t.roas||0, fmt: FMT.roas, prev: pt?.roas },
    { label: '구매전환수', value: t.purchaseCnt||0, fmt: FMT.num, prev: pt?.purchaseCnt },
    { label: '장바구니수', value: t.cartCnt||0, fmt: FMT.num, prev: pt?.cartCnt },
  ];

  // KPI 라벨 행
  const kpiLabelRow = sumSheet.getRow(sr);
  kpiLabelRow.height = 20;
  kpis.slice(0, 5).forEach((kpi, i) => {
    const cell = kpiLabelRow.getCell(2 + i * 2 - (i > 0 ? i : 0));
    // 2열 사용: 2,4,6,8,10
    const col = 2 + i;
    const c = kpiLabelRow.getCell(col);
    c.value = kpi.label;
    c.font = { size: 9, color: { argb: C.gray } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  sr++;

  // KPI 값 행
  const kpiValRow = sumSheet.getRow(sr);
  kpiValRow.height = 32;
  kpis.slice(0, 5).forEach((kpi, i) => {
    const col = 2 + i;
    const c = kpiValRow.getCell(col);
    c.value = kpi.value;
    c.numFmt = kpi.fmt;
    c.font = { bold: true, size: 16, color: { argb: kpi.isCost ? C.red : C.blue } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.subHeaderBg } };
    c.border = thinBorder();
  });
  sr++;

  // KPI 전기비교 행
  if (pt) {
    const kpiDiffRow = sumSheet.getRow(sr);
    kpiDiffRow.height = 18;
    kpis.slice(0, 5).forEach((kpi, i) => {
      if (kpi.prev === undefined || kpi.prev === null) return;
      const col = 2 + i;
      const diff = kpi.value - kpi.prev;
      const c = kpiDiffRow.getCell(col);
      const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '-';
      c.value = diff;
      c.numFmt = kpi.fmt;
      const isPositive = diff > 0;
      c.font = { size: 9, italic: true, color: { argb: diff === 0 ? C.gray : ((isPositive === !!kpi.isCost) ? C.red : C.green) } };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
    });
  }
  sr += 2;

  // 두 번째 줄 KPI
  const kpiLabelRow2 = sumSheet.getRow(sr);
  kpiLabelRow2.height = 20;
  kpis.slice(5).forEach((kpi, i) => {
    const col = 2 + i;
    const c = kpiLabelRow2.getCell(col);
    c.value = kpi.label;
    c.font = { size: 9, color: { argb: C.gray } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  sr++;

  const kpiValRow2 = sumSheet.getRow(sr);
  kpiValRow2.height = 32;
  kpis.slice(5).forEach((kpi, i) => {
    const col = 2 + i;
    const c = kpiValRow2.getCell(col);
    c.value = kpi.value;
    c.numFmt = kpi.fmt;
    c.font = { bold: true, size: 16, color: { argb: kpi.isCost ? C.red : C.green } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.subHeaderBg } };
    c.border = thinBorder();
  });
  sr += 3;

  // 캠페인 TOP 5 요약 미니테이블
  const campTop5 = Object.entries(data.byCampaign).sort((a, b) => b[1].cost - a[1].cost).slice(0, 5);
  if (campTop5.length > 0) {
    sr = addSubTitle(sumSheet, sr, '비용 TOP 5 캠페인', 6);
    const hdrRow = sumSheet.getRow(sr);
    hdrRow.height = 24;
    ['캠페인', '비용', '클릭', 'CTR', 'ROAS'].forEach((h, i) => {
      const c = hdrRow.getCell(2 + i);
      c.value = h;
      c.font = { bold: true, size: 10, color: { argb: C.subHeaderText } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.subHeaderBg } };
      c.border = thinBorder();
      c.alignment = { horizontal: i === 0 ? 'left' : 'right', vertical: 'middle' };
    });
    sr++;
    campTop5.forEach(([, d], idx) => {
      const row = sumSheet.getRow(sr);
      row.height = 22;
      const vals = [d.name, d.cost, d.clk, d.ctr, d.roas];
      const fmts = [null, FMT.won, FMT.num, FMT.pct, FMT.roas];
      vals.forEach((v, i) => {
        const c = row.getCell(2 + i);
        c.value = v;
        if (fmts[i]) c.numFmt = fmts[i];
        c.font = { size: 10, color: { argb: C.subHeaderText } };
        c.alignment = { horizontal: i === 0 ? 'left' : 'right', vertical: 'middle' };
        c.border = thinBorder();
        if (idx % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.altRow } };
      });
      // 순위 뱃지
      const rankCell = row.getCell(2);
      rankCell.value = `${idx + 1}. ${d.name}`;
      sr++;
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // 3. 캠페인별 시트
  // ══════════════════════════════════════════════════════════════════
  const campEntries = Object.entries(data.byCampaign).sort((a, b) => b[1].cost - a[1].cost);
  if (campEntries.length > 0) {
    const cs = workbook.addWorksheet('캠페인별');
    setupSheetDefaults(cs);
    setMetricColumnWidths(cs, [28]);

    let r = 3;
    r = addSectionTitle(cs, r, `캠페인별 성과 현황 (${period})`);
    r++;
    r = addTableHeader(cs, r);

    campEntries.forEach(([, d], idx) => {
      const isTop5 = idx < 5;
      r = addMetricRow(cs, r, (isTop5 ? `★ ${idx+1}. ` : '') + d.name, d, {
        stripe: idx % 2 === 1,
        bold: isTop5,
        labelColor: isTop5 ? C.blue : undefined,
      });
    });

    // 합계 행
    r++;
    r = addMetricRow(cs, r, '합계', data.total, { bold: true, bg: C.totalBg });

    // 전기 비교
    if (pt) r = addDiffRow(cs, r, '전기 대비', t, pt);

    // 열 고정
    cs.views = [{ state: 'frozen', xSplit: 2, ySplit: 7, showGridLines: false }];
  }

  // ══════════════════════════════════════════════════════════════════
  // 4. 광고그룹별 시트
  // ══════════════════════════════════════════════════════════════════
  const agEntries = Object.entries(data.byAdgroup).sort((a, b) => b[1].cost - a[1].cost);
  if (agEntries.length > 0) {
    const gs = workbook.addWorksheet('광고그룹별');
    setupSheetDefaults(gs);
    setMetricColumnWidths(gs, [20, 25]);

    let r = 3;
    r = addSectionTitle(gs, r, `광고그룹별 성과 현황 (${period})`, 14);
    r++;

    // 헤더
    const hRow = gs.getRow(r);
    hRow.height = 26;
    ['캠페인', '광고그룹', ...metricHeaders].forEach((h, i) => {
      const cell = hRow.getCell(i + 2);
      cell.value = h;
      cell.font = { bold: true, size: 10, color: { argb: C.subHeaderText } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.subHeaderBg } };
      cell.alignment = { horizontal: i < 2 ? 'left' : 'center', vertical: 'middle' };
      cell.border = thinBorder();
    });
    r++;

    agEntries.forEach(([, d], idx) => {
      const isTop10 = idx < 10;
      r = addMetricRow(gs, r, '', d, {
        labels: [d.campaignName || '', (isTop10 ? `★ ${idx+1}. ` : '') + d.name],
        stripe: idx % 2 === 1,
        bold: isTop10,
        labelColor: isTop10 ? C.blue : undefined,
      });
    });

    gs.views = [{ state: 'frozen', xSplit: 3, ySplit: 7, showGridLines: false }];
  }

  // ══════════════════════════════════════════════════════════════════
  // 5. PC/모바일 시트
  // ══════════════════════════════════════════════════════════════════
  const deviceEntries = Object.entries(data.byDevice).sort((a, b) => b[1].cost - a[1].cost);
  if (deviceEntries.length > 0) {
    const ds = workbook.addWorksheet('PC_모바일');
    setupSheetDefaults(ds);
    setMetricColumnWidths(ds, [14]);

    let r = 3;
    r = addSectionTitle(ds, r, `PC / 모바일 성과 비교 (${period})`);
    r++;

    // 비율 요약
    const totalCost = deviceEntries.reduce((s, [, d]) => s + (d.cost||0), 0) || 1;
    const totalClk = deviceEntries.reduce((s, [, d]) => s + (d.clk||0), 0) || 1;
    const summRow = ds.getRow(r);
    summRow.height = 28;
    let col = 2;
    deviceEntries.forEach(([device, d]) => {
      const pctCost = Math.round(d.cost / totalCost * 100);
      const pctClk = Math.round(d.clk / totalClk * 100);
      const c = summRow.getCell(col);
      c.value = `${device === 'PC' ? '🖥 PC' : '📱 MO'} — 비용 ${pctCost}% · 클릭 ${pctClk}%`;
      c.font = { bold: true, size: 11, color: { argb: device === 'PC' ? C.blue : 'FFF97316' } };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.subHeaderBg } };
      c.border = thinBorder();
      col += 6;
    });
    r += 2;

    r = addTableHeader(ds, r, ['디바이스']);
    deviceEntries.forEach(([device, d], idx) => {
      r = addMetricRow(ds, r, device, d, { stripe: idx % 2 === 1 });
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // 6. 시간대별 시트
  // ══════════════════════════════════════════════════════════════════
  const hourEntries = Object.entries(data.byHour).sort((a, b) => a[0].localeCompare(b[0]));
  if (hourEntries.length > 0) {
    const hs = workbook.addWorksheet('시간대별');
    setupSheetDefaults(hs);
    setMetricColumnWidths(hs, [10]);

    let r = 3;
    r = addSectionTitle(hs, r, `시간대별 성과 분포 (${period})`);
    r++;

    // 클릭 히트맵 바 (조건부 서식 대용 - 셀 배경 그라데이션)
    const maxClk = Math.max(...hourEntries.map(([, d]) => d.clk), 1);
    const topHours = [...hourEntries].sort((a, b) => b[1].clk - a[1].clk).slice(0, 3);
    const topHourKeys = topHours.map(([h]) => h);

    r = addSubTitle(hs, r, '시간대별 클릭수 히트맵 (진할수록 높음)', 13);
    const heatRow = hs.getRow(r);
    heatRow.height = 30;
    for (let h = 0; h < 24; h++) {
      if (h + 2 > 25) break;
      const hKey = String(h).padStart(2, '0');
      const d = data.byHour[hKey];
      const clk = d ? d.clk : 0;
      const intensity = Math.round(clk / maxClk * 200);
      const cell = heatRow.getCell(h + 2);
      cell.value = clk;
      cell.numFmt = FMT.num;
      cell.font = { size: 8, bold: topHourKeys.includes(hKey), color: { argb: intensity > 100 ? C.white : C.subHeaderText } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      const g = Math.max(0, 200 - intensity);
      const hexG = g.toString(16).padStart(2, '0');
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${(Math.min(50 + intensity, 255)).toString(16).padStart(2,'0')}${hexG}${(Math.min(100 + intensity, 255)).toString(16).padStart(2,'0')}` } };
      cell.border = thinBorder();
    }
    r++;
    // 시간 라벨
    const hLabelRow = hs.getRow(r);
    for (let h = 0; h < 24; h++) {
      if (h + 2 > 25) break;
      const c = hLabelRow.getCell(h + 2);
      c.value = `${h}시`;
      c.font = { size: 8, color: { argb: C.gray } };
      c.alignment = { horizontal: 'center' };
    }
    r += 2;

    // 최적 시간대 표시
    r = addSubTitle(hs, r, `⏰ 클릭 최적 시간대: ${topHours.map(([h, d]) => `${parseInt(h)}시(${d.clk}회)`).join(', ')}`, 13);
    r++;

    // 데이터 테이블
    r = addTableHeader(hs, r, ['시간']);
    hourEntries.forEach(([h, d], idx) => {
      const isTop = topHourKeys.includes(h);
      r = addMetricRow(hs, r, `${parseInt(h)}시`, d, {
        stripe: idx % 2 === 1,
        bold: isTop,
        labelColor: isTop ? C.green : undefined,
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // 7. 일자별 시트
  // ══════════════════════════════════════════════════════════════════
  const dateEntries = Object.entries(data.byDate).sort((a, b) => a[0].localeCompare(b[0]));
  if (dateEntries.length > 1) {
    const dts = workbook.addWorksheet('일자별');
    setupSheetDefaults(dts);
    setMetricColumnWidths(dts, [18]);

    let r = 3;
    r = addSectionTitle(dts, r, `일자별 성과 추이 (${period})`);
    r++;

    // 일자별 비용 미니바 차트 (셀 내)
    const maxDateCost = Math.max(...dateEntries.map(([, d]) => d.cost), 1);
    r = addSubTitle(dts, r, '일자별 비용 분포', 13);
    dateEntries.forEach(([dt, d]) => {
      const dayOfWeek = ['일', '월', '화', '수', '목', '금', '토'][new Date(dt).getDay()];
      const row = dts.getRow(r);
      row.height = 18;
      const lc = row.getCell(2);
      lc.value = `${dt.slice(5)} (${dayOfWeek})`;
      lc.font = { size: 9, color: { argb: C.gray } };
      lc.alignment = { vertical: 'middle' };

      const bc = row.getCell(3);
      const barLen = Math.max(1, Math.round(d.cost / maxDateCost * 30));
      bc.value = '█'.repeat(barLen) + ` ${f.won(d.cost)}`;
      bc.font = { size: 9, color: { argb: '8B5CF6' } };
      bc.alignment = { vertical: 'middle' };
      r++;
    });
    r += 2;

    // 데이터 테이블
    r = addTableHeader(dts, r, ['일자']);
    dateEntries.forEach(([dt, d], idx) => {
      const dayOfWeek = ['일', '월', '화', '수', '목', '금', '토'][new Date(dt).getDay()];
      const isWeekend = [0, 6].includes(new Date(dt).getDay());
      r = addMetricRow(dts, r, `${dt} (${dayOfWeek})`, d, {
        stripe: idx % 2 === 1,
        labelColor: isWeekend ? C.red : undefined,
      });
    });

    // 합계
    r++;
    const dateTotal = { cost: 0, imp: 0, clk: 0, cpc: 0, ctr: 0, avgRank: 0, rankSum: 0, rankCount: 0, purchaseCnt: 0, purchaseAmt: 0, roas: 0, cartCnt: 0, cartAmt: 0 };
    dateEntries.forEach(([, d]) => {
      dateTotal.cost += d.cost||0; dateTotal.imp += d.imp||0; dateTotal.clk += d.clk||0;
      dateTotal.purchaseCnt += d.purchaseCnt||0; dateTotal.purchaseAmt += d.purchaseAmt||0;
      dateTotal.cartCnt += d.cartCnt||0; dateTotal.cartAmt += d.cartAmt||0;
    });
    dateTotal.cpc = dateTotal.clk > 0 ? Math.round(dateTotal.cost / dateTotal.clk) : 0;
    dateTotal.ctr = dateTotal.imp > 0 ? (dateTotal.clk / dateTotal.imp * 100) : 0;
    dateTotal.roas = dateTotal.cost > 0 ? Math.round(dateTotal.purchaseAmt / dateTotal.cost * 100) : 0;
    r = addMetricRow(dts, r, '합계', dateTotal, { bold: true, bg: C.totalBg });

    dts.views = [{ state: 'frozen', xSplit: 2, ySplit: 0, showGridLines: false }];
  }

  // Buffer로 반환
  return await workbook.xlsx.writeBuffer();
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

  // 엑셀 리포트 생성
  let excelBuffer = null;
  try {
    excelBuffer = await buildExcelReport({ type, period, accountName: account.name, data, prevData });
    console.log(`📊 [${account.name}] 엑셀 리포트 생성 완료 (${Math.round(excelBuffer.length / 1024)}KB)`);
  } catch (e) {
    console.warn(`⚠️ [${account.name}] 엑셀 리포트 생성 실패:`, e.message);
  }

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const mailOptions = {
    from: account.email_user,
    to: recipients.join(', '),
    subject: `📊 [${account.name}] ${typeLabel} 성과 리포트 - ${today}`,
    html,
    text: `네이버 SA ${typeLabel} 리포트\n광고주: ${account.name}\n기간: ${period}\n총비용: ${f.won(data.total.cost)}\n클릭: ${f.num(data.total.clk)}`,
  };

  // 엑셀 첨부파일 추가
  if (excelBuffer) {
    mailOptions.attachments = [{
      filename: `${account.name}_${typeLabel}_리포트_${dateStr}.xlsx`,
      content: Buffer.from(excelBuffer),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }];
  }

  await getTransporter(account).sendMail(mailOptions);

  console.log(`✅ [${account.name}] ${typeLabel} 리포트 → ${recipients.join(', ')}${excelBuffer ? ' (엑셀 첨부)' : ''}`);
}

module.exports = { sendReport, buildHtmlReport, buildExcelReport };
