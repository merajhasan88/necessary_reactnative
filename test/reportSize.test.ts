// The report-size rule: a report a backend would refuse for its size is never sent. The lists the
// contract lets a collector shorten are halved, and say truncated, until it fits; anything else is
// an error naming the limit -- nothing is cut silently.
import { ApiException, fitReport, reportByteLimit } from '../src';
import { utf8Encode } from '../src/util/bytes';

const report = (probes: Record<string, unknown>): Record<string, unknown> => ({
  challenge_id: 'c',
  challenge_nonce: 'n',
  installation_id: 'i',
  platform: 'android',
  collector_version: 8,
  collected_at: 1,
  probe_results: probes,
  enabled_measurements: ['accessibility'],
  version: 1,
});
const bytes = (value: Record<string, unknown>): number => utf8Encode(JSON.stringify(value)).length;
const service = (i: number) => ({
  package: `com.example.service.with.a.long.name.number${i}`,
  service: `com.example.service.with.a.long.name.number${i}.Service`,
  system: false,
  installer: 'com.android.vending',
});

test('a report that fits is sent as it is', () => {
  const value = report({ accessibility: { status: 'ok', services: [service(1)], truncated: false } });
  expect(fitReport(value)).toEqual(value);
});

test('a list the contract lets shorten is halved, and says so, until it fits', () => {
  const value = report({
    accessibility: { status: 'ok', services: Array.from({ length: 2000 }, (_, i) => service(i)), settings_only: [], truncated: false },
    device: { status: 'ok', model: 'm' },
  });
  expect(bytes(value)).toBeGreaterThan(reportByteLimit);
  const fitted = fitReport(value);
  expect(bytes(fitted)).toBeLessThanOrEqual(reportByteLimit);
  const probes = fitted['probe_results'] as Record<string, any>;
  expect(probes['accessibility']['truncated']).toBe(true);
  expect(probes['accessibility']['services'].length).toBeLessThan(2000);
  expect(probes['device']).toEqual({ status: 'ok', model: 'm' });
  // the collector answer itself is left as it came
  expect((value['probe_results'] as Record<string, any>)['accessibility']['services']).toHaveLength(2000);
});

test('anything else too large is an error naming the limit', () => {
  const value = report({ device: { status: 'ok', model: 'x'.repeat(reportByteLimit + 1) } });
  expect(() => fitReport(value)).toThrow(ApiException);
  try {
    fitReport(value);
  } catch (error) {
    expect((error as ApiException).code).toBe('report_too_large');
    expect((error as ApiException).details?.['limit']).toBe(reportByteLimit);
  }
});
