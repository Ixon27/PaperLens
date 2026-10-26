<!-- paper-reader 연구 유형 분류 요청서. 유형을 늘리려면 analysis.md 에 METHODS:<유형> 섹션을, 여기와 UI 에 라벨을 추가한다. 치환자: {title} {abstract} {methods_excerpt} -->

## === PROMPT ===
아래 논문이 어떤 연구 유형인지 골라 JSON 하나로만 답하라: {"types":["…"],"reason":"한 문장"}
유형(1~2개, 주된 것 먼저):
- wetlab: 실험실 측정(배양·분자생물학·생화학·동물/세포 실험)
- omics: 오믹스·계산·생물정보(시퀀싱 데이터 분석, 메타게놈, 모델링, 머신러닝)
- review: 리뷰·메타분석(새 데이터 없이 문헌 종합)
- clinical: 임상·코호트·역학(사람 대상 연구)
예: 마우스 실험 + 16S 시퀀싱 분석이면 ["wetlab","omics"].

제목: {title}
초록: {abstract}
방법 일부:
{methods_excerpt}
