const { createApiClient } = require('../api/naverApi');
const db = require('../db/database');

const runningAccounts = new Set();

/**
 * 자동입찰 실행 (키워드별 설정 기반)
 * - 각 키워드의 희망순위, 최대입찰가, 조정입찰가, 실행시간대 설정에 따라 동작
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
    // DB에서 활성화된 키워드 목록 조회
    const abKeywords = await db.getEnabledAutoBidKeywords(account.id);
    if (!abKeywords.length) return;

    // 현재 시간 (KST)
    const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const currentHour = kstNow.getUTCHours();

    console.log(`\n🤖 [${account.name}] 자동입찰 시작 (${abKeywords.length}개 키워드, ${currentHour}시)`);

    for (const abKw of abKeywords) {
      // 시간대 체크: schedule은 24자리 문자열 (0=off, 1=on)
      const schedule = abKw.schedule || '111111111111111111111111';
      if (schedule[currentHour] !== '1') {
        continue; // 이 시간대에는 실행하지 않음
      }

      try {
        await adjustBidForKeyword(client, abKw);
        await new Promise(r => setTimeout(r, 200)); // rate limit
      } catch (err) {
        console.error(`  ⚠️ [${abKw.keyword}] 입찰가 조정 실패:`, err.message);
      }
    }

    console.log(`✅ [${account.name}] 자동입찰 완료`);
  } catch (err) {
    console.error(`❌ [${account.name}] 자동입찰 오류:`, err.message);
  } finally {
    runningAccounts.delete(account.id);
  }
}

/**
 * 개별 키워드 입찰가 조정
 * - getBidSimulation으로 현재 순위 확인
 * - 희망순위보다 낮으면 조정금액만큼 상향 (최대입찰가 이내)
 * - 희망순위보다 높으면 조정금액만큼 하향 (70원 이상)
 */
async function adjustBidForKeyword(client, abKw) {
  const { keyword_id, keyword, target_rank, max_bid, adjust_amt, device } = abKw;

  // 현재 키워드 정보 조회
  let currentBid;
  try {
    // 키워드 상세 정보에서 현재 입찰가 가져오기
    const kwInfo = await client.getKeywordInfo(keyword_id);
    currentBid = kwInfo?.bidAmt || 0;
  } catch (e) {
    // getKeywordInfo가 없으면 getBidSimulation 결과 사용
    currentBid = abKw.last_bid || 0;
  }

  // 입찰 시뮬레이션으로 현재 순위 확인
  const simulation = await client.getBidSimulation(keyword_id);
  const currentRank = simulation?.avgRnk || 999;

  let newBid = currentBid;

  if (currentRank > target_rank) {
    // 순위가 목표보다 낮으면 → 입찰가 상향
    newBid = Math.min(currentBid + adjust_amt, max_bid);
  } else if (currentRank < target_rank - 1) {
    // 순위가 목표보다 높으면 → 입찰가 하향
    newBid = Math.max(currentBid - adjust_amt, 70); // 네이버 최소 입찰가 70원
  }

  // 입찰가 변경이 있으면 업데이트
  if (newBid !== currentBid && newBid > 0) {
    await client.updateKeywordBid(keyword_id, newBid);
    console.log(`  🎯 [${keyword}] ${device} ${currentBid}→${newBid}원 (현재: ${currentRank.toFixed(1)}위, 목표: ${target_rank}위)`);
  }

  // DB에 현재 상태 기록
  await db.updateAutoBidKeywordStatus(keyword_id, device, currentRank, newBid || currentBid).catch(() => {});
}

module.exports = { runAutoBiddingForAccount };
