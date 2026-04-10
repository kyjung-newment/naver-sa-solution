const { createApiClient } = require('../api/naverApi');
const db = require('../db/database');

const runningAccounts = new Set();

/**
 * 쇼핑검색 자동입찰 실행 (소재 단위 입찰가 조정)
 * - 크론은 5분마다 실행, 각 키워드는 bid_interval에 따라 차등 처리
 */
async function runShoppingAutoBidForAccount(account) {
  if (runningAccounts.has(account.id)) {
    console.log(`⏭ [${account.name}] 쇼핑 자동입찰 이미 실행 중`);
    return;
  }
  runningAccounts.add(account.id);

  const client = createApiClient({
    apiKey: account.api_key,
    secretKey: account.secret_key,
    customerId: account.customer_id,
  });

  const siteUrls = (account.site_url || '').split(',').map(u => u.trim()).filter(Boolean);

  try {
    const abKeywords = await db.getEnabledShoppingBidKeywords(account.id);
    if (!abKeywords.length) return;

    const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const currentHour = kstNow.getUTCHours();
    const now = Date.now();

    // 실행 대상 필터
    const targets = abKeywords.filter(kw => {
      const schedule = kw.schedule || '111111111111111111111111';
      if (schedule[currentHour] !== '1') return false;
      const interval = (kw.bid_interval || 10) * 60 * 1000;
      const lastRun = kw.last_run ? new Date(kw.last_run).getTime() : 0;
      return (now - lastRun) >= interval;
    });

    if (!targets.length) return;

    console.log(`\n🛒 [${account.name}] 쇼핑 자동입찰: ${targets.length}/${abKeywords.length}개 (${currentHour}시)`);

    const { findShoppingRank } = require('../api/shoppingRankScraper');
    const rankCache = {};
    let adjusted = 0;

    for (const kw of targets) {
      try {
        const nadId = kw.product_url; // 소재 ID (nad-xxx)
        if (!nadId) continue;

        // 1. 현재 입찰가 조회 (소재 레벨)
        let currentBid = kw.last_bid || 0;
        try {
          const adDetail = await client.getAdDetail(nadId);
          const adBid = adDetail?.adAttr?.bidAmt || adDetail?.bidAmt || 0;
          if (adBid > 0) currentBid = adBid;
          else if (adDetail?.useGroupBidAmt && adDetail?.nccAdgroupId) {
            const grp = await client.getAdGroupDetail(adDetail.nccAdgroupId);
            if (grp?.bidAmt > 0) currentBid = grp.bidAmt;
          }
        } catch (e) { /* fallback to last_bid */ }

        // 2. 실시간 순위 조회
        let realRank = 0;
        const cacheKey = `${kw.keyword}_${kw.device}`;
        if (rankCache[cacheKey] !== undefined) {
          realRank = rankCache[cacheKey];
        } else {
          try {
            const result = await findShoppingRank(kw.keyword, kw.device, nadId);
            realRank = result.rank || 0;
            rankCache[cacheKey] = realRank;
          } catch (e) { /* 순위 조회 실패 */ }
        }

        // 3. 입찰가 조정 로직
        let newBid = currentBid;
        let action = '유지';
        const adjust = kw.adjust_amt || 100;

        if (realRank === 0) {
          const lastRank = kw.last_rank || 0;
          if (lastRank > 0 && lastRank <= kw.target_rank) {
            action = `순위조회실패→유지(이전${lastRank}위)`;
          } else if (currentBid >= kw.max_bid) {
            action = '순위밖+최대입찰가→유지';
          } else {
            newBid = Math.min(currentBid + adjust, kw.max_bid);
            action = '순위밖→상향';
          }
        } else if (realRank > kw.target_rank) {
          newBid = Math.min(currentBid + adjust, kw.max_bid);
          action = `${realRank}위→상향`;
        } else if (realRank < kw.target_rank) {
          newBid = Math.max(currentBid - adjust, 70);
          action = `${realRank}위→하향`;
        } else {
          action = `${realRank}위=목표`;
        }

        // 4. 입찰가 변경 (소재 레벨 - adAttr.bidAmt)
        const changed = newBid !== currentBid && newBid > 0;
        if (changed) {
          try {
            await client.updateAdBid(nadId, newBid);
            console.log(`  🛒 [${kw.keyword}] ${kw.device} ₩${currentBid}→₩${newBid} (${action}, 목표:${kw.target_rank}위)`);
            adjusted++;
            // 변경 후 실제 반영 확인
            await new Promise(r => setTimeout(r, 500));
            try {
              const updated = await client.getAdDetail(nadId);
              const confirmedBid = updated?.adAttr?.bidAmt || newBid;
              newBid = confirmedBid;
            } catch (e) {}
          } catch (bidErr) {
            console.error(`  ❌ 쇼핑 입찰가 변경 실패 [${kw.keyword}]:`, bidErr.message);
          }
        } else {
          console.log(`  ✓ [${kw.keyword}] ${kw.device} ₩${currentBid} ${action}`);
        }

        // DB 상태 갱신
        await db.updateShoppingBidKeywordStatus(kw.id, realRank || kw.last_rank || 0, newBid || currentBid);
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        console.error(`  ⚠️ [${kw.keyword}] 실패:`, e.message);
        await db.pool.query(
          'UPDATE shopping_bid_keywords SET last_run = CURRENT_TIMESTAMP WHERE id = $1',
          [kw.id]
        ).catch(() => {});
      }
    }

    console.log(`✅ [${account.name}] 쇼핑 자동입찰 완료: ${adjusted}개 조정`);
  } catch (err) {
    console.error(`❌ [${account.name}] 쇼핑 자동입찰 오류:`, err.message);
  } finally {
    runningAccounts.delete(account.id);
  }
}

module.exports = { runShoppingAutoBidForAccount };
