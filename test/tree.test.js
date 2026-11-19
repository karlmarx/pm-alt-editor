'use strict';
// Self-test for the experimental tree mode (pmx-tree.js): the whole collection as files, and back.
// It answers the spike's question: does a collection survive the trip to files and back unchanged, and can
// requests, variables and shared scripts be edited through those files?
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
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
  assert.match(r.out, /has edits that are not packed yet/);
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
  assert.match(pmx(d7, 'help').out, /tree unpack \| pack \| test \| check/);
  assert.strictEqual(pmx(d7, 'tree').code, 0);
  ok('unpack, ls, status and pack work as before next to a tree, and both modes leave an unedited collection byte-identical');

  // 8. fuzz: random collections must come back identical, and the writer must reproduce their bytes
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
