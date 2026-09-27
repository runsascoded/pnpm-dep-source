import { parse } from '@babel/parser'
import type { ArrayExpression, Expression, Node, ObjectExpression, ObjectProperty, Statement } from '@babel/types'

// Edits to `optimizeDeps.exclude` in a Vite config. A real parser locates the
// edit points, then edits are applied as text splices at those offsets — the
// file is never re-printed, so formatting, comments, and quote style survive
// byte-for-byte. (An AST *printer* — magicast/recast — reformatted user files,
// which is why that approach was abandoned.)
//
// Insertion and removal are exact inverses for every list shape (single-line,
// multi-line, with/without trailing comma), so `pds l X` → `pds g X` restores
// the config byte-identically, and sibling keys (`include`, `esbuildOptions`,
// …) are never touched.

export type ViteEditStatus = 'changed' | 'unchanged' | 'unsupported'
export interface ViteEdit {
  content: string
  status: ViteEditStatus
  /** Why the edit couldn't be made (status `unsupported`). */
  reason?: string
}

interface Item { start: number, end: number }

/** A bracketed, comma-separated list: an array literal or object literal. */
interface List {
  /** Offset of the opening `[` / `{`. */
  open: number
  /** Offset of the closing `]` / `}`. */
  close: number
  items: Item[]
}

class Unsupported extends Error {}

class Source {
  readonly unit: string
  readonly quote: string
  private readonly comments: Item[]

  constructor(readonly text: string, comments: Item[]) {
    this.comments = comments
    this.unit = text.match(/\n([ \t]+)\S/)?.[1] ?? '  '
    this.quote = text.match(/\bfrom\s+(['"])/)?.[1] ?? '\''
  }

  /** Skip whitespace and comments. */
  skipTrivia(i: number): number {
    for (;;) {
      while (i < this.text.length && /\s/.test(this.text[i])) i++
      const comment = this.comments.find(c => c.start === i)
      if (!comment) return i
      i = comment.end
    }
  }

  /** Offset just past the comma following `item`, if there is one. */
  commaEnd(item: Item): number | undefined {
    const i = this.skipTrivia(item.end)
    return this.text[i] === ',' ? i + 1 : undefined
  }

  lineStart(i: number): number { return this.text.lastIndexOf('\n', i - 1) + 1 }

  lineEnd(i: number): number {
    const j = this.text.indexOf('\n', i)
    return j === -1 ? this.text.length : j
  }

  isBlank(from: number, to: number): boolean { return /^[ \t]*$/.test(this.text.slice(from, to)) }

  /** Whether `[i, end of line)` holds only whitespace, optionally ending in a comment. */
  restOfLineIsTrivia(i: number): boolean {
    const eol = this.lineEnd(i)
    while (i < eol && /[ \t]/.test(this.text[i])) i++
    const comment = this.comments.find(c => c.start === i)
    if (comment && comment.end <= eol) i = comment.end
    return this.isBlank(i, eol)
  }

  indentOf(i: number): string { return this.text.slice(this.lineStart(i)).match(/^[ \t]*/)![0] }

  isMultiline(list: List): boolean { return this.text.slice(list.open, list.close).includes('\n') }

  /** Whether the list's interior holds nothing but whitespace (no comments). */
  isEmpty(list: List): boolean { return /^\s*$/.test(this.text.slice(list.open + 1, list.close)) }
}

type Splice = { at: number, del?: number, ins?: string }

function apply(text: string, s: Splice): string {
  return text.slice(0, s.at) + (s.ins ?? '') + text.slice(s.at + (s.del ?? 0))
}

/**
 * Append an item to `list`. `render(indent)` produces the item's text; `indent`
 * is the item indentation in a multi-line list, or `null` in a single-line one.
 * `emptyMultiline`: lay out an insert into an empty list across lines (used for
 * the root config object).
 */
function appendItem(
  src: Source,
  list: List,
  render: (indent: string | null) => string,
  emptyMultiline = false,
): Splice {
  const { items, close } = list
  const multi = src.isMultiline(list)
  const closeOwnLine = src.isBlank(src.lineStart(close), close)
  if (items.length === 0) {
    if (multi && closeOwnLine) {
      const indent = src.indentOf(close) + src.unit
      return { at: src.lineStart(close), ins: `${indent}${render(indent)},\n` }
    }
    if (emptyMultiline) {
      const indent = src.indentOf(list.open) + src.unit
      return { at: list.open + 1, ins: `\n${indent}${render(indent)},\n${src.indentOf(list.open)}` }
    }
    return { at: list.open + 1, ins: render(null) }
  }
  const last = items[items.length - 1]
  const comma = src.commaEnd(last)
  if (multi) {
    const indent = src.indentOf(last.start)
    if (comma !== undefined && closeOwnLine) {
      return { at: src.lineStart(close), ins: `${indent}${render(indent)},\n` }
    }
    if (comma !== undefined) return { at: comma, ins: `\n${indent}${render(indent)},` }
    return { at: last.end, ins: `,\n${indent}${render(indent)}` }
  }
  if (comma !== undefined) return { at: comma, ins: ` ${render(null)},` }
  return { at: last.end, ins: `, ${render(null)}` }
}

/** Remove `list.items[idx]` — the exact inverse of `appendItem` for a last item. */
function removeItem(src: Source, list: List, idx: number): Splice {
  const { items } = list
  const x = items[idx]
  const comma = src.commaEnd(x)
  const span = (from: number, to: number): Splice => ({ at: from, del: to - from })
  if (
    comma !== undefined && src.isMultiline(list)
    && src.isBlank(src.lineStart(x.start), x.start)
    && src.restOfLineIsTrivia(comma)
  ) {
    // Item occupies its own line(s), possibly with a trailing comment annotating
    // it: drop them whole.
    const end = src.lineEnd(comma)
    return span(src.lineStart(x.start), Math.min(end + 1, src.text.length))
  }
  if (idx < items.length - 1) {
    // Not last: drop the item, its comma, and the whitespace up to the next item.
    let to = comma!
    while (/[ \t\n\r]/.test(src.text[to])) to++
    return span(x.start, to)
  }
  if (items.length === 1) return span(x.start, comma ?? x.end)
  const prev = items[idx - 1]
  if (comma !== undefined) return span(src.commaEnd(prev)!, comma)
  return span(prev.end, x.end)
}

function unwrap(n: Node): Node {
  while (
    n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression'
    || n.type === 'TSNonNullExpression' || n.type === 'ParenthesizedExpression'
  ) n = n.expression
  return n
}

/** Resolve an expression to the Vite config object literal. */
function resolveConfig(n: Node | null | undefined, body: Statement[], seen = new Set<string>()): ObjectExpression {
  if (!n) throw new Unsupported('no config object found')
  n = unwrap(n)
  switch (n.type) {
    case 'ObjectExpression':
      return n
    case 'CallExpression': {
      // `defineConfig(…)`
      const arg = n.arguments[0]
      if (!arg || arg.type === 'SpreadElement' || arg.type === 'ArgumentPlaceholder') {
        throw new Unsupported('no config object found')
      }
      return resolveConfig(arg, body, seen)
    }
    case 'ArrowFunctionExpression':
    case 'FunctionExpression': {
      if (n.body.type !== 'BlockStatement') return resolveConfig(n.body, body, seen)
      const ret = n.body.body.find(s => s.type === 'ReturnStatement')
      return resolveConfig(ret?.type === 'ReturnStatement' ? ret.argument : null, body, seen)
    }
    case 'Identifier': {
      // `const config = {…}; export default config`
      if (seen.has(n.name)) throw new Unsupported(`circular reference to \`${n.name}\``)
      seen.add(n.name)
      for (const s of body) {
        const decl = s.type === 'ExportNamedDeclaration' ? s.declaration : s
        if (decl?.type !== 'VariableDeclaration') continue
        for (const d of decl.declarations) {
          if (d.id.type === 'Identifier' && d.id.name === n.name) return resolveConfig(d.init, body, seen)
        }
      }
      throw new Unsupported(`can't resolve \`${n.name}\``)
    }
    default:
      throw new Unsupported(`config is a ${n.type}, not an object literal`)
  }
}

function keyName(p: ObjectProperty): string | undefined {
  if (p.computed) return undefined
  if (p.key.type === 'Identifier') return p.key.name
  if (p.key.type === 'StringLiteral') return p.key.value
  return undefined
}

/** Find direct property `name` of `obj`; throws if it exists but isn't a plain `name: value`. */
function findProp(obj: ObjectExpression, name: string): { prop: ObjectProperty, idx: number } | undefined {
  for (const [idx, p] of obj.properties.entries()) {
    if (p.type === 'ObjectMethod' && keyName(p as unknown as ObjectProperty) === name) {
      throw new Unsupported(`\`${name}\` is a method`)
    }
    if (p.type !== 'ObjectProperty' || keyName(p) !== name) continue
    if (p.shorthand) throw new Unsupported(`\`${name}\` is a shorthand property`)
    return { prop: p, idx }
  }
  return undefined
}

function asObject(n: Node, name: string): ObjectExpression {
  const v = unwrap(n)
  if (v.type !== 'ObjectExpression') throw new Unsupported(`\`${name}\` is not an object literal`)
  return v
}

function asArray(n: Node, name: string): ArrayExpression {
  const v = unwrap(n)
  if (v.type !== 'ArrayExpression') throw new Unsupported(`\`${name}\` is not an array literal`)
  if (v.elements.some(e => e === null)) throw new Unsupported(`\`${name}\` has holes`)
  return v
}

function toList(n: ObjectExpression | ArrayExpression): List {
  const nodes = n.type === 'ObjectExpression' ? n.properties : n.elements
  return {
    open: n.start!,
    close: n.end! - 1,
    items: nodes.map(e => ({ start: e!.start!, end: e!.end! })),
  }
}

function stringValue(n: Node | null): string | undefined {
  if (!n) return undefined
  if (n.type === 'StringLiteral') return n.value
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0].value.cooked ?? undefined
  return undefined
}

interface Located {
  src: Source
  root: ObjectExpression
  optimizeDeps?: { prop: ObjectProperty, idx: number, obj: ObjectExpression }
  exclude?: { prop: ObjectProperty, idx: number, arr: ArrayExpression }
}

function locate(text: string): Located {
  let ast
  try {
    ast = parse(text, { sourceType: 'module', plugins: ['typescript'] })
  } catch (e) {
    throw new Unsupported(`parse error: ${(e as Error).message}`)
  }
  const src = new Source(text, (ast.comments ?? []).map(c => ({ start: c.start!, end: c.end! })))
  const body = ast.program.body
  const exp = body.find(s => s.type === 'ExportDefaultDeclaration')
  if (exp?.type !== 'ExportDefaultDeclaration') throw new Unsupported('no `export default`')
  const root = resolveConfig(exp.declaration as Expression, body)
  const located: Located = { src, root }
  const od = findProp(root, 'optimizeDeps')
  if (!od) return located
  const obj = asObject(od.prop.value, 'optimizeDeps')
  located.optimizeDeps = { ...od, obj }
  const ex = findProp(obj, 'exclude')
  if (ex) located.exclude = { ...ex, arr: asArray(ex.prop.value, 'optimizeDeps.exclude') }
  return located
}

function edit(content: string, fn: (loc: Located) => string | undefined): ViteEdit {
  try {
    const updated = fn(locate(content))
    if (updated === undefined || updated === content) return { content, status: 'unchanged' }
    return { content: updated, status: 'changed' }
  } catch (e) {
    if (e instanceof Unsupported) return { content, status: 'unsupported', reason: e.message }
    throw e
  }
}

/** Add `dep` to the config's `optimizeDeps.exclude`, creating the key/block as needed. */
export function addOptimizeDepsExclude(content: string, dep: string): ViteEdit {
  return edit(content, ({ src, root, optimizeDeps, exclude }) => {
    const lit = `${src.quote}${dep}${src.quote}`
    if (exclude) {
      if (exclude.arr.elements.some(e => stringValue(e) === dep)) return undefined
      return apply(content, appendItem(src, toList(exclude.arr), () => lit))
    }
    if (optimizeDeps) {
      return apply(content, appendItem(src, toList(optimizeDeps.obj), () => `exclude: [${lit}]`))
    }
    return apply(content, appendItem(
      src,
      toList(root),
      indent => indent === null
        ? `optimizeDeps: { exclude: [${lit}] }`
        : `optimizeDeps: {\n${indent}${src.unit}exclude: [${lit}],\n${indent}}`,
      true,
    ))
  })
}

/**
 * Remove `dep` from the config's `optimizeDeps.exclude`. If that empties the
 * array, the `exclude` key is removed; if that empties `optimizeDeps`, the block
 * is removed. Sibling keys and comments are preserved (a list whose only
 * remaining content is a comment is kept).
 */
export function removeOptimizeDepsExclude(content: string, dep: string): ViteEdit {
  return edit(content, ({ src, exclude }) => {
    if (!exclude) return undefined
    const idx = exclude.arr.elements.findIndex(e => stringValue(e) === dep)
    if (idx === -1) return undefined
    let text = apply(content, removeItem(src, toList(exclude.arr), idx))
    // Re-locate after each splice (offsets shift), then collapse emptied containers.
    let loc = locate(text)
    if (loc.exclude && loc.src.isEmpty(toList(loc.exclude.arr))) {
      text = apply(text, removeItem(loc.src, toList(loc.optimizeDeps!.obj), loc.exclude.idx))
      loc = locate(text)
    }
    if (loc.optimizeDeps && loc.src.isEmpty(toList(loc.optimizeDeps.obj))) {
      text = apply(text, removeItem(loc.src, toList(loc.root), loc.optimizeDeps.idx))
      loc = locate(text)
      const root = toList(loc.root)
      if (loc.src.isEmpty(root)) text = apply(text, { at: root.open + 1, del: root.close - root.open - 1 })
    }
    return text
  })
}
