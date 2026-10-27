## === PROMPT ===
'{title}' 논문 하나만 다룬다. 읽는 사람: {context}

이 {kind_name} ({label}, p.{page})을 독자가 직접 만져 볼 수 있는 인터랙티브 위젯 하나로 바꾼다. 첨부 이미지는 이 쪽 전체다. {label} 만 다룬다.

캡션:
{caption}

본문 언급:
{mentions}

{kind_rule}

종류 선택: 측정 시리즈는 line/bar/scatter, 조성은 stacked, 분포는 box, 행렬은 heatmap, 차등 발현은 volcano, PCA/PCoA는 ordination, Kaplan–Meier는 survival, IC50/EC50 곡선은 doseResponse. 핵심 방정식은 formula, 조건 표는 compare/table. 파이프라인·기전·작업 흐름은 flow, 일정은 timeline, 분류·계통은 tree, 상호작용 지도는 network, 겹침은 venn. 도식이나 사진에 다른 형식이 맞지 않을 때만 hotspot을 쓴다.

데이터 규칙:
- 본문이나 표에 명시된 정확한 수치를 우선한다. 필요할 때만 그림에서 값을 읽으며, 하나라도 눈으로 읽으면 approx: true로 한다. 그림에 없는 시리즈·그룹을 지어내지 마라.
- 촘촘한 플롯은 라벨이 있거나 유의한 점을 남기고 아래 최대 개수를 지킨다. 수치가 부족하면 적합한 다른 종류를 선택한다.
- title, takeaway, howTo, notes는 한국어. 축·변수·분류군 이름은 인쇄된 그대로 둔다.
- sources는 근거 {page, quote} 배열이다. quote는 그 쪽 본문에 실제로 있는 연속된 5~15단어를 원래 언어 그대로 옮긴다(번역·요약·철자 수정 금지). 구절 안에 큰따옴표·대괄호가 있으면 그 앞에서 끊는다. 정확히 옮길 자신이 없으면 quote: null. 페이지를 지어내지 마라.
- 모든 수는 유한한 JSON 숫자로 쓴다. 없는 값은 null, 선택 필드는 생략한다.

모든 종류의 공통 필드: kind, title(최대 80자), takeaway(한 줄 결론, 최대 200자), howTo(사용 방법, 최대 160자), approx(boolean), sources([{page, quote}], 최대 6개), notes(문자열 배열, 최대 5개, 항목당 200자). 그 밖의 라벨은 최대 80자, 설명은 최대 300자.

종류별 필드(JSON 모양):
- line: {xLabel, yLabel, xLog?, yLog?, series:[{name, points:[{x,y,err?}]}]} — 1~12 series, 각 2~500 points.
- bar: {yLabel, categories:[string], series:[{name, values:[number|null], errors?:[number|null]}]} — 1~60 categories, 1~12 series, values/errors 길이는 categories와 같음.
- scatter: {xLabel,yLabel,xLog?,yLog?,points:[{x,y,group?,label?}]} — 점 2~2000개.
- stacked: {yLabel,samples:[string],parts:[{name,values:[number]}]} — samples 1~80개, parts 1~30개, 값은 0 이상이며 길이는 samples와 같음.
- box: {yLabel,groups:[{name,min,q1,median,q3,max,mean?,n?}]} — 1~30개, min ≤ q1 ≤ median ≤ q3 ≤ max.
- heatmap: {rowLabel,colLabel,valueLabel,rows:[string],cols:[string],values:[[number|null]],diverging:boolean} — 행·열 각각 최대 80, values 차원 일치.
- volcano: {xLabel,points:[{label?,log2fc,p}],pThreshold,fcThreshold} — 점 1~2000개, 0 < p ≤ 1, 0 ≤ pThreshold ≤ 1, fcThreshold ≥ 0.
- ordination: {xLabel,yLabel,points:[{x,y,group,label?}]} — 점 2~2000개.
- survival: {timeLabel,groups:[{name,steps:[{t,s}],censored?:[number]}]} — 1~8개 그룹, s는 0~1, t는 시간순 비감소.
- doseResponse: {xLabel,yLabel,curves:[{name,bottom,top,ec50,hill,points?:[{x,y}]}]} — 1~8개 곡선, ec50 > 0, hill ≠ 0, 점 x > 0.
- formula: {expression,latex,x:{name,label,min,max},yLabel,variables:[{name,label,min,max,step,value,unit?}]} — 변수 0~8개, min < max, step > 0, value는 범위 안. expression에는 x.name, variables.name, pi, e와 + - * / ^, exp ln log log10 log2 sqrt abs sin cos tan tanh min max pow 및 괄호만 쓴다. latex는 원문 수식이다.
- compare: {conditions:[string],metrics:[{name,unit?,values:[number|null],higherIsBetter?}]} — 조건 2~6개, 지표 1~20개, values 길이는 조건 수와 같음.
- table: {columns:[{key,label,numeric:boolean,unit?}],rows:[{열key:문자열|숫자|null}],highlight?:[행인덱스]} — 열 1~12개(고유 key), 행 1~200개, highlight는 유효한 0부터의 인덱스.
- flow: {steps:[{id,label,detail,page?}],edges:[{from,to,label?}]} — 단계 2~30개, id 고유, edge는 존재하는 id를 참조.
- timeline: {unit,events:[{label,detail,start,end?,lane?}]} — 사건 1~60개, end ≥ start.
- tree: {root:{label,detail?,children?:[같은 구조]}} — 깊이 최대 6, 노드 최대 200.
- network: {nodes:[{id,label,group?,detail?}],edges:[{source,target,weight?,sign?:'+'|'-'}]} — 고유 노드 2~150개, 간선 최대 600개, 양 끝은 존재하는 id.
- venn: {sets:[{name,size}],regions:[{sets:[집합 이름],count,members?:[string]}]} — 집합 2~3개, region의 sets는 집합 이름만, members 최대 50개.
- hotspot: {box:[x0,y0,x1,y1],spots:[{x,y,label,detail,page?}]} — box는 전체 쪽에서 그림 영역의 정규화 좌표(0~1, x0<x1, y0<y1); spots 1~20개, x/y는 box 안의 상대좌표 0~1.

설명 없이 JSON 객체 하나만 출력하라.
