# Elysia with Bun runtime

## Getting Started
To get started with this template, simply paste this command into your terminal:
```bash
bun create elysia ./elysia-example
```

## Development
To start the development server run:
```bash
bun run dev
```

Open http://localhost:3000/ with your browser to see the result.

## 라우터 및 API 설명

### 1. 인증(Auth) 라우터 (`/auth`)

- **용도 / 역할**: 사용자 인증, 액세스·리프레시 토큰 발급 및 갱신, 세션 종료.
- **엔드포인트 및 예상 시나리오**
  1. **POST `/auth/login`**
     - 시나리오: 사용자가 이메일과 비밀번호로 로그인합니다.
     - 인풋 Body: `{ "email": "user@example.com", "password": "비밀번호" }`
     - 출력: `user` 정보와 `accessToken`, `refreshToken`을 반환합니다.
  2. **POST `/auth/register`**
     - 시나리오: 신규 사용자가 회원가입합니다.
     - 인풋 Body: `{ "email": "...", "password": "...", "name": "..." }`
     - 출력: 생성된 `user` 정보.
  3. **POST `/auth/refresh`**
     - 시나리오: 액세스 토큰 만료 시 리프레시 토큰으로 새 토큰을 발급받습니다.
     - 인풋: 쿠키 `refreshToken` 또는 헤더 `Authorization: Bearer <refreshToken>`
     - 출력: 새로운 `accessToken`.
  4. **GET `/auth/me`**
     - 시나리오: 현재 로그인된 사용자의 정보를 조회합니다.
     - 인풋: 쿠키 `accessToken` 또는 헤더 `Authorization: Bearer <accessToken>`
     - 출력: JWT Payload (id, name, email, roles 등).
  5. **POST `/auth/logout`**
     - 시나리오: 로그아웃하여 인증 쿠키를 삭제합니다.
     - 인풋: 없음 (쿠키 자동 제거).
     - 출력: `null`.

> 로그인은 분당 5회, 회원가입은 시간당 3회로 레이트리밋이 적용됩니다.

### 2. 위키(Wiki) 라우터 (`/wiki`)

- **용도 / 역할**: 위키 문서 생성, 열람, 공동 편집 및 그래프 형태의 브라우징을 제공합니다.
- **엔드포인트**
  1. **GET `/wiki/browse/trending`**
     - 시나리오: 트렌딩 문서를 그래프(노드/간선) 형태로 조회합니다.
     - 인풋 Query: `n`(노드 수, 기본 50), `k`(간선 수, 기본 4)
     - 출력: `{ nodes: [...], edges: [...] }`
  2. **GET `/wiki/browse/around/:id`**
     - 시나리오: 특정 문서(`id`)를 중심으로 주변 문서를 조회합니다.
     - 인풋: URL 파라미터 `id`, Query `c`(반경 내 문서 수)
     - 출력: 노드·에지 리스트.
  3. **POST `/wiki/documents`**
     - 시나리오: 새 문서를 생성합니다.
     - 인풋 Body: `{ "title": "...", "tags": ["태그1", "태그2"] }`
     - 출력: `{ id: "새 문서 ID" }`
  4. **WS `/wiki/ws/doc/:id`**
     - 시나리오: 실시간 공동 편집을 위해 WebSocket을 연결합니다.
     - 메시지 예시: `{ type: "edit" | "join" | "cursor", ... }`

### 3. 검색(Search) 라우터 (루트 경로)

- **용도 / 역할**: 문서 제목 임베딩 기반 검색 및 시각화 브라우징을 제공합니다.
- **엔드포인트**
  1. **GET `/search`**
     - 시나리오: 키워드 기반으로 문서를 검색합니다.
     - 인풋 Query: `q`(검색어, 필수), `k`(결과 수, 기본 10)
     - 출력: `{ id, title, score }` 리스트.
  2. **GET `/search/browse`**
     - 시나리오: 검색어 임베딩을 기준으로 그래프 데이터를 요청합니다.
     - 인풋 Query: `q`, `n`(노드 수), `k`(간선 수)
     - 출력: `{ nodes: [...], edges: [...] }`

### 4. 관리자(Admin) 라우터 (`/admin`)

- **용도 / 역할**: 서버 운영 및 그리드 메트릭 확인.
- **엔드포인트**
  1. **GET `/admin/grid/metrics`**
     - 시나리오: 현재 그리드(트렌드 맵)의 메트릭을 조회합니다.
     - 인풋 Header: `x-admin-token` = `ADMIN_TOKEN` 환경변수 값.
     - 출력: `{ total, placedOrder, removedCount, lastSaveTs, placement, persistPath }`

### 5. 전역(Global) 엔드포인트

- **GET `/`** → `/health` 로 리다이렉트됩니다.
- **GET `/health`** → "OK" 문자열을 반환하여 헬스체크를 제공합니다.
- 개발 모드에서는 **Swagger** 문서가 `/docs` 또는 `/swagger` 경로에 노출됩니다.

---
이 문서는 프로젝트의 API 구조를 빠르게 파악하고자 하는 개발자를 위한 참고 자료입니다. 추가적인 질문이나 개선 사항이 있다면 언제든지 Issue 또는 PR을 남겨주세요.