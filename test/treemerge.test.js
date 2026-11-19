'use strict';
// Self-test for treemerge: the engine on its own, then real git merges, the terminal prompts and the browser UI's API.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), http = require('http'), net = require('net');
const { spawnSync, spawn } = require('child_process');
const ROOT = path.join(__dirname, '..'), TM = path.join(ROOT, 'treemerge.js'), FILE = 'Demo.postman_collection.json';
const { mergeTexts } = require(TM);
let n = 0; const ok = name => console.log(`  ok ${++n}  ${name}`);
const J = (v, ind = 2) => JSON.stringify(v, null, ind), clone = v => JSON.parse(JSON.stringify(v));
const m3 = (b, o, t, extra) => mergeTexts(Object.assign({ file: 'x.json', base: b, ours: o, theirs: t }, extra));
const sorted = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(q => [q, x[q]])) : x));

/* ───────── 1. the engine, on any JSON ───────── */
{
  const base = { name: 'app', version: '1.0.0', scripts: { test: 'jest' }, dependencies: { react: '^18.0.0', lodash: '^4.17.0' } };
  const o = clone(base), t = clone(base);
  o.scripts.lint = 'eslint .'; o.dependencies.zod = '^3.0.0'; o.dependencies.react = '^18.2.0';
  t.version = '1.1.0'; t.dependencies.axios = '^1.0.0'; t.dependencies.react = '^18.3.0'; delete t.dependencies.lodash;
  let r = m3(J(base), J(o), J(t)), v = JSON.parse(r.text);
  assert.strictEqual(r.profile, 'json'); assert.strictEqual(r.open, 1);
  assert.deepStrictEqual([v.version, v.scripts.lint, v.dependencies.zod, v.dependencies.axios, v.dependencies.lodash], ['1.1.0', 'eslint .', '^3.0.0', '^1.0.0', undefined]);
  const c = r.entries.find(e => e.status === 'conflict'); assert.deepStrictEqual([c.group, c.field, c.n], ['dependencies', 'react', 1]);
  r = m3(J(base), J(o), J(t), { choices: { [c.key]: 'theirs' } }); assert.strictEqual(r.open, 0); assert.strictEqual(JSON.parse(r.text).dependencies.react, '^18.3.0');
  ok('plain JSON (a package.json): keys from both sides merge, the one real clash is a single decision');
}
{
  const base = { servers: [{ id: 1, host: 'a', port: 80 }, { id: 2, host: 'b', port: 80 }, { id: 3, host: 'c', port: 80 }], tags: ['a', 'b'], box: [1, 2] };
  const o = clone(base), t = clone(base);
  o.servers[1].port = 8080; o.tags.push('c'); o.box[1] = 3;
  t.servers.shift(); t.servers.push({ id: 4, host: 'd', port: 80 }); t.servers[1].host = 'cc'; t.tags.push('d'); t.box[0] = 5;
  let r = m3(J(base), J(o), J(t)), v = JSON.parse(r.text);
  assert.deepStrictEqual(v.servers, [{ id: 2, host: 'b', port: 8080 }, { id: 3, host: 'cc', port: 80 }, { id: 4, host: 'd', port: 80 }]);
  assert.ok(r.entries.some(e => e.group === 'servers[2]' && e.field === 'port' && e.status === 'ours'));
  assert.deepStrictEqual(v.box, [5, 3]);
  const c = r.entries.find(e => e.status === 'conflict'); assert.strictEqual(r.open, 1); assert.strictEqual(c.field, 'tags');
  r = m3(J(base), J(o), J(t), { choices: { [c.key]: { hunks: { [c.chunks.findIndex(x => x.t === 'conflict')]: 'ours+theirs' } } } });
  assert.strictEqual(r.open, 0); assert.deepStrictEqual(JSON.parse(r.text).tags, ['a', 'b', 'c', 'd']);
  ok('lists: identity is inferred (id), same-length lists merge slot by slot, a plain list that both sides extend asks once and "both" works');
}
{
  const ours = '{\n   "name":"caf\\u00e9",\n   "ratio": 1.0,\n   "list": [1, 2,   3],\n   "nested": { "timeout": 30, "retries": 2 },\n   "deep": {\n      "keep": [ "x" ],\n      "port": 80\n   }\n}\n';
  const t = JSON.parse(ours); t.nested.timeout = 60; t.deep.port = 81; t.deep.host = 'h';
  assert.strictEqual(m3(ours, ours, JSON.stringify(t)).text, ours.replace('"timeout": 30', '"timeout": 60').replace('"port": 80', '"port": 81,\n      "host": "h"'));
  ok('layout: odd indentation, inline lists, \\u escapes and 1.0 all survive; only the changed values move');
}
{
  let seed = 11; const rnd = k => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % k;
  const gen = d => { const k = rnd(d > 2 ? 3 : 6); return k === 0 ? rnd(100) : k === 1 ? 's' + rnd(50) : k === 2 ? rnd(2) === 0 : k === 3 ? Array.from({ length: rnd(4) }, () => gen(d + 1)) : Object.fromEntries(Array.from({ length: 1 + rnd(4) }, (_, i) => ['k' + i + rnd(3), gen(d + 1)])); };
  const mutate = v => { if (Array.isArray(v)) { if (v.length && rnd(2)) v[rnd(v.length)] = gen(2); else v.push(gen(2)); } else if (v && typeof v === 'object') { const ks = Object.keys(v), k = ks[rnd(ks.length)]; const q = rnd(4); if (q === 0) delete v[k]; else if (q === 1) v['n' + rnd(9)] = gen(2); else if (v[k] && typeof v[k] === 'object' && rnd(3)) mutate(v[k]); else v[k] = gen(2); } };
  for (let i = 0; i < 1500; i++) {
    const ind = [0, 2, 4, '\t'][rnd(4)], fmt = v => { const s = JSON.stringify(v, null, ind) + '\n'; return rnd(5) ? s : s.replace(/\n/g, '\r\n'); };
    const b = { root: gen(0), other: gen(1) }, o = clone(b), t = clone(b);
    mutate(o); mutate(o.root && typeof o.root === 'object' ? o.root : o); mutate(t);
    const B = fmt(b), O = fmt(o), T = fmt(t);
    assert.strictEqual(m3(B, O, B).text, O, 'only OURS changed -> the result is OURS, byte for byte');
    assert.strictEqual(m3(B, O, O).text, O, 'both made the same change');
    assert.strictEqual(sorted(JSON.parse(m3(B, B, T).text)), sorted(t), 'only THEIRS changed -> the result is THEIRS');
    const r = m3(B, O, T); JSON.parse(r.text);
    for (const side of ['ours', 'theirs']) { const all = m3(B, O, T, { choices: Object.fromEntries(r.entries.filter(e => e.status === 'conflict').map(e => [e.key, side])) }); assert.strictEqual(all.open, 0); JSON.parse(all.text); }
  }
  ok('1500 random documents in 4 layouts: one-sided changes come through exactly, every result parses, every conflict can be settled');
}
{
  const b = 'line1\r\nline2\r\nline3\r\nline4\r\n', file = 'notes.txt';
  let r = mergeTexts({ file, base: b, ours: b.replace('line1', 'LINE1'), theirs: b.replace('line4', 'LINE4').replace(/\r\n/g, '\n') });
  assert.deepStrictEqual([r.kind, r.open, r.text], ['text', 0, 'LINE1\r\nline2\r\nline3\r\nLINE4\r\n']);
  r = mergeTexts({ file, base: b, ours: b.replace('line2', 'ours2'), theirs: b.replace('line2', 'theirs2') }); assert.strictEqual(r.open, 1);
  const e = r.entries[0], i = e.chunks.findIndex(x => x.t === 'conflict');
  r = mergeTexts({ file, base: b, ours: b.replace('line2', 'ours2'), theirs: b.replace('line2', 'theirs2'), choices: { [e.key]: { hunks: { [i]: 'theirs' } } } });
  assert.deepStrictEqual([r.open, r.text], [0, 'line1\r\ntheirs2\r\nline3\r\nline4\r\n']);
  ok('any other text file merges line by line and keeps our line endings');
}
{
  const base = { id: 'e1', name: 'snap', values: [{ key: 'baseUrl', value: 'http://a', enabled: true }, { key: 'token', value: 'x', enabled: true }], _postman_variable_scope: 'environment', _postman_exported_at: '2024-01-01T00:00:00Z' };
  const o = clone(base), t = clone(base);
  o.values[0].value = 'http://b'; o.values.push({ key: 'timeout', value: '5', enabled: true }); o._postman_exported_at = '2024-02-02T00:00:00Z';
  t.values[1].value = 'y'; t.values.push({ key: 'region', value: 'us', enabled: true }); t._postman_exported_at = '2024-03-03T00:00:00Z'; t.id = 'e2';
  const r = mergeTexts({ file: 'snap.postman_environment.json', base: J(base, '\t'), ours: J(o, '\t'), theirs: J(t, '\t') }), v = JSON.parse(r.text);
  assert.deepStrictEqual([r.profile, r.open, v.id, v._postman_exported_at], ['postman', 0, 'e1', '2024-02-02T00:00:00Z']);
  assert.deepStrictEqual(v.values.map(x => x.key + '=' + x.value), ['baseUrl=http://b', 'token=y', 'timeout=5', 'region=us']);
  ok('a Postman environment: variables merge by key, export timestamps and ids never conflict');
}

/* ───────── 2. through real git merges ───────── */
function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pmx-merge-'));
  const sh = (cmd, ...a) => spawnSync(cmd, a, { cwd: d, encoding: 'utf8' });
  const git = (...a) => { const r = sh('git', ...a); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
  const tm = (...a) => { const input = a[0] && a[0].stdin; if (input !== undefined) a.shift(); const r = spawnSync(process.execPath, [TM, ...a], { cwd: d, encoding: 'utf8', input }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
  const read = () => JSON.parse(fs.readFileSync(path.join(d, FILE), 'utf8'));
  const write = c => fs.writeFileSync(path.join(d, FILE), JSON.stringify(c, null, '\t'));
  const commit = msg => { git('add', '-A'); assert.strictEqual(git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', msg).code, 0); };
  git('init', '-q', '-b', 'main', '.');
  fs.writeFileSync(path.join(d, '.gitignore'), '.pmx/\n');
  spawnSync(process.execPath, [path.join(ROOT, 'demo', 'make-demo.js'), d]);
  return { d, git, tm, read, write, commit, text: () => fs.readFileSync(path.join(d, FILE), 'utf8') };
}
const probe = (x, id) => ({ name: 'Probe ' + x, event: [{ listen: 'test', script: { id, exec: [`pm.test("probe ${x}", function () {\r`, '    pm.response.to.have.status(200);\r', '});'], type: 'text/javascript' } }],
  request: { method: 'GET', header: [], url: { raw: '{{baseUrl}}/health', host: ['{{baseUrl}}'], path: ['health'] } }, response: [] });
const days = id => ({ name: 'Opening days', event: [{ listen: 'test', script: { id, exec: ['const openDays = [\r', '    "monday",\r', '    "friday"\r', '];\r', 'pm.test("the shop lists its opening days", function () {\r', '    pm.expect(pm.response.json().days).to.eql(openDays);\r', '});'], type: 'text/javascript' } }],
  request: { method: 'GET', header: [], url: { raw: '{{baseUrl}}/hours', host: ['{{baseUrl}}'], path: ['hours'] } }, response: [] });
const exec = (c, f, r) => c.item[f].item[r].event[c.item[f].item[r].event.length - 1].script.exec;
const setExec = (c, f, r, fn) => { const ev = c.item[f].item[r].event; const cur = ev[ev.length - 1].script.exec; const lines = fn(cur.map(l => l.replace(/\r$/, ''))); ev[ev.length - 1].script.exec = lines.map((l, i) => (i < lines.length - 1 ? l + '\r' : l)); };
const ids = (c, tag) => { let i = 0; JSON.stringify(c, (k, v) => { if (k === 'script' && v && typeof v === 'object') v.id = `${tag}-${++i}`; return v; }); c.info._postman_id = tag + '-collection'; };
const PING = [0, 0], CAT = [1, 0], MISC = 3, DAYS = [MISC, 0];                 // demo requests, and the folder this test adds
const picks = c => c.item[1].item[1].item[0];                                   // Catalogue / Staff picks / Picks by genre

function base(R) {
  const c = R.read();
  c.item.push({ name: 'Misc', item: [days('b0'), probe('A', 'b1'), probe('B', 'b2'), probe('C', 'b3')] });
  ids(c, 'base'); R.write(c); R.commit('base');
}
function ours(R, conflict) {                      // the feature branch
  const c = R.read();
  c.item[MISC].item.push(probe('OURS', 'x'));                                                     // both branches append to the same folder
  setExec(c, ...CAT, l => { const i = l.indexOf('pm.test("Catalogue answers with 200", function () {'); assert.ok(i > 0); l.splice(i, 0, 'pm.test("Catalogue answers with JSON", function () {', '    pm.response.to.be.json;', '});', ''); return l; });
  c.item[CAT[0]].item[CAT[1]].request.header.push({ key: 'Accept', value: 'application/json' });
  c.item[MISC].item[3].name = 'Probe C (renamed)';                                                // rename only
  const nested = picks(c);                                                                       // re-indent a whole script: whitespace only
  nested.event[0].script.exec = nested.event[0].script.exec.map(l => l.replace(/^( +)/, m => ' '.repeat(Math.ceil(m.length / 2))));
  if (conflict) {
    setExec(c, ...DAYS, l => l.map(x => (x === '    "friday"' ? '    "friday",\n    "saturday"' : x)).join('\n').split('\n'));
    c.item[MISC].item.splice(2, 1);                                                               // delete Probe B (they change it)
  }
  ids(c, 'ours'); R.write(c); R.commit('ours');
}
function theirs(R, conflict) {                    // dev
  const c = R.read();
  c.item[MISC].item.push(probe('THEIRS', 'y'));
  setExec(c, ...CAT, l => l.map(x => x.replace('["hardcover", "paperback", "ebook"]', '["hardcover", "paperback", "ebook", "audio"]')));   // other end of the same script
  c.item[CAT[0]].item[CAT[1]].request.header.push({ key: 'X-Trace', value: '1' });
  c.item[PING[0]].item[PING[1]].request.url.raw += '?v=2';
  setExec(c, MISC, 3, l => l.concat(['console.log("probe C done");']));                          // edit the request we renamed
  picks(c).event[0].script.exec = picks(c).event[0].script.exec.map(l => l.replace('["history", "poetry"]', '["history", "poetry", "travel"]'));
  c.item[MISC].item.splice(1, 1);                                                                 // delete Probe A (we did not touch it)
  if (conflict) {
    setExec(c, ...DAYS, l => l.map(x => (x === '    "friday"' ? '    "friday",\n    "sunday"' : x)).join('\n').split('\n'));
    c.item[MISC].item[1].event[0].script.exec[1] = '    pm.response.to.have.status(204);\r';       // change Probe B (now index 1)
  }
  ids(c, 'theirs'); R.write(c); R.commit('theirs');
}
function branches(R, conflict) {
  base(R);
  R.git('checkout', '-q', '-b', 'dev'); theirs(R, conflict);
  R.git('checkout', '-q', 'main'); R.git('checkout', '-q', '-b', 'feature'); ours(R, conflict);
}
function checkCommon(c, text) {
  const names = c.item[MISC].item.map(i => i.name);
  assert.ok(names.includes('Probe OURS') && names.includes('Probe THEIRS') && !names.includes('Probe A'), names.join());
  assert.ok(names.indexOf('Probe OURS') < names.indexOf('Probe THEIRS'));
  const cat = exec(c, ...CAT).join('\n');
  assert.ok(cat.includes('pm.test("Catalogue answers with JSON"') && cat.includes('"ebook", "audio"]'));
  assert.deepStrictEqual(c.item[CAT[0]].item[CAT[1]].request.header.map(h => h.key), ['Accept', 'X-Trace']);
  assert.ok(c.item[PING[0]].item[PING[1]].request.url.raw.endsWith('?v=2'));
  const pc = c.item[MISC].item.find(i => i.name === 'Probe C (renamed)'); assert.ok(pc && pc.event[0].script.exec.join('').includes('probe C done'));
  const nested = picks(c).event[0].script.exec.join('\n'); assert.ok(nested.includes('["history", "poetry", "travel"]'));
  assert.strictEqual(c.info._postman_id, 'ours-collection');                                       // ids regenerated on both sides: never a conflict
  for (const s of [exec(c, ...CAT), pc.event[0].script.exec]) assert.ok(s.slice(0, -1).every(l => l.endsWith('\r')) && !s[s.length - 1].endsWith('\r'), 'line endings');
  assert.strictEqual(text, JSON.stringify(c, null, '\t'), 'layout');
}

const G = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
let R = repo(); branches(R, false);
assert.notStrictEqual(R.git('merge', 'dev').code, 0); assert.throws(() => R.read());
let r = R.tm('--no-ui'); assert.strictEqual(r.code, 0, r.out);
assert.match(r.out, /\(postman rules\)/); assert.match(r.out, /CONFLICTS: none/); assert.match(r.out, /NEXT: git add Demo\.postman_collection\.json/);
checkCommon(R.read(), R.text()); ok('git left broken JSON; treemerge merges it with nothing to ask (both additions, line-merged script, rename + edit, ids ignored)');
R.git('add', FILE); assert.strictEqual(R.git(...G, 'commit', '-qm', 'merge').code, 0);
r = R.tm('diff', FILE, 'HEAD~1'); assert.match(r.out, /Misc \/ Probe THEIRS\n {2}\+ \(whole request\): added/); assert.match(r.out, /Misc \/ Probe A\n {2}- \(whole request\): removed/);
assert.match(r.out, /Catalogue \/ Genres and formats\n {2}~ test script: \+1 -1 lines\n {2}\+ request\.header\[X-Trace\]: added/); assert.doesNotMatch(r.out, /_postman_id/); ok('diff says what the merge brought in, in request terms');

R = repo(); branches(R, true);
fs.writeFileSync(path.join(R.d, 'notes.txt'), 'one\ntwo\nthree\n'); R.git('checkout', '-q', 'main'); fs.writeFileSync(path.join(R.d, 'notes.txt'), 'one\ntwo\nthree\n'); R.commit('notes');
for (const [br, word] of [['dev', 'DEV'], ['feature', 'FEATURE']]) { R.git('checkout', '-q', br); R.git(...G, 'merge', '-q', '--no-edit', 'main'); fs.writeFileSync(path.join(R.d, 'notes.txt'), `one\n${word}\nthree\n`); R.commit('notes ' + br); }
assert.notStrictEqual(R.git('merge', 'dev').code, 0);
r = R.tm('--no-ui'); assert.strictEqual(r.code, 1, r.out);
assert.match(r.out, /CONFLICTS: 2 need a decision/); assert.match(r.out, /#1 {2}Misc \/ Opening days {2}> {2}test script/); assert.match(r.out, /#2 {2}Misc \/ Probe B {2}> {2}\(whole request\)\n\s+OURS deleted it, THEIRS changed it/);
assert.match(r.out, /notes\.txt .*\(plain text, line by line\)\n.*\nCONFLICTS: 1 need a decision/);
checkCommon(R.read(), R.text()); ok('real conflicts: the JSON stays valid, everything else is merged, and a plain text file in the same merge is handled too');
const cf = path.join(R.d, /fix: {2}edit (\S+Opening\S+\.js)/.exec(r.out)[1]), marked = fs.readFileSync(cf, 'utf8');
assert.match(marked, /<<<<<<< OURS\n {4}"friday",\n {4}"saturday"\n\|\|\|\|\|\|\| BASE\n {4}"friday"\n=======\n {4}"friday",\n {4}"sunday"\n>>>>>>> THEIRS/); assert.ok(!marked.includes('\\r'));
fs.writeFileSync(cf, marked.replace(/<<<<<<< OURS[\s\S]*>>>>>>> THEIRS/, '    "friday",\n    "saturday"\n    "sunday"'));
r = R.tm('--no-ui', FILE); assert.strictEqual(r.code, 1); assert.match(r.out, /not valid JavaScript/);
fs.writeFileSync(cf, marked.replace(/<<<<<<< OURS[\s\S]*>>>>>>> THEIRS/, '    "friday",\n    "saturday",\n    "sunday"'));
r = R.tm('--no-ui', FILE, '--take-theirs', '2'); assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /#1 {2}settled/); assert.match(r.out, /#2 {2}settled/);
let c = R.read(); checkCommon(c, R.text());
assert.ok(exec(c, ...DAYS).join('\n').includes('"saturday",\r\n    "sunday"\r')); assert.ok(c.item[MISC].item.find(i => i.name === 'Probe B').event[0].script.exec[1].includes('204'));
r = R.tm('--no-ui', FILE, '--take-ours', '2'); assert.strictEqual(r.code, 0); assert.ok(!R.read().item[MISC].item.some(i => i.name === 'Probe B'));
ok('without the UI: edit the small conflict file or use --take-ours/--take-theirs; a resolution that does not parse is refused; decisions can change');

/* terminal prompts */
r = R.tm({ stdin: 't\n' }, '--tui', 'notes.txt'); assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /conflict #1/); assert.strictEqual(fs.readFileSync(path.join(R.d, 'notes.txt'), 'utf8'), 'one\nDEV\nthree\n');
R = repo(); branches(R, true); R.git('merge', 'dev');
r = R.tm({ stdin: 'b\nu\nt\no\n' }, '--tui'); assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /not valid JavaScript/);
c = R.read(); assert.ok(exec(c, ...DAYS).join('').includes('sunday') && !exec(c, ...DAYS).join('').includes('saturday')); assert.ok(!c.item[MISC].item.some(i => i.name === 'Probe B'));
ok('--tui: answer o / t / b per block in the terminal; an answer that breaks the script is not accepted');

/* preview + git integration */
R = repo(); branches(R, false);
const before = fs.readFileSync(path.join(R.d, FILE));
r = R.tm(FILE, '--theirs', 'dev', '--no-ui'); assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /PREVIEW ONLY/); assert.ok(fs.readFileSync(path.join(R.d, FILE)).equals(before)); assert.strictEqual(R.git('status', '--porcelain').out.trim(), '');
ok('--theirs <branch> previews a merge; nothing is written and git status stays clean');
assert.strictEqual(R.tm('install', '*.postman_collection.json').code, 0);
r = R.git(...G, 'merge', '--no-edit', 'dev'); assert.strictEqual(r.code, 0, r.out); checkCommon(R.read(), R.text()); ok('after install, a plain `git merge dev` just works');
R = repo(); branches(R, true); R.tm('install', '*.postman_collection.json');
r = R.git('merge', 'dev'); assert.notStrictEqual(r.code, 0); assert.match(r.out, /2 real conflict\(s\) left/); R.read();
r = R.tm('--no-ui', '--take-theirs', 'all'); assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /CONFLICTS: 0 need a decision {3}\(2 already settled\)/); ok('merge driver + real conflicts: git stops, the file stays valid, --take-theirs all finishes it');

/* hardening: what a branch someone else wrote must not be able to do */
R = repo(); branches(R, true); R.git('merge', 'dev');
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-outside-')), outsideFile = path.join(outsideDir, 'profile');
fs.writeFileSync(outsideFile, 'keep me');
let canLink = true;
try { fs.symlinkSync(outsideFile, path.join(R.d, FILE + '.treemerge-tmp')); fs.symlinkSync(outsideFile, path.join(R.d, '.gitattributes')); } catch (e) { canLink = false; }   // not on every Windows setup
r = R.tm('--no-ui'); assert.strictEqual(r.code, 1, r.out); checkCommon(R.read(), R.text());
assert.strictEqual(R.tm('install', '*.postman_collection.json').code, 0);
assert.strictEqual(fs.readFileSync(outsideFile, 'utf8'), 'keep me');
if (canLink) { assert.ok(fs.lstatSync(path.join(R.d, '.gitattributes')).isFile()); assert.match(fs.readFileSync(path.join(R.d, '.gitattributes'), 'utf8'), /merge=treemerge/); }
ok('a link planted at the old temporary path, or in place of .gitattributes, is replaced and never written through');

R = repo(); branches(R, true); R.git('merge', 'dev');
fs.mkdirSync(path.join(R.d, '.treemerge', 'planted'), { recursive: true }); fs.writeFileSync(path.join(R.d, '.treemerge', 'planted', 'choices.json'), '{}');
R.git('add', '-f', '.treemerge');                                                                  // what a merged branch that tracks .treemerge/ leaves behind
r = R.tm('--no-ui'); assert.strictEqual(r.code, 2, r.out); assert.match(r.out, /\.treemerge\/ is tracked by git/); assert.throws(() => R.read());
R.git('rm', '-r', '-q', '--cached', '.treemerge'); fs.rmSync(path.join(R.d, '.treemerge'), { recursive: true, force: true });
r = R.tm('--no-ui'); assert.strictEqual(r.code, 1, r.out); assert.match(r.out, /CONFLICTS: 2 need a decision/);
if (canLink) {
  fs.rmSync(path.join(R.d, '.treemerge'), { recursive: true, force: true }); fs.symlinkSync(outsideDir, path.join(R.d, '.treemerge'));
  r = R.tm('--no-ui'); assert.strictEqual(r.code, 2, r.out); assert.match(r.out, /is not a plain folder/); assert.deepStrictEqual(fs.readdirSync(outsideDir), ['profile']);
}
ok('a .treemerge folder that git tracks, or that is a link to somewhere else, is refused instead of trusted');

/* ───────── 3. the browser UI's server ───────── */
(async () => {
  R = repo(); branches(R, true); R.git('merge', 'dev');
  const child = spawn(process.execPath, [TM, '--ui', '--no-open', '--port', '0'], { cwd: R.d });
  let out = ''; child.stdout.on('data', d => { out += d; });
  const exit = new Promise(res => child.on('exit', res));
  try {
    for (let i = 0; i < 100 && !/\?k=[0-9a-f]+/.test(out); i++) await new Promise(res => setTimeout(res, 50));
    const url = /http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]+/.exec(out)[0], origin = url.split('/?')[0], k = url.split('k=')[1];
    const call = async (p, body) => (await fetch(`${origin}${p}${p.includes('?') ? '&' : '?'}k=${k}`, body ? { method: 'POST', body: JSON.stringify(body) } : undefined)).json();
    assert.strictEqual((await fetch(origin + '/')).status, 403); assert.strictEqual((await fetch(origin + '/api/docs?k=nope')).status, 403);
    const evil = await new Promise(res => http.get({ host: '127.0.0.1', port: +origin.split(':')[2], path: '/api/docs?k=' + k, headers: { Host: 'evil.example' } }, x => res(x.statusCode)));
    assert.strictEqual(evil, 403); assert.match(await (await fetch(url)).text(), /<title>treemerge<\/title>/);
    ok('UI server: this machine only, needs the secret link, rejects other Host names');
    const firstLine = await new Promise(res => { let got = ''; const sock = net.connect(+origin.split(':')[2], '127.0.0.1', () => sock.write('GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')); sock.on('data', d => { got += d; }); sock.on('close', () => res(got.split('\r\n')[0])); sock.on('error', () => res('socket error')); setTimeout(() => sock.destroy(), 3000); });
    assert.match(firstLine, /^HTTP\/1\.1 400/); assert.strictEqual((await fetch(origin + '/api/docs?k=' + k)).status, 200);
    ok('UI server: a request line that is not a URL gets 400 and the server keeps running');
    assert.deepStrictEqual((await call('/api/docs')).map(d => [d.file, d.open, d.profile]), [[FILE, 2, 'postman']]);
    const doc = await call('/api/doc?i=0'), [c1, c2] = doc.entries.filter(e => e.status === 'conflict');
    let d1 = await call('/api/entry?i=0&key=' + encodeURIComponent(c1.key)); const hunk = d1.chunks.find(x => x.t === 'conflict');
    assert.deepStrictEqual(hunk.both, ['    "friday",', '    "saturday"', '    "sunday"']);
    let res = await call('/api/choose?i=0', { key: c1.key, choice: { hunk: hunk.i, pick: 'ours+theirs' } }); assert.strictEqual(res.entry.status, 'conflict'); assert.match(res.entry.problem, /not valid JavaScript/);
    const word = 'Pr' + String.fromCharCode(0xFC) + 'fgr' + String.fromCharCode(0xF6, 0xDF) + 'e';       // a word with three two-byte characters
    const payload = Buffer.from(JSON.stringify({ key: c1.key, choice: { hunk: hunk.i, pick: { lines: ['    "friday",', '    "saturday",', '    "sunday" // ' + word] } } }), 'utf8');
    const cut = payload.indexOf(Buffer.from(String.fromCharCode(0xFC), 'utf8')) + 1;                  // in the middle of the first of them
    res = await new Promise((resolve, reject) => { const q = http.request({ host: '127.0.0.1', port: +origin.split(':')[2], path: '/api/choose?i=0&k=' + k, method: 'POST' }, x => { let b = ''; x.setEncoding('utf8'); x.on('data', d => { b += d; }); x.on('end', () => resolve(JSON.parse(b))); }); q.on('error', reject); q.setNoDelay(true); q.write(payload.subarray(0, cut)); setTimeout(() => q.end(payload.subarray(cut)), 200); });
    assert.strictEqual(res.entry.status, 'resolved');
    const d2 = await call('/api/entry?i=0&key=' + encodeURIComponent(c2.key)); assert.ok(d2.absent.ours && /status\(204\)/.test(d2.theirs) && !d2.theirs.includes('\\r'));
    res = await call('/api/choose?i=0', { key: c2.key, choice: { side: 'theirs' } }); assert.strictEqual(res.doc.counts.conflict, 0);
    res = await call('/api/save', { add: true }); assert.match(res.messages[0], /saved and marked resolved \(git add\)/);
    await call('/api/close', {}); assert.strictEqual(await exit, 0);
    assert.strictEqual(R.git('status', '--porcelain').out.trim(), 'M  ' + FILE); checkCommon(R.read(), R.text());
    assert.ok(exec(R.read(), ...DAYS).join('\n').includes('"sunday" // ' + word), 'a character split across two pieces of the request was damaged');
    ok('UI flow over its API: "both" that breaks the script is refused, an edited block (sent in two pieces, split inside a character) is accepted intact, Save writes the file and stages it');
  } finally { child.kill(); }
  console.log(`\nall ${n} treemerge checks passed`);
})().catch(e => { console.error('\nTREEMERGE TEST FAILED\n' + (e.stack || e)); process.exit(1); });
