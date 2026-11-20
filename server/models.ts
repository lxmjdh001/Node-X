import { z } from 'zod';
import { isModelProvider, modelProviders, type ModelProviderId, type ModelPurpose, type ModelSettings, type WorkspaceModel } from '../src/model-catalog.js';
import { InputError, requireFound } from './errors.js';
import { isCustomerWorkspace, reveal, row, rows, write } from './store.js';

type StoredModel = WorkspaceModel & { encryptedKey: string };
type ActiveModel = { name: string; model: string; apiKey: string; endpoint: string; protocol: 'chat' | 'messages' | 'responses' };

function legacyModel() {
  if (isCustomerWorkspace()) return;
  const apiKey = process.env.AI_API_KEY?.trim();
  const model = process.env.AI_MODEL?.trim();
  if (!apiKey || !model) return;
  try {
    const base = new URL(process.env.AI_BASE_URL?.trim() || 'https://api.openai.com/v1');
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) return;
    return { name: '服务器默认模型', model, apiKey, endpoint: base.href.replace(/\/+$/, '') + '/chat/completions', protocol: 'chat' } satisfies ActiveModel;
  } catch {
    return;
  }
}

export function modelById(id: string): StoredModel {
  return requireFound(row<StoredModel>('SELECT * FROM ai_models WHERE id = ?', id), '找不到这个模型。');
}

export function modelDefault(purpose: ModelPurpose): string | null {
  return row<{ modelId: string }>('SELECT modelId FROM ai_defaults WHERE purpose = ?', purpose)?.modelId ?? null;
}

export function legacyWritingAvailable() {
  return Boolean(legacyModel());
}

export function modelSettings(): ModelSettings {
  return {
    models: rows<WorkspaceModel>('SELECT id, provider, model FROM ai_models ORDER BY rowid DESC'),
    defaults: { writing: modelDefault('writing'), publishing: modelDefault('publishing') },
    legacyWriting: legacyWritingAvailable(),
  };
}

export function setModelDefault(purpose: ModelPurpose, id: string | null) {
  if (id === null) return write('DELETE FROM ai_defaults WHERE purpose = ?', purpose);
  modelById(id);
  return write('INSERT INTO ai_defaults (purpose, modelId) VALUES (?, ?) ON CONFLICT(purpose) DO UPDATE SET modelId = excluded.modelId', purpose, id);
}

export function configuredModel(id: string): ActiveModel {
  const config = modelById(id);
  const provider = modelProviders[config.provider];
  return { ...provider, model: config.model, apiKey: reveal(config.encryptedKey) };
}

export function activeModel(purpose: ModelPurpose): ActiveModel | undefined {
  const id = modelDefault(purpose);
  return id ? configuredModel(id) : purpose === 'writing' ? legacyModel() : undefined;
}

const textParts = z.array(z.object({ type: z.string(), text: z.string().optional() }));
const messagesResult = z.object({ content: textParts });
const responsesResult = z.object({ output: z.array(z.object({ type: z.string(), content: textParts.optional() })) });
const chatResult = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })) });

export async function runModel(
  config: ActiveModel, system: string, prompt: string, maxTokens: number, timeout = 45_000,
): Promise<string> {
  const messages = [{ role: 'user', content: prompt }];
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const model = config.model;
  let body: object;
  if (config.protocol === 'messages') {
    headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = { model, system, messages, max_tokens: maxTokens };
  } else {
    headers.Authorization = 'Bearer ' + config.apiKey;
    body = config.protocol === 'responses'
      ? { model, input: [{ role: 'system', content: system }, ...messages], max_output_tokens: maxTokens, store: false }
      : { model, messages: [{ role: 'system', content: system }, ...messages], max_tokens: maxTokens };
  }
  let response: Response;
  let text: string | null | undefined;
  try {
    response = await fetch(config.endpoint, {
      method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeout),
    });
    if (response.ok) {
      const data: unknown = await response.json();
      text = config.protocol === 'messages'
        ? messagesResult.parse(data).content.filter(part => part.type === 'text').map(part => part.text).join('')
        : config.protocol === 'responses'
          ? responsesResult.parse(data).output.filter(item => item.type === 'message')
            .flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text).join('')
          : chatResult.parse(data).choices[0]?.message.content;
    } else {
      await response.body?.cancel();
    }
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new InputError(timedOut ? '模型响应超时，请重试或切换模型。' : '无法读取模型响应，请检查服务网络或更换模型。', 502);
  }
  if (!response.ok) {
    const { status } = response;
    if (status === 401 || status === 403) throw new InputError('模型服务拒绝了 API Key 或模型权限。', 422);
    if (status === 402 || status === 429) throw new InputError('模型服务额度不足或触发了频率限制。', 429);
    if (status === 400 || status === 404) throw new InputError('模型服务未接受请求，请核对模型 ID、所选地区和模型权限。', 422);
    throw new InputError('模型服务暂时不可用，请稍后重试。', 502);
  }
  if (!text?.trim()) throw new InputError('模型未返回正文，请重试或切换模型。', 502);
  return text.trim();
}

export function requiredModel(purpose: ModelPurpose) {
  const config = activeModel(purpose);
  if (!config) throw new InputError(purpose === 'writing' ? '请先在模型列表设置默认写作模型。' : '请先在模型列表设置默认发布审核模型。', 409);
  return config;
}

export const providerInput = z.string().refine((value): value is ModelProviderId => isModelProvider(value), '请选择支持的模型服务商。');
