'use strict';
/*
 * pmx tree - EXPERIMENTAL whole-collection mode (a spike: see the issue "collection-as-code editor").
 *
 * `pmx unpack` turns only the scripts of a collection into files. This mode turns ALL of it into a folder of small
 * files, and builds the collection back from them:
 *
 *   tree unpack <collection.json>   one definition file per request and per folder, one .js file per script
 *   tree pack                       build the collection from those files and write it, keeping the file's own layout
 *   tree test                       pack, then run newman on the result
 *   tree check <collection.json>    measure the round trip: unpack, build, compare with the original (--run: newman too)
 *
 * It is a separate mode. Nothing here changes what the other pmx commands do, and it only reuses their helpers.
 *
 * The files
 *   collection.js                 everything at the top of the collection (info, variables, auth, ...)
 *   collection.prerequest.js      a collection-level script, as plain JavaScript
 *   <Folder>/folder.js            a folder's own fields
 *   <Folder>/<Request>.request.js one request: name, method, URL, headers, body, saved responses, ...
 *   <Folder>/<Request>.test.js    that request's scripts
 *
 * A definition file is `module.exports = <JSON>;`. It is read as data and never executed. Two markers stand in for
 * what lives in other files: {"$script": "Ping.test.js"} where a script's lines go, and
 * {"$children": ["Ping.request.js", "Staff_picks/"]} where a folder's content goes, in order. So adding, removing or
 * reordering requests means editing that list.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const pmx = require('./pmx.js');
const { die, rel, safe, sha, stripBom, readStrict, writeAtomic, mergeScript, syntaxError, detectFormat, diffOps } = pmx;

const DEF_START = 'module.exports = ';
const posix = p => p.split(path.sep).join('/');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const oneKey = (v, key) => isPlain(v) && Object.keys(v).length === 1 && key in v;
const isStrings = v => Array.isArray(v) && v.every(x => typeof x === 'string');
const countTests = code => (code.match(/\bpm\.test\s*\(|\btests\s*\[/g) || []).length;

/* ───────────────────────── collection -> files ───────────────────────── */
function split(text) {
  const json = JSON.parse(stripBom(text));
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
  const writeDef = (file, title, value) => files.set(file, `// ${title}\n${DEF_START}${JSON.stringify(value, null, 2)};\n`);

  // Returns a copy of one node (collection, folder or request) with its scripts and children moved out to files.
  function lift(node, key, dir, scriptStem, names) {
    const copy = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'event' && Array.isArray(v)) {
        copy.event = v.map((ev, i) => {
          const exec = isPlain(ev) && isPlain(ev.script) ? ev.script.exec : undefined;
          if (!isStrings(exec) && typeof exec !== 'string') return ev;
          const file = claim(dir, `${scriptStem}.${safe(ev.listen || 'script')}.js`);
          const lines = typeof exec === 'string' ? exec.split('\n') : exec;
          files.set(at(dir, file), lines.map(line => line.replace(/\r$/, '')).join('\n'));
          scripts[at(dir, file)] = { key: [...key, 'event', i, 'script', 'exec'].join('/'), kind: typeof exec === 'string' ? 'string' : 'array' };
          return Object.assign({}, ev, { script: Object.assign({}, ev.script, { exec: { $script: file } }) });
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

  taken.set('', new Set(['collection.js']));
  const wrapped = isPlain(json) && isPlain(json.collection) && !json.item;      // some exports wrap everything in {"collection": {...}}
  const top = wrapped ? Object.assign({}, json, { collection: lift(json.collection, ['collection'], '', 'collection', []) }) : lift(json, [], '', 'collection', []);
  writeDef('collection.js', 'the collection itself', top);
  return { files, scripts };
}

/* ───────────────────────── files -> collection ───────────────────────── */
function readDef(treeDir, file) {
  const abs = path.join(treeDir, file);
  if (!fs.existsSync(abs)) throw new Error(`${file} is missing`);
  const text = fs.readFileSync(abs, 'utf8'), start = text.indexOf(DEF_START), end = text.lastIndexOf(';');
  if (start < 0 || end < start) throw new Error(`${file}: expected \`${DEF_START}{ ... };\``);
  try { return JSON.parse(text.slice(start + DEF_START.length, end)); } catch (e) { throw new Error(`${file}: the part after \`${DEF_START}\` is not valid JSON (${e.message})`); }
}
const stays = (dir, name) => {                   // a pointer must name something inside the tree, never a path that climbs out
  const joined = path.posix.normalize(dir ? dir + '/' + name : name);
  if (typeof name !== 'string' || !name || path.posix.isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.includes('\\') || joined === '..' || joined.startsWith('../')) throw new Error(`"${name}" points outside the tree`);
  return joined;
};

function build(treeDir, manifest, baseText, opt = {}) {
  const base = JSON.parse(stripBom(baseText));
  const originalExec = key => key.split('/').reduce((v, k) => (v == null ? v : v[k]), base);
  let withCr = 0, total = 0;
  JSON.stringify(base, (k, v) => { if (k === 'exec' && isStrings(v)) v.forEach(line => { total++; if (line.endsWith('\r')) withCr++; }); return v; });
  const crlf = withCr * 2 > total;
  const errors = [], changed = [];

  function scriptLines(file) {
    const abs = path.join(treeDir, file);
    if (!fs.existsSync(abs)) throw new Error(`${file} is missing`);
    const text = fs.readFileSync(abs, 'utf8'), known = manifest.scripts[file];
    const before = known ? originalExec(known.key) : undefined;
    if (before === undefined) {                  // a script that was not in the collection when it was unpacked
      const lines = text.split('\n').map(line => line.replace(/\r$/, ''));
      const problem = syntaxError(lines.join('\n'), file);
      if (problem) errors.push('SYNTAX ERROR ' + problem);
      changed.push(file);
      return crlf ? lines.map((line, i) => (i < lines.length - 1 ? line + '\r' : line)) : lines;
    }
    const m = mergeScript(typeof before === 'string' ? before.split('\n') : before, text, { keepWs: opt.keepWs, defaultCrlf: crlf });
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
          if (!isPlain(ev) || !isPlain(ev.script) || !oneKey(ev.script.exec, '$script')) return ev;
          return Object.assign({}, ev, { script: Object.assign({}, ev.script, { exec: scriptLines(stays(dir, ev.script.exec.$script)) }) });
        });
      } else if (k === 'item' && oneKey(v, '$children')) {
        if (!Array.isArray(v.$children)) throw new Error('$children must be a list of file and folder names');
        node.item = v.$children.map(child => {
          const target = stays(dir, child);
          if (String(child).endsWith('/')) return fill(readDef(treeDir, target + '/folder.js'), target);
          const own = path.posix.dirname(target);                  // a request's script pointers are relative to its own file
          return fill(readDef(treeDir, target), own === '.' ? '' : own);
        });
      } else node[k] = v;
    }
    return node;
  }

  let json;
  try {
    const top = readDef(treeDir, 'collection.js');
    json = isPlain(top.collection) && !top.item ? Object.assign({}, top, { collection: fill(top.collection, '') }) : fill(top, '');
  } catch (e) { errors.push(e.message); }
  return { json, base, errors, changed };
}

/* Turn the built collection into text. Where the original text is known, only what changed is laid out again and every
 * other byte is copied from it (treemerge's writer does that: the original is "ours", the built collection is "theirs"). */
function render(baseText, base, json, file) {
  if (same(json, base)) return { text: baseText, how: 'unchanged' };
  const unit = detectFormat(baseText).unit;
  const plain = () => (baseText.charCodeAt(0) === 0xFEFF ? String.fromCharCode(0xFEFF) : '') + JSON.stringify(json, null, unit || undefined);
  let merged = null;
  try { merged = require('./treemerge.js').mergeTexts({ file, base: baseText, ours: baseText, theirs: JSON.stringify(json) }); } catch (e) { /* no treemerge next to pmx: plain layout */ }
  if (merged && !merged.open) { try { if (same(JSON.parse(stripBom(merged.text)), json)) return { text: merged.text, how: 'layout kept' }; } catch (e) { /* fall through */ } }
  return { text: plain(), how: 'written in plain JSON layout (the original layout could not be kept for this change)' };
}

/* ───────────────────────── commands ───────────────────────── */
function parse(argv) {
  const flags = new Set(['run', 'force', 'keep-whitespace', 'allow-test-removal']), o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (flags.has(k)) o[k] = true; else { if (argv[i + 1] === undefined) die(`--${k} needs a value`); o[k] = argv[++i]; }
  }
  return o;
}
function place(o, collectionArg) {
  let collection = collectionArg || o.collection;
  if (!collection) {                             // no file named: the one collection that has a tree here
    const cfg = fs.existsSync('pmx.config.json') ? pmx.readJson('pmx.config.json') : {}, root = path.resolve(cfg.workDir || '.pmx');
    const found = fs.existsSync(root) ? fs.readdirSync(root).map(d => path.join(root, d, 'tree.json')).filter(f => fs.existsSync(f)) : [];
    if (found.length > 1) die('several collections have a tree here - say which one with --collection <file>');
    if (found.length === 1) {
      collection = JSON.parse(fs.readFileSync(found[0], 'utf8')).collection;
      const r = typeof collection === 'string' ? path.relative(process.cwd(), path.resolve(collection)) : '..';
      if (!r || r.startsWith('..') || path.isAbsolute(r)) die(`${rel(found[0])} points at a collection outside this folder. Run tree unpack again.`);
    }
  }
  const ctx = pmx.getCtx({ collection }, undefined);
  return { ctx, treeDir: path.resolve(o.tree || path.join(ctx.work, 'tree')), baseFile: ctx.f('tree-base.json'), manifestFile: ctx.f('tree.json') };
}
const writeFiles = (dir, files) => { for (const [file, content] of files) { const abs = path.join(dir, file); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content); } };
const loadManifest = p => { if (!fs.existsSync(p.manifestFile) || !fs.existsSync(p.baseFile)) die(`no tree yet. Run: ${pmx.SELF} tree unpack ${rel(p.ctx.collection)}`); return JSON.parse(fs.readFileSync(p.manifestFile, 'utf8')); };

function cmdUnpack(o) {
  const p = place(o, o._[0]);
  if (!fs.existsSync(p.ctx.collection)) die(`no such file: ${rel(p.ctx.collection)}`);
  const text = readStrict(p.ctx.collection);
  if (fs.existsSync(p.manifestFile) && fs.existsSync(p.baseFile) && !o.force) {
    const prior = build(p.treeDir, JSON.parse(fs.readFileSync(p.manifestFile, 'utf8')), readStrict(p.baseFile));
    if (prior.errors.length || !same(prior.json, prior.base)) die(`${rel(p.treeDir)} has edits that are not packed yet. Run \`${pmx.SELF} tree pack\` first, or unpack again with --force to discard them.`);
  }
  const { files, scripts } = split(text);
  fs.rmSync(p.treeDir, { recursive: true, force: true });
  writeFiles(p.treeDir, files);
  fs.mkdirSync(path.dirname(p.baseFile), { recursive: true });
  fs.writeFileSync(p.baseFile, text);
  fs.writeFileSync(p.manifestFile, JSON.stringify({ version: 1, collection: rel(p.ctx.collection), baseSha: sha(text), scripts }, null, 1));
  const defs = [...files.keys()].filter(f => f.endsWith('.request.js')).length, folders = [...files.keys()].filter(f => f.endsWith('/folder.js')).length;
  console.log(`unpacked the whole collection -> ${rel(p.treeDir)}/   (${defs} requests, ${folders} folders, ${Object.keys(scripts).length} scripts, ${files.size} files)`);
  console.log(`edit any file there, then:  ${pmx.SELF} tree pack`);
  return 0;
}

function cmdPack(o, quiet) {
  const p = place(o), manifest = loadManifest(p), baseText = readStrict(p.baseFile);
  const b = build(p.treeDir, manifest, baseText, { keepWs: o['keep-whitespace'], allowTestRemoval: o['allow-test-removal'] });
  if (b.errors.length) {
    console.log('TREE PACK REFUSED - fix these first (the collection file was NOT changed):');
    b.errors.forEach(e => console.log('  ' + e));
    return 2;
  }
  const onDisk = fs.existsSync(p.ctx.collection) ? readStrict(p.ctx.collection) : null;
  if (onDisk !== null && ![manifest.baseSha, manifest.lastPackSha].includes(sha(onDisk)) && !o.force) die(`${rel(p.ctx.collection)} was changed by something else since \`tree unpack\`. Unpack again (your edits in the tree would be lost) or pack with --force to overwrite the file.`);
  const out = render(baseText, b.base, b.json, p.ctx.collection);
  if (onDisk !== out.text) writeAtomic(p.ctx.collection, out.text);
  manifest.lastPackSha = sha(out.text);
  fs.writeFileSync(p.manifestFile, JSON.stringify(manifest, null, 1));
  const ops = diffOps(baseText.split('\n'), out.text.split('\n'));
  console.log(`packed -> ${rel(p.ctx.collection)}   (+${ops.filter(x => x[0] === '+').length} -${ops.filter(x => x[0] === '-').length} lines against the unpacked version; ${out.how})`);
  if (b.changed.length) console.log('  scripts changed: ' + b.changed.join(', '));
  if (!quiet) console.log(`next: ${pmx.SELF} tree test`);
  return 0;
}

/* Unpack into a temporary folder, build again without touching anything, and say what came back. */
async function cmdCheck(o) {
  const file = o._[0] || o.collection;
  if (!file || !fs.existsSync(file)) die('usage: tree check <collection.json> [--run]');
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
      plain = (text.charCodeAt(0) === 0xFEFF ? String.fromCharCode(0xFEFF) : '') + JSON.stringify(b.json, null, unit || undefined) === text ? 'the same bytes' : 'different bytes (this file is not in plain JSON.stringify layout)';
      try { const r = require('./treemerge.js').mergeTexts({ file, base: text, ours: text, theirs: JSON.stringify(b.json) }); writer = !r.open && r.text === text ? 'the same bytes' : 'DIFFERENT bytes'; } catch (e) { writer = 'treemerge.js is not next to pmx.js'; }
    }
    const requests = [...files.keys()].filter(f => f.endsWith('.request.js')).length, folders = [...files.keys()].filter(f => f.endsWith('/folder.js')).length;
    console.log(`ROUND TRIP  ${rel(path.resolve(file))}   ${text.split('\n').length} lines, ${Buffer.byteLength(text)} bytes`);
    console.log(`  unpacked into ${files.size} files: ${requests} requests, ${folders} folders, ${Object.keys(scripts).length} scripts`);
    console.log(`  built back from the files: ${identical ? 'IDENTICAL to the original (every key, value and order)' : 'NOT identical'}`);
    b.errors.forEach(e => console.log('    ' + e));
    console.log(`  layout-keeping writer gives: ${writer}`);
    console.log(`  plain re-serialisation gives: ${plain}`);
    let ok = identical && writer === 'the same bytes';
    if (o.run && identical) ok = await sameUnderNewman(text, b.json, o) && ok;
    console.log(`  time: ${Date.now() - t0} ms`);
    console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
    return ok ? 0 : 1;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/* newman, with the options from pmx.config.json and, if given, an environment file named on the command line. */
function newmanRun(collection, o) {
  const newman = pmx.loadNewman();
  const cfg = fs.existsSync('pmx.config.json') ? pmx.readJson('pmx.config.json') : {};
  const options = Object.assign({ reporters: [] }, pmx.interp(cfg.newman || {}), { collection });
  if (o.environment) { if (!fs.existsSync(o.environment)) die(`no such environment file: ${o.environment}`); options.environment = pmx.readJson(o.environment); }
  const where = item => { const names = []; try { for (let x = item; x && x.name !== undefined && typeof x.parent === 'function'; x = x.parent()) names.unshift(x.name); } catch (e) { /* just the name */ } return names.slice(1).join(' / ') || (item && item.name) || '(collection)'; };
  return new Promise(resolve => {
    const assertions = [];
    newman.run(options, (err, summary) => {
      if (err) die('newman could not run: ' + (err.message || err), 1);
      const errors = (summary.run.failures || []).filter(f => !/^assertion/.test(f.at || '')).map(f => `${where(f.source)}: ${(f.error && f.error.name) || 'Error'} at ${f.at || 'script'}: ${(f.error && f.error.message) || ''}`);
      resolve({ assertions, errors });
    }).on('assertion', (e, a) => assertions.push({ request: where(a.item), name: String(a.assertion), result: e ? 'FAIL' : a.skipped ? 'skipped' : 'pass', message: e ? (e.message || e.name) : '' }));
  });
}

/* Run the original and the rebuilt collection through newman and compare every assertion. */
async function sameUnderNewman(text, rebuilt, o) {
  const line = a => `${a.request} :: ${a.name} :: ${a.result}`;
  const before = await newmanRun(JSON.parse(stripBom(text)), o), after = await newmanRun(rebuilt, o);
  const equal = same(before.assertions.map(line), after.assertions.map(line)) && same(before.errors, after.errors);
  console.log(`  newman on the original and on the rebuilt collection: ${before.assertions.length} and ${after.assertions.length} assertions, ${equal ? 'the same results' : 'DIFFERENT results'} (${before.assertions.filter(a => a.result === 'FAIL').length} failing in both)`);
  return equal;
}

/* Pack, then let newman say whether the collection works. */
async function cmdTest(o) {
  const code = cmdPack(o, true);
  if (code) return code;
  const p = place(o), run = await newmanRun(JSON.parse(stripBom(readStrict(p.ctx.collection))), o);
  const failed = run.assertions.filter(a => a.result === 'FAIL');
  const pass = !failed.length && !run.errors.length;
  console.log(pass ? `RESULT: PASS - ${run.assertions.length} assertions, 0 failed` : `RESULT: FAIL - ${failed.length} of ${run.assertions.length} assertions failed` + (run.errors.length ? `, ${run.errors.length} error(s)` : ''));
  let last = null;
  for (const a of failed) { if (a.request !== last) console.log(`\nX ${last = a.request}`); console.log(`  FAILED TEST: ${JSON.stringify(a.name)}\n     ${a.message}`); }
  if (run.errors.length) { console.log('\nERRORS (a script or a request did not run):'); [...new Set(run.errors)].slice(0, 20).forEach(e => console.log('  ' + e)); }
  return pass ? 0 : 1;
}

const HELP = `pmx tree - EXPERIMENTAL: the whole collection as files, not only its scripts

  tree unpack <collection.json>   write every request, folder and script as its own file under .pmx/<name>/tree/
  tree pack                       build the collection from those files; only what changed moves in the JSON
  tree test                       pack, then run newman on the result (options from pmx.config.json)
  tree check <collection.json>    measure the round trip (unpack, build, compare). --run also compares newman results

options: --tree <dir> (where the files go), --collection <file>, --environment <file> (a Postman environment for
newman), --force, --keep-whitespace, --allow-test-removal
The other pmx commands work exactly as before.`;

async function run(argv) {
  const [sub, ...rest] = argv, o = parse(rest);
  if (sub === 'unpack') return cmdUnpack(o);
  if (sub === 'pack') return cmdPack(o);
  if (sub === 'check') return cmdCheck(o);
  if (sub === 'test') return cmdTest(o);
  console.log(HELP);
  return sub && sub !== 'help' && sub !== '--help' ? 2 : 0;
}

module.exports = { run, split, build, render, posix };
