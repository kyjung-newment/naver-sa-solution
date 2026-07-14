# 네이버 SA 솔루션

네이버 검색광고(SA) API 기반 **광고대행사 멀티계정 관리 + 자동 리포트** 솔루션

- 대시보드: `/smart-sa` (성과 요약 · 캠페인/그룹/키워드/타겟/시간대 분석)
- 자동 리포트: 광고주별 일간/주간/월간 엑셀 리포트 이메일 발송
- 성과개선 전략: 증액(Upselling) / 감액(Downselling) / 원클릭 계정분석 제안

---

## 📁 프로젝트 구조

```
naver-sa-solution/
├── api/index.js              # Vercel 서버리스 진입점
├── src/
│   ├── index.js              # 메인 진입점 (로컬 실행 시 스케줄러 포함)
│   ├── api/
│   │   ├── naverApi.js       # 네이버 SA API 클라이언트 (HMAC 인증, 429 백오프)
│   │   ├── naverDaApi.js     # DA(GFA) API (기능 플래그로 비활성)
│   │   └── *RankScraper.js   # 순위 조회 스크래퍼
│   ├── dashboard/server.js   # 대시보드 전체 라우트 + UI
│   ├── db/database.js        # PostgreSQL(Supabase) 스키마 & 쿼리
│   ├── sync/dashboardSync.js # 일별 성과 데이터 동기화 (크론)
│   ├── report/               # 리포트 데이터 수집/제안 생성
│   ├── email/                # 엑셀 리포트 & 메일 발송
│   └── scheduler/            # 로컬 실행용 Cron 스케줄러
├── config/index.js           # 설정 & 기능 플래그 (DA/자동입찰 ON·OFF)
├── vercel.json               # Vercel 배포 + 크론 스케줄
└── package.json
```

---

## ⚡ 빠른 시작

### 1. 설치

```bash
npm install
cp .env.example .env
```

### 2. .env 설정

```env
PORT=3000
SITE_DOMAIN=https://yourdomain.com
SESSION_SECRET=랜덤하게_긴_문자열
DATABASE_URL=postgresql://... (Supabase 등 PostgreSQL)
CRON_SECRET=랜덤하게_긴_문자열   # Vercel 크론 보안 키
```

> 네이버 SA API 키, 광고주 계정, 발송용 SMTP는 **대시보드 웹 UI**에서 등록합니다.
> (API 설정 → 대행사 자격증명 / 광고주 관리 → 계정 연결)

### 3. 실행

```bash
npm start                 # 서버 + 스케줄러
npm run report:daily      # 리포트 즉시 테스트 (weekly/monthly 동일)
```

---

## 🔀 기능 플래그

`config/index.js`의 `features`에서 일원화 관리 (대시보드/스케줄러 공용):

| 플래그 | 기본값 | 설명 |
|---|---|---|
| `DA` | `false` | DA(GFA) 성과 대시보드 + DA 리포트 (공식 API 연동 전까지 OFF) |
| `AUTOBID` | `false` | 파워링크 자동입찰 (원클릭 계정분석 제안으로 대체) |
| `SHOPPING_BID` | `false` | 쇼핑검색 자동입찰 |

---

## 🔄 데이터 동기화

- Vercel 크론(`vercel.json`)이 매일 전 계정의 전일 성과를 DB에 저장
  - `stat_daily_detail`: AD_DETAIL + 전환 리포트 (키워드/시간대/기기 분석용)
  - `stat_campaign_daily`: Stats API 캠페인 합계 (네이버 대시보드와 일치)
- 동기화는 계정+날짜 단위 **트랜잭션 + advisory lock**으로 원자적 처리 (중복 실행 시 이중 집계 방지)
- 광고주별 대행사 자격증명(`agency_credentials`)이 연결된 경우 해당 키로 동기화

---

## 👥 권한 구조

- `marketer`: API 소유자. 광고주 등록/설정/리포트 관리
- `viewer`: 광고주 초대 계정. 지정된 광고주 대시보드 열람 + 리포트 다운로드만
- `admin`: 직원 승인/관리 + 수동 전체 동기화

---

## 💡 API 호출 최적화

- 네이버 API 병렬 호출은 동시 8개로 제한 (429 방지, 초과 시 지수 백오프 재시도)
- 마스터 리포트는 계정별 in-flight 가드로 중복 job 생성 방지 (계정당 100개 한도 보호)
- 일별 통계 리포트는 4시간 메모리 캐시
