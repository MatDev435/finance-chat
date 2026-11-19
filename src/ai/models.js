/**
 * OpenAI models offered in the AI settings. Only models whose official model
 * page lists Structured Outputs and the Responses API are offered (checked on
 * 2026-11-19 at https://developers.openai.com/api/docs/models). The id is the
 * exact API model id; the name is what the user sees.
 *
 * reasoningEffort: interpretation is a short extraction task, so the lowest
 * effort every listed model accepts is used. GPT-6.2 Sol and GPT-6.2 Astra
 * reject "none" (HTTP 400), so "low" is used for all of them.
 */
export const AI_MODELS = Object.freeze([
  Object.freeze({ id: 'gpt-6-luna', name: 'GPT-6 Luna', description: 'Econômico, para mensagens do dia a dia (recomendado)', reasoningEffort: 'low' }),
  Object.freeze({ id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', description: 'Rápido e eficiente', reasoningEffort: 'low' }),
  Object.freeze({ id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', description: 'Equilíbrio entre qualidade e custo', reasoningEffort: 'low' }),
  Object.freeze({ id: 'gpt-6.2-astra', name: 'GPT-6.2 Astra', description: 'O mais capaz, e o mais caro', reasoningEffort: 'low' }),
]);

export const DEFAULT_MODEL = 'gpt-6-luna';

export function findModel(id) {
  return AI_MODELS.find((model) => model.id === id) || null;
}
