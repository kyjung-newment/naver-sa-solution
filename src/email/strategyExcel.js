const ExcelJS = require('exceljs');

const C = { green: 'FF38AE49', dark: 'FF343539', white: 'FFFFFFFF', headerBg: 'FFF3F3F3', border: 'FFD9D9D9', altRow: 'FFF9FAFB', gray: 'FF718096' };
const FMT = { num: '#,##0', won: '₩#,##0', pct: '0.00"%"', roas: '0"%"', dec: '#,##0.0' };
const cm = { horizontal: 'center', vertical: 'middle' };
const border = { top: { style: 'thin', color: { argb: C.border } }, bottom: { style: 'thin', color: { argb: C.border } }, left: { style: 'thin', color: { argb: C.border } }, right: { style: 'thin', color: { argb: C.border } } };

// 증액(Upselling) 다차원 엑셀: 그룹별 / 키워드(상품검색어)별 / 기기별
async function buildUpsellExcel({ accountName, period, track, channels, groups, keywords, devices }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '뉴먼트 솔루션';

  const trackLabel = track === 'grow_volume' ? '볼륨 성장(ROAS 최소화)' : 'ROAS 유지 증액';
  const chLabel = (channels && channels.length) ? channels.join(', ') : '전체';

  const SPECS = [
    { h: '캠페인유형', w: 11, v: it => it.campaignType || '-' },
    { h: '구분', w: 24, v: it => it.name || '', wrap: true, bold: true },
    { h: '캠페인', w: 18, v: it => it.campaignName || '' },
    { h: '현재클릭', w: 10, v: it => it.clk || 0, fmt: FMT.num },
    { h: 'CVR', w: 9, v: it => it.cvr || 0, fmt: FMT.pct },
    { h: 'CPC', w: 11, v: it => it.cpc || 0, fmt: FMT.won },
    { h: '현재비용', w: 13, v: it => it.cost || 0, fmt: FMT.won },
    { h: '현재ROAS', w: 10, v: it => it.roas || 0, fmt: FMT.roas },
    { h: '구매수', w: 9, v: it => it.purchaseCnt || 0, fmt: FMT.num },
    { h: '구매매출', w: 13, v: it => it.purchaseAmt || 0, fmt: FMT.won },
    { h: '+클릭', w: 9, v: it => it.addClicks || 0, fmt: FMT.num, accent: true },
    { h: '한계CPC', w: 11, v: it => it.marginalCpc || 0, fmt: FMT.won },
    { h: '추가투입', w: 13, v: it => it.addSpend || 0, fmt: FMT.won },
    { h: '증액제안예산', w: 14, v: it => it.recBudget || 0, fmt: FMT.won, accent: true },
    { h: '추가전환', w: 9, v: it => it.addConversions || 0, fmt: FMT.dec },
    { h: '예상상승매출', w: 14, v: it => it.expRevenueUplift || 0, fmt: FMT.won, accent: true },
    { h: '예상ROAS', w: 10, v: it => it.expRoas || 0, fmt: FMT.roas },
    { h: '근거', w: 60, v: it => it.reason || '', wrap: true },
  ];

  function sheet(name, label, items) {
    const ws = wb.addWorksheet(name);
    ws.views = [{ showGridLines: false }];
    ws.getColumn(1).width = 2;
    SPECS.forEach((s, i) => ws.getColumn(i + 2).width = s.w);
    const span = SPECS.length + 1;
    // 타이틀
    let r = 2;
    ws.mergeCells(r, 2, r, span); const tc = ws.getRow(r).getCell(2);
    tc.value = `증액 제안 · ${label}  (${period})`; tc.font = { bold: true, size: 13, color: { argb: C.white } };
    tc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.green } }; tc.alignment = { horizontal: 'left', vertical: 'middle' };
    ws.getRow(r).height = 30; r++;
    ws.mergeCells(r, 2, r, span); const sc = ws.getRow(r).getCell(2);
    sc.value = `트랙: ${trackLabel} · 채널: ${chLabel} · 대상 ${items.length}건 (클릭수 증가 × CPC × 전환율 기반, 한계전환율 감쇠 반영)`;
    sc.font = { size: 10, color: { argb: C.gray } }; r += 2;
    // 헤더
    const hRow = ws.getRow(r); hRow.height = 26;
    SPECS.forEach((s, i) => { const c = hRow.getCell(i + 2); c.value = s.h; c.font = { bold: true, size: 10, color: { argb: C.dark } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } }; c.alignment = cm; c.border = border; });
    r++;
    if (!items.length) { const c = ws.getRow(r).getCell(2); ws.mergeCells(r, 2, r, span); c.value = '대상 없음 (전환 0건·저효율은 제외됩니다)'; c.font = { size: 10, color: { argb: C.gray } }; c.alignment = { horizontal: 'left', vertical: 'middle' }; c.border = border; return; }
    items.forEach((it, idx) => {
      const row = ws.getRow(r); row.height = 24;
      SPECS.forEach((s, i) => {
        const c = row.getCell(i + 2); const v = s.v(it); c.value = v; if (s.fmt && typeof v === 'number') c.numFmt = s.fmt;
        c.font = { size: 9, bold: !!s.bold || !!s.accent, color: { argb: s.accent ? C.green : (i < 2 ? C.dark : C.gray) } };
        c.alignment = s.wrap ? { horizontal: 'left', vertical: 'middle', wrapText: true } : cm;
        c.border = border; if (idx % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.altRow } };
      });
      r++;
    });
  }

  sheet('그룹별', '광고그룹별 (증액 실행 단위)', groups || []);
  sheet('키워드·검색어별', '키워드 / 상품검색어별', keywords || []);
  sheet('기기별', '기기별 (PC/모바일, 계정 전체)', devices || []);

  return await wb.xlsx.writeBuffer();
}

module.exports = { buildUpsellExcel };
