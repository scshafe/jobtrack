'use strict';

// latex-preview.js — best-effort server-side LaTeX -> HTML preview for the
// read-only web UI (Cole's request, 2026-08-04).
//
// The AUTHORITATIVE render of a material is the digest-pinned PDF produced by
// the fixed Docker renderer; the web UI embeds that PDF when one exists. This
// module covers the other case — revisions (rough drafts, unreviewed heads)
// that have no PDF yet — with an APPROXIMATE typeset preview via latex.js,
// generated on the server so the surface stays JavaScript-free for clients.
//
// Honesty rules:
//   * The preview is labeled approximate and never replaces the PDF or the
//     immutable source (both stay on the page).
//   * A small NORMALIZATION pass strips pure page-styling commands latex.js
//     cannot model (\setlength, \vspace, \pagestyle, geometry options) and
//     inlines simple \newenvironment definitions. Content is never altered.
//   * Any parse failure degrades gracefully to {ok:false, reason} — the page
//     then shows the source only, exactly as before this feature.
//
// latex.js needs a DOM; a single jsdom window is installed as the global
// document only for the synchronous duration of a parse, then restored.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_PREVIEW_SOURCE_BYTES = 256 * 1024;
const CACHE_LIMIT = 128;

/** @type {Map<string, {ok: boolean, html?: string, reason?: string}>} */
const cache = new Map();

let engine = null;
function loadEngine() {
  if (engine) return engine;
  const { parse, HtmlGenerator } = require('latex.js');
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  engine = { parse, HtmlGenerator, dom };
  return engine;
}

/**
 * Strip page-styling commands latex.js cannot model and inline simple
 * `\newenvironment{name}{begin}{end}` definitions (usages reduce to the base
 * environment). Documented approximation for PREVIEW purposes only.
 * @param {string} tex
 */
function normalizeForPreview(tex) {
  let out = String(tex);
  const environments = [];
  out = out.replace(
    /\\newenvironment\{([^}]+)\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g,
    (match, name, begin, end) => {
      environments.push({ name, begin, end });
      return '';
    }
  );
  for (const environment of environments) {
    out = out.split(`\\begin{${environment.name}}`).join(environment.begin)
      .split(`\\end{${environment.name}}`).join(environment.end);
  }
  return out
    .replace(/\\setlength\{[^}]*\}\{[^}]*\}/g, '')
    .replace(/\\pagestyle\{[^}]*\}/g, '')
    .replace(/\\vspace\*?\{[^}]*\}/g, '')
    .replace(/\\hfill/g, '\\quad ');
}

/**
 * Render LaTeX source to approximate HTML.
 * @param {string} content
 * @returns {{ok: true, html: string} | {ok: false, reason: string}}
 */
function renderLatexPreview(content) {
  const source = String(content || '');
  if (!source.trim()) return { ok: false, reason: 'No inline content stored.' };
  if (Buffer.byteLength(source, 'utf8') > MAX_PREVIEW_SOURCE_BYTES) {
    return { ok: false, reason: 'Source too large for inline preview.' };
  }
  const key = crypto.createHash('sha256').update(source).digest('hex');
  const cached = cache.get(key);
  if (cached) return cached;

  let result;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  try {
    const { parse, HtmlGenerator, dom } = loadEngine();
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    const generator = new HtmlGenerator({ hyphenate: false });
    parse(normalizeForPreview(source), { generator });
    const root = generator.domFragment().firstElementChild;
    const html = root ? root.outerHTML : '';
    result = html.trim()
      ? { ok: true, html }
      : { ok: false, reason: 'Preview produced no output.' };
  } catch (error) {
    result = { ok: false, reason: `latex.js could not parse this document: ${String(error && error.message || error).slice(0, 300)}` };
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }

  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}

let stylesheet = null;
/**
 * The latex.js stylesheet (base + article), scoped for inlining: webfont
 * imports are dropped (the UI's CSP allows no font loading) and a system
 * serif stack substitutes for Computer Modern.
 */
function latexPreviewStylesheet() {
  if (stylesheet !== null) return stylesheet;
  try {
    const dist = path.dirname(require.resolve('latex.js'));
    const base = fs.readFileSync(path.join(dist, 'css', 'base.css'), 'utf8');
    const article = fs.readFileSync(path.join(dist, 'css', 'article.css'), 'utf8');
    stylesheet = `${base}\n${article}`
      .replace(/@import[^;]+;/g, '')
      .replace(/font-family:\s*"Computer Modern[^;]*;/g, 'font-family: Georgia, "Times New Roman", serif;')
      + '\n.latexjs-preview{background:#fff;color:#111;border-radius:6px;padding:24px 28px;overflow-x:auto;}'
      + '\n.latexjs-preview .body{margin:0 auto;max-width:52rem;}';
  } catch {
    stylesheet = '.latexjs-preview{background:#fff;color:#111;padding:24px 28px;}';
  }
  return stylesheet;
}

module.exports = { renderLatexPreview, normalizeForPreview, latexPreviewStylesheet, MAX_PREVIEW_SOURCE_BYTES };
