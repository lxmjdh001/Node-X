export const MAX_BULK_PUBLISH = 51;

export const publishingMethods = {
  official: '官方 API',
  mcp: '大模型 MCP',
} as const;

export type PublishingMethod = keyof typeof publishingMethods;
export type PublishingSettings = {
  method: PublishingMethod;
  clientId: string;
  hasClientSecret: boolean;
  redirectUri: string;
  xConfigured: boolean;
};

export type PublishSnapshotItem = { id: string; accountId: string; handle: string; text: string };

export function publishSnapshot(items: PublishSnapshotItem[]) {
  return JSON.stringify(items.map(({ id, accountId, handle, text }) => [id, accountId, handle, text]));
}
