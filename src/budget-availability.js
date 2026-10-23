function normalizeName(value) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
}

export function findCategoryAvailability(categories, budgetMonth, requestedName) {
  const category = categories.find((item) => normalizeName(item.name) === normalizeName(requestedName));
  if (!category) {
    const error = new Error(`A categoria '${requestedName}' não existe no Actual Budget.`);
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

export async function getSynchronizedCategoryAvailability(apiClient, categoryName, month) {
  await apiClient.sync();
  const [categories, budgetMonth] = await Promise.all([
    apiClient.getCategories(),
    apiClient.getBudgetMonth(month),
  ]);
  return findCategoryAvailability(categories, budgetMonth, categoryName);
}
