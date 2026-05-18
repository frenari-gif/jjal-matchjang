# 짤맞짱

PC 웹브라우저에서 플레이하는 실시간 멀티 짤 제목 대결 MVP입니다.

## 기술 스택

- Next.js
- TypeScript
- Socket.io
- Prisma
- SQLite

## 실행

```bash
npm install
npm run db:push
npm run dev
```

브라우저에서 `http://localhost:3000`으로 접속합니다.

## 환경변수

`.env.example`을 복사해 `.env`를 만들고 값을 수정합니다.

```env
DATABASE_URL="file:./dev.db"
NEXT_PUBLIC_SITE_URL="http://localhost:3000"
ADMIN_PASSWORD="change-this-before-test"
PORT=3000
HOSTNAME="0.0.0.0"
```

`ADMIN_PASSWORD`가 없으면 관리자 API는 401로 막힙니다. 운영 테스트에서는 반드시 추측하기 어려운 값으로 바꾸세요.

## DB 초기화/마이그레이션

개발 중에는 Prisma 스키마를 SQLite에 바로 반영합니다.

```bash
npm run db:push
```

Prisma Client만 다시 생성하려면:

```bash
npm run prisma:generate
```

## 프로덕션 빌드 확인

배포 전에는 아래 순서로 확인합니다.

```bash
npm install
npm run db:push
npm run build
npm run start
```

`npm run build`가 통과해야 배포 후보로 봅니다.

## 배포 방법

일반 Node 서버, VPS, Railway, Render, Fly.io처럼 하나의 Node 프로세스가 계속 살아있는 환경을 권장합니다.

```bash
cp .env.example .env
npm install
npm run db:push
npm run build
npm run start
```

Vercel 단독 배포는 권장하지 않습니다. 이 프로젝트는 커스텀 `server.js`, Socket.io, 메모리 기반 진행 방 상태를 사용하므로 Vercel 서버리스 함수만으로는 실시간 방 상태 유지가 어렵습니다. Vercel을 쓰려면 Next.js 화면은 Vercel에 두고 Socket.io 서버와 SQLite/DB는 별도 Node 서버로 분리해야 합니다.

Render에 배포할 때는 저장소의 `public/audio` 폴더도 함께 포함되어야 BGM과 클릭음이 배포 환경에서 재생됩니다. 파일이 빠져도 앱은 동작하지만 사운드는 재생되지 않습니다.

배포 도메인이 정해지면 아래 값을 실제 도메인으로 맞춥니다.

- `.env`의 `NEXT_PUBLIC_SITE_URL`
- `public/robots.txt`의 `Sitemap`
- `public/sitemap.xml`의 `<loc>`

## 게임 기능

- 닉네임 입력
- 방 만들기
- 방 코드 입장
- 공개방 목록
- 빠른 참가
- 대기방
- 방장 게임 시작
- 라운드 이미지 공개
- 제목 제출
- 익명 제목 공개
- 투표
- 라운드 결과 공개
- 점수판
- 방 채팅
- BGM/버튼 클릭음
- 방 설정 변경
- 제목 1회 수정
- 방코드 비공개 모드
- 플레이어 프로필/누적 기록
- 다음 라운드
- 최종 승리 화면

## 사운드

오디오 파일은 아래 위치에 넣습니다.

- BGM: `public/audio/Cardboard Thunder.mp3`
- 버튼 클릭음: `public/audio/Click Sound.mp3`

파일을 교체하려면 같은 경로와 파일명으로 덮어쓰면 됩니다. 파일이 없어도 사이트는 깨지지 않고, 브라우저에서 오디오 재생만 조용히 실패하도록 처리되어 있습니다.

브라우저 자동재생 정책 때문에 BGM은 페이지 로드 직후가 아니라 첫 클릭, 키 입력, 입장, 게임 시작 같은 사용자 상호작용 이후 재생됩니다. BGM은 loop로 반복되며 화면 상태가 바뀌어도 중복 재생되지 않도록 전역 사운드 프로바이더에서 한 번만 관리합니다.

사운드 설정:

- BGM 볼륨: 0~100, 기본값 40
- 효과음 볼륨: 0~100, 기본값 70
- 음소거: 기본값 false
- 설정값은 `localStorage`에 저장되어 새로고침 후에도 유지됩니다.

Render 배포 시에도 `public/audio` 안의 mp3 파일이 저장소와 배포 산출물에 포함되어야 합니다.

## 방 채팅

- 같은 방에 있는 플레이어끼리만 실시간 채팅할 수 있습니다.
- 로비 전체 채팅은 없고, 방에 입장한 뒤 대기방/게임 진행/결과 화면에서만 보입니다.
- 서버는 현재 소켓의 방, `roomCode`, `playerSessionId`를 함께 확인한 뒤 메시지를 처리합니다.
- 강퇴되었거나 방에 속하지 않은 플레이어는 채팅을 보낼 수 없습니다.
- Enter 키로 전송할 수 있고, 빈 메시지나 공백만 있는 메시지는 거부됩니다.
- 채팅은 최대 100자까지 보낼 수 있습니다.
- 같은 플레이어는 `chatCooldownMs` 간격보다 빠르게 연속 전송할 수 없습니다.
- 채팅에도 기존 금칙어 필터가 적용되며, 금칙어가 포함된 메시지는 즉시 거부됩니다.
- 방마다 최근 채팅 50개만 메모리에 보관하고 새로 들어온 플레이어에게 이 기록을 보여줍니다.
- 채팅 기록은 아직 DB에 저장하지 않으며, 서버 재시작 시 초기화됩니다.

## 제목 수정

- 제목 제출은 라운드당 1회만 인정됩니다.
- 제출한 뒤 제목 작성 시간이 끝나기 전까지 라운드당 1회만 수정할 수 있습니다.
- 수정 횟수는 서버에서 검증하므로 클라이언트를 조작해도 2회 이상 수정할 수 없습니다.
- 제목 작성 시간이 끝나고 `reveal`, `voting`, `results` 단계로 넘어가면 수정할 수 없습니다.
- 수정 후에도 다른 플레이어에게는 작성자 정보가 공개되지 않고 기존 익명 공개 흐름을 유지합니다.

## 방 설정 변경

방장은 대기방에서 아래 설정을 변경할 수 있습니다.

- 방 이름
- 공개방/비공개방
- 라운드 수
- 제목 작성 시간
- 투표 시간
- 최소 시작 인원
- 최대 인원
- 스트리머 모드
- 방코드 비공개 모드

규칙:

- 게임이 시작된 뒤에는 핵심 방 설정을 변경할 수 없습니다.
- 최소 시작 인원은 최대 인원보다 클 수 없습니다.
- 현재 접속 인원보다 최대 인원을 낮게 설정할 수 없습니다.
- 변경된 설정은 서버 검증 후 같은 방의 모든 플레이어에게 즉시 반영됩니다.
- 변경된 항목은 방 채팅의 시스템 메시지로 표시됩니다.

방코드 비공개 모드는 방 코드만 `••••••`로 숨기는 단일 옵션입니다.

스트리머 모드는 방송용 안전 모드입니다. 켜면 방코드 비공개가 자동으로 포함되고, 방 상태와 시스템 메시지에도 스트리머 모드가 표시됩니다. 이후 방송용 표시 제한을 더 추가할 때 확장할 기준 옵션입니다.

방코드 비공개 모드가 켜져 있으면 대기방, 게임 화면, 결과 화면의 방 코드가 기본적으로 `••••••`로 표시됩니다. 방장은 `코드 보기/숨기기`와 `코드 복사` 버튼으로 필요한 순간에만 코드를 확인하거나 공유할 수 있습니다.

## 플레이어 프로필/누적 기록

- 클라이언트는 `playerSessionId`를 localStorage에 저장하고, 서버는 이 값을 기준으로 플레이어 기록을 DB에 저장합니다.
- 닉네임은 바꿀 수 있지만 기록은 `playerSessionId`에 계속 누적됩니다.
- 같은 브라우저에서는 서버를 재시작해도 누적 기록이 유지됩니다.
- 다른 브라우저나 다른 기기에서는 localStorage가 다르므로 다른 플레이어로 취급됩니다.
- 게임 시작 시 접속 인원이 3명 이상인 방에서만 누적 기록이 반영됩니다. 2명 방도 게임은 가능하지만 플레이 게임 수, 승리, 라운드, 투표 기록은 증가하지 않습니다.
- 로그인 시스템은 아직 없지만, 나중에 로그인 계정과 `PlayerProfile`을 연결하는 방식으로 확장할 수 있습니다.

저장되는 기록:

- 닉네임
- 총 플레이 게임 수
- 총 플레이 라운드 수
- 총 승리 게임 수
- 총 라운드 승리 수
- 총 받은 투표 수
- 총 제출한 제목 수
- 평균 받은 투표 수
- 마지막 접속 시간
- 생성일

기록 반영 시점:

- 라운드 결과가 확정될 때 제출한 제목 수, 받은 투표 수, 라운드 승리 수를 반영합니다.
- 최종 결과가 확정될 때 총 플레이 게임 수, 총 플레이 라운드 수, 게임 승리 수를 반영합니다.

UI:

- 로비의 `내 정보` 버튼으로 자신의 누적 기록을 확인합니다.
- 대기방 플레이어 목록의 `정보 보기` 버튼으로 같은 방 플레이어의 공개 기록을 확인합니다.

DB 모델은 Prisma의 `PlayerProfile`이며, `playerSessionId`가 unique 값입니다.

## 재접속 처리

- 클라이언트는 `playerSessionId`를 localStorage에 저장합니다.
- 방에 입장하면 마지막 방 코드도 localStorage에 저장합니다.
- 새로고침이나 일시 연결 끊김 후 3분 안에 돌아오면 서버가 `playerSessionId` 기준으로 같은 플레이어를 복구합니다.
- 복구 시 닉네임, 점수, 제출 상태, 투표 상태가 유지됩니다.
- 3분이 지나면 cleanup 과정에서 완전 퇴장 처리됩니다.

## 관리자 페이지

관리자 페이지:

- `http://localhost:3000/admin`
- `http://localhost:3000/admin/images`

관리자 로그인:

- `ADMIN_PASSWORD` 환경변수에 관리자 비밀번호를 설정합니다.
- `/admin` 또는 `/admin/images`에 세션 없이 접근하면 `/admin/login`으로 이동합니다.
- 로그인 성공 시 서버가 httpOnly 관리자 세션 쿠키를 발급합니다.
- HTTPS 요청에서는 세션 쿠키에 `Secure` 속성이 붙습니다.
- 관리자 API는 세션 쿠키가 없거나 만료되면 401로 거부합니다.
- 기본 비활성 만료 시간은 30분입니다.
- 로그인 실패가 반복되면 짧은 rate limit이 적용됩니다.
- 로그아웃은 관리자 화면의 `로그아웃` 버튼으로 처리합니다.

관리자 기능:

- 현재 방 목록 확인
- 방 상태, 공개/비공개 여부, 접속 인원 확인
- 방 강제 삭제
- 플레이어 강제 퇴장
- 신고 제목 숨김/복구
- 신고 상태 변경
- 최근 100개 로그 확인
- 금칙어 추가/삭제

## 이미지 관리

`/admin/images`에서 이미지 데이터를 관리합니다.
`/admin/image-submissions`에서 플레이어가 보낸 이미지 추가 신청을 검토합니다.

이미지 데이터 구조:

- `id`
- `src`
- `title`
- `tags`
- `enabled`

이미지 추가는 실제 파일 업로드 대신 아래 방식으로 처리합니다.

- `/game-images/user/example.png`
- `public/game-images/user/example.png`
- `https://...`

`enabled=false`인 이미지는 게임 라운드에 나오지 않습니다.

서버 시작 시 `public/game-images` 아래 이미지 파일은 DB에 자동 등록됩니다.
반대로 `public/game-images`에서 삭제된 로컬 이미지 경로는 서버 시작 시 DB에서도 정리되어 더 이상 게임에 나오지 않습니다.

## 이미지 추가 신청

플레이어는 로비나 방 안의 `이미지 추가 신청` 버튼으로 이미지 URL을 제출할 수 있습니다.

신청 입력 항목:

- 이미지 URL 필수
- 이미지 제목 선택
- 간단한 설명 선택

서버 검증:

- `http` 또는 `https` URL만 허용합니다.
- 잘못된 URL과 너무 긴 문자열은 거부합니다.
- 같은 `playerSessionId`는 5분에 1회만 신청할 수 있습니다.

관리자는 `/admin/image-submissions`에서 신청 목록을 보고 승인 또는 기각할 수 있습니다. 승인해도 게임 이미지 풀에 자동 추가되지는 않고 `approved` 상태로만 저장됩니다. 최종 게임 이미지 등록은 관리자가 `/admin/images`에서 직접 처리합니다.

Render 무료 플랜에서는 서버 로컬 디스크가 영구 저장소로 적합하지 않고, 재배포/재시작 시 파일 유지가 보장되지 않을 수 있습니다. 그래서 현재 이미지 신청은 실제 파일 업로드 저장이 아니라 외부 이미지 URL 제출 방식으로만 운영합니다.

## 운영/안전 기능

### 강퇴

- 방장만 다른 플레이어를 강퇴할 수 있습니다.
- 방장은 자기 자신을 강퇴할 수 없습니다.
- 강퇴된 플레이어는 즉시 방에서 나가며 메시지를 봅니다.
- 서버는 방별 `bannedPlayerIds`와 닉네임 차단 목록을 유지해 같은 방 재입장을 막습니다.
- 방장이 나가면 남은 접속 플레이어 중 한 명에게 방장 권한이 넘어갑니다.

### 신고

- 플레이어는 다른 플레이어의 제목을 신고할 수 있습니다.
- 본인 제목은 신고할 수 없습니다.
- 같은 플레이어가 같은 제목을 여러 번 신고할 수 없습니다.
- 신고 수가 기준 이상이면 제목이 자동 숨김 처리되고 `[신고로 숨겨진 제목]`으로 표시됩니다.
- 신고 기록은 DB의 `ReportRecord`에 저장됩니다.

신고 기록 표시 정보:

- 신고된 제목
- 작성자 닉네임
- 신고자 닉네임
- 방 코드
- 라운드 번호
- 신고 시간
- 처리 상태: `pending`, `hidden`, `dismissed`

### 금칙어

기본 금칙어는 `src/data/bannedWords.ts`에 있습니다. 서버 시작 시 DB의 `BannedWord`에도 기본값을 등록합니다.

관리자 페이지에서 금칙어를 추가/삭제할 수 있고, 서버 검사는 기본 파일 목록과 DB 목록을 함께 사용합니다.

필터는 아래 처리를 적용합니다.

- 대소문자 무시
- 공백 제거
- 일부 특수문자 제거
- 반복 문자 축약

한글 자모 분리 우회는 완벽히 막지 않지만, `normalizeTextForFilter`와 `collapseRepeatedChars` 구조를 확장하면 개선할 수 있습니다.

### 도배 방지

- 제목 제출은 라운드당 1회만 인정됩니다.
- 투표는 라운드당 1회만 인정됩니다.
- 제목은 최대 60자입니다.
- 빈 제목이나 공백만 있는 제목은 거부됩니다.
- 너무 빠른 반복 요청은 서버에서 거부됩니다.

### 방 자동 정리

- 명시적으로 모두 나간 방은 삭제됩니다.
- 일시 끊김 플레이어는 3분 동안 복귀할 수 있습니다.
- 3분이 지나면 완전 퇴장 처리됩니다.
- 대기 상태에서 30분 동안 활동이 없는 방은 삭제됩니다.
- 게임 종료 후 10분이 지난 방은 삭제됩니다.
- 정리 작업은 60초마다 실행됩니다.

## 로그 저장

중요 이벤트는 DB의 `AdminLog`에 저장됩니다.

저장 대상:

- 방 생성
- 방 삭제
- 게임 시작
- 게임 종료
- 강퇴
- 신고
- 제목 숨김/복구
- 관리자 작업
- 서버 오류

관리자 페이지에서 최근 100개 로그를 확인할 수 있습니다.

## 운영 설정값

운영 설정값은 `src/config/gameConfig.ts`에 모여 있습니다.

```ts
reconnectGracePeriodSeconds: 180
adminRecentLogLimit: 100
adminSessionTimeoutMinutes: 30
adminLoginRateLimitWindowMinutes: 10
adminLoginRateLimitMaxAttempts: 5
defaultLoadTestUsers: 50
profileStatsMinPlayers: 3
imageSubmissionCooldownMs: 300000
maxImageSubmissionUrlLength: 500
maxImageSubmissionTitleLength: 80
maxImageSubmissionDescriptionLength: 500
maxChatMessageLength: 100
chatCooldownMs: 1000
maxChatHistoryPerRoom: 50
maxCaptionLength: 60
autoHideReportThreshold: 2
waitingRoomCleanupMinutes: 30
finishedRoomCleanupMinutes: 10
cleanupIntervalSeconds: 60
```

## 부하 테스트

개발 서버를 먼저 실행합니다.

```bash
npm run dev
```

다른 터미널에서 기본 50명 테스트를 실행합니다.

```bash
npm run load:test
```

인원수를 바꾸려면:

```bash
npm run load:test -- 100
```

또는:

```bash
LOAD_TEST_USERS=100 npm run load:test
```

Windows PowerShell에서는:

```powershell
$env:LOAD_TEST_USERS=100; npm run load:test
```

## 이미지 추가

이미지는 `public/game-images` 아래에 넣으면 서버 시작 시 DB에 자동 등록됩니다.

- 직접 추가 권장 위치: `public/game-images/user`
- 지원 확장자: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.svg`
- 권장 비율: 16:9
- 권장 해상도: `1600x900` 또는 `1920x1080`

이미지는 화면에서 `object-fit: contain`으로 표시되어 원본 비율이 유지됩니다.

## 로고

`public/logo.png`를 원하는 이미지로 교체하면 됩니다.

## SEO/공유 설정

- 사이트 이름과 기본 title은 `짤맞짱`입니다.
- meta description과 Open Graph는 `src/app/layout.tsx`에서 관리합니다.
- Open Graph 이미지는 `/logo.png`를 사용합니다.
- favicon은 `public/favicon.svg`, `public/favicon.ico`를 사용합니다.
- `robots.txt`와 `sitemap.xml`은 `public` 폴더에 있습니다.

## 보안 기본 점검

- 관리자 비밀번호는 코드에 하드코딩하지 않고 `ADMIN_PASSWORD` 환경변수로만 검증합니다.
- 관리자 화면은 서버가 관리자 세션 쿠키를 확인한 뒤에만 보여줍니다.
- 관리자 API는 httpOnly 관리자 세션 쿠키가 없으면 처리하지 않습니다.
- 로그인 성공 시 세션 쿠키가 발급되고, 로그아웃 시 서버 세션과 쿠키가 제거됩니다.
- 관리자 세션은 비활성 상태가 일정 시간 지나면 자동 만료됩니다.
- 점수, 투표, 방 상태 변경은 서버 이벤트 처리에서만 반영합니다.
- 제목 제출과 투표는 라운드당 1회만 서버에서 인정합니다.
- 제목 길이, 빈 값, 금칙어, 반복 요청 제한은 서버에서 검사합니다.
- 공개방 목록은 서버에서 대기 중, 공개, 미정원 방만 내려줍니다.

## 최종 테스트 체크리스트

- 방 만들기
- 비공개방 입장
- 공개방 입장
- 빠른 참가
- 게임 시작
- 제목 제출
- 방 채팅
- 미제출 타임아웃
- 투표
- 미투표 타임아웃
- 점수 반영
- 플레이어 기록 확인
- 다음 라운드
- 최종 결과
- 강퇴
- 신고
- 금칙어
- 방 자동 삭제
- 재접속
- 관리자 페이지
- 이미지 관리

## 현재 한계점

- 진행 중인 방 상태는 메모리 기반입니다.
- 서버를 재시작하면 진행 중인 방은 초기화됩니다.
- 플레이어 기록은 로그인 계정이 아니라 브라우저 localStorage 기반이라 다른 기기와 공유되지 않습니다.
- 관리자 세션은 현재 메모리 기반입니다. 서버를 재시작하면 관리자도 다시 로그인해야 합니다.
- 이미지 관리는 파일 업로드가 아니라 URL 또는 public 경로 등록 방식입니다.
- SQLite는 소규모 공개 테스트에는 충분하지만, 큰 트래픽에는 별도 DB와 세션 저장소가 필요합니다.
