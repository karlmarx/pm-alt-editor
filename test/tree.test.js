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
  fs.appendFileSync(path.join(dir, 'Demo.postman_collection.json'), '\n');
  r = pmx(dir, 'tree', 'pack');
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /was changed by something else since `tree unpack`/);
  fs.writeFileSync(path.join(dir, 'Demo.postman_collection.json'), beforeRefusals);
  editDef(T('collection.js'), d => d.variable.push({ key: 'pending', value: '1' }));
  r = pmx(dir, 'tree', 'unpack', 'Demo.postman_collection.json');
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /has edits that are not in Demo\.postman_collection\.json yet/);
  assert.strictEqual(pmx(dir, 'tree', 'unpack', 'Demo.postman_collection.json', '--force').code, 0);
  ok('refused, with the collection untouched: broken JSON, pointers that leave the tree, a syntax error, a removed test, a file changed underneath, unpacking over unpacked edits');

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
  assert.match(pmx(d7, 'help').out, /tree unpack \| ui \| status \| pack \| test \| finish \| check/);
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
  assert.strictEqual(pmx(d9, 'tree', 'unpack', 'Demo.postman_collection.json').code, 0);
  editDef(T9('collection.js'), d => d.variable.push({ key: 'mine', value: '1' }));                                  // my edit, in the files
  fs.writeFileSync(C9, read(C9).replace('"name": "Ping"', '"name": "Ping (renamed upstream)"'));                    // someone else's, in the JSON
  assert.match(pmx(d9, 'tree', 'status').out, /was changed by something else since it was unpacked; `tree pack` will merge these edits into it/);
  r = pmx(d9, 'tree', 'pack');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /merged into the newer collection file/);
  const merged9 = parse(read(C9));
  assert.strictEqual(merged9.item[0].item[0].name, 'Ping (renamed upstream)');
  assert.ok(merged9.variable.some(v => v.key === 'mine'), 'the edit from the files is missing after the merge');
  const renamed9 = fs.readdirSync(T9('Smoke')).filter(f => f.endsWith('.request.js'));                              // the files were written again, so the request's file follows its new name
  assert.strictEqual(renamed9.length, 1, renamed9.join());
  assert.match(read(T9('Smoke', renamed9[0])), /"name": "Ping \(renamed upstream\)"/, 'the files were not written again from the merged collection');
  r = pmx(d9, 'tree', 'status');
  assert.match(r.out, /M collection\.js/);
  assert.doesNotMatch(r.out, /Ping/);
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
  ok('the collection changed underneath: pack merges the edits from the files into it and refreshes the files; a clash is refused with nothing written');

  // 10. the page's server: only this machine, only with the key; every edit the page can make; newman; nothing outside the tree
  const d10 = scratch(), C10 = path.join(d10, 'Demo.postman_collection.json'), T10 = (...parts) => path.join(d10, '.pmx', 'Demo', 'tree', ...parts);
  makeDemo(d10);
  fs.writeFileSync(path.join(d10, 'pmx.config.json'), JSON.stringify({ collection: 'Demo.postman_collection.json', newman: { timeoutRequest: 10000 } }));
  fs.writeFileSync(path.join(d10, 'local.postman_environment.json'), JSON.stringify({ name: 'local', values: [{ key: 'region', value: 'north', enabled: true }, { key: 'token', value: 'not-shown', type: 'secret', enabled: true }] }));
  const before10 = read(C10);
  const ui = spawn(process.execPath, [PMX, 'tree', 'ui', 'Demo.postman_collection.json', '--no-open'], { cwd: d10, stdio: ['ignore', 'pipe', 'pipe'] });
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
    assert.deepStrictEqual(saved, { syntax: null, tests: 2, testsBefore: 2 });
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
    await post('/api/remove', { id: 'Smoke/Ping.request.js' });
    assert.ok(!fs.existsSync(T10('Smoke', 'Ping.request.js')) && !fs.existsSync(T10('Smoke', 'Ping.test.js')));
    await post('/api/revert', { id: 'Smoke/Ping.request.js' });                                           // "Put back": to where it was, first in its folder
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
    if (process.platform !== 'win32') {                                             // a link inside the tree that leads out of it is never read or written
      fs.writeFileSync(outside, 'var secret = 1;');
      fs.rmSync(T10('Smoke', 'Ping.test.js'));
      fs.symlinkSync(outside, T10('Smoke', 'Ping.test.js'));
      st = await get('/api/state');
      assert.match(st.problems.join('\n'), /Ping\.test\.js leads outside the tree \(a link\?\) - refused/);
      assert.deepStrictEqual(st.root.children[0].children.map(c => c.name), ['Ping', 'Version: 2?'], 'the request with the link is no longer shown');
      await refusedBy('POST', '/api/script', { file: 'Smoke/Ping.test.js', text: 'overwritten' }, /leads outside the tree/);
      await refusedBy('GET', '/api/node?id=' + encodeURIComponent('Smoke/Ping.request.js'), undefined, /leads outside the tree/);
      a = await post('/api/pack');
      assert.match(a.errors.join('\n'), /leads outside the tree \(a link\?\) - refused/);
      assert.strictEqual(read(C10), before10, 'a refused pack wrote to the collection');
      assert.strictEqual(read(outside), 'var secret = 1;');
      fs.rmSync(T10('Smoke', 'Ping.test.js'));
      fs.rmSync(outside);
      await post('/api/revert', { id: 'Smoke/Ping.test.js' });
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
    await post('/api/close');
    const exit = await new Promise(resolve => { if (ui.exitCode != null) resolve(ui.exitCode); else ui.on('exit', resolve); setTimeout(() => resolve('still running'), 5000); });
    assert.strictEqual(exit, 0, 'tree ui did not stop when the page closed it');
  } finally { ui.kill(); api10.kill(); }
  ok('the page\'s server: answers only this machine and only with its key; shows, edits, adds, moves, removes and puts back through its API; diffs; newman with file:line and an environment; never reads or writes outside the tree');

  // 11. fuzz: random collections must come back identical, and the writer must reproduce their bytes
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
