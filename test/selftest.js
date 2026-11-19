'use strict';
// End-to-end self-test for pmx. It builds the demo collection, starts the pretend bookshop API and then
// drives pmx.js through its commands the way a person would. Needs newman (npm install).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PMX = path.join(ROOT, 'pmx.js');
const { mergeScript, diffOps } = require(PMX);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pmx-selftest-'));
const PORT = String(4100 + Math.floor(Math.random() * 800));
const COLLECTION = path.join(work, 'Demo.postman_collection.json');
const scriptFile = (...parts) => path.join(work, '.pmx', 'Demo', 'scripts', ...parts);
const CATALOGUE = scriptFile('Catalogue', 'Genres_and_formats.test.js');
const PICKS = scriptFile('Catalogue', 'Staff_picks', 'Picks_by_genre.test.js');
const ORDERS = scriptFile('Orders', 'Open_orders.test.js');

function pmx(...args) {
  const r = spawnSync(process.execPath, [PMX, ...args], { cwd: work, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const read = file => fs.readFileSync(file, 'utf8');
const edit = (file, change) => fs.writeFileSync(file, change(read(file)));
const must = (text, a, b) => { assert.ok(text.includes(a), 'the demo script no longer contains: ' + a); return text.replace(a, b); };
const count = (text, part) => text.split(part).length - 1;
const changedLines = (a, b) => diffOps(a.split('\n'), b.split('\n')).filter(op => op[0] !== '=').length;
const RLO = String.fromCharCode(0x202E);          // RIGHT-TO-LEFT OVERRIDE: an invisible character that reorders the text after it
const BOM = String.fromCharCode(0xFEFF);          // the byte-order mark some editors put at the start of a file
let passed = 0;
const ok = name => console.log(`  ok ${++passed}  ${name}`);

// The three edits that make the demo collection pass.
const ignoreOrder = code => must(must(code, 'fromApi.every(function (name, i) {', 'fromApi.every(function (name) {'), 'return name === wanted[i];', 'return wanted.includes(name);');
const addTravel = code => must(code, '["history", "cooking", "poetry"]', '["history", "cooking", "poetry", "travel"]');
const allowPreorder = code => must(code, 'return line.status !== "in stock";', 'return line.status !== "in stock" && line.status !== "preorder";');
// What an editor or a model can do to a whole file while making a small fix:
// halve every indent, strip trailing spaces, switch to CRLF and leave blank lines at the end.
const reformatted = code => code.split('\n').map(line => line.replace(/^ +/, m => ' '.repeat(m.length / 2)).replace(/\s+$/, '')).join('\r\n') + '\r\n\r\n';

async function main() {
  spawnSync(process.execPath, [path.join(ROOT, 'demo', 'make-demo.js'), work], { env: Object.assign({}, process.env, { PORT }) });
  fs.writeFileSync(path.join(work, 'pmx.config.json'), JSON.stringify({ collection: 'Demo.postman_collection.json', newman: { timeoutRequest: 10000 } }));
  const api = spawn(process.execPath, [path.join(ROOT, 'demo', 'mock-server.js')], { env: Object.assign({}, process.env, { PORT }), stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 400));
  let r;
  try {
    const original = fs.readFileSync(COLLECTION);

    r = pmx('unpack', 'Demo.postman_collection.json');
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /unpacked 6 scripts from 4 requests/);
    assert.ok(fs.existsSync(scriptFile('_collection.prerequest.js')), 'the collection-level script is unpacked too');
    r = pmx('pack');
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(fs.readFileSync(COLLECTION).equals(original));
    ok('unpack + pack with no edits leaves the collection byte-identical');

    r = pmx('test');
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /RESULT: FAIL - 5 of 10 assertions failed, in 3 request/);
    assert.match(r.out, /FAILED TEST: "Every line of an open order is available"\n\s+edit -> \.pmx\/Demo\/scripts\/Orders\/Open_orders\.test\.js:8\n/);
    assert.match(r.out, /FAILED TEST: "Catalogue lists the right genres"\n\s+edit -> \.pmx\/Demo\/scripts\/Catalogue\/Genres_and_formats\.test\.js:9\n/);
    assert.match(r.out, /only in 1st list: \["travel"\]/);
    assert.match(r.out, /same members, different ORDER/);
    assert.match(r.out, /values across these failures: b-104 \(x2\) \| b-107 \(x1\)/);
    assert.match(r.out, /\(\+1 inherited folder\/collection script\(s\)\)/);
    ok('newman failures become a short digest with file:line, list-diff hints and a tally of values');

    edit(CATALOGUE, code => reformatted(addTravel(ignoreOrder(code))));
    r = pmx('status');
    assert.match(r.out, /Genres_and_formats\.test\.js {3}\+3 -3/);
    assert.match(r.out, /\(6 whitespace-only line edit\(s\) ignored/);
    assert.match(r.out, /TWIN CODE: 1 place/);
    assert.match(r.out, /Staff_picks\/Picks_by_genre\.test\.js:11 /);
    ok('a re-indented CRLF edit is reduced to the 3 real lines, and the pasted copy of the helper is found');

    r = pmx('sync');
    assert.strictEqual(r.code, 0, r.out);
    const twin = read(PICKS);
    assert.ok(twin.includes('fromApi.every(function (name) {') && twin.includes('return wanted.includes(name);'));
    assert.ok(twin.includes('expectSameNames("genres with picks"'), 'the rest of the other script is untouched');
    assert.doesNotMatch(pmx('status').out, /TWIN CODE/);
    ok('sync copies the edit into the other request');

    r = pmx('test', '--failed');
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /RESULT: FAIL - 2 of 9 assertions failed, in 1 request\(s\) {3}\[partial run: 3 previously failing request\(s\)\]/);
    assert.doesNotMatch(r.out, /Catalogue lists the right/);
    ok('--failed re-runs only the failing requests; fixed ones drop out');

    edit(ORDERS, allowPreorder);
    r = pmx('test', '--failed');
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /partial run/);
    r = pmx('test');
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /RESULT: PASS - 10 assertions, 0 failed/);
    ok('full run is green after the fixes');

    const packed = read(COLLECTION);
    assert.strictEqual(changedLines(original.toString('utf8'), packed), 3 + 3 + 2 + 2 + 1 + 1);
    ok('collection diff is exactly the 12 changed script lines, nothing else');

    assert.ok(packed.includes('return wanted.includes(name);\\r"'), 'a changed line ends in \\r like the lines around it');
    assert.doesNotMatch(packed, /[^\\]\\n"/, 'no script line carries a bare \\n');
    const col = JSON.parse(packed);
    for (const exec of [col.item[1].item[0].event[0].script.exec, col.item[1].item[1].item[0].event[0].script.exec, col.item[2].item[0].event[1].script.exec]) {
      assert.ok(exec.slice(0, -1).every(line => line.endsWith('\r')) && !exec[exec.length - 1].endsWith('\r'));
    }
    ok('changed lines got the same \\r line ending as their neighbours');

    const goodOrders = read(ORDERS);
    edit(ORDERS, code => code + '\n// </span><script>alert(1)</script> ' + RLO);
    r = pmx('view');
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /3 changed script\(s\), \+7 -6/);
    const page = read(path.join(work, '.pmx', 'Demo', 'diff.html'));
    assert.match(page, /Content-Security-Policy" content="default-src 'none'; style-src 'sha256-[A-Za-z0-9+\/=]+'; base-uri 'none'; form-action 'none'"/);
    assert.doesNotMatch(page, /<script|<img|<link|<iframe|<form|\son\w+=|(src|href)="(?!#)|url\(|@import/i);
    assert.ok(page.includes('&#60;script&#62;alert(1)') && page.includes('>U+202E<') && !page.includes(RLO));
    assert.match(page, /3 scripts changed/);
    assert.match(page, /<mark>, &#34;travel&#34;<\/mark>/);
    assert.match(page, /Scripts were edited after this run/);
    assert.strictEqual(read(COLLECTION), packed);
    ok('view writes a static HTML diff: no script, no outside reference, script text escaped, collection untouched');

    fs.writeFileSync(ORDERS, goodOrders + '\nvar broken = ;');
    r = pmx('pack');
    assert.strictEqual(r.code, 2);
    assert.match(r.out, /SYNTAX ERROR .*Open_orders\.test\.js:\d+/);
    assert.strictEqual(read(COLLECTION), packed);
    ok('syntax error is refused and the collection is left alone');

    const withoutOneTest = goodOrders.replace(/pm\.test\("There are open orders to look at"[\s\S]*?\n}\);\n/, '');
    assert.notStrictEqual(withoutOneTest, goodOrders);
    fs.writeFileSync(ORDERS, withoutOneTest);
    r = pmx('pack');
    assert.strictEqual(r.code, 2);
    assert.match(r.out, /dropped from 2 to 1/);
    ok('deleting a pm.test is refused');
    fs.writeFileSync(ORDERS, goodOrders);

    fs.writeFileSync(path.join(work, 'ci.log'), [
      '  Pass  Something earlier', '',
      '  #  failure         detail                                                          ', '',
      ' 1.  AssertionError  Every line of an open order is available                        ',
      '                     order 7 is waiting for ["b-104"]: expected false to be true     ',
      '                     at assertion:1 in test-script                                   ',
      '                     inside "Orders / Open orders"                                   ', '',
      ' 2.  TypeError       Cannot read properties of undefined (reading \'x\')              ',
      '                     at test-script                                                  ',
      '                     inside "Catalogue / Staff picks / Picks by genre"               ', '',
      '[Pipeline] junit', ''].join('\n'));
    r = pmx('digest', 'ci.log');
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /1x FAILED TEST: "Every line of an open order is available"\n\s+edit -> .*Open_orders\.test\.js:8/);
    assert.match(r.out, /SCRIPT ERROR/);
    assert.match(r.out, /Catalogue\/Staff_picks\/Picks_by_genre\.test\.js/);
    ok('digest maps a CI console log back to script files');

    edit(CATALOGUE, code => must(code, 'pm.test("Catalogue answers with 200"', 'pm.test("Catalogue answers OK"'));
    r = pmx('test');
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /TESTS THAT STOPPED RUNNING[\s\S]*"Catalogue answers with 200" ran 1x before, 0x now/);
    ok('a test that silently disappears from the run is reported');

    pmx('restore', '--all');
    r = pmx('pack');
    assert.ok(fs.readFileSync(COLLECTION).equals(original));
    ok('restore --all + pack returns the original bytes');

    edit(CATALOGUE, code => code + '\nconsole.log("added at the end");');
    assert.doesNotMatch(pmx('status').out, /TWIN CODE/);
    assert.match(pmx('sync').out, /no twin code found/);
    assert.strictEqual(count(read(CATALOGUE), 'added at the end'), 1);
    ok('sync does not treat a line added at the end of a script as its own twin');
    pmx('restore', '--all');

    fs.appendFileSync(COLLECTION, '\n');
    edit(ORDERS, code => code + '\n// x');
    r = pmx('pack');
    assert.strictEqual(r.code, 2);
    assert.match(r.out, /changed by something other than pmx/);
    ok('refuses to overwrite a collection that changed underneath it');

    const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmx-calls-'));
    fs.writeFileSync(path.join(helperDir, 'H.postman_collection.json'), JSON.stringify({
      info: { name: 'H', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{
        name: 'Main',
        event: [
          { listen: 'prerequest', script: { exec: ['pm.sendRequest("http://127.0.0.1:' + PORT + '/health", function () {});'] } },
          { listen: 'test', script: { exec: ['pm.test("never true", function () { pm.expect(1).to.equal(2); });'] } },
        ],
        request: { method: 'GET', header: [], url: 'http://127.0.0.1:' + PORT + '/catalogue' },
        response: [],
      }],
    }, null, '\t'));
    fs.writeFileSync(path.join(helperDir, 'pmx.config.json'), JSON.stringify({ collection: 'H.postman_collection.json', newman: { timeoutRequest: 10000 } }));
    const inHelperDir = (...args) => spawnSync(process.execPath, [PMX, ...args], { cwd: helperDir, encoding: 'utf8' });
    assert.strictEqual(inHelperDir('unpack', 'H.postman_collection.json').status, 0);
    r = inHelperDir('test');
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp('failing calls: GET http://127\\.0\\.0\\.1:' + PORT + '/catalogue -> 200\n'));
    assert.doesNotMatch(r.stdout, /failing calls:.*\/health/);
    ok('"failing calls" names the request itself, not a request its pre-request script made');
  } finally {
    api.kill();
  }

  // Other ways a collection file can be laid out. Each must survive unpack + pack untouched,
  // and take a one-line edit that contains a quote and a backslash.
  const base = JSON.parse(read(path.join(work, '.pmx', 'Demo', 'base.json')));
  const copy = change => JSON.parse(JSON.stringify(base), (key, value) => (key === 'exec' ? change(value) : value));
  const shapes = {
    tabs: JSON.stringify(base, null, '\t'),
    spaces4: JSON.stringify(base, null, 4),
    minified: JSON.stringify(base),
    crlfFile: JSON.stringify(base, null, 2).replace(/\n/g, '\r\n'),
    bom: BOM + JSON.stringify(base, null, '\t'),
    lfScripts: JSON.stringify(copy(lines => lines.map(line => line.replace(/\r$/, ''))), null, '\t'),
    execString: JSON.stringify(copy(lines => lines.join('\n')), null, '\t'),
    wrapped: JSON.stringify({ collection: base }, null, '\t'),
  };
  const anchor = 'const body = pm.response.json();';
  const withExtraLine = anchor + '\nvar added = "q\\"uote\\\\";';
  for (const [name, text] of Object.entries(shapes)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmx-shape-'));
    const file = path.join(dir, 'X.postman_collection.json');
    fs.writeFileSync(file, text);
    const run = (...args) => spawnSync(process.execPath, [PMX, ...args], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(run('unpack', 'X.postman_collection.json').status, 0);
    assert.strictEqual(run('pack').status, 0);
    assert.strictEqual(read(file), text, name + ': unpack + pack changed the file');

    const js = path.join(dir, '.pmx', 'X', 'scripts', 'Catalogue', 'Genres_and_formats.test.js');
    fs.writeFileSync(js, must(read(js), anchor, withExtraLine));
    const packRun = run('pack');
    assert.strictEqual(packRun.status, 0, name + packRun.stdout + packRun.stderr);
    const after = read(file);
    const scriptOf = json => {
      const parsed = JSON.parse(json.startsWith(BOM) ? json.slice(1) : json);
      const exec = (parsed.collection || parsed).item[1].item[0].event[0].script.exec;
      return Array.isArray(exec) ? exec.join('\n') : exec;
    };
    const before = scriptOf(text), now = scriptOf(after);
    assert.strictEqual(now.replace(/\r/g, ''), before.replace(/\r/g, '').replace(anchor, withExtraLine), name);
    assert.strictEqual(count(now, '\r'), count(before, '\r') + (before.includes('\r') ? 1 : 0), name + ': line-ending style');
    if (name !== 'minified' && name !== 'execString') assert.strictEqual(changedLines(text, after), 1, name + ': one line added');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  ok(`round-trips ${Object.keys(shapes).length} export shapes (tabs/spaces/minified/CRLF file/BOM/LF scripts/exec-as-string/wrapped)`);

  // Fuzz the merge of one script: unedited scripts must come back identical whatever their mix of
  // line endings, and an edit must land exactly once.
  let seed = 7;
  const random = below => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % below;
  const pool = ['', '    ', 'var a = 1;', '  if (x) {', '  }', 'pm.test("t", function () {', '});', '// c', '\tfoo( bar );', 'x = "a  b";'];
  for (let round = 0; round < 3000; round++) {
    const stored = Array.from({ length: random(12) }, () => pool[random(pool.length)] + (random(4) ? '\r' : ''));
    const asFile = stored.map(line => line.replace(/\r$/, '')).join('\n');
    for (const keepWs of [false, true]) {
      const same = mergeScript(stored, asFile, { keepWs, defaultCrlf: true });
      assert.ok(!same.changed && same.lines.every((line, i) => line === stored[i]), 'fuzz: no edit, but the script changed');
      const lines = asFile.split('\n');
      const marker = 'NEW_LINE_' + round;
      lines.splice(random(lines.length + 1), random(2), marker);
      const edited = mergeScript(stored, stored.length ? lines.join('\n') : marker, { keepWs, defaultCrlf: true });
      assert.ok(edited.changed && edited.lines.filter(line => line.replace(/\r$/, '') === marker).length === 1, 'fuzz: the edit did not land exactly once');
      if (keepWs && stored.length) assert.deepStrictEqual(edited.lines.map(line => line.replace(/\r$/, '')), lines, 'fuzz: result differs from the edited file');
    }
  }
  ok('fuzz: 3000 random scripts with mixed line endings round-trip exactly');

  // ---- Hardening: what an odd collection, or a branch someone else wrote, must not be able to do. ----
  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pmx-hard-'));
  const git = (dir, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });
  const runIn = (dir, ...args) => {
    const x = spawnSync(process.execPath, [PMX, ...args], { cwd: dir, encoding: 'utf8', timeout: 30000 });
    return { code: x.status, out: (x.stdout || '') + (x.stderr || '') };
  };
  const oneRequest = (name, listen, ...lines) => ({ name, event: [{ listen, script: { type: 'text/javascript', exec: lines } }], request: { method: 'GET', header: [], url: { raw: 'http://127.0.0.1:9/x' } }, response: [] });
  const tiny = requests => JSON.stringify({ info: { name: 'T', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: requests }, null, '\t');
  const canLink = (() => { const d = scratch(); try { fs.symlinkSync(d, path.join(d, 'link')); return true; } catch (e) { return false; } })();   // not on every Windows setup

  let dir = scratch();
  fs.writeFileSync(path.join(dir, 'T.postman_collection.json'), tiny([oneRequest('Same name', 'Test2', 'var a = 1;'), oneRequest('Same name', 'Test2', 'var b = 2;'), oneRequest('Same name', 'Test2', 'var c = 3;')]));
  r = runIn(dir, 'unpack', 'T.postman_collection.json');
  assert.strictEqual(r.code, 0, 'unpack did not finish: ' + r.out);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, '.pmx', 'T', 'scripts')).sort(), ['Same_name.Test2.js', 'Same_name~2.Test2.js', 'Same_name~3.Test2.js']);
  fs.writeFileSync(path.join(dir, '.pmx', 'T', 'scripts', 'Same_name~2.Test2.js'), 'var b = 22;');
  assert.strictEqual(runIn(dir, 'pack').code, 0);
  assert.deepStrictEqual(JSON.parse(read(path.join(dir, 'T.postman_collection.json'))).item.map(item => item.event[0].script.exec[0]), ['var a = 1;', 'var b = 22;', 'var c = 3;']);
  ok('same-named requests get different files whatever their event is called (unpack used to hang), and each packs back into its own request');

  dir = scratch();
  git(dir, 'init', '-q', '-b', 'main', '.');
  const tinyFile = path.join(dir, 'T.postman_collection.json'), tinyScript = path.join(dir, '.pmx', 'T', 'scripts', 'One.test.js');
  fs.writeFileSync(tinyFile, tiny([oneRequest('One', 'test', 'var a = 1;')]));
  assert.strictEqual(runIn(dir, 'unpack', 'T.postman_collection.json').code, 0);
  const outside = path.join(scratch(), 'outside.txt');
  fs.writeFileSync(outside, 'keep me');
  if (canLink) fs.symlinkSync(outside, tinyFile + '.pmx-tmp');                       // where pack used to write its temporary copy
  fs.writeFileSync(tinyScript, 'var a = 2;');
  r = runIn(dir, 'pack');
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(read(outside), 'keep me', 'pack wrote through a planted link');
  assert.ok(read(tinyFile).includes('var a = 2;'));
  const manifestFile = path.join(dir, '.pmx', 'T', 'manifest.json'), manifest = read(manifestFile);
  const escaping = JSON.parse(manifest);
  escaping.scripts[0].file = '../../../../escaped-' + path.basename(dir) + '.js';
  fs.writeFileSync(manifestFile, JSON.stringify(escaping));
  for (const command of [['restore', '--all'], ['pack'], ['status']]) {
    r = runIn(dir, ...command);
    assert.strictEqual(r.code, 2, command.join(' ') + ': ' + r.out);
    assert.match(r.out, /names a script file outside/);
  }
  assert.ok(!fs.existsSync(path.resolve(path.join(dir, '.pmx', 'T', 'scripts'), escaping.scripts[0].file)), 'a file was written outside the scripts folder');
  fs.writeFileSync(manifestFile, manifest);
  assert.strictEqual(runIn(dir, 'status').code, 0);
  git(dir, 'add', '-f', '.pmx');                                                     // what a merged branch that tracks .pmx/ leaves behind
  r = runIn(dir, 'status');
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /\.pmx\/ is tracked by git/);
  git(dir, 'rm', '-r', '-q', '--cached', '.pmx');
  assert.strictEqual(runIn(dir, 'status').code, 0);
  if (canLink) {
    fs.renameSync(path.join(dir, '.pmx'), path.join(dir, 'elsewhere'));
    fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(dir, '.pmx'));
    r = runIn(dir, 'status');
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, /is not a plain folder/);
  }
  ok('pack does not write through a planted link; a work folder that git tracks, that is a link, or whose manifest points outside is refused');

  dir = scratch();
  git(dir, 'init', '-q', '-b', 'main', '.');
  spawnSync(process.execPath, [path.join(ROOT, 'demo', 'make-demo.js'), dir]);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'one');
  const demoFile = path.join(dir, 'Demo.postman_collection.json');
  fs.writeFileSync(demoFile, must(read(demoFile), '\\"paperback\\", \\"ebook\\"', '\\"paperback\\"'));
  git(dir, 'commit', '-qam', 'two');
  r = runIn(dir, 'diff', 'HEAD~1');                                                  // no pmx.config.json: the one tracked collection is used
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /Catalogue \/ Genres and formats\n {2}~ test script: \+1 -1 lines/);
  r = runIn(dir, 'merge', '--theirs', 'HEAD~1', '--no-ui');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /CONFLICTS: none/);
  for (const flag of ['--no-ui', '--tui', '--ui', '--no-open', '--add']) assert.doesNotMatch(runIn(dir, 'merge', flag, '--help').out, /needs a value/, flag);
  assert.match(runIn(dir, 'merge', '--no-ui').out, /nothing to merge/);
  ok('pmx merge passes treemerge its own switches, and diff / merge --theirs find the collection without a config file');

  dir = scratch();
  const hidden = [0x202E, 0x3164, 0x061C, 0xFE0F, 0x00A0, 0xE0041, 0x200B].map(cp => String.fromCodePoint(cp));
  fs.writeFileSync(path.join(dir, 'T.postman_collection.json'), tiny([oneRequest('Pay' + hidden[0] + 'load' + hidden[1], 'test', 'var a = 1;')]));
  assert.strictEqual(runIn(dir, 'unpack', 'T.postman_collection.json').code, 0);
  fs.writeFileSync(path.join(dir, '.pmx', 'T', 'scripts', 'Pay_load.test.js'), 'var a = 1;\nvar b = "' + hidden.join('x') + '";');
  assert.strictEqual(runIn(dir, 'view').code, 0);
  const hiddenPage = read(path.join(dir, '.pmx', 'T', 'diff.html'));
  for (const ch of hidden) {
    const label = '>U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + '<';
    assert.ok(!hiddenPage.includes(ch) && hiddenPage.includes(label), 'not marked: ' + label);
  }
  assert.ok(count(hiddenPage, '>U+202E<') >= 3, 'the request name is marked in the list, in the heading and in the script');
  ok('view marks invisible and direction-changing characters in script lines and in request names');

  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\nall ${passed} checks passed`);
}

main().catch(error => { console.error('\nSELFTEST FAILED\n' + (error.stack || error)); process.exit(1); });
