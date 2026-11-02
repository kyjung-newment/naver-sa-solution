/**
 * 자동리포트 BETA — SA/DA 분리 화면 + GFA 원본 업로드
 *  - DA 단독 리포트 / SA+DA 통합 리포트 (미리보기·엑셀·메일)
 *  - 'DA 업로드 후 자동리포트 발송': 켜면 해당 주기의 자동 발송을 업로드 확정 전까지 보류하고,
 *    확정되면 크론이 SA+DA 통합 리포트로 발송한다 (재시도·선점·이력은 기존 크론 경로 그대로).
 */
const zlib = require('zlib');
const db = require('../db/database');
const gfa = require('../report/gfaUpload');
const gfaReport = require('../report/gfaReport');
const { renderBetaPage } = require('./daUploadPage');

const TYPES = ['daily', 'weekly', 'monthly'];
const TYPE_LABEL = { daily: '일간', weekly: '주간', monthly: '월간' };
const MAX_ROWS = 300000;
const MAX_FILE_BYTES = 120 * 1024 * 1024;

const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
function readRange(src) {
  const { since, until } = src;
  if (!validDate(since) || !validDate(until)) throw new Error('기간을 선택해 주세요.');
  if (since > until) throw new Error('시작일이 종료일보다 늦습니다.');
  if ((Date.parse(until) - Date.parse(since)) / 86400000 > 366) throw new Error('기간은 1년 이내로 선택해 주세요.');
  return { since, until };
}

/** 저장된 파일 + 직전 기간 파일로 리포트 입력 구성. 성과 보고서가 없으면 null */
async function loadDaReport(accountId, since, until) {
  const load = async (a, b) => {
    const files = await db.getDaFiles(accountId, a, b, true);
    return gfa.buildModel(files.map(f => ({ ...f, rows: gfa.unpackRows(f.rows_gz) })));
  };
  const model = await load(since, until);
  if (!model) return null;
  const prevRange = gfa.previousRange(since, until);
  const prev = await load(prevRange.since, prevRange.until);
  const info = gfa.classifyPeriod(since, until);
  return {
    model, prev, prevRange: prev ? prevRange : null, comparePeriod: prevRange,
    cmpLabel: info.cmp, typeLabel: info.label, periodType: info.type, period: gfa.periodText(since, until),
  };
}

// 이번 주기(until이 끝난 뒤) 자동리포트가 이미 나갔는지
function sentForPeriod(account, type, until) {
  const last = account[`last_${type}_report`];
  if (!last) return false;
  return new Date(last).getTime() >= Date.parse(`${until}T15:00:00Z`); // until 다음날 00:00 KST
}

function registerDaUploadRoutes(router, deps) {
  const { requireLogin, requireAdmin, appLayout, getUser, getLayoutOpts, getGlobalSmtpAccount, escHtml } = deps;
  const guard = [requireLogin, requireAdmin];

  // 본인 소유 광고주만 (열람자 경로 제외)
  async function ownedAccount(req, id) {
    const a = await db.getAccountById(id, req.session.userId);
    if (!a || a.user_id !== req.session.userId) { const e = new Error('광고주를 찾을 수 없습니다.'); e.status = 404; throw e; }
    return a;
  }
  async function withSmtp(req, account) {
    const g = await getGlobalSmtpAccount();
    if (g) return { ...account, email_host: g.email_host, email_port: g.email_port, email_user: g.email_user, email_pass: g.email_pass };
    const s = await db.getSmtpCredentials(req.session.userId);
    const user = s?.daou_email || s?.username || '';
    if (!user || !s?.smtp_pass) throw new Error('발신 메일이 설정되지 않았습니다. 내 정보에서 다우오피스 계정을 설정해 주세요.');
    return { ...account, email_host: s.smtp_host || 'outbound.daouoffice.com', email_port: 465, email_user: user, email_pass: s.smtp_pass };
  }
  async function withApi(req, account) {
    if (account.has_sa === false) throw new Error('SA가 활성화되지 않은 광고주입니다. DA 단독 리포트를 이용해 주세요.');
    const creds = await db.getApiCredentials(req.session.userId, account.id);
    if (!creds) throw new Error('API 계정이 등록되지 않아 SA 데이터를 가져올 수 없습니다.');
    return { ...account, api_key: creds.api_key, secret_key: creds.secret_key };
  }
  // SA 생성기 호출 인자: 정기 기간과 같으면 정기 리포트로, 아니면 맞춤으로
  function saArgs(since, until) {
    const { getDateRange } = require('../report/generator');
    const c = gfa.classifyPeriod(since, until);
    const type = TYPES.includes(c.type) ? c.type : 'monthly';
    const reg = getDateRange(type);
    const regular = c.type !== 'custom' && reg.since === since && reg.until === until;
    return { type, regular, customRange: regular ? null : { since, until } };
  }
  const fail = (res, e) => res.status(e.status || 200).json({ ok: false, error: e.message });

  // ─── 화면 ────────────────────────────────────────────────────
  router.get('/beta/reports', ...guard, async (req, res) => {
    const user = await getUser(req);
    const layoutOpts = await getLayoutOpts(req);
    const accounts = (layoutOpts.accounts || []);
    const account = accounts.find(a => String(a.id) === String(layoutOpts.selectedAccountId)) || null;
    const content = renderBetaPage({ account, escHtml, guide: gfa.FILE_GUIDE });
    res.send(appLayout('자동리포트 BETA', content, user, 'beta-reports', layoutOpts));
  });

  // ─── 현재 기간 상태 ──────────────────────────────────────────
  router.get('/api/da-upload/state', ...guard, async (req, res) => {
    try {
      const account = await ownedAccount(req, req.query.accountId);
      const { since, until } = readRange(req.query);
      const files = await db.getDaFiles(account.id, since, until, true);
      const model = gfa.buildModel(files.map(f => ({ ...f, rows: gfa.unpackRows(f.rows_gz) })));
      const prevRange = gfa.previousRange(since, until);
      const prevFiles = await db.getDaFiles(account.id, prevRange.since, prevRange.until);
      const { getDateRange } = require('../report/generator');
      const info = gfa.classifyPeriod(since, until);
      const auto = [];
      for (const t of TYPES) {
        const r = getDateRange(t);
        const tFiles = await db.getDaFiles(account.id, r.since, r.until);
        auto.push({
          type: t, label: TYPE_LABEL[t], on: !!account[`feat_${t}_report`], wait: !!account[`da_wait_${t}`],
          since: r.since, until: r.until, files: tFiles.length, hasPerf: tFiles.some(f => f.kind === 'performance'),
          ready: !!(await db.getDaReady(account.id, t, r.since, r.until)),
          sent: sentForPeriod(account, t, r.until),
        });
      }
      res.json({
        ok: true,
        typeLabel: info.label, cmpLabel: info.cmp, period: gfa.periodText(since, until),
        files: files.map(f => ({
          id: f.id, fileName: f.file_name, kind: f.kind, dims: gfa.dimsLabel(f.dims), rows: f.row_count,
          cost: f.totals.cost || 0, buy: f.totals.buy || 0, sales: f.totals.sales || 0, uploadedAt: f.uploaded_at, warnings: f.warnings,
        })),
        hasReport: !!model,
        warnings: model ? model.warnings : [],
        total: model ? model.total : null,
        coverage: gfa.coverage(model),
        sheets: model ? gfaReport.daSheetPlan({ model, prev: null, cmpLabel: info.cmp, period: '', accountName: '', typeLabel: '' }).map(s => s.name) : [],
        prev: { since: prevRange.since, until: prevRange.until, files: prevFiles.length, hasPerf: prevFiles.some(f => f.kind === 'performance') },
        recipients: account.report_emails || '',
        hasSa: account.has_sa !== false,
        lastSend: {
          da: await db.getDaLastSend(account.id, since, until, 'da'),
          combined: await db.getDaLastSend(account.id, since, until, 'combined'),
        },
        periods: await db.getDaPeriods(account.id),
        auto,
      });
    } catch (e) { fail(res, e); }
  });

  // ─── 파일 업로드 (파일당 1요청) ──────────────────────────────
  router.post('/api/da-upload/file', ...guard, async (req, res) => {
    try {
      const account = await ownedAccount(req, req.body.accountId);
      const { since, until } = readRange(req.body);
      const fileName = String(req.body.fileName || 'upload.csv').slice(0, 200);
      if (!req.body.data) throw new Error('파일 내용이 없습니다.');
      let buf = Buffer.from(String(req.body.data), 'base64');
      if (req.body.gz) buf = zlib.gunzipSync(buf, { maxOutputLength: MAX_FILE_BYTES });
      const p = await gfa.parseUpload(buf, fileName, { since, until });
      if (p.rows.length > MAX_ROWS) throw new Error(`행이 ${MAX_ROWS.toLocaleString('ko-KR')}개를 넘습니다. 분석 단위나 기간 단위를 줄여 내려받아 주세요.`);
      // 같은 내용이 다른 기간으로 올라가 있으면 기간을 잘못 고른 것 (파일에 날짜가 없어 내용으로 판별)
      const dup = await db.findDaFileInOtherPeriod(account.id, p.contentHash, since, until);
      if (dup) throw new Error(`같은 내용의 파일('${dup.file_name}')이 이미 ${gfa.periodText(dup.since, dup.until)} 기간으로 올라가 있습니다. 기간을 확인해 주세요. 그 기간이 잘못됐다면 먼저 삭제한 뒤 다시 올려주세요.`);
      const saved = await db.upsertDaFile({
        accountId: account.id, since, until, signature: p.signature, kind: p.kind, dims: p.dims, fileName,
        contentHash: p.contentHash, rowCount: p.rows.length, totals: p.totals, warnings: p.warnings,
        rowsGz: gfa.packRows(p.rows), uploadedBy: req.session.userId,
      });
      res.json({ ok: true, id: saved.id, replaced: !!saved.replaced, kind: p.kind, dims: gfa.dimsLabel(p.dims), rows: p.rows.length, warnings: p.warnings });
    } catch (e) { res.status(e.status || 200).json({ ok: false, error: e.message, detected: e.detected || null }); }
  });

  router.delete('/api/da-upload/file/:id', ...guard, async (req, res) => {
    try {
      const account = await ownedAccount(req, req.query.accountId);
      await db.deleteDaFile(req.params.id, account.id);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ─── 미리보기 / 엑셀 ─────────────────────────────────────────
  router.get('/api/da-upload/preview', ...guard, async (req, res) => {
    try {
      const account = await ownedAccount(req, req.query.accountId);
      const { since, until } = readRange(req.query);
      const da = await loadDaReport(account.id, since, until);
      if (!da) throw new Error('성과 보고서 파일을 먼저 올려주세요.');
      res.set('Content-Type', 'text/html; charset=utf-8');
      if (req.query.mode === 'combined') {
        const { generatePreview } = require('../report/generator');
        const { type, customRange } = saArgs(since, until);
        return res.send(await generatePreview(await withApi(req, account), type, customRange, { daReport: da, comparePeriod: da.comparePeriod }));
      }
      res.send(gfaReport.buildDaHtml({ accountName: account.name, ...da }));
    } catch (e) { res.status(e.status || 400).set('Content-Type', 'text/plain; charset=utf-8').send(e.message); }
  });

  router.get('/api/da-upload/excel', ...guard, async (req, res) => {
    try {
      const account = await ownedAccount(req, req.query.accountId);
      const { since, until } = readRange(req.query);
      const da = await loadDaReport(account.id, since, until);
      if (!da) throw new Error('성과 보고서 파일을 먼저 올려주세요.');
      const safe = (account.name || 'account').replace(/[\\/:*?"<>|]/g, '_');
      const tag = since.replace(/-/g, '') + (since === until ? '' : `-${until.replace(/-/g, '')}`);
      let buffer, filename;
      if (req.query.mode === 'combined') {
        const { generateExcelBuffer } = require('../report/generator');
        const { type, customRange } = saArgs(since, until);
        const label = customRange ? '맞춤' : TYPE_LABEL[type];
        ({ buffer } = await generateExcelBuffer(await withApi(req, account), type, customRange, { daReport: da, comparePeriod: da.comparePeriod }));
        filename = `${safe}_SA+DA_${label}_리포트_${tag}.xlsx`;
      } else {
        buffer = await gfaReport.buildDaExcel({ accountName: account.name, ...da });
        filename = `${safe}_DA_${da.typeLabel}_리포트_${tag}.xlsx`;
      }
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.send(Buffer.from(buffer));
    } catch (e) { res.status(e.status || 400).set('Content-Type', 'text/plain; charset=utf-8').send(e.message); }
  });

  // ─── 메일 발송 (담당자가 직접 누르는 경로) ───────────────────
  router.post('/api/da-upload/send', ...guard, async (req, res) => {
    let lockId = null, stampType = null, oldStamp = null;
    try {
      const account = await ownedAccount(req, req.body.accountId);
      const { since, until } = readRange(req.body);
      const mode = req.body.mode === 'combined' ? 'combined' : 'da';
      const recipients = (account.report_emails || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!recipients.length) throw new Error('수신 이메일이 없습니다. 광고주 설정에서 리포트 수신 이메일을 등록해 주세요.');
      const da = await loadDaReport(account.id, since, until);
      if (!da) throw new Error('성과 보고서 파일을 먼저 올려주세요.');
      const sa = mode === 'combined' ? saArgs(since, until) : null;

      // 중복 발송 방지: 같은 기간을 이미 보냈으면 담당자가 확인해야 진행
      if (!req.body.confirmResend) {
        const last = await db.getDaLastSend(account.id, since, until, mode);
        if (last) return res.json({ ok: false, needConfirm: true, error: `이 기간 리포트는 이미 발송됐습니다 (${last.created_at.slice(0, 16)} UTC, 수신: ${last.recipients}). 같은 메일을 다시 보낼까요?` });
        if (sa && sa.regular && sentForPeriod(account, sa.type, until)) {
          return res.json({ ok: false, needConfirm: true, error: `이 기간 ${TYPE_LABEL[sa.type]} SA 자동리포트가 이미 발송됐습니다. SA+DA를 보내면 광고주가 같은 기간 SA 데이터를 두 번 받습니다. 그래도 보낼까요?` });
        }
      }
      const enriched = await withSmtp(req, mode === 'combined' ? await withApi(req, account) : account);
      lockId = await db.beginDaSend(account.id, since, until, mode, recipients.join(', '), req.session.userId);
      if (!lockId) throw new Error('이 기간 리포트를 발송하는 중입니다. 잠시 후 결과를 확인해 주세요.');
      const t0 = Date.now();

      if (mode === 'combined') {
        const { generateAndSend } = require('../report/generator');
        // 정기 기간이면 자동 발송과 같은 내용이므로 스탬프를 먼저 남겨 크론과의 중복을 막는다
        if (sa.regular) {
          stampType = sa.type;
          oldStamp = account[`last_${sa.type}_report`] || null;
          await db.pool.query(`UPDATE ad_accounts SET last_${sa.type}_report = CURRENT_TIMESTAMP WHERE id = $1`, [account.id]);
        }
        await generateAndSend(enriched, sa.type, sa.customRange, { daReport: da, comparePeriod: da.comparePeriod });
        db.logReportSend(account.id, sa.regular ? sa.type : 'da_upload', { source: 'manual', status: 'sent', recipients: recipients.join(', '), durationMs: Date.now() - t0 });
      } else {
        const { sendMailWithFallback } = require('../email/sender');
        const buffer = await gfaReport.buildDaExcel({ accountName: account.name, ...da });
        const safe = (account.name || 'account').replace(/[\\/:*?"<>|]/g, '_');
        const tag = since.replace(/-/g, '') + (since === until ? '' : `-${until.replace(/-/g, '')}`);
        await sendMailWithFallback(enriched, {
          from: enriched.email_user,
          to: recipients.join(', '),
          subject: `📺 [${account.name}] DA ${da.typeLabel} 성과 리포트 (${da.period})`,
          html: gfaReport.buildDaHtml({ accountName: account.name, ...da }),
          attachments: [{
            filename: `${safe}_DA_${da.typeLabel}_리포트_${tag}.xlsx`,
            content: Buffer.from(buffer),
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          }],
        });
        db.logReportSend(account.id, 'da_upload', { source: 'manual', status: 'sent', recipients: recipients.join(', '), durationMs: Date.now() - t0 });
      }
      await db.finishDaSend(lockId, true);
      res.json({ ok: true, message: `${recipients.join(', ')}(으)로 발송했습니다.` });
    } catch (e) {
      if (lockId) await db.finishDaSend(lockId, false).catch(() => {});
      if (stampType) await db.pool.query(`UPDATE ad_accounts SET last_${stampType}_report = $2 WHERE id = $1`, [req.body.accountId, oldStamp]).catch(() => {});
      if (req.body.accountId && lockId) db.logReportSend(req.body.accountId, 'da_upload', { source: 'manual', status: 'failed', errorMsg: e.message });
      fail(res, e);
    }
  });

  // ─── 'DA 업로드 후 자동리포트 발송' 설정 ─────────────────────
  router.post('/api/da-upload/wait', ...guard, async (req, res) => {
    try {
      const account = await ownedAccount(req, req.body.accountId);
      const { type } = req.body;
      if (!TYPES.includes(type)) throw new Error('잘못된 리포트 유형입니다.');
      if (req.body.on && account.has_sa === false) throw new Error('SA가 활성화되지 않은 광고주는 자동리포트가 없어 설정할 수 없습니다.');
      await db.setDaWait(account.id, type, !!req.body.on);
      if (!req.body.on) {
        const r = require('../report/generator').getDateRange(type);
        await db.clearDaReady(account.id, type, r.since, r.until);
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // 업로드 완료 확정 → 크론이 다음 정각부터 발송 대상으로 잡음
  router.post('/api/da-upload/ready', ...guard, async (req, res) => {
    try {
      const account = await ownedAccount(req, req.body.accountId);
      const { type } = req.body;
      if (!TYPES.includes(type)) throw new Error('잘못된 리포트 유형입니다.');
      const r = require('../report/generator').getDateRange(type);
      if (req.body.cancel) {
        await db.clearDaReady(account.id, type, r.since, r.until);
        return res.json({ ok: true });
      }
      if (!account[`feat_${type}_report`]) throw new Error(`${TYPE_LABEL[type]} 자동 발송이 꺼져 있습니다.`);
      if (!account[`da_wait_${type}`]) throw new Error("먼저 'DA 업로드 후 자동리포트 발송'을 켜 주세요.");
      if (sentForPeriod(account, type, r.until)) throw new Error('이번 주기 자동리포트는 이미 발송됐습니다.');
      const files = await db.getDaFiles(account.id, r.since, r.until);
      if (!files.some(f => f.kind === 'performance')) throw new Error(`${gfa.periodText(r.since, r.until)} 기간의 성과 보고서 파일을 먼저 올려주세요.`);
      await db.setDaReady(account.id, type, r.since, r.until, req.session.userId);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { registerDaUploadRoutes, loadDaReport };
