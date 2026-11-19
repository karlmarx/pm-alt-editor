'use strict';
// Optional check of the page of `pmx tree ui` in a real browser. It is not part of `npm test`, because it needs
// Playwright (npm i -D playwright), which the tool itself does not. Without Playwright it says so and stops.
//   node test/tree-ui.browser.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.log('skipped: Playwright is not installed (npm i -D playwright)'); process.exit(0); }

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmx-tree-ui-'));
const PORT = String(5100 + Math.floor(Math.random() * 800));
const env = Object.assign({}, process.env, { PORT });
const T = (...parts) => path.join(dir, '.pmx', 'Demo', 'tree', ...parts);
const read = file => fs.readFileSync(file, 'utf8');
const def = (...parts) => { const text = read(T(...parts)); return JSON.parse(text.slice(text.indexOf('module.exports = ') + 17, text.lastIndexOf(';'))); };
const row = name => `#tree .row:has(.name:text-is("${name}"))`;
let passed = 0;
const ok = name => console.log(`  ok ${++passed}  ${name}`);

async function main() {
  spawnSync(process.execPath, [path.join(ROOT, 'demo', 'make-demo.js'), dir], { env });
  fs.writeFileSync(path.join(dir, 'pmx.config.json'), JSON.stringify({ collection: 'Demo.postman_collection.json', newman: { timeoutRequest: 10000 } }));
  const before = read(path.join(dir, 'Demo.postman_collection.json'));
  const mock = spawn(process.execPath, [path.join(ROOT, 'demo', 'mock-server.js')], { env, stdio: 'ignore' });
  const ui = spawn(process.execPath, [path.join(ROOT, 'pmx.js'), 'tree', 'ui', 'Demo.postman_collection.json', '--no-open'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    let printed = '';
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('tree ui printed no link:\n' + printed)), 15000);
      const seen = chunk => { printed += chunk; const m = /http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]{32}/.exec(printed); if (m) { clearTimeout(timer); resolve(m[0]); } };
      ui.stdout.on('data', seen); ui.stderr.on('data', seen);
    });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const problems = [];
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`); });
    page.on('pageerror', e => problems.push('[error] ' + e.message));
    page.on('request', r => { if (!r.url().startsWith(url.split('/?')[0])) problems.push('[request to elsewhere] ' + r.url()); });
    page.on('dialog', d => { problems.push('[dialog] ' + d.message()); d.dismiss(); });
    const settled = async () => { await page.waitForFunction(() => document.getElementById('saved').textContent.startsWith('Every edit') && document.getElementById('pillPack').textContent !== '…'); await page.waitForTimeout(200); };
    const selection = () => page.evaluate(() => { const t = document.activeElement; return t && t.tagName === 'TEXTAREA' ? t.value.slice(t.selectionStart, t.selectionEnd) : null; });
    await page.goto(url);
    await page.waitForSelector(row('Open orders'));
    await settled();
    assert.deepStrictEqual(await page.locator('#tree .row .name').allInnerTexts(), ['Demo', 'Smoke', 'Ping', 'Catalogue', 'Genres and formats', 'Staff picks', 'Picks by genre', 'Orders', 'Open orders']);
    assert.strictEqual(await page.locator('#pillChanges').innerText(), 'no changes');
    ok('the page loads and shows the collection as folders and requests');

    // run newman; a failing test leads to its line in its script
    await page.click('#btnRun');
    await page.waitForSelector('main .banner.bad', { timeout: 60000 });
    assert.match(await page.locator('main .banner.bad').innerText(), /FAIL . 5 of 10 assertions failed/);
    assert.deepStrictEqual(await page.locator(row('Open orders') + ' .res').allInnerTexts(), ['✗2']);
    await page.click('main .card:has(h2:text-is("Orders / Open orders")) button.link >> nth=0');
    await page.waitForSelector('#tabbody .editor');
    assert.strictEqual(await selection(), '    pm.test("Every line of an open order is available", function () {');
    ok('Run tests shows the 5 failures, marks them in the tree, and a failure opens its script at its line');

    // edit a script: saved to its file, checked as you type
    const tests = page.locator('#tabbody textarea.code').nth(1);
    await tests.fill((await tests.inputValue()).replace('return line.status !== "in stock";', 'return line.status !== "in stock" && line.status !== "preorder";'));
    await settled();
    assert.match(read(T('Orders', 'Open_orders.test.js')), /line\.status !== "preorder"/);
    assert.match(await page.locator('#tabbody .card >> nth=1').locator('.hint').innerText(), /^Parses\. 2 pm\.test calls\.$/);
    await tests.focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('if (true) {');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('var broken = ;');
    await settled();
    assert.match(await page.locator('#tabbody .hint.bad').innerText(), /Syntax error: .*Open_orders\.test\.js:18/);
    assert.match(await page.locator('#pillPack').innerText(), /cannot pack: 1 problem/);
    assert.deepStrictEqual(read(T('Orders', 'Open_orders.test.js')).split('\n').slice(-2), ['if (true) {', '    var broken = ;'], 'Enter and Tab do not indent');
    await tests.fill((await tests.inputValue()).replace('\nif (true) {\n    var broken = ;', ''));
    await settled();
    ok('a script is edited in place: written to its file, parsed while typing, Tab and Enter indent');

    // the request form keeps the URL text and its parts in step, and adds keys where Postman puts them
    await page.click('#tabs button:has-text("Request")');
    await page.click('button:has-text("+ Add header")');
    const header = page.locator('.card:has(h3:text-is("Headers")) input.mono');
    await header.nth(0).fill('X-Trace');
    await header.nth(1).fill('demo');
    await page.click('button:has-text("+ Add query parameter")');
    const query = page.locator('.card:has(h3:text-is("Query parameters")) table input.mono');
    await query.nth(2).fill('limit');
    await query.nth(3).fill('5');
    assert.strictEqual(await page.locator('input[aria-label="URL"]').inputValue(), '{{baseUrl}}/orders?status={{orderStatus}}&limit=5');
    await page.locator('input[aria-label="URL"]').fill('https://shop.example:8443/v2/orders?status={{orderStatus}}&sort=id#top');
    assert.deepStrictEqual(await query.evaluateAll(els => els.map(e => e.value)), ['status', '{{orderStatus}}', 'sort', 'id']);
    await page.selectOption('select[aria-label="Method"]', 'POST');
    await page.selectOption('select[aria-label="Kind of body"]', 'raw');
    await page.locator('textarea[aria-label="Body"]').fill('{"a":1}');
    await page.click('button:has-text("Tidy JSON")');
    await page.selectOption('select[aria-label="Kind of auth"]', 'bearer');
    await page.locator('.card:has(h3:text-is("Auth")) input.mono').fill('{{token}}');
    await settled();
    const orders = def('Orders', 'Open_orders.request.js').request;
    assert.deepStrictEqual(orders, { auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] }, method: 'POST', header: [{ key: 'X-Trace', value: 'demo', type: 'text' }], body: { mode: 'raw', raw: '{\n  "a": 1\n}' },
      url: { raw: 'https://shop.example:8443/v2/orders?status={{orderStatus}}&sort=id#top', protocol: 'https', host: ['shop', 'example'], port: '8443', path: ['v2', 'orders'], query: [{ key: 'status', value: '{{orderStatus}}' }, { key: 'sort', value: 'id' }], hash: 'top' } });
    assert.deepStrictEqual([Object.keys(orders), Object.keys(orders.url)], [['auth', 'method', 'header', 'body', 'url'], ['raw', 'protocol', 'host', 'port', 'path', 'query', 'hash']]);
    await page.click('#nodehead button:has-text("Revert")');
    await settled();
    assert.strictEqual(await page.locator('#pillChanges').innerText(), 'no changes');
    await page.click('#tabs button:has-text("Scripts")');
    await tests.fill((await tests.inputValue()).replace('return line.status !== "in stock";', 'return line.status !== "in stock" && line.status !== "preorder";'));
    await settled();
    ok('the request form: headers, query and URL stay in step, body and auth are written in Postman\'s shape and key order, Revert undoes it all');

    // the Raw tab: text is written on Apply, and also when you leave the tab; text that is not valid JSON keeps you there
    await page.click(row('Ping'));
    await page.click('#tabs button:has-text("Raw")');
    const raw = page.locator('#tabbody textarea.code');
    const rawText = await raw.inputValue();
    await raw.fill(rawText.replace('"name": "Ping"', '"name": "Ping the API"'));
    assert.strictEqual(await page.locator('#saved').innerText(), 'Raw: not applied yet.');
    await page.click('#tabs button:has-text("Request")');
    await page.waitForSelector(row('Ping the API'));
    assert.strictEqual(def('Smoke', 'Ping.request.js').name, 'Ping the API', 'leaving the Raw tab dropped what was typed');
    await page.click('#tabs button:has-text("Raw")');
    await raw.fill('{ "name": ');
    await page.click(row('Open orders'));
    await page.waitForSelector('.note.bad');
    assert.match(await page.locator('.note.bad').innerText(), /not valid JSON/);
    assert.strictEqual(await page.locator('#tabs button[aria-selected="true"]').innerText(), 'Raw', 'text that could not be written was left behind');
    assert.strictEqual(await raw.inputValue(), '{ "name": ');
    await page.click('.note.bad .x');
    await raw.fill(rawText);
    await page.click('#tabbody button:has-text("Apply")');
    await page.waitForSelector(row('Ping'));
    await settled();
    assert.strictEqual(await page.locator('#pillChanges').innerText(), '1 changed');
    problems.length = 0;                             // the refused write above is reported by the browser as a failed request; that one is expected
    ok('the Raw tab writes on Apply and on leaving; text that is not valid JSON is not lost and not written');

    // names and values from the collection are shown as text, never run as HTML
    const nasty = '<img src=x onerror="document.title=\'run\'"><script>document.title="run"</script>';
    await page.click(row('Smoke'));
    await page.click('#treebar button:has-text("+ Request")');
    await page.fill('#treebar input[type=text]', nasty);
    await page.click('#treebar button:has-text("Add")');
    await page.waitForSelector('#tabbody input');
    await page.locator('input[aria-label="URL"]').fill('{{baseUrl}}/health?x=' + nasty);
    await settled();
    await page.click('#tabs button:has-text("Changes")');
    await page.waitForSelector('#tabbody table.diff');
    await page.click('#btnChanges');
    await page.waitForSelector('main table.diff');
    await page.click('#btnPreview');
    await page.waitForSelector('main table.diff');
    await page.fill('#filter', 'onerror');
    await page.press('#filter', 'Enter');
    await page.waitForSelector('main .hit');
    assert.deepStrictEqual([await page.title(), await page.locator('main img, #tree img, main script, #tree script').count()], ['pmx tree', 0], 'text from the collection became HTML');
    assert.strictEqual(await page.locator('#tree .row .name').nth(3).innerText(), nasty);
    await page.locator('#tree .row').nth(3).click();
    await page.waitForSelector('#nodehead button:has-text("Remove")');
    await page.click('#nodehead button:has-text("Remove")');
    await page.click('#nodehead button:has-text("Really remove?")');
    await settled();
    ok('a name or URL full of HTML is shown as text in the tree, the forms, the diffs and the search');

    // variables, new requests, order, put back
    await page.click(row('Demo'));
    await page.click('button:has-text("+ Add variable")');
    const variable = page.locator('.card:has(h3:text-is("Collection variables")) table input.mono');
    await variable.nth(2).fill('pageSize');
    await variable.nth(3).fill('5');
    await settled();
    await page.waitForSelector('.card:has(h3:text-is("Variables in use")) code:text-is("pageSize")');
    await page.click(row('Smoke'));
    await page.click('#treebar button:has-text("+ Request")');
    await page.fill('#treebar input[type=text]', 'Version');
    await page.press('#treebar input[type=text]', 'Enter');
    await page.waitForSelector(row('Version'));
    await page.locator('input[aria-label="URL"]').fill('{{baseUrl}}/health');
    await page.click('#tabs button:has-text("Scripts")');
    await page.click('button:has-text("+ Add tests")');
    await page.locator('#tabbody textarea.code').fill('pm.test("Version answers", function () {\n    pm.response.to.have.status(200);\n});');
    await settled();
    await page.click('#nodehead button[aria-label="Move up"]');
    await settled();
    await page.click(row('Picks by genre'));
    await page.click('#nodehead button:has-text("Remove")');
    await page.click('#nodehead button:has-text("Really remove?")');
    await page.waitForSelector('#tree button:has-text("Put back")');
    await page.click('#tree button:has-text("Put back")');
    await page.waitForSelector(row('Picks by genre') + '.sel');
    await settled();
    assert.deepStrictEqual(await page.locator('#tree .row .name').allInnerTexts(), ['Demo', 'Smoke', 'Version', 'Ping', 'Catalogue', 'Genres and formats', 'Staff picks', 'Picks by genre', 'Orders', 'Open orders']);
    assert.strictEqual(await page.locator('#pillChanges').innerText(), '4 changed');
    ok('a variable and a request are added, a request is moved, removed and put back');

    // the diffs, then pack: the collection JSON gets the edits and nothing else moves
    await page.click(row('Open orders'));
    await page.click('#tabs button:has-text("Changes")');
    await page.waitForSelector('#tabbody table.diff.unified tr.add');
    await page.click('#tabbody button:has-text("Side by side")');
    await page.waitForSelector('#tabbody table.diff.split td.add');
    assert.strictEqual(await page.locator('#tabbody table.diff td.add .chg').innerText(), ' && line.status !== "preorder"');
    await page.click('#btnChanges');
    await page.waitForSelector('main .card');
    assert.deepStrictEqual(await page.locator('main .card h2').allInnerTexts(), ['Demo', 'Smoke', 'Smoke / Version', 'Orders / Open orders']);
    await page.click('#btnPreview');
    await page.waitForSelector('main table.diff');
    assert.strictEqual(read(path.join(dir, 'Demo.postman_collection.json')), before, 'the collection file changed before Pack');
    await page.click('main button.primary:has-text("Pack")');
    await page.waitForSelector('.note.good:has-text("Packed into")');
    assert.match(await page.locator('.note.good:has-text("Packed into")').innerText(), /Packed into Demo\.postman_collection\.json: \+\d+ .\d+ lines \(layout kept\)/);
    await settled();
    assert.strictEqual(await page.locator('#pillPack').innerText(), 'packed: the JSON holds every edit');
    const packed = JSON.parse(read(path.join(dir, 'Demo.postman_collection.json')));
    assert.deepStrictEqual([packed.variable.map(v => v.key), packed.item[0].item.map(i => i.name)], [['baseUrl', 'pageSize'], ['Version', 'Ping']]);
    await page.click('#btnRun');
    await page.waitForFunction(() => /Results: 3 of 11 fail/.test(document.getElementById('btnResults').textContent), null, { timeout: 60000 });
    ok('diffs per request and for everything, unified and side by side; Pack writes the collection JSON; the next run has 3 of 11 failing');

    assert.deepStrictEqual(problems, [], 'the browser reported problems');
    ok('no console errors, no dialogs, and no request to anything but pmx on this machine');
    console.log(`\nall ${passed} browser checks passed`);
  } finally {
    if (browser) await browser.close();
    ui.kill(); mock.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error('\nBROWSER CHECK FAILED\n' + (error.stack || error)); process.exit(1); });
