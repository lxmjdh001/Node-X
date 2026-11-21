export class ProtocolError extends Error {
  constructor(message: string, status?: number);
  readonly status?: number;
}

type BridgeCredential = { matrixUrl: string; bridgeProvisioningUrl: string; matrixAccessToken: string };
type Transport = (url: string, init: RequestInit) => Promise<Response>;

export function discoverBridgeAccount(config: BridgeCredential, username: string, options: {
  signal: AbortSignal;
  transport?: Transport;
  expectedBot?: string;
}): Promise<{ xUserId: string; bridgeBotId: string }>;

export function runConnector(configFile: string, options: {
  signal: AbortSignal;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  managed?: {
    nodeXUrl: string;
    readConfig?: () => unknown;
    transport?: Transport;
    hosted?: {
      checkAccess: () => void;
      verifyIdentity: (xUserId: string) => void;
      onAwaiting: (username: string) => void;
    };
    pair: (xUserId: string) => { token: string; account: { xUserId: string | null } };
    hasToken: (token: string, xUserId: string) => boolean;
    onPaired: (token: string) => void;
    onSync: () => void;
    onRetry: (message: string) => void;
  };
}): Promise<void>;
