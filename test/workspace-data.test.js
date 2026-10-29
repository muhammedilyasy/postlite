// Settings: time format, and "Delete my workspace data" — wipes one workspace completely and nothing else.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestApp, makeJpeg } from './helpers.js';
import { WIPE_TABLES } from '../src/wipe.js';

let app, A, B, keyA, keyB, keyApproval;

async function seed(sc, label) {
  const acc = await sc.integrations.upsert('facebook', { external_id: `page-${label}`, name: `${label} Page`, access_token: 't', refresh_token: 'r' });
  const m = await sc.media.save(new Uint8Array(makeJpeg(1080, 1080)), `${label}.jpg`);
  const g = await sc.posts.saveGroup({ content: `${label} post`, media: [m.id], action: 'schedule', publish_at: Date.now() + 86400000, posts: [{ integration_id: acc }] });
  await sc.webhooks.create({ url: `http://127.0.0.1:9/${label}`, events: ['*'] });
  await sc.brands.create({ name: `${label} brand`, account_ids: [acc] });
  await sc.settings.update({ timezone: 'Europe/Berlin', time_format: '12h' });
  await sc.db.run("INSERT INTO account_metrics(integration_id, metric, day, value, fetched_at) VALUES(?, 'followers', '2026-10-01', 5, 1) /* ws:checked */", acc);
  return { acc, m, g };
}

before(async () => {
  app = await createTestApp();
  const wsB = await app.root.workspaces.create('Bob space');
  A = { sc: app.core, ...(await seed(app.core, 'alice')) };
  B = { sc: app.root.scope(wsB), ...(await seed(app.root.scope(wsB), 'bob')) };
  keyA = (await A.sc.apiKeys.create({ name: 'a-admin', scopes: ['read', 'write', 'publish', 'analytics', 'admin'], approval_mode: false })).key;
  keyApproval = (await A.sc.apiKeys.create({ name: 'a-approval', scopes: ['read', 'write', 'publish', 'analytics', 'admin'] })).key;
  keyB = (await B.sc.apiKeys.create({ name: 'b-admin', scopes: ['read', 'write', 'publish', 'analytics', 'admin'], approval_mode: false })).key;
});
after(async () => { await app?.close(); });

test('time_format: 24h by default, 12h saved per workspace, validated', async () => {
  const fresh = app.root.scope(await app.root.workspaces.create('fresh'));
  assert.equal((await fresh.settings.get()).time_format, '24h');
  assert.equal((await app.api('GET', '/settings', { key: keyA })).json.settings.time_format, '12h');
  const bad = await app.api('PATCH', '/settings', { key: keyA, body: { time_format: '13h' } });
  assert.equal(bad.status, 400);
  const ok = await app.api('PATCH', '/settings', { key: keyA, body: { time_format: '24h' } });
  assert.equal(ok.json.settings.time_format, '24h');
  assert.equal((await B.sc.settings.get()).time_format, '12h'); // Bob's own setting is untouched
});

test('every table with a workspace_id column is wiped by delete_workspace_data', async () => {
  const tables = (await app.root.db.all("SELECT name FROM sqlite_master WHERE type='table'")).map((r) => r.name);
  const withWs = [];
  for (const t of tables) if ((await app.root.db.all(`PRAGMA table_info(${t})`)).some((c) => c.name === 'workspace_id') && !['users'].includes(t)) withWs.push(t);
  for (const t of withWs) assert.ok(WIPE_TABLES.includes(t), `${t} has workspace_id but is not in WIPE_TABLES`);
});

test('delete_workspace_data needs the exact confirmation, refuses approval keys, wipes only this workspace', async () => {
  const sum = await app.api('GET', '/workspace/data', { key: keyA });
  assert.equal(sum.status, 200, sum.text);
  assert.equal(sum.json.counts.integrations, 1);
  const expected = sum.json.confirm_with;
  assert.equal(expected, (await app.root.workspaces.get('owner')).name);
  assert.equal((await app.api('POST', '/workspace/delete-data', { key: keyApproval, body: { confirm: expected } })).status, 403);
  const wrong = await app.api('POST', '/workspace/delete-data', { key: keyA, body: { confirm: 'nope' } });
  assert.equal(wrong.status, 400);
  assert.equal((await A.sc.integrations.list()).length, 1);

  const aFile = path.join(app.cfg.uploadDir, A.m.filename);
  const bFile = path.join(app.cfg.uploadDir, B.m.filename);
  assert.ok(fs.existsSync(aFile) && fs.existsSync(bFile));
  const r = await app.api('POST', '/workspace/delete-data', { key: keyA, body: { confirm: expected.toUpperCase() } });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.files_deleted >= 1);
  // Alice: empty (the calling key is gone too)
  assert.equal((await A.sc.integrations.list()).length, 0);
  assert.equal((await A.sc.posts.listGroups({})).length, 0);
  assert.equal((await A.sc.media.rows(100)).length, 0);
  assert.equal((await A.sc.brands.list()).length, 0);
  assert.equal((await A.sc.webhooks.list()).length, 0);
  assert.equal((await A.sc.settings.get()).timezone, app.cfg.defaultTimezone);
  assert.equal((await app.root.db.get("SELECT COUNT(*) AS n FROM account_metrics WHERE integration_id = ? /* ws:system */", A.acc)).n, 0);
  assert.equal((await app.root.db.get("SELECT COUNT(*) AS n FROM jobs j JOIN posts p ON p.id = j.post_id WHERE p.workspace_id = 'owner'")).n, 0);
  assert.equal((await app.api('GET', '/accounts', { key: keyA })).status, 401);
  assert.ok(!fs.existsSync(aFile));
  assert.ok(await app.root.workspaces.get('owner'), 'the workspace row (sign-in binding) stays');
  // Bob: untouched
  assert.equal((await B.sc.integrations.list()).length, 1);
  assert.equal((await B.sc.posts.listGroups({})).length, 1);
  assert.equal((await B.sc.media.rows(100)).length, 1);
  assert.equal((await B.sc.brands.list()).length, 1);
  assert.equal((await B.sc.webhooks.list()).length, 1);
  assert.equal((await B.sc.settings.get()).timezone, 'Europe/Berlin');
  assert.ok(fs.existsSync(bFile));
  assert.equal((await app.api('GET', '/accounts', { key: keyB })).json.accounts.length, 1);
  assert.equal((await app.root.db.get('SELECT COUNT(*) AS n FROM jobs j JOIN posts p ON p.id = j.post_id WHERE p.workspace_id = ?', B.sc.workspaceId)).n, 1);
  // the wipe itself is the only audit entry left
  const audit = await app.root.db.all("SELECT operation FROM audit_log WHERE workspace_id = 'owner'");
  assert.deepEqual(audit.map((x) => x.operation), ['delete_workspace_data']);
});
