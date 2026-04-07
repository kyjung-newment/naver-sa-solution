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
 * 개별 키워드 입찰가 조정
 * @returns {boolean} 입찰가 변경 여부
 */
async function adjustBidForKeyword(client, abKw, siteUrls, rankCache) {
  const { keyword_id, keyword, target_rank, max_bid, adjust_amt, device } = abKw;

  try {
    // 1. 현재 입찰가 조회
    let currentBid = abKw.last_bid || 0;
    try {
      const kwInfo = await client.getKeywordInfo(keyword_id);
      currentBid = kwInfo?.bidAmt || currentBid;
    } catch (e) { /* fallback */ }

    // 2. 목표 순위에 필요한 입찰가 조회 (estimate API)
    let targetBid = 0;
    try {
      const est = await client.getEstimatedBidForPosition(keyword_id, device, target_rank);
      targetBid = est?.estimate?.[0]?.bid || 0;
    } catch (e) {
      console.log(`  순위 추정 실패 [${keyword}]:`, e.message);
    }

    // 3. 실시간 순위 조회 (검색결과 파싱)
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

    // 4. 입찰가 조정 로직
    let newBid = currentBid;

    if (realRank > 0 && realRank <= target_rank) {
      // 실시간 순위 달성 → 입찰가 과다 시 점진 하향
      if (targetBid > 0 && currentBid > targetBid + adjust_amt) {
        newBid = Math.max(currentBid - adjust_amt, 70);
      }
      // 순위 달성 중이면 유지
    } else if (targetBid > 0 && currentBid < targetBid) {
      // 목표 순위 미달 → adjust_amt만큼 점진 상향
      newBid = Math.min(currentBid + adjust_amt, max_bid);
    } else if (targetBid > 0 && currentBid > targetBid + adjust_amt) {
      // 입찰가 과다 → adjust_amt만큼 점진 하향
      newBid = Math.max(currentBid - adjust_amt, 70);
    } else if (targetBid === 0 && realRank === 0) {
      // estimate 조회 실패 + 순위 밖 → 상향 시도
      newBid = Math.min(currentBid + adjust_amt, max_bid);
    }

    const changed = newBid !== currentBid && newBid > 0;
    if (changed) {
      await client.updateKeywordBid(keyword_id, newBid);
      const rankStr = realRank > 0 ? realRank + '위' : '순위밖';
      console.log(`  🎯 [${keyword}] ${device} ${currentBid}→${newBid}원 (${rankStr} → 목표:${target_rank}위, 필요:${targetBid}원)`);
    }

    // DB 상태 + last_run 갱신
    await db.updateAutoBidKeywordStatus(keyword_id, device, targetBid, newBid || currentBid, realRank).catch(() => {});

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
