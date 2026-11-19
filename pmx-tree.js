'use strict';
/*
 * pmx tree - EXPERIMENTAL whole-collection mode.
 *
 * `pmx unpack` turns only the scripts of a collection into files. This mode turns ALL of it into a folder of small
 * files that you edit (by hand or in a local page), and then builds the collection JSON back from them.
 *
 * The files are a TEMPORARY working copy. The collection JSON stays the thing that is kept and merged:
 *
 *   tree unpack <collection.json>   one definition file per request and per folder, one .js file per script
 *   tree ui                         edit them in a page served from this machine: requests, variables, scripts, diffs, newman
 *   tree status                     what differs from the collection as it was unpacked
 *   tree pack                       build the collection from the files and write it, keeping the file's own layout
 *   tree test                       pack, then run newman on the result
 *   tree finish                     pack, check, and remove the files again (do this before merging)
 *   tree check <collection.json>    measure the round trip of a collection without touching anything
 *
 * It is a separate mode. Nothing here changes what the other pmx commands do; it only reuses their helpers.
 *
 * The files
 *   collection.js                 everything at the top of the collection (info, variables, auth, ...)
 *   collection.prerequest.js      a collection-level script, as plain JavaScript
 *   <Folder>/folder.js            a folder's own fields
 *   <Folder>/<Request>.request.js one request: name, method, URL, headers, body, saved responses, ...
 *   <Folder>/<Request>.test.js    that request's scripts
 *   .pmx-tree.json                which collection this belongs to, and what it looked like when unpacked
 *
 * A definition file is `module.exports = <JSON>;`. It is read as data and never executed. Two markers stand in for
 * what lives in other files: {"$script": "Ping.test.js"} where a script's lines go, and
 * {"$children": ["Ping.request.js", "Staff_picks/"]} where a folder's content goes, in order.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const pmx = require('./pmx.js');
const { rel, safe, sha, stripBom, readStrict, writeAtomic, mergeScript, syntaxError, detectFormat, diffOps, findTestLine } = pmx;

class Problem extends Error {}                   // something the user can fix: reported, never a stack trace
const fail = message => { throw new Problem(message); };

const META = '.pmx-tree.json';
const DEF_START = 'module.exports = ';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const oneKey = (v, key) => isPlain(v) && Object.keys(v).length === 1 && key in v;
const isStrings = v => Array.isArray(v) && v.every(x => typeof x === 'string');
/* The marker that stands for a script in a definition: {"$script": "Ping.test.js"}. Where the files are the source,
 * it can carry two notes, so that the collection can be built from the files alone: "$as": "string" (the collection
 * keeps this script as one text, not as a list of lines) and "$cr": "inner" | "all" | "none" (which of its lines end
 * in a carriage return, when that differs from the rest of the collection). */
const isScriptRef = v => isPlain(v) && typeof v.$script === 'string' && Object.keys(v).every(k => k === '$script' || k === '$as' || k === '$cr');
const crPattern = lines => { const n = lines.length, cr = lines.filter(line => line.endsWith('\r')).length; return cr === 0 ? 'none' : cr === n ? 'all' : cr === n - 1 && !lines[n - 1].endsWith('\r') ? 'inner' : 'mixed'; };
function liftScript(exec, scriptCr) {
  const lines = typeof exec === 'string' ? exec.split('\n') : exec, cr = crPattern(lines), notes = {};
  if (typeof exec === 'string') notes.$as = 'string';
  if (cr !== 'mixed' && cr !== scriptCr && !(lines.length <= 1 && cr === 'none')) notes.$cr = cr;
  return { text: lines.length ? lines.map(line => line.replace(/\r$/, '')).join('\n') + '\n' : '', notes, mixed: cr === 'mixed' };   // the file ends with one line break of its own
}
const canonical = (json, f) => (f.bom ? BOM : '') + JSON.stringify(json, null, f.indent || undefined).replace(/\n/g, f.eol || '\n') + (f.tail || '');
const countTests = code => (code.match(/\bpm\.test\s*\(|\btests\s*\[/g) || []).length;
/* Blank lines at the very end of a script say nothing (editors add and remove a last line break on their own):
 * give `text` the ending of `like`. Every other difference, spaces included, counts as an edit. */
const endBlanks = text => /(\r?\n[ \t]*)*$/.exec(text)[0];
const sameEnd = (text, like) => { const a = text.replace(/\r\n/g, '\n'), b = like.replace(/\r\n/g, '\n'); return a.slice(0, a.length - endBlanks(a).length) + endBlanks(b); };
const sameCode = (a, b) => sameEnd(a, '') === sameEnd(b, '');
const insideCwd = p => { const r = path.relative(process.cwd(), path.resolve(p)); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
const BOM = String.fromCharCode(0xFEFF);

/* ───────────────────────── collection -> files ───────────────────────── */
function split(text, opt = {}) {
  const json = JSON.parse(stripBom(text));
  const source = !!opt.source;
  let scriptCr = opt.scriptCr, mixed = 0;        // how script lines end in this collection: "inner" = a carriage return on every line but the last
  if (source && !scriptCr) {
    let withCr = 0, without = 0;
    JSON.stringify(json, (k, v) => { const lines = k !== 'exec' ? null : isStrings(v) ? v : typeof v === 'string' ? v.split('\n') : null; if (lines && lines.length > 1) { if (crPattern(lines) === 'none') without++; else withCr++; } return v; });
    scriptCr = withCr && withCr >= without ? 'inner' : 'none';
  }
  const files = new Map();                       // relative path (with /) -> content
  const scripts = {};                            // script file -> where its lines sit in the original, e.g. item/0/event/1/script/exec
  const taken = new Map();                       // folder -> names already used there (compared without case)
  const claim = (dir, name) => {                 // "Ping.test.js" -> "Ping~2.test.js" when the name is taken
    if (!taken.has(dir)) taken.set(dir, new Set());
    const used = taken.get(dir), dot = name.indexOf('.'), stem = dot < 0 ? name : name.slice(0, dot), rest = dot < 0 ? '' : name.slice(dot);
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem}~${n}${rest}`;
    used.add(candidate.toLowerCase());
    return candidate;
  };
  const at = (dir, name) => (dir ? dir + '/' + name : name);
  const writeDef = (file, title, value) => files.set(file, defText(title, value));

  // Returns a copy of one node (collection, folder or request) with its scripts and children moved out to files.
  function lift(node, key, dir, scriptStem, names) {
    const copy = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'event' && Array.isArray(v)) {
        copy.event = v.map((ev, i) => {
          const exec = isPlain(ev) && isPlain(ev.script) ? ev.script.exec : undefined;
          if (!isStrings(exec) && typeof exec !== 'string') return ev;
          const file = claim(dir, `${scriptStem}.${safe(ev.listen || 'script')}.js`);
          const lines = typeof exec === 'string' ? exec.split('\n') : exec, body = lines.map(line => line.replace(/\r$/, '')).join('\n');
          const lifted = source ? liftScript(exec, scriptCr) : null, ref = Object.assign({ $script: file }, lifted ? lifted.notes : {});
          if (lifted && lifted.mixed) mixed++;
          files.set(at(dir, file), lifted ? lifted.text : body);
          scripts[at(dir, file)] = { key: [...key, 'event', i, 'script', 'exec'].join('/'), kind: typeof exec === 'string' ? 'string' : 'array' };
          return Object.assign({}, ev, { script: Object.assign({}, ev.script, { exec: ref }) });
        });
      } else if (k === 'item' && Array.isArray(v) && v.every(isPlain)) {
        copy.item = { $children: v.map((child, i) => {
          const childKey = [...key, 'item', i], childNames = names.concat(child.name == null ? `item ${i + 1}` : String(child.name));
          if (Array.isArray(child.item)) {
            const sub = claim(dir, safe(child.name == null ? 'folder' : child.name)), subDir = at(dir, sub);
            taken.set(subDir, new Set(['folder.js']));
            writeDef(at(subDir, 'folder.js'), childNames.join(' / ') + '   (folder)', lift(child, childKey, subDir, 'folder', childNames));
            return sub + '/';
          }
          const file = claim(dir, safe(child.name == null ? 'request' : child.name) + '.request.js');
          writeDef(at(dir, file), childNames.join(' / '), lift(child, childKey, dir, file.slice(0, -'.request.js'.length), childNames));
          return file;
        }) };
      } else copy[k] = v;
    }
    return copy;
  }

  taken.set('', new Set(['collection.js', META]));
  const wrapped = isPlain(json) && isPlain(json.collection) && !json.item;      // some exports wrap everything in {"collection": {...}}
  const top = wrapped ? Object.assign({}, json, { collection: lift(json.collection, ['collection'], '', 'collection', []) }) : lift(json, [], '', 'collection', []);
  writeDef('collection.js', 'the collection itself', top);
  const format = source ? { indent: detectFormat(text).unit, eol: text.includes('\r\n') ? '\r\n' : '\n', bom: text.startsWith(BOM), tail: /\s*$/.exec(text)[0], scriptCr } : undefined;
  return { files, scripts, format, mixed };
}
const defText = (title, value) => `// ${String(title).replace(/[\r\n]+/g, ' ')}\n${DEF_START}${JSON.stringify(value, null, 2)};\n`;

/* ───────────────────────── files -> collection ───────────────────────── */
function parseDef(text, file) {
  const start = text.indexOf(DEF_START), end = text.lastIndexOf(';');
  if (start < 0 || end < start) throw new Problem(`${file}: expected \`${DEF_START}{ ... };\``);
  let value;
  try { value = JSON.parse(text.slice(start + DEF_START.length, end)); } catch (e) { throw new Problem(`${file}: the part after \`${DEF_START}\` is not valid JSON (${e.message})`); }
  if (!isPlain(value)) throw new Problem(`${file}: expected an object after \`${DEF_START}\``);
  return value;
}
/* The path of a tree file, after making sure it really is inside the tree. No step of the path may be a link, whether
 * or not the link's target exists, so nothing outside the tree is ever read into the collection or written to. */
function inTree(treeDir, file) {
  const parts = String(file).split('/').filter(part => part && part !== '.');
  if (parts.includes('..')) throw new Problem(`${file} leads outside the tree - refused`);
  let at = treeDir;
  for (let i = 0; i < parts.length; i++) {
    at = path.join(at, parts[i]);
    const found = fs.lstatSync(at, { throwIfNoEntry: false });
    if (!found) break;
    if (found.isSymbolicLink()) throw new Problem(`${file} ${i === parts.length - 1 ? 'is a link, not a file' : 'is reached through a link'} - refused`);
  }
  return path.join(treeDir, ...parts);
}
/* Is this path inside the current folder once every link on the way is followed? A path that does not exist yet is
 * judged by the nearest folder that does. */
function reallyInsideCwd(p) {
  let probe = path.resolve(p);
  while (!fs.lstatSync(probe, { throwIfNoEntry: false }) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  try { const r = path.relative(fs.realpathSync(process.cwd()), fs.realpathSync(probe)); return !r.startsWith('..') && !path.isAbsolute(r); } catch (e) { return false; }
}
const isLink = p => { const found = fs.lstatSync(p, { throwIfNoEntry: false }); return !!found && found.isSymbolicLink(); };
function readDef(treeDir, file) {
  const abs = inTree(treeDir, file);
  if (!fs.existsSync(abs)) throw new Problem(`${file} is missing`);
  return parseDef(fs.readFileSync(abs, 'utf8'), file);
}
const stays = (dir, name) => {                   // a pointer must name something inside the tree, never a path that climbs out
  if (typeof name !== 'string' || !name || path.posix.isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.includes('\\') || name.includes('\0')) throw new Problem(`"${name}" points outside the tree`);
  const joined = path.posix.normalize(dir ? dir + '/' + name : name).replace(/\/$/, '');
  if (joined === '..' || joined.startsWith('../') || joined === '.' || joined === '') throw new Problem(`"${name}" points outside the tree`);
  return joined;
};

function build(treeDir, manifest, baseText, opt = {}) {
  const src = opt.source || null;                // { format, head }: the files are the source; head = each file as it is in the last commit
  const base = src ? null : JSON.parse(stripBom(baseText));
  const originalExec = key => key.split('/').reduce((v, k) => (v == null ? v : v[k]), base);
  let withCr = 0, total = 0;
  JSON.stringify(base, (k, v) => { if (k === 'exec' && isStrings(v)) v.forEach(line => { total++; if (line.endsWith('\r')) withCr++; }); return v; });
  const crlf = withCr * 2 > total;
  const errors = [], changed = [], ignored = [], open = new Set();
  const readFile = opt.read || (file => { const abs = inTree(treeDir, file); return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null; });
  const defOf = file => { const text = readFile(file); if (text == null) throw new Problem(`${file} is missing`); return parseDef(text, file); };

  function scriptLines(file, ref) {
    const text = readFile(file);
    if (text == null) throw new Problem(`${file} is missing`);
    if (src) {
      const code = text.replace(/\r\n/g, '\n'), body = code.endsWith('\n') ? code.slice(0, -1) : code;       // the file's own last line break is not part of the script
      const lines = code === '' ? [] : body.split('\n'), before = src.head.get(file);
      if (before === undefined || before.replace(/\r\n/g, '\n') !== code) {           // new, or edited since the last commit: checked like any edit
        changed.push(file);
        const problem = syntaxError(body, file);
        if (problem) errors.push('SYNTAX ERROR ' + problem);
        const had = before === undefined ? 0 : countTests(before), has = countTests(body);
        if (has < had && !opt.allowTestRemoval) errors.push(`${file}: number of pm.test(...) calls dropped from ${had} to ${has} since ${src.since || 'the last commit'}. Tests must not be removed. (A human can override with --allow-test-removal.)`);
      }
      const cr = ['all', 'none', 'inner'].includes(ref.$cr) ? ref.$cr : src.format.scriptCr;
      const out = lines.map((line, i) => line + (cr === 'all' || (cr === 'inner' && i < lines.length - 1) ? '\r' : ''));
      return ref.$as === 'string' ? out.join('\n') : out;
    }
    const known = manifest.scripts[file];
    const before = known ? originalExec(known.key) : undefined;
    if (before === undefined) {                  // a script that was not in the collection when it was unpacked
      const lines = sameEnd(text, '').split('\n').map(line => line.replace(/\r$/, ''));
      const problem = syntaxError(lines.join('\n'), file);
      if (problem) errors.push('SYNTAX ERROR ' + problem);
      changed.push(file);
      return crlf ? lines.map((line, i) => (i < lines.length - 1 ? line + '\r' : line)) : lines;
    }
    const was = typeof before === 'string' ? before.split('\n') : before;
    const m = mergeScript(was, opt.ignoreWs ? text : sameEnd(text, was.map(line => line.replace(/\r$/, '')).join('\n')), { keepWs: !opt.ignoreWs, defaultCrlf: crlf });
    if (!m.changed && opt.ignoreWs && !sameCode(text, was.map(line => line.replace(/\r$/, '')).join('\n'))) ignored.push(file);
    if (m.changed) {
      changed.push(file);
      const code = m.lines.map(line => line.replace(/\r$/, '')).join('\n');
      const problem = syntaxError(code, file);
      if (problem) errors.push('SYNTAX ERROR ' + problem);
      const had = countTests(m.origN.join('\n')), has = countTests(code);
      if (has < had && !opt.allowTestRemoval) errors.push(`${file}: number of pm.test(...) calls dropped from ${had} to ${has}. Tests must not be removed. (A human can override with --allow-test-removal.)`);
    }
    return typeof before === 'string' ? m.lines.join('\n') : m.lines;
  }

  function fill(copy, dir) {
    const node = {};
    for (const [k, v] of Object.entries(copy)) {
      if (k === 'event' && Array.isArray(v)) {
        node.event = v.map(ev => {
          if (!isPlain(ev) || !isPlain(ev.script) || !isScriptRef(ev.script.exec)) return ev;
          return Object.assign({}, ev, { script: Object.assign({}, ev.script, { exec: scriptLines(stays(dir, ev.script.exec.$script), ev.script.exec) }) });
        });
      } else if (k === 'item' && oneKey(v, '$children')) {
        if (!Array.isArray(v.$children)) throw new Problem('$children must be a list of file and folder names');
        node.item = v.$children.map(child => {
          const target = stays(dir, child);
          if (!String(child).endsWith('/')) {
            const own = path.posix.dirname(target);                // a request's script pointers are relative to its own file
            return fill(defOf(target), own === '.' ? '' : own);
          }
          if (open.has(target)) throw new Problem(`the folder ${target}/ contains itself`);
          open.add(target);
          const folder = fill(defOf(target + '/folder.js'), target);
          open.delete(target);
          return folder;
        });
      } else node[k] = v;
    }
    return node;
  }

  let json;
  try {
    const top = defOf('collection.js');
    json = isPlain(top.collection) && !top.item ? Object.assign({}, top, { collection: fill(top.collection, '') }) : fill(top, '');
  } catch (e) { if (!(e instanceof Problem)) throw e; errors.push(e.message); }
  return { json, base, errors, changed, ignored };
}

/* Turn the built collection into text. Where the original text is known, only what changed is laid out again and every
 * other byte is copied from it (treemerge's writer does that: the original is "ours", the built collection is "theirs"). */
function render(baseText, base, json, file) {
  if (same(json, base)) return { text: baseText, how: 'unchanged' };
  const unit = detectFormat(baseText).unit;
  const plain = () => (baseText.startsWith(BOM) ? BOM : '') + JSON.stringify(json, null, unit || undefined);
  let merged = null;
  try { merged = require('./treemerge.js').mergeTexts({ file, base: baseText, ours: baseText, theirs: JSON.stringify(json) }); } catch (e) { /* no treemerge next to pmx: plain layout */ }
  if (merged && !merged.open) { try { if (same(JSON.parse(stripBom(merged.text)), json)) return { text: merged.text, how: 'layout kept' }; } catch (e) { /* fall through */ } }
  return { text: plain(), how: 'written in plain JSON layout (the original layout could not be kept for this change)' };
}

/* ───────────────────────── the working copy ─────────────────────────
 * A tree folder carries a small note (.pmx-tree.json): which collection it belongs to and the fingerprint of that
 * collection when it was unpacked. With that, the folder can sit in the scratch area or be committed on a branch. */
function findTrees() {
  const found = [], skip = new Set(['node_modules', '.git']);
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    if (entries.some(e => e.isFile() && e.name === META)) { found.push(dir); return; }
    if (depth < 4) for (const e of entries) if (e.isDirectory() && !skip.has(e.name)) walk(path.join(dir, e.name), depth + 1);
  };
  walk(process.cwd(), 0);
  return found;
}
function readMeta(treeDir) {
  const file = inTree(treeDir, META);
  if (!fs.existsSync(file)) fail(`${rel(treeDir)} is not an unpacked collection (it has no ${META}). Run: ${pmx.SELF} tree unpack <collection.json>`);
  let meta;
  try { meta = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(`${rel(file)} is not valid JSON`); }
  const sound = isPlain(meta) && (meta.role === 'source' ? isPlain(meta.format) : typeof meta.baseSha === 'string');
  if (!sound || typeof meta.collection !== 'string' || !/\.json$/i.test(meta.collection) || !insideCwd(meta.collection)) fail(`${rel(file)} does not name a collection inside this folder. Run tree unpack again.`);
  return meta;
}
function openTree(o = {}) {
  let treeDir = o.tree ? path.resolve(o.tree) : null;
  if (!treeDir) {
    let found = findTrees();
    if (o.collection) found = found.filter(dir => { try { return path.resolve(readMeta(dir).collection) === path.resolve(o.collection); } catch (e) { return false; } });
    if (!found.length) { const none = new Problem(`nothing is unpacked here yet. Run: ${pmx.SELF} tree unpack <collection.json>`); none.nothingUnpacked = true; throw none; }
    if (found.length > 1) fail('more than one collection is unpacked here - say which with --tree <folder>:\n  ' + found.map(rel).join('\n  '));
    treeDir = found[0];
  }
  if (!insideCwd(treeDir) || !reallyInsideCwd(treeDir)) fail('the tree folder must be inside the current folder');
  const meta = readMeta(treeDir);
  if (!reallyInsideCwd(meta.collection) || isLink(meta.collection)) fail(`${rel(path.join(treeDir, META))} names a collection that is a link or is reached through one - refused`);
  const ctx = pmx.getCtx({ collection: meta.collection }, undefined);
  const ws = { treeDir, meta, collection: ctx.collection, baseCopy: ctx.f('tree-base.json'), packCopy: ctx.f('tree-pack.json') };
  if (meta.role === 'source') { ws.role = 'source'; ws.packCopy = ctx.f('tree-built.json'); ws.baseText = null; sourceBaseline(ws); return ws; }
  ws.baseText = findBase(ws);
  ws.orig = split(ws.baseText);
  return ws;
}
/* ───────────────────────── the files as the source ─────────────────────────
 * After `tree adopt` the folder is what is kept, reviewed and merged, and the collection JSON is generated from it.
 * "What changed" is then counted from the last commit: git is asked for the files as they are there. */
function headFiles(treeDir) {                    // file -> text as in the last commit; null when git does not know the folder
  const ls = spawnSync('git', ['ls-tree', '-r', '-z', 'HEAD', '--', rel(treeDir) + '/'], { maxBuffer: 1 << 28 });
  if (ls.status !== 0) return null;
  const prefix = rel(treeDir).split(path.sep).join('/') + '/';
  const blobs = ls.stdout.toString('utf8').split('\0').filter(Boolean).map(entry => /^(\d+) blob ([0-9a-f]+)\t(.*)$/s.exec(entry)).filter(m => m && m[1] !== '120000' && m[3].startsWith(prefix));
  if (!blobs.length) return null;
  const out = spawnSync('git', ['cat-file', '--batch'], { input: blobs.map(m => m[2]).join('\n') + '\n', maxBuffer: 1 << 30 });
  if (out.status !== 0) return null;
  const files = new Map();
  let at = 0;
  for (const m of blobs) {
    const lineEnd = out.stdout.indexOf(10, at), size = Number(out.stdout.slice(at, lineEnd).toString('utf8').split(' ')[2]);
    if (!Number.isFinite(size)) return null;
    const name = m[3].slice(prefix.length);
    if (name !== META) files.set(name, out.stdout.slice(lineEnd + 1, lineEnd + 1 + size).toString('utf8').replace(/\r\n/g, '\n'));
    at = lineEnd + 1 + size + 1;
  }
  return files;
}
const headSha = () => { const r = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; };
const atHead = file => { const r = spawnSync('git', ['cat-file', '--filters', 'HEAD:./' + rel(file).split(path.sep).join('/')], { maxBuffer: 1 << 29 }); return r.status === 0 ? r.stdout.toString('utf8') : null; };
function sourceBaseline(ws) {
  ws.head = headSha();
  const committed = ws.head ? headFiles(ws.treeDir) : null;
  if (committed) { ws.orig = { files: committed, scripts: {} }; ws.since = 'the last commit'; return; }
  let files = null;                              // not committed yet: count from what the collection JSON says
  try { const text = readIf(ws.collection); if (text != null) files = split(text, { source: true, scriptCr: ws.meta.format.scriptCr }).files; } catch (e) { files = null; }
  ws.orig = { files: files || new Map(), scripts: {} };
  ws.since = files ? 'the collection JSON (the folder is not committed yet)' : 'nothing (the folder is not committed yet)';
}
const buildFiles = (ws, opt) => build(ws.treeDir, { scripts: {} }, null, Object.assign({}, opt, { source: { format: ws.meta.format, head: ws.orig.files, since: ws.since } }));

/* Generate the collection JSON from the files. The file keeps its layout where it has one; only what changed moves.
 * A JSON that somebody edited directly (it is neither what was built here last nor the committed version) is not
 * overwritten: `tree import` takes such changes into the files. A JSON that cannot be read (merge marks) is built anew. */
function buildSource(ws, opt = {}) {
  const b = buildFiles(ws, opt);
  if (b.errors.length) return { errors: b.errors };
  const onDisk = fs.existsSync(ws.collection) ? readStrict(ws.collection) : null;
  let was;
  try { was = onDisk == null ? undefined : JSON.parse(stripBom(onDisk)); } catch (e) { was = undefined; }
  const current = was !== undefined && same(was, b.json);
  if (!current && was !== undefined && !opt.force && onDisk !== readIf(ws.packCopy) && onDisk !== atHead(ws.collection)) {
    return { errors: [`${rel(ws.collection)} was edited directly: it is neither what was built from the files last nor the committed version.\n  Take its changes into the files with \`${pmx.SELF} tree import\`, or overwrite it with \`${pmx.SELF} tree build --force\`.`], edited: true };
  }
  const out = current ? { text: onDisk, how: 'up to date' } : was !== undefined ? render(onDisk, was, b.json, ws.collection) : { text: canonical(b.json, ws.meta.format), how: onDisk == null ? 'written new' : 'written new: the file could not be read as JSON (merge marks?)' };
  if (!opt.dry) {
    if (onDisk !== out.text) writeAtomic(ws.collection, out.text);
    cache(ws.packCopy, out.text);
  }
  const ops = diffOps((onDisk || '').split('\n'), out.text.split('\n'));
  return { errors: [], text: out.text, how: out.how, json: b.json, scripts: b.changed, ignored: [], added: ops.filter(x => x[0] === '+').length, removed: ops.filter(x => x[0] === '-').length, ops, base: onDisk || '', source: true };
}

/* Make a folder of files the source of a collection. The collection file itself is not touched. */
function adoptTree(o, collectionArg) {
  const ctx = pmx.getCtx({ collection: o.collection }, collectionArg);
  if (!fs.existsSync(ctx.collection)) fail(`no such file: ${rel(ctx.collection)}`);
  const text = readStrict(ctx.collection);
  const parsed = JSON.parse(stripBom(text)), top = isPlain(parsed) && isPlain(parsed.collection) && !parsed.item ? parsed.collection : parsed;
  if (!isPlain(top) || !Array.isArray(top.item)) fail(`${rel(ctx.collection)} does not look like a Postman collection (no "item" list)`);
  if (!insideCwd(ctx.collection) || !reallyInsideCwd(ctx.collection) || isLink(ctx.collection)) fail('the collection must be a file inside the current folder');
  const name = path.basename(ctx.collection).replace(/(\.postman_collection)?\.json$/i, '');
  const treeDir = o.tree ? path.resolve(o.tree) : path.join(path.dirname(ctx.collection), safe(name));
  if (!insideCwd(treeDir) || !reallyInsideCwd(treeDir)) fail('the folder must be inside the current folder');
  if (fs.existsSync(treeDir) && fs.readdirSync(treeDir).length) fail(`${rel(treeDir)}/ exists and is not empty. Name a new folder with --tree <folder>.` + (fs.existsSync(path.join(treeDir, META)) ? ` (To take a collection into files that are already the source, use \`${pmx.SELF} tree import\`.)` : ''));
  const parts = split(text, { source: true });
  writeFiles(treeDir, parts.files);
  const ws = { treeDir, role: 'source', collection: ctx.collection, packCopy: ctx.f('tree-built.json'), meta: { version: 2, role: 'source', collection: rel(ctx.collection).split(path.sep).join('/'), format: parts.format } };
  saveMeta(ws);
  cache(ws.packCopy, text);
  sourceBaseline(ws);
  const dry = buildSource(ws, { dry: true });
  const names = [...parts.files.keys()];
  return { treeDir, collection: ctx.collection, files: parts.files.size, requests: names.filter(f => f.endsWith('.request.js')).length, folders: names.filter(f => f.endsWith('/folder.js')).length, scripts: Object.keys(parts.scripts).length,
    exact: !dry.errors.length && dry.text === text, moves: dry.errors.length ? null : dry.added + dry.removed, mixed: parts.mixed, errors: dry.errors };
}

/* Take a collection JSON into the files: the collection file itself after somebody edited it, or an export from
 * Postman. What the files changed since the last commit is kept and merged with it; a clash is refused. The files are
 * then written again from the result, and the collection file is built from them. */
function importTree(ws, from, opt = {}) {
  const file = from ? path.resolve(from) : ws.collection;
  if (!fs.existsSync(file)) fail(`no such file: ${rel(file)}`);
  const theirsText = readStrict(file);
  let theirs;
  try { theirs = JSON.parse(stripBom(theirsText)); } catch (e) { fail(`${rel(file)} is not valid JSON (${e.message})`); }
  const top = isPlain(theirs) && isPlain(theirs.collection) && !theirs.item ? theirs.collection : theirs;
  if (!isPlain(top) || !Array.isArray(top.item)) fail(`${rel(file)} does not look like a Postman collection (no "item" list)`);
  const b = buildFiles(ws, { allowTestRemoval: true });
  if (b.errors.length && !opt.theirs) return { errors: b.errors };
  if (!b.errors.length && same(theirs, b.json)) return { errors: [], same: true };
  let text = theirsText, how = 'taken as it is';
  if (!opt.theirs) {
    const committed = ws.head ? headFiles(ws.treeDir) : null;
    const was = committed ? build(ws.treeDir, { scripts: {} }, null, { allowTestRemoval: true, read: f => (committed.has(f) ? committed.get(f) : null), source: { format: ws.meta.format, head: committed } }) : null;
    const baseText = was && !was.errors.length ? canonical(was.json, ws.meta.format) : readIf(ws.packCopy);
    if (baseText == null) return { errors: [`there is no earlier version to compare with (the folder is not committed, and nothing was built here yet).\n  Import with --theirs to take ${rel(file)} as it is; edits in the files that are not in it are lost.`] };
    let merged = null;
    try { merged = require('./treemerge.js').mergeTexts({ file: ws.collection, base: baseText, ours: theirsText, theirs: canonical(b.json, ws.meta.format) }); } catch (e) { merged = null; }
    if (!merged || merged.open) return { errors: [`${merged ? merged.open + ' place(s) were' : 'something was'} changed both in ${rel(file)} and in the files since ${ws.since}. The two cannot be combined automatically.\n  Commit or undo the edits in the files first, or import with --theirs to take ${rel(file)} as it is (the edits in the files are lost).`] };
    text = merged.text; how = 'merged with the edits in the files';
  }
  const target = JSON.parse(stripBom(text));
  const touched = syncFiles(ws, target);
  let again = buildFiles(ws, { allowTestRemoval: true });
  if (again.errors.length || (!touched.mixed && !same(again.json, target))) {     // should not happen; then the folder is written anew, which is always right
    const fresh = split(text, { source: true, scriptCr: ws.meta.format.scriptCr });
    const extra = describe(ws).unlisted.filter(f => !fresh.files.has(f)).map(f => [f, readText(ws, f)]);
    for (const f of treeFiles(ws.treeDir)) fs.rmSync(inTree(ws.treeDir, f), { force: true });
    writeFiles(ws.treeDir, fresh.files);
    writeFiles(ws.treeDir, extra.filter(([, t]) => t != null));
    how += '; the files were written anew, so some have new names';
    again = buildFiles(ws, { allowTestRemoval: true });
  }
  (function prune(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) { prune(path.join(dir, e.name)); if (!fs.readdirSync(path.join(dir, e.name)).length) fs.rmdirSync(path.join(dir, e.name)); } })(ws.treeDir);
  const built = buildSource(ws, { force: true, allowTestRemoval: true });
  return { errors: built.errors, how, files: touched.written.length + touched.removed.length, written: touched.written, removed: touched.removed, mixed: touched.mixed };
}

/* Bring the files to say what `target` (a collection) says, touching as few of them as possible. A request, folder or
 * script that is still there keeps its file, also under a new name; what is new gets a new file; what is gone is removed. */
function syncFiles(ws, target) {
  const fmt = ws.meta.format, written = [], removed = [];
  let mixed = 0;
  const put = (file, text) => { if (readText(ws, file) !== text) { writeText(ws, file, text); written.push(file); } };
  const drop = file => { const abs = inTree(ws.treeDir, file); if (fs.lstatSync(abs, { throwIfNoEntry: false })) { fs.rmSync(abs, { recursive: true, force: true }); removed.push(file); } };
  const at = (dir, name) => (dir ? dir + '/' + name : name);
  const up = p => (path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p));
  const defIf = file => { try { return readText(ws, file) == null ? null : readDef(ws.treeDir, file); } catch (e) { if (!(e instanceof Problem)) throw e; return null; } };
  const refs = (body, dir) => (Array.isArray(body.event) ? body.event : []).filter(ev => isPlain(ev) && isPlain(ev.script) && isScriptRef(ev.script.exec))
    .map(ev => { try { return { listen: String(ev.listen || 'script'), file: stays(dir, ev.script.exec.$script), used: false }; } catch (e) { return null; } }).filter(Boolean);
  const liftable = ev => isPlain(ev) && isPlain(ev.script) && (isStrings(ev.script.exec) || typeof ev.script.exec === 'string');

  function dropNode(c) {
    if (c.kind === 'folder') { drop(c.target); return; }
    const def = defIf(c.id);
    if (def) refs(def, up(c.target)).forEach(r => drop(r.file));
    drop(c.id);
  }
  function node(id, dir, kind, json, names) {      // id: the definition file (it may not exist yet); json: the node as the collection has it
    const now = defIf(id), nowBody = now ? bodyOf(now, kind) : {};
    const wrapped = kind === 'collection' && isPlain(json.collection) && !json.item, from = wrapped ? json.collection : json;
    const had = refs(nowBody, dir), def = {};
    const stem = kind === 'collection' ? 'collection' : kind === 'folder' ? 'folder' : path.posix.basename(id).replace(/\.request\.js$/, '');
    for (const [k, v] of Object.entries(from)) {
      if (k === 'event' && Array.isArray(v)) {
        def.event = v.map(ev => {
          if (!liftable(ev)) return ev;
          const listen = String(ev.listen || 'script'), slot = had.find(x => !x.used && x.listen === listen);
          if (slot) slot.used = true;
          const file = slot ? slot.file : at(dir, freeName(ws, dir, stem, `.${safe(listen)}.js`));
          const lifted = liftScript(ev.script.exec, fmt.scriptCr);
          if (lifted.mixed) mixed++;
          put(file, lifted.text);
          return Object.assign({}, ev, { script: Object.assign({}, ev.script, { exec: Object.assign({ $script: dir ? path.posix.relative(dir, file) : file }, lifted.notes) }) });
        });
      } else if (k === 'item' && kind !== 'request' && Array.isArray(v) && v.every(isPlain)) {
        const listed = isPlain(nowBody.item) && Array.isArray(nowBody.item.$children) ? nowBody.item.$children : [];
        const there = listed.map(pointer => {
          try {
            const target = stays(dir, pointer), folder = String(pointer).endsWith('/'), cid = folder ? target + '/folder.js' : target, d = defIf(cid);
            return { pointer, target, id: cid, kind: folder ? 'folder' : 'request', name: d && d.name != null ? String(d.name) : null, used: false };
          } catch (e) { if (!(e instanceof Problem)) throw e; return null; }
        }).filter(Boolean);
        const wanted = v.map(child => ({ json: child, kind: Array.isArray(child.item) ? 'folder' : 'request', name: child.name == null ? null : String(child.name), hit: null }));
        for (const w of wanted) { const c = there.find(x => !x.used && x.kind === w.kind && x.name === w.name); if (c) { c.used = true; w.hit = c; } }
        for (const sort of ['folder', 'request']) {      // what is left over on both sides in equal number: the same things under new names
          const left = there.filter(x => !x.used && x.kind === sort), open = wanted.filter(w => !w.hit && w.kind === sort);
          if (left.length && left.length === open.length) open.forEach((w, i) => { left[i].used = true; w.hit = left[i]; });
        }
        def.item = { $children: wanted.map((w, i) => {
          const childNames = names.concat(w.name == null ? `item ${i + 1}` : w.name);
          if (w.hit) { node(w.hit.id, w.kind === 'folder' ? w.hit.target : up(w.hit.target), w.kind, w.json, childNames); return w.hit.pointer; }
          if (w.kind === 'folder') {
            const sub = freeName(ws, dir, safe(w.name == null ? 'folder' : w.name), '');
            fs.mkdirSync(inTree(ws.treeDir, at(dir, sub)), { recursive: true });
            node(at(dir, sub) + '/folder.js', at(dir, sub), 'folder', w.json, childNames);
            return sub + '/';
          }
          const file = freeName(ws, dir, safe(w.name == null ? 'request' : w.name), '.request.js');
          node(at(dir, file), dir, 'request', w.json, childNames);
          return file;
        }) };
        there.filter(x => !x.used).forEach(dropNode);
      } else def[k] = v;
    }
    had.filter(x => !x.used).forEach(x => drop(x.file));
    const first = String(readText(ws, id) || '').split('\n')[0];
    const title = first.startsWith('//') ? first.slice(2).trim() : kind === 'collection' ? 'the collection itself' : names.join(' / ') + (kind === 'folder' ? '   (folder)' : '');
    put(id, defText(title, wrapped ? Object.assign({}, json, { collection: def }) : def));
  }
  node('collection.js', '', 'collection', target, []);
  return { written, removed, mixed };
}

/* The collection as it was when the tree was unpacked: from the scratch copy, from the file itself if it is still
 * untouched, or from git's history. */
function findBase(ws) {
  const fits = text => text != null && sha(text) === ws.meta.baseSha;
  let text = readIf(ws.baseCopy);
  if (fits(text)) return text;
  text = readIf(ws.collection);
  if (fits(text)) return cache(ws.baseCopy, text);
  text = gitBlobText(ws.meta.baseBlob, ws.collection);
  if (fits(text)) return cache(ws.baseCopy, text);
  return fail(`cannot find ${rel(ws.collection)} as it was when ${rel(ws.treeDir)}/ was unpacked: not in the scratch folder (.pmx/), not on disk, not in git.\nIt was probably not committed when the files were unpacked. On the machine that unpacked it, the commands still work.\nOtherwise unpack again with --force (the edits in ${rel(ws.treeDir)}/ are then lost).`);
}
const BLOB = /^[0-9a-f]{40,64}$/;
const gitBlobOf = (text, file) => { const r = spawnSync('git', ['hash-object', '--stdin', '--path', rel(file)], { input: text, encoding: 'utf8' }); return r.status === 0 && BLOB.test(r.stdout.trim()) ? r.stdout.trim() : null; };
const gitBlobText = (blob, file) => { if (!BLOB.test(blob || '')) return null; const r = spawnSync('git', ['cat-file', '--filters', '--path', rel(file), blob], { maxBuffer: 1 << 29 }); return r.status === 0 ? r.stdout.toString('utf8') : null; };
const gitHas = blob => BLOB.test(blob || '') && spawnSync('git', ['cat-file', '-e', blob]).status === 0;
const readIf = file => { try { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; } catch (e) { return null; } };
const cache = (file, text) => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); if (readIf(file) !== text) fs.writeFileSync(file, text); } catch (e) { /* only a cache */ } return text; };
/* What the last pack wrote, if it can still be found: the scratch copy, or git. */
function lastPack(ws) {
  const fits = text => text != null && sha(text) === ws.meta.lastPackSha;
  if (!ws.meta.lastPackSha) return null;
  let text = readIf(ws.packCopy);
  if (fits(text)) return text;
  text = gitBlobText(ws.meta.lastPackBlob, ws.collection);
  return fits(text) ? cache(ws.packCopy, text) : null;
}
function rememberPack(ws, text) {
  cache(ws.packCopy, text);
  if (ws.meta.lastPackSha === sha(text)) return;
  ws.meta = Object.assign({}, ws.meta, { lastPackSha: sha(text), lastPackBlob: gitBlobOf(text, ws.collection) });
  saveMeta(ws);
}
const saveMeta = ws => writeAtomic(inTree(ws.treeDir, META), JSON.stringify(ws.meta, null, 1) + '\n');
const buildTree = (ws, opt) => build(ws.treeDir, { scripts: ws.orig.scripts }, ws.baseText, opt);
const writeFiles = (dir, files) => { for (const [file, content] of files) { const abs = path.join(dir, file); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content); } };

function unpackTree(o, collectionArg) {
  const ctx = pmx.getCtx({ collection: o.collection }, collectionArg);
  if (!fs.existsSync(ctx.collection)) fail(`no such file: ${rel(ctx.collection)}`);
  const text = readStrict(ctx.collection);
  const parsed = JSON.parse(stripBom(text)), top = isPlain(parsed) && isPlain(parsed.collection) && !parsed.item ? parsed.collection : parsed;
  if (!isPlain(top) || !Array.isArray(top.item)) fail(`${rel(ctx.collection)} does not look like a Postman collection (no "item" list)`);
  if (!insideCwd(ctx.collection) || !reallyInsideCwd(ctx.collection) || isLink(ctx.collection)) fail('the collection must be a file inside the current folder');
  const treeDir = o.tree ? path.resolve(o.tree) : path.join(ctx.work, 'tree');
  if (!insideCwd(treeDir) || !reallyInsideCwd(treeDir)) fail('the tree folder must be inside the current folder');
  if (fs.existsSync(treeDir) && !fs.existsSync(path.join(treeDir, META)) && fs.readdirSync(treeDir).length) fail(`${rel(treeDir)}/ exists and holds other files. Name a new or empty folder.`);
  if (fs.existsSync(path.join(treeDir, META))) { let role = null; try { role = readMeta(treeDir).role; } catch (e) { role = null; } if (role === 'source') fail(`${rel(treeDir)}/ is the source of its collection (it was adopted). To take a collection into it: ${pmx.SELF} tree import <collection.json>`); }
  if (fs.existsSync(path.join(treeDir, META)) && !o.force) {
    let lost = true;                             // would unpacking again throw away edits that are not in the collection?
    let extra = [];
    try { const ws = openTree({ tree: treeDir }), b = buildTree(ws); lost = b.errors.length > 0 || !same(b.json, parsed); extra = describe(ws).unlisted; } catch (e) { if (!(e instanceof Problem)) throw e; }
    if (lost) fail(`${rel(treeDir)}/ has edits that are not in ${rel(ctx.collection)} yet. Run \`${pmx.SELF} tree pack\` first, or unpack again with --force to discard them.`);
    if (extra.length) fail(`${rel(treeDir)}/ holds files that are not part of the collection (nothing lists them):\n  ${extra.join('\n  ')}\nList them, move them away, or unpack again with --force to discard them.`);
  }
  const { files, scripts } = split(text);
  fs.rmSync(treeDir, { recursive: true, force: true });
  writeFiles(treeDir, files);
  const blob = gitBlobOf(text, ctx.collection);
  const ws = { treeDir, collection: ctx.collection, baseCopy: ctx.f('tree-base.json'), packCopy: ctx.f('tree-pack.json'), meta: { version: 1, collection: rel(ctx.collection).split(path.sep).join('/'), baseSha: sha(text), baseBlob: blob } };
  saveMeta(ws);
  cache(ws.baseCopy, text);
  fs.rmSync(ws.packCopy, { force: true });
  const names = [...files.keys()];
  return { treeDir, committed: gitHas(blob), files: files.size, requests: names.filter(f => f.endsWith('.request.js')).length, folders: names.filter(f => f.endsWith('/folder.js')).length, scripts: Object.keys(scripts).length };
}

function packTree(ws, opt = {}) {
  if (ws.role === 'source') return buildSource(ws, opt);
  const b = buildTree(ws, opt);
  if (b.errors.length) return { errors: b.errors };
  const onDisk = fs.existsSync(ws.collection) ? readStrict(ws.collection) : null;
  const out = render(ws.baseText, b.base, b.json, ws.collection);
  if (onDisk !== null && ![ws.meta.baseSha, ws.meta.lastPackSha].includes(sha(onDisk)) && !opt.force) return packOnto(ws, b, out, onDisk, opt);
  if (!opt.dry) {
    if (onDisk !== out.text) writeAtomic(ws.collection, out.text);
    rememberPack(ws, out.text);
  }
  const ops = diffOps(ws.baseText.split('\n'), out.text.split('\n'));
  return { errors: [], text: out.text, how: out.how, json: b.json, scripts: b.changed, ignored: b.ignored, added: ops.filter(x => x[0] === '+').length, removed: ops.filter(x => x[0] === '-').length, ops };
}

/* The collection file changed while the files were unpacked (main was merged into the branch, say). Then what the
 * files changed is merged into that newer collection, and the files are written again from the result; from then on
 * changes are counted from there. Edits that collide with the newer version are refused.
 *
 * What did the files change? Against the last pack, if the newer file is built on it (it holds everything that pack
 * wrote): then an edit made again is taken, and an edit taken back stays taken back. Otherwise against the version
 * that was unpacked. */
function packOnto(ws, b, out, onDisk, opt) {
  const moved = `${rel(ws.collection)} was changed by something else since \`tree unpack\``;
  let tm = null, theirs;
  try { tm = require('./treemerge.js'); theirs = JSON.parse(stripBom(onDisk)); } catch (e) { tm = null; }
  const merge3 = (base, ours, others) => { try { return tm.mergeTexts({ file: ws.collection, base, ours, theirs: others }); } catch (e) { return null; } };
  const holds = text => { try { return same(JSON.parse(stripBom(text)), theirs); } catch (e) { return false; } };
  let from = ws.baseText;
  const last = tm ? lastPack(ws) : null;
  if (last && last !== ws.baseText) { const m = merge3(ws.baseText, onDisk, last); if (m && !m.open && holds(m.text)) from = last; }
  const merged = tm ? merge3(from, onDisk, out.text) : null;
  if (!merged || merged.open) return { errors: [`${moved}${merged ? `, and ${merged.open} place(s) were changed both there and in the files` : ''}. The two cannot be combined automatically.\n  Either unpack again (the edits in the files are lost), or pack with --force (the other change is lost).`] };
  const ops = diffOps(onDisk.split('\n'), merged.text.split('\n'));
  const result = { errors: [], text: merged.text, how: 'merged into the newer collection file', json: JSON.parse(stripBom(merged.text)), scripts: b.changed, ignored: b.ignored, added: ops.filter(x => x[0] === '+').length, removed: ops.filter(x => x[0] === '-').length, ops, onto: true, base: onDisk };
  if (holds(merged.text)) Object.assign(result, { text: onDisk, how: 'the newer collection file already held every edit; the files follow it', held: true, added: 0, removed: 0, ops: ops.filter(x => x[0] === '=') });
  if (opt.dry) return result;
  if (!result.held) writeAtomic(ws.collection, result.text);
  const fresh = split(result.text);
  const extra = describe(ws).unlisted.filter(f => !fresh.files.has(f)).map(f => [f, readText(ws, f)]);    // files that nothing lists are the person's own: they stay
  fs.rmSync(ws.treeDir, { recursive: true, force: true });
  writeFiles(ws.treeDir, fresh.files);
  writeFiles(ws.treeDir, extra.filter(([, text]) => text != null));
  const blob = gitBlobOf(result.text, ws.collection);
  ws.meta = Object.assign({}, ws.meta, { baseSha: sha(result.text), baseBlob: blob, lastPackSha: sha(result.text), lastPackBlob: blob });
  saveMeta(ws);
  cache(ws.baseCopy, result.text);
  cache(ws.packCopy, result.text);
  ws.baseText = result.text;
  ws.orig = fresh;
  return result;
}

/* ───────────────────────── what is in the tree, and what changed ───────────────────────── */
function describe(ws) {
  const problems = [], seen = new Set(), open = new Set();
  const original = file => { try { return parseDef(ws.orig.files.get(file), file); } catch (e) { return undefined; } };
  function node(id, dir, kind, names) {
    seen.add(id);
    const n = { id, kind, dir, name: names[names.length - 1] || '', path: names, status: ws.orig.files.has(id) ? 'same' : 'added', scripts: [], children: [] };
    let def;
    try { def = readDef(ws.treeDir, id); } catch (e) { if (!(e instanceof Problem)) throw e; n.problem = e.message; problems.push(e.message); return n; }
    const body = kind === 'collection' && isPlain(def.collection) && !def.item ? def.collection : def;
    n.name = kind === 'collection' ? String((isPlain(body.info) && body.info.name) || 'collection') : body.name == null ? '' : String(body.name);
    n.path = kind === 'collection' ? [] : names.slice(0, -1).concat(n.name);
    if (kind === 'request' && isPlain(body.request)) n.method = String(body.request.method || '');
    if (n.status === 'same' && !same(def, original(id))) n.status = 'modified';
    for (const ev of Array.isArray(body.event) ? body.event : []) {
      if (!isPlain(ev) || !isPlain(ev.script) || !isScriptRef(ev.script.exec)) continue;
      let file;
      try { file = stays(dir, ev.script.exec.$script); } catch (e) { n.problem = e.message; problems.push(`${id}: ${e.message}`); continue; }
      seen.add(file);
      let now = null, why = `${file} is missing`;
      try { now = readText(ws, file); } catch (e) { if (!(e instanceof Problem)) throw e; why = e.message; }
      const status = now == null ? 'missing' : !ws.orig.files.has(file) ? 'added' : sameCode(now, ws.orig.files.get(file)) ? 'same' : 'modified';
      if (status === 'missing') { problems.push(why); n.problem = why; }
      n.scripts.push({ file, listen: String(ev.listen || 'script'), status });
    }
    if (isPlain(body.item) && Array.isArray(body.item.$children)) for (const child of body.item.$children) {
      try {
        const target = stays(dir, child);
        if (String(child).endsWith('/')) {
          if (open.has(target)) throw new Problem(`the folder ${target}/ contains itself`);
          open.add(target);
          n.children.push(node(target + '/folder.js', target, 'folder', n.path.concat(target.split('/').pop())));
          open.delete(target);
        } else { const own = path.posix.dirname(target); n.children.push(node(target, own === '.' ? '' : own, 'request', n.path.concat(target))); }
      } catch (e) { if (!(e instanceof Problem)) throw e; problems.push(`${id}: ${e.message}`); }
    }
    return n;
  }
  const root = node('collection.js', '', 'collection', []);
  const removed = [...ws.orig.files.keys()].filter(f => !seen.has(f) && (f.endsWith('.request.js') || f.endsWith('/folder.js'))).map(f => {
    const def = original(f) || {};
    return { id: f, kind: f.endsWith('/folder.js') ? 'folder' : 'request', name: String(def.name == null ? f : def.name) };
  });
  const counts = { modified: 0, added: 0, removed: removed.length };
  (function tally(n) { if (n.status !== 'same' || n.scripts.some(s => s.status !== 'same')) counts[n.status === 'added' ? 'added' : 'modified']++; n.children.forEach(tally); })(root);
  // Files in the folder that no definition points to and that were not unpacked: somebody put them there. They are not part of the collection.
  const unlisted = treeFiles(ws.treeDir).filter(f => !seen.has(f) && (ws.role === 'source' || !ws.orig.files.has(f)));
  return { root, removed, problems, counts, unlisted };
}
function treeFiles(treeDir) {                    // every real file in the folder (links and the note left out), with / in its path
  const out = [];
  (function walk(dir, prefix) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) { if (e.isDirectory()) walk(path.join(dir, e.name), prefix + e.name + '/'); else if (e.isFile() && prefix + e.name !== META && !e.name.endsWith('.pmx-tmp')) out.push(prefix + e.name); }
  })(treeDir, '');
  return out.sort();
}
const flat = root => { const out = []; (function walk(n, parent) { out.push({ node: n, parent }); n.children.forEach(c => walk(c, n)); })(root, null); return out; };
function findNode(ws, id) {
  const hit = flat(describe(ws).root).find(x => x.node.id === id);
  if (!hit) fail(`${id} is not part of the collection (or was removed)`);
  return hit;
}
const bodyOf = (def, kind) => (kind === 'collection' && isPlain(def.collection) && !def.item ? def.collection : def);
const readText = (ws, file) => { const abs = inTree(ws.treeDir, file); return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null; };
const writeText = (ws, file, text) => { const abs = inTree(ws.treeDir, file); fs.mkdirSync(path.dirname(abs), { recursive: true }); writeAtomic(abs, text); };

/* Everything the page needs to show and edit one request, folder or the collection. */
function readNode(ws, id) {
  const { node } = findNode(ws, id);
  const def = readDef(ws.treeDir, id);
  const chain = [];                              // what this node inherits: the collection, then each folder above it
  (function climb(n, trail) { if (n.id === id) { chain.push(...trail); return true; } return n.children.some(c => climb(c, trail.concat(n))); })(describe(ws).root, []);
  const inherited = chain.map(a => {
    const body = bodyOf(readDef(ws.treeDir, a.id), a.kind);
    return { id: a.id, kind: a.kind, name: a.name, scripts: a.scripts, variables: Array.isArray(body.variable) ? body.variable.filter(isPlain).map(v => ({ key: String(v.key), disabled: !!v.disabled })) : [], auth: isPlain(body.auth) ? String(body.auth.type || '') : '' };
  });
  let originalDef = null;
  if (ws.orig.files.has(id)) originalDef = parseDef(ws.orig.files.get(id), id);
  return { id, kind: node.kind, name: node.name, path: node.path, status: node.status, def, originalDef, inherited, rev: sha(readText(ws, id) || ''),
    scripts: node.scripts.map(s => {
      const text = readText(ws, s.file) || '', original = ws.orig.files.has(s.file) ? ws.orig.files.get(s.file) : null;
      return { file: s.file, listen: s.listen, status: s.status, text, original, rev: sha(text), syntax: syntaxError(text, s.file), tests: countTests(text), testsBefore: original == null ? null : countTests(original) };
    }) };
}
/* `rev` is the fingerprint of the file as the page last saw it. If the file is different now, somebody else wrote it. */
function notStale(ws, file, rev) {
  if (rev == null || sha(readText(ws, file) || '') === rev) return;
  const stale = new Problem(`${file} was changed in the files since the page read it, so the page's older copy was not written over it. It is shown again as it is now.`);
  stale.stale = true;
  throw stale;
}
function writeDef(ws, id, def, rev) {
  const { node } = findNode(ws, id);
  if (!isPlain(def)) fail('a definition must be an object');
  notStale(ws, id, rev);
  const body = bodyOf(def, node.kind);
  if (node.kind !== 'request' && !(isPlain(body.item) && Array.isArray(body.item.$children)) && !Array.isArray(body.item)) fail('a folder or collection needs its "item" list ({"$children": [...]})');
  const before = readText(ws, id) || '', title = before.startsWith('//') ? before.slice(2, before.indexOf('\n')).trim() : node.path.join(' / ') || 'the collection itself';
  const text = defText(title, def);
  writeText(ws, id, text);
  return sha(text);
}
function writeScript(ws, file, text, rev) {
  const owner = flat(describe(ws).root).find(x => x.node.scripts.some(s => s.file === file));
  if (!owner) fail(`${file} is not a script of this collection`);
  if (typeof text !== 'string') fail('a script must be text');
  notStale(ws, file, rev);
  const written = text.replace(/\r\n/g, '\n');
  writeText(ws, file, written);
  const before = ws.orig.files.has(file) ? ws.orig.files.get(file) : null;
  return { syntax: syntaxError(text, file), tests: countTests(text), testsBefore: before == null ? null : countTests(before), rev: sha(written) };
}
function addScript(ws, id, listen) {
  if (!['prerequest', 'test'].includes(listen)) fail('a script is either "prerequest" or "test"');
  const { node } = findNode(ws, id), def = readDef(ws.treeDir, id), body = bodyOf(def, node.kind);
  if (node.scripts.some(s => s.listen === listen)) fail(`this ${node.kind} already has a ${listen} script`);
  const stem = node.kind === 'collection' ? 'collection' : node.kind === 'folder' ? 'folder' : path.posix.basename(id).replace(/\.request\.js$/, '');
  const name = freeName(ws, node.dir, stem, `.${listen}.js`), file = node.dir ? node.dir + '/' + name : name;
  writeText(ws, file, '');
  const event = (Array.isArray(body.event) ? body.event : []).concat({ listen, script: { type: 'text/javascript', exec: { $script: name } } });
  if ('event' in body) body.event = event;
  else {                                         // a new key goes where Postman writes it; the keys that are there stay in their order
    const order = ['info', 'name', 'description', 'item', 'event'], rank = k => (order.includes(k) ? order.indexOf(k) : order.length);
    const entries = Object.entries(body), at = entries.findIndex(([k]) => rank(k) > rank('event'));
    entries.splice(at < 0 ? entries.length : at, 0, ['event', event]);
    for (const k of Object.keys(body)) delete body[k];
    for (const [k, v] of entries) body[k] = v;
  }
  writeDef(ws, id, def);
  return file;
}
function freeName(ws, dir, stem, suffix) {
  const abs = inTree(ws.treeDir, dir || '.');
  const taken = new Set(fs.existsSync(abs) ? fs.readdirSync(abs).map(n => n.toLowerCase()) : []);
  let name = stem + suffix;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem}~${n}${suffix}`;
  return name;
}
function addNode(ws, parentId, kind, name) {
  const { node: parent } = findNode(ws, parentId);
  if (parent.kind === 'request') fail('a request cannot contain other requests');
  if (typeof name !== 'string' || !name.trim()) fail('give it a name');
  const def = readDef(ws.treeDir, parentId), body = bodyOf(def, parent.kind);
  if (!isPlain(body.item) || !Array.isArray(body.item.$children)) fail(`${parentId} has no list of children to add to`);
  let pointer, id;
  if (kind === 'folder') {
    const dirName = freeName(ws, parent.dir, safe(name), '');
    const dir = parent.dir ? parent.dir + '/' + dirName : dirName;
    id = dir + '/folder.js'; pointer = dirName + '/';
    writeText(ws, id, defText(parent.path.concat(name).join(' / ') + '   (folder)', { name, item: { $children: [] } }));
  } else if (kind === 'request') {
    const file = freeName(ws, parent.dir, safe(name), '.request.js');
    id = parent.dir ? parent.dir + '/' + file : file; pointer = file;
    writeText(ws, id, defText(parent.path.concat(name).join(' / '), { name, request: { method: 'GET', header: [], url: { raw: '' } }, response: [] }));
  } else fail('add a "request" or a "folder"');
  body.item.$children.push(pointer);
  writeDef(ws, parentId, def);
  return id;
}
const pointerOf = (parent, node) => { const p = node.kind === 'folder' ? node.dir : node.id; return (parent.dir ? path.posix.relative(parent.dir, p) : p) + (node.kind === 'folder' ? '/' : ''); };
function withParentList(ws, id, change) {
  const { node, parent } = findNode(ws, id);
  if (!parent) fail('the collection itself cannot be moved or removed');
  const def = readDef(ws.treeDir, parent.id), list = bodyOf(def, parent.kind).item.$children;
  const at = list.findIndex(p => { try { return stays(parent.dir, p) === (node.kind === 'folder' ? node.dir : node.id); } catch (e) { return false; } });
  if (at < 0) fail(`${id} is not listed in ${parent.id}`);
  change(list, at, node, parent);
  writeDef(ws, parent.id, def);
  return { node, parent };
}
function moveNode(ws, id, by) {
  withParentList(ws, id, (list, at) => { const to = at + (by < 0 ? -1 : 1); if (to < 0 || to >= list.length) return; const [p] = list.splice(at, 1); list.splice(to, 0, p); });
}
function removeNode(ws, id) {
  const { node } = withParentList(ws, id, (list, at) => { list.splice(at, 1); });
  const kept = file => ws.role !== 'source' && ws.orig.files.has(file);     // in a temporary working copy, what was unpacked is only taken off the list; its files wait for a "put back"
  if (kept(node.id)) return;                     // (where the files are the source, removing removes: the last commit still has them)
  const still = new Set(flat(describe(ws).root).flatMap(x => [x.node.id, ...x.node.scripts.map(s => s.file)]));   // listed somewhere else too? then keep the files
  if (node.kind === 'folder') { if (![...still].some(f => f.startsWith(node.dir + '/')) && ![...ws.orig.files.keys()].some(f => f.startsWith(node.dir + '/') && kept(f))) fs.rmSync(inTree(ws.treeDir, node.dir), { recursive: true, force: true }); }
  else for (const file of [node.id, ...node.scripts.map(s => s.file)]) if (!still.has(file) && !kept(file)) fs.rmSync(inTree(ws.treeDir, file), { force: true });
}
function duplicateNode(ws, id) {
  const { node, parent } = findNode(ws, id);
  if (node.kind !== 'request') fail('only a request can be duplicated');
  const def = readDef(ws.treeDir, id), stem = path.posix.basename(id).replace(/\.request\.js$/, '');
  const file = freeName(ws, node.dir, stem + '_copy', '.request.js'), newStem = file.replace(/\.request\.js$/, '');
  def.name = String(def.name == null ? '' : def.name) + ' copy';
  for (const ev of Array.isArray(def.event) ? def.event : []) {
    if (!isPlain(ev) || !isPlain(ev.script) || !isScriptRef(ev.script.exec)) continue;
    const from = stays(node.dir, ev.script.exec.$script), name = freeName(ws, node.dir, newStem, `.${safe(ev.listen || 'script')}.js`);
    writeText(ws, node.dir ? node.dir + '/' + name : name, readText(ws, from) || '');
    ev.script = Object.assign({}, ev.script, { exec: Object.assign({}, ev.script.exec, { $script: name }) });
  }
  const newId = node.dir ? node.dir + '/' + file : file;
  writeText(ws, newId, defText(parent.path.concat(def.name).join(' / '), def));
  withParentList(ws, id, (list, at) => { list.splice(at + 1, 0, file); });
  return newId;
}
/* Put a script or a definition back to what it was when the collection was unpacked, or list a removed request or
 * folder again.
 *  - A folder or the collection gets its own fields back and keeps the list of what is in it now: requests added to
 *    it stay, requests removed from it stay removed (each has its own "remove" and "put back").
 *  - Putting something back never writes over a file that is still there: its edits come back with it. */
function revert(ws, id) {
  if (!ws.orig.files.has(id)) fail(`${id} did not exist when the collection was unpacked`);
  const isDef = id === 'collection.js' || id.endsWith('.request.js') || id.endsWith('/folder.js');
  const kind = id === 'collection.js' ? 'collection' : id.endsWith('/folder.js') ? 'folder' : 'request';
  const up = p => (path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p));
  const pointsTo = (def, from) => (Array.isArray(def.event) ? def.event : []).filter(ev => isPlain(ev) && isPlain(ev.script) && isScriptRef(ev.script.exec)).map(ev => { try { return stays(from, ev.script.exec.$script); } catch (e) { return null; } }).filter(Boolean);
  const titleOf = text => { const first = String(text || '').split('\n')[0]; return first.startsWith('//') ? first.slice(2).trim() : 'the collection itself'; };
  const present = flat(describe(ws).root).some(x => x.node.id === id || x.node.scripts.some(s => s.file === id));
  const original = ws.orig.files.get(id);
  if (!isDef) { writeText(ws, id, original); return; }
  if (present) {
    let now = null;
    try { now = readDef(ws.treeDir, id); } catch (e) { if (!(e instanceof Problem)) throw e; }
    const back = parseDef(original, id), dir = kind === 'folder' ? up(id) : kind === 'request' ? up(id) : '';
    const list = now && isPlain(bodyOf(now, kind).item) ? bodyOf(now, kind).item.$children : null;
    if (kind !== 'request' && Array.isArray(list) && isPlain(bodyOf(back, kind).item)) bodyOf(back, kind).item.$children = list;
    const gained = now ? pointsTo(bodyOf(now, kind), dir).filter(f => !ws.orig.files.has(f)) : [];
    writeText(ws, id, kind === 'request' || !now ? original : defText(titleOf(original), back));
    const still = new Set(flat(describe(ws).root).flatMap(x => x.node.scripts.map(s => s.file)));
    for (const f of gained) if (!still.has(f)) fs.rmSync(inTree(ws.treeDir, f), { force: true });    // a script this definition had gained goes with it
    return;
  }
  // a removed request or folder: list it again where it was; files of it that are gone come back as they were unpacked
  const dir = kind === 'folder' ? up(id) : null;
  const files = dir ? [...ws.orig.files.keys()].filter(f => f.startsWith(dir + '/')) : [id, ...pointsTo(parseDef(original, id), up(id))];
  const holderDir = up(dir || id), holderId = holderDir ? holderDir + '/folder.js' : 'collection.js', holderKind = holderDir ? 'folder' : 'collection';
  if (readText(ws, holderId) == null) fail(`the folder that held it (${holderDir}/) is gone too. Put that folder back first.`);
  for (const f of files) if (ws.orig.files.has(f) && readText(ws, f) == null) writeText(ws, f, ws.orig.files.get(f));
  const pointer = dir ? path.posix.basename(dir) + '/' : path.posix.basename(id);
  const holder = readDef(ws.treeDir, holderId), list = bodyOf(holder, holderKind).item.$children;
  if (list.includes(pointer)) return;
  const before = bodyOf(parseDef(ws.orig.files.get(holderId), holderId), holderKind).item.$children;
  const earlier = before.slice(0, before.indexOf(pointer)).filter(p => list.includes(p));
  list.splice(earlier.length ? list.indexOf(earlier[earlier.length - 1]) + 1 : 0, 0, pointer);
  writeText(ws, holderId, defText(titleOf(readText(ws, holderId)), holder));
}

/* Line-by-line difference of every file of a node against the unpacked original. */
const diffLines = (before, after) => { const a = before == null ? [] : before.split('\n'), b = after == null ? [] : after.split('\n'); return diffOps(a, b).map(op => (op[0] === '=' ? { t: '=', a: op[1] + 1, b: op[2] + 1, s: b[op[2]] } : op[0] === '-' ? { t: '-', a: op[1] + 1, s: a[op[1]] } : { t: '+', b: op[1] + 1, s: b[op[1]] })); };
const pretty = (text, file) => { try { return JSON.stringify(parseDef(text, file), null, 2); } catch (e) { return text; } };
function hunks(lines, context = 3) {               // keep the changed lines and a few around them; say how many were left out
  const keep = new Uint8Array(lines.length);
  lines.forEach((l, i) => { if (l.t !== '=') for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = 1; });
  const out = [];
  let skipped = 0;
  lines.forEach((l, i) => { if (!keep[i]) { skipped++; return; } if (skipped) { out.push({ t: 'gap', n: skipped }); skipped = 0; } out.push(l); });
  if (skipped) out.push({ t: 'gap', n: skipped });
  return out;
}
function diffNode(ws, id) {
  const out = [], origHas = f => ws.orig.files.has(f);
  const hit = flat(describe(ws).root).find(x => x.node.id === id);
  const defNow = hit ? readText(ws, id) : null;
  const defOps = diffLines(origHas(id) ? pretty(ws.orig.files.get(id), id) : null, defNow == null ? null : pretty(defNow, id));
  out.push({ file: id, what: 'definition', changed: defOps.some(o => o.t !== '='), lines: hunks(defOps) });
  const scripts = hit ? hit.node.scripts.map(s => s.file) : [];
  for (const file of scripts) { const lines = diffLines(origHas(file) ? ws.orig.files.get(file) : null, readText(ws, file)); out.push({ file, what: 'script', changed: !origHas(file) || !sameCode(readText(ws, file) || '', ws.orig.files.get(file)), lines: hunks(lines) }); }
  return out;
}
function allChanges(ws) {
  const d = describe(ws), list = [];
  for (const { node } of flat(d.root)) if (node.status !== 'same' || node.scripts.some(s => s.status !== 'same')) list.push({ id: node.id, kind: node.kind, name: node.name, path: node.path, status: node.status === 'same' ? 'modified' : node.status, files: diffNode(ws, node.id).filter(f => f.changed) });
  for (const r of d.removed) list.push({ id: r.id, kind: r.kind, name: r.name, path: [r.name], status: 'removed', files: [] });
  return list;
}

/* Find text in every definition and script of the collection. */
function search(ws, q) {
  if (typeof q !== 'string' || !q.trim()) return [];
  const needle = q.toLowerCase(), hits = [];
  for (const { node } of flat(describe(ws).root)) for (const file of [node.id, ...node.scripts.map(s => s.file)]) {
    const text = readText(ws, file);
    if (text == null) continue;
    text.split('\n').forEach((line, i) => {
      const shown = file === node.id ? line.replace(/\\(["\\/])/g, '$1') : line;          // in a definition, text sits inside JSON strings
      if (hits.length >= 300 || (file === node.id && i === 0) || !(line.toLowerCase().includes(needle) || shown.toLowerCase().includes(needle))) return;
      hits.push({ id: node.id, kind: node.kind, name: node.name, path: node.path, file, script: file !== node.id, line: i + 1, text: line.trim().slice(0, 240) });
    });
  }
  return hits;
}
/* Every {{variable}} the collection uses, how often, and where a value for it comes from (if anywhere). */
function variables(ws, envFile) {
  const uses = new Map(), from = new Map();
  const use = key => uses.set(key, (uses.get(key) || 0) + 1);
  const give = (key, source) => { if (!from.has(key)) from.set(key, new Set()); from.get(key).add(source); };
  const top = bodyOf(readDef(ws.treeDir, 'collection.js'), 'collection');
  (Array.isArray(top.variable) ? top.variable : []).filter(v => isPlain(v) && !v.disabled).forEach(v => give(String(v.key), 'collection'));
  const env = envFile ? environments().find(e => e.file === envFile) : null;
  if (env) env.keys.filter(k => k.enabled).forEach(k => give(k.key, 'environment'));
  try { const cfg = fs.existsSync('pmx.config.json') ? pmx.readJson('pmx.config.json') : {}; for (const v of (cfg.newman && Array.isArray(cfg.newman.envVar) ? cfg.newman.envVar : [])) if (isPlain(v)) give(String(v.key), 'pmx.config.json'); } catch (e) { /* no config */ }
  for (const { node } of flat(describe(ws).root)) for (const file of [node.id, ...node.scripts.map(s => s.file)]) {
    const text = readText(ws, file) || '';
    for (const m of text.matchAll(/\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g)) if (!m[1].startsWith('$')) use(m[1]);
    if (file === node.id) continue;
    for (const m of text.matchAll(/\bpm\.(?:variables|collectionVariables|environment|globals)\.(get|set)\(\s*(["'`])([^"'`]+)\2/g)) { if (m[1] === 'set') give(m[3], 'a script'); else use(m[3]); }
  }
  return [...new Set([...uses.keys(), ...from.keys()])].sort().map(key => ({ key, uses: uses.get(key) || 0, from: [...(from.get(key) || [])] }));
}

/* ───────────────────────── newman ───────────────────────── */
function loadNewman() {
  for (const from of [process.cwd(), __dirname]) { try { return require(require.resolve('newman', { paths: [from] })); } catch (e) { /* keep looking */ } }
  return fail('cannot find the "newman" package. Install it once: npm i -D newman');
}
function environments() {                        // Postman environment files in this folder (not searched deeper than 3 levels)
  const found = [], skip = new Set(['node_modules', '.git', '.pmx', '.treemerge']);
  (function walk(dir, depth) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (depth < 3 && !skip.has(e.name) && !fs.existsSync(path.join(dir, e.name, META))) walk(path.join(dir, e.name), depth + 1); }
      else if (e.isFile() && /environment.*\.json$/i.test(e.name)) {
        try { const j = JSON.parse(stripBom(fs.readFileSync(path.join(dir, e.name), 'utf8'))); if (isPlain(j) && Array.isArray(j.values)) found.push({ file: rel(path.join(dir, e.name)), name: String(j.name || e.name), keys: j.values.filter(isPlain).map(v => ({ key: String(v.key), enabled: v.enabled !== false, secret: v.type === 'secret' })) }); } catch (e2) { /* not an environment */ }
      }
    }
  })(process.cwd(), 0);
  return found;
}
function newmanRun(collection, o = {}) {
  const newman = loadNewman();
  const cfg = fs.existsSync('pmx.config.json') ? pmx.readJson('pmx.config.json') : {};
  const options = Object.assign({ reporters: [] }, pmx.interp(cfg.newman || {}), { collection });
  if (o.environment) {
    if (!insideCwd(o.environment) || !fs.existsSync(o.environment)) fail(`no such environment file here: ${o.environment}`);
    options.environment = pmx.readJson(o.environment);
  }
  if (o.folder) options.folder = o.folder;
  const where = item => { const names = []; try { for (let x = item; x && x.name !== undefined && typeof x.parent === 'function'; x = x.parent()) names.unshift(x.name); } catch (e) { /* just the name */ } return names.slice(1); };
  return new Promise((resolve, reject) => {
    const assertions = [];
    newman.run(options, (err, summary) => {
      if (err) return reject(new Problem('newman could not run: ' + (err.message || err)));
      const errors = (summary.run.failures || []).filter(f => !/^assertion/.test(f.at || '')).map(f => ({ path: where(f.source), text: `${(f.error && f.error.name) || 'Error'} at ${f.at || 'script'}: ${(f.error && f.error.message) || ''}` }));
      resolve({ assertions, errors });
    }).on('assertion', (e, a) => assertions.push({ path: where(a.item), name: String(a.assertion), result: e ? 'FAIL' : a.skipped ? 'skipped' : 'pass', message: e ? String(e.message || e.name) : '' }));
  });
}
/* Pack, run newman, and say for each failing test which file and line holds it. */
async function testTree(ws, o = {}) {
  const packed = packTree(ws, o);
  if (packed.errors.length) return { packed };
  const run = await newmanRun(JSON.parse(stripBom(packed.text)), o);
  const nodes = flat(describe(ws).root);
  const byPath = new Map();
  for (const x of nodes) { const key = x.node.path.join('\u0001'); if (!byPath.has(key)) byPath.set(key, x); }
  const chainOf = x => { const up = []; for (let p = x; p; p = nodes.find(y => y.node === p.parent)) up.push(p.node); return up; };
  for (const a of run.assertions) {
    const hit = byPath.get(a.path.join('\u0001'));
    if (!hit) continue;
    a.id = hit.node.id;
    if (a.result !== 'FAIL') continue;
    for (const n of chainOf(hit)) for (const s of n.scripts.filter(s2 => s2.listen === 'test').concat(n.scripts.filter(s2 => s2.listen !== 'test'))) {
      const line = findTestLine(readText(ws, s.file) || '', a.name);
      if (line && !a.file) { a.file = s.file; a.line = line; a.owner = n.id; }
    }
  }
  for (const e of run.errors) { const hit = byPath.get(e.path.join('\u0001')); if (hit) e.id = hit.node.id; }
  const failed = run.assertions.filter(a => a.result === 'FAIL');
  return { packed, run, failed, pass: !failed.length && !run.errors.length };
}

/* ───────────────────────── commands ───────────────────────── */
function parse(argv) {
  const flags = new Set(['run', 'force', 'ignore-whitespace', 'keep-whitespace', 'allow-test-removal', 'no-open', 'keep', 'theirs']), o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (flags.has(k)) o[k] = true; else { if (argv[i + 1] === undefined) fail(`--${k} needs a value`); o[k] = argv[++i]; }
  }
  return o;
}
const packOptions = o => ({ ignoreWs: o['ignore-whitespace'], allowTestRemoval: o['allow-test-removal'], force: o.force, environment: o.environment, folder: o.folder });
const treeArg = ws => (ws.treeDir === path.join(path.dirname(ws.baseCopy), 'tree') ? '' : ` --tree ${rel(ws.treeDir)}`);

function cmdUnpack(o) {
  const r = unpackTree(o, o._[0]);
  console.log(`unpacked the whole collection -> ${rel(r.treeDir)}/   (${r.requests} requests, ${r.folders} folders, ${r.scripts} scripts, ${r.files} files)`);
  if (o.tree && !r.committed) console.log('note: this version of the collection is not committed in git. Commit it before or with the files:\n      otherwise only this machine can tell what was changed (a fresh clone cannot).');
  console.log(`edit there, or in the page:  ${pmx.SELF} tree ui`);
  console.log(`then:                        ${pmx.SELF} tree test    and, before merging,   ${pmx.SELF} tree finish`);
  return 0;
}
function reportPack(ws, r, quiet) {
  if (r.errors.length) {
    console.log(`TREE ${ws.role === 'source' ? 'BUILD' : 'PACK'} REFUSED - fix these first (the collection file was NOT changed):`);
    r.errors.forEach(e => console.log('  ' + e));
    return 2;
  }
  if (ws.role === 'source') {
    console.log(`built -> ${rel(ws.collection)}   (${r.how === 'up to date' ? 'it was up to date' : `+${r.added} -${r.removed} lines; ${r.how}`})`);
    if (r.scripts.length) console.log('  scripts changed since ' + ws.since + ': ' + r.scripts.join(', '));
    if (!quiet && r.how !== 'up to date') console.log(`next: commit ${rel(ws.collection)} together with the files.`);
    return 0;
  }
  console.log(`packed -> ${rel(ws.collection)}   (+${r.added} -${r.removed} lines${r.onto ? '' : ' against the unpacked version'}; ${r.how})`);
  if (r.onto) console.log(`  ${rel(ws.collection)} had changed since it was unpacked. The files in ${rel(ws.treeDir)}/ were written again from the result.`);
  if (r.scripts.length) console.log('  scripts changed: ' + r.scripts.join(', '));
  if (r.ignored && r.ignored.length) console.log('  --ignore-whitespace: edits that only change spacing were left out in ' + r.ignored.join(', '));
  if (!quiet) console.log(`next: ${pmx.SELF} tree test`);
  return 0;
}
function cmdPack(o) { const ws = openTree(o); return reportPack(ws, packTree(ws, packOptions(o))); }

function cmdStatus(o) {
  const ws = openTree(o), d = describe(ws);
  const lines = [];
  for (const { node } of flat(d.root)) {
    const files = [];
    if (node.status !== 'same') files.push(`${node.status === 'added' ? 'A' : 'M'} ${node.id}`);
    node.scripts.filter(s => s.status !== 'same').forEach(s => files.push(`${s.status === 'added' ? 'A' : s.status === 'missing' ? '!' : 'M'} ${s.file}`));
    files.forEach(f => lines.push('  ' + f + (node.path.length ? `   <- ${node.path.join(' / ')}` : '')));
  }
  d.removed.forEach(r => lines.push(`  D ${r.id}   <- ${r.name}`));
  const source = ws.role === 'source';
  console.log(source ? `${rel(ws.treeDir)}/  is the source of  ${rel(ws.collection)}` : `${rel(ws.treeDir)}/  for  ${rel(ws.collection)}`);
  if (!lines.length) console.log(source ? `no changes since ${ws.since}` : 'no changes against the collection as it was unpacked');
  else if (source) console.log(`changes since ${ws.since}:`);
  lines.forEach(l => console.log(l));
  d.unlisted.forEach(f => console.log(`  ? ${f}   <- no definition lists this file, so it is not part of the collection`));
  d.problems.forEach(p => console.log('  ERROR ' + p));
  const dry = packTree(ws, Object.assign(packOptions(o), { dry: true }));
  if (dry.ignored && dry.ignored.length) console.log('  --ignore-whitespace: edits that only change spacing are left out in ' + dry.ignored.join(', '));
  if (source) {
    if (dry.errors.length) dry.errors.forEach(e => console.log('  ERROR ' + e));
    else console.log(dry.how === 'up to date' ? `${rel(ws.collection)} is up to date with the files` : `${rel(ws.collection)} is behind the files (+${dry.added} -${dry.removed} lines). Run: ${pmx.SELF} tree build`);
    return 0;
  }
  if (!dry.errors.length) {
    const onDisk = fs.existsSync(ws.collection) ? readStrict(ws.collection) : null;
    if (dry.onto) console.log(`${rel(ws.collection)} was changed by something else since it was unpacked; \`tree pack\` will ${dry.held ? 'write the files again from it' : 'merge these edits into it'}`);
    console.log(onDisk === dry.text ? `${rel(ws.collection)} already holds these edits` : `${rel(ws.collection)} does not hold these edits yet (+${dry.added} -${dry.removed} lines). Run: ${pmx.SELF} tree pack`);
  } else dry.errors.forEach(e => console.log('  ERROR ' + e));
  return 0;
}

async function cmdTest(o) {
  const ws = openTree(o), t = await testTree(ws, packOptions(o));
  if (t.packed.errors.length) return reportPack(ws, t.packed, true);
  reportPack(ws, t.packed, true);
  const total = t.run.assertions.length;
  console.log(t.pass ? `RESULT: PASS - ${total} assertions, 0 failed` : `RESULT: FAIL - ${t.failed.length} of ${total} assertions failed` + (t.run.errors.length ? `, ${t.run.errors.length} error(s)` : ''));
  let last = null;
  for (const a of t.failed) {
    const title = a.path.join(' / ');
    if (title !== last) console.log(`\nX ${last = title}`);
    console.log(`  FAILED TEST: ${JSON.stringify(a.name)}`);
    if (a.file) console.log(`     edit -> ${rel(path.join(ws.treeDir, a.file))}:${a.line}`);
    console.log(`     ${a.message}`);
  }
  if (t.run.errors.length) { console.log('\nERRORS (a script or a request did not run):'); [...new Set(t.run.errors.map(e => `${e.path.join(' / ') || '(collection)'}: ${e.text}`))].slice(0, 20).forEach(e => console.log('  ' + e)); }
  return t.pass ? 0 : 1;
}

/* Before merging: write the collection, make sure it holds exactly what the files say, and remove the files. */
function cmdFinish(o) {
  const ws = openTree(o);
  if (ws.role === 'source') fail(`${rel(ws.treeDir)}/ is the source of ${rel(ws.collection)}: it stays. (tree finish removes a temporary working copy.) To generate the JSON: ${pmx.SELF} tree build`);
  const extra = describe(ws).unlisted;
  if (extra.length && !o.force && !o.keep) {
    console.log(`TREE FINISH REFUSED - ${rel(ws.treeDir)}/ holds files that are not part of the collection (no definition lists them):`);
    extra.forEach(f => console.log('  ? ' + f));
    console.log('List them (a script in its request\'s "event", a request in its folder\'s "$children"), move them away, or finish with --force to remove them too.');
    return 2;
  }
  const r = packTree(ws, packOptions(o));
  const code = reportPack(ws, r, true);
  if (code) return code;
  if (!same(JSON.parse(stripBom(readStrict(ws.collection))), r.json)) fail(`${rel(ws.collection)} does not hold what the files say - nothing was removed`);
  if (o.keep) { console.log(`kept ${rel(ws.treeDir)}/ (--keep)`); return 0; }
  fs.rmSync(ws.treeDir, { recursive: true, force: true });
  fs.rmSync(ws.baseCopy, { force: true });
  fs.rmSync(ws.packCopy, { force: true });
  console.log(`removed ${rel(ws.treeDir)}/ - the collection file now holds everything.`);
  console.log(`next: run the tests on it (${pmx.SELF} unpack ${rel(ws.collection)} && ${pmx.SELF} test), then commit ${rel(ws.collection)}.`);
  return 0;
}

function cmdAdopt(o) {
  const r = adoptTree(o, o._[0]);
  console.log(`adopted ${rel(r.collection)} -> ${rel(r.treeDir)}/   (${r.requests} requests, ${r.folders} folders, ${r.scripts} scripts, ${r.files} files)`);
  console.log(`The files in ${rel(r.treeDir)}/ are now the source. ${rel(r.collection)} is generated from them:  ${pmx.SELF} tree build`);
  if (r.errors.length) r.errors.forEach(e => console.log('  ERROR ' + e));
  else if (r.exact) console.log('check: building from the files gives the same file, byte for byte.');
  else console.log(`check: building from the files changes ${r.moves} line(s) of the JSON, once` + (r.mixed ? ` (${r.mixed} script(s) mix line ends; they are made uniform)` : '') + `. Look at them with: ${pmx.SELF} tree build && git diff`);
  console.log(`next: commit ${rel(r.treeDir)}/. Edit there or in the page (${pmx.SELF} tree ui). After edits: ${pmx.SELF} tree build, and commit the JSON with the files. In CI: ${pmx.SELF} tree verify`);
  return 0;
}
/* For CI: is the collection JSON exactly what the files generate? */
function cmdVerify(o) {
  const ws = openTree(o);
  if (ws.role !== 'source') fail(`tree verify is for files that are the source of their collection (see tree adopt). For a temporary working copy: ${pmx.SELF} tree status`);
  const d = describe(ws), dry = packTree(ws, Object.assign(packOptions(o), { dry: true }));
  const onDisk = fs.existsSync(ws.collection) ? readStrict(ws.collection) : null;
  const wrong = [...new Set([...d.problems, ...dry.errors])].concat(d.unlisted.map(f => `${f}: no definition lists this file, so it is not part of the collection`));
  if (!dry.errors.length && onDisk !== dry.text) wrong.push(onDisk == null ? `${rel(ws.collection)} does not exist. Run: ${pmx.SELF} tree build` : `${rel(ws.collection)} is not what the files generate (+${dry.added} -${dry.removed} lines). Run: ${pmx.SELF} tree build`);
  if (!wrong.length) { console.log(`VERIFY OK - ${rel(ws.collection)} is what ${rel(ws.treeDir)}/ generates`); return 0; }
  console.log('VERIFY FAILED');
  wrong.forEach(w => console.log('  ' + w));
  return 1;
}
function cmdImport(o) {
  const ws = openTree(o);
  if (ws.role !== 'source') fail(`tree import is for files that are the source of their collection (see tree adopt). In a temporary working copy, \`tree pack\` merges a collection that changed.`);
  const from = o._[0] ? path.resolve(o._[0]) : ws.collection;
  const r = importTree(ws, o._[0], { theirs: o.theirs });
  if (r.errors.length) { console.log('TREE IMPORT REFUSED:'); r.errors.forEach(e => console.log('  ' + e)); return 2; }
  if (r.same) { console.log(`nothing to import: the files already say what ${rel(from)} says`); return 0; }
  console.log(`imported ${rel(from)} -> ${rel(ws.treeDir)}/   (${r.how}; ${r.files} file(s) written or removed)`);
  console.log(`${rel(ws.collection)} was built again from the files. Look at the change with git diff, then commit.`);
  return 0;
}

/* Unpack into a temporary folder, build again without touching anything, and say what came back. */
async function cmdCheck(o) {
  const file = o._[0] || o.collection;
  if (!file || !fs.existsSync(file)) fail('usage: tree check <collection.json> [--run]');
  const text = readStrict(file), t0 = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmx-tree-'));
  try {
    const { files, scripts } = split(text);
    writeFiles(tmp, files);
    const b = build(tmp, { scripts }, text);
    const identical = !b.errors.length && same(b.json, b.base);
    let writer = 'not tried', plain = 'not tried';
    if (identical) {
      const unit = detectFormat(text).unit;
      plain = (text.startsWith(BOM) ? BOM : '') + JSON.stringify(b.json, null, unit || undefined) === text ? 'the same bytes' : 'different bytes (this file is not in plain JSON.stringify layout)';
      try { const r = require('./treemerge.js').mergeTexts({ file, base: text, ours: text, theirs: JSON.stringify(b.json) }); writer = !r.open && r.text === text ? 'the same bytes' : 'DIFFERENT bytes'; } catch (e) { writer = 'treemerge.js is not next to pmx.js'; }
    }
    const names = [...files.keys()];
    console.log(`ROUND TRIP  ${rel(path.resolve(file))}   ${text.split('\n').length} lines, ${Buffer.byteLength(text)} bytes`);
    console.log(`  unpacked into ${files.size} files: ${names.filter(f => f.endsWith('.request.js')).length} requests, ${names.filter(f => f.endsWith('/folder.js')).length} folders, ${Object.keys(scripts).length} scripts`);
    console.log(`  built back from the files: ${identical ? 'IDENTICAL to the original (every key, value and order)' : 'NOT identical'}`);
    b.errors.forEach(e => console.log('    ' + e));
    console.log(`  layout-keeping writer gives: ${writer}`);
    console.log(`  plain re-serialisation gives: ${plain}`);
    let ok = identical && writer === 'the same bytes';
    if (o.run && identical) {
      const line = a => `${a.path.join(' / ')} :: ${a.name} :: ${a.result}`;
      const before = await newmanRun(JSON.parse(stripBom(text)), o), after = await newmanRun(b.json, o);
      const equal = same(before.assertions.map(line), after.assertions.map(line)) && same(before.errors, after.errors);
      console.log(`  newman on the original and on the rebuilt collection: ${before.assertions.length} and ${after.assertions.length} assertions, ${equal ? 'the same results' : 'DIFFERENT results'} (${before.assertions.filter(a => a.result === 'FAIL').length} failing in both)`);
      ok = equal && ok;
    }
    console.log(`  time: ${Date.now() - t0} ms`);
    console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
    return ok ? 0 : 1;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/* ───────────────────────── the page's server ─────────────────────────
 * Listens on this machine only, on a free port, and answers only requests that carry the key from the link it prints.
 * Anything that changes a file must be a POST with that key in a header, which a page from another site cannot send. */
function serve(ws, o = {}) {
  const page = path.join(__dirname, 'pmx-tree.ui.html');
  if (!fs.existsSync(page)) fail(`the page needs ${rel(page)} next to pmx-tree.js`);
  const key = crypto.randomBytes(16).toString('hex');
  let chosenEnv = o.environment || null, lastRun = null, running = false, envs = null, envsAt = 0;
  const envList = () => { if (!envs || Date.now() - envsAt > 10000) { envs = environments(); envsAt = Date.now(); } return envs; };
  const state = () => {
    const d = describe(ws);
    return { role: ws.role === 'source' ? 'source' : 'copy', since: ws.role === 'source' ? ws.since : 'the collection as it was unpacked', collection: rel(ws.collection), tree: rel(ws.treeDir), root: d.root, removed: d.removed, unlisted: d.unlisted, problems: d.problems, counts: d.counts, environments: envList(), environment: chosenEnv, lastRun };
  };
  const sync = () => {                           // the note may have been written by a command in the terminal meanwhile (a pack, a merge)
    const meta = readMeta(ws.treeDir), moved = meta.baseSha !== ws.meta.baseSha;
    if (ws.role === 'source') { ws.meta = meta; if (headSha() !== ws.head) sourceBaseline(ws); return; }   // a commit was made meanwhile: changes are counted from it
    ws.meta = meta;
    if (moved) { ws.baseText = findBase(ws); ws.orig = split(ws.baseText); }
  };
  const dryPack = () => packTree(ws, { dry: true });
  const routes = {
    'GET /api/state': () => state(),
    'GET /api/node': q => readNode(ws, q.id),
    'GET /api/diff': q => diffNode(ws, q.id),
    'GET /api/changes': () => allChanges(ws),
    'GET /api/pending': () => {                    // would packing change the collection file, and by how much?
      const dry = dryPack();
      if (dry.errors.length) return { errors: dry.errors, edited: !!dry.edited };
      const onDisk = fs.existsSync(ws.collection) ? readStrict(ws.collection) : null;
      return { errors: [], packed: onDisk === dry.text && !dry.held, added: dry.added, removed: dry.removed, how: dry.how, onto: !!dry.onto, held: !!dry.held };
    },
    'GET /api/preview': () => {
      const dry = dryPack();
      if (dry.errors.length) return { errors: dry.errors };
      const base = (dry.base != null ? dry.base : ws.baseText).split('\n'), now = dry.text.split('\n');
      return { errors: [], how: dry.how, added: dry.added, removed: dry.removed, onto: !!dry.onto, held: !!dry.held, lines: hunks(dry.ops.map(op => (op[0] === '=' ? { t: '=', a: op[1] + 1, b: op[2] + 1, s: now[op[2]] } : op[0] === '-' ? { t: '-', a: op[1] + 1, s: base[op[1]] } : { t: '+', b: op[1] + 1, s: now[op[1]] }))) };
    },
    'GET /api/search': q => search(ws, q.q),
    'GET /api/variables': () => variables(ws, chosenEnv),
    'POST /api/def': (q, b) => ({ ok: true, rev: writeDef(ws, b.id, typeof b.text === 'string' ? parseDef(DEF_START + b.text + ';', b.id) : b.def, b.rev) }),
    'POST /api/script': (q, b) => writeScript(ws, b.file, b.text, b.rev),
    'POST /api/add-script': (q, b) => ({ file: addScript(ws, b.id, b.listen) }),
    'POST /api/add': (q, b) => ({ id: addNode(ws, b.parent, b.kind, b.name) }),
    'POST /api/remove': (q, b) => { removeNode(ws, b.id); return { ok: true }; },
    'POST /api/move': (q, b) => { moveNode(ws, b.id, b.by); return { ok: true }; },
    'POST /api/duplicate': (q, b) => ({ id: duplicateNode(ws, b.id) }),
    'POST /api/revert': (q, b) => { revert(ws, b.id); return { ok: true }; },
    'POST /api/pack': () => { const r = packTree(ws, {}); return r.errors.length ? { errors: r.errors } : { errors: [], how: r.how, added: r.added, removed: r.removed, onto: !!r.onto, held: !!r.held }; },
    'POST /api/environment': (q, b) => { if (b.file && !envList().some(e => e.file === b.file)) fail('that is not an environment file here'); chosenEnv = b.file || null; return { ok: true }; },
    'POST /api/test': async (q, b) => {
      if (running) fail('a run is still going');
      let folder = null;
      if (b.id && b.id !== 'collection.js') {      // only this folder or request: newman finds it by name, so the name must be the only one
        const all = flat(describe(ws).root), hit = all.find(x => x.node.id === b.id);
        if (!hit) fail(`${b.id} is not part of the collection`);
        if (all.filter(x => x.node.name === hit.node.name).length > 1) fail(`"${hit.node.name}" is the name of more than one request or folder, so it cannot be run alone. Run everything.`);
        folder = hit.node.name;
      }
      running = true;
      let t;
      try { t = await testTree(ws, { environment: chosenEnv, folder }); } finally { running = false; }
      if (t.packed.errors.length) return { errors: t.packed.errors };
      lastRun = { at: new Date().toISOString(), environment: chosenEnv, only: folder, pass: t.pass, total: t.run.assertions.length, failed: t.failed.length,
        assertions: t.run.assertions.map(a => ({ id: a.id || null, path: a.path, name: a.name, result: a.result, message: a.message, file: a.file || null, line: a.line || null, owner: a.owner || null })),
        errors: t.run.errors.map(e => ({ id: e.id || null, path: e.path, text: e.text })) };
      return { errors: [], run: lastRun };
    },
  };
  return new Promise((resolve, reject) => {
    const send = (res, code, body, type) => {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
      res.end(text);
    };
    const server = http.createServer((req, res) => {
      let u;
      try { u = new URL(req.url, 'http://x'); } catch (e) { return send(res, 400, { error: 'bad request' }); }
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, { error: 'this page is for this machine only' });
      if (u.pathname === '/' && req.method === 'GET') {
        if (u.searchParams.get('k') !== key) return send(res, 403, 'open the link printed in the terminal', 'text/plain; charset=utf-8');
        const nonce = crypto.randomBytes(16).toString('base64');
        res.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
        return send(res, 200, fs.readFileSync(page, 'utf8').replace(/__NONCE__/g, nonce), 'text/html; charset=utf-8');
      }
      if (req.headers['x-pmx-key'] !== key) return send(res, 403, { error: 'missing or wrong key' });
      const parts = []; let size = 0;
      req.on('data', c => { parts.push(c); size += c.length; if (size > 5e7) req.destroy(); });
      req.on('end', async () => {
        try {
          if (u.pathname === '/api/close' && req.method === 'POST') { send(res, 200, { ok: true }); server.close(); setTimeout(resolve, 50); return; }
          const handler = routes[`${req.method} ${u.pathname}`];
          if (!handler) return send(res, 404, { error: 'not found' });
          sync();
          const raw = Buffer.concat(parts).toString('utf8');
          const body = raw ? JSON.parse(raw) : {};
          if (!isPlain(body)) return send(res, 400, { error: 'expected a JSON object' });
          send(res, 200, await handler(Object.fromEntries(u.searchParams), body));
        } catch (e) { send(res, e instanceof Problem && e.stale ? 409 : e instanceof Problem || e instanceof SyntaxError ? 400 : 500, { error: e instanceof Problem || e instanceof SyntaxError ? e.message : 'internal error: ' + e.message, stale: !!(e && e.stale) }); }
      });
    });
    server.on('error', reject);
    server.listen(+o.port || 0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/?k=${key}`;
      console.log(`\nthe collection is open for editing in your browser:\n  ${url}\n(edits are written to ${rel(ws.treeDir)}/ as you make them; press Ctrl+C here to stop)\n`);
      if (o.onUrl) o.onUrl(url);
      if (!o['no-open']) {
        const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
        try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch (e) { /* the link is printed */ }
      }
    });
  });
}
async function cmdUi(o) {
  const which = Object.assign({}, o, { collection: o.collection || o._[0] });
  let ws;
  try { ws = openTree(which); } catch (e) {
    if (!(e instanceof Problem) || !e.nothingUnpacked) throw e;
    const r = unpackTree(o, o._[0]);              // nothing unpacked yet: do that first (the collection named here, or the configured one)
    console.log(`unpacked the whole collection -> ${rel(r.treeDir)}/   (${r.requests} requests, ${r.folders} folders, ${r.scripts} scripts)`);
    ws = openTree(Object.assign({}, which, { tree: r.treeDir }));
  }
  await serve(ws, o);
  return 0;
}

const HELP = `pmx tree - EXPERIMENTAL: the whole collection as files, and the collection JSON built from them

Two ways to use the files. Pick one per collection.

A. The files are the source (they stay, are reviewed and merged; the JSON is generated):
  tree adopt <collection.json>    write every request, folder and script as its own file, in a folder next to the JSON
  tree build                      generate the collection JSON from the files; only what changed moves
  tree verify                     for CI: fail unless the JSON is exactly what the files generate
  tree import [<export.json>]     take a JSON that was edited directly, or an export from Postman, into the files

B. The files are a temporary working copy (the JSON stays what you keep and merge):
  tree unpack <collection.json>   write the files (default: .pmx/<name>/tree/; --tree <folder> to commit them on a branch)
  tree pack                       build the collection JSON from the files
  tree finish                     pack, check, and remove the files again - do this before merging

Both:
  tree ui                         edit in a page served from this machine: requests, variables, scripts, diffs, newman
  tree status                     what changed (A: since the last commit; B: since the unpack), and whether the JSON holds it
  tree test                       build or pack, then run newman on the result (options from pmx.config.json)
  tree check <collection.json>    measure the round trip of a collection without touching anything. --run also compares newman results

options: --tree <dir> (where the files are), --collection <file>,
--environment <file> (a Postman environment for newman), --folder <name> (test: only this folder or request),
--port <n> and --no-open (ui), --keep (finish), --theirs (import: take the JSON as it is),
--force, --ignore-whitespace (pack: drop edits that only change spacing), --allow-test-removal
The other pmx commands work exactly as before.`;

async function run(argv) {
  try {
    const [sub, ...rest] = argv, o = parse(rest);
    if (['pack', 'build', 'status', 'test', 'finish', 'verify'].includes(sub) && o._[0] && !o.collection) o.collection = o._[0];
    if (sub === 'unpack') return cmdUnpack(o);
    if (sub === 'adopt') return cmdAdopt(o);
    if (sub === 'verify') return cmdVerify(o);
    if (sub === 'import') return cmdImport(o);
    if (sub === 'pack' || sub === 'build') return cmdPack(o);
    if (sub === 'status') return cmdStatus(o);
    if (sub === 'test') return await cmdTest(o);
    if (sub === 'finish') return cmdFinish(o);
    if (sub === 'check') return await cmdCheck(o);
    if (sub === 'ui') return await cmdUi(o);
    console.log(HELP);
    return sub && sub !== 'help' && sub !== '--help' ? 2 : 0;
  } catch (e) {
    if (!(e instanceof Problem)) throw e;
    console.error('pmx: ' + e.message);
    return 2;
  }
}

/* Split a collection the way `tree adopt` does and build it again from those files, all in memory. */
function sourceRoundTrip(text) {
  const parts = split(text, { source: true });
  const b = build('', { scripts: {} }, null, { read: file => (parts.files.has(file) ? parts.files.get(file) : null), source: { format: parts.format, head: parts.files } });
  return { errors: b.errors, json: b.json, text: b.errors.length ? null : canonical(b.json, parts.format), mixed: parts.mixed, files: parts.files };
}

module.exports = { sourceRoundTrip, adoptTree, importTree, run, split, build, render, Problem, openTree, unpackTree, packTree, describe, readNode, writeDef, writeScript, addScript, addNode, removeNode, moveNode, duplicateNode, revert, diffNode, allChanges, testTree, serve, environments };
