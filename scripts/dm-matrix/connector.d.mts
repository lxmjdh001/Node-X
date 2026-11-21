export class ProtocolError extends Error {
  constructor(message: string, status?: number);
  readonly status?: number;
}

export function runConnector(configFile: string, options: {
  signal: AbortSignal;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  managed?: {
    nodeXUrl: string;
    pair: (xUserId: string) => { token: string; account: { xUserId: string | null } };
    hasToken: (token: string, xUserId: string) => boolean;
    onPaired: (token: string) => void;
    onSync: () => void;
    onRetry: (message: string) => void;
  };
}): Promise<void>;
