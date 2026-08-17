/**
 * build-docs.mjs
 * Чете docs/kursova/*.md → генерира public/docs/index.html
 * Извиква се като част от `npm run build`.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';

const __dirname     = dirname(fileURLToPath(import.meta.url));
const ROOT          = join(__dirname, '..');
const DOCS_SRC      = join(ROOT, 'docs', 'kursova');
const SCREENSHOTS_SRC = join(ROOT, 'docs', 'screenshots');
const DOCS_OUT      = join(ROOT, 'public', 'docs');
const OUT_FILE      = join(DOCS_OUT, 'index.html');

// ── Strip YAML frontmatter (--- ... ---) from markdown ────────────────────
function stripFrontmatter(raw) {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return raw;
  return raw.slice(end + 4).trimStart();
}

// ── Collect & sort .md files (01, 02, 03 …) ───────────────────────────────
const mdFiles = readdirSync(DOCS_SRC)
  .filter(f => f.endsWith('.md'))
  .sort();

if (mdFiles.length === 0) {
  console.error('[build-docs] Няма .md файлове в docs/kursova/');
  process.exit(1);
}

// ── Convert each file ─────────────────────────────────────────────────────
const sections = mdFiles.map(file => {
  const raw  = stripFrontmatter(readFileSync(join(DOCS_SRC, file), 'utf8'));
  const body = marked.parse(raw);
  const id   = file.replace('.md', '');
  return `<section class="doc-section" id="${id}">\n${body}\n</section>`;
});

// ── Build TOC from first H1 of each file ─────────────────────────────────
const tocItems = mdFiles.map(file => {
  const raw    = stripFrontmatter(readFileSync(join(DOCS_SRC, file), 'utf8'));
  const match  = raw.match(/^#\s+(.+)$/m);
  const title  = match ? match[1].trim() : file.replace('.md', '');
  const id     = file.replace('.md', '');
  return `      <li><a href="#${id}">${title}</a></li>`;
}).join('\n');

// ── HTML template ─────────────────────────────────────────────────────────
const page = `<!DOCTYPE html>
<html lang="bg">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Постквантови криптографски схеми — Дипломна работа</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html { font-size: 16px; scroll-behavior: smooth; }
    body {
      font-family: Georgia, 'Times New Roman', 'DejaVu Serif', serif;
      line-height: 1.78;
      color: #1a1a1a;
      background: #fafaf8;
      padding: 2rem 1rem 5rem;
    }

    .page { max-width: 820px; margin: 0 auto; }

    /* ── Cover ── */
    .cover {
      text-align: center;
      padding: 3rem 0 2rem;
      border-bottom: 2px solid #333;
      margin-bottom: 2.5rem;
    }
    .cover h1 { font-size: 1.75rem; line-height: 1.3; margin: 1.75rem 0 .4rem; }
    .cover .sub { font-size: 0.95rem; color: #555; font-style: italic; }
    .cover .meta { margin-top: 1rem; font-size: 0.88rem; color: #444; }
    .cover-univ { font-size: 1.15rem; font-weight: 700; letter-spacing: .02em; text-align: center; }
    .cover-faculty { font-size: 1.02rem; font-weight: 700; margin-top: .25rem; text-align: center; }
    .cover-logo { width: 150px; height: auto; margin: 1.75rem auto 0; display: block; }
    .cover-ontopic { font-size: .95rem; color: #555; text-align: center; }
    .cover-title { font-size: 1.15rem; font-weight: 700; margin: .4rem auto 0; max-width: 34rem; line-height: 1.4; text-align: center; }
    .cover-authorblock { margin-top: 4rem; font-size: .92rem; color: #333; }
    .cover-authorblock p { margin: .25rem 0; text-align: right; }

    /* ── TOC ── */
    .toc {
      background: #f0ede8;
      border-left: 4px solid #555;
      padding: 1.25rem 1.5rem 1.25rem 1.75rem;
      margin-bottom: 2.5rem;
      border-radius: 0 4px 4px 0;
    }
    .toc h2 {
      font-size: 0.85rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: .07em;
      color: #333; margin-bottom: .65rem;
    }
    .toc ol { padding-left: 1.25rem; }
    .toc li { margin: .3rem 0; }
    .toc a { color: #2a5a9a; text-decoration: none; font-size: .92rem; }
    .toc a:hover { text-decoration: underline; }

    /* ── Sections ── */
    .doc-section {
      margin-bottom: 3.5rem;
      padding-bottom: 2rem;
      border-bottom: 1px solid #d0ccc5;
    }
    .doc-section:last-child { border-bottom: none; }

    /* ── Headings ── */
    h1 { font-size: 1.65rem; font-weight: 700; margin: 2rem 0 .9rem; line-height: 1.25; color: #111; }
    h2 { font-size: 1.25rem; font-weight: 700; margin: 1.9rem 0 .65rem; color: #1a1a1a;
         border-bottom: 1px solid #ccc; padding-bottom: .25rem; }
    h3 { font-size: 1.05rem; font-weight: 700; margin: 1.5rem 0 .45rem; color: #333; }
    h4 { font-size: .97rem; font-weight: 700; margin: 1rem 0 .35rem; color: #444; }

    /* ── Body text ── */
    p { margin: .7rem 0; text-align: justify; hyphens: auto; }
    strong { font-weight: 700; }
    em { font-style: italic; }
    hr { border: none; border-top: 1px solid #ccc; margin: 1.75rem 0; }

    /* ── Lists ── */
    ul, ol { padding-left: 1.75rem; margin: .65rem 0; }
    li { margin: .28rem 0; }

    /* ── Tables ── */
    .tw { overflow-x: auto; margin: 1.25rem 0; }
    table { border-collapse: collapse; width: 100%; font-size: .88rem;
            font-family: 'Segoe UI', system-ui, sans-serif; }
    th { background: #2e2e2e; color: #fff; padding: .5rem .75rem;
         text-align: left; font-weight: 600; }
    td { padding: .42rem .75rem; border-bottom: 1px solid #ddd; vertical-align: top; }
    tr:nth-child(even) td { background: #f5f3ef; }

    /* ── Code ── */
    code { font-family: Consolas, 'Courier New', monospace; font-size: .85rem;
           background: #eee; padding: .1em .35em; border-radius: 3px; }
    pre { background: #1e1e1e; color: #d4d4d4; padding: 1rem 1.25rem;
          border-radius: 6px; overflow-x: auto; margin: 1rem 0;
          font-size: .83rem; line-height: 1.5; }
    pre code { background: none; padding: 0; color: inherit; font-size: inherit; }

    /* ── Изображения (screenshots, диаграми) ── */
    .fig { margin: 1.5rem 0; text-align: center; }
    .fig img { max-width: 100%; height: auto; border: 1px solid #d0ccc5; border-radius: 6px;
               box-shadow: 0 2px 8px rgba(0,0,0,.08); }
    .fig-caption { font-size: .82rem; color: #666; margin-top: .5rem; font-style: italic; }

    /* ── Blockquote ── */
    blockquote { border-left: 4px solid #aaa; margin: 1.2rem 0;
                 padding: .7rem 1rem; background: #f5f3ef; color: #555; font-style: italic; }

    /* ── Print ── */
    @media print {
      body { background:#fff; color:#000; padding:0; font-size:11pt; }
      .cover { padding-top:1rem; }
      .toc { break-after:page; }
      .doc-section { page-break-after:always; }
      h1,h2,h3 { break-after:avoid; }
      a { color:#000; text-decoration:none; }
      .tw { overflow-x:visible; }
    }

    /* ── Dark mode ── */
    @media (prefers-color-scheme: dark) {
      body { background:#1a1816; color:#e4dfd8; }
      .cover { border-color:#666; }
      .cover .sub, .cover .meta { color:#999; }
      .cover-ontopic { color:#999; }
      .cover-authorblock { color:#ccc; }
      .cover-logo { filter: invert(1) hue-rotate(180deg); }
      .toc { background:#252220; border-color:#777; }
      .toc h2 { color:#bbb; }
      .toc a { color:#79aadb; }
      .doc-section { border-color:#333; }
      h1,h2,h3,h4 { color:#e4dfd8; }
      h2 { border-color:#444; }
      code { background:#2a2826; color:#e4dfd8; }
      th { background:#3a3836; }
      td { border-color:#333; }
      tr:nth-child(even) td { background:#212120; }
      blockquote { background:#252220; border-color:#666; color:#999; }
      hr { border-color:#333; }
      .fig img { border-color:#444; }
      .fig-caption { color:#999; }
    }
  </style>
</head>
<body>
<div class="page">

  <div class="cover">
    <p class="cover-univ">ТЕХНИЧЕСКИ УНИВЕРСИТЕТ – СОФИЯ</p>
    <p class="cover-faculty">ФАКУЛТЕТ ПО КОМПЮТЪРНИ СИСТЕМИ И ТЕХНОЛОГИИ</p>
    <img class="cover-logo" src="screenshots/assets/tu-sofia-logo.png" alt="Лого на Технически университет – София" />
    <h1>Дипломна работа</h1>
    <p class="cover-ontopic">на тема</p>
    <p class="cover-title">Постквантови криптографски схеми за защита на електронни документи</p>
    <div class="cover-authorblock">
      <p>Дипломант: Мариела Василева Тупарова</p>
      <p>Специалност: Компютърно и софтуерно инженерство</p>
      <p>Дипломен ръководител: маг. инж. Момчил Петков</p>
    </div>
  </div>

  <nav class="toc">
    <h2>Съдържание</h2>
    <ol>
${tocItems}
    </ol>
  </nav>

  ${sections.join('\n\n')}

</div>
</body>
</html>`;

// Wrap tables for horizontal scroll on mobile
const final = page
  .replace(/<table>/g, '<div class="tw"><table>')
  .replace(/<\/table>/g, '</table></div>');

mkdirSync(DOCS_OUT, { recursive: true });
writeFileSync(OUT_FILE, final, 'utf8');

// Ръчно рекурсивно копиране (не fs.cpSync — на тази Node/Windows комбинация
// с кирилски път cpSync крашва процеса без грешка, вж. commit история).
function copyDirRecursive(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

if (existsSync(SCREENSHOTS_SRC)) {
  copyDirRecursive(SCREENSHOTS_SRC, join(DOCS_OUT, 'screenshots'));
  console.log('[build-docs] ✅ Копирани screenshots/диаграми в public/docs/screenshots');
}

console.log(`[build-docs] ✅ Записан ${OUT_FILE} (${mdFiles.length} файла)`);