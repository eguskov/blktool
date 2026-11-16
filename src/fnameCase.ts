'use strict';
import * as fs from 'fs';
import * as path from 'path';

export interface BlkRef
{
  kind: 'include' | 'import';
  value: string;
  offset: number;
}

export interface FnameCaseIssue
{
  file: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  kind: string;
  written: string;
  real: string;
}

export interface FnameCaseOptions
{
  root: string;
  mountPoints: { [key: string]: string };
  searchDirs: string[];
}

function isIdentChar(c: string)
{
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '-' || c === '.' || c === '~';
}

class Scanner
{
  pos = 0;

  constructor(public text: string) {}

  eof()
  {
    return this.pos >= this.text.length;
  }

  skipWhite(allowCrlf = true, parseComments = true)
  {
    const t = this.text;
    while (this.pos < t.length)
    {
      const c = t[this.pos];
      if (c === ' ' || c === '\t' || c === '\x1A' || (allowCrlf && (c === '\r' || c === '\n')))
        this.pos++;
      else if (parseComments && c === '/' && t[this.pos + 1] === '/')
      {
        while (this.pos < t.length && t[this.pos] !== '\r' && t[this.pos] !== '\n')
          this.pos++;
      }
      else if (parseComments && c === '/' && t[this.pos + 1] === '*')
      {
        let cnt = 1;
        this.pos += 2;
        while (this.pos < t.length && cnt > 0)
        {
          if (t.startsWith('/*', this.pos))
          {
            cnt++;
            this.pos += 2;
          }
          else if (t.startsWith('*/', this.pos))
          {
            cnt--;
            this.pos += 2;
          }
          else
            this.pos++;
        }
      }
      else
        break;
    }
  }

  readIdent()
  {
    const start = this.pos;
    while (this.pos < this.text.length && isIdentChar(this.text[this.pos]))
      this.pos++;
    return this.text.substring(start, this.pos);
  }

  readValue(): { value: string, offset: number, plain: boolean }
  {
    const t = this.text;
    let qc = '';
    let multiLine = false;
    if (t[this.pos] === '"' || t[this.pos] === "'")
    {
      qc = t[this.pos++];
      if (t[this.pos] === qc && t[this.pos + 1] === qc)
      {
        multiLine = true;
        this.pos += 2;
      }
    }

    const start = this.pos;
    let end = start;
    let plain = !multiLine;
    while (this.pos < t.length)
    {
      const c = t[this.pos];
      if (qc)
      {
        if (c === qc && (!multiLine || (t[this.pos + 1] === qc && t[this.pos + 2] === qc)))
        {
          this.pos += multiLine ? 3 : 1;
          this.skipWhite(multiLine, multiLine);
          if (t[this.pos] === ';')
            this.pos++;
          break;
        }
        if (!multiLine && (c === '\r' || c === '\n'))
          break;
        if (c === '~')
        {
          plain = false;
          this.pos++;
        }
        end = ++this.pos;
      }
      else
      {
        if (c === ';')
        {
          this.pos++;
          break;
        }
        if (c === '\r' || c === '\n' || c === '}' || (c === '/' && t[this.pos + 1] === '/'))
          break;
        if (c === '/' && t[this.pos + 1] === '*')
        {
          const close = t.indexOf('*/', this.pos + 2);
          const commentEnd = close < 0 ? t.length : close + 2;
          const hasEol = /[\r\n]/.test(t.substring(this.pos, commentEnd));
          plain = false;
          this.pos = commentEnd;
          if (hasEol)
            break;
          continue;
        }
        this.pos++;
        if (c !== ' ' && c !== '\t')
          end = this.pos;
      }
    }
    return { value: t.substring(start, end), offset: start, plain };
  }
}

export function scanBlkRefs(text: string): BlkRef[]
{
  const refs: BlkRef[] = [];
  const s = new Scanner(text);
  let depth = 0;
  while (true)
  {
    s.skipWhite();
    if (s.eof())
      break;

    const c = text[s.pos];
    if (c === '}')
    {
      depth--;
      s.pos++;
      continue;
    }

    let name: string;
    if (isIdentChar(c))
      name = s.readIdent();
    else if (c === '"' || c === "'")
      name = s.readValue().value;
    else
    {
      s.pos++;
      continue;
    }

    s.skipWhite();
    const next = text[s.pos];
    if (next === '{')
    {
      depth++;
      s.pos++;
    }
    else if (next === ':')
    {
      s.pos++;
      s.skipWhite();
      const type = s.readIdent();
      s.skipWhite();
      const isArray = text.startsWith('[]', s.pos);
      if (isArray)
      {
        s.pos += 2;
        s.skipWhite();
      }
      if (text[s.pos] !== '=')
        continue;
      s.pos++;
      s.skipWhite(false);

      if (isArray)
      {
        if (text[s.pos] !== '[')
          continue;
        s.pos++;
        while (true)
        {
          s.skipWhite();
          if (s.eof())
            break;
          if (text[s.pos] === ']')
          {
            s.pos++;
            break;
          }
          const at = s.pos;
          s.readValue();
          if (s.pos === at)
            s.pos++;
        }
        continue;
      }

      const v = s.readValue();
      if (depth === 0 && type === 't' && v.plain && v.value && (name === 'import' || name === 'import_optional'))
        refs.push({ kind: 'import', value: v.value, offset: v.offset });
    }
    else if (next === '=')
    {
      s.pos++;
      s.skipWhite();
      s.readValue();
    }
    else if (name.toLowerCase() === 'include')
    {
      const v = s.readValue();
      if (v.plain && v.value)
        refs.push({ kind: 'include', value: v.value, offset: v.offset });
    }
  }
  return refs;
}

class DirCache
{
  private dirs = new Map<string, { exact: Set<string>, lower: Map<string, string> }>();

  private list(dir: string)
  {
    let entry = this.dirs.get(dir);
    if (entry === undefined)
    {
      entry = null;
      try
      {
        const names = fs.readdirSync(dir);
        entry = { exact: new Set<string>(names), lower: new Map<string, string>() };
        for (const n of names)
          entry.lower.set(n.toLowerCase(), n);
      }
      catch (err)
      {
      }
      this.dirs.set(dir, entry);
    }
    return entry;
  }

  resolve(base: string, rel: string): { fullPath: string, real: string, mismatch: boolean }
  {
    let dir = base;
    let real = '';
    let last = 0;
    let mismatch = false;
    const re = /[^\\/]+/g;
    let m: RegExpExecArray;
    while ((m = re.exec(rel)))
    {
      real += rel.substring(last, m.index);
      last = m.index + m[0].length;

      let name = m[0];
      if (name === '..')
        dir = path.dirname(dir);
      else if (name !== '.')
      {
        const entry = this.list(dir);
        if (!entry)
          return null;
        if (!entry.exact.has(name))
        {
          const realName = entry.lower.get(name.toLowerCase());
          if (realName === undefined)
            return null;
          name = realName;
          mismatch = true;
        }
        dir = path.join(dir, name);
      }
      real += name;
    }
    real += rel.substring(last);
    return { fullPath: dir, real, mismatch };
  }

  realCasePath(p: string)
  {
    const root = path.parse(p).root;
    const res = root ? this.resolve(root, p.substring(root.length)) : null;
    return res ? res.fullPath : p;
  }
}

function isBinaryBlk(buf: Buffer)
{
  for (let i = 0; i < 4 && i < buf.length; i++)
    if (buf[i] < 9)
      return true;
  return false;
}

function getLineStarts(text: string)
{
  const starts = [0];
  for (let i = 0; i < text.length; i++)
  {
    const c = text[i];
    if (c === '\r' && text[i + 1] === '\n')
      i++;
    if (c === '\r' || c === '\n')
      starts.push(i + 1);
  }
  return starts;
}

function findLine(lineStarts: number[], offset: number)
{
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi)
  {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset)
      lo = mid;
    else
      hi = mid - 1;
  }
  return lo;
}

export function checkFnameCase(filePath: string, text: string, opts: FnameCaseOptions): FnameCaseIssue[]
{
  const issues: FnameCaseIssue[] = [];
  const cache = new DirCache();
  const visited = new Set<string>();
  const importDir = path.dirname(filePath);
  const mountPoints = opts.mountPoints || {};
  const importRoots = (opts.searchDirs || []).concat(opts.root).filter(d => !!d);

  const getBases = (ref: BlkRef, fileDir: string): { dirs: string[], prefixLen: number } =>
  {
    const v = ref.value;
    if (v[0] === '%')
    {
      const slash = v.search(/[\\/]/);
      if (slash < 0)
        return null;
      const mount = mountPoints[v.substring(0, slash)] || mountPoints[v.substring(1, slash)];
      return mount ? { dirs: [mount], prefixLen: slash + 1 } : null;
    }
    if (v[0] === '#')
      return { dirs: ref.kind === 'import' ? importRoots : (opts.root ? [opts.root] : []), prefixLen: 1 };
    if (v[0] === '/' || v[0] === '\\' || v[0] === ':' || /^[A-Za-z]:/.test(v))
      return null;
    return { dirs: [ref.kind === 'import' ? importDir : fileDir], prefixLen: 0 };
  };

  const checkFile = (fn: string, fileText: string) =>
  {
    const fileDir = path.dirname(fn);
    let lineStarts: number[] = null;
    for (const ref of scanBlkRefs(fileText))
    {
      const bases = getBases(ref, fileDir);
      if (!bases)
        continue;

      let rel = ref.value.substring(bases.prefixLen);
      if (ref.kind === 'import' && rel.indexOf('*') >= 0)
        rel = rel.substring(0, Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\')) + 1);
      if (!rel)
        continue;

      let res = null;
      for (const dir of bases.dirs)
        if ((res = cache.resolve(dir, rel)))
          break;
      if (!res)
        continue;

      if (res.mismatch)
      {
        if (!lineStarts)
          lineStarts = getLineStarts(fileText);
        const start = ref.offset + bases.prefixLen, end = start + rel.length;
        const line = findLine(lineStarts, start), endLine = findLine(lineStarts, end);
        issues.push({
          file: fn, line, character: start - lineStarts[line], endLine, endCharacter: end - lineStarts[endLine],
          kind: ref.kind, written: rel, real: res.real
        });
      }

      if (ref.kind === 'include')
        visitFile(cache.realCasePath(res.fullPath));
    }
  };

  const visitFile = (fn: string) =>
  {
    const key = fn.toLowerCase();
    if (visited.has(key))
      return;
    visited.add(key);

    let buf: Buffer;
    try
    {
      buf = fs.readFileSync(fn);
    }
    catch (err)
    {
      return;
    }
    if (isBinaryBlk(buf))
      return;

    let fileText = buf.toString('utf8');
    if (fileText.charCodeAt(0) === 0xFEFF)
      fileText = fileText.substring(1);
    checkFile(fn, fileText);
  };

  visited.add(filePath.toLowerCase());
  checkFile(filePath, text);
  return issues;
}
