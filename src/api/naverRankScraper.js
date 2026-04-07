/**
 * 네이버 검색결과에서 파워링크 광고 실시간 순위 조회
 * - 네이버 SA API에서 실시간 순위 API를 제공하지 않아 검색결과 HTML 파싱 방식 사용
 * - 파워링크 광고는 SSR로 렌더링되어 HTTP 요청만으로 파싱 가능
 */
const axios = require('axios');
const cheerio = require('cheerio');

const PC_SEARCH_URL = 'https://search.naver.com/search.naver';
const MO_SEARCH_URL = 'https://m.search.naver.com/search.naver';

const PC_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MO_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/**
 * 네이버 검색결과에서 파워링크 광고 목록 조회
 * @param {string} keyword - 검색 키워드
 * @param {'PC'|'MO'} device - 디바이스 타입
 * @returns {Array<{rank: number, headline: string, description: string, displayUrl: string, finalUrl: string}>}
 */
async function getPowerLinkAds(keyword, device = 'PC') {
  const isPC = device !== 'MO';
  const url = isPC ? PC_SEARCH_URL : MO_SEARCH_URL;
  const params = isPC
    ? { where: 'nexearch', query: keyword }
    : { where: 'm', query: keyword };

  try {
    const response = await axios.get(url, {
      params,
      headers: {
        'User-Agent': isPC ? PC_USER_AGENT : MO_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      },
      timeout: 10000,
      maxRedirects: 3,
    });

    const $ = cheerio.load(response.data);
    const ads = [];

    if (isPC) {
      // PC: #power_link_body 또는 .ad_section 내부의 광고 목록
      const adItems = $('#power_link_body li.lst, .ad_section li.lst');
      adItems.each((idx, el) => {
        const $el = $(el);
        const headline = $el.find('.lnk_tit, .tit_wrap a, .lnk_head').first().text().trim();
        const description = $el.find('.ad_dsc_inner, .dsc_wrap, .lnk_txt').first().text().trim();
        const displayUrl = $el.find('.lnk_url, .url_area .url').first().text().trim();

        // final_url은 onclick 또는 href에서 추출
        let finalUrl = '';
        const linkEl = $el.find('a.lnk_tit, a.tit_wrap, .tit_area a').first();
        if (linkEl.length) {
          finalUrl = linkEl.attr('href') || '';
        }

        if (headline) {
          ads.push({
            rank: idx + 1,
            headline,
            description,
            displayUrl: displayUrl.replace(/https?:\/\//, ''),
            finalUrl,
          });
        }
      });

      // fallback: onclick 속성에서 r= 파라미터로 순위 추출
      if (ads.length === 0) {
        $('[onclick*="pwl_nop"]').each((idx, el) => {
          const onclick = $(el).attr('onclick') || '';
          const rMatch = onclick.match(/r=(\d+)/);
          const rank = rMatch ? parseInt(rMatch[1]) : idx + 1;
          const $li = $(el).closest('li');
          const headline = $li.find('.lnk_tit, .tit_wrap a').first().text().trim();
          const displayUrl = $li.find('.lnk_url, .url_area .url').first().text().trim();
          if (headline && !ads.find(a => a.rank === rank)) {
            ads.push({
              rank,
              headline,
              description: '',
              displayUrl: displayUrl.replace(/https?:\/\//, ''),
              finalUrl: '',
            });
          }
        });
      }
    } else {
      // 모바일: #mobilePowerLink 또는 모바일 광고 섹션
      const adItems = $('[class*="powerlink"] li, [id*="mobilePowerLink"] li, .lst_total > li');
      adItems.each((idx, el) => {
        const $el = $(el);
        const headline = $el.find('.tit, .tit_area a, a.tit').first().text().trim();
        const description = $el.find('.dsc, .desc, .ad_dsc').first().text().trim();
        const displayUrl = $el.find('.url, .url_area .url, .lnk_url').first().text().trim();

        if (headline) {
          ads.push({
            rank: idx + 1,
            headline,
            description,
            displayUrl: displayUrl.replace(/https?:\/\//, ''),
            finalUrl: '',
          });
        }
      });
    }

    return ads;
  } catch (err) {
    console.error(`검색결과 파싱 오류 [${keyword}/${device}]:`, err.message);
    return [];
  }
}

/**
 * 특정 광고주의 광고 순위를 찾기
 * @param {string} keyword - 검색 키워드
 * @param {'PC'|'MO'} device - 디바이스
 * @param {string} siteUrl - 광고주 사이트 URL (display_url 매칭용)
 * @returns {{rank: number, totalAds: number, ad: object}|null}
 */
async function findAdRank(keyword, device, siteUrl) {
  const ads = await getPowerLinkAds(keyword, device);
  if (!ads.length) return { rank: 0, totalAds: 0, ads: [], matched: null };

  // siteUrl에서 도메인 추출 (www 제외)
  const normalizeUrl = (url) => {
    return (url || '')
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/$/, '')
      .toLowerCase();
  };

  const targetDomain = normalizeUrl(siteUrl);

  // 도메인 매칭으로 광고 찾기
  const matched = ads.find(ad => {
    const adDomain = normalizeUrl(ad.displayUrl);
    return adDomain.includes(targetDomain) || targetDomain.includes(adDomain);
  });

  return {
    rank: matched ? matched.rank : 0, // 0 = 순위 밖
    totalAds: ads.length,
    ads,
    matched,
  };
}

module.exports = { getPowerLinkAds, findAdRank };
