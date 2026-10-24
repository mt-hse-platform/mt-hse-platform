// Tiny safe expression engine for "formula" questions: numbers, {questionId} references, + - * / ( ) and unary minus.
// No eval, no function calls, no property access.

export type Ast =
  | { t: 'num'; v: number }
  | { t: 'ref'; id: string }
  | { t: 'neg'; e: Ast }
  | { t: 'bin'; op: '+' | '-' | '*' | '/'; l: Ast; r: Ast };

export type ParseResult = { ok: true; ast: Ast; refs: string[] } | { ok: false };

export function parseFormula(src: string): ParseResult {
  const tokens: string[] = [];
  const re = /\s*(\d+(?:\.\d+)?|\{[A-Za-z0-9_-]+\}|[()+\-*/])/y;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) {
      if (src.slice(pos).trim() === '') break;
      return { ok: false };
    }
    tokens.push(m[1]!);
    pos = re.lastIndex;
  }
  if (tokens.length === 0) return { ok: false };

  let i = 0;
  const refs: string[] = [];
  const peek = () => tokens[i];

  function expr(): Ast | null {
    let left = term();
    while (left && (peek() === '+' || peek() === '-')) {
      const op = tokens[i++] as '+' | '-';
      const right = term();
      if (!right) return null;
      left = { t: 'bin', op, l: left, r: right };
    }
    return left;
  }
  function term(): Ast | null {
    let left = factor();
    while (left && (peek() === '*' || peek() === '/')) {
      const op = tokens[i++] as '*' | '/';
      const right = factor();
      if (!right) return null;
      left = { t: 'bin', op, l: left, r: right };
    }
    return left;
  }
  function factor(): Ast | null {
    const tok = tokens[i];
    if (tok === undefined) return null;
    if (tok === '-') { i++; const e = factor(); return e ? { t: 'neg', e } : null; }
    if (tok === '(') {
      i++;
      const e = expr();
      if (!e || tokens[i] !== ')') return null;
      i++;
      return e;
    }
    if (tok.startsWith('{')) { i++; const id = tok.slice(1, -1); refs.push(id); return { t: 'ref', id }; }
    if (/^\d/.test(tok)) { i++; return { t: 'num', v: Number(tok) }; }
    return null;
  }

  const ast = expr();
  if (!ast || i !== tokens.length) return { ok: false };
  return { ok: true, ast, refs: [...new Set(refs)] };
}

/** Returns null when a referenced value is missing/non-numeric or when dividing by zero. */
export function evalFormula(ast: Ast, getNumber: (id: string) => number | null): number | null {
  const go = (n: Ast): number | null => {
    switch (n.t) {
      case 'num': return n.v;
      case 'ref': return getNumber(n.id);
      case 'neg': { const v = go(n.e); return v === null ? null : -v; }
      case 'bin': {
        const l = go(n.l); const r = go(n.r);
        if (l === null || r === null) return null;
        if (n.op === '+') return l + r;
        if (n.op === '-') return l - r;
        if (n.op === '*') return l * r;
        return r === 0 ? null : l / r;
      }
    }
  };
  const v = go(ast);
  return v !== null && Number.isFinite(v) ? v : null;
}
