import { crudErrors } from '../../../core/crud/crud.errors.js';
const VARIABLES = new Set(['text', 'instruction', 'language']);
export function validateTemplate(content: string) {
  if (!content.includes('{{text}}'))
    throw crudErrors.badRequest('模板必须包含{{text}}');
  const stripped = content.replace(
    /\{\{([a-z]+)\}\}/g,
    (_match, key: string) => {
      if (!VARIABLES.has(key))
        throw crudErrors.badRequest(
          '模板变量仅支持text、instruction、language',
        );
      return '';
    },
  );
  if (stripped.includes('{{') || stripped.includes('}}'))
    throw crudErrors.badRequest('模板变量格式无效');
}
export function renderTemplate(
  content: string,
  values: Record<string, string>,
) {
  validateTemplate(content);
  return content.replace(
    /\{\{([a-z]+)\}\}/g,
    (_match, key: string) => values[key] ?? '',
  );
}
