// Data migration from the single shared workspace: attribution from evidence + apply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, MIGRATIONS_DIR } from '../src/node/db.js';
import { runAttribution } from '../src/node/attribute.js';

const OWNER = 'owner@example.com';
const FRIEND = 'Friend@Example.com';

function v5db() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pl-attr-'));
  const mig = path.join(dir, 'mig');
  fs.mkdirSync(mig);
  for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f < '0006')) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(mig, f));
  const file = path.join(dir, 'db.sqlite');
  const db = openDb(file, { migrationsDir: mig });
  const raw = db.raw;
  const now = Date.now();
  const ins = (sql, ...p) => raw.prepare(sql).run(...p);
  // friend connected two accounts (one via oauth_connected, one via picker); one account has no evidence
  for (const [id, prov] of [['i-f1', 'youtube'], ['i-f2', 'facebook'], ['i-x', 'instagram']]) ins("INSERT INTO integrations(id, provider, external_id, name, status, meta, created_at, updated_at) VALUES(?,?,?,?, 'active', '{}', ?, ?)", id, prov, `ext-${id}`, `Acc ${id}`, now, now);
  ins("INSERT INTO audit_log(at, actor_type, actor_id, actor_name, via, operation, status, detail) VALUES(?, 'session', 'friend@example.com', 'friend@example.com', 'ui', 'oauth_connected', 200, ?)", now, JSON.stringify([{ id: 'i-f1', name: 'x' }]));
  ins("INSERT INTO audit_log(at, actor_type, actor_id, actor_name, via, operation, status, detail) VALUES(?, 'session', 'friend@example.com', 'friend@example.com', 'ui', 'select_accounts', 200, ?)", now, JSON.stringify({ connected: [{ id: 'i-f2', name: 'y' }] }));
  // keys: friend's agent key (session), owner's key from password mode
  ins("INSERT INTO api_keys(id, name, prefix, hash, scopes, created_at) VALUES('k-f', 'Agent', 'aaaaaaaa', 'h', '[]', ?)", now);
  ins("INSERT INTO api_keys(id, name, prefix, hash, scopes, created_at) VALUES('k-o', 'Mine', 'bbbbbbbb', 'h', '[]', ?)", now - 100000);
  ins("INSERT INTO audit_log(at, actor_type, actor_id, actor_name, via, operation, status, detail) VALUES(?, 'session', 'friend@example.com', 'friend@example.com', 'ui', 'create_api_key', 200, ?)", now + 1, JSON.stringify({ name: 'Agent' }));
  ins("INSERT INTO audit_log(at, actor_type, actor_id, actor_name, via, operation, status, detail) VALUES(?, 'session', 'admin', 'admin (web UI)', 'ui', 'create_api_key', 200, ?)", now - 99999, JSON.stringify({ name: 'Mine' }));
  // media uploaded by the friend's key; one orphan image
  ins("INSERT INTO media(id, token, filename, mime, kind, size, created_at) VALUES('m-f', 't1', 'm-f.mp4', 'video/mp4', 'video', 1, ?)", now);
  ins("INSERT INTO media(id, token, filename, mime, kind, size, created_at) VALUES('m-x', 't2', 'm-x.jpg', 'image/jpeg', 'image', 1, ?)", now);
  ins("INSERT INTO audit_log(at, actor_type, actor_id, actor_name, via, operation, target, status) VALUES(?, 'api_key', 'k-f', 'Agent', 'mcp-http', 'complete_upload', 'm-f', 200)", now);
  // posts: g1 → friend's account; g2 → split across friend's and the unattributed account; g3 no posts, created by owner
  ins("INSERT INTO groups(id, content, media, created_by, created_at, updated_at) VALUES('g1', 'one', '[\"m-f\"]', 'Agent', ?, ?)", now, now);
  ins("INSERT INTO groups(id, content, media, created_by, created_at, updated_at) VALUES('g2', 'two', '[]', 'Agent', ?, ?)", now, now);
  ins("INSERT INTO groups(id, content, media, created_by, created_at, updated_at) VALUES('g3', 'three', '[]', 'admin (web UI)', ?, ?)", now, now);
  ins("INSERT INTO posts(id, group_id, integration_id, settings, status, created_at, updated_at) VALUES('p1', 'g1', 'i-f1', '{}', 'scheduled', ?, ?)", now, now);
  ins("INSERT INTO posts(id, group_id, integration_id, settings, status, created_at, updated_at) VALUES('p2', 'g2', 'i-f2', '{}', 'draft', ?, ?)", now, now);
  ins("INSERT INTO posts(id, group_id, integration_id, settings, status, created_at, updated_at) VALUES('p3', 'g2', 'i-x', '{}', 'draft', ?, ?)", now, now);
  ins("INSERT INTO remote_posts(integration_id, external_id, updated_at) VALUES('i-f1', 'v1', ?)", now);
  ins("INSERT INTO sessions(id_hash, csrf, created_at, expires_at, email) VALUES('s', 'c', ?, ?, 'friend@example.com')", now, now + 1000);
  ins("INSERT INTO settings(key, value) VALUES('platform_app.google', ?)", JSON.stringify({ id: 'cid.apps.googleusercontent.com', secret_enc: 'v1:x', updated_at: now }));
  ins("INSERT INTO settings(key, value) VALUES('timezone', 'Asia/Kolkata')");
  db.close();
  return { dir, file };
}

test('attribution: dry run is read-only and reports owners + unattributable rows', async () => {
  const { dir, file } = v5db();
  const before = fs.readFileSync(file);
  const { res, text } = await runAttribution({ dbFile: file, owner: OWNER });
  assert.ok(fs.readFileSync(file).equals(before), 'dry run did not touch the file');
  const f = 'friend@example.com';
  assert.equal(res.counts[f].integrations, 2);
  assert.equal(res.counts[OWNER].integrations, 1);
  assert.equal(res.counts[f].api_keys, 1);
  assert.equal(res.counts[OWNER].api_keys, 1);
  assert.equal(res.counts[f].media, 1);
  assert.equal(res.assignment.posts.get('p3'), OWNER, 'posts follow their account');
  assert.deepEqual(res.splits.map((s) => s.group), ['g2']);
  assert.deepEqual(res.unattributable.map((u) => `${u.table}:${u.id}`).sort(), ['integrations:i-x', 'media:m-x'].sort());
  assert.match(text, /UNATTRIBUTABLE → owner@example.com \(2\)/);
  assert.match(text, /DRY RUN/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('attribution: apply moves rows into per-person workspaces, splits mixed posts, copies apps, is idempotent', async () => {
  const { dir, file } = v5db();
  const { out } = await runAttribution({ dbFile: file, owner: OWNER, apply: true });
  const f = 'friend@example.com';
  const db = openDb(file);
  const q = (sql, ...p) => db.raw.prepare(sql).all(...p);
  const fws = out.wsOf[f];
  assert.equal(out.wsOf[OWNER], 'owner');
  assert.ok(fws && fws !== 'owner');
  assert.deepEqual(q('SELECT id FROM integrations WHERE workspace_id = ? ORDER BY id', fws).map((r) => r.id), ['i-f1', 'i-f2']);
  assert.deepEqual(q("SELECT id FROM integrations WHERE workspace_id = 'owner'").map((r) => r.id), ['i-x']);
  assert.equal(q('SELECT workspace_id FROM api_keys WHERE id = ?', 'k-f')[0].workspace_id, fws);
  assert.equal(q('SELECT workspace_id FROM media WHERE id = ?', 'm-f')[0].workspace_id, fws);
  assert.equal(q('SELECT workspace_id FROM remote_posts')[0].workspace_id, fws);
  // g2 split: p2 (friend) and p3 (owner) end up in groups of their own workspace
  const p2 = q('SELECT p.workspace_id, g.workspace_id AS gws FROM posts p JOIN groups g ON g.id = p.group_id WHERE p.id = ?', 'p2')[0];
  const p3 = q('SELECT p.workspace_id, g.workspace_id AS gws FROM posts p JOIN groups g ON g.id = p.group_id WHERE p.id = ?', 'p3')[0];
  assert.equal(p2.workspace_id, p2.gws);
  assert.equal(p3.workspace_id, p3.gws);
  assert.notEqual(p2.workspace_id, p3.workspace_id);
  // platform apps + timezone in both workspaces
  for (const ws of ['owner', fws]) {
    assert.equal(q("SELECT COUNT(*) n FROM workspace_settings WHERE workspace_id = ? AND key = 'platform_app.google'", ws)[0].n, 1);
    assert.equal(q("SELECT value FROM workspace_settings WHERE workspace_id = ? AND key = 'timezone'", ws)[0].value, 'Asia/Kolkata');
  }
  assert.deepEqual(q('SELECT email, workspace_id FROM users ORDER BY email').map((r) => `${r.email}:${r.workspace_id === 'owner' ? 'owner' : 'friend'}`), [`${f}:friend`, `${OWNER}:owner`]);
  db.close();
  // second run changes nothing
  const again = await runAttribution({ dbFile: file, owner: OWNER, apply: true });
  assert.equal(Object.values(again.out.moved).reduce((a, b) => a + b, 0), 0);
  assert.equal(again.out.wsOf[f], fws);
  fs.rmSync(dir, { recursive: true, force: true });
});
