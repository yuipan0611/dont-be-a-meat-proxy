import { createGemini, createAntigravity } from './gemini.mjs';
import { createGeminiApi } from './gemini-api.mjs';
import { createGroqApi } from './groq-api.mjs';
import { GatewayError } from './queue.mjs';

export function createBackend({ type, model, command, profileDir, apiKey, timeoutMs, fetchImpl, inheritedHome }) {
  if (type === 'disabled') return { generate: async () => { throw new GatewayError('BACKEND_UNCONFIGURED', 503); } };
  if (!model) throw new Error('upstream model required');
  let backend;
  if (type === 'gemini-cli') backend = createGemini({ command, profileDir, timeoutMs });
  else if (type === 'antigravity-cli') backend = createAntigravity({ command, profileDir, timeoutMs, inheritedHome });
  else if (['gemini-api-free', 'gemini-api-paid'].includes(type)) backend = createGeminiApi({ key: apiKey, timeoutMs, fetchImpl });
  else if (type === 'groq-api') backend = createGroqApi({ key: apiKey, timeoutMs, fetchImpl });
  else throw new Error(`unsupported backend: ${type}`);
  return { generate: (request) => backend.generate({ ...request, model }) };
}
