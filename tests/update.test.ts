import { expect, it } from 'vitest';
import { compareVersions } from '../src/server/update';

it('orders release versions numerically, not as text', () => {
  expect(compareVersions('0.10.0', '0.9.3')).toBe(1);
  expect(compareVersions('v0.3.1', '0.3.0')).toBe(1);
  expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
  expect(compareVersions('0.3', '0.3.0')).toBe(0);
  expect(compareVersions('0.2.9', '0.3.0')).toBe(-1);
  expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(0);
});
