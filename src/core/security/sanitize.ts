import sanitizeHtml from 'sanitize-html';

/**
 * 富文本清洗（T25）：只留排版用的标签和属性，去掉脚本、事件属性、javascript: 链接、iframe 等。
 * 保存富文本（CMS 正文、公告）前调用，返回清洗后的 HTML；不要只靠前端编辑器过滤。
 */
export function sanitizeRichText(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'img',
      'h1',
      'h2',
      'span',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      '*': ['style', 'class'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowedStyles: {
      '*': {
        color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s,.%]+\)$/i],
        'text-align': [/^(left|right|center|justify)$/],
        'font-weight': [/^(bold|normal|\d{3})$/],
      },
    },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
    },
  });
}

/**
 * 导出到 Excel / CSV 的单元格转义（T25，防公式注入）：以 = + - @ 制表符、回车开头的文字前面加单引号，
 * 打开文件时不会被当成公式执行。数字、日期等非文字原样返回。
 */
export function escapeSpreadsheetCell(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
