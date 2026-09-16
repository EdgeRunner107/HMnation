# 전체 후원 목표 위젯

## 현재 구조와 집계 기준

- 기존 개인별 위젯: `/widget/ranking/:login_id`.
- `users.login_id`로 사용자를 찾은 뒤 `users.id`를 `get_current_donation_ranking(p_user_id, p_limit)`에 전달합니다.
- 개별 후원은 `bank_donations`, 후원자별 금액은 위 함수의 `total_amount`입니다. 프론트는 반환된 순위를 표시하며 금액을 재집계하지 않습니다.
- 기존 랭킹 API는 기본 6명, 최대 100명을 반환합니다. 이 응답만 합산하면 나머지 후원자가 누락됩니다.
- 새 `get_donation_db_total()`은 PostgreSQL 안에서 모든 활성 사용자(`is_active IS DISTINCT FROM false`)의 기존 랭킹 함수를 호출하고 `total_amount`를 합산합니다. 기존 API가 거절하는 비활성 사용자는 제외합니다.
- 따라서 취소 제외, `ranking_reset_at`, 후원자 그룹 기준 등은 기존 함수가 그대로 결정합니다. 실행 대기/완료 조건도 새로 추가하지 않습니다.
- 새 목표는 **서비스 전체 합계**이며 `login_id`/`userid`로 필터링하지 않습니다. Toonation 상태도 전역 1개입니다. 기존 개인별 링크는 그대로 유지합니다.

기존 DB 함수의 SQL 본문은 저장소에 없습니다. 새 SQL은 기존 함수의 `p_limit`에 `2147483647`을 전달하며, 함수 내부에서 `LEAST(p_limit, 6)` 같은 별도 상한을 강제하지 않는다는 전제입니다. 실제 함수 정의는 다음 읽기 전용 SQL로 확인할 수 있습니다. 내부 상한이 있다면 배포 전에 그 정의에 맞는 전체 집계가 필요합니다.

```sql
select pg_get_functiondef(p.oid)
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'get_current_donation_ranking';
```

## 설치

1. Supabase SQL Editor에서 [`sql/goal-progress.sql`](sql/goal-progress.sql) 전체를 실행합니다. 기존 랭킹 함수나 후원 기록은 변경하지 않습니다.
2. 백엔드 환경변수 `TOONATION_GOAL_TOKEN`에 수집기 전용 비밀 문자열을 설정합니다. 이 값은 서버와 Tampermonkey 수집기에만 두며, 프론트 환경변수나 위젯 URL에 넣지 않습니다.
3. 백엔드와 프론트를 배포합니다. 프론트의 기존 `VITE_API_BASE` 설정을 그대로 사용합니다.
4. 관리자 화면에 추가된 **전체 후원 목표 그래프 URL**을 복사하거나 다음 주소를 OBS/PRISM 브라우저 소스에 넣습니다.

```text
https://hmnat-livid.vercel.app/widget/goal
```

권장 시작 크기는 720 × 80이며 작은 화면에서도 폭에 맞춥니다. 위젯 바는 밝은 회색, 진행 영역은 검정이고 나머지 페이지는 투명합니다. 기존 `/widget/ranking/:login_id` 및 기존 그래프바 URL은 바꾸지 않습니다.

## Toonation 현재 누적값 전송

```http
POST https://hmnation.onrender.com/api/toonation-goal
Content-Type: application/json
Authorization: Bearer <TOONATION_GOAL_TOKEN>

{"amount":11900}
```

```json
{
  "ok": true,
  "toonAmount": 11900,
  "toonUpdatedAt": "2026-09-16T00:00:00.000Z"
}
```

`amount`는 0 이상인 정수 JSON 숫자이며 최대 `Number.MAX_SAFE_INTEGER`입니다. 문자열, 퍼센트가 포함된 DOM 원문, 음수, 소수는 400으로 거절합니다. 토큰이 없거나 틀리면 401, 서버에 토큰이 설정되지 않았으면 503입니다. 저장 실패는 500이며 이전 값은 유지됩니다.

향후 Tampermonkey 수집기는 `#widget_wrapper .widget-style-default-single-line .display-progress-text`의 `11,900 (1.2%)`에서 금액 부분만 숫자 `11900`으로 변환해 전송해야 합니다. 표시 퍼센트의 숫자를 금액에 섞지 않습니다. Toonation의 `.display-goal-text` 값은 새 위젯 목표 계산에 사용하지 않습니다. 새 목표는 합산액에 따라 자동 계산합니다.

매 POST는 `toonation_goal_state`의 **id=1**에 UPSERT합니다. 같은 값을 반복 전송해도 합산되지 않습니다. 값이 내려가거나 0으로 초기화되는 경우도 최신 스냅샷으로 저장하고, 서버 수신 시각으로 `updated_at`을 갱신합니다. 수집기는 한 개를 사용하고 POST를 순서대로 완료시켜 수집 순서를 유지합니다. 이번 변경에는 Tampermonkey 코드 수정이 없습니다.

## 최종값 조회

```http
GET https://hmnation.onrender.com/api/goal-progress
```

```json
{
  "ok": true,
  "toonAmount": 11900,
  "dbAmount": 50000,
  "totalAmount": 61900,
  "goalAmount": 100000,
  "percent": 61.9,
  "toonUpdatedAt": "2026-09-16T00:00:00.000Z",
  "isToonStale": false
}
```

데이터 흐름:

```text
Tampermonkey 현재값 → POST → toonation_goal_state(id=1) 덮어쓰기
users → 기존 get_current_donation_ranking → get_donation_db_total()
두 현재값 조회 → dbAmount + toonAmount → 목표 단계/퍼센트 계산
GET /api/goal-progress → /widget/goal → HM 61,900 (61.9%)
```

조회할 때마다 두 현재 총액을 더합니다. 이전 표시값에 Toonation 값을 더하지 않습니다. Toonation이 아직 저장되지 않았으면 0/`toonUpdatedAt: null`을 사용합니다. 마지막 수신 후 60초가 지났으면 `isToonStale: true`지만 금액은 계속 포함합니다. DB/RPC 오류는 500으로 반환하며 실패를 0원으로 대체하지 않습니다.

목표는 `totalAmount <= 100000`일 때 100,000원, 초과하면 1,000,000원, 이후 각 백만원을 **초과할 때** 다음 백만원으로 바뀝니다. 최대 목표는 10,000,000원이며 총액은 상한 없이 안전한 정수 범위까지 표시합니다. 퍼센트는 최대 100%, 소수점 한 자리입니다.

프론트는 최초 진입 즉시 조회하고 요청 종료 10초 후 다시 조회합니다. 요청은 겹치지 않으며 오류 시 마지막 정상 화면을 유지합니다. 처음부터 실패했다면 `—`를 표시합니다. 위젯 해제 시 타이머·요청·전용 body/html 클래스를 정리합니다.

## 검증

```bash
# HMNAT-BACK
npm test

# HMNAT-FRONT
npm run build
npm test
```

백엔드 테스트는 모든 목표 경계, A~D 예시, 동일 스냅샷 반복/감소/0, UPSERT, 토큰·입력 검증, stale 금액 유지, 오류 처리를 확인합니다. 기존 후원 API 테스트도 유지합니다. 브라우저 테스트는 10초 갱신, 오류 복구, 개인별 링크 보존, 모바일/OBS 크기와 관리자 배경 복구를 확인합니다.

자동 API 테스트는 로컬 모의 DB를 사용합니다. SQL 테스트는 테스트 전용 개발 의존성 PGlite의 메모리 PostgreSQL에서 실제 `sql/goal-progress.sql`을 실행합니다. 1,500명 이상 합산, 취소·초기화 반영, 테이블 제약, 권한, 재실행 시 기존 함수·데이터 보존을 확인합니다. 이때 기존 랭킹 함수는 테스트용 정의이며 운영 함수의 SQL 본문을 검증한 것은 아닙니다.

운영 SQL 적용 후에는 아래 조회값을 활성 사용자의 전체 랭킹 합계와 비교하고, 반복 POST 시 총액이 늘어나지 않는지 확인합니다.

```sql
select public.get_donation_db_total();
select id, amount, updated_at from public.toonation_goal_state;
```

## 변경 파일

수정:

- 백엔드 `server.js`: 새 라우트 등록만 추가.
- 백엔드 `package.json`, `package-lock.json`: SQL 테스트용 PGlite 개발 의존성.
- 백엔드 `tests/donations.test.js`: 기존 API 회귀 테스트에 목표 API 테스트 추가.
- 프론트 `src/main.jsx`, `vercel.json`: `/widget/goal` 진입 경로 추가.
- 프론트 `src/api.js`: 전체 목표 조회 함수 추가.
- 프론트 `src/App.jsx`, `src/components/UrlCard.jsx`: 기존 두 링크 옆에 전체 목표 링크 추가.
- 프론트 `tests/login.spec.js`: 추가된 URL 카드 수 반영.

신규:

- 백엔드 `goalProgress.js`, `sql/goal-progress.sql`, `GOAL-PROGRESS.md`.
- 백엔드 `tests/goalProgress.test.js`, `tests/goalProgress.sql.test.js`.
- 프론트 `src/pages/GoalWidget.jsx`, `src/pages/GoalWidget.css`, `tests/goal-widget.spec.js`.
