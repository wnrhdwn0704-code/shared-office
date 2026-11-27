# 합동 비서실 (Shared Office)

지시·요청·보고를 주고받고, 이미지와 설문·블로그 진행 상황을 한곳에서 보는 **정적 웹앱**입니다.
서버 없이 **GitHub Pages**(화면) + **Firebase Realtime Database**(저장소)만으로 동작하며, 무료 요금제(Spark)로 충분합니다.

곽도형 님 측이 전해 준 구축 가이드의 구조를 그대로 따랐습니다.

```
shared-office-web/
├─ index.html          화면 뼈대 (잠금 화면 + 4개 탭)
├─ style.css           디자인 (라이트/다크, 모바일·PC 반응형)
├─ app.js              동작 전체 (Firebase 연결, CRUD, 이미지 경량화, REST 안내)
├─ firebase-config.js  Firebase 프로젝트 설정값 (여기만 채우면 됨)
└─ README.md           이 문서
```

---

## 0. 준비물

- Google 계정 (Firebase 콘솔용)
- GitHub 계정 (GitHub Pages 배포용)
- 비서실에 쓸 **비밀번호** 하나 (예: `1234`, 길수록 좋습니다)

---

## 1. Firebase 프로젝트 만들기

1. <https://console.firebase.google.com> 접속 → **프로젝트 추가**
2. 이름을 정하고(예: `shared-office`) **계속** → Google Analytics는 꺼도 됩니다 → **프로젝트 만들기**
3. 프로젝트 개요 화면에서 **웹 앱** 아이콘 `</>` 을 눌러 앱 등록 (닉네임은 아무거나)
4. **SDK 설정 및 구성**에 나오는 `firebaseConfig` 값을 복사해 둡니다.

## 2. Realtime Database 만들기

1. 왼쪽 메뉴 **빌드 → Realtime Database → 데이터베이스 만들기**
2. 위치는 **싱가포르(asia-southeast1)** 를 권장합니다. (한국에서 가장 가까운 리전)
3. 보안 모드는 일단 **잠금 모드**로 시작해도 됩니다. (5단계에서 규칙을 직접 넣습니다.)

## 3. `firebase-config.js` 채우기

`firebase-config.js`를 열고 아래 값들을 콘솔에서 복사한 값으로 바꿉니다.

```js
window.FIREBASE_CONFIG = {
  apiKey: "AIza...",                       // 콘솔 값 그대로
  authDomain: "shared-office.firebaseapp.com",
  databaseURL: "https://shared-office-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "shared-office",
  storageBucket: "shared-office.firebasestorage.app",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef"
};
```

> `firebase-config.js`는 공개 저장소에 올라가는 파일입니다. 하지만 여기 들어가는 값은 웹앱을 식별하는 **공개 정보**이고, 실제 보안은 5단계의 **보안 규칙**과 비밀번호(ROOM_KEY)가 담당합니다. 카드번호·계정 비밀번호 같은 값은 절대 넣지 마세요.

## 4. ROOM_KEY(방 열쇠) 만들기

비서실은 `프로젝트ID:비밀번호` 문자열을 **SHA-256**으로 해시한 뒤 **앞 32자리**를 방 열쇠로 씁니다.
웹페이지도 로그인할 때 브라우저에서 똑같이 계산하므로, 아래 방법과 값이 같아야 합니다.

**터미널(Linux/macOS)**

```sh
# Linux
printf '%s' "shared-office:1234" | sha256sum | cut -c1-32

# macOS (sha256sum이 없을 때)
printf '%s' "shared-office:1234" | shasum -a 256 | cut -c1-32
```

**브라우저 콘솔** (Firebase 콘솔이 아니라, 아무 HTTPS 페이지에서 F12 → Console)

```js
crypto.subtle.digest('SHA-256', new TextEncoder().encode('shared-office:1234'))
  .then(b => console.log([...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 32)));
```

출력 예: `9f2c1d7ab34e05c6d8e1f0a2b3c4d5e6` (32자리, 소문자 16진수)
이 값을 복사해 둡니다. **이메일·메신저로 남에게 보내지 마세요.** 이 값이 곧 비밀번호입니다.

## 5. 보안 규칙 게시 (가장 중요)

Realtime Database → **규칙** 탭에서 아래 내용을 붙여넣고 **게시**합니다.
`여기에_32자리_ROOM_KEY` 부분만 4단계에서 만든 값으로 바꿉니다.

```json
{
  "rules": {
    "office": {
      "$room": {
        ".read": "$room === '여기에_32자리_ROOM_KEY'",
        ".write": "$room === '여기에_32자리_ROOM_KEY'"
      }
    }
  }
}
```

이렇게 하면 웹페이지와 REST API 모두 `/office/{ROOM_KEY}/...` 경로로만 읽고 쓸 수 있고, 다른 경로와 다른 방 열쇠로는 접근할 수 없습니다.

## 6. GitHub Pages 배포

1. GitHub에서 새 **Public** 저장소를 만듭니다. (예: `shared-office`)
2. 이 폴더의 파일 5개를 저장소 **최상위**에 올립니다. (웹 화면에서 드래그해도 되고, git을 써도 됩니다.)

   ```sh
   git init
   git add .
   git commit -m "shared office"
   git branch -M main
   git remote add origin https://github.com/깃허브아이디/shared-office.git
   git push -u origin main
   ```

3. 저장소 **Settings → Pages → Build and deployment**
   - Source: **Deploy from a branch**
   - Branch: **main** / **/(root)** → **Save**
4. 1~2분 뒤 `https://깃허브아이디.github.io/shared-office/` 로 열립니다.

## 7. 사용법

| 탭 | 하는 일 |
|---|---|
| **공유 메모** | 작성자·태그(지시/요청/보고/메모)를 골라 등록. **이미지·문서(HWP·PDF·XLSX·PPTX·DOCX)·압축 파일**을 첨부할 수 있고(끌어다 놓기·Ctrl+V 붙여넣기), 카드에서 썸네일로 보거나 다운로드합니다. 카드에서 바로 **수정**(인라인), **완료** 체크, **답글**, **삭제**. 필터: 전체/미완료/태그별 |
| **이미지** | 여러 장을 한 번에 끌어다 놓거나 선택. 긴 변 1280px·JPEG로 자동 경량화해 저장. 클릭하면 크게 보기 + 다운로드 |
| **보드** | **설문 현황**(진행전/진행중/완료)과 **블로그 보드**(기획/작성중/발행완료)를 전환하며, 상태별 필터·추가·수정·삭제. 마감일은 D-day로 표시 |
| **AI 연동** | 지금 연결된 `databaseURL`과 `ROOM_KEY` 기준 **REST API 예시**가 자동으로 표시됩니다. 복사 버튼으로 바로 사용 |

모든 변경은 Firebase 실시간 연결로 다른 기기·다른 사람 화면에 바로 반영됩니다. 상단의 점이 초록이면 연결됨, 주황이면 연결 중입니다.

## 8. 다른 AI·스크립트에서 쓰기 (REST API)

기본 주소: `https://{DB주소}/office/{ROOM_KEY}` — 모든 요청 끝에 `.json`을 붙입니다.

```sh
BASE="https://shared-office-default-rtdb.asia-southeast1.firebasedatabase.app/office/9f2c1d7ab34e05c6d8e1f0a2b3c4d5e6"

# 메모 조회
curl "$BASE/memos.json"

# 메모 등록
curl -X POST -H "Content-Type: application/json" \
  -d '{"author":"AI비서","tag":"보고","text":"보고 내용","done":false,"createdAt":1795768800000}' \
  "$BASE/memos.json"

# 완료 처리 (PATCH = 일부 값만 수정)
curl -X PATCH -H "Content-Type: application/json" \
  -d '{"done":true}' "$BASE/memos/{메모ID}.json"

# 답글 등록
curl -X POST -H "Content-Type: application/json" \
  -d '{"author":"AI비서","text":"답글","createdAt":1795768800000}' \
  "$BASE/memos/{메모ID}/replies.json"

# 첨부 파일 본문 조회 (dataUrl 또는 chunks)
curl "$BASE/memoFiles/{파일ID}.json"
```

데이터 구조 (`/office/{ROOM_KEY}/`):

```
memos/{id}                 { author, tag, text, done, createdAt,
                             attachments: [{ fileId, name, type, size }],
                             replies/{replyId} }
memoFiles/{id}             { name, type, size, memoId, createdAt,
                             dataUrl }                       // 작은 파일
memoFiles/{id}             { name, type, size, memoId, createdAt,
                             chunkCount, chunks/{0..n} }     // 512K자 넘는 파일
images/{id}                { author, title, dataUrl, width, height, bytes, createdAt }
surveys/{id}               { title, deadline, status, assignee, note, updatedAt }
blogs/{id}                 { title, platform, status, author, note, updatedAt }
```

메모에는 첨부 파일의 **이름·형식·용량만** 들어가고 본문(Base64)은 `memoFiles`에 따로 둡니다.
그래서 `memos.json`이 가벼워 목록 로딩과 정기 확인(`check.sh`)이 느려지지 않습니다.

정기 확인용 `check.sh` 예시 (완료되지 않은 메모가 있을 때만 AI를 깨움):

```sh
#!/bin/sh
BASE="https://.../office/...."
json=$(curl -fsS "$BASE/memos.json?print=pretty") || exit 1
printf "%s" "$json" | grep -q '"done": false' && exit 0
exit 1
```

## 9. 알아 둘 제한과 주의

- **첨부 파일**: 한 메모에 10개까지, 파일 하나 5MB, 합계 15MB까지 올릴 수 있습니다. 이미지는 긴 변 1400px·JPEG로 자동 경량화되고, GIF·SVG·HEIC처럼 다시 그릴 수 없는 형식은 원본 그대로 저장됩니다. 문서 파일은 원본 바이트가 그대로 보관되어 다운로드하면 같은 파일이 됩니다.
- **큰 파일 저장 방식**: Base64 512K자가 넘는 파일은 `memoFiles/{id}/chunks/{0..n}`으로 나눠 씁니다(한 번에 큰 쓰기를 피해 실패 확률을 줄입니다). 조회할 때는 `memoFiles/{id}.json` 한 번이면 조각이 합쳐진 형태로 옵니다.
- **이미지 용량**: Realtime Database 값 하나는 10MB를 넘을 수 없습니다. 그래서 업로드할 때 큰 이미지는 줄이고, 첨부 파일은 위처럼 나눠 씁니다. 저장본은 원본이 아니라 줄인 이미지이고, 페이지를 열 때 첨부 이미지 썸네일을 그때그때 읽으므로 많이 쌓이면 첫 로딩이 느려질 수 있습니다.
- **무료 요금제(Spark)**: 저장 1GB, 월 다운로드 10GB까지 무료입니다. 이미지 200KB 기준 약 5,000장 수준입니다.
- **공개 저장소**: 페이지 주소는 공개입니다. 주소를 아는 사람도 비밀번호(ROOM_KEY)가 없으면 데이터를 볼 수 없지만, **이름·전화번호·주소·계정 비밀번호 같은 개인정보는 올리지 마세요.** 화면에도 같은 안내가 표시됩니다.
- **비밀번호 분실**: 데이터는 `/office/{기존_ROOM_KEY}`에 그대로 남아 있습니다. 4단계로 새 ROOM_KEY를 만들고 5단계 규칙을 새 값으로 바꾸면 새 방이 열리지만, 기존 데이터는 보이지 않습니다. 꼭 필요하면 Firebase 콘솔에서 기존 노드를 새 노드로 복사하세요.
- **비밀번호를 바꾸면** 방도 새로 생깁니다. 같은 비밀번호를 계속 쓰는 편이 관리하기 쉽습니다.

## 10. 문제 해결

| 증상 | 원인 / 해결 |
|---|---|
| "비밀번호가 맞지 않거나, 보안 규칙이 아직 설정되지 않았습니다" | 5단계 규칙의 ROOM_KEY와 4단계 값이 다르거나, 규칙을 게시하지 않았습니다. 둘을 다시 대조하세요. |
| "설정이 아직 필요합니다" | `firebase-config.js`가 아직 플레이스홀더입니다. 3단계를 마치세요. |
| 페이지가 하얗고 아무것도 안 보임 | `app.js`·`style.css` 경로가 저장소 최상위와 같은지 확인하세요. |
| 이미지 업로드가 실패함 | 사진 용량이 너무 큽니다. 더 작은 이미지로 시도하거나 캡처 후 올려 주세요. |
| 첨부 파일이 너무 크다고 나옴 | 파일 하나 5MB, 메모당 합계 15MB까지입니다. ZIP으로 묶거나 나눠서 올려 주세요. |
| 실시간 반영이 안 됨 | 상단 연결 점을 확인하세요. 오프라인이면 연결이 돌아올 때 자동으로 다시 붙습니다. |
| Firebase 요금이 걱정됨 | Spark 무료 한도 내에서만 동작하며, 한도를 넘으면 해당 월말까지 쓰기가 제한될 뿐 과금되지 않습니다. |

---

문의: 이 페이지는 (주)무나 전희주 님의 합동 비서실용으로 제작되었습니다.
