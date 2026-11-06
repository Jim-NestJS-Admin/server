import { escapeSpreadsheetCell, sanitizeRichText } from './sanitize.js';
import { assertPublicUrl, isPrivateAddress } from './ssrf.js';

describe('安全工具（T25）', () => {
  it('富文本：去掉脚本、事件属性和 javascript: 链接', () => {
    const out = sanitizeRichText(
      '<p onclick="x()">hi<script>alert(1)</script><a href="javascript:alert(1)">a</a><img src=x onerror=1></p>',
    );
    expect(out).not.toMatch(/script|onclick|onerror|javascript:/i);
    expect(out).toContain('<p>hi');
  });

  it('导出：公式开头的文字加单引号', () => {
    expect(escapeSpreadsheetCell('=1+1')).toBe("'=1+1");
    expect(escapeSpreadsheetCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(escapeSpreadsheetCell('正常')).toBe('正常');
    expect(escapeSpreadsheetCell(-5)).toBe(-5);
  });

  it('SSRF：内网、本机、映射地址都算私有', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      '::ffff:127.0.0.1',
      'fd00::1',
    ])
      expect(isPrivateAddress(ip)).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });

  it('SSRF：拒绝内网 IP、非 http 协议、带账号密码的地址', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toThrow('内网');
    await expect(assertPublicUrl('http://[::1]/')).rejects.toThrow('内网');
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow('http');
    await expect(assertPublicUrl('http://u:p@8.8.8.8/')).rejects.toThrow(
      '账号密码',
    );
  });
});
