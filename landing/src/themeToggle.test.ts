/**
 * LANDING-4 A3 — exactly one theme icon is visible, in both theme states,
 * on every page.
 *
 * This cannot be checked by grepping the stylesheet: both icons have a
 * `display` rule and the bug was which one WINS. So the test resolves the
 * cascade properly — it parses landing/styles.css, matches each selector
 * against a model of the real element tree, computes CSS specificity, and
 * takes the winner by (specificity, source order), which is what a browser
 * does.
 *
 * It was written before the fix and failed against the broken stylesheet,
 * which is the only reason to trust that it would catch the bug coming
 * back. The raw failure is in the review file.
 *
 * Run: npx tsx landing/src/themeToggle.test.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++
    console.log(`[Pass] ${label}`)
  } else {
    failed++
    console.log(`[FAIL] ${label}`)
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LANDING = path.resolve(__dirname, '..')
const CSS_PATH = path.join(LANDING, 'styles.css')
const PAGES = ['index.html', 'privacy.html']

// --- a very small CSS model ----------------------------------------------
// Only what these selectors actually use: descendant combinators over
// compounds of :root, [attr="value"], #id, .class and tag names.

interface Node {
  tag: string
  id?: string
  classes: string[]
  attrs: Record<string, string>
  isRoot?: boolean
}

interface Rule {
  selector: string
  declarations: Record<string, string>
  order: number
}

function parseCss(source: string): Rule[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: Rule[] = []
  let order = 0
  // Media blocks are flattened in deliberately: the responsive block only
  // touches font sizes, and flattening keeps a `display` rule hidden inside
  // one from silently escaping this check.
  const body = withoutComments.replace(/@media[^{]*\{/g, '').replace(/\}\s*\}/g, '}')
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = ruleRe.exec(body)) !== null) {
    const declarations: Record<string, string> = {}
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':')
      if (i === -1) continue
      declarations[decl.slice(0, i).trim()] = decl.slice(i + 1).trim()
    }
    for (const selector of m[1].split(',')) {
      const s = selector.trim()
      if (s !== '') rules.push({ selector: s, declarations, order: order++ })
    }
  }
  return rules
}

function specificity(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length
  const classes =
    (selector.match(/\.[\w-]+/g) ?? []).length +
    (selector.match(/\[[^\]]+\]/g) ?? []).length +
    (selector.match(/:(?!:)[\w-]+/g) ?? []).length
  const tags = (selector.replace(/[#.][\w-]+/g, '').replace(/\[[^\]]+\]/g, '').replace(/:(?!:)[\w-]+/g, '').match(/\b[a-z][\w-]*/g) ?? []).length
  return ids * 10000 + classes * 100 + tags
}

function matchesCompound(compound: string, node: Node): boolean {
  const id = compound.match(/#([\w-]+)/)
  if (id && node.id !== id[1]) return false
  for (const c of compound.match(/\.([\w-]+)/g) ?? []) {
    if (!node.classes.includes(c.slice(1))) return false
  }
  for (const a of compound.match(/\[[^\]]+\]/g) ?? []) {
    const parsed = a.slice(1, -1).match(/^([\w-]+)="?([^"\]]*)"?$/)
    if (!parsed) return false
    if (node.attrs[parsed[1]] !== parsed[2]) return false
  }
  if (/:root/.test(compound) && !node.isRoot) return false
  const tag = compound.replace(/[#.][\w-]+/g, '').replace(/\[[^\]]+\]/g, '').replace(/:(?!:)[\w-]+/g, '').trim()
  if (tag !== '' && tag !== '*' && tag !== node.tag) return false
  return true
}

/** chain is root-first; the selector's last compound must match the last node. */
function matches(selector: string, chain: Node[]): boolean {
  if (/[>+~]/.test(selector)) return false // none of ours use these
  const compounds = selector.trim().split(/\s+/)
  let i = chain.length - 1
  let j = compounds.length - 1
  if (!matchesCompound(compounds[j], chain[i])) return false
  j--
  i--
  while (j >= 0) {
    let found = false
    while (i >= 0) {
      if (matchesCompound(compounds[j], chain[i])) {
        found = true
        i--
        break
      }
      i--
    }
    if (!found) return false
    j--
  }
  return true
}

function resolveDisplay(rules: Rule[], chain: Node[]): string {
  let best: { spec: number; order: number; value: string } | null = null
  for (const rule of rules) {
    if (rule.declarations['display'] === undefined) continue
    if (!matches(rule.selector, chain)) continue
    const spec = specificity(rule.selector)
    if (best === null || spec > best.spec || (spec === best.spec && rule.order > best.order)) {
      best = { spec, order: rule.order, value: rule.declarations['display'] }
    }
  }
  return best === null ? 'inline' : best.value
}

function chainFor(theme: string, iconClass: string): Node[] {
  return [
    { tag: 'html', classes: [], attrs: { 'data-theme': theme }, isRoot: true },
    { tag: 'body', classes: [], attrs: {} },
    { tag: 'div', classes: ['navr'], attrs: {} },
    { tag: 'button', id: 'theme-toggle', classes: [], attrs: {} },
    { tag: 'svg', classes: [iconClass], attrs: {} },
  ]
}

const css = fs.readFileSync(CSS_PATH, 'utf8')
const rules = parseCss(css)
assert(rules.length > 50, `styles.css parsed into rules (${rules.length})`)

// --- the actual claim -----------------------------------------------------

for (const theme of ['dark', 'light']) {
  const sun = resolveDisplay(rules, chainFor(theme, 'icon-sun'))
  const moon = resolveDisplay(rules, chainFor(theme, 'icon-moon'))
  const visible = [sun !== 'none' ? 'sun' : null, moon !== 'none' ? 'moon' : null].filter(Boolean)

  console.log(`[info] data-theme="${theme}": icon-sun display=${sun}, icon-moon display=${moon}`)
  assert(
    visible.length === 1,
    `data-theme="${theme}": exactly ONE icon is visible (visible: ${visible.length === 0 ? 'none' : visible.join(' + ')})`,
  )
  const expected = theme === 'dark' ? 'sun' : 'moon'
  assert(
    visible.length === 1 && visible[0] === expected,
    `data-theme="${theme}": the visible icon is the ${expected} (offering to switch to ${theme === 'dark' ? 'light' : 'dark'})`,
  )
}

// A regression guard aimed at the exact cause: an id-scoped rule setting
// display on the svg would out-specify any class-scoped theme rule.
const idSvgDisplay = rules.filter(
  (r) => /#theme-toggle\s+svg\s*$/.test(r.selector) && r.declarations['display'] !== undefined,
)
assert(
  idSvgDisplay.length === 0,
  `no "#theme-toggle svg" rule sets display -- that is what out-specified the theme rules (found ${idSvgDisplay.length})`,
)

// --- the markup on every page --------------------------------------------

for (const page of PAGES) {
  const html = fs.readFileSync(path.join(LANDING, page), 'utf8')
  const toggles = (html.match(/id="theme-toggle"/g) ?? []).length
  const suns = (html.match(/class="icon-sun"/g) ?? []).length
  const moons = (html.match(/class="icon-moon"/g) ?? []).length
  assert(toggles === 1, `${page}: exactly one #theme-toggle (${toggles})`)
  assert(suns === 1 && moons === 1, `${page}: exactly one of each icon (sun ${suns}, moon ${moons})`)
  assert(
    !/class="icon-(sun|moon)"[^>]*style=/.test(html),
    `${page}: neither icon carries an inline style, so nothing beats the stylesheet`,
  )
}

const total = passed + failed
if (failed === 0) {
  console.log(`\nAll ${total} tests passed`)
} else {
  console.log(`\n${failed} of ${total} tests failed`)
  throw new Error(`${failed} tests failed`)
}
