#!/usr/bin/env node
'use strict';
/*
 * treemerge - an interactive 3-way merge tool that understands structure.
 *
 *   JSON files   merged as a tree: objects key by key, lists by element identity (inferred, or from a
 *                built-in profile such as Postman), multi-line strings and script arrays line by line.
 *                Untouched parts of the file keep their exact bytes.
 *   other text   merged line by line (diff3), so it works as a git mergetool for any file.
 *
 * Conflicts are settled in a local browser UI, in the terminal, or with flags / small conflict files
 * (for scripts and coding agents). Zero dependencies. Needs treemerge.ui.html next to this file for the UI.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const vm = require('vm');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const strs = a => a.every(l => typeof l === 'string');
const noCR = a => a.map(l => l.replace(/\r$/, ''));
const sameArr = (x, y) => x.length === y.length && x.every((l, i) => l === y[i]);
const stripWs = l => l.replace(/\s+/g, '');
const stripBom = s => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);
const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…');
const rel = p => path.relative(process.cwd(), p).split(path.sep).join('/') || '.';
const safe = s => String(s).replace(/[^A-Za-z0-9.]+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 60) || '_';
const setKey = (o, k, v) => { if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); else o[k] = v; };
const show = v => (v === undefined ? '(not present)' : clip(JSON.stringify(v), 140));
class Fail extends Error {}
const die = m => { throw new Fail(m); };
const SELF = 'node ' + (rel(__filename).includes(' ') ? JSON.stringify(rel(__filename)) : rel(__filename));

/* ───────────────────────── line diff ───────────────────────── */
function diffOps(a, b) {
  const n = a.length, m = b.length, ops = [];
  let s = 0; while (s < n && s < m && a[s] === b[s]) s++;
  let e = 0; while (e < n - s && e < m - s && a[n - 1 - e] === b[m - 1 - e]) e++;
  for (let k = 0; k < s; k++) ops.push(['=', k, k]);
  const N = n - s - e, M = m - s - e;
  if (N && M && N * M <= 4e7) {
    const W = M + 1, t = new Uint32Array((N + 1) * W);
    for (let x = N - 1; x >= 0; x--) for (let y = M - 1; y >= 0; y--) t[x * W + y] = a[s + x] === b[s + y] ? t[(x + 1) * W + y + 1] + 1 : Math.max(t[(x + 1) * W + y], t[x * W + y + 1]);
    let x = 0, y = 0;
    while (x < N && y < M) {
      if (a[s + x] === b[s + y]) { ops.push(['=', s + x, s + y]); x++; y++; } else if (t[(x + 1) * W + y] >= t[x * W + y + 1]) ops.push(['-', s + x++]); else ops.push(['+', s + y++]);
    }
    while (x < N) ops.push(['-', s + x++]);
    while (y < M) ops.push(['+', s + y++]);
  } else { for (let x = 0; x < N; x++) ops.push(['-', s + x]); for (let y = 0; y < M; y++) ops.push(['+', s + y]); }
  for (let k = 0; k < e; k++) ops.push(['=', n - e + k, m - e + k]);
  return ops;
}
/* diff3: split three versions of a line list into chunks: same | ours | theirs | agree | conflict */
function chunks3(O, A, B, key, noBase) {
  if (noBase) O = diffOps(A.map(key), B.map(key)).filter(op => op[0] === '=').map(op => A[op[1]]);   // no ancestor: shared lines stand in for it
  const ko = O.map(key), ma = new Int32Array(O.length).fill(-1), mb = new Int32Array(O.length).fill(-1);
  for (const op of diffOps(ko, A.map(key))) if (op[0] === '=') ma[op[1]] = op[2];
  for (const op of diffOps(ko, B.map(key))) if (op[0] === '=') mb[op[1]] = op[2];
  const same = (x, y) => x.length === y.length && x.every((l, i) => key(l) === key(y[i]));
  const out = []; let lo = 0, la = 0, lb = 0;
  for (;;) {
    let i = 0;
    while (lo + i < O.length && ma[lo + i] === la + i && mb[lo + i] === lb + i) i++;
    if (i) {
      const lines = [];
      for (let q = 0; q < i; q++) { const a = A[la + q]; lines.push(noBase || a !== O[lo + q] ? a : B[lb + q]); }   // spelling of whichever side touched the line
      const last = out[out.length - 1];
      if (last && last.t === 'same') last.lines.push(...lines); else out.push({ t: 'same', lines });
      lo += i; la += i; lb += i; continue;
    }
    let o = lo; while (o < O.length && (ma[o] < 0 || mb[o] < 0)) o++;
    const ea = o < O.length ? ma[o] : A.length, eb = o < O.length ? mb[o] : B.length;
    const co = O.slice(lo, o), ca = A.slice(la, ea), cb = B.slice(lb, eb);
    if (co.length || ca.length || cb.length) {
      if (same(ca, cb)) out.push({ t: 'agree', base: co, lines: ca });
      else if (!noBase && same(ca, co)) out.push({ t: 'theirs', base: co, lines: cb });
      else if (!noBase && same(cb, co)) out.push({ t: 'ours', base: co, lines: ca });
      else out.push({ t: 'conflict', base: noBase ? null : co, ours: ca, theirs: cb });
    }
    lo = o; la = ea; lb = eb;
    if (o >= O.length) break;
  }
  return out;
}
const sideOf = (c, s) => (c.t === 'same' ? c.lines : c.t === 'conflict' ? (s === 'ours' ? c.ours : s === 'theirs' ? c.theirs : c.base || [])
  : s === 'base' ? c.base : c.t === 'agree' || c.t === s ? c.lines : c.base);
function pickLines(c, pick) {
  if (pick && typeof pick === 'object') return pick.lines;
  if (pick === 'ours+theirs' || pick === 'theirs+ours') {              // both: lines the two sides share at the edges appear once
    const a = sideOf(c, 'ours'), b = sideOf(c, 'theirs');
    let px = 0; while (px < a.length && px < b.length && a[px] === b[px]) px++;
    let sx = 0; while (sx < a.length - px && sx < b.length - px && a[a.length - 1 - sx] === b[b.length - 1 - sx]) sx++;
    const ma = a.slice(px, a.length - sx), mb = b.slice(px, b.length - sx);
    return a.slice(0, px).concat(pick === 'ours+theirs' ? ma.concat(mb) : mb.concat(ma), a.slice(a.length - sx));
  }
  return sideOf(c, pick);
}
/* apply a choice to chunks -> final lines, how many conflict chunks are still undecided, and a version with markers */
function resolveText(chunks, ch) {
  if (isObj(ch) && typeof ch.text === 'string') { const lines = ch.text.replace(/\r\n/g, '\n').split('\n'); return { lines, open: 0, marked: lines, picks: {} }; }
  const side = typeof ch === 'string' ? ch : null, hunks = isObj(ch) && isObj(ch.hunks) ? ch.hunks : {}, picks = {};
  const lines = [], marked = []; let open = 0;
  chunks.forEach((c, i) => {
    if (c.t === 'same') { lines.push(...c.lines); marked.push(...c.lines); return; }
    const pick = side || (has(hunks, i) ? hunks[i] : null);
    if (pick) { const l = pickLines(c, pick); picks[i] = pick; lines.push(...l); marked.push(...l); return; }
    if (c.t !== 'conflict') { lines.push(...c.lines); marked.push(...c.lines); return; }
    open++; lines.push(...c.ours);
    marked.push('<<<<<<< OURS', ...c.ours, ...(c.base ? ['||||||| BASE', ...c.base] : []), '=======', ...c.theirs, '>>>>>>> THEIRS');
  });
  return { lines, open, marked, picks };
}
/* put \r line terminators back the way `orig` had them (for arrays that hold one script line per element) */
function restoreCR(orig, lines, defCrlf) {
  if (!orig) return lines.map((l, i) => l + (defCrlf && i < lines.length - 1 ? '\r' : ''));
  const origN = noCR(orig);
  if (sameArr(origN, lines)) return orig;
  const cr = orig.filter(l => l.endsWith('\r')).length, crlf = orig.length > 1 ? cr > 0 && cr * 2 >= orig.length - 1 : !!defCrlf;
  const lastCR = orig.length > 0 && orig[orig.length - 1].endsWith('\r'), out = [];
  for (const op of diffOps(origN, lines)) { if (op[0] === '=') out.push({ oi: op[1] }); else if (op[0] === '+') out.push({ line: lines[op[1]] }); }
  return out.map((x, idx) => {
    const last = idx === out.length - 1;
    if (x.line !== undefined) return x.line + (crlf && (!last || lastCR) ? '\r' : '');
    const raw = orig[x.oi];
    if (!crlf || (x.oi === orig.length - 1) === last) return raw;
    return raw.replace(/\r$/, '') + (!last || lastCR ? '\r' : '');
  });
}
function syntaxError(code) {
  try { new vm.Script('(async function(){' + code + '\n})', { filename: 'merged.js' }); return null; } // eslint-disable-line no-new
  catch (e) { const m = /merged\.js:(\d+)/.exec(String(e.stack || '')); return `${e.name}: ${e.message}` + (m ? ` (line ${m[1]})` : ''); }
}

/* ───────────────────────── JSON with positions, and a writer that keeps untouched bytes ───────────────────────── */
function parseCst(text) {
  let i = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  const bad = m => { throw new SyntaxError(`${m} at offset ${i}`); };
  const ws = () => { for (;;) { const c = text.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; } };
  const str = () => { i++; for (;;) { const c = text[i]; if (c === undefined) bad('unterminated string'); if (c === '\\') i += 2; else if (c === '"') { i++; return; } else i++; } };
  const val = () => {
    ws(); const s = i, c = text[i];
    if (c === '{') {
      i++; const v = {}, kids = new Map(); ws();
      if (text[i] === '}') { i++; return { v, s, e: i, kids }; }
      for (;;) {
        ws(); if (text[i] !== '"') bad('expected a key');
        const ks = i; str(); const k = JSON.parse(text.slice(ks, i));
        ws(); if (text[i] !== ':') bad('expected ":"'); i++;
        const n = val(); n.ks = ks; setKey(v, k, n.v); kids.set(k, n);
        ws(); if (text[i] === ',') { i++; continue; } if (text[i] === '}') { i++; break; } bad('expected "," or "}"');
      }
      return { v, s, e: i, kids };
    }
    if (c === '[') {
      i++; const v = [], kids = []; ws();
      if (text[i] === ']') { i++; return { v, s, e: i, kids }; }
      for (;;) { const n = val(); v.push(n.v); kids.push(n); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === ']') { i++; break; } bad('expected "," or "]"'); }
      return { v, s, e: i, kids };
    }
    if (c === '"') { str(); return { v: JSON.parse(text.slice(s, i)), s, e: i }; }
    const re = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y; re.lastIndex = i;
    const m = re.exec(text); if (!m) bad('unexpected token'); i += m[0].length;
    return { v: JSON.parse(m[0]), s, e: i };
  };
  const root = val(); ws();
  if (i !== text.length) bad('unexpected trailing content');
  return root;
}
function detectStyle(text) {
  const m = /\n([ \t]+)\S/.exec(text), c = /"[ \t]*:([ \t]*)/.exec(text), multi = /\n/.test(text.trim());
  return { nl: /\r\n/.test(text) ? '\r\n' : '\n', unit: m ? m[1] : (multi ? '' : ''), multi, colon: ':' + (c ? c[1] : multi ? ' ' : '') };
}
/* Serialise `tree` in the style of `text`. Any value that is still ours (same object / same scalar at the same key)
 * is copied from the original text byte for byte; only containers that really changed are laid out again. */
function emitter(text, root) {
  const st = detectStyle(text), nodeOf = new Map();
  (function idx(n) { if (n.kids) { nodeOf.set(n.v, n); (n.kids instanceof Map ? [...n.kids.values()] : n.kids).forEach(idx); } })(root);
  const lineInd = pos => { const ls = text.lastIndexOf('\n', pos - 1) + 1; return /^[ \t]*/.exec(text.slice(ls, pos))[0]; };
  const isInline = n => !!n && n.e - n.s > 2 && !/[\r\n]/.test(text.slice(n.s, n.e));
  const emit = (v, node, ind) => {
    if (node && node.v === v) return text.slice(node.s, node.e);
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (nodeOf.has(v)) { const n = nodeOf.get(v); return text.slice(n.s, n.e); }
    const inline = !st.multi || isInline(node), old = node && node.kids ? text.slice(node.s, node.e) : '';
    if (node && node.kids && !inline) ind = lineInd(node.s);
    const pad = inline && /^.[ \t]/.test(old) ? ' ' : '', gap = inline ? (/,[ \t]/.test(old) || (!old && st.multi) ? ', ' : ',') : '';
    const inner = ind + st.unit, sep = inline ? gap : ',' + st.nl + inner, open = inline ? pad : st.nl + inner, close = inline ? pad : st.nl + ind;
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      const raw = new Map();
      if (node && Array.isArray(node.kids)) for (const k of node.kids) if (!k.kids && !raw.has(k.v)) raw.set(k.v, text.slice(k.s, k.e));
      return '[' + open + v.map(x => (x !== null && typeof x === 'object' ? emit(x, undefined, inner) : raw.has(x) ? raw.get(x) : JSON.stringify(x))).join(sep) + close + ']';
    }
    const keys = Object.keys(v); if (!keys.length) return '{}';
    const kids = node && node.kids instanceof Map ? node.kids : null;
    let colon = st.colon;
    return '{' + open + keys.map(k => {
      const kn = kids ? kids.get(k) : undefined;
      if (kn) { const pre = text.slice(kn.ks, kn.s); colon = pre.slice(pre.lastIndexOf('"') + 1); return pre + emit(v[k], kn, inner); }   // existing member: its own spelling
      return JSON.stringify(k) + colon + emit(v[k], undefined, inner);
    }).join(sep) + close + '}';
  };
  return { style: st, emit: v => emit(v, root, '') };
}

/* ───────────────────────── profiles: what the tool knows about a kind of file ───────────────────────── */
const PREFERRED = ['id', '_id', 'uid', 'uuid', 'guid', 'key', 'name', 'title', 'slug', 'code', 'path', 'ref', 'url', 'listen'];
function keyFn(field) { const f = e => `${typeof e[field]}:${e[field]}`; f.field = field; f.label = e => String(e[field]); return f; }
const pmItem = e => (Array.isArray(e.item) ? 'folder:' : 'request:') + e.name; pmItem.field = 'name'; pmItem.label = e => String(e.name);
const PM_LISTS = { item: pmItem, event: keyFn('listen'), response: keyFn('name'), cookie: keyFn('name'), header: keyFn('key'), variable: keyFn('key'), query: keyFn('key'), urlencoded: keyFn('key'), formdata: keyFn('key'), values: keyFn('key') };
const segText = s => (typeof s === 'string' ? s : `[${s.label}]`);
const joinSegs = segs => segs.map((s, i) => (typeof s === 'string' ? (i ? '.' : '') + s : `[${s.label}]`)).join('');
function genLabel(p) { return p.length ? { group: joinSegs(p.slice(0, -1)) || '(top level)', field: segText(p[p.length - 1]) } : { group: '(top level)', field: '(whole file)' }; }
function pmLabel(p) {
  let last = -1; const names = [], parts = [];
  p.forEach((s, i) => { if (typeof s !== 'string' && s.list === 'item') { names.push(s.label); last = i; } });
  for (let i = last + 1; i < p.length; i++) { const s = p[i]; if (typeof s !== 'string') parts.push(`${s.list}[${s.label}]`); else if (typeof p[i + 1] === 'string' || i === p.length - 1) parts.push(s); }
  const n = parts.length, ev = n >= 3 ? /^event\[(.*)\]$/.exec(parts[n - 3]) : null;
  const field = n >= 2 && parts[n - 1] === 'exec' && parts[n - 2] === 'script' ? (ev ? ev[1] + ' ' : '') + 'script' : parts.join('.');
  return { group: names.length ? names.join(' / ') : '(collection level)', field: field || (last >= 0 && String(p[last].id).startsWith('folder:') ? '(whole folder)' : '(whole request)') };
}
const PROFILES = [
  { name: 'postman',
    test: (file, v) => /postman/i.test(path.basename(file)) || (isObj(v) && ((isObj(v.info) && /getpostman\.com/.test(String(v.info.schema))) || has(v, '_postman_variable_scope') || (isObj(v.collection) && isObj(v.collection.info)))),
    volatile: new Set(['id', '_postman_id', 'uid', '_exporter_id', '_postman_exported_at', '_postman_exported_using']),
    listKey: (name, arrs) => (PM_LISTS[name] && arrs.every(a => a.every(e => isObj(e) && has(e, PM_LISTS[name].field))) ? PM_LISTS[name] : undefined),
    textArray: name => name === 'exec', atomic: p => p[p.length - 1] === 'url', ignoreWs: true, label: pmLabel, lang: (p, mode) => (mode === 'lines' ? 'javascript' : 'text') },
  { name: 'json', test: () => true, volatile: new Set(), listKey: () => undefined, textArray: () => false, atomic: () => false, ignoreWs: false, label: genLabel, lang: () => 'text' },
];
const textProfile = file => ({ name: 'text', volatile: new Set(), label: () => ({ group: path.basename(file), field: 'contents' }), lang: () => (/\.[cm]?js$/i.test(file) ? 'javascript' : 'text'), ignoreWs: false });
function pickProfile(file, value, forced) {
  if (forced) { const p = PROFILES.find(x => x.name === forced); if (!p) die(`unknown profile "${forced}" (have: ${PROFILES.map(x => x.name).join(', ')})`); return p; }
  return PROFILES.find(p => p.test(file, value));
}
/* which field identifies an element of this list? must exist on every element and be unique in each version */
function inferKey(arrs, prof) {
  const all = [].concat(...arrs);
  if (!all.length || !all.every(isObj)) return null;
  for (const f of [...PREFERRED, ...Object.keys(all[0])]) {
    if (prof.volatile.has(f) || !all.every(e => has(e, f) && e[f] !== null && typeof e[f] !== 'object')) continue;
    if (arrs.every(a => new Set(a.map(e => `${typeof e[f]}:${e[f]}`)).size === a.length)) return keyFn(f);
  }
  return null;
}
function makeEq(vol) {       // deep equality that ignores volatile keys and object key order
  const eq = (a, b) => {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    const aa = Array.isArray(a); if (aa !== Array.isArray(b)) return false;
    if (aa) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false; return true; }
    for (const k of Object.keys(a)) if (!vol.has(k) && (!has(b, k) || !eq(a[k], b[k]))) return false;
    for (const k of Object.keys(b)) if (!vol.has(k) && !has(a, k)) return false;
    return true;
  };
  return eq;
}

/* ───────────────────────── the merge ───────────────────────── */
function newEntry(ctx, p, kind, b, o, t) {
  let key = JSON.stringify(p.map(s => (typeof s === 'string' ? s : [s.id]))), n = 2;
  if (ctx.keys.has(key)) { while (ctx.keys.has(`${key}#${n}`)) n++; key = `${key}#${n}`; }
  ctx.keys.add(key);
  const lab = ctx.prof.label(p);
  const e = { key, kind, group: lab.group, field: lab.field, base: b, ours: o, theirs: t };
  ctx.entries.push(e);
  return e;
}
/* a leaf decision: one value (or one list element) that differs between the sides */
function decide(ctx, p, kind, b, o, t) {
  const e = newEntry(ctx, p, kind, b, o, t), oc = !ctx.eq(b, o), tc = !ctx.eq(b, t);
  e.auto = oc && tc ? 'conflict' : tc ? 'theirs' : 'ours';
  const ch = ctx.choices[e.key];
  if (ch === 'ours' || ch === 'theirs' || ch === 'base' || (isObj(ch) && has(ch, 'value'))) {
    ctx.overrides++; e.choice = ch; e.status = e.auto === 'conflict' ? 'resolved' : 'overridden';
    return (e.result = ch === 'ours' ? o : ch === 'theirs' ? t : ch === 'base' ? b : ch.value);
  }
  e.status = e.auto;
  return (e.result = e.auto === 'theirs' ? t : e.auto === 'ours' ? o : o !== undefined ? o : t);      // undecided: keep whatever exists
}
function mergeText(ctx, p, b, o, t, mode) {            // mode: lines (array, one line each) | string | json (array of anything)
  const prof = ctx.prof, noBase = b === undefined;
  const toLines = v => (mode === 'lines' ? noCR(v) : mode === 'string' ? v.split('\n').map(l => l.replace(/\r$/, '')) : v.map(x => JSON.stringify(x)));
  const A = toLines(o), B = toLines(t), O = noBase ? [] : toLines(b);
  const chunks = chunks3(O, A, B, mode === 'lines' && prof.ignoreWs ? stripWs : l => l, noBase);
  const oc = chunks.some(c => c.t === 'ours' || c.t === 'agree' || c.t === 'conflict'), tc = chunks.some(c => c.t === 'theirs' || c.t === 'agree' || c.t === 'conflict');
  const back = lines => {
    if (mode === 'lines') return restoreCR(o, lines, ctx.crlf);
    if (mode === 'string') return lines.join(/\r\n/.test(o) ? '\r\n' : '\n');
    const ref = new Map(); [t, b || [], o].forEach(arr => arr.forEach(x => ref.set(JSON.stringify(x), x)));
    return keep(o, lines.map(l => (ref.has(l) ? ref.get(l) : JSON.parse(l))));
  };
  if (!oc && !tc) return back(resolveText(chunks).lines);                       // differences in whitespace only
  const e = newEntry(ctx, p, 'text', b, o, t);
  e.mode = mode; e.chunks = chunks; e.lang = prof.lang(p, mode);
  e.auto = chunks.some(c => c.t === 'conflict') ? 'conflict' : oc && tc ? 'merged' : tc ? 'theirs' : 'ours';
  let ch = ctx.choices[e.key];
  if (ch === undefined && ctx.fileRes) { const txt = ctx.fileRes(e); if (txt !== null) ch = { text: txt }; }
  const r = resolveText(chunks, ch);
  e.lines = r.lines; e.marked = r.marked; e.picks = r.picks; e.open = r.open; e.custom = isObj(ch) && typeof ch.text === 'string';
  let value = o;
  try { value = back(r.lines); } catch (err) { e.problem = 'not valid JSON: ' + err.message; }
  if (!e.problem && e.lang === 'javascript' && !r.open) {
    const err = syntaxError(r.lines.join('\n'));
    if (err && !syntaxError(A.join('\n')) && !syntaxError(B.join('\n'))) e.problem = 'the result is not valid JavaScript - ' + err;
  }
  if (ch !== undefined) { e.choice = ch; ctx.overrides++; }
  if (r.open || e.problem) e.status = 'conflict';
  else if (ch !== undefined) e.status = e.auto === 'conflict' ? 'resolved' : 'overridden';
  else e.status = e.auto;
  return (e.result = e.problem ? o : value);
}
const sameKids = (o, out) => (Array.isArray(out) ? Array.isArray(o) && o.length === out.length && out.every((x, i) => x === o[i])
  : (() => { const a = Object.keys(o), b = Object.keys(out); return a.length === b.length && b.every((k, i) => k === a[i] && out[k] === o[k]); })());
const keep = (o, out) => (sameKids(o, out) ? o : out);        // merged container identical to OURS: hand back OURS itself, so its bytes are reused
function occKeys(arr, keyOf) { const seen = new Map(); return arr.map(el => { const k = String(keyOf(el)); const n = (seen.get(k) || 0) + 1; seen.set(k, n); return n === 1 ? k : `${k}\u0000#${n}`; }); }
/* elements the key match missed: pair them by id, then by identical content apart from the key (= a rename) */
function rematch(base, kBase, side, kSide, field, prof) {
  const sideSet = new Set(kSide), baseSet = new Set(kBase);
  const freeB = kBase.map((k, i) => i).filter(i => !sideSet.has(kBase[i]));
  let freeS = kSide.map((k, i) => i).filter(i => !baseSet.has(kSide[i]));
  if (!freeB.length || !freeS.length) return;
  const sig = e => JSON.stringify(Object.assign({}, e, { [field]: undefined }), (k, v) => (prof.volatile.has(k) ? undefined : v));
  const tests = [(b, s) => field !== 'id' && b.id !== undefined && b.id === s.id, (b, s) => Array.isArray(b.item) === Array.isArray(s.item) && sig(b) === sig(s)];
  for (const test of tests) for (const bi of freeB.slice()) {
    const hits = freeS.filter(si => test(base[bi], side[si]));
    if (hits.length !== 1) continue;
    kSide[hits[0]] = kBase[bi];
    freeS = freeS.filter(si => si !== hits[0]); freeB.splice(freeB.indexOf(bi), 1);
  }
}
function mergeList(B, O, T, keyOf, name, p, ctx) {
  const kB = occKeys(B, keyOf), kO = occKeys(O, keyOf), kT = occKeys(T, keyOf);
  rematch(B, kB, O, kO, keyOf.field, ctx.prof); rematch(B, kB, T, kT, keyOf.field, ctx.prof);
  const mB = new Map(kB.map((k, i) => [k, B[i]])), mO = new Map(kO.map((k, i) => [k, O[i]])), mT = new Map(kT.map((k, i) => [k, T[i]]));
  const result = new Map();
  for (const k of new Set([...kO, ...kT, ...kB])) {
    const b = mB.get(k), o = mO.get(k), t = mT.get(k), any = o !== undefined ? o : t !== undefined ? t : b;
    if (o === undefined && t === undefined) continue;                              // gone on both sides
    const seg = { id: k, label: keyOf.label(any) + (k.includes('\u0000') ? ' ' + k.split('\u0000')[1] : ''), list: name };
    const v = o !== undefined && t !== undefined ? mergeValue(b, o, t, p.concat(seg), ctx) : decide(ctx, p.concat(seg), 'element', b, o, t);
    if (v !== undefined) result.set(k, v);
  }
  // order: ours, unless only theirs re-ordered; the other side's additions go next to their neighbours
  const common = new Set(kB.filter(k => mO.has(k) && mT.has(k)));
  const ord = seq => seq.filter(k => common.has(k)).join('\u0001');
  const oursMoved = ord(kO) !== ord(kB), theirsMoved = ord(kT) !== ord(kB);
  if (oursMoved && theirsMoved && ord(kO) !== ord(kT)) ctx.notes.push(`${joinSegs(p) || 'top level'}: both sides re-ordered this list differently - kept OURS order`);
  const [prim, sec] = theirsMoved && !oursMoved ? [kT, kO] : [kO, kT];
  const order = prim.filter(k => result.has(k)), secSet = new Set(sec);
  sec.forEach((k, i) => {
    if (!result.has(k) || order.includes(k)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) { const q = order.indexOf(sec[j]); if (q >= 0) { at = q + 1; break; } }
    while (at < order.length && !secSet.has(order[at])) at++;
    order.splice(at, 0, k);
  });
  return keep(O, order.map(k => result.get(k)));
}
function mergeArr(b, o, t, p, ctx) {
  const name = typeof p[p.length - 1] === 'string' ? p[p.length - 1] : undefined, prof = ctx.prof, B = b || [];
  if (prof.textArray(name, p) && strs(o) && strs(t) && strs(B)) return mergeText(ctx, p, b, o, t, 'lines');
  let keyOf = prof.listKey(name, [B, o, t]);
  if (keyOf === undefined) keyOf = inferKey([B, o, t], prof);
  if (keyOf) return mergeList(B, o, t, keyOf, name, p, ctx);
  if (b !== undefined && B.length === o.length && o.length === t.length) return keep(o, o.map((x, i) => mergeValue(B[i], x, t[i], p.concat({ id: '#' + i, label: String(i), list: name }), ctx)));
  return mergeText(ctx, p, b, o, t, 'json');                                       // no identity: merge the sequence itself
}
function mergeObj(b, o, t, p, ctx) {
  const keys = Object.keys(o);
  Object.keys(t).forEach((k, i, tk) => {
    if (has(o, k)) return;
    const prev = tk.slice(0, i).reverse().find(q => keys.includes(q));
    if (prev !== undefined) keys.splice(keys.indexOf(prev) + 1, 0, k); else keys.push(k);
  });
  const out = {};
  for (const k of keys) { const v = mergeValue(has(b, k) ? b[k] : undefined, has(o, k) ? o[k] : undefined, has(t, k) ? t[k] : undefined, p.concat(k), ctx); if (v !== undefined) setKey(out, k, v); }
  return keep(o, out);
}
function mergeValue(b, o, t, p, ctx) {
  const eq = ctx.eq;
  if (eq(o, t)) return o;
  const k = p[p.length - 1];
  if (typeof k === 'string' && ctx.prof.volatile.has(k)) return o !== undefined ? o : t;
  const mark = ctx.overrides;
  let r;
  if (ctx.prof.atomic(p)) r = decide(ctx, p, 'value', b, o, t);
  else if (isObj(o) && isObj(t) && (b === undefined || isObj(b))) r = mergeObj(b || {}, o, t, p, ctx);
  else if (Array.isArray(o) && Array.isArray(t) && (b === undefined || Array.isArray(b))) r = mergeArr(b, o, t, p, ctx);
  else if (typeof o === 'string' && typeof t === 'string' && (b === undefined || typeof b === 'string') && /\n/.test(o + t)) r = mergeText(ctx, p, b, o, t, 'string');
  else r = decide(ctx, p, 'value', b, o, t);
  if (b !== undefined && mark === ctx.overrides) {            // safety net: if one side never touched this, the answer is simply the other side
    if (eq(b, o) && !eq(r, t)) { ctx.fallbacks++; return t; }
    if (eq(b, t) && !eq(r, o)) { ctx.fallbacks++; return o; }
  }
  return r;
}
/* d: { file, base, ours, theirs (texts; base may be null), choices, fileRes, profile } */
function mergeTexts(d) {
  const ctx = { choices: d.choices || {}, fileRes: d.fileRes, entries: [], keys: new Set(), overrides: 0, fallbacks: 0, notes: [], crlf: false };
  let cst = null, tv, bv;
  try { cst = parseCst(d.ours); tv = JSON.parse(stripBom(d.theirs)); bv = d.base == null || !d.base.trim() ? undefined : JSON.parse(stripBom(d.base)); } catch (e) { cst = null; }
  let text;
  if (cst) {
    ctx.prof = pickProfile(d.file, cst.v, d.profile); ctx.eq = makeEq(ctx.prof.volatile);
    let cr = 0, tot = 0;
    JSON.stringify(cst.v, (k, v) => { if (Array.isArray(v) && ctx.prof.textArray(k) && strs(v)) v.forEach(l => { tot++; if (l.endsWith('\r')) cr++; }); return v; });
    ctx.crlf = cr * 2 > tot;
    const tree = mergeValue(bv, cst.v, tv, [], ctx);
    const em = emitter(d.ours, cst);
    let body = em.emit(tree), good = false;
    try { good = JSON.stringify(JSON.parse(body)) === JSON.stringify(tree); } catch (e) { /* fall through */ }
    if (!good) { ctx.notes.push('could not keep the original layout for this result; wrote it in plain JSON.stringify layout'); body = JSON.stringify(tree, null, em.style.unit || undefined); }
    text = d.ours.slice(0, cst.s) + body + d.ours.slice(cst.e);
  } else {
    ctx.prof = textProfile(d.file); ctx.eq = (a, b) => a === b;
    text = d.ours === d.theirs ? d.ours : mergeText(ctx, [], d.base == null ? undefined : d.base, d.ours, d.theirs, 'string');
  }
  let n = 0;
  for (const e of ctx.entries) if (e.auto === 'conflict') e.n = ++n;
  for (const e of ctx.entries) if (e.auto !== 'conflict' && e.status === 'conflict') e.n = ++n;
  if (ctx.fallbacks) ctx.notes.push(`${ctx.fallbacks} place(s) were taken whole from the side that changed them`);
  return { text, kind: cst ? 'json' : 'text', profile: ctx.prof.name, prof: ctx.prof, entries: ctx.entries, notes: ctx.notes, open: ctx.entries.filter(e => e.status === 'conflict').length };
}
function hint(e) {
  if (e.kind === 'text') {
    const conf = e.chunks.filter(c => c.t === 'conflict').length;
    let add = 0, del = 0;
    e.chunks.forEach(c => { if (c.t === 'same') return; del += (c.base || []).length; add += c.t === 'conflict' ? Math.max(c.ours.length, c.theirs.length) : c.lines.length; });
    return (conf ? `${conf} conflict block${conf > 1 ? 's' : ''}, ` : '') + `+${add} -${del} lines`;
  }
  if (e.kind === 'element') return e.base === undefined ? `added by ${e.ours !== undefined ? 'OURS' : 'THEIRS'}` : e.auto === 'conflict' ? `${e.ours === undefined ? 'OURS' : 'THEIRS'} deleted it, ${e.ours === undefined ? 'THEIRS' : 'OURS'} changed it` : `deleted by ${e.ours === undefined ? 'OURS' : 'THEIRS'}`;
  return e.auto === 'conflict' ? 'both sides set a different value' : `${clip(show(e.base), 40)} -> ${clip(show(e.auto === 'theirs' ? e.theirs : e.ours), 40)}`;
}

/* a compact outline of a value for people to read: no JSON escaping, scripts as plain lines */
function outline(v, prof, ind, key) {
  if (v === null || typeof v !== 'object') return typeof v === 'string' ? (v.includes('\n') ? '|\n' + v.split('\n').map(l => ind + '  ' + l.replace(/\r$/, '')).join('\n') : v) : JSON.stringify(v);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (strs(v) && prof.textArray && prof.textArray(key)) return '|\n' + noCR(v).map(l => ind + '  ' + l).join('\n');
    if (v.every(x => x === null || typeof x !== 'object')) return '[' + v.map(x => JSON.stringify(x)).join(', ') + ']';
    return '\n' + v.map(x => ind + '- ' + outline(x, prof, ind + '  ').replace(/^\n\s*/, '')).join('\n');
  }
  const keys = Object.keys(v);
  return keys.length ? '\n' + keys.map(k => ind + k + ': ' + outline(v[k], prof, ind + '  ', k)).join('\n') : '{}';
}
const readable = (v, prof) => outline(v, prof, '').replace(/^\n/, '').replace(/: \n/g, ':\n');

/* ───────────────────────── git + sessions ───────────────────────── */
const git = args => spawnSync('git', args, { maxBuffer: 1 << 29 });
const gitText = args => { const r = git(args); return r.status === 0 ? r.stdout.toString('utf8').trim() : null; };
function utf8(buf, what) { const s = buf.toString('utf8'); if (!Buffer.from(s, 'utf8').equals(buf)) die(`${what} is not valid UTF-8`); return s; }
const readFile = f => utf8(fs.readFileSync(f), rel(f));
const isFile = f => !!f && fs.existsSync(f) && fs.statSync(f).isFile();
function gitShow(spec) { const r = git(['show', spec]); if (r.status !== 0) die(`git cannot read "${spec}": ${r.stderr.toString().trim().split('\n')[0]}`); return utf8(r.stdout, spec); }
const readSpec = (spec, file) => (isFile(spec) ? readFile(spec) : gitShow(spec.includes(':') ? spec : `${spec}:./${rel(file)}`));
function stageInputs(file) {
  const r = git(['ls-files', '-u', '--', file]);
  if (r.status !== 0) return null;
  const st = {};
  for (const line of r.stdout.toString().split('\n')) { const m = /^\d+ ([0-9a-f]+) ([123])\t/.exec(line); if (m) st[m[2]] = m[1]; }
  if (!st[2] || !st[3]) return null;
  const blob = h => utf8(git(['cat-file', 'blob', h]).stdout, 'git blob ' + h);
  let theirs = 'incoming';
  for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD']) if (gitText(['rev-parse', '-q', '--verify', ref])) { theirs = (gitText(['name-rev', '--name-only', ref]) || ref).replace(/^remotes\//, ''); break; }
  return { mode: 'git', base: st[1] ? blob(st[1]) : null, ours: blob(st[2]), theirs: blob(st[3]), labels: { ours: gitText(['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD', theirs } };
}
function explicitInputs(file, o) {
  if (!o.theirs) die('give the other side: --theirs <branch | file>');
  let base = null;
  if (o.base) {                                             // a file, a git ref, or (from git mergetool) a file that may not exist
    if (isFile(o.base)) base = readFile(o.base);
    else if (o.base.includes(':') || gitText(['rev-parse', '-q', '--verify', o.base + '^{commit}'])) base = readSpec(o.base, file);
  } else if (!isFile(o.theirs) && !isFile(o.ours)) {
    const mb = gitText(['merge-base', o.ours || 'HEAD', o.theirs]);
    if (!mb) die(`git finds no common ancestor of ${o.ours || 'HEAD'} and ${o.theirs}`);
    base = readSpec(mb, file);
  }
  return { mode: 'explicit', base: base === '' ? null : base, ours: o.ours ? readSpec(o.ours, file) : readFile(file), theirs: readSpec(o.theirs, file),
    labels: { ours: o.ours && !isFile(o.ours) ? o.ours : 'ours', theirs: isFile(o.theirs) ? 'theirs' : o.theirs } };
}
function sessionDir(file) {
  const top = gitText(['rev-parse', '--show-toplevel']) || process.cwd();
  const root = path.join(top, '.treemerge');
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
    const ex = gitText(['rev-parse', '--git-path', 'info/exclude']);                              // keep our scratch folder out of `git status` without touching .gitignore
    if (ex && git(['check-ignore', '-q', root]).status !== 0) { try { fs.mkdirSync(path.dirname(ex), { recursive: true }); fs.appendFileSync(ex, '\n.treemerge/\n'); } catch (e) { /* read-only: fine */ } }
  }
  return path.join(root, `${safe(path.basename(file))}-${sha(path.resolve(file))}`);
}
/* a doc = one file being merged: inputs, remembered choices, latest result */
function openDoc(file, inp, o) {
  const doc = { file: path.resolve(file), out: o.out ? path.resolve(o.out) : path.resolve(file), inp, dir: sessionDir(o.out || file), profile: o.profile, preview: inp.mode === 'explicit' && !o.out && !o.write };
  const id = sha([inp.base == null ? '' : inp.base, inp.ours, inp.theirs].join('\u0000')), sf = path.join(doc.dir, 'session.json');
  if (!fs.existsSync(sf) || JSON.parse(fs.readFileSync(sf, 'utf8')).id !== id || o.reset) {
    fs.rmSync(doc.dir, { recursive: true, force: true }); fs.mkdirSync(doc.dir, { recursive: true });
    fs.writeFileSync(path.join(doc.dir, 'ours'), inp.ours); fs.writeFileSync(path.join(doc.dir, 'theirs'), inp.theirs);
    if (inp.base != null) fs.writeFileSync(path.join(doc.dir, 'base'), inp.base);
    fs.writeFileSync(sf, JSON.stringify({ id, mode: inp.mode, labels: inp.labels, file: rel(doc.file) }));
  }
  const cf = path.join(doc.dir, 'choices.json');
  doc.choices = fs.existsSync(cf) ? JSON.parse(fs.readFileSync(cf, 'utf8')) : {};
  return doc;
}
function savedDoc(file, o) {
  const dir = sessionDir(file), sf = path.join(dir, 'session.json');
  if (!fs.existsSync(sf)) return null;
  const s = JSON.parse(fs.readFileSync(sf, 'utf8')), rd = n => (fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n), 'utf8') : null);
  return openDoc(file, { mode: s.mode, labels: s.labels, base: rd('base'), ours: rd('ours'), theirs: rd('theirs') }, o);
}
const conflictFile = (doc, e) => path.join(doc.dir, 'conflicts', `${safe(e.group).slice(0, 40)}_${safe(e.field).slice(0, 24)}_${sha(e.key).slice(0, 6)}.${e.lang === 'javascript' ? 'js' : e.mode === 'json' ? 'jsonl' : 'txt'}`);
const MARK = /^(<<<<<<< |>>>>>>> |=======$|\|\|\|\|\|\|\| )/m;
function runDoc(doc) {
  const genFile = path.join(doc.dir, 'conflicts', '.generated.json');
  const gen = fs.existsSync(genFile) ? JSON.parse(fs.readFileSync(genFile, 'utf8')) : {};
  doc.r = mergeTexts({ file: doc.out, base: doc.inp.base, ours: doc.inp.ours, theirs: doc.inp.theirs, choices: doc.choices, profile: doc.profile,
    fileRes: e => {                                                  // a conflict file somebody edited (no markers left) is that entry's answer
      const f = conflictFile(doc, e);
      if (!fs.existsSync(f)) return null;
      const cur = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
      return MARK.test(cur) || sha(cur) === gen[path.basename(f)] ? null : cur;
    } });
  return doc.r;
}
function saveChoices(doc) { fs.writeFileSync(path.join(doc.dir, 'choices.json'), JSON.stringify(doc.choices, null, 1)); }
function writeConflictFiles(doc) {                                    // for people and agents who would rather edit a file
  const dir = path.join(doc.dir, 'conflicts'), genFile = path.join(dir, '.generated.json');
  const gen = fs.existsSync(genFile) ? JSON.parse(fs.readFileSync(genFile, 'utf8')) : {};
  for (const e of doc.r.entries) {
    if (e.kind !== 'text' || e.status !== 'conflict') continue;
    const f = conflictFile(doc, e);
    e.file = f;
    if (fs.existsSync(f)) continue;
    fs.mkdirSync(dir, { recursive: true });
    const body = e.marked.join('\n'); fs.writeFileSync(f, body); gen[path.basename(f)] = sha(body);
  }
  if (Object.keys(gen).length) fs.writeFileSync(genFile, JSON.stringify(gen));
}
function writeOut(doc) { if (doc.preview) return; const tmp = doc.out + '.treemerge-tmp'; fs.writeFileSync(tmp, doc.r.text); fs.renameSync(tmp, doc.out); }
/* choice coming from a UI: {side} | {hunk, pick} | {text} | {value} | {reset} */
function applyChoice(doc, key, c) {
  const e = doc.r.entries.find(x => x.key === key);
  if (!e) die('that item no longer exists - reload');
  const prev = doc.choices[key];
  if (c.reset) delete doc.choices[key];
  else if (c.side) doc.choices[key] = c.side;
  else if (typeof c.text === 'string') doc.choices[key] = { text: c.text };
  else if (has(c, 'value')) doc.choices[key] = { value: c.value };
  else if (has(c, 'hunk')) {
    const hunks = Object.assign({}, e.picks || {});
    if (c.pick == null) delete hunks[c.hunk]; else hunks[c.hunk] = c.pick;
    if (Object.keys(hunks).length) doc.choices[key] = { hunks }; else delete doc.choices[key];
  }
  if (e.kind !== 'text' && doc.choices[key] === e.auto) delete doc.choices[key];                  // choosing what would happen anyway is not an override
  try { runDoc(doc); } catch (err) { if (prev === undefined) delete doc.choices[key]; else doc.choices[key] = prev; runDoc(doc); throw err; }
  saveChoices(doc);
}

/* ───────────────────────── reports ───────────────────────── */
function summary(doc) {
  const E = doc.r.entries, by = s => E.filter(e => e.status === s).length;
  return { file: rel(doc.out), labels: doc.inp.labels, kind: doc.r.kind, profile: doc.r.profile, preview: doc.preview, mode: doc.inp.mode, notes: doc.r.notes,
    counts: { conflict: by('conflict'), resolved: by('resolved'), theirs: by('theirs'), ours: by('ours'), merged: by('merged'), overridden: by('overridden') },
    entries: E.map(e => ({ key: e.key, n: e.n, group: e.group, field: e.field, kind: e.kind, status: e.status, auto: e.auto, hint: hint(e) })) };
}
function report(doc) {
  const s = summary(doc), c = s.counts, L = [], open = doc.r.entries.filter(e => e.status === 'conflict');
  L.push(`MERGE  ${s.file}     OURS = ${s.labels.ours}     THEIRS = ${s.labels.theirs}     (${s.kind === 'json' ? s.profile + ' rules' : 'plain text, line by line'})`);
  L.push(`  merged automatically: ${c.theirs} from THEIRS, ${c.ours} from OURS, ${c.merged} combined line by line` + (c.overridden ? `, ${c.overridden} overridden by you` : ''));
  s.notes.forEach(n => L.push('  note: ' + n));
  if (!open.length && !c.resolved) L.push('CONFLICTS: none');
  else L.push(`CONFLICTS: ${open.length} need a decision` + (c.resolved ? `   (${c.resolved} already settled)` : ''));
  for (const e of doc.r.entries) {
    if (e.status === 'resolved') { L.push(`  #${e.n}  settled  ${e.group}  >  ${e.field}`); continue; }
    if (e.status !== 'conflict') continue;
    L.push(`  #${e.n}  ${e.group}  >  ${e.field}`, `        ${e.problem || hint(e)}`);
    if (e.kind === 'text') L.push(`        fix:  edit ${rel(e.file || conflictFile(doc, e))}   (remove the <<<<<<< ======= >>>>>>> markers)`);
    else L.push(`        OURS:   ${show(e.ours)}`, `        THEIRS: ${show(e.theirs)}`);
    L.push(`        or:   ${SELF} ${rel(doc.file)} --take-ours ${e.n}   |   --take-theirs ${e.n}`);
  }
  return L.join('\n');
}
function fullReport(doc) {
  const L = [report(doc), '', 'EVERYTHING THAT CHANGED:'];
  let g = null;
  for (const e of doc.r.entries) { if (e.group !== g) { g = e.group; L.push('', g); } L.push(`  [${e.status}] ${e.field}: ${hint(e)}`); }
  return L.join('\n') + '\n';
}

/* ───────────────────────── terminal UI ───────────────────────── */
function lineReader() {
  const rl = require('readline').createInterface({ input: process.stdin });
  const q = [], waiters = []; let closed = false;
  rl.on('line', l => (waiters.length ? waiters.shift()(l) : q.push(l)));
  rl.on('close', () => { closed = true; waiters.splice(0).forEach(w => w(null)); });
  return { ask: text => { process.stdout.write(text); return q.length ? Promise.resolve(q.shift()) : closed ? Promise.resolve(null) : new Promise(r => waiters.push(r)); }, close: () => rl.close() };
}
async function tui(docs) {
  const tty = process.stdout.isTTY, col = (c, s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
  const block = (title, color, lines) => { console.log(col(color, `  ${title}`)); (lines.length ? lines.slice(0, 40) : ['(nothing)']).forEach(l => console.log(col(color, '  | ') + l)); if (lines.length > 40) console.log(col(color, `  | ... ${lines.length - 40} more lines`)); };
  const editor = (text, ext) => {
    const f = path.join(os.tmpdir(), `treemerge-${process.pid}.${ext}`); fs.writeFileSync(f, text);
    const ed = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
    spawnSync(ed, [f], { stdio: 'inherit', shell: true });
    const out = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); fs.rmSync(f, { force: true }); return out;
  };
  const rd = lineReader(), skipped = new Set();
  try {
    for (const doc of docs) {
      for (;;) {
        const open = doc.r.entries.filter(e => e.status === 'conflict'), e = open.find(x => !skipped.has(x.key));
        if (!e) break;
        const hi = e.kind === 'text' ? e.chunks.findIndex((c, i) => c.t === 'conflict' && !has(e.picks, i)) : -1;
        console.log('\n' + col('1', `${rel(doc.out)}  -  conflict #${e.n}  (${open.length} left)`) + `\n${e.group}  >  ${e.field}`);
        if (e.problem) console.log(col('33', '  ' + e.problem));
        let opts;
        if (e.kind === 'text' && hi >= 0) {
          const c = e.chunks[hi];
          if (c.base) block('BASE', '90', c.base);
          block(`OURS (${doc.inp.labels.ours})`, '32', c.ours); block(`THEIRS (${doc.inp.labels.theirs})`, '36', c.theirs);
          opts = '[o]urs  [t]heirs  [b]oth, ours first  [r] both, theirs first  [e]dit  [s]kip  [q]uit';
        } else if (e.kind === 'text') { opts = '[o] all ours  [t] all theirs  [e]dit the whole result  [s]kip  [q]uit'; }
        else { console.log(col('32', `  OURS (${doc.inp.labels.ours}):   `) + show(e.ours)); console.log(col('36', `  THEIRS (${doc.inp.labels.theirs}): `) + show(e.theirs)); opts = '[o]urs  [t]heirs  [s]kip  [q]uit'; }
        const a = ((await rd.ask(`  ${opts} > `)) || 'q').trim().toLowerCase()[0];
        try {
          if (a === 'q') return;
          else if (a === 's') skipped.add(e.key);
          else if (a === 'e' && e.kind === 'text') { if (hi >= 0) applyChoice(doc, e.key, { hunk: hi, pick: { lines: editor(e.chunks[hi].ours.concat(e.chunks[hi].theirs).join('\n'), 'txt').split('\n') } }); else applyChoice(doc, e.key, { text: editor(e.marked.join('\n'), e.lang === 'javascript' ? 'js' : 'txt') }); }
          else if (a === 'o' || a === 't') { const side = a === 'o' ? 'ours' : 'theirs'; applyChoice(doc, e.key, hi >= 0 ? { hunk: hi, pick: side } : { side }); }
          else if ((a === 'b' || a === 'r') && hi >= 0) applyChoice(doc, e.key, { hunk: hi, pick: a === 'b' ? 'ours+theirs' : 'theirs+ours' });
          else console.log('  (not an option)');
        } catch (err) { console.log(col('31', '  ' + err.message)); }
      }
    }
  } finally { rd.close(); }
}

/* ───────────────────────── browser UI (local server, this machine only) ───────────────────────── */
function entryDetail(doc, key, full) {
  const e = doc.r.entries.find(x => x.key === key);
  if (!e) return null;
  const d = { key: e.key, n: e.n, group: e.group, field: e.field, kind: e.kind, status: e.status, auto: e.auto, hint: hint(e), problem: e.problem || null, choice: e.choice === undefined ? null : typeof e.choice === 'string' ? e.choice : Object.keys(e.choice)[0] };
  if (e.kind === 'text') {
    d.mode = e.mode; d.lang = e.lang; d.custom = e.custom;
    d.chunks = e.chunks.map((c, i) => (c.t === 'same' ? (c.lines.length > 9 && !full ? { i, t: 'same', n: c.lines.length, head: c.lines.slice(0, 3), tail: c.lines.slice(-3) } : { i, t: 'same', n: c.lines.length, lines: c.lines })
      : { i, t: c.t, base: c.base, ours: c.t === 'conflict' ? c.ours : undefined, theirs: c.t === 'conflict' ? c.theirs : undefined, lines: c.lines, both: c.t === 'conflict' ? pickLines(c, 'ours+theirs') : undefined, pick: has(e.picks, i) ? e.picks[i] : null, result: has(e.picks, i) ? pickLines(c, e.picks[i]) : c.t === 'conflict' ? null : c.lines }));
    if (full) d.text = e.lines.join('\n');
  } else {
    const pretty = v => (v === undefined ? null : clip(readable(v, doc.r.prof), 80000));
    d.editText = e.result === undefined ? '' : typeof e.result === 'string' ? e.result : JSON.stringify(e.result, null, 2);
    d.base = pretty(e.base); d.ours = pretty(e.ours); d.theirs = pretty(e.theirs); d.result = pretty(e.result);
    d.absent = { base: e.base === undefined, ours: e.ours === undefined, theirs: e.theirs === undefined, result: e.result === undefined };
    d.isString = [e.base, e.ours, e.theirs].every(v => v === undefined || typeof v === 'string');
  }
  return d;
}
function serve(docs, o) {
  const page = path.join(__dirname, 'treemerge.ui.html');
  if (!fs.existsSync(page)) die(`the browser UI needs ${rel(page)} next to treemerge.js (use --tui for the terminal instead)`);
  const token = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    const send = (res, code, body, type) => { const b = typeof body === 'string' ? body : JSON.stringify(body); res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(b); };
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x'), host = String(req.headers.host || '').replace(/:\d+$/, '');
      if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, { error: 'local only' });
      if (u.pathname === '/' && req.method === 'GET') return u.searchParams.get('k') === token ? send(res, 200, fs.readFileSync(page, 'utf8'), 'text/html; charset=utf-8') : send(res, 403, 'open the link printed in the terminal', 'text/plain');
      if (u.searchParams.get('k') !== token) return send(res, 403, { error: 'bad token' });
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 5e7) req.destroy(); });
      req.on('end', () => {
        try {
          const body = raw ? JSON.parse(raw) : {}, doc = docs[+u.searchParams.get('i') || 0];
          if (u.pathname === '/api/docs') return send(res, 200, docs.map((d, i) => { const s = summary(d); return { i, file: s.file, open: s.counts.conflict, labels: s.labels, kind: s.kind, profile: s.profile, preview: s.preview }; }));
          if (u.pathname === '/api/doc') return send(res, 200, summary(doc));
          if (u.pathname === '/api/entry') return send(res, 200, entryDetail(doc, u.searchParams.get('key'), u.searchParams.get('full') === '1') || { error: 'gone' });
          if (u.pathname === '/api/choose' && req.method === 'POST') { applyChoice(doc, body.key, body.choice); return send(res, 200, { doc: summary(doc), entry: entryDetail(doc, body.key, false) }); }
          if (u.pathname === '/api/bulk' && req.method === 'POST') { for (const e of doc.r.entries.filter(x => x.status === 'conflict')) doc.choices[e.key] = body.side; runDoc(doc); saveChoices(doc); return send(res, 200, { doc: summary(doc) }); }
          if (u.pathname === '/api/save' && req.method === 'POST') {
            const msgs = [];
            for (const d of docs) {
              if (d.preview) { msgs.push(`${rel(d.out)}: preview only, not written`); continue; }
              writeOut(d);
              const left = d.r.open;
              if (!left && d.inp.mode === 'git' && body.add !== false) { git(['add', '--', d.out]); d.staged = true; msgs.push(`${rel(d.out)}: saved and marked resolved (git add)`); } else msgs.push(`${rel(d.out)}: saved` + (left ? ` - ${left} conflict(s) still open` : ''));
            }
            return send(res, 200, { ok: true, messages: msgs });
          }
          if (u.pathname === '/api/close' && req.method === 'POST') { send(res, 200, { ok: true }); server.close(); setTimeout(() => resolve(), 50); return; }
          send(res, 404, { error: 'not found' });
        } catch (err) { send(res, 400, { error: err.message }); }
      });
    });
    server.on('error', reject);
    server.listen(+o.port || 0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/?k=${token}`;
      console.log(`\ntreemerge is open in your browser:\n  ${url}\n(decisions are saved as you go; press Ctrl+C here to stop)\n`);
      if (o.onUrl) o.onUrl(url);
      if (!o['no-open']) { const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'; try { spawn(cmd, process.platform === 'win32' ? ['/c', 'start', '', url] : [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch (e) { /* no browser: the link is printed */ } }
    });
  });
}

/* ───────────────────────── commands ───────────────────────── */
function parseArgs(argv) {
  const BOOL = new Set(['ui', 'tui', 'no-ui', 'add', 'abort', 'reset', 'write', 'full', 'no-open', 'help']);
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (BOOL.has(k)) o[k] = true; else { if (argv[i + 1] === undefined) die(`--${k} needs a value`); o[k] = argv[++i]; }
  }
  return o;
}
async function cmdMerge(o) {
  let files = o._.slice();
  if (o.abort) { (files.length ? files : []).forEach(f => fs.rmSync(sessionDir(f), { recursive: true, force: true })); if (!files.length) fs.rmSync(path.dirname(sessionDir('x')), { recursive: true, force: true }); console.log('remembered decisions cleared (your files were not touched)'); return 0; }
  const explicit = !!(o.theirs || o.ours || o.base);
  if (explicit && !files.length) files = [o.out || (isFile(o.ours) ? o.ours : null)].filter(Boolean);
  if (explicit && files.length !== 1) die('with --theirs / --ours / --base, name exactly one file to merge');
  if (!files.length) files = (gitText(['diff', '--name-only', '--relative', '--diff-filter=U']) || '').split('\n').filter(f => f && fs.existsSync(f));
  if (!files.length) die('nothing to merge: no file is in conflict here.\n  merge a branch first (git merge <branch>), name a file, or preview with: ' + SELF + ' <file> --theirs <branch>');
  const docs = [];
  for (const f of files) {
    const doc = explicit ? openDoc(f, explicitInputs(f, o), o) : (() => { const inp = stageInputs(f); return inp ? openDoc(f, inp, o) : savedDoc(f, o); })();
    if (!doc) die(`${f} is not in conflict (and has no merge in progress). Preview a merge with: ${SELF} ${f} --theirs <branch>`);
    runDoc(doc);
    for (const side of ['ours', 'theirs']) {
      const arg = o['take-' + side]; if (!arg) continue;
      const open = doc.r.entries.filter(e => e.n);
      for (const e of arg === 'all' ? open.filter(x => x.status === 'conflict') : String(arg).split(',').map(n => open.find(x => x.n === +n) || die(`${f}: there is no conflict #${n}`))) doc.choices[e.key] = side;
      saveChoices(doc); runDoc(doc);
    }
    docs.push(doc);
  }
  const anyOpen = () => docs.some(d => d.r.open);
  const mode = o['no-ui'] ? 'none' : o.tui ? 'tui' : o.ui ? 'web' : anyOpen() && process.stdout.isTTY && process.stdin.isTTY ? 'web' : 'none';
  docs.forEach(writeOut);
  if (mode === 'web') { try { await serve(docs, o); } catch (e) { if (e instanceof Fail) throw e; console.log(`(could not start the browser UI: ${e.message} - using the terminal)`); await tui(docs); } }
  else if (mode === 'tui') await tui(docs);
  docs.forEach((d, i) => {
    runDoc(d); writeConflictFiles(d); writeOut(d);
    fs.writeFileSync(path.join(d.dir, 'REPORT.txt'), fullReport(d));
    if (i) console.log('\n' + '-'.repeat(70) + '\n');
    console.log(report(d));
    if (d.preview) console.log(`\nPREVIEW ONLY - nothing was written. To do it for real: git merge ${d.inp.labels.theirs}   then   ${SELF}`);
    else if (d.r.open) console.log(`\nNEXT: ${d.r.open} conflict(s) open in ${rel(d.out)}. Run \`${SELF}\` in a terminal for the interactive view, or settle them as shown above. The file is valid but has OURS at those spots - do not commit it yet.`);
    else if (d.inp.mode === 'git') { if (o.add) { git(['add', '--', d.out]); d.staged = true; } console.log(`\nNEXT: ${d.staged ? rel(d.out) + ' is staged (git add done).' : 'git add ' + rel(d.out) + ','} Finish the merge with git commit.`); }
    else console.log(`\nDONE: wrote ${rel(d.out)}`);
    console.log(`(full list of changes: ${rel(path.join(d.dir, 'REPORT.txt'))})`);
  });
  return anyOpen() ? 1 : 0;
}
function cmdDiff(o) {
  let [x, y, z] = o._, file, A, B, la, lb;
  if (isFile(x) && isFile(y) && !z) { file = y; A = readFile(x); B = readFile(y); la = x; lb = y; }
  else { file = x; if (!isFile(file)) die('usage: diff <file> [refA] [refB]     or     diff <fileA> <fileB>'); la = y || 'HEAD'; lb = z || 'working file'; A = readSpec(la, file); B = z ? readSpec(z, file) : readFile(file); }
  const r = mergeTexts({ file, base: A, ours: A, theirs: B });                     // a diff is a merge where OURS never moved
  const want = e => !o.only || (e.group + ' ' + e.field).toLowerCase().includes(String(o.only).toLowerCase());
  console.log(`DIFF  ${rel(file)}     A = ${la}     B = ${lb}     ${r.entries.length} difference(s)`);
  let g = null;
  for (const e of r.entries.filter(want)) {
    if (e.group !== g) { g = e.group; console.log('\n' + g); }
    console.log(`  ${e.kind === 'element' ? (e.theirs === undefined ? '-' : '+') : '~'} ${e.field}: ${e.kind === 'element' ? (e.theirs === undefined ? 'removed' : 'added') : hint(e)}`);
    if (o.full && e.kind === 'text') e.chunks.forEach(c => { if (c.t === 'same') return; (c.base || []).forEach(l => console.log('      - ' + l)); c.lines.forEach(l => console.log('      + ' + l)); });
  }
  if (!r.entries.length) console.log('no differences that matter');
  return 0;
}
function cmdDriver(o) {                       // git config merge.treemerge.driver "node treemerge.js driver %O %A %B %P"
  const [O, A, B, P] = o._;
  if (!A || !B) die('usage: driver %O %A %B %P');
  const inp = { mode: 'git', base: O && fs.existsSync(O) ? fs.readFileSync(O, 'utf8') : null, ours: fs.readFileSync(A, 'utf8'), theirs: fs.readFileSync(B, 'utf8'), labels: { ours: 'ours', theirs: 'theirs' } };
  const r = mergeTexts({ file: P || A, base: inp.base, ours: inp.ours, theirs: inp.theirs });
  fs.writeFileSync(A, r.text);
  console.error(`treemerge: ${P || A}: merged by structure` + (r.open ? ` - ${r.open} real conflict(s) left. Run: ${SELF}` : ''));
  return r.open ? 1 : 0;
}
function cmdInstall(o) {
  const top = gitText(['rev-parse', '--show-toplevel']);
  if (!top) die('not inside a git repository');
  let p = path.relative(top, __filename).split(path.sep).join('/');
  if (p.startsWith('..')) p = __filename.split(path.sep).join('/');
  git(['config', 'merge.treemerge.name', 'structural merge (treemerge)']);
  git(['config', 'merge.treemerge.driver', `node "${p}" driver %O %A %B %P`]);
  git(['config', 'mergetool.treemerge.cmd', `node "${p}" --base "$BASE" --ours "$LOCAL" --theirs "$REMOTE" --out "$MERGED" --ui`]);
  git(['config', 'mergetool.treemerge.trustExitCode', 'true']);
  const pats = o._.length ? o._ : ['*.json'], ga = path.join(top, '.gitattributes');
  let cur = fs.existsSync(ga) ? fs.readFileSync(ga, 'utf8') : '';
  for (const pat of pats) { const line = `${pat} merge=treemerge`; if (!cur.split(/\r?\n/).includes(line)) cur += (cur && !cur.endsWith('\n') ? '\n' : '') + line + '\n'; }
  fs.writeFileSync(ga, cur);
  console.log(`installed for this clone:\n  - git merge / rebase / cherry-pick now merge ${pats.join(', ')} by structure (see .gitattributes; commit it to share the rule)\n  - \`git mergetool -t treemerge\` opens the interactive view for any conflicted file\n  - each teammate runs \`${SELF} install\` once; to undo: git config --remove-section merge.treemerge`);
  return 0;
}
const HELP = `treemerge - interactive 3-way merge that understands structure

  treemerge                         merge every file that is in conflict (after git merge / rebase / cherry-pick)
  treemerge <file>...               only these files
  treemerge <file> --theirs <ref>   preview a merge with a branch; nothing is written (add --write to apply)
  treemerge --base A --ours B --theirs C --out D     merge three plain files
  treemerge diff <file> [refA] [refB]   what differs, in terms of the file's structure   (--full, --only <text>)
  treemerge install [patterns]      let git use it: merge driver for the patterns (default *.json) + mergetool

  how conflicts get settled:
    (default, in a terminal)        opens a local page in your browser: click ours / theirs / both / edit per block
    --tui                           ask in the terminal instead
    --no-ui                         just report; then edit the listed conflict files, or use
    --take-ours 1,3  --take-theirs 2 | all
  other: --ui (open the page even without conflicts, to review)  --add (git add when clean)  --reset  --abort
         --profile postman|json  --port N  --no-open`;
async function cli(argv) {
  const cmd = ['diff', 'install', 'driver', 'merge', 'help'].includes(argv[0]) ? argv[0] : 'merge';
  const o = parseArgs(cmd === argv[0] ? argv.slice(1) : argv);
  if (cmd === 'help' || o.help) { console.log(HELP); return 0; }
  if (cmd === 'diff') return cmdDiff(o);
  if (cmd === 'install') return cmdInstall(o);
  if (cmd === 'driver') return cmdDriver(o);
  return cmdMerge(o);
}
if (require.main === module) cli(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { console.error('treemerge: ' + (e instanceof Fail ? e.message : e.stack || e)); process.exitCode = 2; });
module.exports = { cli, mergeTexts, chunks3, parseCst, emitter, diffOps, openDoc, runDoc, applyChoice, summary, entryDetail, serve };
