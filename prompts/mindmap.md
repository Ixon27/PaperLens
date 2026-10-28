<!-- paper-reader 마인드맵 요청서. 논문 본문은 system 으로 따로 붙는다. 치환자 없음. -->

## === PROMPT ===
이 논문의 구조를 마인드맵 JSON 하나로만 출력하라. 설명·코드블록 금지.
형식: {"root":{"label":"…","children":[{"label":"…","kind":"background|question|method|finding|limitation|concept","bullets":["…"],"pages":[3,4],"children":[…]}]}}
- root.label: 논문 핵심을 한국어 30자 이내로.
- 1단계 노드 4~7개: 배경·연구 질문·방법·핵심 발견·한계·핵심 개념 중 이 논문에 있는 것을 다룬다. method 는 실험·관측·이론 유도·알고리즘·모형·수치 해석, finding 은 측정 결과·정리·성능, concept 는 정의·원리·방정식이다. 한계는 저자가 밝힌 것만.
- 깊이 최대 3단계, 전체 노드 35개 이하. 노드마다 bullets 0~3개, 각 40자 이내, 수치는 원문 그대로. 수식은 짧은 텍스트로(예: E=mc^2).
- pages: 그 노드 근거가 있는 본문 [p.N] 의 N 들. 지어내지 마라.
- 전공 용어는 영어 원어 그대로.
