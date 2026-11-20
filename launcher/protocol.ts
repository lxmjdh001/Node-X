import { z } from 'zod';
import config from './config.json' with { type: 'json' };

export const launcherConfig = config;
export const ticketPattern = /^[A-Za-z0-9_-]{43}$/;
export const launcherWorkspace = z.union([z.literal('owner'), z.uuid()]);
export const launchPayload = z.object({
  workspace: launcherWorkspace,
  profile: z.uuid(),
  presenceToken: z.string().min(1).max(512).optional(),
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(320).max(2160),
  proxy: z.object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    username: z.string().max(255),
    password: z.string().max(255),
  }),
});
