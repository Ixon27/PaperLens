# paper-reader

개인용 논문 읽기 웹앱. Moonlight(선택 번역·설명·질문, 그림 영역 설명, 스마트 인용, 전체 채팅, 하이라이트)와
Caramel Lab(`[p.N]` 근거가 달린 한국어 구조 분석, 원문-번역 줄 맞춤 읽기, 마인드맵, 관련 논문 추천)을 한곳에 모았다.
결과는 앱 안에 남고, Obsidian 볼트 `04_References/Papers/` 로 내보낼 수 있다.

AI 는 API 키 없이 **로그인된 `claude` CLI / `codex` CLI** 를 그대로 쓴다(앱 상단에서 전환).

## 처음 한 번

```bash
brew install poppler          # pdftotext·pdfinfo (PDF 텍스트·좌표 추출)
which pdftotext               # /opt/homebrew/bin/pdftotext 가 나와야 한다
claude -p "2+2"               # Claude Code 로그인 확인 (구독 OAuth)
codex exec "2+2"              # Codex CLI 로그인 확인 (둘 중 하나만 있어도 된다)
node --version                # 25 이상
```

## 실행

```bash
npm install
npm run dev                   # http://localhost:5173  (API 는 127.0.0.1:4317)
```

배포 모드: `npm run build && npm start` → http://127.0.0.1:4317

서버는 `127.0.0.1` 에만 붙는다(CLI 를 실행하고 파일을 쓰기 때문).

## 환경 변수

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `PAPER_READER_DB_DIR` | `~/Library/Application Support/paper-reader` | SQLite DB 폴더. 동기화 폴더 밖에 둔다 |
| `PAPER_READER_FILES` | `~/Desktop/MM/paper-reader` | PDF·그림·임시 파일 (`pdfs/` `images/` `tmp/`) |
| `PAPER_READER_VAULT` | `~/Obsidian/IXON_Vault` | Obsidian 볼트. 내보내기는 `04_References/Papers/` |
| `PAPER_READER_EMAIL` | (없음) | OpenAlex·Crossref User-Agent 연락처. 있으면 Unpaywall 로 OA PDF 도 찾는다 |

볼트의 `MM` 이 `~/Desktop/MM` 심볼릭 링크라서, 내보낸 노트의 `[p.N]` 은
`[[MM/paper-reader/pdfs/<id>.pdf#page=N|p.N]]` 처럼 원문 PDF 쪽으로 바로 열린다.

## 쓰는 법

- **가져오기**: 라이브러리에 DOI·arXiv 링크를 붙여넣거나 PDF 를 창에 끌어다 놓는다. 오픈액세스 PDF 만 자동으로 받는다.
  유료 논문은 논문 화면의 빈 PDF 자리에 PDF 를 끌어다 붙인다.
  같은 DOI 는 겹쳐 올려도 한 논문으로 합쳐진다. 이미 PDF 가 붙은 논문의 파일은 덮어쓰지 않는다.
- **PDF 위에서**: 글을 선택하면 `번역 · 설명 · 질문 · 하이라이트 색 · 메모`. `Alt+드래그`(또는 `영역 선택`)로 그림·표·수식을 잘라 `설명`.
  본문의 `[12]` · `(Smith et al., 2020)` 같은 인용을 클릭하면 참고문헌 카드가 뜬다.
- **오른쪽 탭**: 번역(문단 카드에 마우스를 올리면 PDF 원문 줄이 파랗게 표시) · 분석(연구 유형 판별 → 3단 분석) ·
  채팅 · 마인드맵 · 인용·관련 · 하이라이트.
- **중단·재개**: 작업 진행 막대 옆 `취소`로 멈춘다. 서버를 재시작해도 완료된 번역·분석 호출은 남는다.
  번역은 `이어서 번역`으로 빠진 문단만 처리한다. CLI 구독 한도에 걸리면 오류가 표시되며 자동 재시도하지 않는다.
- **프롬프트**: `prompts/*.md` 를 고치면 서버 재시작 없이 다음 호출부터 반영된다.
  연구 유형을 늘리려면 `prompts/analysis.md` 에 `## === METHODS:<유형> ===` 섹션을, `prompts/classify.md` 와 UI 에 라벨을 추가한다.

## 개발

```bash
npm run typecheck
npm test
```

- PDF worker 는 로컬 `pdfjs-dist@4.10.38` 에서 가져온다(CDN worker 와 버전이 달라지지 않도록 고정).
- `react-pdf-highlighter-extended@8.1.0` 의 내부 페이지별 그룹 함수가 같은 하이라이트를 줄 수만큼 중복 렌더링한다.
  Vite alias 로 `src/web/pdf/group-highlights-by-page.ts` 를 사용해 한 페이지당 한 번만 그린다.
  이 alias 를 적용하려고 라이브러리 자체는 prebundle 에서 제외하고, 그 CommonJS 의존성은 따로 prebundle 한다.
  라이브러리 버전을 올리면 이 호환성 처리를 먼저 확인한다.
- PDF 의 링크 annotation 이 인용 텍스트를 덮어도 클릭을 포착해 참고문헌 팝오버를 연다.
- 회전된 PDF 페이지는 번역 문단의 hover 상자가 어긋날 수 있다. OCR 은 하지 않는다.

스캔본(텍스트 레이어 없는 PDF) OCR, KCI, Zotero 연동은 범위 밖이다.
