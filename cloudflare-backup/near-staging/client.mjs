import { InferenceClient } from '@nearai/inference-sdk';
import { CONTEXT_LIMIT, MAX_OUTPUT, MODEL } from './contract.mjs';

function clientOptions(origin) {
  return {
    baseUrl: origin + '/v1',
    headers: {'X-Workstation-Request': '1'},
    e2ee: true,
    signingAlgo: 'ed25519',
    attestationCacheTimeToLiveMs: 0,
    gatewayVerification: {policy: {acceptedTcbStatuses: ['UpToDate']}},
    modelVerification: {policy: {acceptedTcbStatuses: ['UpToDate'], gpuEvidence: 'required'}},
  };
}

export async function verifyStagingModel(origin) {
  const client = new InferenceClient(clientOptions(origin));
  const evidence = await client.verify(MODEL);
  if (evidence.models.length !== 1) throw new Error('Expected one verified model report');
}

export async function verifiedReply(origin, messages, makeClient = options => new InferenceClient(options)) {
  if (![1, 3].includes(messages.length) || messages.reduce((size, message) => size + message.content.length, 0) > CONTEXT_LIMIT) {
    throw new Error('Staging conversation limit reached');
  }
  const client = makeClient(clientOptions(origin));
  try {
    const result = await client.chat.completions.create({
      model: MODEL,
      messages,
      stream: false,
      max_tokens: MAX_OUTPUT,
    });
    const receipt = await client.verifyResponse(result.id);
    const reply = result.choices?.[0]?.message;
    if (receipt.signatureKind !== 'provider_tee' || receipt.attestations.length !== 1 ||
        result.model !== MODEL || reply?.role !== 'assistant' || typeof reply.content !== 'string' || !reply.content.trim()) {
      throw new Error('Model reply could not be verified');
    }
    return reply.content;
  } finally {
    client.clearResponseCache();
  }
}
