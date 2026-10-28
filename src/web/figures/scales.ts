import { useEffect, useState } from 'react';

export function logReason(values: number[], extents: number[] = []): string | undefined {
  if (!values.length) return '표시된 데이터가 없습니다.';
  if (values.some(value => !Number.isFinite(value) || value <= 0)) return '0 이하 또는 유효하지 않은 값이 있습니다.';
  if (extents.some(value => !Number.isFinite(value) || value <= 0)) return '오차 범위가 0 이하이거나 유효하지 않습니다.';
  return undefined;
}

export function useValidLog(initial: boolean, reason: string | undefined) {
  const [requested, setRequested] = useState(initial && !reason);
  useEffect(() => { if (reason) setRequested(false); }, [reason]);
  return [requested && !reason, setRequested] as const;
}

export const formatNumber = (n: number) => Number(n.toPrecision(4)).toString();
