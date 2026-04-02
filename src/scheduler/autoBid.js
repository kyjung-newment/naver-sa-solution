const { createApiClient } = require('../api/naverApi');

const runningAccounts = new Set();

async function runAutoBiddingForAccount(account) {
  if (runningAccounts.has(account.id)) {
    console.log(`⏭ [${account.name}] 자동입찰 이미 실행 중`);
    return;
  }
  runningAccounts.add(account.id);
  console.log(`\n🤖 [${account.name}] 자동입찰 시작 (목표: ${account.auto_bid_target_rank}위)`);

  // 사용자의 API 자격증명으로 해당 광고주(customer_id) 접근
  const client = createApiClient({
    apiKey: account.api_key,
    secretKey: account.secret_key,
    customerId: account.customer_id,
  });

  try {
    const campaigns = await client.getCampaigns();
    for (const campaign of (campaigns || [])) {
      const adGroups = await client.getAdGroups(campaign.nccCampaignId);
      for (const adGroup of (adGroups || [])) {
        const keywords = await client.getKeywords(adGroup.nccAdgroupId);
        for (const keyword of (keywords || [])) {
          await adjustBid(client, keyword, account);
          await new Promise(r => setTimeout(r, 200));
        }
      }
    }
  } catch (err) {
    console.error(`❌ [${account.name}] 자동입찰 오류:`, err.message);
  } finally {
    runningAccounts.delete(account.id);
  }
}

async function adjustBid(client, keyword, account) {
  const { nccKeywordId, keyword: kw, bidAmt } = keyword;
  const { auto_bid_target_rank: targetRank, auto_bid_max_bid: maxBid, auto_bid_min_bid: minBid } = account;

  try {
    const simulation = await client.getBidSimulation(nccKeywordId);
    const currentRank = simulation?.avgRnk || 999;
    let newBid = bidAmt;

    if (currentRank > targetRank) {
      newBid = Math.min(Math.ceil(bidAmt * 1.10), maxBid);
    } else if (currentRank < targetRank - 1) {
      newBid = Math.max(Math.floor(bidAmt * 0.92), minBid);
    }

    if (newBid !== bidAmt) {
      await client.updateKeywordBid(nccKeywordId, newBid);
      console.log(`  🎯 [${kw}] ${bidAmt}→${newBid}원 (현재: ${currentRank}위, 목표: ${targetRank}위)`);
    }
  } catch (err) {
    console.error(`  ⚠️ [${kw}] 입찰가 조정 실패:`, err.message);
  }
}

module.exports = { runAutoBiddingForAccount };
