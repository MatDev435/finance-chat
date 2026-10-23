export function evaluateCategorySpending(available, requested) {
  const remaining = available - requested;
  return { available, requested, remaining, canSpend: remaining >= 0 };
}
