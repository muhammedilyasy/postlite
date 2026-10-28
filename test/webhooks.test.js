import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTestApp, makeJpeg, waitFor } from './helpers.js';
import { sign, verifySignature } from '../src/webhooks.js';

let app, receiver, received, failFirst;
before(async () => {
  app = await createTestApp();
  received = [];
  failFirst = 0;
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (failFirst > 0) { failFirst--; res.writeHead(500); return res.end(); }
      received.push({ headers: req.headers, body });
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
});
after(async () => { receiver.close(); await app.close(); });

test('signature helper', () => {
  const t = Math.floor(Date.now() / 1000);
  const body = '{"a":1}';
  const header = `t=${t},v1=${sign('whsec_x', t, body)}`;
  assert.ok(verifySignature('whsec_x', header, body));
  assert.ok(!verifySignature('whsec_y', header, body));
  assert.ok(!verifySignature('whsec_x', header, '{"a":2}'));
  assert.ok(!verifySignature('whsec_x', `t=${t - 1000},v1=${sign('whsec_x', t - 1000, body)}`, body), 'old timestamps rejected');
});

test('post.published / post.failed / account.needs_reconnect are delivered signed; failures retried', async () => {
  const url = `http://127.0.0.1:${receiver.address().port}/hook`;
  const s = await app.login();
  const w = await app.api('POST', '/webhooks', { session: s, body: { url, events: ['post.published', 'post.failed', 'account.needs_reconnect'] } });
  assert.equal(w.status, 200, w.text);
  const secret = w.json.webhook.secret;
  assert.match(secret, /^whsec_/);
  assert.ok(!JSON.stringify(app.core.webhooks.list()).includes(secret), 'secret not listed again');
  app.core.webhooks.start(20);

  const fb = app.seed('facebook');
  failFirst = 1; // first delivery attempt gets HTTP 500 → retried
  app.core.posts.saveGroup({ content: 'hooked', media: [], action: 'now', posts: [{ integration_id: fb, settings: {} }] });
  await app.core.scheduler.drain();
  const pub = await waitFor(() => received.find((r) => r.headers['x-postlite-event'] === 'post.published'));
  assert.ok(verifySignature(secret, pub.headers['x-postlite-signature'], pub.body));
  const payload = JSON.parse(pub.body);
  assert.equal(payload.event, 'post.published');
  assert.equal(payload.data.provider, 'facebook');
  assert.match(payload.data.published_url, /facebook\.com/);
  const del = app.core.webhooks.deliveries(w.json.webhook.id).find((d) => d.event === 'post.published');
  assert.equal(del.state, 'delivered');
  assert.equal(del.attempts, 2);

  app.fake.state.revoked.add('page1-token');
  app.core.posts.saveGroup({ content: 'will fail', media: [], action: 'now', posts: [{ integration_id: fb, settings: {} }] });
  await app.core.scheduler.drain();
  app.fake.state.revoked.delete('page1-token');
  await waitFor(() => received.find((r) => r.headers['x-postlite-event'] === 'post.failed'));
  const rec = await waitFor(() => received.find((r) => r.headers['x-postlite-event'] === 'account.needs_reconnect'));
  assert.equal(JSON.parse(rec.body).data.provider, 'facebook');
});

test('webhook management via API: test ping, rotate secret, permanent failure after max attempts', async () => {
  const s = await app.login();
  const w = (await app.api('POST', '/webhooks', { session: s, body: { url: `http://127.0.0.1:${receiver.address().port}/x`, events: ['*'] } })).json.webhook;
  const ping = await app.api('POST', `/webhooks/${w.id}/test`, { session: s, body: {} });
  assert.equal(ping.json.deliveries[0].state, 'delivered');
  const rot = await app.api('POST', `/webhooks/${w.id}/rotate-secret`, { session: s, body: {} });
  assert.notEqual(rot.json.secret, w.secret);
  const dead = (await app.api('POST', '/webhooks', { session: s, body: { url: 'http://127.0.0.1:1/nothing', events: ['analytics.synced'] } })).json.webhook;
  app.core.webhooks.emit('analytics.synced', { test: true });
  await waitFor(async () => {
    await app.core.webhooks.deliverDue();
    const d = app.core.webhooks.deliveries(dead.id)[0];
    return d?.state === 'failed' ? d : null;
  }, { timeout: 15000 });
  const bad = await app.api('POST', '/webhooks', { session: s, body: { url: 'http://x', events: ['post.exploded'] } });
  assert.equal(bad.status, 400);
});
