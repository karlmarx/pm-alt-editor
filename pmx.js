#!/usr/bin/env node
'use strict';
/*
 * pmx — fix Postman collection scripts without ever hand-editing the collection JSON.
 *
 *   unpack   collection.json  ->  one plain .js file per script (LF, no JSON escaping)
 *   pack     edited .js files ->  spliced back into the ORIGINAL bytes of the collection
 *                                 (only changed lines differ; whitespace-only edits are dropped)
 *   test     pack + run newman + print a short failure digest that points at file:line
 *   digest   turn a newman / Jenkins console log into the same short digest
 *   sync     copy an edit to identical copies of the same code in other requests
 *   view     write a static, read-only HTML page showing the diff of your edits
 *   loop     deterministic fix loop: test -> small model edits -> test ... until green
 *
 * Zero dependencies except `newman` (only needed for `test` / `loop`).
 * Run every command from the repository root.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { spawnSync, spawn } = require('child_process');
const { pathToFileURL } = require('url');

const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const die = (msg, code = 2) => { console.error('pmx: ' + msg); process.exit(code); };
const rel = p => path.relative(process.cwd(), p).split(path.sep).join('/') || '.';
const stripBom = s => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);
const readJson = f => JSON.parse(stripBom(fs.readFileSync(f, 'utf8')));
const SELF = 'node ' + (rel(__filename).includes(' ') ? JSON.stringify(rel(__filename)) : rel(__filename));

function readStrict(file) {
  const buf = fs.readFileSync(file);
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) die(`${rel(file)} is not valid UTF-8 - refusing to touch it`);
  return text;
}
/* Write through a temporary file with a random name, created with "wx" (fail if anything is already there), then rename.
 * A branch therefore cannot plant a link at a known temp path, and the rename replaces a link instead of writing through it. */
function writeAtomic(file, text) {
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.pmx-tmp`;
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  fs.renameSync(tmp, file);
}

/* ───────────────────────── JSON position scanner ─────────────────────────
 * Finds the byte span of every `"script": { "exec": ... }` value so we can splice
 * new content into the original text and leave every other byte untouched. */
function scanExec(text) {
  const spans = new Map();
  let i = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  const fail = m => { throw new Error(`JSON scan error at offset ${i}: ${m}`); };
  const ws = () => { for (;;) { const c = text.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; } };
  const str = () => {
    if (text[i] !== '"') fail('expected a string');
    i++;
    for (;;) {
      const c = text[i];
      if (c === undefined) fail('unterminated string');
      if (c === '\\') i += 2; else if (c === '"') { i++; return; } else i++;
    }
  };
  const isExec = p => p.length >= 2 && p[p.length - 1] === 'exec' && p[p.length - 2] === 'script';
  const value = p => {
    ws();
    const start = i, c = text[i];
    if (c === '{') {
      i++; ws();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws(); const ks = i; str(); const key = JSON.parse(text.slice(ks, i));
        ws(); if (text[i] !== ':') fail('expected ":"'); i++;
        p.push(key); value(p); p.pop();
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return; }
        fail('expected "," or "}"');
      }
    } else if (c === '[') {
      const elems = [];
      i++; ws();
      if (text[i] === ']') i++;
      else for (let n = 0; ; n++) {
        ws(); const es = i;
        p.push(n); value(p); p.pop();
        elems.push([es, i]);
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; break; }
        fail('expected "," or "]"');
      }
      if (isExec(p)) spans.set(p.join('/'), { kind: 'array', start, end: i, elems });
    } else if (c === '"') {
      str();
      if (isExec(p)) spans.set(p.join('/'), { kind: 'string', start, end: i, elems: [] });
    } else {
      const re = /-?[0-9.eE+-]+|true|false|null/y; re.lastIndex = i;
      const m = re.exec(text); if (!m) fail('unexpected token');
      i += m[0].length;
    }
  };
  value([]);
  ws();
  if (i !== text.length) fail('trailing content');
  return spans;
}
function decodeSpan(text, span) {
  if (span.kind === 'string') return { lines: JSON.parse(text.slice(span.start, span.end)).split('\n'), tok: new Map() };
  const tok = new Map();
  const lines = span.elems.map(([a, b]) => {
    const raw = text.slice(a, b), v = JSON.parse(raw);
    if (typeof v !== 'string') throw new Error('exec element is not a string');
    if (!tok.has(v)) tok.set(v, raw);
    return v;
  });
  return { lines, tok };
}
function detectFormat(text) {
  const m = /\n([ \t]+)\S/.exec(text);
  return { nl: text.includes('\r\n') ? '\r\n' : '\n', unit: m ? m[1] : '' };
}
function encodeSpan(text, span, lines, tok, fmt) {
  if (span.kind === 'string') return JSON.stringify(lines.join('\n'));
  if (!lines.length) return '[]';
  let open, between, close;
  if (span.elems.length) {
    open = text.slice(span.start + 1, span.elems[0][0]);
    close = text.slice(span.elems[span.elems.length - 1][1], span.end - 1);
    between = span.elems.length > 1 ? text.slice(span.elems[0][1], span.elems[1][0]) : ',' + open;
  } else if (!fmt.unit) { open = ''; between = ','; close = ''; } else {
    const ls = text.lastIndexOf('\n', span.start) + 1;
    const ind = /^[ \t]*/.exec(text.slice(ls, span.start))[0];
    open = fmt.nl + ind + fmt.unit; between = ',' + open; close = fmt.nl + ind;
  }
  return '[' + open + lines.map(l => tok.get(l) || JSON.stringify(l)).join(between) + close + ']';
}
const skeleton = (text, spans) => {
  let out = '', at = 0;
  for (const s of [...spans.values()].sort((a, b) => a.start - b.start)) { out += text.slice(at, s.start) + '\u0000'; at = s.end; }
  return out + text.slice(at);
};

/* ───────────────────────── collection tree helpers ───────────────────────── */
const rootOf = json => (json.collection && !json.item ? { root: json.collection, prefix: ['collection'] } : { root: json, prefix: [] });
function walkItems(root, prefix, fn) {
  const rec = (node, p, names) => (node.item || []).forEach((child, i) => {
    if (!child || typeof child !== 'object') return;
    const cp = p.concat('item', i), cn = names.concat(child.name == null ? `item${i}` : String(child.name));
    fn(child, cp, cn);
    if (Array.isArray(child.item)) rec(child, cp, cn);
  });
  rec(root, prefix, []);
}
const safe = s => String(s).replace(/[^A-Za-z0-9.]+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 70).replace(/[_.]+$/, '') || '_';
const normName = s => String(s).replace(/\s+/g, ' ').trim();

/* ───────────────────────── line diff + merge ───────────────────────── */
function diffOps(a, b) {
  const n = a.length, m = b.length, ops = [];
  let s = 0; while (s < n && s < m && a[s] === b[s]) s++;
  let e = 0; while (e < n - s && e < m - s && a[n - 1 - e] === b[m - 1 - e]) e++;
  for (let k = 0; k < s; k++) ops.push(['=', k, k]);
  const N = n - s - e, M = m - s - e;
  if (N && M && N * M <= 4e7) {
    const W = M + 1, t = new Uint32Array((N + 1) * W);
    for (let x = N - 1; x >= 0; x--) for (let y = M - 1; y >= 0; y--) {
      t[x * W + y] = a[s + x] === b[s + y] ? t[(x + 1) * W + y + 1] + 1 : Math.max(t[(x + 1) * W + y], t[x * W + y + 1]);
    }
    let x = 0, y = 0;
    while (x < N && y < M) {
      if (a[s + x] === b[s + y]) { ops.push(['=', s + x, s + y]); x++; y++; }
      else if (t[(x + 1) * W + y] >= t[x * W + y + 1]) ops.push(['-', s + x++]);
      else ops.push(['+', s + y++]);
    }
    while (x < N) ops.push(['-', s + x++]);
    while (y < M) ops.push(['+', s + y++]);
  } else {
    for (let x = 0; x < N; x++) ops.push(['-', s + x]);
    for (let y = 0; y < M; y++) ops.push(['+', s + y]);
  }
  for (let k = 0; k < e; k++) ops.push(['=', n - e + k, m - e + k]);
  return ops;
}
const stripWs = l => l.replace(/\s+/g, '');
const trailingBlank = arr => { let k = 0; while (k < arr.length && arr[arr.length - 1 - k].trim() === '') k++; return k; };

/* orig = decoded exec lines exactly as stored (may end in \r); curText = edited .js file.
 * Unchanged lines keep their ORIGINAL bytes. Whitespace-only edits are dropped unless keepWs. */
function mergeScript(orig, curText, opt) {
  const origN = orig.map(l => l.replace(/\r$/, ''));
  let cur = curText.split('\n').map(l => l.replace(/\r$/, ''));
  if (!orig.length && !curText.trim()) cur = [];
  if (!opt.keepWs) cur = cur.slice(0, cur.length - trailingBlank(cur)).concat(origN.slice(origN.length - trailingBlank(origN)));
  if (origN.length === cur.length && origN.every((l, k) => l === cur[k])) return { changed: false, lines: orig, origN, cur, ops: null, add: 0, del: 0, ws: 0 };
  const key = opt.keepWs ? (l => l) : stripWs;
  const ops = diffOps(origN.map(key), cur.map(key));
  const crCount = orig.filter(l => l.endsWith('\r')).length;
  const crlf = orig.length > 1 ? crCount > 0 && crCount * 2 >= orig.length - 1 : !!opt.defaultCrlf;
  const lastHadCR = orig.length > 0 && orig[orig.length - 1].endsWith('\r');
  const out = []; let add = 0, del = 0, wsIgnored = 0;
  for (const op of ops) {
    if (op[0] === '=') { out.push({ oi: op[1] }); if (origN[op[1]] !== cur[op[2]]) wsIgnored++; }
    else if (op[0] === '+') { out.push({ line: cur[op[1]] }); add++; }
    else del++;
  }
  const lines = out.map((o, idx) => {
    const last = idx === out.length - 1;
    if (o.line !== undefined) return o.line + (crlf && (!last || lastHadCR) ? '\r' : '');
    const raw = orig[o.oi], wasLast = o.oi === orig.length - 1;
    if (!crlf || wasLast === last) return raw;
    return raw.replace(/\r$/, '') + (!last || lastHadCR ? '\r' : '');
  });
  const changed = lines.length !== orig.length || lines.some((l, k) => l !== orig[k]);
  return { changed, lines, origN, cur, ops, add, del, ws: wsIgnored };
}

/* ───────────────────────── context / config ───────────────────────── */
function parseArgs(argv) {
  const BOOL = new Set(['force', 'keep-whitespace', 'allow-test-removal', 'failed', 'all', 'rebaseline', 'no-sync', 'quiet', 'open', 'abort', 'reset', 'full', 'write', 'ui', 'tui', 'no-ui', 'add', 'no-open', 'help']);
  const o = { _: [], folder: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (BOOL.has(k)) { o[k] = true; continue; }
    const v = argv[++i];
    if (v === undefined) die(`--${k} needs a value`);
    if (k === 'folder') o.folder.push(v); else o[k] = v;
  }
  return o;
}
/* .pmx/ is replayed into the collection by `pack`, so it must be ours alone: a folder that git tracks (a merged branch
 * can deliver one) or that is really a link to somewhere else is refused. */
function guardWork(root) {
  const st = fs.lstatSync(root, { throwIfNoEntry: false });
  if (st && !st.isDirectory()) die(`${rel(root)} is not a plain folder. pmx keeps its working files there: remove it and run unpack again.`);
  const r = spawnSync('git', ['ls-files', '--', root], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) die(`${rel(root)}/ is tracked by git in this repository (a merged branch may have brought it in).\npmx will not pack from files it did not write itself. Add ${rel(root)}/ to .gitignore, take it out of git and delete it:\n  git rm -r -q --cached ${rel(root)} && rm -rf ${rel(root)}\nthen run unpack again.`);
}
const inside = (dir, file) => { const r = path.relative(dir, path.resolve(dir, String(file))); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
function getCtx(o, collectionArg) {
  const cfg = fs.existsSync('pmx.config.json') ? readJson('pmx.config.json') : {};
  const workRoot = path.resolve(cfg.workDir || '.pmx');
  guardWork(workRoot);
  let collection = collectionArg || o.collection || cfg.collection;
  if (!collection && fs.existsSync(workRoot)) {
    const mans = fs.readdirSync(workRoot).map(d => path.join(workRoot, d, 'manifest.json')).filter(f => fs.existsSync(f));
    if (mans.length === 1) {
      collection = readJson(mans[0]).collection;
      if (typeof collection !== 'string' || !inside(process.cwd(), collection)) die(`${rel(mans[0])} points at a collection outside this folder. It was not written by pmx here: run unpack again.`);
    }
    else if (mans.length > 1) die('several collections are unpacked - say which one with --collection <file>');
  }
  if (!collection) {                                    // last resort: the one collection file git tracks here
    const r = spawnSync('git', ['ls-files', '--', '*postman_collection*.json'], { encoding: 'utf8' });
    const found = r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
    if (found.length === 1) collection = found[0];
    else if (found.length > 1) die('several collections here - say which one with --collection <file>:\n  ' + found.join('\n  '));
  }
  if (!collection) die('which collection? pass --collection <file>, or put {"collection": "..."} in pmx.config.json');
  const name = path.basename(collection).replace(/(\.postman_collection)?\.json$/i, '');
  const work = path.join(workRoot, safe(name));
  return { cfg, collection: path.resolve(collection), work, scriptsDir: path.join(work, 'scripts'), f: n => path.join(work, n) };
}
function needManifest(ctx) {
  if (!fs.existsSync(ctx.f('manifest.json'))) die(`not unpacked yet. Run: ${SELF} unpack ${rel(ctx.collection)}`);
  const man = readJson(ctx.f('manifest.json'));
  for (const s of man.scripts || []) {
    if (!inside(ctx.scriptsDir, s.file)) die(`${rel(ctx.f('manifest.json'))} names a script file outside ${rel(ctx.scriptsDir)}/ (${JSON.stringify(s.file)}). It was not written by pmx: run unpack again.`);
  }
  return man;
}
const loadState = ctx => (fs.existsSync(ctx.f('state.json')) ? readJson(ctx.f('state.json')) : {});
const saveState = (ctx, st) => fs.writeFileSync(ctx.f('state.json'), JSON.stringify(st, null, 1));

/* ───────────────────────── unpack ───────────────────────── */
function cmdUnpack(o) {
  const ctx = getCtx(o, o._[0]);
  if (!fs.existsSync(ctx.collection)) die(`no such file: ${rel(ctx.collection)}`);
  const text = readStrict(ctx.collection);
  if (fs.existsSync(ctx.f('manifest.json')) && !o.force) {
    const pending = buildPack(ctx, {}).changes.filter(c => !c.noop).length;
    if (pending && sha(text) !== loadState(ctx).lastPackSha) die(`${pending} edited script(s) in ${rel(ctx.scriptsDir)} are not packed yet. Run \`${SELF} pack\` first, or re-run unpack with --force to discard them.`);
  }
  const json = JSON.parse(stripBom(text));
  const { root, prefix } = rootOf(json);
  const spans = scanExec(text);
  const scripts = [], items = [], used = new Set();
  const uniq = f => {                                   // "name.test.js" -> "name~2.test.js" when the name is taken; always a new string, whatever the event is called
    const cut = f.lastIndexOf('.', f.length - 4), at = cut > f.lastIndexOf('/') ? cut : f.length - 3;
    let r = f, n = 1;
    while (used.has(r.toLowerCase())) r = `${f.slice(0, at)}~${++n}${f.slice(at)}`;
    used.add(r.toLowerCase()); return r;
  };
  const addEvents = (node, p, dir, stem, names) => (Array.isArray(node.event) ? node.event : []).forEach((ev, ei) => {
    if (!ev || !ev.script || ev.script.exec == null) return;
    const key = p.concat('event', ei, 'script', 'exec').join('/');
    if (!spans.has(key)) return;
    scripts.push({ key, names, listen: ev.listen || 'script', dir, stem });
  });
  addEvents(root, prefix, [], '_collection', []);
  walkItems(root, prefix, (node, p, names) => {
    if (Array.isArray(node.item)) addEvents(node, p, names.map(safe), '_folder', names);
    else { items.push({ key: p.join('/'), names }); addEvents(node, p, names.slice(0, -1).map(safe), safe(names[names.length - 1]), names); }
  });
  fs.rmSync(ctx.scriptsDir, { recursive: true, force: true });
  fs.mkdirSync(ctx.scriptsDir, { recursive: true });
  let cr = 0, total = 0, skipped = 0;
  const kept = [];
  for (const s of scripts) {
    const { lines } = decodeSpan(text, spans.get(s.key));
    lines.forEach(l => { total++; if (l.endsWith('\r')) cr++; });
    const body = lines.map(l => l.replace(/\r$/, '')).join('\n');
    if (!body.trim() && !o.all) { skipped++; continue; }
    const file = uniq([...s.dir, `${s.stem}.${safe(s.listen)}.js`].join('/'));
    const abs = path.join(ctx.scriptsDir, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    kept.push({ key: s.key, file, names: s.names, listen: s.listen, lines: lines.length });
  }
  fs.writeFileSync(ctx.f('base.json'), text);
  for (const f of ['state.json', 'baseline.json', 'last-run.json', 'last-run.txt']) fs.rmSync(ctx.f(f), { force: true });
  const man = { version: 1, collection: rel(ctx.collection), baseSha: sha(text), crlf: cr * 2 > total, scripts: kept, items };
  fs.writeFileSync(ctx.f('manifest.json'), JSON.stringify(man, null, 1));
  console.log(`unpacked ${kept.length} scripts from ${items.length} requests -> ${rel(ctx.scriptsDir)}/` + (skipped ? `   (${skipped} empty scripts skipped; --all to include)` : ''));
  console.log(`find a script:  ${SELF} ls <part of request name>`);
  console.log(`next:           ${SELF} test        (or: ${SELF} digest <newman-or-jenkins-log.txt>)`);
}

function cmdLs(o) {
  const ctx = getCtx(o); const man = needManifest(ctx);
  const q = (o._[0] || '').toLowerCase();
  const rows = man.scripts.filter(s => !q || (s.file + ' ' + s.names.join(' / ')).toLowerCase().includes(q));
  rows.forEach(s => console.log(`${rel(path.join(ctx.scriptsDir, s.file))}   <- ${s.names.join(' / ') || '(collection)'} [${s.listen}, ${s.lines} lines]`));
  console.log(`${rows.length} script(s)`);
}

/* ───────────────────────── pack (+ static guards) ───────────────────────── */
function syntaxError(code, file) {
  try { new vm.Script('(async function(){' + code + '\n})', { filename: file }); return null; } // eslint-disable-line no-new
  catch (e) { return `${String(e.stack || '').split('\n')[0]}  ${e.name}: ${e.message}`; }
}
const countTests = code => (code.match(/\bpm\.test\s*\(|\btests\s*\[/g) || []).length;

function buildPack(ctx, opt) {
  const man = needManifest(ctx);
  const base = readStrict(ctx.f('base.json'));
  const spans = scanExec(base), fmt = detectFormat(base);
  const edits = [], changes = [], errors = [], states = [];
  for (const s of man.scripts) {
    const span = spans.get(s.key);
    if (!span) die('manifest does not match base.json - run unpack again');
    const { lines: orig, tok } = decodeSpan(base, span);
    const abs = path.join(ctx.scriptsDir, s.file);
    if (!fs.existsSync(abs)) { errors.push(`${rel(abs)}: file is missing. Bring it back with: ${SELF} restore ${s.file}`); continue; }
    const m = mergeScript(orig, fs.readFileSync(abs, 'utf8'), { keepWs: opt.keepWs, defaultCrlf: man.crlf });
    states.push({ s, abs, m });
    if (!m.changed) { if (m.ws) changes.push({ file: s.file, abs, add: 0, del: 0, ws: m.ws, noop: true }); continue; }
    const code = m.lines.map(l => l.replace(/\r$/, '')).join('\n');
    const syn = syntaxError(code, rel(abs));
    if (syn) errors.push('SYNTAX ERROR ' + syn);
    const before = countTests(m.origN.join('\n')), after = countTests(code);
    if (after < before && !opt.allowTestRemoval) errors.push(`${rel(abs)}: number of pm.test(...) calls dropped from ${before} to ${after}. Tests must not be removed. (A human can override with --allow-test-removal.)`);
    edits.push({ span, key: s.key, lines: m.lines, text: encodeSpan(base, span, m.lines, tok, fmt) });
    changes.push({ file: s.file, abs, add: m.add, del: m.del, ws: m.ws });
  }
  let out = base;
  for (const e of edits.slice().sort((a, b) => b.span.start - a.span.start)) out = out.slice(0, e.span.start) + e.text + out.slice(e.span.end);
  // self-check: valid JSON, nothing outside exec arrays moved, edited scripts decode to exactly what was intended
  JSON.parse(stripBom(out));
  const spans2 = scanExec(out);
  if (skeleton(base, spans) !== skeleton(out, spans2)) die('internal error: bytes outside script bodies changed - nothing written');
  for (const e of edits) {
    const got = decodeSpan(out, spans2.get(e.key)).lines;
    if (got.length !== e.lines.length || got.some((l, k) => l !== e.lines[k])) die(`internal error: ${e.key} did not round-trip - nothing written`);
  }
  return { man, out, changes, errors, states };
}
function printChanges(ctx, r) {
  const real = r.changes.filter(c => !c.noop);
  if (!real.length) console.log('no script changes');
  real.forEach(c => console.log(`  M ${rel(c.abs)}   +${c.add} -${c.del}`));
  const ws = r.changes.reduce((n, c) => n + c.ws, 0);
  if (ws) console.log(`  (${ws} whitespace-only line edit(s) ignored so the diff stays small; --keep-whitespace to keep them)`);
}
function doPack(ctx, o, quiet) {
  const r = buildPack(ctx, { keepWs: o['keep-whitespace'], allowTestRemoval: o['allow-test-removal'] });
  if (r.errors.length) {
    console.log('PACK REFUSED - fix these first (the collection file was NOT changed):');
    r.errors.forEach(e => console.log('  ' + e));
    process.exit(2);
  }
  const st = loadState(ctx);
  const onDisk = fs.existsSync(ctx.collection) ? readStrict(ctx.collection) : null;
  if (onDisk !== null && ![r.man.baseSha, st.lastPackSha].includes(sha(onDisk)) && !o.force) {
    die(`${rel(ctx.collection)} was changed by something other than pmx since unpack. Re-run unpack (your .js edits would be lost) or pack with --force to overwrite the file.`);
  }
  if (onDisk !== r.out) writeAtomic(ctx.collection, r.out);
  st.lastPackSha = sha(r.out); saveState(ctx, st);
  if (!quiet) { console.log(`packed -> ${rel(ctx.collection)}`); printChanges(ctx, r); printTwins(ctx, findTwins(r.states)); }
  return r;
}
function cmdRestore(o) {
  const ctx = getCtx(o); const man = needManifest(ctx);
  const base = readStrict(ctx.f('base.json')), spans = scanExec(base);
  const want = o._.map(f => f.split(path.sep).join('/'));
  const pick = man.scripts.filter(s => o.all || want.some(w => w === s.file || w.endsWith('/' + s.file) || rel(path.join(ctx.scriptsDir, s.file)) === w));
  if (!pick.length) die('nothing matched. Usage: restore <script file> | restore --all');
  for (const s of pick) {
    const abs = path.join(ctx.scriptsDir, s.file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, decodeSpan(base, spans.get(s.key)).lines.map(l => l.replace(/\r$/, '')).join('\n'));
  }
  console.log(`restored ${pick.length} script(s) to their unpacked state. Run \`${SELF} pack\` to update the collection file.`);
}

/* ───────────────────────── twins: same code in other requests ───────────────────────── */
function hunksOf(m) {
  const hunks = []; if (!m.ops) return hunks;
  const ops = m.ops;
  for (let i = 0; i < ops.length;) {
    if (ops[i][0] === '=') { i++; continue; }
    let j = i; while (j < ops.length && ops[j][0] !== '=') j++;
    const old = [], neu = [];
    for (let k = i; k < j; k++) (ops[k][0] === '-' ? old.push(m.origN[ops[k][1]]) : neu.push(m.cur[ops[k][1]]));
    const ctxB = [], ctxA = [];
    for (let k = i - 1; k >= 0 && ctxB.length < 3 && ops[k][0] === '='; k--) ctxB.unshift(m.cur[ops[k][2]]);
    for (let k = j; k < ops.length && ctxA.length < 3 && ops[k][0] === '='; k++) ctxA.push(m.cur[ops[k][2]]);
    const firstNew = ops.slice(i, j).find(x => x[0] === '+');
    hunks.push({ old, neu, ctxB, ctxA, line: (firstNew ? firstNew[1] : (ctxB.length ? ops[i - 1][2] + 1 : 0)) + 1 });
    i = j;
  }
  return hunks;
}
function findTwins(states) {
  const twins = [];
  const curOf = st => (st.m.ops ? st.m.cur : st.m.origN);
  const targets = states.map(st => ({ st, cur: curOf(st), keys: curOf(st).map(stripWs) }));
  for (const src of states) for (const h of hunksOf(src.m)) {
    const pat = [...h.ctxB, ...h.old, ...h.ctxA].map(stripWs);
    if (pat.filter(k => k.length >= 6).length < 2) continue;                 // context too generic to match safely
    const done = h.old.length ? null : [...h.ctxB, ...h.neu, ...h.ctxA].map(stripWs);   // an insertion: what a place looks like once it has the edit
    for (const t of targets) {
      for (let p = 0; p + pat.length <= t.keys.length; p++) {
        let ok = true;
        for (let q = 0; q < pat.length; q++) if (t.keys[p + q] !== pat[q]) { ok = false; break; }
        const from = p - (h.ctxB.length ? 0 : h.neu.length);
        if (ok && done && from >= 0 && done.every((k, q) => t.keys[from + q] === k)) continue;   // already there (the edited file itself, or synced earlier)
        if (ok) twins.push({ src, h, t, at: p + h.ctxB.length, ref: h.ctxB.length ? [h.ctxB[0], t.cur[p]] : h.ctxA.length ? [h.ctxA[0], t.cur[p + h.old.length]] : null });
      }
    }
  }
  return twins;
}
function printTwins(ctx, twins) {
  if (!twins.length) return;
  console.log(`TWIN CODE: ${twins.length} place(s) still contain the old version of code you just changed:`);
  twins.slice(0, 20).forEach(t => console.log(`  ${rel(t.t.st.abs)}:${t.at + 1}   (same block you edited at ${rel(t.src.abs)}:${t.h.line})`));
  console.log(`  -> copy your edit there automatically with: ${SELF} sync`);
}
function reindent(lines, ref) {
  if (!ref) return lines;
  const a = /^[ \t]*/.exec(ref[0])[0], b = /^[ \t]*/.exec(ref[1])[0];
  if (a === b || /\t/.test(a + b)) return lines;
  const d = b.length - a.length;
  return lines.map(l => (!l.trim() ? l : d > 0 ? ' '.repeat(d) + l : l.replace(new RegExp('^ {0,' + -d + '}'), '')));
}
function applyTwins(twins) {
  const byFile = new Map();
  twins.forEach(t => { if (!byFile.has(t.t.st.abs)) byFile.set(t.t.st.abs, []); byFile.get(t.t.st.abs).push(t); });
  let n = 0;
  for (const [abs, list] of byFile) {
    const cur = list[0].t.cur.slice();
    let floor = Infinity;
    for (const t of list.sort((a, b) => b.at - a.at)) {
      if (t.at + t.h.old.length + t.h.ctxA.length > floor) continue;         // overlaps an edit already applied below
      cur.splice(t.at, t.h.old.length, ...reindent(t.h.neu, t.ref));
      floor = t.at - t.h.ctxB.length; n++;
    }
    fs.writeFileSync(abs, cur.join('\n'));
  }
  return n;
}
function cmdSync(o) {
  const ctx = getCtx(o);
  const twins = findTwins(buildPack(ctx, { keepWs: o['keep-whitespace'], allowTestRemoval: true }).states);
  if (!twins.length) return console.log('no twin code found - nothing to sync');
  const n = applyTwins(twins);
  console.log(`synced ${n} block(s):`);
  [...new Set(twins.map(t => rel(t.t.st.abs)))].forEach(f => console.log('  M ' + f));
  console.log(`next: ${SELF} test --failed`);
}

/* ───────────────────────── failure digest ───────────────────────── */
const clip = (s, n) => (s.length <= n ? s : s.slice(0, Math.floor(n * 0.65)) + ` ...[${s.length - n} chars cut]... ` + s.slice(-Math.floor(n * 0.3)));
function arraysIn(s) {
  const out = []; const re = /\[[^[\]]*\]/g; let m;
  while ((m = re.exec(s))) {
    for (const cand of [m[0], m[0].replace(/'/g, '"')]) {
      try { const v = JSON.parse(cand); if (Array.isArray(v) && v.every(x => x === null || typeof x !== 'object')) { out.push(v); break; } } catch (e) { /* not JSON */ }
    }
  }
  return out;
}
function twoListHint(line) {
  const a = arraysIn(line); if (a.length !== 2) return null;
  const only1 = a[0].filter(x => !a[1].includes(x)), only2 = a[1].filter(x => !a[0].includes(x));
  if (!only1.length && !only2.length) return a[0].length === a[1].length && JSON.stringify(a[0]) !== JSON.stringify(a[1]) ? 'same members, different ORDER' : null;
  return `only in 1st list: ${JSON.stringify(only1)}   only in 2nd list: ${JSON.stringify(only2)}`;
}
function findTestLine(code, name) {
  const re = /pm\.test\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*([,+)]?)/g; let m, best = null;
  while ((m = re.exec(code))) {
    let lit = m[2].replace(/\\(.)/g, '$1'), dynamic = m[3] === '+';
    if (m[1] === '`' && lit.includes('${')) { lit = lit.slice(0, lit.indexOf('${')); dynamic = true; }
    const score = !dynamic && lit === name ? 1e6 : dynamic && lit.length >= 3 && name.startsWith(lit) ? lit.length : 0;
    if (score && (!best || score > best.score)) best = { score, line: code.slice(0, m.index).split('\n').length };
  }
  return best && best.line;
}
/* groups: [{ itemKey, title, tests: Map(name -> {n, errors: Map(msg -> n), isNew}), logs: [], urls: Map }] */
function renderDigest(ctx, man, d) {
  const L = [];
  const scope = d.scope ? `   [${d.scope}]` : '';
  if (!d.groups.length && !d.regressions.length) {
    L.push(`RESULT: PASS - ${d.stats.assertions} assertions, 0 failed${scope}`);
    return L.join('\n');
  }
  L.push(`RESULT: FAIL - ${d.stats.failed} of ${d.stats.assertions} assertions failed, in ${d.groups.length} request(s)${scope}`);
  for (const g of d.groups) {
    L.push('', `X ${g.title}`);
    const own = man.scripts.filter(s => g.itemKey && s.key.startsWith(g.itemKey + '/event/'));
    const anc = man.scripts.filter(s => g.itemKey && !own.includes(s) && g.itemKey.startsWith(s.key.replace(/\/?event\/\d+\/script\/exec$/, '')));
    const codeOf = s => { try { return fs.readFileSync(path.join(ctx.scriptsDir, s.file), 'utf8'); } catch (e) { return ''; } };
    for (const [name, t] of g.tests) {
      L.push(`  ${t.n}x ${t.kind === 'error' ? 'SCRIPT ERROR' : 'FAILED TEST'}: ${JSON.stringify(name)}${t.isNew ? '   <-- NEW: this passed before your edits' : ''}`);
      let where = null;
      for (const s of [...own, ...anc.reverse()]) { const ln = findTestLine(codeOf(s), name); if (ln) { where = `${rel(path.join(ctx.scriptsDir, s.file))}:${ln}`; break; } }
      if (where) L.push(`     edit -> ${where}`);
      const errs = [...t.errors].sort((a, b) => b[1] - a[1]);
      errs.slice(0, 8).forEach(([msg, n]) => { L.push(`     ${n}x ${clip(msg, 500)}`); const h = twoListHint(msg); if (h) L.push(`        hint: ${h}`); });
      if (errs.length > 8) L.push(`     ... ${errs.length - 8} more distinct messages`);
      const tally = new Map();
      if (errs.length > 1) errs.forEach(([msg, n]) => arraysIn(msg).forEach(a => a.forEach(v => tally.set(String(v), (tally.get(String(v)) || 0) + n))));
      if (tally.size > 1) L.push('     values across these failures: ' + [...tally].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([v, n]) => `${v} (x${n})`).join(' | '));
    }
    if (!own.length && !anc.length) L.push('  (could not map this request to an unpacked script - try: ' + SELF + ' ls <name>)');
    else L.push('  scripts for this request: ' + own.map(s => rel(path.join(ctx.scriptsDir, s.file))).join('  ') + (anc.length ? `   (+${anc.length} inherited folder/collection script(s))` : ''));
    if (g.urls && g.urls.size) L.push('  failing calls: ' + [...g.urls].slice(0, 6).map(([u, n]) => `${clip(u, 160)}${n > 1 ? ` (x${n})` : ''}`).join(' ; ') + (g.urls.size > 6 ? ` ; +${g.urls.size - 6} more` : ''));
    if (g.logs && g.logs.length) {
      L.push('  console output from the failing runs:');
      [...new Set(g.logs)].slice(0, 12).forEach(l => { L.push('     ' + clip(l, 600)); const h = twoListHint(l); if (h) L.push('        hint: ' + h); });
    }
  }
  if (d.regressions.length) {
    L.push('', 'TESTS THAT STOPPED RUNNING (they ran before your edits - a test must never disappear):');
    d.regressions.slice(0, 15).forEach(r => L.push('  ' + r));
  }
  return L.join('\n');
}

/* newman CLI / Jenkins console text -> digest data */
function parseNewmanLog(text) {
  const lines = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '').split('\n');
  const fails = [];
  const h = lines.findIndex(l => /^\s*#\s+failure\s+detail\s*$/.test(l));
  if (h >= 0) {
    let cur = null;
    for (let i = h + 1; i < lines.length; i++) {
      const l = lines[i], m = /^\s{0,3}(\d+)\.\s{1,4}(\S+)\s+(.*?)\s*$/.exec(l);
      if (m) { cur = { type: m[2], title: m[3], msg: [], at: '', inside: '' }; fails.push(cur); continue; }
      if (!l.trim()) continue;
      if (!/^\s{4,}/.test(l)) break;
      if (!cur) continue;
      const t = l.trim(); let x;
      if ((x = /^inside "(.*)"$/.exec(t))) cur.inside = x[1];
      else if (!cur.at && (x = /^at (.*(?:script|request|assertion).*)$/.exec(t))) cur.at = x[1];
      else if (!cur.at) cur.msg.push(t);
    }
  }
  const st = /assertions\s*[|│]\s*(\d+)\s*[|│]\s*(\d+)/.exec(lines.join('\n'));
  return { fails, stats: st ? { assertions: +st[1], failed: +st[2] } : { assertions: '?', failed: fails.length } };
}
function cmdDigest(o) {
  const ctx = getCtx(o); const man = needManifest(ctx);
  const src = o._[0];
  if (!src) die('usage: digest <newman-or-jenkins-console-log.txt>   (use - for stdin)');
  const parsed = parseNewmanLog(fs.readFileSync(src === '-' ? 0 : src, 'utf8'));
  if (!parsed.fails.length && parsed.stats.assertions === '?') die('no newman summary found in that log (looked for the "#  failure  detail" table)', 1);
  const byPath = new Map();
  man.items.forEach(it => { const k = normName(it.names.join(' / ')); if (!byPath.has(k)) byPath.set(k, it); });
  const groups = new Map();
  for (const f of parsed.fails) {
    const it = byPath.get(normName(f.inside));
    const gk = it ? it.key : 'name:' + f.inside;
    if (!groups.has(gk)) groups.set(gk, { itemKey: it ? it.key : null, title: f.inside || '(collection)', tests: new Map(), logs: [], urls: new Map() });
    const isAssert = /^assertion/.test(f.at);
    const name = isAssert ? f.title : `${f.type} at ${f.at || 'script'}`;
    const msg = isAssert ? (f.msg.join(' ') || f.type) : `${f.type}: ${f.title}`;
    const tests = groups.get(gk).tests;
    if (!tests.has(name)) tests.set(name, { n: 0, errors: new Map(), kind: isAssert ? 'test' : 'error' });
    const t = tests.get(name); t.n++; t.errors.set(msg, (t.errors.get(msg) || 0) + 1);
  }
  const d = { stats: parsed.stats, groups: [...groups.values()], regressions: [], scope: 'from log file' };
  const out = renderDigest(ctx, man, d);
  finishRun(ctx, d, out, false);
}
function finishRun(ctx, d, out, ranNewman) {
  const failedItems = d.groups.map(g => g.itemKey).filter(Boolean);
  const pass = !d.groups.length && !d.regressions.length;
  fs.writeFileSync(ctx.f('last-run.txt'), out + '\n');
  fs.writeFileSync(ctx.f('last-run.json'), JSON.stringify({ pass, partial: !!d.partial, stats: d.stats, failedItems }, null, 1));
  console.log(out);
  console.log('');
  if (pass && d.partial) console.log(`NEXT: the re-run of the previously failing request(s) is green. Confirm with the full run: ${SELF} test`);
  else if (pass) console.log(`NEXT: done. Review your edits (\`${SELF} view\` writes a visual diff; \`git diff\` on the collection file should be small) and commit.`);
  else console.log(`NEXT: edit the .js file(s) named above (smallest change), then run: ${SELF} test --failed` + (ranNewman ? '' : `   (or push and re-run this digest on the new log)`));
  return pass;
}

/* ───────────────────────── newman runner ───────────────────────── */
function loadNewman() {
  const tries = [process.cwd(), __dirname];
  for (let pass = 0; pass < 2; pass++) {
    for (const t of tries) { try { return require(require.resolve('newman', { paths: [t] })); } catch (e) { /* keep looking */ } }
    if (pass === 0) { try { tries.push(String(spawnSync('npm root -g', { shell: true, encoding: 'utf8' }).stdout || '').trim()); } catch (e) { /* no npm */ } }
  }
  die('cannot find the "newman" package. Install it once: npm i -D newman');
}
const interp = v => (typeof v === 'string' ? v.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] || '')
  : Array.isArray(v) ? v.map(interp) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, interp(x)])) : v);
const fmtArg = a => { if (typeof a === 'string') return a; try { return JSON.stringify(a); } catch (e) { return String(a); } };

function runNewman(ctx, man, o) {
  const newman = loadNewman();
  const json = JSON.parse(stripBom(readStrict(ctx.collection)));
  const { root, prefix } = rootOf(json);
  const byId = new Map();
  walkItems(root, prefix, (node, p, names) => { if (!node.id) node.id = 'pmx-' + p.join('.'); byId.set(node.id, { key: p.join('/'), names, folder: Array.isArray(node.item) }); });
  let partial = false, scope = 'full run';
  if (o.failed) {
    const last = fs.existsSync(ctx.f('last-run.json')) ? readJson(ctx.f('last-run.json')) : null;
    if (!last || !last.failedItems.length) console.log('(no failed requests recorded from a previous run/digest - doing a full run)');
    else {
      const want = new Set(last.failedItems), always = new Set((ctx.cfg.alwaysRun || []).map(normName));
      const prune = node => { node.item = node.item.filter(ch => { if (always.has(normName(ch.name))) return true; if (Array.isArray(ch.item)) { prune(ch); return ch.item.length > 0; } return want.has(byId.get(ch.id).key); }); };
      prune(root); partial = true; scope = `partial run: ${want.size} previously failing request(s)`;
    }
  }
  const options = Object.assign({ reporters: [] }, interp(ctx.cfg.newman || {}), { collection: json });
  if (o.folder.length) { options.folder = o.folder; partial = true; scope = `partial run: folder ${o.folder.join(', ')}`; }
  const execs = new Map(), asserts = [];
  const E = c => { const r = c && c.ref; if (!execs.has(r)) execs.set(r, { logs: [] }); return execs.get(r); };
  return new Promise(resolve => {
    const em = newman.run(options, (err, summary) => {
      if (err) die('newman could not run: ' + (err.message || err), 1);
      resolve({ summary, execs, asserts, byId, partial, scope });
    });
    em.on('beforeItem', (e, a) => { if (a && a.item) E(a.cursor).id = a.item.id; });
    const own = a => a && a.request && !(a.cursor && a.cursor.scriptId);         // the request itself, not one a script made with pm.sendRequest
    em.on('beforeRequest', (e, a) => { const x = E(a && a.cursor); if (own(a) && !x.url) x.url = `${a.request.method} ${a.request.url.toString()}`; });
    em.on('request', (e, a) => { const x = E(a && a.cursor); if (own(a) && a.response && x.status === undefined && x.url === `${a.request.method} ${a.request.url.toString()}`) x.status = a.response.code; });
    em.on('console', (e, a) => { if (!a || !a.messages) return; const line = a.messages.map(fmtArg).join(' '); if (!/is deprecated\. Use /.test(line)) E(a.cursor).logs.push(line); });
    em.on('assertion', (e, a) => { asserts.push({ id: a.item && a.item.id, ref: a.cursor && a.cursor.ref, name: String(a.assertion), skipped: !!a.skipped, error: e ? (e.message || e.name || 'failed') : null }); });
  });
}
async function runTest(ctx, o) {
  const pk = doPack(ctx, o, true);
  const man = pk.man;
  const r = await runNewman(ctx, man, o);
  const groups = new Map();
  const G = (id, ref) => {
    const info = r.byId.get(id) || {}; const gk = info.key || 'collection';
    if (!groups.has(gk)) groups.set(gk, { itemKey: info.key || null, title: (info.names || ['(collection level)']).join(' / '), tests: new Map(), logs: [], urls: new Map(), refs: new Set() });
    const g = groups.get(gk);
    if (ref !== undefined && !g.refs.has(ref)) {
      g.refs.add(ref); const x = r.execs.get(ref);
      if (x) { g.logs.push(...x.logs); if (x.url) { const u = x.url + (x.status ? ` -> ${x.status}` : ''); g.urls.set(u, (g.urls.get(u) || 0) + 1); } }
    }
    return g;
  };
  const add = (g, name, msg, kind) => { if (!g.tests.has(name)) g.tests.set(name, { n: 0, errors: new Map(), kind }); const t = g.tests.get(name); t.n++; t.errors.set(msg, (t.errors.get(msg) || 0) + 1); };
  const counts = {};                                   // "itemKey\u001fname" -> {n, failed}
  const ran = new Set();
  for (const x of r.execs.values()) if (x.id && r.byId.get(x.id)) ran.add(r.byId.get(x.id).key);
  for (const a of r.asserts) {
    const info = r.byId.get(a.id) || {}; const ck = (info.key || '') + '\u001f' + a.name;
    counts[ck] = counts[ck] || { n: 0, failed: 0 }; counts[ck].n++;
    if (a.error && !a.skipped) { counts[ck].failed++; add(G(a.id, a.ref), a.name, a.error, 'test'); }
  }
  for (const f of r.summary.run.failures || []) {
    if (/^assertion/.test(f.at || '')) continue;
    const e = f.error || {};
    add(G(f.source && f.source.id, f.cursor && f.cursor.ref), `${e.name || 'Error'} at ${f.at || 'script'}`, `${e.name || 'Error'}: ${e.message || ''}`, 'error');
  }
  // baseline: what ran / passed before any edit in this session
  const regressions = [];
  const bf = ctx.f('baseline.json');
  if (o.rebaseline) fs.rmSync(bf, { force: true });
  if (fs.existsSync(bf)) {
    const base = readJson(bf);
    for (const [ck, b] of Object.entries(base.counts)) {
      const [ik, name] = ck.split('\u001f'); const c = counts[ck] || { n: 0, failed: 0 };
      if ((r.partial ? ran.has(ik) : true) && c.n < b.n) {
        const it = man.items.find(i => i.key === ik);
        regressions.push(`${it ? it.names.join(' / ') : '(collection)'} :: ${JSON.stringify(name)} ran ${b.n}x before, ${c.n}x now`);
      }
      if (b.failed === 0 && c.failed > 0) for (const g of groups.values()) if (g.itemKey === ik && g.tests.has(name)) g.tests.get(name).isNew = true;
    }
  } else if (!r.partial) fs.writeFileSync(bf, JSON.stringify({ counts }));
  const s = r.summary.run.stats || {};
  const d = { stats: { assertions: (s.assertions || {}).total || 0, failed: (s.assertions || {}).failed || 0 }, groups: [...groups.values()], regressions, scope: r.scope, partial: r.partial };
  const out = renderDigest(ctx, man, d);
  const pass = finishRun(ctx, d, out, true);
  const real = pk.changes.filter(c => !c.noop);
  if (real.length) { console.log(`your edits so far (${real.length} script(s)):`); printChanges(ctx, pk); }
  printTwins(ctx, findTwins(pk.states));
  return { pass, partial: r.partial, pk };
}

/* ───────────────────────── loop: deterministic harness around a small model ───────────────────────── */
function fixPrompt(ctx, why, digest) {
  return `You are fixing failing Postman test scripts. The scripts are plain JavaScript files under ${rel(ctx.scriptsDir)}/ .

RULES (a script checks every one of these after you finish):
1. Edit ONLY .js files under ${rel(ctx.scriptsDir)}/ . Never open or edit any *.postman_collection.json file.
2. Make the SMALLEST change that fixes the failures listed below. Do not reformat, re-indent, rename, reorder or tidy anything else.
3. Never delete, skip or comment out a pm.test. Never make a test pass by comparing a value with itself, by copying the actual response into the expected value, or by swallowing errors. Fix how the EXPECTED value is worked out.
4. Start with the file and line shown after "edit ->". Read only what you need.
5. If the business rule below does not tell you what the correct expected behaviour is, change nothing and answer with one line starting "NEEDS-HUMAN:" followed by your question.
6. When done, answer with 1-3 short lines saying what you changed. Do not run any commands.

BUSINESS RULE FROM THE HUMAN (this is the source of truth for what "correct" means):
${why}

CURRENT FAILURES:
${clip(digest, 14000)}
`;
}
async function cmdLoop(ctx, o) {
  if (!o.why) die('loop needs the business rule: --why "one or two sentences saying what changed and what is now correct"');
  const max = +(o.max || 4), model = o.model || 'haiku';
  let r = await runTest(ctx, Object.assign({}, o, { failed: !!o.failed }));
  for (let attempt = 1; ; attempt++) {
    if (r.pass && !r.partial) { console.log(`\nLOOP: green after ${attempt - 1} fix attempt(s).`); return 0; }
    if (r.pass && r.partial) { console.log('\nLOOP: partial run is green - confirming with the full run...\n'); r = await runTest(ctx, Object.assign({}, o, { failed: false })); attempt--; continue; }
    if (attempt > max) { console.log(`\nLOOP: still failing after ${max} attempts - stopping. Your edits are kept in ${rel(ctx.scriptsDir)}/ (discard with: ${SELF} restore --all && ${SELF} pack).`); return 1; }
    console.log(`\nLOOP: attempt ${attempt}/${max} - asking ${model} for a fix...`);
    const res = spawnSync('claude', ['-p', '--model', model, '--allowedTools', 'Read,Edit,Grep,Glob', '--disallowedTools', 'Bash,Write,WebFetch,WebSearch', '--permission-mode', 'acceptEdits'],
      { input: fixPrompt(ctx, o.why, fs.readFileSync(ctx.f('last-run.txt'), 'utf8')), encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 1 << 26 });
    if (res.error) die('could not start the `claude` CLI: ' + res.error.message, 1);
    const said = String(res.stdout || '').trim();
    console.log('model: ' + clip(said, 800).replace(/\n/g, '\n       '));
    if (/NEEDS-HUMAN/.test(said)) { console.log('\nLOOP: the model needs a human decision - stopping.'); return 3; }
    if (!o['no-sync']) { const tw = findTwins(buildPack(ctx, { allowTestRemoval: true }).states); if (tw.length) console.log(`LOOP: copied the edit to ${applyTwins(tw)} identical block(s) in other scripts`); }
    const chk = buildPack(ctx, {});
    if (chk.errors.length) { console.log('LOOP: the edit broke a rule - feeding that back:'); chk.errors.forEach(e => console.log('  ' + e)); fs.writeFileSync(ctx.f('last-run.txt'), 'YOUR LAST EDIT WAS REJECTED:\n' + chk.errors.join('\n') + '\n\n' + fs.readFileSync(ctx.f('last-run.txt'), 'utf8')); continue; }
    console.log('');
    r = await runTest(ctx, Object.assign({}, o, { failed: true }));
  }
}

/* ───────────────────────── view: read-only HTML diff of the pending edits ─────────────────────────
 * Writes ONE static file and nothing else. The page has no JavaScript and loads nothing: its Content-Security-Policy
 * forbids scripts and every network request, and all text that comes from scripts, request names and logs is escaped. */
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
/* Characters a reader cannot see, or that change the order text is displayed in: control and format characters (zero-width
 * characters, direction marks, overrides and isolates, tags), line and paragraph separators, every space other than the
 * ordinary one, variation selectors, and the letters that render as blanks. Each is shown as U+XXXX, wherever text from
 * the collection or from a log reaches the page. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2065\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/gu;
const codeHtml = s => esc(s).replace(INVISIBLE, c => (c === ' ' || c === '\t' || c === '\n' ? c : `<i title="invisible or text-direction character">U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}</i>`));
const tokensOf = l => l.match(/\s+|\w+|[^\s\w]/g) || [];
function wordMarks(a, b) {                       // [htmlA, htmlB] with the changed words marked, or null when the two lines are not alike
  const ta = tokensOf(a), tb = tokensOf(b), ops = diffOps(ta, tb);
  const solid = t => t.filter(x => x.trim()).length;
  const same = ops.filter(op => op[0] === '=' && ta[op[1]].trim()).length;
  if (!same || same * 2 < Math.max(solid(ta), solid(tb))) return null;
  const side = (toks, sign) => {
    let out = '', run = '';
    const flush = () => { if (run) out += run.trim() ? `<mark>${codeHtml(run)}</mark>` : codeHtml(run); run = ''; };
    for (const op of ops) { if (op[0] === '=') { flush(); out += codeHtml(ta[op[1]]); } else if (op[0] === sign) run += toks[op[1]]; }
    flush(); return out;
  };
  return [side(ta, '-'), side(tb, '+')];
}
function diffHtml(m) {
  const CONTEXT = 3, wsTip = 'whitespace-only edit ignored: the collection keeps this line exactly as it was';
  const segs = [];
  for (const op of m.ops) {
    const eq = op[0] === '=';
    if (!segs.length || segs[segs.length - 1].eq !== eq) segs.push({ eq, rows: [], dels: [], adds: [] });
    const seg = segs[segs.length - 1];
    if (eq) seg.rows.push({ a: op[1] + 1, b: op[2] + 1, text: m.origN[op[1]], ws: m.origN[op[1]] !== m.cur[op[2]] });
    else if (op[0] === '-') seg.dels.push({ a: op[1] + 1, text: m.origN[op[1]] });
    else seg.adds.push({ b: op[1] + 1, text: m.cur[op[1]] });
  }
  const fold = (rows, i, render) => {            // unchanged lines far from an edit go into a closed <details>
    const head = i > 0 ? CONTEXT : 0, tail = i < segs.length - 1 ? CONTEXT : 0, hidden = rows.length - head - tail;
    if (hidden < 4) return rows.map(render).join('');
    return rows.slice(0, head).map(render).join('') + `<details class="gap"><summary>${hidden} unchanged lines</summary>${rows.slice(head, rows.length - tail).map(render).join('')}</details>` + rows.slice(rows.length - tail).map(render).join('');
  };
  const uni = (cls, a, b, sign, html, tip) => `<div class="r ${cls}"${tip ? ` title="${esc(tip)}"` : ''}><span class="n">${a}</span><span class="n">${b}</span><span class="g">${sign}</span><span class="c">${html}</span></div>`;
  const half = (cls, n, sign, html) => `<span class="n ${cls}">${n}</span><span class="g ${cls}">${sign}</span><span class="c ${cls}">${html}</span>`;
  const row = (l, r, tip) => `<div class="r"${tip ? ` title="${esc(tip)}"` : ''}>${l}${r}</div>`;
  const blank = half('pad', '', '', '');
  let u = '', s = '';
  segs.forEach((seg, i) => {
    if (seg.eq) {
      u += fold(seg.rows, i, x => uni(x.ws ? 'ws' : '', x.a, x.b, x.ws ? '\u2248' : '', codeHtml(x.text), x.ws && wsTip));
      s += fold(seg.rows, i, x => row(half('', x.a, '', codeHtml(x.text)), half(x.ws ? 'ws' : '', x.b, x.ws ? '\u2248' : '', codeHtml(x.text)), x.ws && wsTip));
      return;
    }
    let next = 0;                                // pair each removed line with the added line that replaces it
    if (seg.dels.length * seg.adds.length <= 2500) for (const d of seg.dels) for (let j = next; j < seg.adds.length; j++) {
      const h = wordMarks(d.text, seg.adds[j].text);
      if (h) { d.html = h[0]; seg.adds[j].html = h[1]; d.mate = seg.adds[j]; next = j + 1; break; }
    }
    const L = d => half('del', d.a, '\u2212', d.html || codeHtml(d.text)), R = a => half('add', a.b, '+', a.html || codeHtml(a.text));
    u += seg.dels.map(d => uni('del', d.a, '', '\u2212', d.html || codeHtml(d.text))).join('') + seg.adds.map(a => uni('add', '', a.b, '+', a.html || codeHtml(a.text))).join('');
    let j = 0, ql = [], qr = [];
    const flush = () => { for (let k = 0; k < Math.max(ql.length, qr.length); k++) s += row(ql[k] || blank, qr[k] || blank); ql = []; qr = []; };
    for (const d of seg.dels) {
      if (!d.mate) { ql.push(L(d)); continue; }
      while (seg.adds[j] !== d.mate) qr.push(R(seg.adds[j++]));
      flush(); s += row(L(d), R(seg.adds[j++]));
    }
    while (j < seg.adds.length) qr.push(R(seg.adds[j++]));
    flush();
  });
  return `<div class="diff u">${u}</div><div class="diff s">${s}</div>`;
}
const VIEW_CSS = `
:root{--bg:#f5f6f8;--panel:#fff;--ink:#1c2128;--dim:#5d6772;--line:#d8dde3;--add:#e6f6ea;--addm:#abe5ba;--del:#fdeced;--delm:#f5b8bd;--ok:#116329;--bad:#b3111f;--warn:#7a4f00;--warnbg:#fff3cf;--accent:#2a5bd7}
@media(prefers-color-scheme:dark){:root{--bg:#13161b;--panel:#1b1f26;--ink:#dce2e9;--dim:#98a2ae;--line:#2d343e;--add:#15301f;--addm:#236b3c;--del:#391a1e;--delm:#8a2c35;--ok:#7ddc98;--bad:#ff9aa2;--warn:#f1c463;--warnbg:#3a2f12;--accent:#8fb3ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
code,.diff,pre{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",Menlo,monospace;font-size:12.5px}
code{overflow-wrap:anywhere}
input[name=mode]{position:fixed;opacity:0;pointer-events:none}
header{background:var(--panel);border-bottom:1px solid var(--line);padding:18px 24px 14px}
.top{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline}
h1{font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dim);margin:0}
h1 code{text-transform:none;letter-spacing:0;font-weight:400}
.modes{margin-left:auto;display:flex;border:1px solid var(--line);border-radius:6px;overflow:hidden}
.modes label{padding:3px 12px;font-size:12.5px;cursor:pointer;color:var(--dim)}
#mu:checked~header label[for=mu],#ms:checked~header label[for=ms]{background:var(--accent);color:var(--panel)}
#mu:focus-visible~header label[for=mu],#ms:focus-visible~header label[for=ms]{outline:2px solid var(--ink);outline-offset:-2px}
#mu:checked~.wrap .s,#ms:checked~.wrap .u{display:none}
.verdict{font-size:22px;font-weight:650;line-height:1.25;margin:10px 0 8px}
.verdict.bad,.bad{color:var(--bad)}.okc{color:var(--ok)}.warnc{color:var(--warn)}
.p{color:var(--ok)}.m{color:var(--bad)}
.facts{list-style:none;margin:0;padding:0;display:grid;gap:3px;font-size:13.5px}
.facts>li{padding-left:18px;position:relative}
.facts>li::before{content:"";position:absolute;left:2px;top:.55em;width:7px;height:7px;border-radius:50%;background:var(--dim)}
.facts>li.okc::before{background:var(--ok)}.facts>li.bad::before{background:var(--bad)}.facts>li.warnc::before{background:var(--warn)}
.facts li span,.facts li ul{color:var(--ink)}
.facts ul{margin:2px 0 4px;padding-left:18px}
.log summary{cursor:pointer}
pre{margin:6px 0 2px;padding:10px 12px;background:var(--bg);border:1px solid var(--line);border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:60vh;overflow:auto;color:var(--ink)}
.wrap{display:grid;grid-template-columns:minmax(200px,270px) minmax(0,1fr);gap:20px;padding:20px 24px;align-items:start}
nav{position:sticky;top:12px;max-height:calc(100vh - 24px);overflow:auto;font-size:13px}
nav h2{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);margin:2px 0 6px;font-weight:600}
nav a{display:flex;gap:8px;justify-content:space-between;align-items:baseline;padding:5px 8px;border-radius:6px;color:inherit;text-decoration:none}
nav a:hover,nav a:focus-visible{background:var(--panel);outline:1px solid var(--line)}
nav .pm{white-space:nowrap;font-size:12px}
.req{overflow-wrap:anywhere;color:var(--dim)}.req b{color:var(--ink);font-weight:600}
main{display:grid;gap:16px;min-width:0}
.file{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.file.flag{border-color:var(--bad)}
.file>summary{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline;padding:10px 14px;cursor:pointer;list-style:none}
.file>summary::-webkit-details-marker,.gap>summary::-webkit-details-marker{display:none}
.file>summary::before{content:"\u25B8";color:var(--dim)}.file[open]>summary::before{content:"\u25BE"}
.file>summary .pm{margin-left:auto;font-weight:600}
.tag{font-size:11.5px;border:1px solid var(--line);border-radius:10px;padding:0 8px;color:var(--dim);white-space:nowrap}
.meta{padding:0 14px 10px 30px;font-size:12.5px;color:var(--dim)}
.diff{border-top:1px solid var(--line);line-height:1.5}
.r{display:grid;grid-template-columns:5ch 5ch 2.5ch minmax(0,1fr)}
.s .r{grid-template-columns:5ch 2.5ch minmax(0,1fr) 5ch 2.5ch minmax(0,1fr)}
.s .c{border-right:1px solid var(--line)}.s .c:last-child{border-right:0}
.n,.g{user-select:none;-webkit-user-select:none;color:var(--dim);text-align:right}
.g{text-align:center}
.c{white-space:pre-wrap;overflow-wrap:anywhere;tab-size:4;min-height:1.5em;padding-right:10px}
.add{background:var(--add)}.del{background:var(--del)}.pad{background:var(--bg)}
.add .g,.g.add{color:var(--ok)}.del .g,.g.del{color:var(--bad)}.ws .g,.g.ws{color:var(--warn)}
mark{color:inherit;border-radius:2px;background:var(--addm)}.del mark{background:var(--delm)}
.c i{font-style:normal;font-size:.85em;padding:0 3px;border:1px solid;border-radius:3px;color:var(--warn);background:var(--warnbg)}
.gap>summary{list-style:none;cursor:pointer;padding:2px 14px;font:12px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--dim);background:var(--bg);border-block:1px solid var(--line)}
.gap>summary::before{content:"\u22EF  show "}.gap[open]>summary::before{content:"\u22EF  hide "}
.gap>summary:hover{color:var(--ink)}
.empty{background:var(--panel);border:1px dashed var(--line);border-radius:8px;padding:28px;color:var(--dim)}
footer{padding:4px 24px 28px;font-size:12px;color:var(--dim)}
@media(max-width:860px){.wrap{grid-template-columns:minmax(0,1fr)}nav{position:static;max-height:none}}
`;
function viewHtml(ctx, r, twins) {
  const changed = r.states.filter(st => st.m.changed);
  const total = k => changed.reduce((n, st) => n + st.m[k], 0);
  const ws = r.changes.reduce((n, c) => n + c.ws, 0);
  const code = t => `<code>${codeHtml(t)}</code>`, when = ms => esc(new Date(ms).toLocaleString());
  const pm = m => `<span class="pm"><span class="p">+${m.add}</span> <span class="m">\u2212${m.del}</span></span>`;
  const info = changed.map((st, i) => {
    const names = st.s.names.length ? st.s.names : ['(collection)'];
    return { st, id: 's' + (i + 1), file: rel(st.abs), kind: (/(^|\/)_folder\.[^/]+$/.test(st.s.file) ? 'folder ' : !st.s.names.length ? 'collection ' : '') + st.s.listen,
      req: `<span class="req">${names.slice(0, -1).map(n => codeHtml(n) + ' / ').join('')}<b>${codeHtml(names[names.length - 1])}</b></span>` };
  });
  const facts = [];
  if (r.errors.length) facts.push(`<li class="bad">Guards refused these edits, so the collection file is not updated:<ul>${r.errors.map(e => `<li>${code(e)}</li>`).join('')}</ul></li>`);
  else if (changed.length) facts.push('<li class="okc"><span>Guards passed: no syntax errors, no <code>pm.test</code> removed.</span></li>');
  const onDisk = fs.existsSync(ctx.collection) ? readStrict(ctx.collection) : null;
  const col = code(rel(ctx.collection));
  if (r.errors.length) { /* said above */ }
  else if (onDisk === r.out) facts.push(`<li class="okc"><span>${col} ${changed.length ? 'already contains exactly these edits (packed).' : 'is unchanged since unpack.'}</span></li>`);
  else if (onDisk !== null && [r.man.baseSha, loadState(ctx).lastPackSha].includes(sha(onDisk))) facts.push(`<li class="warnc"><span>${col} does not contain these edits yet. Run ${code(SELF + ' test')} (or ${code('pack')}).</span></li>`);
  else facts.push(`<li class="bad"><span>${col} was changed by something other than pmx since unpack. Unpack again before packing.</span></li>`);
  if (ws) facts.push(`<li><span>${ws} whitespace-only line edit(s) ignored, so the collection diff stays small (marked \u2248 inside the unchanged lines).</span></li>`);
  if (twins.length) facts.push(`<li class="warnc">Twin code: ${twins.length} place(s) still contain the old version of code changed here. Copy the edit with ${code(SELF + ' sync')}.<ul>${twins.slice(0, 20).map(t => `<li>${code(`${rel(t.t.st.abs)}:${t.at + 1}`)} <span>same block as</span> ${code(`${rel(t.src.abs)}:${t.h.line}`)}</li>`).join('')}</ul></li>`);
  const runFile = ctx.f('last-run.txt');
  if (fs.existsSync(runFile)) {
    const txt = fs.readFileSync(runFile, 'utf8'), at = fs.statSync(runFile).mtimeMs;
    const stale = changed.some(st => fs.statSync(st.abs).mtimeMs > at);
    facts.push(`<li class="${stale ? 'warnc' : /^RESULT: PASS/.test(txt) ? 'okc' : 'bad'}"><details class="log"><summary><span>Last test run (${when(at)}): ${code(txt.split('\n')[0])}${stale ? ' <b class="warnc">Scripts were edited after this run. Run the tests again.</b>' : ''}</span></summary><pre>${codeHtml(txt)}</pre></details></li>`);
  } else facts.push(`<li><span>No test run recorded yet. Run ${code(SELF + ' test')}.</span></li>`);
  const verdict = r.errors.length ? `<p class="verdict bad">Pack refused: ${r.errors.length} problem(s) to fix</p>`
    : !changed.length ? '<p class="verdict">No script changes since unpack</p>'
    : `<p class="verdict">${changed.length} script${changed.length > 1 ? 's' : ''} changed <span class="p">+${total('add')}</span> <span class="m">\u2212${total('del')}</span></p>`;
  const cards = info.map(x => {
    const m = x.st.m, before = countTests(m.origN.join('\n')), after = countTests(m.lines.map(l => l.replace(/\r$/, '')).join('\n'));
    const flag = r.errors.some(e => e.includes(x.file));
    return `<details class="file${flag ? ' flag' : ''}" id="${x.id}" open><summary>${x.req}<span class="tag">${codeHtml(x.kind)}</span>${flag ? '<span class="tag bad">refused</span>' : ''}${pm(m)}</summary>`
      + `<div class="meta">${code(x.file)} \u00B7 <span${after < before ? ' class="bad"' : ''}>pm.test calls ${before} \u2192 ${after}</span>${m.ws ? ` \u00B7 ${m.ws} whitespace-only edit(s) ignored` : ''}</div>${diffHtml(m)}</details>`;
  }).join('');
  const nav = info.length ? `<nav><h2>Changed scripts</h2>${info.map(x => `<a href="#${x.id}">${x.req}${pm(x.st.m)}</a>`).join('')}</nav>` : '<nav></nav>';
  const empty = `<div class="empty">Nothing to review. Edit a .js file under ${code(rel(ctx.scriptsDir) + '/')} and run ${code(SELF + ' view')} again.</div>`;
  const csp = `default-src 'none'; style-src 'sha256-${crypto.createHash('sha256').update(VIEW_CSS).digest('base64')}'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>pmx diff - ${esc(path.basename(ctx.work))}</title><style>${VIEW_CSS}</style></head><body>`
    + '<input type="radio" name="mode" id="mu" checked aria-label="Unified diff"><input type="radio" name="mode" id="ms" aria-label="Side-by-side diff">'
    + `<header><div class="top"><h1>pmx diff \u00B7 ${col}</h1><div class="modes"><label for="mu">Unified</label><label for="ms">Side by side</label></div></div>${verdict}<ul class="facts">${facts.join('')}</ul></header>`
    + `<div class="wrap">${nav}<main>${cards || empty}</main></div>`
    + `<footer>Read-only snapshot of the edits since unpack, taken ${when(Date.now())}. Refresh it with ${code(SELF + ' view')}. This page contains no JavaScript and makes no network requests.</footer></body></html>\n`;
}
function cmdView(o) {
  const ctx = getCtx(o);
  const r = buildPack(ctx, { keepWs: o['keep-whitespace'], allowTestRemoval: o['allow-test-removal'] });
  const file = ctx.f('diff.html'), changed = r.states.filter(st => st.m.changed);
  writeAtomic(file, viewHtml(ctx, r, findTwins(r.states)));
  console.log(`wrote ${rel(file)}   (${changed.length} changed script(s), +${changed.reduce((n, st) => n + st.m.add, 0)} -${changed.reduce((n, st) => n + st.m.del, 0)}${r.errors.length ? `, ${r.errors.length} guard error(s)` : ''})`);
  console.log(`open it in a browser: ${pathToFileURL(file).href}`);
  if (!o.open) return;
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [file]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [file]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => console.log('(could not start a browser from here - open the file yourself)')).unref();
}

/* ───────────────────────── main ───────────────────────── */
const HELP = `pmx - fix Postman collection scripts as plain .js files (run from the repo root)

  unpack <collection.json>   split every script into ${'.pmx/<name>/scripts/**.js'}
  ls [text]                  list script files (filter by request name)
  digest <log.txt|->         short failure list from a newman / Jenkins console log
  test [--failed]            pack + run newman + short failure list   (--failed = only requests that failed last time)
  sync                       copy your edit to identical copies of the same code in other requests
  status                     what changed so far (nothing is written)
  view [--open]              write a read-only HTML diff of your edits (static file: no server, no JavaScript)
  pack                       write edits into the collection file (test does this for you)
  restore <file>|--all       throw away edits to script file(s)
  loop --why "<rule>"        test -> small model edits -> test, until green   [--model haiku] [--max 4]

merging is done by treemerge.js (same folder; works on any JSON or text file, see its --help):
  merge [flags]              = treemerge for the configured collection
  diff [refA] [refB]         = treemerge diff for the configured collection
  merge-install              = treemerge install "*.postman_collection.json"

guards on every pack: only script lines you changed differ in the collection, whitespace-only
edits are dropped, syntax errors and removed pm.test() calls are refused.`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = parseArgs(rest);
  switch (cmd) {
    case 'unpack': return cmdUnpack(o);
    case 'ls': return cmdLs(o);
    case 'pack': return void doPack(getCtx(o), o, false);
    case 'status': { const ctx = getCtx(o); const r = buildPack(ctx, { keepWs: o['keep-whitespace'], allowTestRemoval: o['allow-test-removal'] }); printChanges(ctx, r); r.errors.forEach(e => console.log('  ERROR ' + e)); printTwins(ctx, findTwins(r.states)); return; }
    case 'restore': return cmdRestore(o);
    case 'sync': return cmdSync(o);
    case 'view': return cmdView(o);
    case 'digest': return cmdDigest(o);
    case 'test': { const r = await runTest(getCtx(o), o); process.exitCode = r.pass ? 0 : 1; return; }
    case 'loop': process.exitCode = await cmdLoop(getCtx(o), o); return;
    case 'merge': case 'diff': case 'merge-install': {                      // merging lives in treemerge.js; these are shortcuts for the configured collection
      const cfg = fs.existsSync('pmx.config.json') ? readJson('pmx.config.json') : {};
      let col = o.collection || cfg.collection;
      if (!col && (cmd === 'diff' || o.theirs || o.ours || o.base) && !o._.some(a => /\.json$/i.test(a))) {   // no file named: use the one collection git tracks here
        const r = spawnSync('git', ['ls-files', '--', '*postman_collection*.json'], { encoding: 'utf8' });
        const found = r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
        if (found.length === 1) col = found[0];
        else if (found.length > 1) die('several collections here - say which one with --collection <file>:\n  ' + found.join('\n  '));
      }
      const pass = rest.filter((a, i) => a !== '--collection' && rest[i - 1] !== '--collection');
      const args = cmd === 'merge-install' ? ['install', '*.postman_collection.json'] : cmd === 'diff' ? ['diff', ...(col ? [col] : []), ...pass] : [...(col && !o._.length ? [col] : []), ...pass];
      process.exitCode = await require('./treemerge.js').cli(args).catch(e => { console.error('pmx: ' + e.message); return 2; });
      return;
    }
    default: console.log(HELP); process.exitCode = cmd && cmd !== 'help' && cmd !== '--help' ? 2 : 0;
  }
}
module.exports = { scanExec, decodeSpan, encodeSpan, detectFormat, mergeScript, diffOps, parseNewmanLog, findTestLine, twoListHint,
  stripWs, safe, rel, die, sha, stripBom, syntaxError, getCtx, readStrict, writeAtomic, readJson, clip, SELF };
if (require.main === module) main().catch(e => die(e && e.stack ? e.stack : String(e)));
