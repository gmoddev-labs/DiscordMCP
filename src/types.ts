import { z } from 'zod';

export const Snowflake = z.string().regex(/^\d{17,20}$/);
export const PermissionName = z.string().regex(/^[A-Z_]+$/);
export const RoleSpec = z.object({
  key: z.string().min(1), name: z.string().min(1).max(100),
  permissions: z.array(PermissionName).default([]), hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(), color: z.number().int().min(0).max(0xffffff).optional()
});
export const OverwriteSpec = z.object({
  target: z.string().min(1), allow: z.array(PermissionName).default([]),
  deny: z.array(PermissionName).default([])
});
export const ChannelSpec = z.object({
  key: z.string().min(1), name: z.string().min(1).max(100),
  type: z.enum(['category', 'text', 'voice', 'forum', 'announcement', 'stage', 'media']),
  parent: z.string().optional(), topic: z.string().max(1024).optional(),
  nsfw: z.boolean().optional(), overwrites: z.array(OverwriteSpec).default([])
});
export const BlueprintSchema = z.object({
  version: z.literal(1), roles: z.array(RoleSpec).default([]),
  channels: z.array(ChannelSpec).default([]),
  guild: z.object({name: z.string().min(2).max(100).optional()}).optional(),
  policy: z.object({pruneChannels: z.boolean().default(false), pruneRoles: z.boolean().default(false)}).optional()
}).superRefine((Value, Context) => {
  for (const Type of ['roles', 'channels'] as const) {
    const Keys = Value[Type].map(Item => Item.key);
    if (new Set(Keys).size !== Keys.length) Context.addIssue({code: 'custom', message: `Duplicate ${Type} key`});
  }
  const Categories = new Set(Value.channels.filter(Item => Item.type === 'category').map(Item => Item.key));
  for (const Channel of Value.channels) if (Channel.parent && !Categories.has(Channel.parent))
    Context.addIssue({code: 'custom', message: `Unknown category ${Channel.parent}`});
});
export type Blueprint = z.infer<typeof BlueprintSchema>;
export type Role = z.infer<typeof RoleSpec>;
export type Channel = z.infer<typeof ChannelSpec>;
export type Operation = {
  id: string; resource: 'role' | 'channel' | 'guild'; action: 'create' | 'update' | 'delete';
  key?: string; targetId?: string; desired?: Role | Channel | {name: string};
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  resultId?: string; error?: string;
};
export type Plan = {
  id: string; guildId: string; actor: string; mode: 'RECONCILE' | 'REPLACE';
  blueprint: Blueprint; blueprintHash: string; mappingHash: string; preconditions: Record<string, string>;
  operations: Operation[]; status: 'planned' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'abandoned';
  createdAt: string; updatedAt: string;
};
