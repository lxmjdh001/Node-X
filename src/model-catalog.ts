type ModelProtocol = 'chat' | 'responses' | 'messages';
type ModelProvider = { name: string; endpoint: string; protocol: ModelProtocol; models: readonly string[] };

const chat = (name: string, base: string, ...models: string[]): ModelProvider => ({
  name, endpoint: base + '/chat/completions', protocol: 'chat', models,
});

export const modelProviders = {
  openai: { name: 'OpenAI · GPT', endpoint: 'https://api.openai.com/v1/responses', protocol: 'responses', models: ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-5-mini'] },
  anthropic: { name: 'Anthropic · Claude', endpoint: 'https://api.anthropic.com/v1/messages', protocol: 'messages', models: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'] },
  gemini: chat('Google · Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'),
  deepseek: chat('DeepSeek', 'https://api.deepseek.com', 'deepseek-flash', 'deepseek-v4-pro'),
  qwen: chat('阿里云 · 通义千问（中国内地）', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.8-flash', 'qwen-plus', 'qwen-max', 'qwen-turbo'),
  qwenIntl: chat('阿里云 · 通义千问（国际）', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen3.8-flash', 'qwen-plus', 'qwen-max', 'qwen-turbo'),
  fnewapi: chat('第三方 · FNewAPI（顺奥）', 'https://subapis.gzshunao.com/v1', 'qwen3.8-flash', 'qwen3.8-max', 'qwen3.7-flash'),
  kimi: chat('月之暗面 · Kimi（中国内地）', 'https://api.moonshot.cn/v1', 'kimi-k3.1-pro', 'kimi-k2.5'),
  kimiIntl: chat('月之暗面 · Kimi（国际）', 'https://api.moonshot.ai/v1', 'kimi-k3.1-pro', 'kimi-k2.5'),
  bigmodel: chat('智谱 · GLM（中国内地）', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3', 'glm-4.7-flash'),
  zai: chat('Z.AI · GLM（国际）', 'https://api.z.ai/api/paas/v4', 'glm-5.3', 'glm-4.7-flash'),
  doubao: chat('火山方舟 · 豆包', 'https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-2-1-lite-260915', 'doubao-seed-2-0-mini-260428'),
  minimax: chat('MiniMax', 'https://api.minimax.io/v1', 'MiniMax-M3.1-Flash', 'MiniMax-M3'),
  hunyuan: chat('腾讯 · 混元', 'https://api.hunyuan.cloud.tencent.com/v1', 'hunyuan-turbos-latest'),
  ernie: chat('百度千帆 · 文心', 'https://qianfan.baidubce.com/v2', 'ernie-4.5-turbo-32k'),
  xai: { name: 'xAI · Grok', endpoint: 'https://api.x.ai/v1/responses', protocol: 'responses', models: ['grok-4.7'] },
  mistral: chat('Mistral AI', 'https://api.mistral.ai/v1', 'mistral-small-latest', 'mistral-large-latest'),
  groq: chat('Groq', 'https://api.groq.com/openai/v1', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b'),
  siliconflow: chat('硅基流动 · SiliconFlow', 'https://api.siliconflow.cn/v1'),
  openrouter: chat('OpenRouter', 'https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-5.5', 'openai/gpt-oss-20b'),
} satisfies Record<string, ModelProvider>;

export type ModelProviderId = keyof typeof modelProviders;
export type ModelPurpose = 'writing' | 'publishing';
export type ModelScope = 'workspace' | 'global';
type ModelDefaults = Record<ModelPurpose, string | null>;
export type WorkspaceModel = { id: string; provider: ModelProviderId; model: string; providerWorkspace: string | null };
export type SharedModel = Omit<WorkspaceModel, 'providerWorkspace'>;
export type ModelSettings = {
  models: WorkspaceModel[];
  defaults: ModelDefaults;
  shared?: { models: SharedModel[]; defaults: ModelDefaults };
  legacyWriting: boolean;
};

export function isModelProvider(value: string): value is ModelProviderId {
  return Object.hasOwn(modelProviders, value);
}

export function isQwenProvider(provider: ModelProviderId): provider is 'qwen' | 'qwenIntl' {
  return provider === 'qwen' || provider === 'qwenIntl';
}
