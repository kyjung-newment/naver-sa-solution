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

const fmt = {
  num:  n => Number(n || 0).toLocaleString('ko-KR'),
  pct:  n => `${Number(n || 0).toFixed(2)}%`,
  won:  n => `₩${Number(n || 0).toLocaleString('ko-KR')}`,
  rank: n => n ? `${Number(n).toFixed(1)}위` : '-',
};

function trend(curr, prev) {
  if (!prev) return '';
  const diff = curr - prev;
  if (diff > 0) return `<span style="color:#16a34a">▲ ${fmt.num(Math.abs(diff))}</span>`;
  if (diff < 0) return `<span style="color:#dc2626">▼ ${fmt.num(Math.abs(diff))}</span>`;
  return `<span style="color:#6b7280">— 동일</span>`;
}

function buildHtmlReport({ type, period, accountName, stats, keywordStats = [], prevStats = null }) {
  const typeLabel = { daily: '일간', weekly: '주간', monthly: '월간' }[type] || type;
  const now = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });

  const totalClk   = stats?.clkCnt   || 0;
  const totalImp   = stats?.impCnt   || 0;
  const totalSales = stats?.salesAmt || 0;
  const avgCtr     = stats?.ctr      || 0;
  const avgRnk     = stats?.avgRnk   || 0;

  const topKeywords = [...(keywordStats || [])].sort((a, b) => (b.clkCnt || 0) - (a.clkCnt || 0)).slice(0, 10);
  const kwRows = topKeywords.map((kw, i) => `
    <tr style="background:${i % 2 === 0 ? '#f9fafb' : '#ffffff'}">
      <td style="padding:10px 12px;text-align:center;color:#6b7280;font-size:12px">${i + 1}</td>
      <td style="padding:10px 12px;font-weight:500">${kw.keyword || kw.keywordId || '-'}</td>
      <td style="padding:10px 12px;text-align:right">${fmt.num(kw.impCnt)}</td>
      <td style="padding:10px 12px;text-align:right;color:#1d4ed8">${fmt.num(kw.clkCnt)}</td>
      <td style="padding:10px 12px;text-align:right">${fmt.pct(kw.ctr)}</td>
      <td style="padding:10px 12px;text-align:right;color:#16a34a">${fmt.won(kw.salesAmt)}</td>
      <td style="padding:10px 12px;text-align:center">${fmt.rank(kw.avgRnk)}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>네이버SA ${typeLabel} 리포트</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif;">
<div style="max-width:680px;margin:0 auto;padding:24px 16px;">
  <div style="background:#03c75a;border-radius:12px 12px 0 0;padding:28px 32px;">
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <div>
        <p style="margin:0;color:rgba(255,255,255,0.75);font-size:13px">NAVER SEARCH AD · ${accountName}</p>
        <h1 style="margin:6px 0 0;color:#ffffff;font-size:24px;font-weight:700">${typeLabel} 성과 리포트</h1>
      </div>
      <div style="text-align:right">
        <p style="margin:0;color:rgba(255,255,255,0.75);font-size:12px">발송일</p>
        <p style="margin:4px 0 0;color:#ffffff;font-size:14px;font-weight:500">${now}</p>
      </div>
    </div>
    <p style="margin:12px 0 0;color:rgba(255,255,255,0.85);font-size:14px">📅 분석 기간: ${period}</p>
  </div>
  <div style="background:#ffffff;padding:24px 32px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
    <table width="100%" cellspacing="0" cellpadding="0"><tr>
      ${[
        { label: '총 노출수', value: fmt.num(totalImp), icon: '👁', sub: prevStats ? trend(totalImp, prevStats.impCnt) : '' },
        { label: '총 클릭수', value: fmt.num(totalClk), icon: '🖱', sub: prevStats ? trend(totalClk, prevStats.clkCnt) : '' },
        { label: '전환 매출', value: fmt.won(totalSales), icon: '💰', sub: prevStats ? trend(totalSales, prevStats.salesAmt) : '' },
        { label: '평균 CTR', value: fmt.pct(avgCtr), icon: '📊', sub: '' },
      ].map(card => `
        <td style="width:25%;padding:0 6px">
          <div style="background:#f9fafb;border-radius:10px;padding:16px;text-align:center;border:1px solid #f3f4f6">
            <div style="font-size:22px;margin-bottom:8px">${card.icon}</div>
            <div style="font-size:11px;color:#6b7280;margin-bottom:6px">${card.label}</div>
            <div style="font-size:18px;font-weight:700;color:#111827">${card.value}</div>
            ${card.sub ? `<div style="font-size:11px;margin-top:6px">${card.sub}</div>` : ''}
          </div>
        </td>
      `).join('')}
    </tr></table>
  </div>
  <div style="background:#eff6ff;border-left:4px solid #3b82f6;border-right:1px solid #e5e7eb;padding:14px 32px;">
    <span style="font-size:16px;margin-right:10px">🎯</span>
    <span style="font-size:14px;color:#1e40af">평균 노출 순위: <strong>${fmt.rank(avgRnk)}</strong></span>
  </div>
  <div style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;padding:24px 32px;">
    <h2 style="margin:0 0 16px;font-size:16px;font-weight:600;color:#111827">🔑 키워드별 성과 Top 10</h2>
    ${topKeywords.length > 0 ? `
    <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px;">
      <thead><tr style="background:#f3f4f6;border-bottom:2px solid #e5e7eb">
        <th style="padding:10px 12px;text-align:center;color:#6b7280;font-weight:500;font-size:12px">#</th>
        <th style="padding:10px 12px;text-align:left;color:#6b7280;font-weight:500;font-size:12px">키워드</th>
        <th style="padding:10px 12px;text-align:right;color:#6b7280;font-weight:500;font-size:12px">노출</th>
        <th style="padding:10px 12px;text-align:right;color:#6b7280;font-weight:500;font-size:12px">클릭</th>
        <th style="padding:10px 12px;text-align:right;color:#6b7280;font-weight:500;font-size:12px">CTR</th>
        <th style="padding:10px 12px;text-align:right;color:#6b7280;font-weight:500;font-size:12px">전환매출</th>
        <th style="padding:10px 12px;text-align:center;color:#6b7280;font-weight:500;font-size:12px">순위</th>
      </tr></thead>
      <tbody>${kwRows}</tbody>
    </table>` : '<p style="color:#9ca3af;font-size:14px">키워드 데이터가 없습니다.</p>'}
  </div>
  <div style="background:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:16px 32px;text-align:center;">
    <p style="margin:0;font-size:12px;color:#9ca3af">이 리포트는 자동으로 발송되었습니다 · ${accountName}</p>
  </div>
</div></body></html>`.trim();
}

async function sendReport({ account, type, period, stats, keywordStats, prevStats }) {
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

  const html = buildHtmlReport({ type, period, accountName: account.name, stats, keywordStats, prevStats });

  await getTransporter(account).sendMail({
    from: account.email_user,
    to:   recipients.join(', '),
    subject: `📊 [${account.name}] ${typeLabel} 성과 리포트 - ${today}`,
    html,
    text: `네이버 SA ${typeLabel} 리포트\n광고주: ${account.name}\n기간: ${period}\n노출: ${fmt.num(stats?.impCnt)}\n클릭: ${fmt.num(stats?.clkCnt)}`,
  });

  console.log(`✅ [${account.name}] ${typeLabel} 리포트 → ${recipients.join(', ')}`);
}

module.exports = { sendReport };
