/**
 * 대시보드 데이터 동기화 모듈
 * - Naver SA API에서 AD_DETAIL + AD_CONVERSION_DETAIL 데이터를 주기적으로 DB에 저장
 * - 대시보드 로딩 시 API 대신 DB에서 즉시 조회 (0.1~0.3초)
 */
const { createApiClient } = require('../api/naverApi');
const db = require('../db/database');

// KST 기준 날짜 포맷
function fmtKST(d) {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function getDatesBetween(since, until) {
  const dates = [];
  const s = new Date(since), e = new Date(until);
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) dates.push(d.toISOString().slice(0, 10));
  return dates;
}

/**
 * 단일 계정 + 단일 날짜 동기화
 */
async function syncAccountDate(account, date) {
  const client = createApiClient({
    apiKey: account.api_key,
    secretKey: account.secret_key,
    customerId: account.customer_id,
  });

  console.log(`  📥 [${account.name}] ${date} 동기화 시작...`);

  // 1. AD_DETAIL 다운로드
  let adRows = [];
  try {
    adRows = await client.createAndDownloadStatReport('AD_DETAIL', date);
  } catch (e) {
    console.log(`  ⚠️ AD_DETAIL 다운로드 실패 (${date}):`, e.message);
  }

  // 2. AD_CONVERSION_DETAIL 다운로드
  let convRows = [];
  try {
    convRows = await client.createAndDownloadStatReport('AD_CONVERSION_DETAIL', date);
  } catch (e) {
    console.log(`  ⚠️ AD_CONVERSION_DETAIL 다운로드 실패 (${date}):`, e.message);
  }

  // 3. 전환 데이터 lookup 맵 빌드
  // key: campaignId:adgroupId:keywordId:hour:device
  const convMap = {};
  for (const cols of convRows) {
    if (cols.length < 15) continue;
    const convType = cols[12];
    const isPurchase = convType === 'purchase' || convType === 'purchase_complete' || convType === 'complete_purchase';
    const isCart = convType === 'add_to_cart' || convType === 'cart';
    if (!isPurchase && !isCart) continue;

    const key = `${cols[2]}:${cols[3]}:${cols[4]}:${cols[7]}:${cols[10]}`;
    if (!convMap[key]) convMap[key] = { purchaseCnt: 0, purchaseAmt: 0, cartCnt: 0, cartAmt: 0 };
    const cnt = parseInt(cols[13]) || 0;
    const amt = parseInt(cols[14]) || 0;
    if (isPurchase) { convMap[key].purchaseCnt += cnt; convMap[key].purchaseAmt += amt; }
    if (isCart) { convMap[key].cartCnt += cnt; convMap[key].cartAmt += amt; }
  }

  // 4. AD_DETAIL 행 + 전환 데이터 병합 후 DB에 저장
  // 먼저 기존 데이터 삭제
  await db.pool.query(
    'DELETE FROM stat_daily_detail WHERE account_id = $1 AND stat_date = $2',
    [account.id, date]
  );

  // 배치 INSERT (100행씩)
  const BATCH = 100;
  for (let i = 0; i < adRows.length; i += BATCH) {
    const batch = adRows.slice(i, i + BATCH);
    if (batch.length === 0) continue;

    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const cols of batch) {
      if (cols.length < 14) continue;
      const campId = cols[2] || '';
      const agId = cols[3] || '';
      const kwId = cols[4] || '';
      const adId = cols[5] || '';
      const hour = parseInt(cols[7]) || 0;
      const device = cols[10] === 'P' ? 'PC' : 'MO';
      const imp = parseInt(cols[11]) || 0;
      const clk = parseInt(cols[12]) || 0;
      const cost = parseInt(cols[13]) || 0;
      const rank = parseFloat(cols[14]) || 0;

      const convKey = `${campId}:${agId}:${kwId}:${cols[7]}:${cols[10]}`;
      const conv = convMap[convKey] || { purchaseCnt: 0, purchaseAmt: 0, cartCnt: 0, cartAmt: 0 };

      values.push(`($${paramIdx},$${paramIdx+1},$${paramIdx+2},$${paramIdx+3},$${paramIdx+4},$${paramIdx+5},$${paramIdx+6},$${paramIdx+7},$${paramIdx+8},$${paramIdx+9},$${paramIdx+10},$${paramIdx+11},$${paramIdx+12},$${paramIdx+13},$${paramIdx+14})`);
      params.push(account.id, date, campId, agId, kwId, adId, hour, device, imp, clk, cost, rank, conv.purchaseCnt, conv.purchaseAmt, conv.cartCnt);
      paramIdx += 15;
    }

    if (values.length > 0) {
      await db.pool.query(
        `INSERT INTO stat_daily_detail (account_id, stat_date, campaign_id, adgroup_id, keyword_id, ad_id, hour, device, imp, clk, cost, rank_val, purchase_cnt, purchase_amt, cart_cnt)
         VALUES ${values.join(',')}`,
        params
      );
    }
  }

  // 5. Stats API로 캠페인별 정확한 salesAmt 저장
  try {
    const campaigns = await client.getCampaigns();
    const statsResults = await Promise.allSettled(
      (campaigns || []).map(camp =>
        client.getStatById(camp.nccCampaignId, { startDate: date, endDate: date })
          .then(result => ({ camp, result }))
      )
    );

    // 기존 캠페인 일별 데이터 삭제
    await db.pool.query(
      'DELETE FROM stat_campaign_daily WHERE account_id = $1 AND stat_date = $2',
      [account.id, date]
    );

    const campValues = [];
    const campParams = [];
    let cpIdx = 1;

    for (const sr of statsResults) {
      if (sr.status !== 'fulfilled') continue;
      const { camp, result } = sr.value;
      if (!result?.data?.length) continue;

      let imp = 0, clk = 0, salesAmt = 0, convAmt = 0, avgRnk = 0, rkCnt = 0;
      for (const d of result.data) {
        imp += d.impCnt || 0;
        clk += d.clkCnt || 0;
        salesAmt += d.salesAmt || 0;
        convAmt += d.convAmt || 0;
        if (d.avgRnk > 0) { avgRnk += d.avgRnk; rkCnt++; }
      }
      if (rkCnt > 0) avgRnk = avgRnk / rkCnt;

      // 전환 데이터 (구매완료)
      let purchaseCnt = 0, purchaseAmt = 0;
      for (const cols of convRows) {
        if (cols.length < 15) continue;
        if (cols[2] !== camp.nccCampaignId) continue;
        const ct = cols[12];
        if (ct === 'purchase' || ct === 'purchase_complete' || ct === 'complete_purchase') {
          purchaseCnt += parseInt(cols[13]) || 0;
          purchaseAmt += parseInt(cols[14]) || 0;
        }
      }

      campValues.push(`($${cpIdx},$${cpIdx+1},$${cpIdx+2},$${cpIdx+3},$${cpIdx+4},$${cpIdx+5},$${cpIdx+6},$${cpIdx+7},$${cpIdx+8},$${cpIdx+9})`);
      campParams.push(account.id, date, camp.nccCampaignId, camp.name, imp, clk, salesAmt, avgRnk, purchaseCnt, purchaseAmt);
      cpIdx += 10;
    }

    if (campValues.length > 0) {
      await db.pool.query(
        `INSERT INTO stat_campaign_daily (account_id, stat_date, campaign_id, campaign_name, imp, clk, sales_amt, avg_rnk, purchase_cnt, purchase_amt)
         VALUES ${campValues.join(',')}`,
        campParams
      );
    }
  } catch (e) {
    console.log(`  ⚠️ Stats API 캠페인 동기화 실패 (${date}):`, e.message);
  }

  // 6. 동기화 로그 업데이트
  await db.pool.query(
    `INSERT INTO sync_log (account_id, sync_type, stat_date, status, row_count, completed_at)
     VALUES ($1, 'detail', $2, 'done', $3, CURRENT_TIMESTAMP)
     ON CONFLICT (account_id, sync_type, stat_date)
     DO UPDATE SET status = 'done', row_count = $3, completed_at = CURRENT_TIMESTAMP`,
    [account.id, date, adRows.length]
  );

  console.log(`  ✅ [${account.name}] ${date} 동기화 완료 (${adRows.length}행)`);
  return adRows.length;
}

/**
 * 전체 계정 동기화 (크론잡용)
 * @param {number} timeoutMs - 최대 실행 시간 (기본 50초)
 */
async function runDashboardSync(timeoutMs = 50000) {
  const startTime = Date.now();
  console.log('🔄 대시보드 데이터 동기화 시작...');

  // 모든 계정 조회 (API 키가 설정된)
  const accounts = await db.all(`
    SELECT ad_accounts.*, users.api_key, users.secret_key
    FROM ad_accounts
    JOIN users ON users.id = ad_accounts.user_id
    WHERE users.api_key != '' AND users.secret_key != ''
  `);

  const now = new Date();
  const yesterday = fmtKST(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const today = fmtKST(now);

  let totalSynced = 0;

  for (const account of accounts) {
    if (Date.now() - startTime > timeoutMs) {
      console.log('⏰ 타임아웃 - 다음 크론에서 계속');
      break;
    }

    try {
      // 어제 데이터: 이미 done이면 스킵
      const yesterdayLog = await db.get(
        `SELECT status FROM sync_log WHERE account_id = $1 AND sync_type = 'detail' AND stat_date = $2`,
        [account.id, yesterday]
      );
      if (!yesterdayLog || yesterdayLog.status !== 'done') {
        await syncAccountDate(account, yesterday);
        totalSynced++;
      }

      // 오늘 데이터: 항상 갱신 (부분 데이터)
      if (Date.now() - startTime < timeoutMs) {
        await syncAccountDate(account, today);
        totalSynced++;
      }

      // 계정별 마지막 동기화 시간 업데이트
      await db.pool.query(
        'UPDATE ad_accounts SET last_dashboard_sync = CURRENT_TIMESTAMP WHERE id = $1',
        [account.id]
      );
    } catch (e) {
      console.log(`❌ [${account.name}] 동기화 실패:`, e.message);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ 대시보드 동기화 완료: ${totalSynced}건, ${elapsed}초`);
  return { totalSynced, elapsed, accounts: accounts.length };
}

/**
 * 과거 데이터 백필 (최초 또는 누락 데이터 보충)
 * @param {number} timeoutMs - 최대 실행 시간
 * @param {number} days - 백필할 일수 (기본 30일)
 */
async function runBackfill(timeoutMs = 50000, days = 30) {
  const startTime = Date.now();
  console.log(`🔄 백필 동기화 시작 (${days}일)...`);

  const accounts = await db.all(`
    SELECT ad_accounts.*, users.api_key, users.secret_key
    FROM ad_accounts
    JOIN users ON users.id = ad_accounts.user_id
    WHERE users.api_key != '' AND users.secret_key != ''
  `);

  const now = new Date();
  let totalSynced = 0;

  for (const account of accounts) {
    // 동기화 안 된 날짜 찾기
    const syncedDates = await db.all(
      `SELECT stat_date::text as stat_date FROM sync_log WHERE account_id = $1 AND sync_type = 'detail' AND status = 'done'`,
      [account.id]
    );
    const syncedSet = new Set(syncedDates.map(r => r.stat_date.slice(0, 10)));

    for (let i = 1; i <= days; i++) {
      if (Date.now() - startTime > timeoutMs) {
        console.log('⏰ 백필 타임아웃 - 다음에 계속');
        return { totalSynced, elapsed: ((Date.now() - startTime) / 1000).toFixed(1) };
      }

      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = fmtKST(d);

      if (!syncedSet.has(dateStr)) {
        try {
          await syncAccountDate(account, dateStr);
          totalSynced++;
        } catch (e) {
          console.log(`❌ [${account.name}] ${dateStr} 백필 실패:`, e.message);
        }
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ 백필 완료: ${totalSynced}건, ${elapsed}초`);
  return { totalSynced, elapsed };
}

module.exports = { syncAccountDate, runDashboardSync, runBackfill };
