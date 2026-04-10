/**
 * 네이버 통합검색 "네이버 가격비교" 섹션에서 쇼핑 광고 순위 조회
 *
 * 파싱 방법:
 * - PC: search.naver.com → #shp_dui_root 섹션
 * - MO: m.search.naver.com → #shp_lis_root 섹션
 * - 광고: data-slog-content에 "nad-xxx" 포함 (소재 ID)
 * - 일반상품: data-slog-content에 "00000009_xxx"
 *
 * 순위 산정: 광고 상품만 카운트 (일반상품 제외)
 * 매칭: 소재 ID (nad-xxx) 기반
 */
const axios = require('axios');
const cheerio = require('cheerio');

const PC_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MO_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/**
 * 네이버 통합검색에서 쇼핑 광고 목록 조회
 * @returns {Array<{rank, title, price, mallName, isAd, nadId}>} 광고만 필터링된 목록
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

    // PC: #shp_gui_root (구: #shp_dui_root) / MO: #shp_tli_root (구: #shp_lis_root)
    let section = $('#shp_gui_root');
    if (section.length === 0) section = $('#shp_dui_root');
    if (section.length === 0) section = $('#shp_tli_root');
    if (section.length === 0) section = $('#shp_lis_root');
    if (section.length === 0) {
      // fallback: data-slog-container로 찾기
      section = $('[data-slog-container*="shp_"]');
    }

    if (section.length === 0) {
      console.log(`  🛒 [${device}] 쇼핑 섹션 없음, HTML: ${response.data.length}자`);
      return [];
    }

    const items = section.find('li[data-slog-content]');
    console.log(`  🛒 [${device}] 쇼핑 섹션: 전체 ${items.length}개 상품`);

    // 모든 아이템 파싱
    const allItems = [];
    items.each((idx, el) => {
      const $el = $(el);
      const slogContent = $el.attr('data-slog-content') || '';
      const nadMatch = slogContent.match(/nad-[\w-]+/);
      const nadId = nadMatch ? nadMatch[0] : '';
      const isAd = !!nadId;
      const fullText = $el.text().replace(/\s+/g, ' ').trim();

      // 상품명 추출
      let title = '';
      const priceIdx = fullText.search(/\d{1,3}(,\d{3})*원/);
      if (priceIdx > 0) title = fullText.slice(0, priceIdx).trim();

      // 가격
      const priceMatch = fullText.match(/(\d{1,3}(?:,\d{3})*원)/);
      const price = priceMatch ? priceMatch[1] : '';

      // 상점명 추출
      // 광고 상품: "...배송비무료브라이튼프레임광고①..." → "브라이튼프레임"
      // 일반 상품: "...멜팅스튜디오네이버페이..." → "멜팅스튜디오"
      let mallName = '';

      if (isAd) {
        // 광고: "상점명광고" 패턴에서 상점명 추출
        // 불필요한 텍스트 제거 후 광고 직전 단어 추출
        const adMatch = fullText.match(/([\s\S]*?)광고[①②③④⑤⑥⑦⑧⑨⑩]?/);
        if (adMatch) {
          const before = adMatch[1];
          // 뒤에서부터 한글/영문 상점명 추출 (숫자/원/배송 등 제거)
          const nameMatch = before.match(/([가-힣A-Za-z][가-힣A-Za-z0-9\s]{0,20}?)$/);
          if (nameMatch) {
            mallName = nameMatch[1].trim()
              .replace(/^.*(?:무료|배송비|원|주문\s*시|쿠폰|할인가)\s*/g, '')
              .trim();
          }
        }
      }

      if (!mallName) {
        // 일반: "상점명네이버페이" 패턴
        const payMatch = fullText.match(/([가-힣A-Za-z][가-힣A-Za-z0-9\s]{0,15}?)네이버페이/);
        if (payMatch) {
          mallName = payMatch[1].trim()
            .replace(/^.*(?:무료|배송비|원|주문\s*시)\s*/g, '')
            .trim();
        }
      }

      allItems.push({ title, price, mallName, isAd, nadId, slogContent });
    });

    // 광고만 필터링하여 순위 부여
    let adRank = 0;
    const adItems = allItems.filter(item => item.isAd).map(item => {
      adRank++;
      return { ...item, rank: adRank };
    });

    console.log(`  🛒 [${device}] 광고 ${adItems.length}개 / 일반 ${allItems.length - adItems.length}개`);

    return adItems;
  } catch (err) {
    console.error(`  🛒 [${device}] 쇼핑검색 파싱 오류:`, err.message);
    return [];
  }
}

/**
 * 특정 소재의 쇼핑검색 광고 순위 찾기
 *
 * 매칭: 소재 ID(nad-xxx) → smartstore ID → 상점명
 */
async function findShoppingRank(keyword, device, productUrl) {
  const ads = await getShoppingAds(keyword, device);
  if (!ads.length) return { rank: 0, totalAds: 0, ads: [], matched: null };

  let matched = null;

  // 1차: 소재 ID(nad-xxx) 직접 매칭
  const targetNadMatch = productUrl.match(/nad-[\w-]+/);
  if (targetNadMatch) {
    const targetNadId = targetNadMatch[0];
    matched = ads.find(ad => ad.nadId === targetNadId);
    if (matched) {
      console.log(`  🎯 nad-ID 매칭: ${targetNadId} → 광고 ${matched.rank}위`);
    }
  }

  // 2차: smartstore URL의 스토어 ID로 매칭
  if (!matched) {
    const storeMatch = productUrl.match(/smartstore\.naver\.com\/([^\/\?#]+)/i);
    if (storeMatch) {
      const storeId = storeMatch[1].toLowerCase();
      // mallName에 스토어 관련 이름이 포함된 광고 찾기
      matched = ads.find(ad => {
        if (!ad.mallName) return false;
        const mall = ad.mallName.toLowerCase().replace(/\s+/g, '');
        return mall.includes(storeId) || storeId.includes(mall);
      });
      if (matched) {
        console.log(`  🎯 스토어 매칭: ${storeId} → ${matched.mallName} → 광고 ${matched.rank}위`);
      }
    }
  }

  // 3차: URL의 경로 부분과 mallName 매칭
  if (!matched && productUrl) {
    const urlParts = productUrl.replace(/^https?:\/\//, '').split('/').filter(Boolean);
    for (const part of urlParts) {
      if (part.includes('.')) continue;
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
