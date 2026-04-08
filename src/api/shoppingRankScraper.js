/**
 * 네이버 통합검색 "네이버 가격비교" 섹션에서 쇼핑 광고 순위 조회
 *
 * 파싱 방법:
 * - search.naver.com 통합검색 HTML의 #shp_dui_root 섹션
 * - li[data-slog-content] 에서 상품 정보 추출
 * - 광고 상품: data-slog-content="shp_dui:nad-xxx" (nad- ID 포함)
 * - 일반 상품: data-slog-content="shp_dui:00000009_xxx"
 *
 * 매칭: 소재 ID (nad-xxx) 또는 상점명(mallName) 기반
 */
const axios = require('axios');
const cheerio = require('cheerio');

const PC_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MO_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/**
 * 네이버 통합검색에서 쇼핑(가격비교) 상품 목록 조회
 */
async function getShoppingAds(keyword, device = 'PC') {
  const isPC = device !== 'MO';
  const userAgent = isPC ? PC_USER_AGENT : MO_USER_AGENT;
  const url = isPC
    ? 'https://search.naver.com/search.naver'
    : 'https://m.search.naver.com/search.naver';
  const params = isPC
    ? { where: 'nexearch', query: keyword }
    : { where: 'm', query: keyword };

  try {
    const response = await axios.get(url, {
      params,
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
      timeout: 10000,
    });

    const $ = cheerio.load(response.data);
    const ads = [];
    let rank = 0;

    // #shp_dui_root 섹션 내의 li[data-slog-content] 아이템
    const section = $('#shp_dui_root');
    if (section.length === 0) {
      console.log(`  🛒 [${device}] #shp_dui_root 섹션 없음`);
      // fallback: 전체 HTML에서 shp_dui 관련 li 찾기
      const fallbackItems = $('li[data-slog-content*="shp_dui"]');
      if (fallbackItems.length === 0) {
        console.log(`  🛒 [${device}] shp_dui 아이템도 없음, HTML 길이: ${response.data.length}`);
        return [];
      }
      return parseShoppingItems($, fallbackItems, device);
    }

    const items = section.find('li[data-slog-content]');
    console.log(`  🛒 [${device}] #shp_dui_root: ${items.length}개 상품 발견`);

    return parseShoppingItems($, items, device);
  } catch (err) {
    console.error(`  🛒 [${device}] 쇼핑검색 파싱 오류:`, err.message);
    return [];
  }
}

/**
 * li 아이템들에서 상품 정보 추출
 */
function parseShoppingItems($, items, device) {
  const ads = [];
  let rank = 0;

  items.each((idx, el) => {
    const $el = $(el);
    const slogContent = $el.attr('data-slog-content') || '';

    // nad- ID 추출 (광고 소재 ID)
    const nadMatch = slogContent.match(/nad-[\w-]+/);
    const nadId = nadMatch ? nadMatch[0] : '';
    const isAd = !!nadId;

    // 전체 텍스트
    const fullText = $el.text().replace(/\s+/g, ' ').trim();

    // 상품명 추출 (첫 번째 링크의 텍스트 또는 주요 텍스트)
    let title = '';
    const titleEl = $el.find('a[class*="tit"], a[class*="name"], [class*="tit"] a').first();
    if (titleEl.length > 0) {
      title = titleEl.text().trim();
    }
    if (!title) {
      // fallback: 첫 번째 의미있는 링크 텍스트
      $el.find('a').each((i, a) => {
        const t = $(a).text().trim();
        if (t.length > 5 && !title) title = t;
      });
    }
    if (!title) {
      // fullText에서 가격 앞의 텍스트를 제목으로 사용
      const priceIdx = fullText.search(/\d{1,3}(,\d{3})*원/);
      if (priceIdx > 0) title = fullText.slice(0, priceIdx).trim();
    }

    // 가격 추출
    const priceMatch = fullText.match(/(\d{1,3}(?:,\d{3})*원)/);
    const price = priceMatch ? priceMatch[1] : '';

    // 상점명 추출 (광고 텍스트 앞의 단어)
    let mallName = '';
    // "SujP광고" or "브라이튼프레임광고" 패턴
    const mallAdMatch = fullText.match(/([가-힣a-zA-Z0-9]+)광고/);
    if (mallAdMatch && isAd) {
      mallName = mallAdMatch[1];
    }
    // 일반 상품: "멜팅스튜디오네이버페이" 등
    if (!mallName) {
      const mallPayMatch = fullText.match(/([가-힣a-zA-Z0-9]+)네이버페이/);
      if (mallPayMatch) mallName = mallPayMatch[1];
    }
    // "판매처" 앞의 상점명
    if (!mallName) {
      const sellerMatch = fullText.match(/([가-힣a-zA-Z0-9]+)(?:판매처|찜)/);
      if (sellerMatch) mallName = sellerMatch[1];
    }

    // 링크 URL
    const linkEl = $el.find('a[href]').first();
    const url = linkEl.attr('href') || '';

    if (title || mallName) {
      rank++;
      ads.push({
        rank,
        title: title || mallName,
        price,
        mallName,
        url,
        isAd,
        nadId,
        slogContent,
      });
    }
  });

  return ads;
}

/**
 * 특정 소재/상품의 쇼핑검색 순위 찾기
 *
 * 매칭 방법:
 * 1) 소재 ID(nad-xxx) 매칭 — 가장 정확
 * 2) 상점명(mallName) 매칭
 * 3) smartstore URL 경로 매칭
 */
async function findShoppingRank(keyword, device, productUrl) {
  const ads = await getShoppingAds(keyword, device);
  if (!ads.length) return { rank: 0, totalAds: 0, ads: [], matched: null };

  let matched = null;

  // 1차: productUrl에 nad- ID가 포함된 경우 (소재 ID 직접 매칭)
  const targetNadMatch = productUrl.match(/nad-[\w-]+/);
  if (targetNadMatch) {
    const targetNadId = targetNadMatch[0];
    matched = ads.find(ad => ad.nadId === targetNadId);
    if (matched) {
      console.log(`  🎯 nad- ID 매칭: ${targetNadId} → ${matched.rank}위`);
    }
  }

  // 2차: smartstore URL → 스토어 ID 매칭 (mallName 또는 URL)
  if (!matched) {
    const storeMatch = productUrl.match(/smartstore\.naver\.com\/([^\/\?#]+)/i);
    if (storeMatch) {
      const storeId = storeMatch[1].toLowerCase();
      matched = ads.find(ad => {
        // 광고 URL에 smartstore 경로가 포함된 경우
        if (ad.url && ad.url.toLowerCase().includes(storeId)) return true;
        return false;
      });
    }
  }

  // 3차: 상점명 텍스트 매칭
  if (!matched && productUrl) {
    // URL에서 상점명 힌트 추출
    const parts = productUrl.replace(/^https?:\/\//, '').split('/').filter(Boolean);
    for (const part of parts) {
      if (part.includes('.')) continue; // 도메인 부분 스킵
      const clean = part.toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
      if (clean.length < 2) continue;
      const found = ads.find(ad => {
        if (!ad.mallName) return false;
        const mall = ad.mallName.toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
        return mall === clean || mall.includes(clean) || clean.includes(mall);
      });
      if (found) { matched = found; break; }
    }
  }

  return {
    rank: matched ? matched.rank : 0,
    totalAds: ads.length,
    ads,
    matched,
  };
}

module.exports = { getShoppingAds, findShoppingRank };
