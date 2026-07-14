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

  // 4개 리포트를 병렬 다운로드 (속도 개선)
  const [adResult, convResult, shopResult, shopConvResult] = await Promise.allSettled([
    client.createAndDownloadStatReport('AD_DETAIL', date),
    client.createAndDownloadStatReport('AD_CONVERSION_DETAIL', date),
    client.createAndDownloadStatReport('SHOPPINGKEYWORD_DETAIL', date),
    client.createAndDownloadStatReport('SHOPPINGKEYWORD_CONVERSION_DETAIL', date),
  ]);

  let adRows = adResult.status === 'fulfilled' ? adResult.value : [];
  if (adResult.status === 'rejected') console.log(`  ⚠️ AD_DETAIL 실패 (${date}):`, adResult.reason?.message);

  let convRows = convResult.status === 'fulfilled' ? convResult.value : [];
  if (convResult.status === 'rejected') console.log(`  ⚠️ AD_CONVERSION_DETAIL 실패 (${date}):`, convResult.reason?.message);

  const shopKwRows = shopResult.status === 'fulfilled' ? shopResult.value : [];
  if (shopResult.status === 'fulfilled' && shopKwRows.length > 0) console.log(`  🔍 SHOPPINGKEYWORD_DETAIL: ${shopKwRows.length}행`);

  const shopConvRows = shopConvResult.status === 'fulfilled' ? shopConvResult.value : [];

  // SHOPPINGKEYWORD 데이터 리매핑 (13열 → 15열 AD_DETAIL 포맷 맞춤)
  // Shopping rows는 adId(5), channelId(6) 컬럼이 없으므로 빈 값 삽입
  function remapShoppingRow(cols) {
    if (cols.length >= 15) return cols;
    return [...cols.slice(0, 5), '', '', ...cols.slice(5)];
  }

  // SHOPPINGKEYWORD_DETAIL: 쇼핑 키워드별 성과 → stat_daily_detail에 별도 저장 (키워드 탭용)
  // AD_DETAIL에는 쇼핑 캠페인이 keyword_id='-'로만 저장되어 개별 키워드 분석 불가
  const remappedShopKw = shopKwRows.map(remapShoppingRow);
  const remappedShopConv = shopConvRows.map(remapShoppingRow);
  if (remappedShopKw.length > 0) {
    console.log(`  📋 SHOPPINGKEYWORD_DETAIL ${remappedShopKw.length}행 → DB 저장 (키워드 분석용)`);
  }

  // 3. 전환 데이터 lookup 맵 빌드 (AD_CONVERSION_DETAIL + SHOPPINGKEYWORD_CONVERSION_DETAIL)
  // key: campaignId:adgroupId:keywordId:hour:device
  const convMap = {};
  const convTypeSet = new Set();
  function isPurchaseType(ct) {
    const lo = (ct || '').trim().toLowerCase();
    const raw = (ct || '').trim();
    return lo === 'purchase' || lo === 'purchase_complete' || lo === 'complete_purchase'
      || lo === 'conversion' || lo === 'conv' || lo === '1'
      || raw === '구매완료';
  }
  function isCartType(ct) {
    const lo = (ct || '').trim().toLowerCase();
    const raw = (ct || '').trim();
    return lo === 'add_to_cart' || lo === 'cart' || lo === 'add_cart'
      || raw === '장바구니 담기' || raw === '장바구니';
  }
  function addConvRow(cols) {
    if (cols.length < 15) return;
    const convType = cols[12];
    convTypeSet.add(convType);
    const isPurchase = isPurchaseType(convType);
    const isCart = isCartType(convType);
    if (!isPurchase && !isCart) return;
    const key = `${cols[2]}:${cols[3]}:${cols[4]}:${cols[7]}:${cols[10]}`;
    if (!convMap[key]) convMap[key] = { purchaseCnt: 0, purchaseAmt: 0, cartCnt: 0, cartAmt: 0 };
    const cnt = parseInt(cols[13]) || 0;
    const amt = parseInt(cols[14]) || 0;
    if (isPurchase) { convMap[key].purchaseCnt += cnt; convMap[key].purchaseAmt += amt; }
    if (isCart) { convMap[key].cartCnt += cnt; convMap[key].cartAmt += amt; }
  }
  // AD_CONVERSION_DETAIL (파워링크+쇼핑 전체 전환)
  for (const cols of convRows) addConvRow(cols);
  // SHOPPINGKEYWORD_CONVERSION_DETAIL (쇼핑 키워드별 전환 → 리매핑 후 동일 포맷)
  for (const cols of remappedShopConv) addConvRow(cols);
  if (convTypeSet.size > 0) console.log(`  📊 [${account.name}] ${date} 전환 타입: ${[...convTypeSet].join(', ')} (AD:${convRows.length}행 + SHOP:${remappedShopConv.length}행)`);

  // 4. 캠페인별 Stats API 데이터 선조회 (DB 트랜잭션 밖에서 API 호출)
  //    구매전환은 convRows를 1회만 스캔해 캠페인별 집계 (기존: 캠페인수 × 전환행수 반복 스캔)
  const campConvMap = {};
  for (const cols of convRows) {
    if (cols.length < 15) continue;
    if (!isPurchaseType(cols[12])) continue;
    const cid = cols[2];
    if (!campConvMap[cid]) campConvMap[cid] = { cnt: 0, amt: 0 };
    campConvMap[cid].cnt += parseInt(cols[13]) || 0;
    campConvMap[cid].amt += parseInt(cols[14]) || 0;
  }

  const campValues = [];
  const campParams = [];
  let campFetchOk = false;
  try {
    const campaigns = await client.getCampaigns();
    // 동시 8개 제한 (캠페인 수가 많은 계정에서 429 방지)
    const statsResults = [];
    const campList = campaigns || [];
    for (let i = 0; i < campList.length; i += 8) {
      const chunk = campList.slice(i, i + 8);
      const res = await Promise.allSettled(chunk.map(camp =>
        client.getStatById(camp.nccCampaignId, { startDate: date, endDate: date })
          .then(result => ({ camp, result }))
      ));
      statsResults.push(...res);
    }
    campFetchOk = true;

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

      const cc = campConvMap[camp.nccCampaignId] || { cnt: 0, amt: 0 };
      campValues.push(`($${cpIdx},$${cpIdx+1},$${cpIdx+2},$${cpIdx+3},$${cpIdx+4},$${cpIdx+5},$${cpIdx+6},$${cpIdx+7},$${cpIdx+8},$${cpIdx+9})`);
      campParams.push(account.id, date, camp.nccCampaignId, camp.name, imp, clk, salesAmt, avgRnk, cc.cnt, cc.amt);
      cpIdx += 10;
    }
  } catch (e) {
    console.log(`  ⚠️ Stats API 캠페인 조회 실패 (${date}):`, e.message);
  }

  // 5. DB 저장 — 단일 트랜잭션으로 원자적 DELETE→INSERT
  //    (크론 중복/동시 실행 시 이중 집계 방지: 계정+날짜 advisory lock)
  const tx = await db.pool.connect();
  try {
  await tx.query('BEGIN');
  await tx.query('SELECT pg_advisory_xact_lock($1, $2)', [account.id, parseInt(date.replace(/-/g, ''), 10)]);
  await tx.query(
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
      await tx.query(
        `INSERT INTO stat_daily_detail (account_id, stat_date, campaign_id, adgroup_id, keyword_id, ad_id, hour, device, imp, clk, cost, rank_val, purchase_cnt, purchase_amt, cart_cnt)
         VALUES ${values.join(',')}`,
        params
      );
    }
  }

  // 4-1. SHOPPINGKEYWORD_DETAIL 행도 DB에 저장 (키워드 탭용, 리매핑된 포맷)
  for (let i = 0; i < remappedShopKw.length; i += BATCH) {
    const batch = remappedShopKw.slice(i, i + BATCH);
    if (batch.length === 0) continue;

    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const cols of batch) {
      if (cols.length < 14) continue;
      const campId = cols[2] || '';
      const agId = cols[3] || '';
      const kwId = cols[4] || '';
      if (!kwId || kwId === '-' || kwId === '') continue; // 키워드 없는 행 스킵
      const adId = '';
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
      await tx.query(
        `INSERT INTO stat_daily_detail (account_id, stat_date, campaign_id, adgroup_id, keyword_id, ad_id, hour, device, imp, clk, cost, rank_val, purchase_cnt, purchase_amt, cart_cnt)
         VALUES ${values.join(',')}`,
        params
      );
    }
  }
  if (remappedShopKw.length > 0) console.log(`  ✅ SHOPPINGKEYWORD_DETAIL ${remappedShopKw.length}행 DB 저장 완료`);

  // 5-1. 캠페인 일별 데이터 (Stats API 조회 성공 시에만 교체)
  if (campFetchOk) {
    await tx.query(
      'DELETE FROM stat_campaign_daily WHERE account_id = $1 AND stat_date = $2',
      [account.id, date]
    );
    if (campValues.length > 0) {
      await tx.query(
        `INSERT INTO stat_campaign_daily (account_id, stat_date, campaign_id, campaign_name, imp, clk, sales_amt, avg_rnk, purchase_cnt, purchase_amt)
         VALUES ${campValues.join(',')}`,
        campParams
      );
    }
  }

  // 6. 동기화 로그 업데이트
  await tx.query(
    `INSERT INTO sync_log (account_id, sync_type, stat_date, status, row_count, completed_at)
     VALUES ($1, 'detail', $2, 'done', $3, CURRENT_TIMESTAMP)
     ON CONFLICT (account_id, sync_type, stat_date)
     DO UPDATE SET status = 'done', row_count = $3, completed_at = CURRENT_TIMESTAMP`,
    [account.id, date, adRows.length]
  );

  await tx.query('COMMIT');
  } catch (e) {
    await tx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    tx.release();
  }

  console.log(`  ✅ [${account.name}] ${date} 동기화 완료 (${adRows.length}행)`);
  return adRows.length;
}

/**
 * 마스터 데이터 동기화 (캠페인/광고그룹/키워드 이름)
 */
async function syncMasterData(account) {
  const { createApiClient } = require('../api/naverApi');
  const client = createApiClient({
    apiKey: account.api_key,
    secretKey: account.secret_key,
    customerId: account.customer_id,
  });

  try {
    // 캠페인 마스터
    const campRows = await client.syncMaster('Campaign');
    await db.upsertMasterCampaigns(account.id, campRows);

    // 광고그룹 마스터
    const agRows = await client.syncMaster('Adgroup');
    await db.upsertMasterAdgroups(account.id, agRows);

    // 키워드 마스터
    const kwRows = await client.syncMaster('Keyword');
    await db.upsertMasterKeywords(account.id, kwRows);

    // 품질지수(Qi) 마스터 → master_keywords.qi_grade 업데이트
    try {
      const qiRows = await client.syncMaster('Qi');
      const qiUpdated = await db.upsertMasterQi(account.id, qiRows);
      console.log(`  📊 [${account.name}] Qi 동기화: ${qiRows.length}행 → ${qiUpdated}건 업데이트`);
    } catch (e) {
      console.log(`  ⚠️ Qi 동기화 실패:`, e.message);
    }

    console.log(`  📋 [${account.name}] 마스터 동기화: 캠페인 ${campRows.length}, 광고그룹 ${agRows.length}, 키워드 ${kwRows.length}`);
  } catch (e) {
    console.log(`  ⚠️ [${account.name}] 마스터 동기화 실패:`, e.message);
  }
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
    SELECT ad_accounts.*,
           COALESCE(NULLIF(ac.api_key, ''), users.api_key) AS api_key,
           COALESCE(NULLIF(ac.secret_key, ''), users.secret_key) AS secret_key
    FROM ad_accounts
    JOIN users ON users.id = ad_accounts.user_id
    LEFT JOIN agency_credentials ac ON ac.id = ad_accounts.agency_credential_id
    WHERE COALESCE(NULLIF(ac.api_key, ''), users.api_key) != ''
      AND COALESCE(NULLIF(ac.secret_key, ''), users.secret_key) != ''
  `);

  const now = new Date();
  const yesterday = fmtKST(new Date(now.getTime() - 24 * 60 * 60 * 1000));

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

      // 마스터 데이터 동기화 (키워드 이름 등) - 매일 갱신
      const masterLog = await db.get(
        `SELECT status FROM sync_log WHERE account_id = $1 AND sync_type = 'master' AND stat_date = $2`,
        [account.id, yesterday]
      );
      if (!masterLog || masterLog.status !== 'done') {
        if (Date.now() - startTime < timeoutMs - 15000) { // 15초 여유 확보
          await syncMasterData(account);
          await db.pool.query(
            `INSERT INTO sync_log (account_id, sync_type, stat_date, status, completed_at)
             VALUES ($1, 'master', $2, 'done', CURRENT_TIMESTAMP)
             ON CONFLICT (account_id, sync_type, stat_date)
             DO UPDATE SET status = 'done', completed_at = CURRENT_TIMESTAMP`,
            [account.id, yesterday]
          );
        }
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
 * @param {number} days - 백필할 일수 (기본 60일 - 전월 리포트 조회용)
 */
async function runBackfill(timeoutMs = 50000, days = 60) {
  const startTime = Date.now();
  console.log(`🔄 백필 동기화 시작 (${days}일)...`);

  const accounts = await db.all(`
    SELECT ad_accounts.*,
           COALESCE(NULLIF(ac.api_key, ''), users.api_key) AS api_key,
           COALESCE(NULLIF(ac.secret_key, ''), users.secret_key) AS secret_key
    FROM ad_accounts
    JOIN users ON users.id = ad_accounts.user_id
    LEFT JOIN agency_credentials ac ON ac.id = ad_accounts.agency_credential_id
    WHERE COALESCE(NULLIF(ac.api_key, ''), users.api_key) != ''
      AND COALESCE(NULLIF(ac.secret_key, ''), users.secret_key) != ''
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

