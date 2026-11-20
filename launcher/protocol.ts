import { z } from 'zod';
import config from './config.json' with { type: 'json' };

export const launcherConfig = config;
export const ticketPattern = /^[A-Za-z0-9_-]{43}$/;
export const launchPayload = z.object({
  workspace: z.union([z.literal('owner'), z.uuid()]),
  profile: z.uuid(),
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(320).max(2160),
  proxy: z.object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    username: z.string().max(255),
    password: z.string().max(255),
  }),
});
