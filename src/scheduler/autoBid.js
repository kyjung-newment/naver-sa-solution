const { createApiClient } = require('../api/naverApi');
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

  try {
    const abKeywords = await db.getEnabledAutoBidKeywords(account.id);
    if (!abKeywords.length) return;

    // KST 현재 시간
    const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const currentHour = kstNow.getUTCHours();
    const now = Date.now();

    // 실행 대상 키워드 필터링
    const targets = abKeywords.filter(kw => {
      // 시간대 체크
      const schedule = kw.schedule || '111111111111111111111111';
      if (schedule[currentHour] !== '1') return false;

      // 간격 체크: last_run 이후 bid_interval(분) 경과했는지
      const interval = (kw.bid_interval || 10) * 60 * 1000;
      const lastRun = kw.last_run ? new Date(kw.last_run).getTime() : 0;
      return (now - lastRun) >= interval;
    });

    if (!targets.length) return;

    console.log(`\n🤖 [${account.name}] 자동입찰: ${targets.length}/${abKeywords.length}개 (${currentHour}시)`);

    // 병렬 10개씩 배치 처리
    const BATCH = 10;
    let adjusted = 0;
    for (let i = 0; i < targets.length; i += BATCH) {
      const batch = targets.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(kw => adjustBidForKeyword(client, kw))
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
async function adjustBidForKeyword(client, abKw) {
  const { keyword_id, keyword, target_rank, max_bid, adjust_amt, device } = abKw;

  try {
    // 현재 입찰가 조회
    let currentBid = abKw.last_bid || 0;
    try {
      const kwInfo = await client.getKeywordInfo(keyword_id);
      currentBid = kwInfo?.bidAmt || currentBid;
    } catch (e) { /* fallback */ }

    // 목표 순위에 필요한 입찰가 조회 (estimate API)
    let currentRank = 999;
    let targetBid = 0;
    try {
      const est = await client.getEstimatedBidForPosition(keyword_id, device, target_rank);
      targetBid = est?.estimate?.[0]?.bid || 0;
      if (targetBid > 0) {
        currentRank = currentBid >= targetBid ? target_rank : (target_rank + 1);
      }
    } catch (e) {
      console.log(`  순위 추정 실패 [${keyword}]:`, e.message);
    }

    let newBid = currentBid;

    if (targetBid > 0 && currentBid < targetBid) {
      // 목표 순위 미달 → 입찰가 상향
      newBid = Math.min(currentBid + adjust_amt, max_bid);
    } else if (targetBid > 0 && currentBid > targetBid + adjust_amt) {
      // 입찰가 과다 → 하향
      newBid = Math.max(currentBid - adjust_amt, 70);
    }

    const changed = newBid !== currentBid && newBid > 0;
    if (changed) {
      await client.updateKeywordBid(keyword_id, newBid);
      console.log(`  🎯 [${keyword}] ${device} ${currentBid}→${newBid}원 (현재:${currentRank.toFixed(1)}위 목표:${target_rank}위)`);
    }

    // DB 상태 + last_run 갱신
    await db.updateAutoBidKeywordStatus(keyword_id, device, currentRank, newBid || currentBid).catch(() => {});

    return changed;
  } catch (err) {
    console.error(`  ⚠️ [${keyword}] ${device} 실패:`, err.message);
    // last_run은 갱신하여 다음 interval까지 재시도 방지
    await db.pool.query(
      'UPDATE auto_bid_keywords SET last_run = CURRENT_TIMESTAMP WHERE keyword_id = $1 AND device = $2',
      [keyword_id, device]
    ).catch(() => {});
    return false;
  }
}

module.exports = { runAutoBiddingForAccount };
