import { resolveCategory } from './validation.js';

export function findCategoryAvailability(categories, budgetMonth, requestedName, categoryId) {
  let category;
  try {
    category = resolveCategory(categories, requestedName, categoryId);
  } catch (error) {
    error.code = 'CATEGORY_NOT_FOUND';
    throw error;
  }

  const monthCategory = (budgetMonth.categoryGroups || [])
    .flatMap((group) => group.categories || [])
    .find((item) => item.id === category.id);

  return {
    category: { id: category.id, name: category.name },
    available: monthCategory?.balance ?? 0,
  };
}

export async function getSynchronizedCategoryAvailability(apiClient, categoryName, month, categoryId) {
  await apiClient.sync();
  const [categories, budgetMonth] = await Promise.all([
    apiClient.getCategories(),
    apiClient.getBudgetMonth(month),
  ]);
  return findCategoryAvailability(categories, budgetMonth, categoryName, categoryId);
}
