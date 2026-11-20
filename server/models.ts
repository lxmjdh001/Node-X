import { z } from 'zod';
import { isFnewApiProvider, isModelProvider, isQwenProvider, modelProviders, type ModelProviderId, type ModelPurpose, type ModelScope, type ModelSettings, type SharedModel, type WorkspaceModel } from '../src/model-catalog.js';
import { InputError, requireFound } from './errors.js';
import { db, isCustomerWorkspace, reveal, workspaceDb } from './store.js';

type StoredModel = WorkspaceModel & { encryptedKey: string };
type ActiveModel = {
  name: string;
  model: string;
  apiKey: string;
  endpoint: string;
  protocol: 'chat' | 'messages' | 'responses';
  provider?: ModelProviderId;
  chatOptions?: { enable_thinking?: false; stream?: false };
};

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

export function modelStore(scope: ModelScope) {
  return scope === 'global'
    ? { database: db, models: 'global_ai_models', defaults: 'global_ai_defaults' }
    : { database: workspaceDb(), models: 'ai_models', defaults: 'ai_defaults' };
}

function storedModel(scope: ModelScope, id: string): StoredModel | undefined {
  const { database, models } = modelStore(scope);
  return database.prepare(`SELECT * FROM ${models} WHERE id = ?`).get(id) as StoredModel | undefined;
}

export function modelById(scope: ModelScope, id: string): StoredModel {
  return requireFound(storedModel(scope, id), '找不到这个模型。');
}

function defaultId(scope: ModelScope, purpose: ModelPurpose): string | null {
  const { database, defaults } = modelStore(scope);
  const entry = database.prepare(`SELECT modelId FROM ${defaults} WHERE purpose = ?`).get(purpose) as { modelId: string } | undefined;
  return entry?.modelId ?? null;
}

function sharedSelection(purpose: ModelPurpose): string | null {
  const entry = workspaceDb().prepare('SELECT modelId FROM ai_shared_selections WHERE purpose = ?').get(purpose) as { modelId: string } | undefined;
  return entry && db.prepare('SELECT 1 FROM global_ai_models WHERE id = ?').get(entry.modelId) ? entry.modelId : null;
}

function effectiveModel(purpose: ModelPurpose): { scope: ModelScope; id: string } | undefined {
  const local = defaultId('workspace', purpose);
  if (local) return { scope: 'workspace', id: local };
  const shared = sharedSelection(purpose) ?? defaultId('global', purpose);
  if (shared) return { scope: 'global', id: shared };
}

export function modelAvailable(purpose: ModelPurpose): boolean {
  return Boolean(effectiveModel(purpose) || (purpose === 'writing' && legacyModel()));
}

export function modelSettings(scope: ModelScope): ModelSettings {
  const { database, models } = modelStore(scope);
  const defaults = {
    writing: defaultId(scope, 'writing'),
    publishing: defaultId(scope, 'publishing'),
  };
  const settings: ModelSettings = {
    models: database.prepare(`SELECT id, provider, model, providerWorkspace FROM ${models} ORDER BY rowid DESC`).all() as WorkspaceModel[],
    defaults,
    legacyWriting: scope === 'workspace' && Boolean(legacyModel()),
  };
  if (scope === 'workspace') {
    settings.defaults = {
      writing: defaults.writing ?? sharedSelection('writing'),
      publishing: defaults.publishing ?? sharedSelection('publishing'),
    };
    settings.shared = {
      models: db.prepare('SELECT id, provider, model FROM global_ai_models ORDER BY rowid DESC').all() as SharedModel[],
      defaults: { writing: defaultId('global', 'writing'), publishing: defaultId('global', 'publishing') },
    };
  }
  return settings;
}

function writeDefault(scope: ModelScope, purpose: ModelPurpose, id: string | null) {
  const { database, defaults } = modelStore(scope);
  if (id === null) database.prepare(`DELETE FROM ${defaults} WHERE purpose = ?`).run(purpose);
  else database.prepare(`
    INSERT INTO ${defaults} (purpose, modelId) VALUES (?, ?) ON CONFLICT(purpose) DO UPDATE SET modelId = excluded.modelId
  `).run(purpose, id);
}

export function setModelDefault(scope: ModelScope, purpose: ModelPurpose, id: string | null) {
  if (scope === 'global') {
    if (id !== null) modelById(scope, id);
    writeDefault(scope, purpose, id);
    return;
  }
  const database = workspaceDb();
  const local = id !== null && storedModel('workspace', id) !== undefined;
  if (id !== null && !local) modelById('global', id);
  database.exec('BEGIN IMMEDIATE');
  try {
    writeDefault('workspace', purpose, local ? id : null);
    if (id !== null && !local) {
      database.prepare(`
        INSERT INTO ai_shared_selections (purpose, modelId) VALUES (?, ?) ON CONFLICT(purpose) DO UPDATE SET modelId = excluded.modelId
      `).run(purpose, id);
    } else {
      database.prepare('DELETE FROM ai_shared_selections WHERE purpose = ?').run(purpose);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function configuredModel(scope: ModelScope, id: string): ActiveModel {
  const config = modelById(scope, id);
  const provider = modelProviders[config.provider];
  let endpoint = provider.endpoint;
  if (config.providerWorkspace && isQwenProvider(config.provider)) {
    const region = config.provider === 'qwen' ? 'cn-beijing' : 'ap-southeast-1';
    endpoint = `https://${config.providerWorkspace}.${region}.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;
  }
  const gateway = config.provider === 'fnewapi';
  const qwenFlash = (gateway || isQwenProvider(config.provider)) && /^qwen3\.8-flash(?:-|$)/.test(config.model);
  return {
    ...provider, endpoint, model: config.model, apiKey: reveal(config.encryptedKey), provider: config.provider,
    chatOptions: {
      ...(gateway ? { stream: false } : {}),
      ...(qwenFlash ? { enable_thinking: false } : {}),
    },
  };
}

export function activeModel(purpose: ModelPurpose): ActiveModel | undefined {
  const selection = effectiveModel(purpose);
  return selection ? configuredModel(selection.scope, selection.id)
    : purpose === 'writing' ? legacyModel() : undefined;
}

const textParts = z.array(z.object({ type: z.string(), text: z.string().optional() }));
const messagesResult = z.object({ content: textParts });
const responsesResult = z.object({
  status: z.string().optional(),
  output: z.array(z.object({ type: z.string(), content: textParts.optional() })).optional(),
});
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
    if (config.provider === 'fnewapiResponses') {
      body = { model, instructions: system, input: prompt, max_output_tokens: maxTokens, stream: false, store: false };
    } else if (config.protocol === 'responses') {
      body = { model, input: [{ role: 'system', content: system }, ...messages], max_output_tokens: maxTokens, store: false };
    } else {
      body = { model, messages: [{ role: 'system', content: system }, ...messages], max_tokens: maxTokens, ...config.chatOptions };
    }
  }
  let response: Response;
  let text: string | null | undefined;
  try {
    response = await fetch(config.endpoint, {
      method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeout),
    });
    if (response.ok) {
      const data: unknown = await response.json();
      if (config.protocol === 'responses') {
        const result = responsesResult.parse(data);
        if (config.provider === 'fnewapiResponses' && result.status && result.status !== 'completed') {
          throw new InputError(result.status === 'incomplete'
            ? 'FNewAPI Responses 返回的正文未完成。请缩短请求或换用其他模型。'
            : 'FNewAPI Responses 未能完成这次请求。', 502);
        }
        text = result.output?.filter(item => item.type === 'message')
          .flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text).join('');
      } else if (config.protocol === 'messages') {
        text = messagesResult.parse(data).content.filter(part => part.type === 'text').map(part => part.text).join('');
      } else {
        text = chatResult.parse(data).choices[0]?.message.content;
      }
    } else {
      await response.body?.cancel();
    }
  } catch (error) {
    if (error instanceof InputError) throw error;
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new InputError(timedOut ? '模型响应超时，请重试或切换模型。' : '无法读取模型响应，请检查服务网络或更换模型。', 502);
  }
  if (!response.ok) {
    const { status } = response;
    if (config.provider && isFnewApiProvider(config.provider)) {
      if (status === 401) throw new InputError('FNewAPI 未接受此 API Key。请确认使用第三方平台签发的有效 Key。', 422);
      if (status === 403 || status === 404) throw new InputError('FNewAPI 拒绝访问此模型。请核对模型 ID，并检查账号和 Key 的模型权限。', 422);
    }
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
