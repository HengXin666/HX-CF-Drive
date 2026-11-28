// 批量重命名规则 (#22): 序号模板或正则替换, 纯函数, 预览和提交共用
export type RenameRule =
  | { mode: 'seq'; template: string; start: number; pad: number; keepExt: boolean }
  | { mode: 'regex'; find: string; replace: string; ignoreCase: boolean };

const splitExt = (name: string) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
};

/** 返回每个名字的新名字; 正则写错时抛出 */
export function applyRename(names: string[], r: RenameRule): string[] {
  if (r.mode === 'seq') {
    return names.map((name, i) => {
      const [base, ext] = splitExt(name);
      const n = String(r.start + i).padStart(Math.max(0, r.pad), '0');
      const out = (r.template || '{name}_{n}').replaceAll('{n}', n).replaceAll('{name}', base);
      return r.keepExt ? out + ext : out;
    });
  }
  if (!r.find) return [...names];
  const re = new RegExp(r.find, r.ignoreCase ? 'gi' : 'g');
  return names.map((name) => name.replace(re, r.replace));
}
