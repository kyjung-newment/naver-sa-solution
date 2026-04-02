/**
 * ================================================================
 * 네이버SA 방문자 추적 스크립트
 * ================================================================
 *
 * 사용법:
 *   1. 아래 TRACKER_URL을 실제 서버 주소로 변경
 *   2. 모든 페이지의 </body> 직전에 이 스크립트를 삽입
 *
 * <script src="https://yourdomain.com/tracker.js"></script>
 *
 * 전환 추적 (구매완료 페이지 등):
 * <script>
 *   NaverTracker.conversion('purchase', 39000); // 이벤트타입, 금액
 * </script>
 * ================================================================
 */

(function() {
  'use strict';

  // ── 설정 ────────────────────────────────────────────────
  var TRACKER_URL = '{{TRACKER_DOMAIN}}/tracker/collect'; // 서버에서 치환됨
  var STORAGE_KEY = '_nav_tracker';

  // ── 세션 관리 ─────────────────────────────────────────────
  function getSessionId() {
    try {
      var sid = sessionStorage.getItem(STORAGE_KEY);
      if (!sid) {
        sid = Date.now() + '-' + Math.random().toString(36).slice(2, 9);
        sessionStorage.setItem(STORAGE_KEY, sid);
      }
      return sid;
    } catch (e) {
      return 'nosess-' + Date.now();
    }
  }

  // ── 페이지뷰 추적 ──────────────────────────────────────────
  function trackPageView() {
    var data = {
      url:       window.location.href,
      referrer:  document.referrer,
      sessionId: getSessionId(),
      title:     document.title,
    };

    // fetch API 사용 (지원하는 브라우저)
    if (typeof fetch !== 'undefined') {
      fetch(TRACKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        keepalive: true, // 페이지 이탈 후에도 전송
      }).catch(function() {
        // fetch 실패 시 img 방식으로 폴백
        fallbackBeacon(data);
      });
    } else {
      fallbackBeacon(data);
    }
  }

  // ── img 태그 폴백 (구형 브라우저) ─────────────────────────
  function fallbackBeacon(data) {
    var img = new Image(1, 1);
    img.src = TRACKER_URL
      + '?url=' + encodeURIComponent(data.url)
      + '&ref=' + encodeURIComponent(data.referrer)
      + '&sid=' + encodeURIComponent(data.sessionId)
      + '&t='   + Date.now();
  }

  // ── 전환 이벤트 ───────────────────────────────────────────
  function trackConversion(eventType, value) {
    var convUrl = TRACKER_URL.replace('/collect', '/conversion');
    var data = {
      sessionId: getSessionId(),
      eventType: eventType || 'purchase',
      value:     value || 0,
    };

    if (typeof fetch !== 'undefined') {
      fetch(convUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).catch(function() {});
    }
  }

  // ── SPA 지원 (History API 감지) ───────────────────────────
  var originalPushState = history.pushState;
  history.pushState = function() {
    originalPushState.apply(this, arguments);
    setTimeout(trackPageView, 100);
  };
  window.addEventListener('popstate', function() {
    setTimeout(trackPageView, 100);
  });

  // ── 초기 실행 ─────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', trackPageView);
  } else {
    trackPageView();
  }

  // ── 전역 API 노출 ─────────────────────────────────────────
  window.NaverTracker = {
    conversion: trackConversion,
    pageView:   trackPageView,
  };
})();
