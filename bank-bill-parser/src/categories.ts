export const DEFAULT_CATEGORIES = [
  'Housing',
  'Utilities',
  'Food',
  'Transportation',
  'Insurance',
  'Debt',
  'Savings',
  'Giving',
  'Subscriptions',
  'Other',
] as const

export type Category = (typeof DEFAULT_CATEGORIES)[number]
