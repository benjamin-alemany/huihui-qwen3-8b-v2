import { authenticate } from '../workstation/auth.mjs';
import { mutationAllowed } from '../workstation/policy.mjs';
import { encryptedReply, encryptedRequest, isKey, MODEL, MODEL_PATH, signaturePath } from './contract.mjs';

const UPSTREAM = 'https://cloud-api.near.ai';
const STAGING_ORIGIN = 'https://near-staging.unjailed.work';
const security = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' https://cloud.near.ai https://nras.attestation.nvidia.com; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function fail(status) {
  return Response.json({error: 'Encrypted staging request unavailable'}, {status, headers: security});
}

async function readJSON(stream, limit) {
  if (!stream) throw new Error('Missing data');
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('Data exceeds limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {bytes, value: JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes))};
}

function evidenceURL(url) {
  const upstream = new URL(UPSTREAM + url.pathname);
  if (url.pathname === MODEL_PATH && !url.search) return upstream;
  if (signaturePath.test(url.pathname) && url.search === '?signing_algo=ed25519') return upstream;
  if (url.pathname !== '/v1/attestation/report') return;
  const params = url.searchParams;
  const model = params.get('model');
  const keys = model === null
    ? ['include_tls_fingerprint', 'nonce', 'signing_algo']
    : ['include_tls_fingerprint', 'model', 'nonce', 'provider', 'signing_algo'];
  if ([...params.keys()].sort().join() !== keys.sort().join() ||
      !isKey(params.get('nonce')) || params.get('signing_algo') !== 'ed25519' ||
      params.get('include_tls_fingerprint') !== 'false' ||
      model !== null && (model !== MODEL || params.get('provider') !== 'near')) return;
  upstream.search = params.toString();
  return upstream;
}

export function stagingRelay({ verifyOwner = authenticate, fetchUpstream = (url, options) => fetch(url, options) } = {}) {
  return async (request, env) => {
    const url = new URL(request.url);
    if (url.origin !== STAGING_ORIGIN || !await verifyOwner(request, env)) return fail(403);
    try {
      const assetPath = url.pathname === '/' || /^\/assets\/[\w.-]+\.(?:js|css|wasm)$/.test(url.pathname);
      if (request.method === 'GET' && assetPath && !url.search) {
        const asset = await env.ASSETS.fetch(request);
        const headers = new Headers(asset.headers);
        for (const [name, value] of Object.entries(security)) headers.set(name, value);
        return new Response(asset.body, {status: asset.status, headers});
      }
      if (request.headers.get('X-Workstation-Request') !== '1' || request.headers.get('Sec-Fetch-Site') !== 'same-origin') return fail(403);
      const inference = request.method === 'POST' && url.pathname === '/v1/chat/completions' && !url.search;
      const upstream = inference ? new URL(UPSTREAM + url.pathname) : request.method === 'GET' && evidenceURL(url);
      if (!upstream) return fail(404);
      const headers = new Headers({Accept: 'application/json', 'x-no-aliasing': 'true', 'Cache-Control': 'no-store'});
      let body;
      if (inference) {
        if (env.NEAR_STAGING_ENABLED !== 'true' || !env.NEAR_API_KEY || !mutationAllowed(request, STAGING_ORIGIN)) return fail(403);
        if (request.headers.get('X-Encryption-Version') !== '3' || request.headers.get('X-Encrypt-All-Fields') !== 'true' ||
            request.headers.get('X-Signing-Algo') !== 'ed25519' ||
            !isKey(request.headers.get('X-Model-Pub-Key')) || !isKey(request.headers.get('X-Client-Pub-Key'))) return fail(400);
        const parsed = await readJSON(request.body, 16_384);
        if (!encryptedRequest(parsed.value)) return fail(400);
        body = parsed.bytes;
        for (const name of ['X-Encryption-Version', 'X-Encrypt-All-Fields', 'X-Signing-Algo', 'X-Model-Pub-Key', 'X-Client-Pub-Key']) {
          headers.set(name, request.headers.get(name));
        }
        headers.set('Content-Type', 'application/json');
        // Persist only a counter. An uncertain or failed submission still consumes its slot.
        if (!await env.STAGING_QUOTA.getByName('first-two-turns').take()) return fail(429);
      }
      if (inference || signaturePath.test(url.pathname)) {
        if (env.NEAR_STAGING_ENABLED !== 'true' || !env.NEAR_API_KEY) return fail(403);
        headers.set('Authorization', 'Bearer ' + env.NEAR_API_KEY);
      }
      let response;
      try {
        response = await fetchUpstream(upstream, {
          method: request.method, headers, body, redirect: 'manual',
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        if (inference || signaturePath.test(url.pathname)) return fail(502);
        return fail(error instanceof TypeError ? 520 : 521);
      }
      if (!response.ok) {
        await response.body?.cancel();
        const publicEvidence = !inference && !signaturePath.test(url.pathname);
        return fail(publicEvidence ? (response.status >= 400 ? response.status : 424) : 502);
      }
      const parsed = await readJSON(response.body, inference ? 65_536 : 1_048_576);
      if (inference && !encryptedReply(parsed.value)) return fail(502);
      // Preserve exact body bytes for browser-side signature verification.
      return new Response(parsed.bytes, {headers: {...security, 'Content-Type': 'application/json'}});
    } catch {
      return fail(502);
    }
  };
}
