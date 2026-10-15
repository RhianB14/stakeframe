export type DailyLimitState = {
  dailyLimitPercent: string | null;
  dailyLimit: string | null;
  usedToday: string;
  remainingToday: string | null;
  date: string;
  version: number;
};

export const dailyLimitStateSchema = {
  parse(value: unknown): DailyLimitState {
    if (!value || typeof value !== 'object') throw new Error('Invalid daily limit response');
    const state = value as Partial<DailyLimitState>;
    if (
      (state.dailyLimitPercent !== null && typeof state.dailyLimitPercent !== 'string') ||
      (state.dailyLimit !== null && typeof state.dailyLimit !== 'string') ||
      typeof state.usedToday !== 'string' ||
      (state.remainingToday !== null && typeof state.remainingToday !== 'string') ||
      typeof state.date !== 'string' ||
      typeof state.version !== 'number'
    ) {
      throw new Error('Invalid daily limit response');
    }
    return state as DailyLimitState;
  },
};
