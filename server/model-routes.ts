import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { isQwenProvider, type ModelProviderId, type ModelScope } from '../src/model-catalog.js';
import { InputError } from './errors.js';
import { configuredModel, modelById, modelSettings, modelStore, providerInput, runModel, setModelDefault } from './models.js';
import { seal } from './store.js';

const modelInput = z.string().trim().min(1, '请输入模型 ID。').max(180)
  .regex(/^[a-z0-9][a-z0-9_./:@-]*$/i, '模型 ID 格式无效。');
const keyInput = z.string().trim().min(1, '请输入 API Key。').max(2048)
  .regex(/^[!-~]+$/, 'API Key 含有无效字符。');
const workspaceInput = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, '百炼工作空间 ID 只能包含英文字母、数字和连字符。');
const modelCreate = z.object({ provider: providerInput, model: modelInput, apiKey: keyInput, providerWorkspace: workspaceInput.optional() });
const modelUpdate = z.object({ model: modelInput, apiKey: keyInput.optional(), providerWorkspace: workspaceInput.nullable().optional() });
const defaultInput = z.object({ purpose: z.enum(['writing', 'publishing']), modelId: z.uuid().nullable() });

function providerWorkspace(provider: ModelProviderId, value: string | null | undefined) {
  if (value && !isQwenProvider(provider)) throw new InputError('当前服务商无需百炼工作空间 ID。');
  return value ?? null;
}

export function modelRoutes(scope: ModelScope) {
  const routes = Router();
  routes.get('/models', (_req, res) => {
    res.json(modelSettings(scope));
  });

  routes.post('/models', (req, res) => {
    const input = modelCreate.parse(req.body);
    const { database, models } = modelStore(scope);
    if (database.prepare(`SELECT 1 FROM ${models} WHERE provider = ? AND model = ?`).get(input.provider, input.model)) {
      throw new InputError('这个模型已经添加，可编辑它的 API Key。', 409);
    }
    database.prepare(`INSERT INTO ${models} (id, provider, model, encryptedKey, providerWorkspace) VALUES (?, ?, ?, ?, ?)`)
      .run(randomUUID(), input.provider, input.model, seal(input.apiKey), providerWorkspace(input.provider, input.providerWorkspace));
    res.status(201).json(modelSettings(scope));
  });

  routes.patch('/models/:id', (req, res) => {
    const current = modelById(scope, req.params.id);
    const input = modelUpdate.parse(req.body);
    const { database, models } = modelStore(scope);
    if (database.prepare(`SELECT 1 FROM ${models} WHERE provider = ? AND model = ? AND id != ?`).get(current.provider, input.model, current.id)) {
      throw new InputError('这个模型已经添加。', 409);
    }
    const workspace = input.providerWorkspace === undefined ? current.providerWorkspace : providerWorkspace(current.provider, input.providerWorkspace);
    database.prepare(`UPDATE ${models} SET model = ?, encryptedKey = ?, providerWorkspace = ? WHERE id = ?`)
      .run(input.model, input.apiKey === undefined ? current.encryptedKey : seal(input.apiKey), workspace, current.id);
    res.json(modelSettings(scope));
  });

  routes.delete('/models/:id', (req, res) => {
    const { id } = modelById(scope, req.params.id);
    const { database, models } = modelStore(scope);
    database.prepare(`DELETE FROM ${models} WHERE id = ?`).run(id);
    res.json(modelSettings(scope));
  });

  routes.patch('/models-defaults', (req, res) => {
    const { purpose, modelId } = defaultInput.parse(req.body);
    setModelDefault(scope, purpose, modelId);
    res.json(modelSettings(scope));
  });

  routes.post('/models/:id/test', async (req, res) => {
    await runModel(configuredModel(scope, req.params.id), '只返回 OK。', '连接测试。', 1500, 25_000);
    res.json({ ok: true });
  });

  return routes;
}
