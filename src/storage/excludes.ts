// gitignore-lite patterns:
//   "name"        matches any file or folder with that name at any depth
//   "name/"       matches only folders with that name at any depth
//   "*.log"       glob: * (no slash), ** (anything), ? (one char)
//   "a/b*"        contains a slash -> anchored to the start of the path
export interface Matcher {
  test(path: string): boolean;
}

function globToRegexSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

export function compilePattern(raw: string): Matcher | null {
  let p = raw.trim();
  if (!p || p.startsWith('#')) return null;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.replace(/\/+$/, '');
  if (!p) return null;
  const anchored = p.includes('/');
  p = p.replace(/^\/+/, '');
  const src = globToRegexSource(p);
  if (anchored) {
    const re = new RegExp(`^${src}(?:/.*)?$`);
    const reDir = new RegExp(`^${src}/.*$`);
    return { test: (path) => (dirOnly ? reDir.test(path) : re.test(path)) };
  }
  const re = new RegExp(`^${src}$`);
  return {
    test(path) {
      const segs = path.split('/');
      const last = segs.length - 1;
      return segs.some((s, i) => (!dirOnly || i < last) && re.test(s));
    },
  };
}

export function compilePatterns(patterns: string[]): Matcher[] {
  return patterns.map(compilePattern).filter((m): m is Matcher => m !== null);
}

export const isExcluded = (path: string, matchers: Matcher[]) => matchers.some((m) => m.test(path));
