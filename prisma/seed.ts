import { PrismaClient, TagType, type Role, type User, type Tag } from "@prisma/client";
import { hashPassword } from "../src/auth/util";

// Seed types
interface SeedUser {
  email: string;
  name: string;
  password: string;
  roles: string[]; // role names
}

interface SeedDoc {
  title: string;
  tags: string[]; // tag contents
  thumbnail: string;
  contentMd?: string;
  words?: number;
  views?: number;
  updatedCount?: number;
}

const prisma = new PrismaClient();

async function ensureRole(name: string): Promise<Role> {
  const existing = await prisma.role.findFirst({ where: { name } });
  if (existing) return existing;
  return prisma.role.create({ data: { name } });
}

async function ensureTag(type: TagType, content: string): Promise<Tag> {
  return prisma.tag.upsert({
    where: { content },
    update: {},
    create: { type, content },
  });
}

async function ensureUser(u: SeedUser): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { email: u.email } });
  if (existing) return existing;
  const roleRecords: Role[] = [];
  for (const r of u.roles) roleRecords.push(await ensureRole(r));
  return prisma.user.create({
    data: {
      email: u.email,
      name: u.name,
      password: await hashPassword(u.password),
      roles: { connect: roleRecords.map((r) => ({ id: r.id })) },
    },
  });
}

// Helpers
function estimateWords(text: string): number {
  const withoutCode = text.replace(/```[\s\S]*?```/g, " ");
  const stripped = withoutCode.replace(/[#*_`>\-]/g, " ");
  return stripped.split(/\s+/).filter(Boolean).length;
}

function defaultThumb(title: string): string {
  const seed = encodeURIComponent(title);
  return `https://picsum.photos/seed/${seed}/1080/1080`;
}

async function createDocuments(docs: SeedDoc[]): Promise<void> {
  // prepare tags map
  const tagRecords: Record<string, Tag> = {};
  async function getTag(content: string): Promise<Tag> {
    if (tagRecords[content]) return tagRecords[content];
    // Heuristics for demo tag types
    const type = content.match(/^\d{4,}$/) ? TagType.STD_NUM : content.match(/^(CS|EE|ME|BIO|MATH)$/) ? TagType.MAJOR : TagType.CUSTOM;
    const t = await ensureTag(type, content);
    tagRecords[content] = t;
    return t;
  }

  for (const d of docs) {
    // Avoid duplicates by title
    const exists = await prisma.document.findFirst({ where: { title: d.title } });
    if (exists) continue;
    const connectTags = [] as { id: string }[];
    for (const tg of d.tags) {
      const t = await getTag(tg);
      connectTags.push({ id: t.id });
    }
    const content = d.contentMd ?? `# ${d.title}\n\n이 문서는 자동으로 생성된 시드 문서입니다. 관련 주제에 대한 개요와 예시를 포함합니다.`;
    await prisma.document.create({
      data: {
        title: d.title,
        contentMd: content,
        words: d.words ?? estimateWords(content),
        thumbnail: d.thumbnail ?? defaultThumb(d.title),
        embedding: [], // lazy embedding computed on-demand
        views: d.views ?? Math.floor(Math.random() * 200),
        updatedCount: d.updatedCount ?? Math.floor(Math.random() * 20),
        editable: true,
        tags: { connect: connectTags },
      },
    });
  }
}

async function main(): Promise<void> {
  await prisma.$connect();

  // Roles & Users
  const users: SeedUser[] = [
    { email: "admin@example.com", name: "Admin", password: "admin123!", roles: ["admin"] },
    { email: "user@example.com", name: "User", password: "user123!", roles: ["user"] },
  ];
  for (const u of users) await ensureUser(u);

  // Tags
  const baseTags = [
    { type: TagType.MAJOR, content: "CS" },
    { type: TagType.MAJOR, content: "EE" },
    { type: TagType.CUSTOM, content: "Notice" },
    { type: TagType.CUSTOM, content: "Guide" },
    { type: TagType.STD_NUM, content: "20230001" },
  ];
  for (const t of baseTags) await ensureTag(t.type, t.content);

  // Documents
  const docs: SeedDoc[] = [
    { title: "Bun과 Elysia 시작하기", tags: ["Guide", "CS"], views: 150, updatedCount: 5, thumbnail: "https://picsum.photos/1080/1080" },
    { title: "Prisma 사용 가이드", tags: ["Guide", "CS"], views: 120, updatedCount: 8, thumbnail: "https://picsum.photos/1080/1080" },
    { title: "공지: 서버 점검 일정", tags: ["Notice"], views: 200, updatedCount: 2, thumbnail: "https://picsum.photos/1080/1080" },
    { title: "전기전자 개론", tags: ["EE"], views: 80, updatedCount: 3, thumbnail: "https://picsum.photos/1080/1080" },
    { title: "학번 20230001 포트폴리오", tags: ["20230001", "CS"], views: 60, updatedCount: 10, thumbnail: "https://picsum.photos/1080/1080" },

    // Additional ~30 seeded documents with content
    {
      title: "TypeScript 기본 문법",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/ts-basics/1080/1080",
      contentMd: `# TypeScript 기본 문법\n\nTypeScript는 정적 타입을 제공하는 JavaScript의 상위 집합입니다. 인터페이스, 제네릭, 유니온 타입 등 강력한 타입 기능을 제공합니다.\n\n## 주요 개념\n- 타입 주석과 타입 추론\n- 인터페이스와 타입 별칭\n- 제네릭과 유틸리티 타입`
    },
    {
      title: "Node.js 모듈 시스템 이해",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/node-modules/1080/1080",
      contentMd: `# Node.js 모듈 시스템\n\nNode.js는 CommonJS와 ESM(ECMAScript Modules)을 지원합니다. ESM은 \"import/export\" 문법을 사용하며, 최신 번들러와 호환성이 좋습니다.\n\n## 모듈 선택 가이드\n- 신규 프로젝트: ESM 권장\n- 레거시 코드: CommonJS 유지 또는 점진적 마이그레이션`
    },
    {
      title: "HTTP란 무엇인가",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/http/1080/1080",
      contentMd: `# HTTP란\n\nHTTP는 클라이언트-서버 모델을 기반으로 하는 애플리케이션 레벨의 프로토콜입니다. 요청과 응답으로 통신하며, 무상태(stateless) 특성을 가집니다.\n\n## 핵심 요소\n- 메서드: GET, POST, PUT, DELETE\n- 상태 코드: 2xx, 4xx, 5xx\n- 헤더와 바디`
    },
    {
      title: "REST API 디자인 베스트 프랙티스",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/rest-design/1080/1080",
      contentMd: `# REST API 디자인\n\n리소스 지향적인 URI, 일관된 상태 코드, 표준화된 오류 응답을 사용합니다. 페이지네이션과 필터링, 정렬 쿼리를 명확히 정의하세요.\n\n## 체크리스트\n- 명사형 리소스\n- HATEOAS 고려\n- 표준 오류 포맷`
    },
    {
      title: "JWT 인증 가이드",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/jwt-guide/1080/1080",
      contentMd: `# JWT 인증\n\nJWT는 클레임을 담은 토큰 기반 인증 방식입니다. Access/Refresh 토큰을 조합해 보안성과 편의성을 높일 수 있습니다.\n\n## 주의사항\n- 토큰 저장은 httpOnly 쿠키 권장\n- 만료시간과 회전(rotation) 전략 설계`
    },
    {
      title: "OAuth 2.0 개요",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/oauth/1080/1080",
      contentMd: `# OAuth 2.0\n\nOAuth 2.0은 권한 위임을 위한 표준 프로토콜입니다. Authorization Code Flow가 일반적이며, PKCE 확장으로 보안이 향상됩니다.\n\n## 용어\n- Resource Owner\n- Client\n- Authorization Server\n- Resource Server`
    },
    {
      title: "WebSocket으로 실시간 통신 구현",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/websocket/1080/1080",
      contentMd: `# WebSocket 실시간 통신\n\nWebSocket은 서버와 클라이언트 간의 양방향 통신을 제공합니다. 채팅, 협업 편집, 알림 등에 활용됩니다.\n\n## 구현 포인트\n- 연결 관리와 재시도\n- 메시지 타입 정의\n- 스케일링 고려`
    },
    {
      title: "테스트 전략: 유닛에서 E2E까지",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/testing/1080/1080",
      contentMd: `# 테스트 전략\n\n유닛, 통합, E2E 테스트를 적절히 혼합합니다. 빠른 피드백과 회귀 방지를 위해 핵심 로직은 유닛 테스트로, 사용자 흐름은 E2E로 검증합니다.\n\n## 팁\n- 테스트 격리\n- 픽스처/목(Mock) 활용\n- CI에서 병렬 실행`
    },
    {
      title: "CI/CD 파이프라인 개요",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/cicd/1080/1080",
      contentMd: `# CI/CD 개요\n\nCI/CD는 빌드, 테스트, 배포 자동화를 통해 개발 효율을 높입니다. 변경이 작고 잦을수록 위험이 줄어듭니다.\n\n## 구성 요소\n- CI: 검증 자동화\n- CD: 배포 자동화\n- 롤백 전략`
    },
    {
      title: "Docker 시작하기",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/docker/1080/1080",
      contentMd: `# Docker 시작하기\n\nDocker는 컨테이너 기반의 표준화된 배포 환경을 제공합니다. 이미지 레이어, 볼륨, 네트워크 개념을 이해하세요.\n\n## 실습\n- Dockerfile 작성\n- 멀티 스테이지 빌드\n- Compose로 로컬 개발`
    },
    {
      title: "회로 이론 기초",
      tags: ["EE"],
      thumbnail: "https://picsum.photos/seed/circuit/1080/1080",
      contentMd: `# 회로 이론\n\n기본 소자(저항, 커패시터, 인덕터)와 키르히호프 법칙을 이해합니다. 선형 회로 해석의 기초를 다집니다.\n\n## 예제\n- 옴의 법칙\n- 분압 회로\n- RC 과도 응답`
    },
    {
      title: "디지털 로직 설계",
      tags: ["EE"],
      thumbnail: "https://picsum.photos/seed/digital-logic/1080/1080",
      contentMd: `# 디지털 로직\n\n불 대수와 논리 게이트를 통해 조합논리/순차논리를 설계합니다. FSM 설계와 동기화 이슈를 다룹니다.\n\n## 키워드\n- 플립플롭\n- 카르노 맵\n- 타이밍 분석`
    },
    {
      title: "신호와 시스템",
      tags: ["EE"],
      thumbnail: "https://picsum.photos/seed/signals/1080/1080",
      contentMd: `# 신호와 시스템\n\n연속/이산 신호, LTI 시스템, 주파수 해석 개념을 이해합니다. 푸리에 변환과 필터 설계를 소개합니다.\n\n## 응용\n- 오디오 처리\n- 이미지 필터링\n- 통신 시스템`
    },
    {
      title: "제어공학 입문",
      tags: ["EE"],
      thumbnail: "https://picsum.photos/seed/control/1080/1080",
      contentMd: `# 제어공학\n\n피드백 제어, 안정도, 응답 특성을 기반으로 시스템을 설계합니다. 루트 궤적과 주파수 응답법을 다룹니다.\n\n## 사례\n- 온도 제어\n- 모터 속도 제어\n- 드론 자세 제어`
    },
    {
      title: "통신공학 개론",
      tags: ["EE"],
      thumbnail: "https://picsum.photos/seed/communication/1080/1080",
      contentMd: `# 통신공학\n\n변조, 다중화, 채널 용량 등 통신의 핵심 개념을 학습합니다. 디지털 통신 시스템의 블록을 살펴봅니다.\n\n## 용어\n- SNR\n- BER\n- OFDM`
    },
    {
      title: "반도체 소자 개론",
      tags: ["EE"],
      thumbnail: "https://picsum.photos/seed/semiconductor/1080/1080",
      contentMd: `# 반도체 소자\n\nPN 접합, 다이오드, BJT, MOSFET의 동작 원리를 이해합니다. 소자 특성과 모델링의 기초를 다룹니다.\n\n## 응용\n- 증폭기 설계\n- 스위칭 회로\n- 전력 변환`
    },
    {
      title: "전자기학 개론",
      tags: ["EE"],
      thumbnail: "https://picsum.photos/seed/em/1080/1080",
      contentMd: `# 전자기학\n\n맥스웰 방정식과 전자파 전파를 소개합니다. 정전계/정자계 개념과 경계 조건을 이해합니다.\n\n## 예시\n- 평면파\n- 도파관\n- 안테나 기초`
    },
    {
      title: "전력전자 개론",
      tags: ["EE"],
      thumbnail: "https://picsum.photos/seed/power-electronics/1080/1080",
      contentMd: `# 전력전자\n\n컨버터 토폴로지(Buck, Boost 등)와 스위칭 소자 제어를 소개합니다. 효율과 열 설계를 고려합니다.\n\n## 사례\n- 배터리 충전기\n- LED 드라이버\n- 인버터`
    },
    {
      title: "공지: 신규 기능 소개",
      tags: ["Notice"],
      thumbnail: "https://picsum.photos/seed/notice-feature/1080/1080",
      contentMd: `# 신규 기능 소개\n\n이번 릴리스에서는 검색 브라우징 향상과 공동 편집 안정화를 포함합니다. 상세한 변경 사항은 릴리스 노트를 참조하세요.\n\n- 검색 정확도 향상\n- 그리드 배치 최적화`
    },
    {
      title: "공지: 커리큘럼 변경 안내",
      tags: ["Notice"],
      thumbnail: "https://picsum.photos/seed/notice-curriculum/1080/1080",
      contentMd: `# 커리큘럼 변경\n\n다음 학기부터 필수 과목이 일부 조정됩니다. 전공 선택 과목군이 확대되었으며, 실습 과목이 강화되었습니다.\n\n자세한 내용은 학과 공지를 확인하세요.`
    },
    {
      title: "공지: 시험 일정 공지",
      tags: ["Notice"],
      thumbnail: "https://picsum.photos/seed/notice-exam/1080/1080",
      contentMd: `# 시험 일정\n\n중간/기말 시험 일정을 안내드립니다. 고사장 및 시간은 포털에서 개인별로 확인 바랍니다.\n\n- 중간: 10월 둘째 주\n- 기말: 12월 셋째 주`
    },
    {
      title: "공지: 과제 제출 안내",
      tags: ["Notice"],
      thumbnail: "https://picsum.photos/seed/notice-assignment/1080/1080",
      contentMd: `# 과제 제출\n\n모든 과제는 제출 마감 전일까지 LMS에 업로드해야 합니다. 지연 제출은 감점 대상입니다.\n\n파일명 규칙과 표절 방지 정책을 준수하세요.`
    },
    {
      title: "공지: 서버 장애 보고서",
      tags: ["Notice"],
      thumbnail: "https://picsum.photos/seed/notice-incident/1080/1080",
      contentMd: `# 장애 보고서\n\n9월 5일 14:20~15:05 사이 일부 요청에서 5xx 오류가 발생했습니다. 원인은 데이터베이스 연결 풀 고갈이었으며, 설정을 조정하여 해결했습니다.\n\n재발 방지로 모니터링 알림 임계값을 강화했습니다.`
    },
    {
      title: "공지: 방학 안내",
      tags: ["Notice"],
      thumbnail: "https://picsum.photos/seed/notice-vacation/1080/1080",
      contentMd: `# 방학 안내\n\n여름 방학 기간 동안 제한적으로 운영됩니다. 문의는 이메일로 남겨주세요.\n\n즐거운 방학 보내세요!`
    },
    {
      title: "학번 20230002 포트폴리오",
      tags: ["20230002", "CS"],
      thumbnail: "https://picsum.photos/seed/20230002/1080/1080",
      contentMd: `# 20230002 포트폴리오\n\n웹 프론트엔드 프로젝트와 알고리즘 스터디 내용을 정리했습니다. 주요 기술 스택은 React, TypeScript입니다.\n\n## 프로젝트\n- 개인 위키\n- 시각화 대시보드`
    },
    {
      title: "학번 20230003 포트폴리오",
      tags: ["20230003", "CS"],
      thumbnail: "https://picsum.photos/seed/20230003/1080/1080",
      contentMd: `# 20230003 포트폴리오\n\n백엔드 개발과 DevOps 자동화 경험을 정리했습니다. Docker와 CI/CD 적용 사례를 포함합니다.\n\n## 기술\n- NestJS\n- PostgreSQL\n- GitHub Actions`
    },
    {
      title: "학번 20230004 포트폴리오",
      tags: ["20230004", "EE"],
      thumbnail: "https://picsum.photos/seed/20230004/1080/1080",
      contentMd: `# 20230004 포트폴리오\n\n임베디드 시스템 설계와 펌웨어 개발 프로젝트를 소개합니다. RTOS 기반 과제를 수행했습니다.\n\n## 하드웨어\n- STM32\n- 센서 인터페이싱\n- 모터 제어`
    },
    {
      title: "학번 20230005 포트폴리오",
      tags: ["20230005", "CS"],
      thumbnail: "https://picsum.photos/seed/20230005/1080/1080",
      contentMd: `# 20230005 포트폴리오\n\n데이터 과학 프로젝트와 시각화 작업을 포함합니다. Pandas와 scikit-learn을 활용했습니다.\n\n## 결과\n- 예측 모델\n- 리포트 대시보드`
    },
    {
      title: "학번 20230006 포트폴리오",
      tags: ["20230006", "CS"],
      thumbnail: "https://picsum.photos/seed/20230006/1080/1080",
      contentMd: `# 20230006 포트폴리오\n\n모바일 애플리케이션 개발 경험을 정리했습니다. React Native로 크로스플랫폼 앱을 제작했습니다.\n\n## 기능\n- 오프라인 동기화\n- 푸시 알림`
    },
    {
      title: "학번 20230007 포트폴리오",
      tags: ["20230007", "CS"],
      thumbnail: "https://picsum.photos/seed/20230007/1080/1080",
      contentMd: `# 20230007 포트폴리오\n\n알고리즘 문제 해결과 시스템 설계 스터디 내용을 정리했습니다. 성능 최적화 사례를 포함합니다.\n\n## 주제\n- 그리디/DP\n- 분산 시스템 기본`
    },
    {
      title: "MATH: 미적분 개론",
      tags: ["MATH", "Guide"],
      thumbnail: "https://picsum.photos/seed/calculus/1080/1080",
      contentMd: `# 미적분 개론\n\n미분과 적분의 기초 개념을 소개합니다. 극한, 연속, 미분 규칙, 정적분의 의미를 다룹니다.\n\n## 응용\n- 최적화\n- 면적 계산`
    },
    {
      title: "MATH: 선형대수 기초",
      tags: ["MATH", "Guide"],
      thumbnail: "https://picsum.photos/seed/linear-algebra/1080/1080",
      contentMd: `# 선형대수\n\n벡터, 행렬, 선형변환과 고유값/고유벡터를 학습합니다. 머신러닝의 수학적 기반입니다.\n\n## 주제\n- 행렬분해\n- 노름과 내적`
    },
    {
      title: "ME: 재료역학 개론",
      tags: ["ME"],
      thumbnail: "https://picsum.photos/seed/mechanics/1080/1080",
      contentMd: `# 재료역학\n\n응력과 변형률, 훅의 법칙, 보의 굽힘을 다룹니다. 기계 요소 설계의 기초가 됩니다.\n\n## 예시\n- 인장 시험\n- 처짐 계산`
    },
    {
      title: "BIO: 생명과학 입문",
      tags: ["BIO"],
      thumbnail: "https://picsum.photos/seed/biology/1080/1080",
      contentMd: `# 생명과학\n\n세포 구조와 유전, 진화의 기본 개념을 소개합니다. 분자 수준의 메커니즘을 개괄합니다.\n\n## 토픽\n- DNA 복제\n- 단백질 합성`
    },
    {
      title: "알고리즘: 정렬과 탐색",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/algorithms/1080/1080",
      contentMd: `# 정렬과 탐색\n\n퀵소트, 머지소트, 이진 탐색 등의 기본 알고리즘을 설명합니다. 시간복잡도와 공간복잡도를 비교합니다.\n\n## 팁\n- 피벗 선택\n- 경계 조건 처리`
    },
    {
      title: "운영체제: 프로세스와 스레드",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/os/1080/1080",
      contentMd: `# 운영체제\n\n프로세스/스레드 모델과 컨텍스트 스위칭, 동기화 기본기를 다룹니다. 뮤텍스와 세마포어 사용 사례를 포함합니다.\n\n## 주제\n- 스케줄링\n- 메모리 관리 기초`
    },
    {
      title: "데이터베이스: 정규화",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/db-normalization/1080/1080",
      contentMd: `# 정규화\n\n1NF, 2NF, 3NF와 BCNF 개념을 설명합니다. 중복을 줄이고 이상(Anomaly)을 방지합니다.\n\n## 실무 팁\n- 과정적 적용\n- 성능과의 균형`
    },
    {
      title: "네트워크: TCP/IP 기초",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/tcpip/1080/1080",
      contentMd: `# TCP/IP\n\n계층 모델과 주요 프로토콜(TCP, UDP, IP, DNS, HTTP)을 개요합니다. 네트워크 디버깅 도구를 소개합니다.\n\n## 도구\n- ping, traceroute\n- netstat, tcpdump`
    },
    {
      title: "보안: 웹 보안 기초",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/web-security/1080/1080",
      contentMd: `# 웹 보안\n\nXSS, CSRF, SQL Injection 등 대표적 취약점을 소개하고 방어 기법을 설명합니다. 보안 헤더와 CSP도 다룹니다.\n\n## 체크\n- 입력 검증\n- 최소 권한 원칙`
    },
    {
      title: "클라우드: 비용 최적화 전략",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/cloud-cost/1080/1080",
      contentMd: `# 클라우드 비용 최적화\n\n적절한 인스턴스 타입 선택, 오토스케일링, 예약 인스턴스 활용 등으로 비용을 절감합니다.\n\n## 원칙\n- 가시성 확보\n- 낭비 제거`
    },
    {
      title: "프론트엔드: 성능 최적화",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/web-perf/1080/1080",
      contentMd: `# 웹 성능\n\n코어 웹 바이탈(LCP, CLS, INP)을 개선하기 위한 전략을 정리합니다. 코드 스플리팅과 이미지 최적화를 고려하세요.\n\n## 체크리스트\n- 캐시 정책\n- 번들 크기 관리`
    },
    {
      title: "백엔드: 캐싱 전략",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/backend-cache/1080/1080",
      contentMd: `# 캐싱 전략\n\n읽기 많은 서비스에서 캐시 적중률은 핵심 지표입니다. 키 설계, 만료, 일관성 전략을 수립합니다.\n\n## 레벨\n- 애플리케이션 캐시\n- 분산 캐시(Redis)`
    },
    {
      title: "마이크로서비스 기본",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/microservices/1080/1080",
      contentMd: `# 마이크로서비스\n\n경계 설정과 데이터 분리를 우선 고려합니다. 통신(동기/비동기) 패턴과 가시성 확보가 중요합니다.\n\n## 고려사항\n- 서킷 브레이커\n- 옵저버빌리티`
    },
    {
      title: "메시지 큐 활용",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/message-queue/1080/1080",
      contentMd: `# 메시지 큐\n\n느슨한 결합과 버퍼링을 통해 시스템 안정성을 높입니다. 정확히 한 번 처리(Exactly-once)는 까다로운 문제입니다.\n\n## 예시\n- 주문 처리\n- 알림 발송`
    },
    {
      title: "GraphQL 입문",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/graphql/1080/1080",
      contentMd: `# GraphQL\n\n클라이언트 주도 쿼리로 과/과소페칭을 줄입니다. 스키마 설계와 N+1 문제 대응이 관건입니다.\n\n## 도구\n- Apollo\n- Codegen`
    },
    {
      title: "테라폼으로 인프라 관리",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/terraform/1080/1080",
      contentMd: `# Terraform\n\n코드로 인프라를 선언적으로 관리합니다. 스테이트 관리와 워크스페이스 전략을 고려하세요.\n\n## 패턴\n- 모듈화\n- 백엔드 스토리지`
    },
    {
      title: "쿠버네티스 기초",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/k8s/1080/1080",
      contentMd: `# Kubernetes\n\nPod, Deployment, Service, Ingress의 개념을 이해합니다. 롤링 업데이트와 HPA를 설정합니다.\n\n## 주제\n- 네임스페이스\n- RBAC`
    },
    {
      title: "로그 수집과 분석",
      tags: ["Guide", "CS"],
      thumbnail: "https://picsum.photos/seed/logging/1080/1080",
      contentMd: `# 로깅\n\n구조화 로그와 상관관계를 통해 문제 해결 시간을 단축합니다. 수집 파이프라인과 인덱싱 전략을 구성합니다.\n\n## 스택\n- ELK/EFK\n- OpenTelemetry`
    },
  ];
  await createDocuments(docs);

  console.log("Seed completed");
}

main()
  .catch((e) => {
    console.error("Seed error", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
