export const FIELDS = ['life', 'medicine', 'agri', 'chemistry', 'physics', 'astro', 'earth', 'math', 'cs', 'ee', 'mech', 'materials', 'civil', 'general'] as const;
export type FieldId = typeof FIELDS[number];

export const FIELD_LABELS: Record<FieldId, string> = {
  life: '생명과학',
  medicine: '의학·약학·보건',
  agri: '농림·식품·수의',
  chemistry: '화학',
  physics: '물리학',
  astro: '천문·우주',
  earth: '지구·환경·해양',
  math: '수학·통계',
  cs: '컴퓨터·AI',
  ee: '전기·전자',
  mech: '기계·항공·로봇',
  materials: '재료·화학공학·에너지',
  civil: '토목·건축·도시',
  general: '기타·학제간',
};

export const FIELD_SCOPES: Record<FieldId, string> = {
  life: '분자·세포·미생물·유전체·생태·진화·신경생물',
  medicine: '임상·역학·약리·간호·공중보건',
  agri: '작물·원예·축산·수의·식품과학·임업',
  chemistry: '유기·무기·분석·물리화학·고분자·계산화학',
  physics: '응집물질·입자·원자·광학·플라스마·양자·이론물리',
  astro: '천체물리·우주론·행성과학·우주탐사',
  earth: '지질·기후·대기·수문·해양·환경과학',
  math: '순수·응용수학·통계학·확률·최적화 이론',
  cs: '머신러닝·알고리즘·시스템·보안·HCI·데이터과학',
  ee: '회로·반도체 소자·통신·신호처리·전력·제어',
  mech: '열유체·고체역학·설계·항공우주·로봇·자동차',
  materials: '신소재·나노·배터리·태양전지·촉매·화학공정',
  civil: '구조·지반·교통·건축환경·도시계획·건설관리',
  general: '위 분야로 나누기 어려운 융합·과학기술정책·과학교육',
};

export const isFieldId = (v: unknown): v is FieldId => typeof v === 'string' && (FIELDS as readonly string[]).includes(v);

export function resolveField(field: string | null | undefined, suggested: string | null | undefined): FieldId {
  if (isFieldId(field)) return field;
  if (isFieldId(suggested)) return suggested;
  return 'general';
}

export const PAREN_CITATION_FIELDS: ReadonlySet<FieldId> = new Set(['life', 'medicine', 'agri', 'general']);
