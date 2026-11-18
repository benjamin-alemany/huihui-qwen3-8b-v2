import assert from 'node:assert/strict';
import {test} from 'node:test';
import {verifiedReply} from './client.mjs';
import {MAX_OUTPUT, MODEL} from './contract.mjs';
import {stagingRelay} from './relay.mjs';

const origin = 'https://near-staging.unjailed.work';
const env = {NEAR_STAGING_ENABLED: 'true', NEAR_API_KEY: 'fixture-only'};
const dummy = 'Dummy zebra on a bicycle';
const ciphertext = 'ab'.repeat(90);
const answerCiphertext = 'cd'.repeat(90);
const completion = {id: 'chatcmpl-fixture', model: MODEL, choices: [{
  finish_reason: 'stop', message: {role: 'assistant', content: answerCiphertext},
}]};

function fixture({owner = true, response = completion} = {}) {
  const calls = [];
  let used = 0;
  const relay = stagingRelay({
    verifyOwner: async () => owner,
    fetchUpstream: async (url, options) => {
      calls.push({url: String(url), options});
      return Response.json(response);
    },
  });
  return {
    calls,
    relay: request => relay(request, {...env, STAGING_QUOTA: {
      getByName: () => ({take: async () => used < 2 && ++used > 0}),
    }}),
  };
}

function request(messages, headers = {}, model = MODEL) {
  return new Request(origin + '/v1/chat/completions', {method: 'POST', headers: {
    Origin: origin, 'Content-Type': 'application/json', 'X-Workstation-Request': '1',
    'Sec-Fetch-Site': 'same-origin', 'X-Encryption-Version': '3', 'X-Encrypt-All-Fields': 'true',
    'X-Signing-Algo': 'ed25519', 'X-Client-Pub-Key': '01'.repeat(32), 'X-Model-Pub-Key': '02'.repeat(32),
    ...headers,
  }, body: JSON.stringify({model, messages, stream: false, max_tokens: MAX_OUTPUT})});
}

test('both turns preserve ciphertext in every context message and the reply', async () => {
  const {relay, calls} = fixture();
  const first = [{role: 'user', content: ciphertext}];
  const followup = [...first, {role: 'assistant', content: answerCiphertext}, {role: 'user', content: ciphertext}];
  for (const messages of [first, followup]) {
    const input = request(messages);
    const body = await input.clone().text();
    const output = await relay(input);
    assert.equal(output.status, 200);
    assert.equal(await output.text(), JSON.stringify(completion));
    const {url, options} = calls.at(-1);
    assert.equal(url, 'https://cloud-api.near.ai/v1/chat/completions');
    assert.equal(new TextDecoder().decode(options.body), body);
    assert.equal(options.headers.get('Authorization'), 'Bearer fixture-only');
    assert.equal(options.headers.get('x-no-aliasing'), 'true');
    assert.equal(options.redirect, 'manual');
  }
  assert.equal((await relay(request(first))).status, 429);
  assert.equal(calls.length, 2);
});

test('rejects wrong owner, plaintext, wrong model, invalid version and cross-origin submits', async () => {
  const messages = [{role: 'user', content: ciphertext}];
  const unauthorized = fixture({owner: false});
  assert.equal((await unauthorized.relay(request(messages))).status, 403);
  assert.equal(unauthorized.calls.length, 0);
  const {relay, calls} = fixture();
  assert.equal((await relay(request([{role: 'user', content: dummy}]))).status, 400);
  assert.equal((await relay(request(messages, {}, 'another/model'))).status, 400);
  assert.equal((await relay(request(messages, {'X-Encryption-Version': '2'}))).status, 400);
  assert.equal((await relay(request(messages, {Origin: 'https://unjailed.work'}))).status, 403);
  assert.equal(calls.length, 0);
});

test('rejects plaintext reply with an opaque, uncached error', async () => {
  const {relay} = fixture({response: {...completion, choices: [{
    finish_reason: 'stop', message: {role: 'assistant', content: dummy},
  }]}});
  const response = await relay(request([{role: 'user', content: ciphertext}]));
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.doesNotMatch(await response.text(), /zebra/);
});

test('browser requires a unique provider signature before it releases a reply', async () => {
  async function run(receipt) {
    return verifiedReply(origin, [{role: 'user', content: dummy}], options => {
      assert.equal(options.e2ee, true);
      assert.equal(options.attestationCacheTimeToLiveMs, 0);
      assert.equal(options.apiKey, undefined);
      return {
        chat: {completions: {create: async () => ({
          ...completion, choices: [{message: {role: 'assistant', content: dummy}}],
        })}},
        verifyResponse: async () => receipt,
        clearResponseCache() {},
      };
    });
  }
  await assert.rejects(run({signatureKind: 'gateway'}));
  await assert.rejects(run({signatureKind: 'provider_tee', attestations: [{}, {}]}));
  assert.equal(await run({signatureKind: 'provider_tee', attestations: [{}]}), dummy);
});
