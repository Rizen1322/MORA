import { describe, expect, it } from 'vitest';
import { PreparationBudget } from '../src/preparation-budget.ts';

describe('preparation budget', () => {
  it('increases the reserve for slow preparation and recovers as preparation speeds up', () => {
    const budget = new PreparationBudget(() => 4 * 1024 ** 3);
    expect(budget.candidates()).toBe(2);
    budget.observe(40_000);
    expect(budget.candidates()).toBe(4);
    budget.observe(2_000);
    budget.observe(2_000);
    expect(budget.candidates()).toBe(3);
    for (let i = 0; i < 8; i++) budget.observe(2_000);
    expect(budget.candidates()).toBe(2);
    budget.observe(NaN);
    expect(budget.candidates()).toBe(2);
  });

  it('shrinks the reserve immediately as available memory falls', () => {
    let free = 2 * 1024 ** 3;
    const budget = new PreparationBudget(() => free);
    budget.observe(40_000);
    expect(budget.candidates()).toBe(4);
    free = 800 * 1024 ** 2;
    expect(budget.candidates()).toBe(1);
    free = 400 * 1024 ** 2;
    expect(budget.candidates()).toBe(0);
    free = 2 * 1024 ** 3;
    expect(budget.candidates()).toBe(4);
  });
});
