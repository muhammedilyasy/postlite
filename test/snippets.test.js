// Signatures (insert / auto-add per platform or channel) and post templates ("sets"), with isolation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, makeMp4 } from './helpers.js';
import { appendSignature } from '../src/snippets.js';

let app, key, keyB, fb, ig, yt, vid;

before(async () => {
  app = await createTestApp();
  fb = await app.seed('facebook');
  ig = await app.seed('instagram');
  yt = await app.seed('youtube');
  vid = await app.upload(makeMp4(), 'v.mp4');
  key = (await app.core.apiKeys.create({ name: 'snip', scopes: ['read', 'write', 'publish'], approval_mode: false, rate_limit_per_min: 5000 })).key;
  const wsB = await app.root.workspaces.create('B');
  keyB = (await app.root.scope(wsB).apiKeys.create({ name: 'b', scopes: ['read', 'write', 'publish'], approval_mode: false })).key;
});
after(async () => { await app?.close(); });

test('appendSignature adds one blank line and never duplicates', () => {
  assert.equal(appendSignature('Hello  \n', '— team'), 'Hello\n\n— team');
  assert.equal(appendSignature('Hello\n\n— team', '— team'), 'Hello\n\n— team');
  assert.equal(appendSignature('', 'sig'), 'sig');
});

test('signatures: CRUD, validation, insert with signature, auto-add per platform/channel', async () => {
  const a = await app.api('POST', '/signatures', { key, body: { name: 'Sign-off', content: '— The North Star team' } });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json.signature.auto_add, false);
  assert.equal((await app.api('POST', '/signatures', { key, body: { name: 'sign-off', content: 'x' } })).status, 409);
  assert.equal((await app.api('POST', '/signatures', { key, body: { name: 'bad', content: 'x', platforms: ['myspace'] } })).status, 400);
  assert.equal((await app.api('POST', '/signatures', { key, body: { name: 'bad2', content: 'x', account_ids: ['nope'] } })).status, 400);
  await app.api('POST', '/signatures', { key, body: { name: 'IG tags', content: '#shorts #howto', auto_add: true, platforms: ['instagram'] } });
  await app.api('POST', '/signatures', { key, body: { name: 'FB link', content: 'More: example.com', auto_add: true, account_ids: [fb] } });
  const p = await app.api('POST', '/posts', { key, body: { content: 'Hello', signature: 'Sign-off', targets: [{ account_id: fb }], mode: 'draft' } });
  assert.equal(p.json.post.content, 'Hello\n\n— The North Star team');
  const auto = await app.api('POST', '/posts', { key, body: { content: 'Reel time', media_ids: [vid.id], auto_signatures: true, targets: [{ account_id: ig }], mode: 'draft' } });
  assert.equal(auto.json.post.content, 'Reel time\n\n#shorts #howto');
  const both = await app.api('POST', '/posts/validate', { key, body: { content: 'x', auto_signatures: true, targets: [{ account_id: yt, settings: { title: 't' } }] } });
  assert.equal(both.status, 200, both.text); // no auto signature applies to YouTube: fine
  const upd = await app.api('PATCH', '/signatures/IG%20tags', { key, body: { platforms: [], auto_add: false } });
  assert.equal(upd.json.signature.auto_add, false);
  assert.equal((await app.api('DELETE', '/signatures/Sign-off', { key })).status, 200);
  assert.equal((await app.api('GET', '/signatures', { key })).json.signatures.length, 2);
});

test('templates: from a post (no media), explicit, start a post from one, overrides win', async () => {
  const src = await app.api('POST', '/posts', { key, body: { content: 'Weekly explainer', media_ids: [vid.id], tags: ['weekly'], targets: [{ account_id: yt, settings: { title: 'Weekly #1', privacy: 'unlisted', thumbnail: vid.id } }, { account_id: ig }], mode: 'draft' } });
  const t = await app.api('POST', '/templates', { key, body: { name: 'Weekly short', from_post_id: src.json.post.id } });
  assert.equal(t.status, 200, t.text);
  assert.equal(t.json.template.content, 'Weekly explainer');
  assert.deepEqual(t.json.template.targets.map((x) => x.account_id).sort(), [yt, ig].sort());
  const ytT = t.json.template.targets.find((x) => x.account_id === yt);
  assert.equal(ytT.settings.privacy, 'unlisted');
  assert.equal(ytT.settings.thumbnail, undefined, 'media is never stored in templates');
  assert.ok(!JSON.stringify(t.json.template).includes(vid.id));
  assert.deepEqual(t.json.template.tags, ['weekly']);
  const p = await app.api('POST', '/posts', { key, body: { template_id: 'Weekly short', media_ids: [vid.id], mode: 'draft' } });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.post.content, 'Weekly explainer');
  assert.equal(p.json.post.targets.length, 2);
  assert.equal(p.json.post.targets.find((x) => x.integration_id === yt).settings.title, 'Weekly #1');
  assert.deepEqual(p.json.post.tags.map((x) => x.name), ['weekly']);
  const o = await app.api('POST', '/posts', { key, body: { template_id: t.json.template.id, content: 'Override', targets: [{ account_id: fb }], mode: 'draft' } });
  assert.equal(o.json.post.content, 'Override');
  assert.deepEqual(o.json.post.targets.map((x) => x.integration_id), [fb]);
  const e = await app.api('POST', '/templates', { key, body: { name: 'Text only', content: 'Hi', targets: [{ account_id: fb, settings: { post_type: 'post' } }] } });
  assert.equal(e.status, 200, e.text);
  assert.equal((await app.api('POST', '/templates', { key, body: { name: 'bad', targets: [{ account_id: 'nope' }] } })).status, 400);
  assert.equal((await app.api('PATCH', '/templates/Text%20only', { key, body: { name: 'Text post' } })).json.template.name, 'Text post');
  assert.equal((await app.api('GET', '/templates', { key })).json.templates.length, 2);
  assert.equal((await app.api('DELETE', '/templates/Text%20post', { key })).status, 200);
});

test('isolation: signatures and templates never cross workspaces', async () => {
  assert.deepEqual((await app.api('GET', '/signatures', { key: keyB })).json.signatures, []);
  assert.deepEqual((await app.api('GET', '/templates', { key: keyB })).json.templates, []);
  assert.equal((await app.api('GET', '/templates/Weekly%20short', { key: keyB })).status, 404);
  assert.equal((await app.api('PATCH', '/signatures/IG%20tags', { key: keyB, body: { content: 'pwned' } })).status, 404);
  assert.equal((await app.api('POST', '/posts', { key: keyB, body: { template_id: 'Weekly short', mode: 'draft' } })).status, 404);
  assert.equal((await app.api('POST', '/posts', { key: keyB, body: { content: 'x', signature: 'IG tags', targets: [{ account_id: fb }], mode: 'draft' } })).status, 404);
  // Bob cannot template Alice's channels
  assert.equal((await app.api('POST', '/templates', { key: keyB, body: { name: 'steal', targets: [{ account_id: fb }] } })).status, 400);
  assert.equal((await app.api('POST', '/templates', { key: keyB, body: { name: 'steal2', from_post_id: (await app.core.posts.listGroups({}))[0].id } })).status, 404);
});
