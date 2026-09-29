import { z } from 'zod';
import type { ActorIdentity } from './assistant-types.js';

export const Snowflake = z.string().regex(/^\d{17,20}$/);
export const PermissionName = z.string().regex(/^[A-Z_]+$/);
export const ArchiveDuration=z.union([z.literal(60),z.literal(1440),z.literal(4320),z.literal(10080)]);
export const ForumTag=z.strictObject({id:Snowflake.optional(),name:z.string().min(1).max(20),moderated:z.boolean().optional(),
  emoji:z.strictObject({id:Snowflake.optional(),name:z.string().min(1).max(64).optional()}).refine(Value=>Boolean(Value.id)!==Boolean(Value.name)).optional()});
export const ForumSettings=z.strictObject({availableTags:z.array(ForumTag).max(20).optional(),
  defaultReactionEmoji:z.strictObject({id:Snowflake.optional(),name:z.string().min(1).max(64).optional()})
    .refine(Value=>Boolean(Value.id)!==Boolean(Value.name)).nullable().optional(),
  defaultSortOrder:z.union([z.literal(0),z.literal(1)]).nullable().optional(),
  defaultForumLayout:z.union([z.literal(0),z.literal(1),z.literal(2)]).optional(),requireTag:z.boolean().optional()})
  .refine(Value=>!Value.availableTags||new Set(Value.availableTags.map(Tag=>Tag.name)).size===Value.availableTags.length,
    'Forum tag names must be unique');
export const ChannelSettings=z.strictObject({name:z.string().min(1).max(100).optional(),topic:z.string().max(4096).nullable().optional(),
  nsfw:z.boolean().optional(),rateLimitPerUser:z.number().int().min(0).max(21600).optional(),
  bitrate:z.number().int().min(8000).max(384000).optional(),userLimit:z.number().int().min(0).max(10000).optional(),
  rtcRegion:z.string().min(1).max(100).nullable().optional(),videoQualityMode:z.union([z.literal(1),z.literal(2)]).optional(),
  defaultAutoArchiveDuration:ArchiveDuration.optional(),defaultThreadRateLimitPerUser:z.number().int().min(0).max(21600).optional(),
  forum:ForumSettings.optional()});
export type ChannelSettingsValue=z.infer<typeof ChannelSettings>;
export const RoleSpec = z.strictObject({
  key: z.string().min(1), name: z.string().min(1).max(100),
  permissions: z.array(PermissionName).default([]), hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(), color: z.number().int().min(0).max(0xffffff).optional(),
  unicodeEmoji:z.string().min(1).max(64).nullable().optional()
});
export const OverwriteSpec = z.object({
  target: z.string().min(1), allow: z.array(PermissionName).default([]),
  deny: z.array(PermissionName).default([])
});
export const ChannelSpec = z.strictObject({
  key: z.string().min(1), name: z.string().min(1).max(100),
  type: z.enum(['category', 'text', 'voice', 'forum', 'announcement', 'stage', 'media']),
  parent: z.string().optional(), topic: z.string().max(4096).nullable().optional(),
  nsfw: z.boolean().optional(), overwrites: z.array(OverwriteSpec).default([]),
  position:z.number().int().min(0).optional(),rateLimitPerUser:ChannelSettings.shape.rateLimitPerUser,
  bitrate:ChannelSettings.shape.bitrate,userLimit:ChannelSettings.shape.userLimit,
  rtcRegion:ChannelSettings.shape.rtcRegion,videoQualityMode:ChannelSettings.shape.videoQualityMode,
  defaultAutoArchiveDuration:ChannelSettings.shape.defaultAutoArchiveDuration,
  defaultThreadRateLimitPerUser:ChannelSettings.shape.defaultThreadRateLimitPerUser,
  forum:ForumSettings.optional()
}).superRefine((Value,Context)=>{
  const Voice=['voice','stage'].includes(Value.type);
  const Forum=['forum','media'].includes(Value.type);
  const Text=['text','announcement','forum','media'].includes(Value.type);
  if(!Voice&&[Value.bitrate,Value.userLimit,Value.rtcRegion,Value.videoQualityMode].some(Item=>Item!==undefined))
    Context.addIssue({code:'custom',message:'Voice properties require voice or stage channel'});
  if(!Forum&&Value.forum) Context.addIssue({code:'custom',message:'Forum configuration requires forum or media channel'});
  if(Value.type==='media'&&Value.forum?.defaultForumLayout!==undefined)
    Context.addIssue({code:'custom',message:'Forum layout requires forum channel'});
  if(!Text&&[Value.topic,Value.defaultAutoArchiveDuration,Value.defaultThreadRateLimitPerUser].some(Item=>Item!==undefined))
    Context.addIssue({code:'custom',message:'Text settings require a text-like channel'});
  if(!Forum&&Value.topic!==undefined&&Value.topic!==null&&Value.topic.length>1024)
    Context.addIssue({code:'custom',message:'Topic exceeds channel limit'});
  if(Value.type==='announcement'&&Value.rateLimitPerUser!==undefined)
    Context.addIssue({code:'custom',message:'Announcement channels do not support slowmode'});
  if(Value.type==='category'&&Value.nsfw!==undefined)
    Context.addIssue({code:'custom',message:'Categories do not support nsfw'});
});
export const GuildSpec=z.strictObject({name:z.string().min(2).max(100).optional(),description:z.string().max(120).nullable().optional(),
  afkChannel:z.string().min(1).nullable().optional(),afkTimeout:z.union([z.literal(60),z.literal(300),z.literal(900),z.literal(1800),z.literal(3600)]).optional(),
  systemChannel:z.string().min(1).nullable().optional(),systemChannelFlags:z.number().int().min(0).max(63).optional(),
  verificationLevel:z.number().int().min(0).max(4).optional(),defaultMessageNotifications:z.union([z.literal(0),z.literal(1)]).optional(),
  explicitContentFilter:z.number().int().min(0).max(2).optional(),preferredLocale:z.string().min(2).max(35).optional(),
  rulesChannel:z.string().min(1).nullable().optional(),publicUpdatesChannel:z.string().min(1).nullable().optional(),
  safetyAlertsChannel:z.string().min(1).nullable().optional()});
export const BlueprintSchema = z.object({
  version: z.literal(1), roles: z.array(RoleSpec).default([]),
  channels: z.array(ChannelSpec).default([]),
  guild: GuildSpec.optional(),
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
export type GuildDesired=z.infer<typeof GuildSpec>;
export type Operation = {
  id: string; resource: 'role' | 'channel' | 'guild'; action: 'create' | 'update' | 'delete';
  key?: string; targetId?: string; desired?: Role | Channel | GuildDesired;
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  resultId?: string; error?: string;
};
export type Plan = {
  id: string; guildId: string; actor: string; actorIdentity?:ActorIdentity; mode: 'RECONCILE' | 'REPLACE';
  blueprint: Blueprint; blueprintHash: string; mappingHash: string; preconditions: Record<string, string>;
  operations: Operation[]; status: 'planned' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'abandoned';
  createdAt: string; updatedAt: string;
};
