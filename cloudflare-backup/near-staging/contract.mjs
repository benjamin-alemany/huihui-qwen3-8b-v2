export const MODEL = 'Qwen/Qwen3.8-27B-abliterated';
export const MAX_OUTPUT = 256;
export const CONTEXT_LIMIT = 1024;
export const MODEL_PATH = '/v1/model/' + encodeURIComponent(MODEL);
export const signaturePath = /^\/v1\/signature\/chatcmpl-[A-Za-z0-9_-]{1,128}$/;
export const isKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const isEnvelope = value => typeof value === 'string' && /^(?:[a-f0-9]{2}){72,2048}$/.test(value);
const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, keys) => isRecord(value) && Object.keys(value).every(key => keys.includes(key));

export function encryptedRequest(body) {
  return onlyKeys(body, ['model', 'messages', 'stream', 'max_tokens']) &&
    body.model === MODEL && body.stream === false && body.max_tokens === MAX_OUTPUT &&
    Array.isArray(body.messages) && [1, 3].includes(body.messages.length) &&
    body.messages.every((message, i) => onlyKeys(message, ['role', 'content']) &&
      message.role === (i % 2 ? 'assistant' : 'user') && isEnvelope(message.content));
}

export function encryptedReply(body) {
  const choice = body?.choices?.[0];
  const message = choice?.message;
  return body?.model === MODEL && typeof body.id === 'string' && signaturePath.test('/v1/signature/' + body.id) &&
    Array.isArray(body.choices) && body.choices.length === 1 &&
    onlyKeys(message, ['role', 'content', 'reasoning', 'reasoning_content', 'refusal', 'tool_calls', 'function_call', 'annotations', 'audio']) &&
    message.role === 'assistant' && isEnvelope(message.content) &&
    ['reasoning', 'reasoning_content', 'refusal'].every(field => message[field] == null || message[field] === '' || isEnvelope(message[field])) &&
    (message.tool_calls == null || Array.isArray(message.tool_calls) && message.tool_calls.length === 0) &&
    message.function_call == null && (message.annotations == null || Array.isArray(message.annotations) && message.annotations.length === 0) &&
    message.audio == null && choice.logprobs == null && ['stop', 'length'].includes(choice.finish_reason);
}
