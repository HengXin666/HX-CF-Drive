// 前端纯函数 (#22): 批量重命名规则, 链接格式
import { describe, expect, it } from 'vitest';
import { formatLink } from '../web/src/lib/linkfmt';
import { applyRename } from '../web/src/lib/rename';

describe('批量重命名', () => {
  it('序号模板, 补零, 保留扩展名', () => {
    expect(applyRename(['IMG_1.jpg', 'b.png', 'noext'], { mode: 'seq', template: '照片_{n}', start: 9, pad: 2, keepExt: true }))
      .toEqual(['照片_09.jpg', '照片_10.png', '照片_11']);
  });
  it('{name} 是不含扩展名的原名', () => {
    expect(applyRename(['a.tar.gz'], { mode: 'seq', template: '{name}-{n}', start: 1, pad: 0, keepExt: false })).toEqual(['a.tar-1']);
  });
  it('正则替换与分组', () => {
    expect(applyRename(['IMG_0012.JPG', 'img_3.jpg'], { mode: 'regex', find: 'img_(\\d+)', replace: '照片$1', ignoreCase: true })).toEqual(['照片0012.JPG', '照片3.jpg']);
  });
  it('正则写错时抛出', () => {
    expect(() => applyRename(['a'], { mode: 'regex', find: '(', replace: '', ignoreCase: false })).toThrow();
  });
});

describe('链接格式', () => {
  const img = { name: 'a [1].png', mime: 'image/png', url: 'https://x/f/1/a.png?e=0&s=y' };
  const doc = { name: '<b>.txt', mime: 'text/plain', url: 'https://x/f/2' };
  it('图片', () => {
    expect(formatLink(img, 'markdown')).toBe('![a \\[1\\].png](https://x/f/1/a.png?e=0&s=y)');
    expect(formatLink(img, 'html')).toBe('<img src="https://x/f/1/a.png?e=0&amp;s=y" alt="a [1].png">');
    expect(formatLink(img, 'bbcode')).toBe('[img]https://x/f/1/a.png?e=0&s=y[/img]');
  });
  it('普通文件', () => {
    expect(formatLink(doc, 'html')).toBe('<a href="https://x/f/2">&lt;b&gt;.txt</a>');
    expect(formatLink(doc, 'url')).toBe('https://x/f/2');
  });
});
