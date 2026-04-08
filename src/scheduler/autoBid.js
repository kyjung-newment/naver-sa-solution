const { createApiClient } = require('../api/naverApi');
const { findAdRank } = require('../api/naverRankScraper');
const db = require('../db/database');

const runningAccounts = new Set();

/**
 * 자동입찰 실행 (키워드별 간격 + 시간대 설정 기반)
 * - 크론은 5분마다 실행, 각 키워드는 bid_interval에 따라 차등 처리
 * - 병렬 10개씩 처리하여 300초 제한 내 완료
 */
async function runAutoBiddingForAccount(account) {
  if (runningAccounts.has(account.id)) {
    console.log(`⏭ [${account.name}] 자동입찰 이미 실행 중`);
    return;
  }
  runningAccounts.add(account.id);

  const client = createApiClient({
    apiKey: account.api_key,
    secretKey: account.secret_key,
    customerId: account.customer_id,
  });

  // 비즈채널 URL (실시간 순위 매칭용)
  const siteUrls = (account.site_url || '').split(',').map(u => u.trim()).filter(Boolean);

  try {
    const abKeywords = await db.getEnabledAutoBidKeywords(account.id);
    if (!abKeywords.length) return;

    // KST 현재 시간
    const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const currentHour = kstNow.getUTCHours();
    const now = Date.now();

    // 실행 대상 키워드 필터링
    const targets = abKeywords.filter(kw => {
      const schedule = kw.schedule || '111111111111111111111111';
      if (schedule[currentHour] !== '1') return false;
      const interval = (kw.bid_interval || 10) * 60 * 1000;
      const lastRun = kw.last_run ? new Date(kw.last_run).getTime() : 0;
      return (now - lastRun) >= interval;
    });

    if (!targets.length) return;

    console.log(`\n🤖 [${account.name}] 자동입찰: ${targets.length}/${abKeywords.length}개 (${currentHour}시)`);

    // 실시간 순위 캐시 (같은 키워드+디바이스 중복 조회 방지)
    const rankCache = {};

    // 병렬 10개씩 배치 처리
    const BATCH = 10;
    let adjusted = 0;
    for (let i = 0; i < targets.length; i += BATCH) {
      const batch = targets.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(kw => adjustBidForKeyword(client, kw, siteUrls, rankCache))
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) adjusted++;
      }
    }

    console.log(`✅ [${account.name}] 자동입찰 완료: ${adjusted}개 조정`);
  } catch (err) {
    console.error(`❌ [${account.name}] 자동입찰 오류:`, err.message);
  } finally {
    runningAccounts.delete(account.id);
  }
}

/**
 * 개별 키워드 입찰가 조정 (실시간 순위 기반)
 * - 실시간 순위 스크래핑 → 목표순위와 비교 → 조정입찰가만큼 단계적 조정
 * - Estimate API 사용하지 않음 (28일 평균이라 부정확)
 * @returns {boolean} 입찰가 변경 여부
 */
async function adjustBidForKeyword(client, abKw, siteUrls, rankCache) {
  const { keyword_id, keyword, target_rank, max_bid, adjust_amt, device } = abKw;

  try {
    // 1. 현재 입찰가 조회 (그룹 입찰가 우선 체크)
    let currentBid = abKw.last_bid || 0;
    try {
      const kwInfo = await client.getKeywordInfo(keyword_id);
      if (kwInfo?.useGroupBidAmt && kwInfo?.nccAdgroupId) {
        // [기본] 사용 → 그룹 입찰가 조회
        const grp = await client.getAdGroupDetail(kwInfo.nccAdgroupId);
        currentBid = grp?.bidAmt || currentBid;
      } else if (kwInfo?.bidAmt && kwInfo.bidAmt > 0) {
        currentBid = kwInfo.bidAmt;
      }
    } catch (e) { /* fallback to last_bid */ }

    // 2. 실시간 순위 조회 (검색결과 스크래핑)
    let realRank = 0;
    if (siteUrls && siteUrls.length > 0) {
      const cacheKey = `${keyword}_${device}`;
      if (rankCache[cacheKey] !== undefined) {
        realRank = rankCache[cacheKey];
      } else {
        try {
          for (const siteUrl of siteUrls) {
            const result = await findAdRank(keyword, device, siteUrl);
            if (result.rank > 0) {
              realRank = result.rank;
              break;
            }
          }
          rankCache[cacheKey] = realRank;
        } catch (e) { /* 실시간 순위 조회 실패 시 무시 */ }
      }
    }

    // 3. 입찰가 조정 로직 (실시간 순위 기반)
    let newBid = currentBid;
    let action = '유지';

    if (realRank === 0) {
      // 순위밖 → 입찰가 상향
      newBid = Math.min(currentBid + adjust_amt, max_bid);
      action = '순위밖→상향';
    } else if (realRank > target_rank) {
      // 현재순위가 목표보다 낮음 (예: 5위인데 3위 원함) → 상향
      newBid = Math.min(currentBid + adjust_amt, max_bid);
      action = `${realRank}위→상향`;
    } else if (realRank < target_rank) {
      // 현재순위가 목표보다 높음 (예: 1위인데 3위 원함) → 하향 (비용 절감)
      newBid = Math.max(currentBid - adjust_amt, 70);
      action = `${realRank}위→하향`;
    } else {
      // 목표순위 정확히 달성 → 유지
      action = `${realRank}위=목표`;
    }

    const changed = newBid !== currentBid && newBid > 0;
    if (changed) {
      await client.updateKeywordBid(keyword_id, newBid);
      console.log(`  🎯 [${keyword}] ${device} ${currentBid}→${newBid}원 (${action}, 목표:${target_rank}위)`);
      // 변경 후 실제 반영된 입찰가 재조회
      await new Promise(r => setTimeout(r, 500));
      try {
        const updatedKw = await client.getKeywordInfo(keyword_id);
        if (updatedKw?.bidAmt && updatedKw.bidAmt > 0) {
          newBid = updatedKw.bidAmt;
        }
      } catch (e) {}
    } else {
      console.log(`  ✓ [${keyword}] ${device} ${currentBid}원 ${action}`);
    }

    // DB 상태 + last_run 갱신 (확인된 입찰가로 저장)
    await db.updateAutoBidKeywordStatus(keyword_id, device, 0, newBid || currentBid, realRank).catch(() => {});

    return changed;
  } catch (err) {
    console.error(`  ⚠️ [${keyword}] ${device} 실패:`, err.message);
    await db.pool.query(
      'UPDATE auto_bid_keywords SET last_run = CURRENT_TIMESTAMP WHERE keyword_id = $1 AND device = $2',
      [keyword_id, device]
    ).catch(() => {});
    return false;
  }
}

module.exports = { runAutoBiddingForAccount };
