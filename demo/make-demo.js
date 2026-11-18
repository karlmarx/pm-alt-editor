'use strict';
// Writes Demo.postman_collection.json: a small collection for a pretend bookshop API (see mock-server.js).
// The file is laid out the way Postman exports one, because that layout is what pmx has to cope with:
// tab-indented JSON, one array element per script line, "\r" at the end of every script line but the last.
// One blank line inside the pasted helper keeps the spaces an editor left on it.
// Three of its four requests fail on purpose, so there is something to fix.
//
//   node demo/make-demo.js [folder]        PORT=4010 by default
const fs = require('fs');
const path = require('path');

const outDir = process.argv[2] || __dirname;
const port = process.env.PORT || 4010;

// ---- scripts -------------------------------------------------------------------------------------------

const everyRequest = `// Runs before every request in the collection.
pm.request.headers.upsert({ key: "X-Demo-Client", value: "pmx-demo" });`;

const pingTest = `pm.test("The API is up", function () {
    pm.response.to.have.status(200);
    pm.expect(pm.response.json().ok).to.be.true;
});`;

// The same helper is pasted into two requests, as happens in real collections.
// "indent" is how far the paste is pushed to the right.
const nameCheck = indent => `// Compare a list of names from the API with the list we expect.
function expectSameNames(what, fromApi, wanted) {
    pm.test("Catalogue lists the right " + what, function () {
        const same = fromApi.length === wanted.length && fromApi.every(function (name, i) {
            return name === wanted[i];
        });
\x20\x20\x20\x20\x20\x20\x20\x20
        pm.expect(same, what + ": API has " + JSON.stringify(fromApi) + ", we expect " + JSON.stringify(wanted)).to.be.true;
    });
}`.split('\n').map(line => (line.trim() ? indent + line : line)).join('\n');

const catalogueTest = `const body = pm.response.json();

pm.test("Catalogue answers with 200", function () {
    pm.response.to.have.status(200);
});

${nameCheck('')}

expectSameNames("genres", body.genres, ["history", "cooking", "poetry"]);
expectSameNames("formats", body.formats, ["hardcover", "paperback", "ebook"]);`;

const picksTest = `const body = pm.response.json();

pm.test("Staff picks answer with 200", function () {
    pm.response.to.have.status(200);
});

if (pm.response.code === 200) {
${nameCheck('    ')}

    expectSameNames("genres with picks", Object.keys(body.picks), ["history", "poetry"]);
}`;

const ordersBefore = `// Ask only for the orders that are still open.
pm.variables.set("orderStatus", "open");`;

const ordersTest = `const orders = pm.response.json().orders;

pm.test("There are open orders to look at", function () {
    pm.expect(orders).to.be.an("array").that.is.not.empty;
});

orders.forEach(function (order) {
    pm.test("Every line of an open order is available", function () {
        const stuck = order.lines.filter(function (line) {
            return line.status !== "in stock";
        }).map(function (line) {
            return line.book;
        });
        pm.expect(stuck.length === 0, "order " + order.id + " is waiting for " + JSON.stringify(stuck)).to.be.true;
    });
});`;

// ---- collection ----------------------------------------------------------------------------------------

const asExported = code => code.split('\n').map((line, i, all) => (i < all.length - 1 ? line + '\r' : line));
const script = (listen, code) => ({ listen, script: { type: 'text/javascript', exec: asExported(code) } });

function request(name, method, url, scripts) {
  const [pathPart, query] = url.split('?');
  const parsed = { raw: '{{baseUrl}}' + url, host: ['{{baseUrl}}'], path: pathPart.split('/').filter(Boolean) };
  if (query) parsed.query = query.split('&').map(pair => ({ key: pair.split('=')[0], value: pair.split('=')[1] }));
  return { name, event: scripts, request: { method, header: [], url: parsed }, response: [] };
}

const collection = {
  info: {
    _postman_id: '11111111-2222-4333-8444-555555555555',
    name: 'Demo',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [
    { name: 'Smoke', item: [request('Ping', 'GET', '/health', [script('test', pingTest)])] },
    {
      name: 'Catalogue',
      item: [
        request('Genres and formats', 'GET', '/catalogue', [script('test', catalogueTest)]),
        { name: 'Staff picks', item: [request('Picks by genre', 'GET', '/picks', [script('test', picksTest)])] },
      ],
    },
    {
      name: 'Orders',
      item: [request('Open orders', 'GET', '/orders?status={{orderStatus}}', [script('prerequest', ordersBefore), script('test', ordersTest)])],
    },
  ],
  event: [script('prerequest', everyRequest), script('test', '')],
  variable: [{ key: 'baseUrl', value: 'http://127.0.0.1:' + port }],
};

fs.writeFileSync(path.join(outDir, 'Demo.postman_collection.json'), JSON.stringify(collection, null, '\t'));
