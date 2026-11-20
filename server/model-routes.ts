import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { InputError } from './errors.js';
import { configuredModel, modelById, modelSettings, providerInput, runModel, setModelDefault } from './models.js';
import { row, seal, write } from './store.js';

export const modelRoutes = Router();

const modelInput = z.string().trim().min(1, '请输入模型 ID。').max(180)
  .regex(/^[a-z0-9][a-z0-9_./:@-]*$/i, '模型 ID 格式无效。');
const keyInput = z.string().trim().min(1, '请输入 API Key。').max(2048)
  .regex(/^[!-~]+$/, 'API Key 含有无效字符。');
const modelCreate = z.object({ provider: providerInput, model: modelInput, apiKey: keyInput });
const modelUpdate = z.object({ model: modelInput, apiKey: keyInput.optional() });
const defaultInput = z.object({ purpose: z.enum(['writing', 'publishing']), modelId: z.uuid().nullable() });

modelRoutes.get('/models', (_req, res) => {
  res.json(modelSettings());
});

modelRoutes.post('/models', (req, res) => {
  const input = modelCreate.parse(req.body);
  const id = randomUUID();
  if (row('SELECT 1 FROM ai_models WHERE provider = ? AND model = ?', input.provider, input.model)) {
    throw new InputError('这个模型已经添加，可编辑它的 API Key。', 409);
  }
  write('INSERT INTO ai_models (id, provider, model, encryptedKey) VALUES (?, ?, ?, ?)', id, input.provider, input.model, seal(input.apiKey));
  res.status(201).json(modelSettings());
});

modelRoutes.patch('/models/:id', (req, res) => {
  const current = modelById(req.params.id);
  const input = modelUpdate.parse(req.body);
  if (row('SELECT 1 FROM ai_models WHERE provider = ? AND model = ? AND id != ?', current.provider, input.model, current.id)) {
    throw new InputError('这个模型已经添加。', 409);
  }
  write('UPDATE ai_models SET model = ?, encryptedKey = ? WHERE id = ?', input.model,
    input.apiKey === undefined ? current.encryptedKey : seal(input.apiKey), current.id);
  res.json(modelSettings());
});

modelRoutes.delete('/models/:id', (req, res) => {
  const { id } = modelById(req.params.id);
  write('DELETE FROM ai_models WHERE id = ?', id);
  res.json(modelSettings());
});

modelRoutes.patch('/models-defaults', (req, res) => {
  const { purpose, modelId } = defaultInput.parse(req.body);
  setModelDefault(purpose, modelId);
  res.json(modelSettings());
});

modelRoutes.post('/models/:id/test', async (req, res) => {
  await runModel(configuredModel(req.params.id), '只返回 OK。', '连接测试。', 1500, 25_000);
  res.json({ ok: true });
});
