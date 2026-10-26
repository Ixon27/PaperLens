# Paper Reader

내 컴퓨터에서 PDF 논문을 읽고 정리하는 **macOS 앱**. 브라우저나 터미널을 열 필요 없이 앱 아이콘으로 실행한다.

선택 번역·설명·질문, 그림 영역 설명, 논문 채팅, 하이라이트·메모, 한국어 구조 분석(`[p.N]` 근거), 원문-번역 줄 맞춤 읽기, 마인드맵, 스마트 인용·관련 논문, Obsidian 내보내기를 제공한다.

## 다운로드 · 설치

**[최신 설치 파일 다운로드 →](https://github.com/Ixon27/paper-reader/releases/latest)**

macOS 13 이상이 필요하다.

| Mac 종류 | 파일 이름 |
|---|---|
| Apple Silicon — M1/M2/M3/M4 등 | `Paper-Reader-<버전>-arm64.dmg` |
| Intel | `Paper-Reader-<버전>-x64.dmg` |

1. 내 Mac에 맞는 DMG를 연다. CPU 종류는 Apple 메뉴 → 이 Mac에 관하여에서 확인한다.
2. **Paper Reader**를 **Applications**로 끌어 놓는다. DMG 안에서 계속 실행하지 않는다.
3. 응용 프로그램 폴더에서 앱을 연다. Dock에 끌어 두어도 된다.
4. 첫 실행 안내에서 저장 위치와 AI 연결 상태를 확인한다. Obsidian 볼트는 선택 사항이다.

Node·Homebrew·Poppler·별도 서버 설치는 **필요 없다**. 실행 환경과 PDF 엔진을 앱에 포함한다. 앱이 내부 로컬 백엔드를 관리하며, `Cmd+Q`로 종료하면 백엔드와 실행 중인 AI 호출도 종료된다. 창만 닫으면 일반 맥 앱처럼 Dock에 남으며 아이콘으로 다시 연다.

### macOS 보안 안내

현재 설치 파일은 **ad-hoc 서명만 적용했으며 Apple 공증은 받지 않았다**. 최초 실행이 차단될 수 있다. 공식 GitHub Release에서 내려받은 파일인지 확인한 뒤, 실행을 한 번 시도하고 **시스템 설정 → 개인정보 보호 및 보안 → 확인 없이 열기**에서 허용한다. 조직에서 관리하는 Mac은 이 허용이 제한될 수 있다. Gatekeeper를 전체 해제하지 않는다.

각 Release의 `SHA256SUMS-*.txt`로 다운로드 무결성을 확인할 수 있다. 업데이트는 새 DMG를 받아 앱을 종료한 뒤 교체한다. 자동 업데이트는 제공하지 않는다. 앱을 교체해도 사용자 데이터는 그대로 남는다.

## AI 연결 — 각자의 계정 사용

PDF 가져오기·읽기·하이라이트·메모는 AI 없이 사용할 수 있다. 번역·설명·분석·채팅 등 AI 기능에는 **사용자가 직접 설치하고 로그인한 [Claude Code](https://code.claude.com/docs/en/setup) 또는 [Codex CLI](https://developers.openai.com/codex/cli/)** 중 하나가 필요하다.

- 앱에 공용 API 키, 개발자의 로그인, 구독 권한이 들어 있지 않다. GitHub에서 앱을 받는 것만으로 AI 구독이 제공되지 않는다.
- 공식 설치 안내로 CLI를 설치하고 터미널에서 `claude` 또는 `codex`를 한 번 실행해 로그인한다. 앱의 설정에서 CLI 감지 여부를 확인하고 엔진을 선택한다. **감지됨은 로그인·구독 인증을 보장하지 않는다.**
- 모델 이름을 직접 입력하지 않고 **설정의 드롭다운**에서 선택한다. Claude 빠른/깊은 모델과 Codex 모델을 각각 고를 수 있다. Codex의 **CLI 기본 모델**을 선택하면 CLI가 모델을 결정한다.
- CLI 한도·로그인 오류는 앱에 표시한다. 사용량 오류를 무시하거나 자동 재시도하지 않는다.
- Finder로 실행해도 `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`에서 CLI를 찾는다. 설치한 CLI 자체가 Node를 요구하는 방식이면 그 CLI의 설치 요건도 충족해야 한다. 앱의 기본 PDF 기능에는 시스템 Node가 필요 없다.

모델 목록은 설치된 Claude CLI의 초기화 응답과 Codex `model/list`에서 직접 불러온다. 목록 조회는 AI 응답을 생성하지 않는다. CLI를 업데이트하거나 로그인 계정을 바꾼 뒤에는 **모델 목록 새로고침**을 누른다. 목록에 없는 기존 모델 설정은 임의로 바꾸지 않으며, 조회 실패 시 오류를 표시하고 저장된 값을 유지한다. CLI가 노출한 목록과 실제 모델 사용 권한·사용량 제한은 다를 수 있다.

PDF·DB·메모는 로컬에 저장한다. **AI 기능을 실행하면 해당 논문의 텍스트 또는 선택한 그림이 선택한 AI 제공자에게 CLI를 통해 전송된다.** DOI/arXiv 가져오기와 관련 논문 조회는 Crossref·OpenAlex·arXiv 등의 공개 서비스를 이용한다. GitHub에 개인 논문이나 로그인 파일을 업로드하지 않는다.

## 저장 위치 · Obsidian

새 설치의 기본 위치:

| 항목 | 위치 |
|---|---|
| 논문 DB | `~/Library/Application Support/paper-reader/paper-reader.db` |
| PDF·그림·임시 파일 | `~/Library/Application Support/paper-reader/files/` |
| 앱 로그 | `~/Library/Logs/paper-reader/desktop.log` |
| Obsidian 볼트 | 기본 지정 없음 — 설정에서 폴더 선택 |

설정은 앱의 **설정** 버튼 또는 `Cmd+,`로 연다. 연락처 이메일은 선택 사항이며, 설정하면 OpenAlex/Crossref 요청의 연락처와 Unpaywall 오픈액세스 PDF 검색에 사용한다.

Obsidian을 사용할 경우 본인의 볼트를 선택한다. 노트는 `04_References/Papers/`, 그림 첨부는 `Attachments/paper-reader/`에 저장한다. 같은 이름의 노트는 확인 없이 덮어쓰지 않는다. PDF가 볼트 밖에 있으면 페이지 표기는 남지만 Obsidian 내부 PDF 링크는 만들지 않는다. PDF 폴더를 볼트 안에 두거나 기존 `MM` 연결을 사용하는 경우 원문 페이지 링크를 만든다.

이전 웹 버전의 DB와 기존 파일 폴더가 있으면 해당 위치를 유지한다. 논문을 다른 위치로 자동 이동·복사하지 않는다. 새 사용자에게 개발자 개인 볼트 경로를 기본값으로 지정하지 않는다.

## 쓰는 법

- **가져오기**: DOI·arXiv 링크를 붙여넣거나 PDF를 창에 끌어다 놓는다. 오픈액세스 PDF만 자동으로 받는다. 유료 논문은 직접 가진 PDF를 붙인다. 같은 DOI는 중복 등록하지 않는다.
- **PDF 선택**: 텍스트 선택 → 번역·설명·질문·색상 하이라이트·메모. `Option+드래그` 또는 영역 선택으로 그림·표·수식을 잘라 설명한다.
- **스마트 인용**: 본문의 `[12]`, `(Smith et al., 2020)` 같은 인용을 누르면 참고문헌 카드가 열린다.
- **오른쪽 탭**: 번역·분석·채팅·마인드맵·인용·관련·하이라이트. 번역 문단에 마우스를 올리면 대응하는 PDF 원문을 표시한다.
- **중단·재개**: 진행 막대의 취소로 작업을 멈춘다. 완료된 번역·분석은 재실행 후에도 남는다. 이어서 번역은 빠진 문단부터 처리한다.

텍스트 레이어가 없는 스캔 PDF의 OCR, KCI, Zotero 연동은 지원하지 않는다. 회전된 페이지는 번역 원문 표시가 어긋날 수 있다.

## 소스에서 실행 · 빌드

개발 환경은 macOS와 **Node 24 LTS 또는 26 이상**, npm을 사용한다.

```bash
git clone https://github.com/Ixon27/paper-reader.git
cd paper-reader
npm ci
npm run desktop              # 전용 앱 창으로 실행
```

```bash
npm run dev                  # 웹 개발: localhost:5173, API: 127.0.0.1:4317
npm run build && npm start   # 웹 프로덕션 모드
npm run typecheck
npm test
npm run pack:mac             # 현재 CPU용 .app → release/
npm run dist:mac             # 현재 CPU용 DMG + ZIP → release/
npm run install:app          # ~/Applications에 설치 + 바탕화면 바로가기
```

설치 스크립트는 실행 중인 앱·AI 작업을 강제 종료하지 않는다. 재설치 전 `Cmd+Q`로 종료한다. 배포 앱은 원본 저장소가 없어도 실행된다.

### 환경 변수

필요한 경우에만 실행 전에 지정한다. 기존 DB에 저장된 설정이 있으면 볼트·연락처는 저장된 설정을 따른다.

| 변수 | 기본값 / 용도 |
|---|---|
| `PAPER_READER_USER_DATA` | macOS 앱 사용자 데이터 폴더. 기본 `~/Library/Application Support/paper-reader` |
| `PAPER_READER_DB_DIR` | DB 폴더를 별도로 지정 |
| `PAPER_READER_FILES` | PDF·그림 폴더. 기본 DB 폴더 아래 `files/` |
| `PAPER_READER_VAULT` | 초기 Obsidian 볼트. 빈 문자열이면 지정하지 않음 |
| `PAPER_READER_EMAIL` | 초기 연락처 이메일. 기본 없음 |

웹 백엔드는 `127.0.0.1`에만 연결한다. 데스크톱 앱은 임의 포트와 매 실행마다 새 인증 토큰을 사용한다. 렌더러는 sandbox/context isolation을 적용하고 Node 접근을 허용하지 않는다. 외부 링크는 별도 브라우저에서 연다.

### Release

버전을 갱신하고 `v<버전>` 태그를 push하면 [macOS release workflow](.github/workflows/release-macos.yml)가 Apple Silicon·Intel 네이티브 러너에서 각각 빌드하고 DMG·ZIP·체크섬을 GitHub Release에 게시한다. 게시 전에 포함된 SQLite/FTS·PDF 런타임과 새 사용자 상태의 실제 앱 창에서 PDF 가져오기·뷰어 렌더링·정상 종료를 확인한다. 동일한 태그로 수동 실행도 가능하다. 현재는 Apple Developer 인증서 없이 배포하는 설정이다.

### 구현 주의사항

- PDF 텍스트·좌표 추출과 화면 worker는 모두 로컬 `pdfjs-dist@4.10.38`을 사용한다. 외부 PDF 프로그램이나 CDN worker를 사용하지 않는다.
- `react-pdf-highlighter-extended@8.1.0`의 페이지별 그룹 함수는 다중 줄 하이라이트를 중복 렌더링한다. Vite alias로 `src/web/pdf/group-highlights-by-page.ts`를 적용하며 라이브러리 자체를 prebundle에서 제외한다. 버전을 올릴 때 이 처리를 확인한다.
- `prompts/*.md`는 소스 실행에서 다음 AI 호출부터 반영된다. 배포 앱은 빌드 당시 프롬프트를 포함한다. 독자 배경 설명과 모델은 앱 설정에서 바꾼다.

## 0.2.1 변경 사항

모델 직접 입력을 CLI 모델 목록 기반 드롭다운으로 교체했다. Claude 빠른/깊은 모델과 Codex 모델을 선택·저장할 수 있으며, 모델 목록을 새로고침해도 편집 중인 설정을 유지한다. 모델 목록 조회 중 앱을 종료하면 조회용 CLI도 함께 종료한다.

## 0.2.0 변경 사항

브라우저를 여는 AppleScript 실행기를 전용 Electron 앱으로 교체했다. Node 런타임과 PDF 추출을 포함하고, 사용자별 저장소·선택형 Obsidian 연결·첫 실행 안내·네이티브 메뉴·DMG/ZIP 배포를 추가했다. 기존 로컬 DB·논문·AI 설정은 유지한다.

## 라이선스

[MIT](LICENSE). AI 제공자와 외부 데이터 서비스의 계정·이용 조건은 별도다.
