import {
  addUtcCalendarMonthsClamped,
  tanzaniaDateRange,
  todayInTanzania,
} from './tanzania-date';

describe('Tanzania calendar helpers', () => {
  it('uses East Africa time across the UTC midnight boundary', () => {
    expect(todayInTanzania(new Date('2026-08-02T22:30:00.000Z'))).toBe(
      '2026-08-03',
    );
  });

  it('builds Tanzania-local day boundaries as UTC instants', () => {
    expect(tanzaniaDateRange('2026-08-03')).toEqual({
      from: '2026-08-02T21:00:00.000Z',
      to: '2026-08-03T20:59:59.999Z',
    });
  });

  it('clamps billing periods at month end', () => {
    expect(
      addUtcCalendarMonthsClamped(
        new Date('2026-01-31T12:00:00.000Z'),
        1,
      ).toISOString(),
    ).toBe('2026-02-28T12:00:00.000Z');
  });
});
