import { renderTemplate, validateTemplate } from './ai-template.js';
describe('AI模板变量', () => {
  it('只替换模板自身变量，用户正文的占位符和脚本是普通文本', () => {
    expect(
      renderTemplate('{{text}} {{language}}', {
        text: '{{language}} <script>alert(1)</script>',
        language: '中文',
      }),
    ).toBe('{{language}} <script>alert(1)</script> 中文');
    expect(() => validateTemplate('{{text}} {{password}}')).toThrow();
    expect(() => validateTemplate('{{text}} {{ text }}')).toThrow();
    expect(() => validateTemplate('没有原文变量')).toThrow();
  });
});
