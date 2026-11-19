'use strict';
// Self-test for the experimental tree mode (pmx-tree.js): the whole collection as files, and back.
// It answers the spike's question: does a collection survive the trip to files and back unchanged, and can
// requests, variables and shared scripts be edited through those files?
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PMX = path.join(ROOT, 'pmx.js');
const tree = require(path.join(ROOT, 'pmx-tree.js'));
const { diffOps } = require(PMX);

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pmx-tree-test-'));
const read = file => fs.readFileSync(file, 'utf8');
function pmx(dir, ...args) {
  const r = spawnSync(process.execPath, [PMX, ...args], { cwd: dir, encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const START = 'module.exports = ';
function editDef(file, change) {                 // a definition file is `module.exports = <JSON>;`
  const text = read(file), from = text.indexOf(START) + START.length, to = text.lastIndexOf(';');
  const value = JSON.parse(text.slice(from, to));
  change(value);
  fs.writeFileSync(file, text.slice(0, from) + JSON.stringify(value, null, 2) + ';\n');
}
const BOM = String.fromCharCode(0xFEFF);
const parse = text => JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let passed = 0;
const ok = name => console.log(`  ok ${++passed}  ${name}`);

// In-process round trip: text -> files in a folder -> collection -> text. Returns what came back.
function roundTrip(text) {
  const dir = scratch();
  const { files, scripts } = tree.split(text);
  for (const [file, content] of files) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), content); }
  const built = tree.build(dir, { scripts }, text);
  fs.rmSync(dir, { recursive: true, force: true });
  return { files, built };
}

// A collection that uses many corners of the format, for the size and fuzz checks.
function bigCollection(folders, perFolder, random) {
  const pick = list => list[random(list.length)];
  const odd = ['Plain name', 'name/with:odd*chars?', 'folder', 'collection', 'CASE', 'case', '', '...', 'tr' + String.fromCharCode(0xE8) + 's long name '.repeat(6), 'Same', 'Same', 'a.request.js'];
  const script = (listen, id) => ({ listen, script: Object.assign({ type: 'text/javascript', exec: [`pm.test("check ${id}", function () {\r`, `    pm.expect(${id}).to.be.a("number");\r`, '});'] }, random(2) ? { id: 'id-' + id } : {}) });
  const bodies = [
    undefined,
    { mode: 'raw', raw: '{\n  "a": 1,\n  "text": "quote \\" and backslash \\\\"\n}', options: { raw: { language: 'json' } } },
    { mode: 'urlencoded', urlencoded: [{ key: 'q', value: 'x y', type: 'text' }, { key: 'off', value: '', disabled: true }] },
    { mode: 'formdata', formdata: [{ key: 'file', type: 'file', src: [] }, { key: 'note', value: 'n', type: 'text' }] },
    { mode: 'graphql', graphql: { query: 'query { books { id } }', variables: '' } },
  ];
  const request = n => {
    const item = { name: pick(odd) + (random(3) ? ' ' + n : '') };
    if (random(4)) item.event = [script('test', n)].concat(random(3) ? [] : [script('prerequest', n + 100000)]);
    if (random(9) === 0) item.event = [{ listen: 'test', script: { type: 'text/javascript', exec: 'var joined = 1;\nvar as = "one string";' } }];
    if (random(15) === 0) item.event = [{ listen: 'test', script: { type: 'text/javascript', exec: ['ok', 7, null] } }, { listen: 'prerequest' }];
    item.request = { method: pick(['GET', 'POST', 'PUT', 'DELETE']), header: random(2) ? [] : [{ key: 'Accept', value: 'application/json' }, { key: 'X-Off', value: '1', disabled: true }],
      url: { raw: '{{baseUrl}}/things/' + n + '?page={{page}}', host: ['{{baseUrl}}'], path: ['things', String(n)], query: [{ key: 'page', value: '{{page}}' }], variable: [] } };
    const body = pick(bodies);
    if (body) item.request.body = body;
    if (random(5) === 0) item.request.auth = { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] };
    if (random(4) === 0) item.request.description = random(2) ? 'A plain description.' : { content: '# Heading\n\ntext', type: 'text/markdown' };
    if (random(6) === 0) item.protocolProfileBehavior = { disableBodyPruning: true };
    item.response = random(5) ? [] : [{ name: 'saved example', originalRequest: { method: 'GET', header: [], url: { raw: '{{baseUrl}}/x' } }, status: 'OK', code: 200, _postman_previewlanguage: 'json', header: [{ key: 'Content-Type', value: 'application/json' }], cookie: [], body: '{"ok":true}' }];
    return item;
  };
  let n = 0;
  const folder = depth => {
    const f = { name: pick(odd) + ' folder ' + (++n), item: [] };
    for (let i = 0; i < perFolder; i++) f.item.push(depth < 2 && random(12) === 0 ? folder(depth + 1) : request(++n));
    if (random(3) === 0) f.event = [script('prerequest', ++n)];
    if (random(4) === 0) f.auth = { type: 'basic', basic: [{ key: 'username', value: 'u', type: 'string' }] };
    if (random(4) === 0) f.description = 'About this folder.';
    return f;
  };
  return {
    info: { _postman_id: 'aaaaaaaa-0000-4000-8000-' + String(1e11 + random(1e9)).slice(0, 12), name: 'Big', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', _exporter_id: '1' },
    item: Array.from({ length: folders }, () => folder(0)).concat(random(2) ? [request(++n)] : []),
    event: [script('prerequest', ++n), { listen: 'test', script: { type: 'text/javascript', exec: [''] } }],
    variable: [{ key: 'baseUrl', value: 'http://127.0.0.1:9', type: 'string' }, { key: 'page', value: '1' }],
    auth: { type: 'noauth' },
    protocolProfileBehavior: {},
  };
}
const seeded = seed => below => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % below;

async function main() {
  const PORT = String(5100 + Math.floor(Math.random() * 800));
  const demoEnv = Object.assign({}, process.env, { PORT });
  const makeDemo = dir => spawnSync(process.execPath, [path.join(ROOT, 'demo', 'make-demo.js'), dir], { env: demoEnv });

  // 1. the demo collection, through the command
  let dir = scratch();
  makeDemo(dir);
  let r = pmx(dir, 'tree', 'check', 'Demo.postman_collection.json');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /unpacked into 16 files: 4 requests, 4 folders, 7 scripts/);
  assert.match(r.out, /built back from the files: IDENTICAL to the original/);
  assert.match(r.out, /layout-keeping writer gives: the same bytes/);
  ok('the demo collection comes back identical from 16 files, and the writer reproduces the original bytes');

  // 2. other ways the same collection can be laid out on disk
  const demo = parse(read(path.join(dir, 'Demo.postman_collection.json')));
  const copy = change => JSON.parse(JSON.stringify(demo), (key, value) => (key === 'exec' && Array.isArray(value) ? change(value) : value));
  const layouts = {
    tabs: JSON.stringify(demo, null, '\t'),
    spaces4: JSON.stringify(demo, null, 4),
    minified: JSON.stringify(demo),
    crlfFile: JSON.stringify(demo, null, 2).replace(/\n/g, '\r\n'),
    bom: BOM + JSON.stringify(demo, null, '\t'),
    lfScripts: JSON.stringify(copy(lines => lines.map(line => line.replace(/\r$/, ''))), null, '\t'),
    execString: JSON.stringify(copy(lines => lines.join('\n')), null, '\t'),
    wrapped: JSON.stringify({ collection: demo }, null, '\t'),
    handEdited: JSON.stringify(demo, null, '\t').replace(/"header": \[\]/g, '"header":   [ ]').replace(/\n\t\t\t"name"/g, '\n\n\t\t\t"name"') + '\n\n',
  };
  for (const [name, text] of Object.entries(layouts)) {
    const d = scratch();
    fs.writeFileSync(path.join(d, 'X.postman_collection.json'), text);
    r = pmx(d, 'tree', 'check', 'X.postman_collection.json');
    assert.strictEqual(r.code, 0, name + ': ' + r.out);
    assert.match(r.out, /IDENTICAL to the original/, name);
    assert.match(r.out, /layout-keeping writer gives: the same bytes/, name);
    fs.rmSync(d, { recursive: true, force: true });
  }
  ok(`round-trips ${Object.keys(layouts).length} layouts of the file (tabs/spaces/minified/CRLF/BOM/LF scripts/exec-as-string/wrapped/hand-edited spacing)`);

  // 3. size: well over a thousand requests, about 100,000 lines, using many corners of the format
  const big = bigCollection(2, 20, seeded(11)), bigText = JSON.stringify(big, null, '\t');
  let started = Date.now();
  const trip = roundTrip(bigText);
  const requestFiles = [...trip.files.keys()].filter(f => f.endsWith('.request.js')).length;
  assert.deepStrictEqual(trip.built.errors, []);
  assert.ok(same(trip.built.json, big), 'the big collection did not come back identical');
  assert.ok(requestFiles >= 900, 'expected about a thousand requests, got ' + requestFiles);
  assert.strictEqual(new Set([...trip.files.keys()].map(f => f.toLowerCase())).size, trip.files.size, 'two files differ only by case');
  const unpackMs = Date.now() - started;
  started = Date.now();
  const edited = JSON.parse(JSON.stringify(big));
  edited.variable.push({ key: 'added', value: '1' });
  const rendered = tree.render(bigText, big, edited, 'Big.postman_collection.json');
  assert.strictEqual(rendered.how, 'layout kept');
  assert.ok(same(parse(rendered.text), edited));
  const bigOps = diffOps(bigText.split('\n'), rendered.text.split('\n')).filter(op => op[0] !== '=');
  assert.ok(bigOps.length <= 6 && bigOps.filter(op => op[0] === '-').length <= 1, 'adding one variable to the big file should touch a handful of lines, not ' + bigOps.length);
  ok(`a collection of ${requestFiles} requests (${bigText.split('\n').length} lines, ${trip.files.size} files) comes back identical in ${unpackMs} ms; one edit then moves only its own lines (${Date.now() - started} ms)`);

  // 4. edit requests, variables and a shared script through the files; the existing newman command validates the result
  fs.writeFileSync(path.join(dir, 'pmx.config.json'), JSON.stringify({ collection: 'Demo.postman_collection.json', newman: { timeoutRequest: 10000 } }));
  const original = read(path.join(dir, 'Demo.postman_collection.json'));
  r = pmx(dir, 'tree', 'unpack', 'Demo.postman_collection.json');
  assert.strictEqual(r.code, 0, r.out);
  const T = (...parts) => path.join(dir, '.pmx', 'Demo', 'tree', ...parts);
  editDef(T('collection.js'), d => d.variable.push({ key: 'shopId', value: 'main' }));                               // a collection variable
  editDef(T('Smoke', 'Ping.request.js'), d => d.request.header.push({ key: 'Accept', value: 'application/json' }));   // a header
  editDef(T('Catalogue', 'Genres_and_formats.request.js'), d => { d.request.url.raw = '{{baseUrl}}/catalogue?shop={{shopId}}'; d.request.url.query = [{ key: 'shop', value: '{{shopId}}' }]; });   // a URL
  fs.writeFileSync(T('collection.prerequest.js'), read(T('collection.prerequest.js')) + '\npm.request.headers.upsert({ key: "X-Shop", value: pm.collectionVariables.get("shopId") });');     // the script every request shares
  fs.writeFileSync(T('Orders', 'Open_orders.test.js'), read(T('Orders', 'Open_orders.test.js')).replace('return line.status !== "in stock";', 'return line.status !== "in stock" && line.status !== "preorder";'));
  editDef(T('Smoke', 'folder.js'), d => d.item.$children.push('Version.request.js'));                               // a new request, listed in its folder
  fs.writeFileSync(T('Smoke', 'Version.request.js'), '// Smoke / Version\n' + START + JSON.stringify({ name: 'Version', event: [{ listen: 'test', script: { type: 'text/javascript', exec: { $script: 'Version.test.js' } } }], request: { method: 'GET', header: [], url: { raw: '{{baseUrl}}/health', host: ['{{baseUrl}}'], path: ['health'] } }, response: [] }, null, 2) + ';\n');
  fs.writeFileSync(T('Smoke', 'Version.test.js'), 'pm.test("Version answers", function () {\n    pm.response.to.have.status(200);\n});');
  r = pmx(dir, 'tree', 'pack');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /layout kept/);
  const expected = parse(original);
  expected.variable.push({ key: 'shopId', value: 'main' });
  expected.item[0].item[0].request.header.push({ key: 'Accept', value: 'application/json' });
  expected.item[1].item[0].request.url.raw = '{{baseUrl}}/catalogue?shop={{shopId}}';
  expected.item[1].item[0].request.url.query = [{ key: 'shop', value: '{{shopId}}' }];
  const shared = expected.event[0].script.exec;
  shared[shared.length - 1] += '\r';
  shared.push('pm.request.headers.upsert({ key: "X-Shop", value: pm.collectionVariables.get("shopId") });');
  const ordersTest = expected.item[2].item[0].event[1].script.exec, lineAt = ordersTest.findIndex(line => line.includes('return line.status !== "in stock";'));
  ordersTest[lineAt] = ordersTest[lineAt].replace('return line.status !== "in stock";', 'return line.status !== "in stock" && line.status !== "preorder";');
  expected.item[0].item.push({ name: 'Version', event: [{ listen: 'test', script: { type: 'text/javascript', exec: ['pm.test("Version answers", function () {\r', '    pm.response.to.have.status(200);\r', '});'] } }], request: { method: 'GET', header: [], url: { raw: '{{baseUrl}}/health', host: ['{{baseUrl}}'], path: ['health'] } }, response: [] });
  const packed = read(path.join(dir, 'Demo.postman_collection.json'));
  assert.ok(same(parse(packed), expected), 'the packed collection is not what the edits describe');
  const removed = diffOps(original.split('\n'), packed.split('\n')).filter(op => op[0] === '-').map(op => original.split('\n')[op[1]].trim());
  assert.ok(removed.length <= 6 && removed.every(line => /^("header": \[\],?|\],?|\}|"raw": .*|"pm\.request.*|"\s+return line\.status.*)$/.test(line)), 'lines that should not have moved: ' + JSON.stringify(removed));
  const api = spawn(process.execPath, [path.join(ROOT, 'demo', 'mock-server.js')], { env: demoEnv, stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 400));
  try {
    r = pmx(dir, 'tree', 'test');
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /RESULT: FAIL - 3 of 11 assertions failed/);
    assert.match(r.out, /X Catalogue \/ Staff picks \/ Picks by genre\n {2}FAILED TEST: "Catalogue lists the right genres with picks"/);
    assert.doesNotMatch(r.out, /Open orders/);
    // an environment file: point the collection at a dead address, and let the environment supply the right one
    const live = parse(read(path.join(dir, 'Demo.postman_collection.json'))).variable.find(v => v.key === 'baseUrl').value;
    editDef(T('collection.js'), d => { d.variable.find(v => v.key === 'baseUrl').value = 'http://127.0.0.1:9'; });
    r = pmx(dir, 'tree', 'test');
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /ERRORS \(a script or a request did not run\)/);
    fs.writeFileSync(path.join(dir, 'local.postman_environment.json'), JSON.stringify({ name: 'local', values: [{ key: 'baseUrl', value: live, enabled: true }] }));
    r = pmx(dir, 'tree', 'test', '--environment', 'local.postman_environment.json');
    assert.match(r.out, /RESULT: FAIL - 3 of 11 assertions failed\n/);
    editDef(T('collection.js'), d => { d.variable.find(v => v.key === 'baseUrl').value = live; });
    assert.strictEqual(pmx(dir, 'tree', 'pack').code, 0);
    r = pmx(dir, 'tree', 'check', 'Demo.postman_collection.json', '--run');
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /newman on the original and on the rebuilt collection: 11 and 11 assertions, the same results \(3 failing in both\)/);
  } finally { api.kill(); }
  ok('a variable, a header, a URL, the shared pre-request script, a test and a new request are edited through the files; only those lines move; newman runs the result, with an environment file too');

  // 5. remove, reorder and rename through the files
  editDef(T('collection.js'), d => { d.item.$children = ['Orders/', 'Catalogue/', 'Smoke/']; });
  editDef(T('Catalogue', 'folder.js'), d => { d.item.$children = d.item.$children.filter(child => child !== 'Staff_picks/'); });
  editDef(T('Smoke', 'Ping.request.js'), d => { d.name = 'Health check'; });
  r = pmx(dir, 'tree', 'pack');
  assert.strictEqual(r.code, 0, r.out);
  const reshaped = parse(read(path.join(dir, 'Demo.postman_collection.json')));
  assert.deepStrictEqual(reshaped.item.map(item => item.name), ['Orders', 'Catalogue', 'Smoke']);
  assert.deepStrictEqual(reshaped.item[1].item.map(item => item.name), ['Genres and formats']);
  assert.deepStrictEqual(reshaped.item[2].item.map(item => item.name), ['Health check', 'Version']);
  expected.item = [expected.item[2], Object.assign({}, expected.item[1], { item: [expected.item[1].item[0]] }), expected.item[0]];
  expected.item[2].item[0].name = 'Health check';
  assert.ok(same(reshaped, expected));
  ok('folders are reordered, a folder is removed and a request renamed by editing the lists and names in the files');

  // 6. what tree pack refuses, leaving the collection file alone
  const beforeRefusals = read(path.join(dir, 'Demo.postman_collection.json'));
  const refused = (what, pattern, undo) => {
    r = pmx(dir, 'tree', 'pack');
    assert.strictEqual(r.code, 2, what + ': ' + r.out);
    assert.match(r.out, pattern, what);
    assert.strictEqual(read(path.join(dir, 'Demo.postman_collection.json')), beforeRefusals, what + ': the collection file changed');
    undo();
  };
  const keep = file => { const text = read(file); return () => fs.writeFileSync(file, text); };
  let undo = keep(T('Orders', 'Open_orders.request.js'));
  fs.writeFileSync(T('Orders', 'Open_orders.request.js'), read(T('Orders', 'Open_orders.request.js')).replace('"method": "GET",', '"method": "GET"'));
  refused('a definition that is not valid JSON', /Orders\/Open_orders\.request\.js: the part after `module\.exports = ` is not valid JSON/, undo);
  const outsideName = 'outside-' + path.basename(dir) + '.js';
  fs.writeFileSync(path.join(os.tmpdir(), outsideName), 'var stolen = 1;');
  undo = keep(T('Orders', 'Open_orders.request.js'));
  editDef(T('Orders', 'Open_orders.request.js'), d => { d.event[1].script.exec.$script = '../../../../../' + outsideName; });
  refused('a script pointer that climbs out of the tree', /points outside the tree/, undo);
  editDef(T('Orders', 'Open_orders.request.js'), d => { d.event[1].script.exec.$script = path.join(os.tmpdir(), outsideName); });
  refused('an absolute script pointer', /points outside the tree/, undo);
  undo = keep(T('Orders', 'folder.js'));
  editDef(T('Orders', 'folder.js'), d => { d.item.$children.push('../Smoke/Ping.request.js', '../../'); });
  refused('a child pointer that climbs out of the tree', /points outside the tree/, undo);
  undo = keep(T('Orders', 'Open_orders.test.js'));
  fs.writeFileSync(T('Orders', 'Open_orders.test.js'), read(T('Orders', 'Open_orders.test.js')) + '\nvar broken = ;');
  refused('a script with a syntax error', /SYNTAX ERROR .*Open_orders\.test\.js/, undo);
  fs.writeFileSync(T('Orders', 'Open_orders.test.js'), read(T('Orders', 'Open_orders.test.js')).replace(/pm\.test\("There are open orders to look at"[\s\S]*?\n}\);\n/, ''));
  refused('a removed pm.test', /dropped from 2 to 1/, undo);
  fs.writeFileSync(path.join(dir, 'Demo.postman_collection.json'), '{ not json');           // the collection replaced by something unreadable
  r = pmx(dir, 'tree', 'pack');
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /was changed by something else since `tree unpack`\. The two cannot be combined automatically/);
  assert.strictEqual(read(path.join(dir, 'Demo.postman_collection.json')), '{ not json');
  fs.writeFileSync(path.join(dir, 'Demo.postman_collection.json'), beforeRefusals);
  editDef(T('collection.js'), d => d.variable.push({ key: 'pending', value: '1' }));
  r = pmx(dir, 'tree', 'unpack', 'Demo.postman_collection.json');
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /has edits that are not in Demo\.postman_collection\.json yet/);
  assert.strictEqual(pmx(dir, 'tree', 'unpack', 'Demo.postman_collection.json', '--force').code, 0);
  ok('refused, with the collection untouched: broken JSON, pointers that leave the tree, a syntax error, a removed test, a collection replaced by something unreadable, unpacking over unpacked edits');

  // 7. the other pmx commands are not affected by a tree next to them
  const d7 = scratch();
  makeDemo(d7);
  const before7 = fs.readFileSync(path.join(d7, 'Demo.postman_collection.json'));
  assert.strictEqual(pmx(d7, 'tree', 'unpack', 'Demo.postman_collection.json').code, 0);
  assert.strictEqual(pmx(d7, 'unpack', 'Demo.postman_collection.json').code, 0);
  assert.match(pmx(d7, 'ls').out, /6 script\(s\)/);
  assert.match(pmx(d7, 'status').out, /no script changes/);
  assert.strictEqual(pmx(d7, 'pack').code, 0);
  assert.ok(fs.readFileSync(path.join(d7, 'Demo.postman_collection.json')).equals(before7));
  assert.strictEqual(pmx(d7, 'tree', 'pack').code, 0);
  assert.ok(fs.readFileSync(path.join(d7, 'Demo.postman_collection.json')).equals(before7));
  assert.match(pmx(d7, 'help').out, /tree adopt \| build \| verify \| import/);
  assert.strictEqual(pmx(d7, 'tree').code, 0);
  ok('unpack, ls, status and pack work as before next to a tree, and both modes leave an unedited collection byte-identical');

  // 8. the files are a temporary working copy: commit them on a branch, edit, pack, and finish before merging
  const git = (cwd, ...args) => { const g = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }); assert.strictEqual(g.status, 0, 'git ' + args.join(' ') + ': ' + g.stderr); return g.stdout; };
  const d8 = scratch(), C8 = path.join(d8, 'Demo.postman_collection.json');
  makeDemo(d8);
  git(d8, 'init', '-q', '.'); git(d8, 'add', '-A'); git(d8, 'commit', '-qm', 'the collection');
  const before8 = read(C8);
  r = pmx(d8, 'tree', 'unpack', 'Demo.postman_collection.json', '--tree', 'demo-tree');
  assert.strictEqual(r.code, 0, r.out);
  git(d8, 'add', 'demo-tree'); git(d8, 'commit', '-qm', 'unpack: the files as they are in the collection');
  const firstCommit = git(d8, 'rev-parse', 'HEAD').trim();
  assert.match(pmx(d8, 'tree', 'status').out, /no changes against the collection as it was unpacked/);
  editDef(path.join(d8, 'demo-tree', 'Smoke', 'Ping.request.js'), d => { d.name = 'Ping the API'; });
  fs.appendFileSync(path.join(d8, 'demo-tree', 'Smoke', 'Ping.test.js'), '\n// checked by hand');
  r = pmx(d8, 'tree', 'status');
  assert.match(r.out, /M Smoke\/Ping\.request\.js/);
  assert.match(r.out, /M Smoke\/Ping\.test\.js/);
  assert.match(r.out, /does not hold these edits yet/);
  assert.deepStrictEqual(git(d8, 'diff', '--name-only').trim().split('\n'), ['demo-tree/Smoke/Ping.request.js', 'demo-tree/Smoke/Ping.test.js'], 'git shows the edit file by file');
  assert.strictEqual(read(C8), before8, 'status wrote to the collection');
  assert.strictEqual(pmx(d8, 'tree', 'pack').code, 0);
  fs.rmSync(path.join(d8, '.pmx'), { recursive: true, force: true });          // a colleague's fresh clone has no scratch folder:
  r = pmx(d8, 'tree', 'status');                                                 // the unpacked version then comes from git
  assert.match(r.out, /M Smoke\/Ping\.request\.js/);
  assert.match(r.out, /already holds these edits/);
  r = pmx(d8, 'tree', 'finish');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /removed demo-tree\/ - the collection file now holds everything/);
  assert.ok(!fs.existsSync(path.join(d8, 'demo-tree')), 'finish left the files');
  const after8 = parse(read(C8)), want8 = parse(before8);
  want8.item[0].item[0].name = 'Ping the API';
  const ping8 = want8.item[0].item[0].event[0].script.exec;
  ping8[ping8.length - 1] += '\r'; ping8.push('// checked by hand');
  assert.ok(same(after8, want8), 'the finished collection is not the original plus the two edits');
  assert.strictEqual(diffOps(before8.split('\n'), read(C8).split('\n')).filter(op => op[0] === '-').length, 2, 'more than the two edited lines moved');
  git(d8, 'add', 'demo-tree', 'Demo.postman_collection.json'); git(d8, 'commit', '-qm', 'finish');
  assert.strictEqual(git(d8, 'diff', '--name-only', firstCommit + '~1', 'HEAD').trim(), 'Demo.postman_collection.json', 'what is merged is the collection JSON only');
  r = pmx(d8, 'tree', 'status');
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /nothing is unpacked here yet/);
  // a checkout that converts line ends (core.autocrlf, the default of Git for Windows): the unpacked version is still found in git
  const d8c = scratch(), C8c = path.join(d8c, 'Demo.postman_collection.json');
  makeDemo(d8c);
  fs.writeFileSync(C8c, read(C8c).replace(/\n/g, '\r\n'));
  git(d8c, 'init', '-q', '.'); git(d8c, 'config', 'core.autocrlf', 'true');
  r = pmx(d8c, 'tree', 'unpack', 'Demo.postman_collection.json', '--tree', 'files');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /note: this version of the collection is not committed in git/);
  git(d8c, 'add', 'Demo.postman_collection.json'); git(d8c, 'commit', '-qm', 'the collection');
  r = pmx(d8c, 'tree', 'unpack', 'Demo.postman_collection.json', '--tree', 'files');
  assert.strictEqual(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /is not committed/);
  editDef(path.join(d8c, 'files', 'Smoke', 'Ping.request.js'), d => { d.name = 'Ping the API'; });
  assert.strictEqual(pmx(d8c, 'tree', 'pack').code, 0);
  fs.rmSync(path.join(d8c, '.pmx'), { recursive: true, force: true });
  r = pmx(d8c, 'tree', 'status');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /M Smoke\/Ping\.request\.js/);
  assert.match(r.out, /already holds these edits/);

  // unpacking never clears a folder that holds something else, never writes outside this folder, and a note that points outside is not followed
  fs.mkdirSync(path.join(d8, 'notes'));
  fs.writeFileSync(path.join(d8, 'notes', 'keep.txt'), 'mine');
  r = pmx(d8, 'tree', 'unpack', 'Demo.postman_collection.json', '--tree', 'notes');
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /notes\/ exists and holds other files/);
  assert.strictEqual(read(path.join(d8, 'notes', 'keep.txt')), 'mine');
  const elsewhere = path.join(os.tmpdir(), 'elsewhere-' + path.basename(d8));
  for (const bad of ['.', '..', elsewhere]) {
    r = pmx(d8, 'tree', 'unpack', 'Demo.postman_collection.json', '--tree', bad);
    assert.strictEqual(r.code, 2, bad + ': ' + r.out);
    assert.match(r.out, /must be inside the current folder/, bad);
  }
  assert.ok(fs.existsSync(C8) && !fs.existsSync(elsewhere), 'unpack touched a folder it was refused');
  fs.writeFileSync(path.join(d8, 'other.json'), '{"a": 1}');
  r = pmx(d8, 'tree', 'unpack', 'other.json', '--tree', 'other-tree');
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /does not look like a Postman collection/);
  assert.strictEqual(pmx(d8, 'tree', 'unpack', 'Demo.postman_collection.json', '--tree', 'again').code, 0);
  const note8 = path.join(d8, 'again', '.pmx-tree.json');
  fs.writeFileSync(note8, read(note8).replace('"Demo.postman_collection.json"', JSON.stringify('../outside-' + path.basename(d8) + '.json')));
  for (const command of ['status', 'pack', 'finish']) {
    r = pmx(d8, 'tree', command, '--tree', 'again');
    assert.strictEqual(r.code, 2, command + ': ' + r.out);
    assert.match(r.out, /does not name a collection inside this folder/, command);
  }
  assert.ok(!fs.existsSync(path.join(d8, '..', 'outside-' + path.basename(d8) + '.json')) && fs.existsSync(path.join(d8, 'again', 'collection.js')));
  ok('working copy on a branch: commit the files, edit, status and git show the edit per file, a fresh clone recovers the original from git, finish leaves only the collection JSON changed; unpack refuses a folder with other content and anything outside this folder');

  // 9. the collection file changes while the files are unpacked (main was merged into the branch): pack merges, or refuses
  const d9 = scratch(), C9 = path.join(d9, 'Demo.postman_collection.json'), T9 = (...parts) => path.join(d9, '.pmx', 'Demo', 'tree', ...parts);
  makeDemo(d9);
  const demoText9 = read(C9);
  assert.strictEqual(pmx(d9, 'tree', 'unpack', 'Demo.postman_collection.json').code, 0);
  editDef(T9('collection.js'), d => d.variable.push({ key: 'mine', value: '1' }));                                  // my edit, in the files
  fs.writeFileSync(C9, read(C9).replace('"name": "Ping"', '"name": "Ping (renamed upstream)"'));                    // someone else's, in the JSON
  assert.match(pmx(d9, 'tree', 'status').out, /was changed by something else since it was unpacked; `tree pack` will merge these edits into it/);
  r = pmx(d9, 'tree', 'pack');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /merged into the newer collection file/);
  assert.doesNotMatch(r.out, /share a name/);
  const merged9 = parse(read(C9));
  assert.strictEqual(merged9.item[0].item[0].name, 'Ping (renamed upstream)');
  assert.ok(merged9.variable.some(v => v.key === 'mine'), 'the edit from the files is missing after the merge');
  const renamed9 = fs.readdirSync(T9('Smoke')).filter(f => f.endsWith('.request.js'));                              // the files were written again, so the request's file follows its new name
  assert.strictEqual(renamed9.length, 1, renamed9.join());
  assert.match(read(T9('Smoke', renamed9[0])), /"name": "Ping \(renamed upstream\)"/, 'the files were not written again from the merged collection');
  r = pmx(d9, 'tree', 'status');                                                                                    // changes go on being counted from the newer collection as it was found:
  assert.match(r.out, /M collection\.js/);                                                                           // the edit is still an edit,
  assert.doesNotMatch(r.out, /Ping/);                                                                                // what came from the other side is not
  assert.match(r.out, /already holds these edits/);
  const packed9 = read(C9);
  assert.strictEqual(pmx(d9, 'tree', 'pack').code, 0);
  assert.strictEqual(read(C9), packed9, 'packing again changed the file');
  editDef(T9('Smoke', renamed9[0]), d => { d.name = 'Ping (mine)'; });                                             // now both change the same value
  fs.writeFileSync(C9, packed9.replace('Ping (renamed upstream)', 'Ping (theirs)'));
  r = pmx(d9, 'tree', 'pack');
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /1 place\(s\) were changed both there and in the files\. The two cannot be combined automatically/);
  assert.strictEqual(read(C9), packed9.replace('Ping (renamed upstream)', 'Ping (theirs)'), 'a refused pack wrote to the collection');
  assert.match(read(T9('Smoke', renamed9[0])), /Ping \(mine\)/, 'a refused pack touched the files');
  // packed already, then the collection changes again around those edits (git merged main into the branch): the files follow it
  const d9b = scratch(), C9b = path.join(d9b, 'Demo.postman_collection.json'), T9b = (...parts) => path.join(d9b, 'files', ...parts);
  makeDemo(d9b);
  assert.strictEqual(pmx(d9b, 'tree', 'unpack', 'Demo.postman_collection.json', '--tree', 'files').code, 0);
  editDef(T9b('collection.js'), d => d.variable.push({ key: 'mine', value: '1' }));
  assert.strictEqual(pmx(d9b, 'tree', 'pack').code, 0);
  fs.writeFileSync(C9b, read(C9b).replace('"name": "Ping"', '"name": "Ping (renamed upstream)"'));
  const held9 = read(C9b);
  assert.match(pmx(d9b, 'tree', 'status').out, /`tree pack` will write the files again from it/);
  r = pmx(d9b, 'tree', 'pack');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /the newer collection file already held every edit; the files follow it/);
  assert.strictEqual(read(C9b), held9, 'the collection was written although it already held every edit');
  assert.ok(fs.readdirSync(T9b('Smoke')).some(f => /renamed_upstream/.test(f)), 'the files do not show the change from upstream');
  r = pmx(d9b, 'tree', 'status');
  assert.match(r.out, /no changes against the collection as it was unpacked/);
  assert.match(r.out, /already holds these edits/);
  editDef(T9b('collection.js'), d => d.variable.push({ key: 'later', value: '2' }));          // and work goes on from there
  assert.strictEqual(pmx(d9b, 'tree', 'finish').code, 0);
  assert.deepStrictEqual(parse(read(C9b)).variable.map(v => v.key), ['baseUrl', 'mine', 'later']);
  assert.strictEqual(parse(read(C9b)).item[0].item[0].name, 'Ping (renamed upstream)');
  // an edit made again, and an edit taken back, after the collection was packed and then changed around those edits
  const startOver = edit => {
    const d = scratch(), C = path.join(d, 'Demo.postman_collection.json'), script = path.join(d, '.pmx', 'Demo', 'tree', 'Orders', 'Open_orders.test.js');
    makeDemo(d);
    assert.strictEqual(pmx(d, 'tree', 'unpack', 'Demo.postman_collection.json').code, 0);
    fs.writeFileSync(script, read(script).replace('"in stock"', '"available"'));
    assert.strictEqual(pmx(d, 'tree', 'pack').code, 0);
    edit(C);
    return { d, C, script, orders: () => parse(read(C)).item[2].item[0].event[1].script.exec.join('\n'), ping: () => parse(read(C)).item[0].item[0].name };
  };
  const upstream = C => fs.writeFileSync(C, read(C).replace('"name": "Ping"', '"name": "Ping (renamed upstream)"'));
  let w = startOver(upstream);                                                                                      // the same line edited once more
  fs.writeFileSync(w.script, read(w.script).replace('"available"', '"ready"'));
  r = pmx(w.d, 'tree', 'pack');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(w.orders().includes('"ready"') && !w.orders().includes('"available"') && w.ping() === 'Ping (renamed upstream)', 'an edit made again after a merge was not taken: ' + r.out);
  w = startOver(upstream);                                                                                          // the edit taken back, and another one made
  fs.writeFileSync(w.script, read(w.script).replace('"available"', '"in stock"'));
  editDef(path.join(w.d, '.pmx', 'Demo', 'tree', 'collection.js'), d => d.variable.push({ key: 'later', value: '2' }));
  r = pmx(w.d, 'tree', 'pack');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(w.orders().includes('"in stock"') && !w.orders().includes('"available"'), 'an edit that was taken back came back after a merge');
  assert.ok(parse(read(w.C)).variable.some(v => v.key === 'later') && w.ping() === 'Ping (renamed upstream)');
  assert.match(read(w.script), /"in stock"/, 'the files got the taken-back edit again');
  w = startOver(C => { fs.writeFileSync(C, demoText9); upstream(C); });                                              // the collection put back to the original, then changed: the edit is not in it
  r = pmx(w.d, 'tree', 'pack');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(w.orders().includes('"available"') && w.ping() === 'Ping (renamed upstream)', 'an edit that the newer collection did not hold was dropped');
  assert.match(read(w.script), /"available"/);
  ok('the collection changed underneath: pack merges the edits from the files into it and refreshes the files; a clash is refused with nothing written; a collection that already holds the edits is followed; an edit made again is taken, an edit taken back stays out, an edit the newer file lacks is kept');

  // two requests of one name in a folder: after a merge the files and what they are compared with still belong together
  const dn = scratch(), Cn = path.join(dn, 'Demo.postman_collection.json'), Tn = (...parts) => path.join(dn, '.pmx', 'Demo', 'tree', ...parts);
  makeDemo(dn);
  const twins = parse(read(Cn)), ping = twins.item[0].item[0];
  twins.item[0].item = [Object.assign({}, ping, { name: 'Same name', event: [{ listen: 'test', script: { type: 'text/javascript', exec: ['pm.test("one", function () {});\r', 'pm.test("two", function () {});'] } }] }),
    Object.assign({}, ping, { name: 'Same name', event: [{ listen: 'test', script: { type: 'text/javascript', exec: ['pm.test("only", function () {});'] } }] })];
  fs.writeFileSync(Cn, JSON.stringify(twins, null, '\t'));
  assert.strictEqual(pmx(dn, 'tree', 'unpack', 'Demo.postman_collection.json').code, 0);
  editDef(Tn('Smoke', 'folder.js'), d => { assert.deepStrictEqual(d.item.$children, ['Same_name.request.js', 'Same_name~2.request.js']); d.item.$children.shift(); });   // the first one goes
  fs.writeFileSync(Cn, read(Cn).replace('"name": "Open orders"', '"name": "Open orders (renamed upstream)"'));
  r = pmx(dn, 'tree', 'pack');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /merged into the newer collection file/);
  assert.match(r.out, /NOTE: two requests or folders share a name[^]*tree unpack Demo\.postman_collection\.json --tree \.pmx[\\/]Demo[\\/]tree --force/);
  const afterTwins = read(Cn);                                                                                       // the merged collection is right: one request left, with its own script
  assert.deepStrictEqual([parse(afterTwins).item[0].item.map(i => i.event[0].script.exec.length), parse(afterTwins).item[2].item[0].name], [[1], 'Open orders (renamed upstream)']);
  assert.strictEqual(pmx(dn, 'tree', 'unpack', 'Demo.postman_collection.json', '--force').code, 0);                  // (after such a merge the files can be told apart again by unpacking anew)
  r = pmx(dn, 'tree', 'finish');
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(read(Cn), afterTwins, 'finish changed a collection that already held everything');

  // 10. nothing is dropped without a word: spacing inside a script, and files that nothing lists
  const dq = scratch(), Cq = path.join(dq, 'Demo.postman_collection.json'), Tq = (...parts) => path.join(dq, '.pmx', 'Demo', 'tree', ...parts);
  makeDemo(dq);
  assert.strictEqual(pmx(dq, 'tree', 'unpack', 'Demo.postman_collection.json').code, 0);
  const scriptQ = Tq('Orders', 'Open_orders.test.js'), beforeQ = read(scriptQ);
  fs.writeFileSync(scriptQ, beforeQ + '\n\n');                                             // an editor adds line breaks at the end: not an edit
  assert.match(pmx(dq, 'tree', 'status').out, /no changes against the collection as it was unpacked/);
  fs.writeFileSync(scriptQ, beforeQ.replace('"in stock"', '"instock"'));                      // one space inside a string: an edit
  r = pmx(dq, 'tree', 'status');
  assert.match(r.out, /M Orders\/Open_orders\.test\.js/);
  r = pmx(dq, 'tree', 'pack', '--ignore-whitespace');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /--ignore-whitespace: edits that only change spacing were left out in Orders\/Open_orders\.test\.js/);
  assert.ok(!read(Cq).includes('instock'));
  assert.strictEqual(pmx(dq, 'tree', 'pack').code, 0);
  assert.ok(read(Cq).includes('line.status !== \\"instock\\"'), 'an edit that only changes spacing was dropped');
  fs.writeFileSync(Tq('Smoke', 'Ping.prerequest.js'), 'pm.variables.set("seen", "1");');     // a script written by hand, but listed nowhere
  r = pmx(dq, 'tree', 'status');
  assert.match(r.out, /\? Smoke\/Ping\.prerequest\.js {3}<- no definition lists this file/);
  r = pmx(dq, 'tree', 'finish');
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /TREE FINISH REFUSED[^]*\? Smoke\/Ping\.prerequest\.js/);
  assert.ok(fs.existsSync(Tq('Smoke', 'Ping.prerequest.js')) && fs.existsSync(Tq('collection.js')), 'a refused finish removed files');
  r = pmx(dq, 'tree', 'unpack', 'Demo.postman_collection.json');
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /holds files that are not part of the collection[^]*Smoke\/Ping\.prerequest\.js/);
  fs.writeFileSync(Cq, read(Cq).replace('"name": "Ping"', '"name": "Ping (renamed upstream)"'));
  editDef(Tq('collection.js'), d => d.variable.push({ key: 'mine', value: '1' }));
  r = pmx(dq, 'tree', 'pack');                                                               // the files are written again after a merge: the unlisted one stays
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /merged into the newer collection file/);
  assert.doesNotMatch(r.out, /share a name/);
  assert.strictEqual(read(Tq('Smoke', 'Ping.prerequest.js')), 'pm.variables.set("seen", "1");', 'a file that nothing lists was removed when the files were written again');
  assert.strictEqual(pmx(dq, 'tree', 'status', 'Demo.postman_collection.json').code, 0);     // the collection may be named on the command line
  assert.strictEqual(pmx(dq, 'tree', 'status', 'Other.postman_collection.json').code, 2);
  fs.writeFileSync(Tq('Smoke', '.DS_Store'), Buffer.from([0, 1, 2]));                          // what a file manager or an editor leaves behind is nobody's business
  fs.writeFileSync(Tq('Smoke', '.Ping.test.js.swp'), 'x');
  assert.doesNotMatch(pmx(dq, 'tree', 'status').out, /DS_Store|swp/);
  const picture = Buffer.from([0x89, 0x50, 0xff, 0xfe, 0x00, 0xe9]);                           // a person's own file, not text: a merge leaves it alone, byte for byte
  fs.writeFileSync(Tq('Smoke', 'cover.png'), picture);
  fs.writeFileSync(Cq, read(Cq).replace('"name": "Orders"', '"name": "Orders (renamed upstream)"'));
  editDef(Tq('collection.js'), d => d.variable.push({ key: 'second', value: '2' }));
  r = pmx(dq, 'tree', 'finish', '--force');                                                    // --force is about the collection, not about these files: still refused
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /TREE FINISH REFUSED[^]*finish with --remove-unlisted/);
  assert.ok(!parse(read(Cq)).variable.some(v => v.key === 'second') && parse(read(Cq)).item[2].name === 'Orders (renamed upstream)', 'a refused finish wrote the collection');
  r = pmx(dq, 'tree', 'finish', '--remove-unlisted', '--keep');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(fs.readFileSync(Tq('Smoke', 'cover.png')).equals(picture), 'a file that is not text was damaged when the files were written again');
  r = pmx(dq, 'tree', 'finish', '--remove-unlisted');                                          // removing the strays does not switch the merge off
  assert.strictEqual(r.code, 0, r.out);
  const doneQ = parse(read(Cq));
  assert.ok(!fs.existsSync(Tq()) && same([doneQ.variable.map(v => v.key), doneQ.item[2].name, doneQ.item[0].item[0].name], [['baseUrl', 'mine', 'second'], 'Orders (renamed upstream)', 'Ping (renamed upstream)']), 'finish with --remove-unlisted lost a change: ' + r.out);
  ok('nothing is dropped without a word: a space inside a string is an edit (line breaks at the very end are not), and a file that nothing lists is shown, kept through a merge, and stops finish and unpack');

  // 11. the page's server: only this machine, only with the key; every edit the page can make; newman; nothing outside the tree
  const d10 = scratch(), C10 = path.join(d10, 'Demo.postman_collection.json'), T10 = (...parts) => path.join(d10, '.pmx', 'Demo', 'tree', ...parts);
  makeDemo(d10);
  fs.writeFileSync(path.join(d10, 'pmx.config.json'), JSON.stringify({ collection: 'Demo.postman_collection.json', newman: { timeoutRequest: 10000 } }));
  fs.writeFileSync(path.join(d10, 'local.postman_environment.json'), JSON.stringify({ name: 'local', values: [{ key: 'region', value: 'north', enabled: true }, { key: 'token', value: 'not-shown', type: 'secret', enabled: true }] }));
  const before10 = read(C10);
  const ui = spawn(process.execPath, [PMX, 'tree', 'ui', '--no-open'], { cwd: d10, stdio: ['ignore', 'pipe', 'pipe'] });   // nothing is unpacked yet: it unpacks the configured collection
  const api10 = spawn(process.execPath, [path.join(ROOT, 'demo', 'mock-server.js')], { env: demoEnv, stdio: 'ignore' });
  try {
    let printed = '';
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('tree ui printed no link:\n' + printed)), 15000);
      const seen = chunk => { printed += chunk; const m = /http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]{32}/.exec(printed); if (m) { clearTimeout(timer); resolve(m[0]); } };
      ui.stdout.on('data', seen); ui.stderr.on('data', seen);
    });
    const origin = base.split('/?')[0], key = base.split('k=')[1];
    const call = (method, url, body, headers) => new Promise((resolve, reject) => {
      const u = new URL(origin + url);
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: Object.assign({ 'content-type': 'application/json', 'x-pmx-key': key }, headers) }, res => {
        const parts = [];
        res.on('data', c => parts.push(c));
        res.on('end', () => { const text = Buffer.concat(parts).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (e) { /* the page is not JSON */ } resolve({ code: res.statusCode, text, json, headers: res.headers }); });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
    const get = async url => { const a = await call('GET', url); assert.strictEqual(a.code, 200, url + ': ' + a.text); return a.json; };
    const post = async (url, body) => { const a = await call('POST', url, body || {}); assert.strictEqual(a.code, 200, url + ': ' + a.text); return a.json; };
    const refusedBy = async (method, url, body, pattern) => { const a = await call(method, url, body); assert.strictEqual(a.code, 400, url + ' was not refused: ' + a.text); assert.match(a.json.error, pattern); };

    // who may talk to it
    let a = await call('GET', '/?k=' + key);
    assert.strictEqual(a.code, 200);
    const nonce = /script-src 'nonce-([^']+)'/.exec(a.headers['content-security-policy'] || '');
    assert.ok(nonce && a.text.includes(`<script nonce="${nonce[1]}">`) && !a.text.includes('__NONCE__'), 'the page does not carry the nonce of its policy');
    assert.match(a.headers['content-security-policy'], /default-src 'none'/);
    assert.doesNotMatch(a.text, /(src|href)\s*=\s*["']?(https?:)?\/\//, 'the page loads something from elsewhere');
    assert.strictEqual((await call('GET', '/?k=' + '0'.repeat(32))).code, 403, 'the page opened with a wrong key');
    assert.strictEqual((await call('GET', '/api/state', undefined, { 'x-pmx-key': '' })).code, 403, 'the API answered without the key');
    assert.strictEqual((await call('GET', '/api/state?k=' + key, undefined, { 'x-pmx-key': '' })).code, 403, 'the API took the key from the address');
    assert.strictEqual((await call('GET', '/api/state', undefined, { host: 'pmx.example:80' })).code, 403, 'the API answered under another host name');
    assert.strictEqual((await call('POST', '/api/state', {})).code, 404);

    // what it shows
    let st = await get('/api/state');
    assert.strictEqual(st.root.name, 'Demo');
    assert.deepStrictEqual(st.root.children.map(c => c.name), ['Smoke', 'Catalogue', 'Orders']);
    assert.deepStrictEqual(st.counts, { modified: 0, added: 0, removed: 0 });
    assert.deepStrictEqual(st.environments.map(e => [e.name, e.keys.map(k => k.key)]), [['local', ['region', 'token']]]);
    assert.ok(!JSON.stringify(st).includes('not-shown'), 'a value from the environment file reached the page');
    let pending = await get('/api/pending');
    assert.deepStrictEqual([pending.packed, pending.added, pending.removed], [true, 0, 0]);
    const orders = 'Orders/Open_orders.request.js', ordersTest = 'Orders/Open_orders.test.js';
    let node = await get('/api/node?id=' + encodeURIComponent(orders));
    assert.deepStrictEqual(node.inherited.map(x => [x.kind, x.name, x.scripts.map(s => s.listen)]), [['collection', 'Demo', ['prerequest', 'test']], ['folder', 'Orders', []]]);
    assert.deepStrictEqual(node.scripts.map(s => [s.listen, s.tests, s.syntax]), [['prerequest', 0, null], ['test', 2, null]]);
    assert.deepStrictEqual((await get('/api/variables')).map(v => [v.key, v.from.join()]), [['baseUrl', 'collection'], ['orderStatus', 'a script']]);
    assert.deepStrictEqual([...new Set((await get('/api/search?q=expectsamenames')).map(x => x.name))], ['Genres and formats', 'Picks by genre']);

    // newman on the collection as it is: the demo fails on purpose, and each failure names its file and line
    let t = await post('/api/test');
    assert.deepStrictEqual([t.run.pass, t.run.total, t.run.failed], [false, 10, 5]);
    const stuck = t.run.assertions.find(x => x.result === 'FAIL' && x.id === orders);
    assert.deepStrictEqual([stuck.file, stuck.line, stuck.owner], [ordersTest, 8, orders]);
    assert.strictEqual(read(C10), before10, 'a run with no edits changed the collection file');
    t = await post('/api/test', { id: 'Smoke/Ping.request.js' });
    assert.deepStrictEqual([t.run.pass, t.run.total, t.run.only], [true, 1, 'Ping']);

    // edits, as the page makes them
    node.def.request.header.push({ key: 'X-Trace', value: 'demo', type: 'text' });
    node.def.request.url.raw += '&limit=5';
    node.def.request.url.query.push({ key: 'limit', value: '5' });
    await post('/api/def', { id: orders, def: node.def });
    let saved = await post('/api/script', { file: ordersTest, text: node.scripts[1].text.replace('return line.status !== "in stock";', 'return line.status !== "in stock" && line.status !== "preorder";') });
    assert.deepStrictEqual([saved.syntax, saved.tests, saved.testsBefore, typeof saved.rev], [null, 2, 2, 'string']);
    saved = await post('/api/script', { file: 'collection.prerequest.js', text: 'pm.request.headers.upsert({ key: "X-Demo-Client", value: "pmx-demo" }' });
    assert.match(saved.syntax, /SyntaxError/);
    pending = await get('/api/pending');
    assert.match(pending.errors.join('\n'), /SYNTAX ERROR .*collection\.prerequest\.js/);
    await post('/api/revert', { id: 'collection.prerequest.js' });
    const top = await get('/api/node?id=collection.js');
    top.def.variable.push({ key: 'region', value: 'south' });
    await post('/api/def', { id: 'collection.js', text: JSON.stringify(top.def, null, 2) });              // the Raw tab sends text
    const added = (await post('/api/add', { parent: 'Smoke/folder.js', kind: 'request', name: 'Version: 2?' })).id;
    assert.strictEqual(added, 'Smoke/Version_2.request.js');
    const versionTest = (await post('/api/add-script', { id: added, listen: 'test' })).file;
    await post('/api/script', { file: versionTest, text: 'pm.test("Version answers", function () {\n    pm.response.to.have.status(200);\n});' });
    const version = await get('/api/node?id=' + encodeURIComponent(added));
    version.def.request.url = { raw: '{{baseUrl}}/health', host: ['{{baseUrl}}'], path: ['health'] };
    await post('/api/def', { id: added, def: version.def });
    await post('/api/move', { id: added, by: -1 });
    const copy10 = (await post('/api/duplicate', { id: 'Smoke/Ping.request.js' })).id;
    await post('/api/remove', { id: copy10 });
    const folder10 = (await post('/api/add', { parent: 'collection.js', kind: 'folder', name: 'Later' })).id;
    assert.strictEqual(folder10, 'Later/folder.js');
    await post('/api/remove', { id: folder10 });
    assert.ok(!fs.existsSync(T10('Later')) && !fs.existsSync(T10('Smoke', 'Ping_copy.request.js')), 'removing something new left its files');
    await post('/api/remove', { id: 'Catalogue/Staff_picks/folder.js' });
    st = await get('/api/state');
    assert.deepStrictEqual(st.removed.map(x => x.id).sort(), ['Catalogue/Staff_picks/Picks_by_genre.request.js', 'Catalogue/Staff_picks/folder.js']);
    const ping10 = await get('/api/node?id=' + encodeURIComponent('Smoke/Ping.request.js'));
    ping10.def.request.header.push({ key: 'X-Edited', value: 'before removing', type: 'text' });
    ping10.def.request.description = 'Answers "ok": true when the API is up';
    let rev10 = (await post('/api/def', { id: 'Smoke/Ping.request.js', def: ping10.def, rev: ping10.rev })).rev;
    assert.deepStrictEqual((await get('/api/search?q=' + encodeURIComponent('answers "ok": true'))).map(x => x.name), ['Ping'], 'text with quotes inside a definition is not found');
    a = await call('POST', '/api/def', { id: 'Smoke/Ping.request.js', def: ping10.originalDef, rev: ping10.rev });   // an older copy of the page, saved late
    assert.strictEqual(a.code, 409, a.text);
    assert.match(a.json.error, /was changed in the files since the page read it/);
    a = await call('POST', '/api/script', { file: 'Smoke/Ping.test.js', text: 'old copy', rev: 'not-the-fingerprint' });
    assert.strictEqual(a.code, 409, a.text);
    assert.match(read(T10('Smoke', 'Ping.request.js')), /X-Edited/, 'an older copy was written over a newer file');
    assert.ok(!read(T10('Smoke', 'Ping.test.js')).includes('old copy'));
    await post('/api/remove', { id: 'Smoke/Ping.request.js' });
    assert.ok(fs.existsSync(T10('Smoke', 'Ping.request.js')) && fs.existsSync(T10('Smoke', 'Ping.test.js')), 'removing something that was unpacked deleted its files');
    await post('/api/revert', { id: 'Smoke/Ping.request.js' });                                           // "Put back": to where it was, first in its folder,
    assert.match(read(T10('Smoke', 'Ping.request.js')), /X-Edited/, 'put back lost the edits made before the removal');   // with the edits it had
    rev10 = (await get('/api/node?id=' + encodeURIComponent('Smoke/Ping.request.js'))).rev;
    await post('/api/def', { id: 'Smoke/Ping.request.js', def: ping10.originalDef, rev: rev10 });
    // Revert on a folder gives it its own fields back and keeps what is in it; a script a definition had gained goes with it
    const smoke10 = await get('/api/node?id=' + encodeURIComponent('Smoke/folder.js'));
    smoke10.def.name = 'Smoke tests';
    await post('/api/def', { id: 'Smoke/folder.js', def: smoke10.def, rev: smoke10.rev });
    const gained10 = (await post('/api/add-script', { id: 'Smoke/folder.js', listen: 'prerequest' })).file;
    assert.ok(fs.existsSync(T10(...gained10.split('/'))));
    await post('/api/revert', { id: 'Smoke/folder.js' });
    st = await get('/api/state');
    assert.deepStrictEqual([st.root.children[0].name, st.root.children[0].children.map(c => c.name), st.root.children[0].scripts.length], ['Smoke', ['Ping', 'Version: 2?'], 0], 'reverting a folder dropped what was added to it');
    assert.ok(!fs.existsSync(T10(...gained10.split('/'))), 'the script the folder had gained was left behind');
    assert.deepStrictEqual(st.unlisted, []);
    fs.writeFileSync(T10('Smoke', 'notes.js'), '// mine');
    assert.deepStrictEqual((await get('/api/state')).unlisted, ['Smoke/notes.js']);
    fs.rmSync(T10('Smoke', 'notes.js'));
    assert.deepStrictEqual([...new Set((await get('/api/search?q=' + encodeURIComponent('"key": "status"'))).map(x => x.name))], ['Open orders']);
    assert.deepStrictEqual([...new Set((await get('/api/search?q=' + encodeURIComponent('{{baseUrl}}/orders?status'))).map(x => x.name))], ['Open orders']);
    await post('/api/revert', { id: 'Catalogue/Staff_picks/folder.js' });
    st = await get('/api/state');
    assert.deepStrictEqual(st.removed, []);
    assert.deepStrictEqual(st.counts, { modified: 3, added: 1, removed: 0 });
    assert.deepStrictEqual(st.root.children[0].children.map(c => [c.name, c.status]), [['Ping', 'same'], ['Version: 2?', 'added']]);
    assert.deepStrictEqual(st.root.children[1].children.map(c => c.name), ['Genres and formats', 'Staff picks']);

    // the diffs it shows
    const diff = await get('/api/diff?id=' + encodeURIComponent(orders));
    assert.deepStrictEqual(diff.map(f => [f.file, f.changed]), [[orders, true], ['Orders/Open_orders.prerequest.js', false], [ordersTest, true]]);
    assert.deepStrictEqual(diff[2].lines.filter(l => l.t === '+' || l.t === '-').map(l => l.t + l.b + l.a), ['-undefined10', '+10undefined']);
    assert.ok(diff[0].lines.some(l => l.t === 'gap'), 'unchanged lines far from a change are sent in full');
    assert.deepStrictEqual((await get('/api/changes')).map(c => [c.id, c.status]), [['collection.js', 'modified'], ['Smoke/folder.js', 'modified'], [added, 'added'], [orders, 'modified']]);
    const preview = await get('/api/preview');
    assert.strictEqual(preview.how, 'layout kept');
    assert.ok(preview.added > 20 && preview.removed <= 6, JSON.stringify([preview.added, preview.removed]));
    assert.deepStrictEqual((await get('/api/variables')).filter(v => v.key === 'region').map(v => v.from.join()), ['collection']);
    await post('/api/environment', { file: 'local.postman_environment.json' });
    assert.deepStrictEqual((await get('/api/variables')).filter(v => v.key === 'region').map(v => v.from.join()), ['collection,environment']);
    await refusedBy('POST', '/api/environment', { file: 'package.json' }, /not an environment file here/);
    assert.strictEqual(read(C10), before10, 'the collection file changed before Pack');

    // it writes only inside the tree
    const outside = path.join(os.tmpdir(), 'outside-' + path.basename(d10) + '.js');
    await refusedBy('POST', '/api/script', { file: '../../../' + path.basename(outside), text: 'x' }, /is not a script of this collection/);
    await refusedBy('POST', '/api/script', { file: outside, text: 'x' }, /is not a script of this collection/);
    await refusedBy('POST', '/api/def', { id: '../../../pmx.config.json', def: {} }, /is not part of the collection/);
    await refusedBy('GET', '/api/node?id=' + encodeURIComponent('../../../pmx.config.json'), undefined, /is not part of the collection/);
    await refusedBy('POST', '/api/add', { parent: orders, kind: 'request', name: 'x' }, /cannot contain other requests/);
    await refusedBy('POST', '/api/revert', { id: '../../../pmx.config.json' }, /did not exist when the collection was unpacked/);
    await refusedBy('POST', '/api/def', { id: orders, text: '{ "name": ' }, /not valid JSON/);
    assert.ok(!fs.existsSync(outside), 'something was written outside the tree');
    if (process.platform !== 'win32') {                                             // a link in the tree is never read through or written through,
      const pingTest = T10('Smoke', 'Ping.test.js'), pingDef = T10('Smoke', 'Ping.request.js'), pingDefText = read(pingDef);
      const LINK = /is a link, not a file - refused|is reached through a link - refused/;
      const refusedLink = async (what, change, calls, undo) => {                    // whether or not what it points at exists
        change();
        st = await get('/api/state');
        assert.match(st.problems.join('\n'), LINK, what);
        for (const [method, url, body] of calls) await refusedBy(method, url, body, LINK);
        a = await post('/api/pack');
        assert.match(a.errors.join('\n'), LINK, what);
        assert.strictEqual(read(C10), before10, what + ': a refused pack wrote to the collection');
        undo();
      };
      const viaScript = [['POST', '/api/script', { file: 'Smoke/Ping.test.js', text: 'overwritten' }], ['POST', '/api/revert', { id: 'Smoke/Ping.test.js' }], ['GET', '/api/node?id=' + encodeURIComponent('Smoke/Ping.request.js')]];
      const viaDef = [['POST', '/api/def', { id: 'Smoke/Ping.request.js', def: { name: 'x', request: {} } }], ['POST', '/api/revert', { id: 'Smoke/Ping.request.js' }], ['GET', '/api/node?id=' + encodeURIComponent('Smoke/Ping.request.js')]];
      fs.writeFileSync(outside, 'var secret = 1;');
      await refusedLink('a script that is a link to a file elsewhere', () => { fs.rmSync(pingTest); fs.symlinkSync(outside, pingTest); }, viaScript, () => fs.rmSync(pingTest));
      assert.strictEqual(read(outside), 'var secret = 1;');
      fs.rmSync(outside);
      await refusedLink('a script that is a link to a file that does not exist yet', () => fs.symlinkSync(outside, pingTest), viaScript, () => fs.rmSync(pingTest));
      st = await get('/api/state');
      assert.deepStrictEqual(st.root.children[0].children.map(c => c.name), ['Ping', 'Version: 2?'], 'a request whose script is missing is no longer shown');
      await post('/api/revert', { id: 'Smoke/Ping.test.js' });
      await refusedLink('a definition that is a link to a file that does not exist yet', () => { fs.rmSync(pingDef); fs.symlinkSync(outside, pingDef); }, viaDef, () => { fs.rmSync(pingDef); fs.writeFileSync(pingDef, pingDefText); });
      const away = fs.mkdtempSync(path.join(os.tmpdir(), 'pmx-away-'));
      fs.renameSync(T10('Smoke'), path.join(away, 'Smoke'));
      await refusedLink('a folder that is a link', () => fs.symlinkSync(path.join(away, 'Smoke'), T10('Smoke')), [['POST', '/api/def', { id: 'Smoke/folder.js', def: { name: 'x', item: { $children: [] } } }], ['POST', '/api/revert', { id: 'Smoke/Ping.test.js' }], ['POST', '/api/revert', { id: 'Smoke/folder.js' }]],
        () => { fs.rmSync(T10('Smoke')); fs.renameSync(path.join(away, 'Smoke'), T10('Smoke')); });
      assert.ok(!fs.existsSync(outside) && fs.readdirSync(away).length === 0, 'something was written through a link');
      st = await get('/api/state');
      assert.deepStrictEqual(st.problems, []);
    }

    // pack and run: the edits are in the collection JSON, with its layout kept, and newman agrees
    assert.strictEqual(read(C10), before10);
    t = await post('/api/test');
    assert.deepStrictEqual([t.run.pass, t.run.total, t.run.failed, t.run.environment], [false, 11, 3, 'local.postman_environment.json']);
    assert.ok(!t.run.assertions.some(x => x.result === 'FAIL' && x.id === orders), 'the edited test still fails');
    const packed10 = parse(read(C10)), want10 = parse(before10);
    want10.variable.push({ key: 'region', value: 'south' });
    want10.item[0].item.push({ name: 'Version: 2?', request: { method: 'GET', header: [], url: { raw: '{{baseUrl}}/health', host: ['{{baseUrl}}'], path: ['health'] } }, response: [], event: [{ listen: 'test', script: { type: 'text/javascript', exec: ['pm.test("Version answers", function () {\r', '    pm.response.to.have.status(200);\r', '});'] } }] });
    const o10 = want10.item[2].item[0];
    o10.request.header.push({ key: 'X-Trace', value: 'demo', type: 'text' });
    o10.request.url.raw += '&limit=5';
    o10.request.url.query.push({ key: 'limit', value: '5' });
    o10.event[1].script.exec = o10.event[1].script.exec.map(line => line.replace('return line.status !== "in stock";', 'return line.status !== "in stock" && line.status !== "preorder";'));
    assert.deepStrictEqual(packed10, want10, 'the packed collection is not the original plus the edits made through the page');
    assert.deepStrictEqual(Object.keys(packed10.item[0].item[1]), ['name', 'event', 'request', 'response'], 'a new script is not where Postman puts it');
    pending = await get('/api/pending');
    assert.strictEqual(pending.packed, true);
    assert.deepStrictEqual((await post('/api/pack')).errors, []);
    // what a removed request still points to is not a stray; a definition laid out again is the same definition; the older way of setting a variable counts
    const pre10 = (await post('/api/add-script', { id: 'Smoke/Ping.request.js', listen: 'prerequest' })).file;
    await post('/api/script', { file: pre10, text: 'postman.setEnvironmentVariable("legacy", "1");' });
    let ping11 = await get('/api/node?id=' + encodeURIComponent('Smoke/Ping.request.js'));
    ping11.def.request.header.push({ key: 'X-Legacy', value: '{{legacy}}', type: 'text' });
    ping11.def.response = [{ name: 'saved', body: '{{onlyInAnExample}}' }];
    await post('/api/def', { id: 'Smoke/Ping.request.js', def: ping11.def, rev: ping11.rev });
    const vars11 = await get('/api/variables');
    assert.deepStrictEqual([vars11.filter(v => v.key === 'legacy').map(v => [v.uses, v.from.join()]), vars11.some(v => v.key === 'onlyInAnExample')], [[[1, 'a script']], false]);
    ping11 = await get('/api/node?id=' + encodeURIComponent('Smoke/Ping.request.js'));
    fs.writeFileSync(T10('Smoke', 'Ping.request.js'), '// laid out again by an editor\r\n' + START + JSON.stringify(ping11.def, null, 4).replace(/\n/g, '\r\n') + ';\r\n');
    ping11.def.name = 'Ping, saved after the file was laid out again';
    a = await call('POST', '/api/def', { id: 'Smoke/Ping.request.js', def: ping11.def, rev: ping11.rev });
    assert.strictEqual(a.code, 200, 'a save was refused although the file only had another layout: ' + a.text);
    await post('/api/remove', { id: 'Smoke/Ping.request.js' });
    st = await get('/api/state');
    assert.deepStrictEqual([st.unlisted, st.removed.map(x => x.id)], [[], ['Smoke/Ping.request.js']], 'the script the removed request had gained is called a stray');
    assert.doesNotMatch(pmx(d10, 'tree', 'status').out, /^\s*\? /m);
    await post('/api/revert', { id: 'Smoke/Ping.request.js' });
    await post('/api/revert', { id: 'Smoke/Ping.request.js' });                                           // (first: listed again; then: as it was)
    st = await get('/api/state');
    assert.deepStrictEqual([st.unlisted, st.removed, fs.existsSync(T10(...pre10.split('/')))], [[], [], false]);

    // the same request name twice: a failing test still leads to its own file, and one of the two can be run alone
    const twice = await get('/api/node?id=' + encodeURIComponent('Smoke/folder.js'));
    const dup10 = (await post('/api/duplicate', { id: 'Smoke/Ping.request.js' })).id;
    const dupNode = await get('/api/node?id=' + encodeURIComponent(dup10));
    dupNode.def.name = 'Ping';
    await post('/api/def', { id: dup10, def: dupNode.def, rev: dupNode.rev });
    await post('/api/script', { file: dupNode.scripts[0].file, text: 'pm.test("The API is up", function () {\n    pm.response.to.have.status(500);\n});' });
    t = await post('/api/test');
    const wrong = t.run.assertions.filter(x => x.result === 'FAIL' && x.name === 'The API is up');
    assert.deepStrictEqual(wrong.map(x => [x.id, x.file, x.line]), [[dup10, dupNode.scripts[0].file, 1]], 'a failure of the second request of that name is shown at the first');
    t = await post('/api/test', { id: dup10 });
    assert.deepStrictEqual([t.run.total, t.run.failed, t.run.only], [1, 1, 'Ping']);
    r = pmx(d10, 'tree', 'test', '--folder', 'Ping');
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, /2 folders or requests are called "Ping"/);
    r = pmx(d10, 'tree', 'test', '--folder', 'Orders');
    assert.match(r.out, /RESULT: PASS - 4 assertions, 0 failed/);            // (the whole collection fails at this point: the copy of Ping expects a 500)
    assert.match(pmx(d10, 'tree', 'test', '--folder', 'Nowhere').out, /no folder or request is called "Nowhere"/);
    await post('/api/remove', { id: dup10 });
    assert.deepStrictEqual(twice.def.item.$children, (await get('/api/node?id=' + encodeURIComponent('Smoke/folder.js'))).def.item.$children);

    // a collection inside {"collection": ...}, as the Postman API hands it out: newman runs it, and an empty one is not a pass
    const dw = scratch();
    makeDemo(dw);
    fs.writeFileSync(path.join(dw, 'pmx.config.json'), JSON.stringify({ collection: 'Demo.postman_collection.json', newman: { timeoutRequest: 10000 } }));
    fs.writeFileSync(path.join(dw, 'Demo.postman_collection.json'), JSON.stringify({ collection: parse(read(path.join(dw, 'Demo.postman_collection.json'))) }, null, '\t'));
    assert.strictEqual(pmx(dw, 'tree', 'unpack', 'Demo.postman_collection.json').code, 0);
    r = pmx(dw, 'tree', 'test');
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /RESULT: FAIL - 5 of 10 assertions failed/);
    assert.match(pmx(dw, 'tree', 'check', 'Demo.postman_collection.json', '--run').out, /10 and 10 assertions, the same results/);
    fs.writeFileSync(path.join(dw, 'Empty.postman_collection.json'), JSON.stringify({ info: { name: 'Empty' }, item: [] }, null, '\t'));
    assert.strictEqual(pmx(dw, 'tree', 'unpack', 'Empty.postman_collection.json').code, 0);
    r = pmx(dw, 'tree', 'test', 'Empty.postman_collection.json');
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /RESULT: FAIL - newman ran no request/);

    // a pack from the terminal while the page is open is this working copy's own pack, not somebody else's change
    let own = await get('/api/node?id=' + encodeURIComponent(orders));
    await post('/api/script', { file: ordersTest, text: own.scripts[1].text.replace('"preorder"', '"backorder"'), rev: own.scripts[1].rev });
    assert.strictEqual(pmx(d10, 'tree', 'pack').code, 0);
    own = await get('/api/node?id=' + encodeURIComponent(orders));
    await post('/api/script', { file: ordersTest, text: own.scripts[1].text.replace('"backorder"', '"reserved"'), rev: own.scripts[1].rev });
    a = await post('/api/pack');
    assert.deepStrictEqual(a.errors, [], 'a pack from the terminal was taken for a foreign change');
    assert.ok(read(C10).includes('reserved') && !read(C10).includes('backorder'));
    // the collection changes underneath while the page is open: Pack merges, and the page goes on from the merged collection
    fs.writeFileSync(C10, read(C10).replace('"name": "Genres and formats"', '"name": "Genres and formats (renamed upstream)"'));
    own = await get('/api/node?id=' + encodeURIComponent(orders));
    await post('/api/script', { file: ordersTest, text: own.scripts[1].text.replace('"reserved"', '"on hold"'), rev: own.scripts[1].rev });
    pending = await get('/api/pending');
    assert.deepStrictEqual([pending.errors, pending.onto, pending.held], [[], true, false]);
    a = await post('/api/pack');
    assert.deepStrictEqual([a.errors, a.onto], [[], true]);
    assert.ok(read(C10).includes('on hold') && read(C10).includes('Genres and formats (renamed upstream)'));
    st = await get('/api/state');
    assert.deepStrictEqual([st.counts, st.problems, st.root.children[1].children[0].name], [{ modified: 1, added: 0, removed: 0 }, [], 'Genres and formats (renamed upstream)']);   // the edit is still an edit; the rename from the other side is not
    pending = await get('/api/pending');
    assert.deepStrictEqual([pending.errors, pending.packed, pending.added, pending.removed], [[], true, 1, 1], 'after a merge the page does not count from the newer collection');
    own = await get('/api/node?id=' + encodeURIComponent(orders));
    await post('/api/script', { file: ordersTest, text: own.scripts[1].text.replace('"on hold"', '"held"'), rev: own.scripts[1].rev });
    assert.deepStrictEqual((await get('/api/changes')).map(c => [c.id, c.status]), [[orders, 'modified']]);
    a = await post('/api/pack');
    assert.deepStrictEqual([a.errors, a.onto, a.added, a.removed], [[], false, 1, 1]);
    if (process.platform !== 'win32') {              // a branch checked out while the page is open can turn the collection into a link: every call looks again
      const elsewhere11 = path.join(os.tmpdir(), 'link-' + path.basename(d10) + '.json'), real11 = read(C10);
      fs.writeFileSync(elsewhere11, real11);
      fs.rmSync(C10); fs.symlinkSync(elsewhere11, C10);
      for (const [method, where, body] of [['GET', '/api/state'], ['POST', '/api/pack', {}]]) {   // reading is refused as well as packing
        a = await call(method, where, body);
        assert.strictEqual(a.code, 400, where + ': ' + a.text);
        assert.match(a.json.error, /is a link now, or is reached through one - refused/);
      }
      assert.strictEqual(read(elsewhere11), real11, 'the page wrote through a link that appeared while it was open');
      fs.rmSync(C10); fs.writeFileSync(C10, real11); fs.rmSync(elsewhere11);
    }
    await post('/api/close');
    const exit = await new Promise(resolve => { if (ui.exitCode != null) resolve(ui.exitCode); else ui.on('exit', resolve); setTimeout(() => resolve('still running'), 5000); });
    assert.strictEqual(exit, 0, 'tree ui did not stop when the page closed it');
  } finally { ui.kill(); api10.kill(); }
  if (process.platform !== 'win32') {              // the note may not be a link, and may not name a collection that is reached through one
    const note10 = T10('.pmx-tree.json'), noteText10 = read(note10), elsewhere10 = fs.mkdtempSync(path.join(os.tmpdir(), 'pmx-else-'));
    fs.writeFileSync(path.join(elsewhere10, 'note.json'), noteText10);
    fs.rmSync(note10); fs.symlinkSync(path.join(elsewhere10, 'note.json'), note10);
    r = pmx(d10, 'tree', 'pack');                                                   // a folder whose note is a link is not taken for a tree at all
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, /nothing is unpacked here yet/);
    r = pmx(d10, 'tree', 'pack', '--tree', path.join('.pmx', 'Demo', 'tree'));
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, /\.pmx-tree\.json is a link, not a file - refused/);
    assert.strictEqual(read(path.join(elsewhere10, 'note.json')), noteText10, 'the note was written through a link');
    fs.rmSync(note10);
    fs.symlinkSync(elsewhere10, path.join(d10, 'linked'));
    fs.writeFileSync(note10, noteText10.replace('"Demo.postman_collection.json"', '"linked/Elsewhere.json"'));
    for (const command of ['status', 'pack', 'finish']) {
      r = pmx(d10, 'tree', command);
      assert.strictEqual(r.code, 2, command + ': ' + r.out);
      assert.match(r.out, /names a collection that is a link or is reached through one - refused/, command);
    }
    assert.deepStrictEqual(fs.readdirSync(elsewhere10), ['note.json'], 'a collection was written through a linked folder');
    fs.symlinkSync(path.join(elsewhere10, 'tree'), path.join(d10, 'linked-tree'));
    r = pmx(d10, 'tree', 'unpack', 'Demo.postman_collection.json', '--tree', 'linked-tree/files');
    assert.strictEqual(r.code, 2, r.out);
    assert.match(r.out, /must be inside the current folder/);
    assert.deepStrictEqual(fs.readdirSync(elsewhere10), ['note.json']);
  }
  ok('the page\'s server: answers only this machine and only with its key; shows, edits, adds, moves, removes and puts back through its API; diffs; newman with file:line and an environment; never reads or writes outside the tree, also not through a link whose target does not exist yet');

  // 12. the files as the source of the collection: adopt, build, verify, a merge, an edit of the JSON, an export from Postman
  const ds = scratch(), Cs = path.join(ds, 'Demo.postman_collection.json'), Ts = (...parts) => path.join(ds, 'Demo', ...parts);
  makeDemo(ds);
  fs.writeFileSync(path.join(ds, '.gitignore'), '.pmx/\n');
  git(ds, 'init', '-q', '.'); git(ds, 'add', '-A'); git(ds, 'commit', '-qm', 'the collection');
  const mainS = git(ds, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), textS = read(Cs);
  r = pmx(ds, 'tree', 'adopt', 'Demo.postman_collection.json');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /adopted Demo\.postman_collection\.json -> Demo\/ {3}\(4 requests, 4 folders, 7 scripts, 16 files\)/);
  assert.match(r.out, /building from the files gives the same file, byte for byte/);
  assert.strictEqual(read(Cs), textS, 'adopting changed the collection file');
  const noteS = read(Ts('.pmx-tree.json'));
  assert.deepStrictEqual(JSON.parse(noteS), { version: 2, role: 'source', collection: 'Demo.postman_collection.json', format: { indent: '\t', eol: '\n', bom: false, tail: '', scriptCr: 'inner' } });
  assert.strictEqual(pmx(ds, 'tree', 'verify').code, 0);
  assert.match(pmx(ds, 'tree', 'build').out, /built -> Demo\.postman_collection\.json {3}\(it was up to date\)/);
  assert.match(pmx(ds, 'tree', 'status').out, /is the source of {2}Demo\.postman_collection\.json\nno changes since the collection JSON \(the folder is not committed yet\)\nDemo\.postman_collection\.json is up to date with the files/);
  for (const [args, pattern] of [[['adopt', 'Demo.postman_collection.json'], /exists and is not empty[^]*tree import/], [['unpack', 'Demo.postman_collection.json', '--tree', 'Demo'], /is the source of its collection/], [['finish'], /is the source of Demo\.postman_collection\.json: it stays/]]) {
    r = pmx(ds, 'tree', ...args);
    assert.strictEqual(r.code, 2, args.join(' ') + ': ' + r.out);
    assert.match(r.out, pattern, args.join(' '));
  }
  assert.ok(fs.existsSync(Ts('collection.js')) && read(Cs) === textS);
  git(ds, 'add', '-A'); git(ds, 'commit', '-qm', 'adopt: the files are the source');

  const scriptS = Ts('Orders', 'Open_orders.test.js');
  editDef(Ts('Smoke', 'Ping.request.js'), d => { d.name = 'Ping the API'; });                 // an edit: seen against the last commit, and the JSON is behind
  fs.writeFileSync(scriptS, read(scriptS).replace('"in stock"', '"available"'));
  r = pmx(ds, 'tree', 'status');
  assert.match(r.out, /changes since the last commit:\n {2}M Smoke\/Ping\.request\.js {3}<- Smoke \/ Ping the API\n {2}M Orders\/Open_orders\.test\.js/);
  assert.match(r.out, /is behind the files \(\+2 -2 lines\)/);
  r = pmx(ds, 'tree', 'verify');
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /VERIFY FAILED\n {2}Demo\.postman_collection\.json is not what the files generate \(\+2 -2 lines\)/);
  r = pmx(ds, 'tree', 'build');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /built -> Demo\.postman_collection\.json {3}\(\+2 -2 lines; layout kept\)/);
  const builtS = textS.replace('"name": "Ping"', '"name": "Ping the API"').replace('\\"in stock\\"', '\\"available\\"');
  assert.strictEqual(read(Cs), builtS, 'building moved more than the two edited lines');
  assert.strictEqual(pmx(ds, 'tree', 'verify').code, 0);
  assert.strictEqual(read(Ts('.pmx-tree.json')), noteS, 'a build changed the note: it would conflict in every merge');
  assert.deepStrictEqual(git(ds, 'status', '--porcelain').split('\n').filter(Boolean).map(l => l.slice(3)).sort(), ['Demo.postman_collection.json', 'Demo/Orders/Open_orders.test.js', 'Demo/Smoke/Ping.request.js']);
  git(ds, 'commit', '-qam', 'two edits');
  fs.writeFileSync(scriptS, read(scriptS).replace(/pm\.test\("There are open orders to look at"[\s\S]*?\n}\);\n/, ''));   // a test removed since the last commit
  r = pmx(ds, 'tree', 'build');
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /TREE BUILD REFUSED[^]*dropped from 2 to 1 since the last commit/);
  assert.strictEqual(read(Cs), builtS);
  git(ds, 'checkout', '-q', '--', 'Demo');

  const cloneS = scratch();                                                                  // a fresh clone has no scratch folder and needs none
  git(cloneS, 'clone', '-q', ds, 'copy');
  r = pmx(path.join(cloneS, 'copy'), 'tree', 'verify');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(pmx(path.join(cloneS, 'copy'), 'tree', 'status').out, /no changes since the last commit\nDemo\.postman_collection\.json is up to date with the files/);

  git(ds, 'checkout', '-q', '-b', 'one');                                                    // two branches change different requests
  editDef(Ts('Smoke', 'Ping.request.js'), d => d.request.header.push({ key: 'Accept', value: 'application/json', type: 'text' }));
  assert.strictEqual(pmx(ds, 'tree', 'build').code, 0);
  git(ds, 'commit', '-qam', 'one');
  git(ds, 'checkout', '-q', '-b', 'two', mainS);
  fs.writeFileSync(scriptS, read(scriptS).replace('"available"', '"ready"'));
  assert.strictEqual(pmx(ds, 'tree', 'build').code, 0);
  git(ds, 'commit', '-qam', 'two');
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'merge', '-q', '--no-edit', 'one'], { cwd: ds });   // the files merge on their own; the JSON may or may not
  assert.strictEqual(git(ds, 'diff', '--name-only', '--diff-filter=U').trim().replace('Demo.postman_collection.json', ''), '', 'a file of the folder is in conflict');
  fs.writeFileSync(Cs, '<<<<<<< HEAD\n' + read(Cs) + '=======\n>>>>>>> one\n');             // say git left its marks in the generated file
  r = pmx(ds, 'tree', 'build');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /written new: the file could not be read as JSON \(merge marks\?\)/);
  const mergedS = parse(read(Cs));
  assert.deepStrictEqual([mergedS.item[0].item[0].request.header.length, mergedS.item[2].item[0].event[1].script.exec.join('').includes('"ready"')], [1, true], 'the built JSON does not hold both branches');
  assert.strictEqual(read(Cs), builtS.replace('"header": []', '"header": [\n\t\t\t\t\t\t\t{\n\t\t\t\t\t\t\t\t"key": "Accept",\n\t\t\t\t\t\t\t\t"value": "application/json",\n\t\t\t\t\t\t\t\t"type": "text"\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t]').replace('\\"available\\"', '\\"ready\\"'), 'a JSON built anew is not in the layout of the original');
  assert.strictEqual(pmx(ds, 'tree', 'verify').code, 0);
  git(ds, 'add', '-A'); git(ds, 'commit', '-q', '--allow-empty', '-m', 'merge one');    // (git may have merged and committed the JSON on its own already)

  const beforeEdit = read(Cs), catalogue = fs.readdirSync(Ts('Catalogue')).sort();           // the JSON is edited directly, as an export from Postman dropped over it would
  fs.writeFileSync(Cs, beforeEdit.replace('"name": "Genres and formats"', '"name": "Genres and formats (from Postman)"'));
  r = pmx(ds, 'tree', 'build');
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /was edited directly[^]*tree import/);
  assert.ok(read(Cs).includes('(from Postman)'), 'a refused build overwrote the edited JSON');
  editDef(Ts('collection.js'), d => d.variable.push({ key: 'mine', value: '1' }));            // and the files have an edit of their own that is not committed
  r = pmx(ds, 'tree', 'import');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /imported Demo\.postman_collection\.json -> Demo\/ {3}\(merged with the edits in the files; 1 file\(s\) written or removed\)/);
  assert.deepStrictEqual(fs.readdirSync(Ts('Catalogue')).sort(), catalogue, 'a renamed request got a new file');
  assert.match(read(Ts('Catalogue', 'Genres_and_formats.request.js')), /"name": "Genres and formats \(from Postman\)"/);
  assert.deepStrictEqual([parse(read(Cs)).item[1].item[0].name, parse(read(Cs)).variable.map(v => v.key)], ['Genres and formats (from Postman)', ['baseUrl', 'mine']]);
  assert.strictEqual(pmx(ds, 'tree', 'verify').code, 0);
  assert.match(pmx(ds, 'tree', 'import').out, /nothing to import/);
  git(ds, 'add', '-A'); git(ds, 'commit', '-qm', 'import');

  const exported = parse(read(Cs));                                                          // an export with a request added, a folder removed and a script changed
  exported.item[0].item.push({ name: 'Version', event: [{ listen: 'test', script: { type: 'text/javascript', exec: ['pm.test("Version answers", function () {\r', '    pm.response.to.have.status(200);\r', '});'] } }], request: { method: 'GET', header: [], url: { raw: '{{baseUrl}}/health', host: ['{{baseUrl}}'], path: ['health'] } }, response: [] });
  exported.item[1].item.splice(1, 1);
  exported.item[2].item[0].event[0].script.exec = ['pm.variables.set("orderStatus", "open");'];
  exported.item[2].name = 'Orders (renamed)';
  fs.writeFileSync(path.join(ds, 'export.json'), JSON.stringify(exported, null, 2));
  r = pmx(ds, 'tree', 'import', 'export.json');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(same(parse(read(Cs)), exported), 'after the import the collection is not what was imported');
  assert.deepStrictEqual(git(ds, 'status', '--porcelain', '--', 'Demo').split('\n').filter(Boolean).sort(), [' D Demo/Catalogue/Staff_picks/Picks_by_genre.request.js', ' D Demo/Catalogue/Staff_picks/Picks_by_genre.test.js', ' D Demo/Catalogue/Staff_picks/folder.js',
    ' M Demo/Catalogue/folder.js', ' M Demo/Orders/Open_orders.prerequest.js', ' M Demo/Orders/folder.js', ' M Demo/Smoke/folder.js', '?? Demo/Smoke/Version.request.js', '?? Demo/Smoke/Version.test.js'], 'the import touched other files than the ones that changed');
  assert.strictEqual(pmx(ds, 'tree', 'verify').code, 0);
  git(ds, 'add', '-A', 'Demo', 'Demo.postman_collection.json'); git(ds, 'commit', '-qm', 'import an export');

  editDef(Ts('Smoke', 'Ping.request.js'), d => { d.name = 'Ping (mine)'; });                  // the files and the export change the same value
  const clashS = parse(read(Cs));
  clashS.item[0].item[0].name = 'Ping (theirs)';
  fs.writeFileSync(path.join(ds, 'export.json'), JSON.stringify(clashS, null, 2));
  const beforeClash = read(Cs);
  r = pmx(ds, 'tree', 'import', 'export.json');
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /TREE IMPORT REFUSED[^]*1 place\(s\) were changed both in export\.json and in the files since the last commit/);
  assert.ok(read(Cs) === beforeClash && /Ping \(mine\)/.test(read(Ts('Smoke', 'Ping.request.js'))), 'a refused import wrote something');
  r = pmx(ds, 'tree', 'import', 'export.json', '--theirs');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(same(parse(read(Cs)), clashS) && /Ping \(theirs\)/.test(read(Ts('Smoke', 'Ping.request.js'))));
  fs.writeFileSync(Ts('Smoke', 'left-over.js'), '// listed nowhere');                          // CI also fails on a file that nothing lists
  r = pmx(ds, 'tree', 'verify');
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /Smoke\/left-over\.js: no definition lists this file/);

  const dv = scratch(), Cv = path.join(dv, 'Demo.postman_collection.json'), Tv = (...parts) => path.join(dv, 'Demo', ...parts);   // what the second review found, where the files are the source
  makeDemo(dv);
  fs.writeFileSync(Cv, JSON.stringify({ collection: parse(read(Cv)) }, null, '\t'));          // a collection inside {"collection": ...} is adopted as it is
  fs.writeFileSync(path.join(dv, '.gitignore'), '.pmx/\n');
  git(dv, 'init', '-q', '.'); git(dv, 'add', '-A'); git(dv, 'commit', '-qm', 'the collection');
  const wrappedV = read(Cv);
  assert.match(pmx(dv, 'tree', 'adopt', 'Demo.postman_collection.json').out, /building from the files gives the same file, byte for byte/);
  git(dv, 'add', '-A'); git(dv, 'commit', '-qm', 'adopt');
  fs.writeFileSync(Tv('Smoke', 'Ping.test.js'), BOM + read(Tv('Smoke', 'Ping.test.js')));     // a byte-order mark from an editor and a file manager's leftovers change nothing
  fs.writeFileSync(Tv('.DS_Store'), 'x');
  r = pmx(dv, 'tree', 'verify');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(pmx(dv, 'tree', 'status').out, /no changes since the last commit\nDemo\.postman_collection\.json is up to date with the files/);
  assert.strictEqual(pmx(dv, 'tree', 'build').code, 0);
  assert.strictEqual(read(Cv), wrappedV);
  const strayV = Buffer.from([0xff, 0xfe, 0x00, 0x41]);                                        // a file that nothing lists: verify fails on it, an import leaves its bytes alone
  fs.writeFileSync(Tv('Smoke', 'mine.bin'), strayV);
  assert.strictEqual(pmx(dv, 'tree', 'verify').code, 1);
  const exportV = parse(wrappedV);
  exportV.collection.item[0].item[0].name = 'Ping (from an export)';
  fs.writeFileSync(path.join(dv, 'export.json'), JSON.stringify(exportV, null, 2));
  r = pmx(dv, 'tree', 'import', 'export.json');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(fs.readFileSync(Tv('Smoke', 'mine.bin')).equals(strayV) && same(parse(read(Cv)), exportV), 'an import changed a file that nothing lists, or did not take the export');
  for (const [args, pattern] of [[['build', '--nope'], /unknown option --nope/], [['finish', '--remove-unlisted'], /is the source of Demo\.postman_collection\.json: it stays/], [['test', '--folder', 'Nowhere'], /no folder or request is called "Nowhere"/]]) {
    r = pmx(dv, 'tree', ...args);
    assert.strictEqual(r.code, 2, args.join(' ') + ': ' + r.out);
    assert.match(r.out, pattern, args.join(' '));
  }
  if (process.platform !== 'win32') {                                                          // the generated file has become a link: nothing is read or written through it
    const elsewhereV = path.join(os.tmpdir(), 'link-' + path.basename(dv) + '.json'), realV = read(Cv);
    fs.writeFileSync(elsewhereV, realV);
    fs.rmSync(Cv); fs.symlinkSync(elsewhereV, Cv);
    editDef(Tv('collection.js'), d => { (d.collection || d).variable.push({ key: 'mine', value: '1' }); });
    for (const sub of ['build', 'verify', 'import', 'status']) {
      r = pmx(dv, 'tree', sub);
      assert.strictEqual(r.code, 2, sub + ': ' + r.out);
      assert.match(r.out, /is a link|reached through one/, sub);
    }
    assert.strictEqual(read(elsewhereV), realV, 'a build wrote through a link');
    fs.rmSync(elsewhereV);
  }

  for (const [name, text] of Object.entries(layouts)) {                                       // what adopting does to other shapes of the file
    const back = tree.sourceRoundTrip(text);
    assert.deepStrictEqual(back.errors, [], name);
    assert.ok(same(back.json, parse(text)), name + ': built from the files, the collection is not the same');
    if (name !== 'handEdited') assert.strictEqual(back.text, text, name + ': built from the files, the file is not the same byte for byte');
  }
  const uneven = JSON.parse(JSON.stringify(demo));                                            // scripts whose line ends differ from the rest of the collection
  uneven.item[0].item[0].event[0].script.exec = ['var a = 1;', 'var b = 2;', ''];
  uneven.item[1].item[0].event[0].script.exec = uneven.item[1].item[0].event[0].script.exec.map(line => line.replace(/\r$/, '') + '\r');
  uneven.item[2].item[0].event[0].script.exec = 'var one = 1;\r\nvar text = "kept as one text";';
  uneven.event[1].script.exec = [];
  const unevenBack = tree.sourceRoundTrip(JSON.stringify(uneven, null, '\t'));
  assert.deepStrictEqual([unevenBack.errors, unevenBack.mixed, unevenBack.text === JSON.stringify(uneven, null, '\t')], [[], 0, true], 'a script with its own line ends does not come back as it was');
  let adopted = 0;
  for (let round = 0; round < 250; round++) {
    const random = seeded(5000 + round), doc = bigCollection(1 + random(4), 1 + random(6), random);
    const text = JSON.stringify(doc, null, [undefined, '\t', 2, 4][round % 4]) + ['', '\n', '\n\n'][round % 3];        // every layout with every ending
    const back = tree.sourceRoundTrip(text);
    assert.deepStrictEqual(back.errors, [], 'round ' + round);
    assert.strictEqual(back.text, text, 'adopt round ' + round + ': built from the files, the file is not the same byte for byte');
    adopted++;
  }
  ok(`the files as the source: adopt leaves the JSON alone and builds it back byte for byte (9 layouts, odd line ends, ${adopted} random collections); edits are counted from the last commit; verify fails when the JSON is behind; a merge needs only a build; an edited JSON is not overwritten but imported in place; a clash is refused; a wrapped collection, a byte-order mark, leftovers of a file manager, a stray file and a collection that became a link are handled as in the other role`);

  // 13. what a second review found
  const A12 = (() => { const d = scratch(); makeDemo(d); return read(path.join(d, 'Demo.postman_collection.json')); })();
  const fresh12 = (text = A12) => { const d = scratch(); fs.writeFileSync(path.join(d, 'Demo.postman_collection.json'), text); return { d, C: path.join(d, 'Demo.postman_collection.json'), T: (...parts) => path.join(d, '.pmx', 'Demo', 'tree', ...parts) }; };
  let k = fresh12();                                                                         // the collection file is put back after a merge, and changes again: the edits are still edits
  assert.strictEqual(pmx(k.d, 'tree', 'unpack', 'Demo.postman_collection.json').code, 0);
  fs.writeFileSync(k.T('Orders', 'Open_orders.test.js'), read(k.T('Orders', 'Open_orders.test.js')).replace('"in stock"', '"available"'));
  fs.writeFileSync(k.C, A12.replace('"name": "Ping"', '"name": "Ping (renamed upstream)"'));
  r = pmx(k.d, 'tree', 'pack');
  assert.match(r.out, /merged into the newer collection file/);
  assert.doesNotMatch(r.out, /share a name/);
  fs.writeFileSync(k.C, A12.replace('"name": "Ping"', '"name": "Ping (renamed upstream)"').replace('"name": "Genres and formats"', '"name": "Genres and formats (renamed upstream)"'));   // as git checkout and a pull leave it: without the edit
  r = pmx(k.d, 'tree', 'status');
  assert.match(r.out, /M Orders\/Open_orders\.test\.js/);
  r = pmx(k.d, 'tree', 'finish');
  assert.strictEqual(r.code, 0, r.out);
  const kept12 = parse(read(k.C));
  assert.ok(kept12.item[2].item[0].event[1].script.exec.join('').includes('"available"') && kept12.item[0].item[0].name === 'Ping (renamed upstream)' && kept12.item[1].item[0].name === 'Genres and formats (renamed upstream)', 'an edit was wiped when the collection file was put back after a merge: ' + r.out);

  k = fresh12();                                                                             // a file that nothing lists has the name the merged collection needs: refused, nothing written
  assert.strictEqual(pmx(k.d, 'tree', 'unpack', 'Demo.postman_collection.json').code, 0);
  fs.writeFileSync(k.T('Smoke', 'Ping.prerequest.js'), '// mine, listed nowhere');
  const upstream12 = parse(A12);
  upstream12.item[0].item[0].event.unshift({ listen: 'prerequest', script: { type: 'text/javascript', exec: ['// from upstream'] } });
  fs.writeFileSync(k.C, JSON.stringify(upstream12, null, '\t'));
  editDef(k.T('collection.js'), d => d.variable.push({ key: 'mine', value: '1' }));
  r = pmx(k.d, 'tree', 'pack');
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /needs these names, which files that nothing lists have taken:\s+Smoke\/Ping\.prerequest\.js/);
  assert.deepStrictEqual([read(k.T('Smoke', 'Ping.prerequest.js')), same(parse(read(k.C)), upstream12)], ['// mine, listed nowhere', true]);

  k = fresh12();                                                                             // a removed request that was edited keeps its edits through a merge
  assert.strictEqual(pmx(k.d, 'tree', 'unpack', 'Demo.postman_collection.json').code, 0);
  fs.writeFileSync(k.T('Orders', 'Open_orders.test.js'), read(k.T('Orders', 'Open_orders.test.js')).replace('"in stock"', '"available"'));
  editDef(k.T('Orders', 'folder.js'), d => { d.item.$children = []; });
  fs.writeFileSync(k.C, A12.replace('"name": "Ping"', '"name": "Ping (renamed upstream)"'));
  assert.strictEqual(pmx(k.d, 'tree', 'pack').code, 0);
  assert.match(read(k.T('Orders', 'Open_orders.test.js')), /"available"/, 'a merge deleted the edited files of a removed request');
  assert.match(pmx(k.d, 'tree', 'status').out, /D Orders\/Open_orders\.request\.js/);

  const oneString = parse(A12);                                                              // a script kept as one long string with line breaks inside, as generators write it
  oneString.item[0].item[0].event[0].script.exec = ['pm.test("The API is up", function () {\n    pm.response.to.have.status(200);\n});\n'];
  k = fresh12(JSON.stringify(oneString, null, '\t'));
  r = pmx(k.d, 'tree', 'check', 'Demo.postman_collection.json');
  assert.match(r.out, /IDENTICAL to the original[^]*layout-keeping writer gives: the same bytes/);
  assert.strictEqual(pmx(k.d, 'tree', 'unpack', 'Demo.postman_collection.json').code, 0);
  fs.writeFileSync(k.T('Smoke', 'Ping.test.js'), BOM + read(k.T('Smoke', 'Ping.test.js')));   // and an editor that puts a byte-order mark in front of it
  r = pmx(k.d, 'tree', 'status');
  assert.match(r.out, /no changes against the collection as it was unpacked\n.*already holds these edits/);
  assert.strictEqual(pmx(k.d, 'tree', 'pack').code, 0);
  assert.strictEqual(read(k.C), JSON.stringify(oneString, null, '\t'), 'a script that was not edited was written differently');

  const odd = parse(A12);                                                                    // names that are trouble: device names of Windows, and a title that looks like a definition
  odd.item[0].name = 'Aux';
  odd.item[0].item[0].name = 'CON';
  odd.item[1].item[0].name = 'module.exports = 1';
  const oddFiles = [...tree.split(JSON.stringify(odd)).files.keys()];
  assert.ok(['Aux_/folder.js', 'Aux_/CON_.request.js', 'Aux_/CON_.test.js'].every(f => oddFiles.includes(f)), oddFiles.join());
  k = fresh12(JSON.stringify(odd, null, '\t'));
  assert.match(pmx(k.d, 'tree', 'check', 'Demo.postman_collection.json').out, /IDENTICAL to the original/);
  assert.strictEqual(pmx(k.d, 'tree', 'unpack', 'Demo.postman_collection.json').code, 0);
  assert.match(pmx(k.d, 'tree', 'status').out, /no changes against the collection as it was unpacked/);
  editDef(k.T('Aux_', 'folder.js'), d => { d.item.$children = ['CON_.request.js/']; });        // a slash too many: reported, not a crash
  r = pmx(k.d, 'tree', 'status');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /ERROR .*CON_\.request\.js\/folder\.js is missing/);
  assert.doesNotMatch(r.out, /ENOTDIR|\n\s+at /);
  r = pmx(k.d, 'tree', 'pack');
  assert.strictEqual(r.code, 2, r.out);
  assert.doesNotMatch(r.out, /ENOTDIR|\n\s+at /);

  k = fresh12();                                                                             // options: an unknown one is refused, --help never runs the command
  assert.strictEqual(pmx(k.d, 'tree', 'unpack', 'Demo.postman_collection.json').code, 0);
  r = pmx(k.d, 'tree', 'finish', '--help', '--keep');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /tree unpack <collection\.json>/);
  assert.ok(fs.existsSync(k.T('collection.js')), '--help ran the command');
  for (const [args, pattern] of [[['status', '--nope'], /unknown option --nope/], [['finish', '--dry-run', '--keep'], /unknown option --dry-run/], [['test', '--folder', 'a', '--folder', 'b'], /--folder was given twice/], [['status', '--tree'], /--tree needs a value/]]) {
    r = pmx(k.d, 'tree', ...args);
    assert.strictEqual(r.code, 2, args.join(' ') + ': ' + r.out);
    assert.match(r.out, pattern);
  }
  assert.ok(fs.existsSync(k.T('collection.js')));
  fs.writeFileSync(k.T('Orders', 'Open_orders.test.js'), read(k.T('Orders', 'Open_orders.test.js')).replace('"in stock"', '"instock"') + '\n// and a real edit');
  r = pmx(k.d, 'tree', 'pack', '--ignore-whitespace');                                         // says which lines it left out, also next to a real edit
  assert.match(r.out, /--ignore-whitespace: edits that only change spacing were left out in Orders\/Open_orders\.test\.js \(1 line\)/);

  const dA = scratch(), dB = scratch();                                                      // two clones that end lines differently share a committed folder of files
  makeDemo(dA);
  fs.writeFileSync(path.join(dA, 'Demo.postman_collection.json'), read(path.join(dA, 'Demo.postman_collection.json')).replace(/\n/g, '\r\n'));
  fs.writeFileSync(path.join(dA, '.gitignore'), '.pmx/\n');
  git(dA, 'init', '-q', '.'); git(dA, 'config', 'core.autocrlf', 'true'); git(dA, 'add', '-A'); git(dA, 'commit', '-qm', 'the collection');
  assert.strictEqual(pmx(dA, 'tree', 'unpack', 'Demo.postman_collection.json', '--tree', 'files').code, 0);
  editDef(path.join(dA, 'files', 'Smoke', 'Ping.request.js'), d => { d.name = 'Ping the API'; });
  git(dA, 'add', '-A'); git(dA, 'commit', '-qm', 'the files, with one edit');
  git(dB, 'clone', '-q', '-c', 'core.autocrlf=false', dA, 'copy');
  const copyB = path.join(dB, 'copy');
  assert.ok(!read(path.join(copyB, 'Demo.postman_collection.json')).includes('\r\n') && read(path.join(dA, 'Demo.postman_collection.json')).includes('\r\n'), 'the two clones do not differ in their line ends');
  r = pmx(copyB, 'tree', 'status');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /M Smoke\/Ping\.request\.js[^]*does not hold these edits yet \(\+1 -1 lines\)/);
  r = pmx(copyB, 'tree', 'finish');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!read(path.join(copyB, 'Demo.postman_collection.json')).includes('\r\n') && parse(read(path.join(copyB, 'Demo.postman_collection.json'))).item[0].item[0].name === 'Ping the API');
  ok('a second review: edits survive a collection that is put back after a merge; strays are never overwritten or in the way unnoticed; removed-but-edited requests keep their edits; a script kept as one string, a byte-order mark, device names, a title like a definition and a slash too many are handled; unknown options are refused; clones with other line ends work');

  // 14. fuzz: random collections must come back identical, and the writer must reproduce their bytes
  let checkedWriter = 0;
  for (let round = 0; round < 250; round++) {
    const random = seeded(1000 + round);
    const doc = bigCollection(1 + random(4), 1 + random(6), random);
    const text = JSON.stringify(doc, null, [undefined, '\t', 2, 4][random(4)]);
    const back = roundTrip(text);
    assert.deepStrictEqual(back.built.errors, [], 'round ' + round);
    assert.ok(same(back.built.json, doc), 'fuzz round ' + round + ': the collection did not come back identical');
    if (round % 10 === 0) {                      // and one edit through the writer keeps every other value
      const changed = JSON.parse(JSON.stringify(doc));
      changed.variable[1].value = String(round);
      const out = tree.render(text, doc, changed, 'F.postman_collection.json');
      assert.ok(same(parse(out.text), changed), 'fuzz round ' + round + ': the written file does not hold the edit');
      checkedWriter++;
    }
  }
  ok(`fuzz: 250 random collections come back identical; ${checkedWriter} of them also take an edit through the writer`);

  console.log(`\nall ${passed} tree checks passed`);
}

main().catch(error => { console.error('\nTREE TEST FAILED\n' + (error.stack || error)); process.exit(1); });
