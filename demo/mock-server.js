'use strict';
// A pretend bookshop API for the demo collection. Everything in it is made up.
// It listens on this machine only (127.0.0.1), on PORT or 4010.
const http = require('http');

const GENRES = ['cooking', 'history', 'poetry', 'travel'];          // "travel" is the newest genre
const FORMATS = ['ebook', 'hardcover', 'paperback'];
const PICKS = { poetry: ['b-103'], history: ['b-102', 'b-105'] };
const OPEN_ORDERS = [                                               // two books can only be pre-ordered so far
  { id: 7, lines: [{ book: 'b-101', status: 'in stock' }, { book: 'b-104', status: 'preorder' }, { book: 'b-107', status: 'preorder' }] },
  { id: 8, lines: [{ book: 'b-102', status: 'in stock' }] },
  { id: 9, lines: [{ book: 'b-104', status: 'preorder' }] },
];

const routes = {
  '/health': () => ({ ok: true }),
  '/catalogue': () => ({ genres: GENRES, formats: FORMATS }),
  '/picks': () => ({ picks: PICKS }),
  '/orders': url => ({ orders: url.searchParams.get('status') === 'open' ? OPEN_ORDERS : [] }),
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = routes[url.pathname];
  res.writeHead(route ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(route ? route(url) : { error: 'no such page' }));
}).listen(Number(process.env.PORT) || 4010, '127.0.0.1');
