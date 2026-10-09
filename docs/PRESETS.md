# 추출 프리셋: 세 페이지와 항목별 영역 고정

[대시보드 사용법](DASHBOARD.md) · [README](../README.md)

## 구조

**프리셋 하나 → 세 페이지 유형 → 추출 항목 → 고정한 선택자** 구조입니다. 화면에는 ✓ 고정됨 / ○ 미지정을 표시합니다.

| 페이지 유형 | 실제 URL 예시 | 선택할 영역 |
|---|---|---|
| 소설 목록 | `https://sbxh9.com/novel` | 여러 소설 카드, 카드 안의 제목·작가·표지·정보 페이지 링크, 목록 다음 페이지 |
| 소설 정보·회차 목록 | `https://sbxh9.com/novel/58387` | 위쪽 소설 제목·작가·태그·줄거리·표지와 아래쪽 회차 행·번호·회차 제목·본문 링크·더 보기 |
| 회차 본문 | `https://sbxh9.com/novel/58387/8837326` | 특정 회차의 본문 루트·실제 문단·로딩/오류 안내 |

회차 목록은 소설 정보 페이지 안에 있으므로 별도 네 번째 유형을 만들지 않습니다. **소설 제목**과 **회차 제목**, **정보 페이지 링크**와 **본문 링크**는 서로 다른 항목입니다. URL의 숫자는 샘플 소설·회차 ID이며 실제 설정 경로는 `{workId}`, `{episodeId}` 패턴으로 저장합니다.

유형·항목별 그림의 초록 테두리로 역할을 확인할 수 있습니다. 그림은 실제 원본 캡처가 아닌 합성 SVG이며 페이지에 없는 항목은 생략합니다.

## 사용 순서

### 기본 프리셋으로 시작하기

**기본 프리셋** 드롭다운에서 `sbxh9` 또는 `toki32` 템플릿을 선택하고 **추가**를 누르면 저장 목록에 수정 가능한 새 복사본이 생깁니다. 목록·정보/회차·본문의 세 페이지와 기본 선택자를 제공합니다. 기존 프리셋은 덮어쓰지 않으며 같은 템플릿을 다시 추가하면 별도 ID와 복사본 이름으로 저장합니다.

추가한 프리셋은 **불러오기**로 확인하고 원본 페이지에서 선택자와 미리보기를 검증하세요. 원본 사이트 구조가 바뀌면 기본 선택자를 수정해야 합니다. 기본 템플릿은 계정·쿠키·토큰·본문 표본을 포함하지 않습니다. 저장소 최대 100개 한도는 기본 복사본에도 적용됩니다.

기본 프리셋 **추가**는 실제 수집 파서의 활성 설정 변경이 아닙니다. 현재 자동 수집 경로는 유지되며 원본 북마크릿의 설정/미리보기와 저장 관리에서 사용할 수 있습니다. 기존 버전 1 프리셋과 사용자 편집한 버전 2 프리셋은 보존됩니다.

1. 대시보드에서 프리셋 이름을 정하고 세 페이지 중 유형과 항목을 선택합니다.
2. **수집 영역 선택** 링크를 북마크바에 등록합니다. 프리셋을 새로 만들거나 저장 연결을 갱신할 때 현재 링크로 등록하세요.
3. 해당 원본 URL을 입력하고 **원본 새 탭 열기**를 누른 뒤 원본에서 북마크를 실행합니다.
4. 원본 도구에서 항목을 고르고 영역을 클릭한 뒤 **이 항목 저장**을 눌러 고정합니다. 세 페이지에서 필요한 항목을 같은 프리셋으로 지정합니다.
5. 할당이 끝나면 원본 도구의 **프리셋 서버 저장**을 누릅니다. 대시보드가 열려 설정을 검증·저장하며 저장 완료 상태를 표시합니다.

원본의 URL로 세 페이지 유형을 자동 판별합니다. 이미 등록한 북마크의 초기 항목은 자동 갱신되지 않지만 원본 도구에서 다른 항목을 선택할 수 있습니다. 같은 원본 origin·프리셋 저장 키를 사용하는 세 페이지는 브라우저에 고정한 설정을 공유합니다.

일반 새 탭을 요청하며 서버 캡처·원격 마우스 입력을 사용하지 않습니다. 기존 브라우저 로그인·북마크를 사용합니다. 북마크바가 보이지 않으면 Ctrl+Shift+B (Mac: ⌘+Shift+B)로 표시합니다. 새 탭이 열리지 않으면 **원본 직접 열기** 링크를 사용하세요.

웹앱이 브라우저 북마크를 자동 등록하거나 다른 사이트에서 자동 실행할 수는 없습니다. 일부 사이트의 CSP/브라우저 정책은 북마크릿 실행을 제한할 수 있습니다.

## 지정과 고정

- **영역 클릭:** 후보를 선택합니다. 클릭만으로 저장하지 않습니다. 후보는 노란 테두리로 표시합니다.
- **이 항목 저장:** 선택자를 원본 브라우저의 프리셋 저장 공간에 고정합니다. 저장에 실패하면 고정됐다고 표시하지 않습니다.
- **항목 재선택:** 저장한 선택자를 다시 적용하고 해당 영역을 초록 테두리로 표시합니다. 반복 항목은 여러 매칭 영역을 표시합니다. 스크롤·화면 크기 변경 후 위치도 갱신합니다.
- **부모 요소:** 카드·회차 행·본문 바깥 영역을 고를 때 사용하고 다시 저장합니다.
- **페이지 탐색:** 원본 링크·로그인·스크롤을 정상적으로 사용합니다. 다시 선택 모드로 전환해 지정합니다.
- **항목 제거:** 해당 선택자를 삭제합니다. 반복 카드/행을 제거하거나 교체하면 종속 상대 항목도 다시 지정해야 합니다.
- ×/Esc로 도구를 닫아도 브라우저에 저장한 선택자는 남습니다. 다시 실행해 항목을 선택하면 복원됩니다.

반복 카드 `items` 또는 회차 행 `rows`를 **먼저 저장**하고 내부 항목을 지정하면 상대 선택자로 연결합니다. 다음 페이지·회차 더 보기 버튼은 반복 영역 밖의 항목입니다.

속성은 텍스트 `text`, 정보/본문 링크 `href`, 이미지 `src` 또는 `data-src`입니다. 열린 ShadowRoot와 원본 렌더러가 유효한 `__novelShadow` 참조를 제공한 root를 지원합니다. 접근할 수 없는 closed root와 iframe 내부는 지원하지 않습니다.

## 선택 항목만 미리보기

**선택 항목 미리보기**는 현재 선택한 항목의 값만 최대 5개, 제한된 길이로 표시합니다. 작가를 선택하면 작가 값만, 본문 텍스트를 선택하면 그 텍스트 표본만 표시합니다. 다른 항목으로 전환하면 이전 결과를 지웁니다. 여러 저장 항목을 한꺼번에 나열하는 전체 미리보기는 제공하지 않습니다.

미리보기 원문·쿠키·로그인 입력은 프리셋 JSON이나 서버에 전달하지 않습니다. 저장 대상은 추출 **값 자체가 아니라 선택자 설정**입니다.

## 서버 저장과 실제 수집 적용

**이 항목 저장**은 원본 브라우저의 고정 설정 저장입니다. **프리셋 서버 저장**은 세 페이지 설정을 대시보드로 넘겨 `data/extraction-presets.json`에 저장합니다. 서버 파일은 공개 Git에 포함하지 않습니다.

전달은 사용자가 누른 저장 버튼에서 대시보드 URL의 fragment로 선택자 JSON을 반환하는 방식입니다. 원본에서 cross-origin API 요청을 하지 않습니다. 대시보드는 자신이 발급한 저장 연결과 원본 origin을 확인하고 관리자 로그인 상태에서 기존 CRUD API로 저장합니다. fragment는 읽은 뒤 주소에서 제거합니다. 저장 연결은 최대 24시간이며 로그아웃하면 폐기됩니다. 연결이 만료되면 새 북마크를 등록하거나 고급 JSON 가져오기를 사용합니다.

**서버 저장 성공이 실제 수집기에 자동 적용됐다는 의미는 아닙니다.** 현재 수집 파서는 이 프리셋을 활성 설정으로 사용하지 않습니다. 기존 수집 원본·인증·작업을 바꾸는 활성 프리셋 연결은 별도 단계입니다.

대시보드 **불러오기**로 세 페이지와 고정 항목을 확인·수정할 수 있습니다. 고급 영역에서는 설정 JSON 붙여넣기·파일 가져오기·복사를 사용할 수 있습니다. 이전 버전의 목록/소개/목차/본문 단일 설정은 불러올 때 세 페이지 그룹으로 변환하고, 이전 목차의 제목·링크는 회차 제목·본문 링크로 구분합니다.

## 웹툰 선택 도구와 버전 3 연결

신규 웹툰 프리셋은 **소설·웹툰 프리셋 실행 연결 규격안**의 v3 형식으로 작성합니다. 서버 검증·API·공통 평가기는 별도 담당 작업이며, 화면은 선택자 작성·저장과 서버 원본 확인·적용 요청을 서로 다른 동작으로 연결합니다. 저장 성공은 원본 검증이나 수집 적용 성공을 뜻하지 않습니다.

- **수집할 작품 → 웹툰**을 선택하면 목록·작품 정보와 회차 목록·회차 본문을 지정할 수 있습니다. `/ing`, `/end`, `/webtoon/{workId}`, `/webtoon/{workId}/{episodeId}`와 문자·숫자·밑줄·하이픈 ID를 지원합니다. 실제 원본의 한글 슬러그는 URL 인코딩을 보존하며 경로 구분자를 포함한 ID는 거부합니다.
- 원본 페이지에서는 **본문 루트**를 먼저 고정하고 그 안의 **본문 이미지**를 고릅니다. 이미지 한 장의 로딩 상태·고유 ID·클래스 때문에 다른 이미지가 빠지지 않도록 기본 선택자는 루트 안의 `img`입니다. 광고가 들어 있지 않은 루트를 선택하세요.
- 웹툰 이미지는 `attribute: imageUrl`, `multiple: true`, `relativeTo: root`로 저장합니다. `imageUrl`은 현재 표시된 `currentSrc`, 지연 로딩 `data-src`, `src` 순으로 읽습니다. URL의 `.css` 같은 확장자는 이미지 형식 판정에 쓰지 않습니다.
- 초록 강조는 최대 20개, 값 미리보기는 최대 5개입니다. 이는 선택 도구의 화면 부하 제한이며 실제 수집 이미지 수 제한이 아닙니다. 원문·이미지 URL·쿠키·미리보기 값은 프리셋 JSON에 저장하지 않습니다.
- 목록 주소와 목차 순서에서 `sources.ongoing`, `sources.completed`, 선택적인 `sources.search`, `catalogOrder`를 지정합니다. 페이지 패턴은 원본 선택 도구에서 한 줄에 하나씩 작성하여 `pagePatterns` 배열로 보관합니다.
- 작가는 `authors`, 회차 원문 표시는 `chapterLabel`, 시즌은 `seasonLabel`·`seasonNumber`로 지정합니다. 목록·상세의 다음 페이지/더 보기 버튼은 각각 `actions.nextPage`·`actions.loadMore`로 저장하며 실행 JavaScript는 받지 않습니다.
- 저장한 프리셋의 유형은 편집 중 바뀌지 않습니다. 다른 유형이나 다른 원본 사이트를 지정하려면 **새 프리셋**을 사용합니다. 기존 v1/v2 소설 프리셋은 읽기·명시적 수정 흐름을 유지하며 자동으로 v3로 덮어쓰거나 활성화하지 않습니다.
- 기본 프리셋 드롭다운은 서버가 제공한 항목을 소설/웹툰 유형별로 보여 줍니다. 해당 유형의 템플릿이 아직 없으면 원본에서 직접 지정할 수 있습니다.

다음은 선택자 전달 형식 예시입니다. 실제 실행 필수 항목의 검증과 활성 연결은 서버 담당 모듈에서 별도로 수행합니다.

```json
{
  "version": 3,
  "contentType": "webtoon",
  "name": "웹툰 선택자",
  "origin": "https://sbxh9.com",
  "catalogOrder": "newest-first",
  "pages": {
    "listing": {
      "pagePatterns": ["/ing", "/end"],
      "sources": {"ongoing": "/ing", "completed": "/end"},
      "fields": {}
    },
    "detail": {"pagePatterns": ["/webtoon/{workId}"], "fields": {}},
    "reader": {
      "pagePatterns": ["/webtoon/{workId}/{episodeId}"],
      "fields": {
        "root": {"selector": ".vw-imgs", "shadowPath": [], "attribute": "text", "multiple": false},
        "images": {"selector": "img", "shadowPath": [], "attribute": "imageUrl", "multiple": true, "relativeTo": "root"}
      }
    }
  }
}
```

원본에서 서버 저장으로 돌아오는 연결은 origin·콘텐츠 유형·형식 버전·연결 만료·관리자 로그인 상태를 확인합니다. 다른 유형의 오래된 브라우저 임시 설정을 재사용하지 않으며, 로그아웃 뒤 늦게 도착한 응답도 저장 상태를 복원하지 않습니다.

### 저장·원본 확인·적용

서버가 연결 상태 API를 제공하면 저장한 프리셋을 불러왔을 때 **원본 확인 후 수집에 적용** 영역이 나타납니다. 기존 서버가 이 API를 아직 지원하지 않으면 기존 저장·선택 기능을 유지하고 새 영역은 표시하지 않습니다.

1. 목록·작품 정보·본문의 실제 HTTPS 주소를 각각 입력하고 확인 버튼을 누릅니다. 프리셋과 다른 origin이나 인증값이 들어 있는 주소는 요청하지 않습니다.
2. 확인 결과는 항목별 매칭 개수만 표시합니다. 원문·이미지 응답은 화면이나 로그로 가져오지 않습니다. 확인만으로 활성 연결이 바뀌지 않습니다.
3. **수집에 적용**은 별도 요청이며 서버가 최신 설정의 세 페이지 검증을 최종 확인합니다. 기본 연결을 바꾸더라도 실행 중인 예약의 설정 사본은 그대로 유지하는 것이 서버 계약입니다.
4. 편집한 내용이 아직 저장되지 않았으면 원본 확인·적용 버튼을 잠급니다. 기존에 저장된 다른 설정을 실수로 적용하는 것을 방지합니다.
5. 적용된 프리셋은 먼저 **적용 해제**한 뒤 삭제할 수 있습니다. 편집·탭 이동·로그아웃 이후의 늦은 응답은 이전 화면 상태를 복원하지 않습니다.

UI 연결 API는 `GET /api/extraction-presets/bindings`, `POST /api/extraction-presets/:id/validate`(본문: `pageKind`, `url`), `PUT /api/extraction-presets/:id/binding`, `DELETE /api/extraction-presets/:id/binding`(연결 변경 본문: 빈 객체)입니다. 실제 원본 접근·필수 필드·저장·활성 연결 검증은 서버 모듈에서 수행합니다.

검증 명령:

```sh
node --test tests/element-picker.test.mjs tests/element-picker-webtoon.test.mjs tests/preset-guide-v3.test.mjs tests/ui-extraction-presets.test.mjs tests/ui-preset-webtoon.test.mjs tests/preset-v3-browser.test.mjs
```

마지막 브라우저 왕복 시험에는 v3를 지원하는 서버 모듈과 Chromium이 필요합니다. 원본 사이트에 대한 실수집·활성 연결·CAPTCHA 처리를 시험하는 명령이 아닙니다.

## 기존 소설 JSON 형식 (버전 2)

```json
{
  "version": 2,
  "name": "소설 수집 프리셋",
  "origin": "https://example.com",
  "pages": {
    "listing": {
      "pagePattern": "/novel",
      "fields": {
        "items": { "selector": "a.novel-card", "shadowPath": [], "attribute": "text", "multiple": true },
        "title": { "selector": ".title", "shadowPath": [], "attribute": "text", "multiple": false, "relativeTo": "items" }
      }
    },
    "detail": {
      "pagePattern": "/novel/{workId}",
      "fields": {
        "title": { "selector": "h1", "shadowPath": [], "attribute": "text", "multiple": false },
        "rows": { "selector": ".episode-row", "shadowPath": [], "attribute": "text", "multiple": true },
        "chapterTitle": { "selector": ".episode-title", "shadowPath": [], "attribute": "text", "multiple": false, "relativeTo": "rows" }
      }
    },
    "reader": {
      "pagePattern": "/novel/{workId}/{episodeId}",
      "fields": { "text": { "selector": ".body", "shadowPath": [], "attribute": "text", "multiple": false } }
    }
  }
}
```

세 페이지를 모두 포함하되 아직 지정하지 않은 페이지의 `fields`는 빈 객체일 수 있습니다. 전체 프리셋은 한 항목 이상 필요합니다. 최대 100개·설정 32KiB·저장소 2MiB이며 서버가 지원 필드·속성·origin·상대 경로·크기를 검증합니다. 버전 1도 기존 저장소 호환을 위해 읽을 수 있습니다.

## API와 검증

### 버전 3 실행 연결 API

버전 3은 `contentType: novel | webtoon`과 세 페이지의 `pagePatterns`, `fields`, 선택적인 `sources`·`actions`를 사용합니다. 기존 버전 1·2 설정은 원본 레코드를 변경하지 않고 실행 규격으로 변환합니다. 웹툰 본문은 단일 `root` 안의 `images`에 `attribute: imageUrl`, `multiple: true`, `relativeTo: root`를 지정합니다.

- `POST /api/extraction-presets/:id/validate`: `{pageKind, url}`로 원본 한 페이지를 검증합니다. 결과는 설정 hash와 매칭 개수이며 미리보기 원문·이미지 주소·인증값을 저장하지 않습니다.
- `GET /api/extraction-presets/bindings`: 콘텐츠 유형·origin별 기본 연결과 검증 상태를 조회합니다.
- `PUT /api/extraction-presets/:id/binding`: 빈 객체로 기본 연결을 적용합니다. 필수 설정과 세 페이지의 최신 설정 hash 검증이 모두 필요합니다.
- `DELETE /api/extraction-presets/:id/binding`: 빈 객체로 기본 연결을 해제합니다. 기본 연결 중인 프리셋은 바로 삭제할 수 없습니다.

연결 설정과 검증 기록은 각각 `data/preset-bindings.json`, `data/preset-validation.json`에 보관합니다. 연결된 선택자를 편집한 뒤에는 새 예약에 사용하기 전 다시 검증해야 합니다. 예약 생성 경계에서는 `ExtractionPresets.snapshot`의 `presetId`, `presetSnapshot`, `presetHash`, `contentType`을 고정해 전달합니다.

공통 실행 경계는 `compilePreset`, `validateRunnablePreset`, `matchesPresetPage`, `evaluatePresetPage`, `clickPresetAction`입니다. DOM 평가기는 열린 Shadow DOM과 반복 부모를 구분하며, 같은 이미지 URL이 여러 DOM 위치에 있어도 순서를 유지합니다. 실제 목차 이동 완료와 이미지 바이트 저장·완전성은 호출하는 수집기가 확인해야 합니다.

이 API는 실행 연결의 공통 기반입니다. 기존 화면의 세 페이지 편집기는 버전 2 경계를 사용하고 기존 소설 수집 경로는 별도 연동 전까지 내장 파서를 유지합니다. 저장이나 기본 연결 기록만으로 예약·수집 호출 지점의 연동이 완료되었다고 판정하지 않습니다.

- `GET/POST /api/extraction-presets`: 요약 목록 / 새 설정 저장
- `GET/PUT/DELETE /api/extraction-presets/:id`: 불러오기 / 수정 저장 / 삭제

관리자 인증과 기존 쓰기 출처 검사를 유지합니다. 원본 페이지 열기·영역 선택·항목 미리보기에는 서버 API를 호출하지 않습니다.

```sh
node --test tests/extraction-presets.test.mjs tests/element-picker.test.mjs tests/preset-native-browser.test.mjs tests/ui-extraction-presets.test.mjs
```

## 개발 중인 실행 연결

웹툰 작품 찾기·예약은 타입과 원천을 구분합니다. 적용한 사용자 프리셋이 있으면 최신 원본 검증을 통과한 설정을 사용하며, 없으면 현재 확인한 일반 DOM 구조의 웹툰 기본 연결을 사용합니다. 기본 프리셋 목록에도 소설·웹툰 템플릿을 별도로 제공합니다. 복사해서 저장한 프리셋은 자동으로 적용되지 않습니다.

웹툰 예약에는 서버가 확정한 `presetSnapshot`·`presetHash`가 들어갑니다. 클라이언트가 임의의 사본·해시를 제출하는 것은 거부합니다. 선택한 연결의 실패를 다른 파서로 숨기지 않으며, 전체 회차 수와 목차가 일치해야 수집을 시작합니다.

웹툰 이미지 원천 URL·서명 query는 응답 처리 동안만 사용합니다. 영구 회차 기록에는 이미지 순서·파일명·실제 형식·바이트·SHA256·너비·높이와 완전성을 저장합니다. 소설의 기존 저장 ID와 TXT·EPUB 형식은 유지합니다.
