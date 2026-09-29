export type ActorIdentity={id:string;kind:'local-mcp'|'local-http'|'discord-user'|'system';externalId?:string;displayName?:string};
export type Capability='guild.read'|'guild.structure.plan'|'guild.structure.apply'|'guild.structure.replace'|
  'messages.read'|'members.inspect'|'moderation.kick'|'moderation.ban'|'roles.assign'|
  'notifications.read'|'notifications.create'|'notifications.acknowledge'|'activity.read'|'audit.read'|
  'messages.write'|'messages.manage'|'reactions.write'|'threads.manage'|'invites.manage'|
  'permissions.inspect'|'members.modify'|'members.timeout'|'members.voice'|'channels.write'|'guild.settings.write';
export type OperationalEvent={id:string;guildId:string;observedAt:string;type:
  'message.created'|'message.updated'|'message.deleted'|'member.joined'|'member.left'|'member.updated'|
  'channel.created'|'channel.updated'|'channel.deleted'|'role.created'|'role.updated'|'role.deleted'|
  'thread.created'|'thread.updated'|'thread.deleted'|'reaction.added'|'reaction.removed'|
  'automod.executed'|'interaction.received'|'guild.updated';
  channelId?:string;messageId?:string;authorId?:string;userId?:string;roleId?:string;threadId?:string;
  accountCreatedAt?:string};
export type OperatorNotification={id:string;guildId:string;severity:'info'|'attention'|'important'|'critical';
  category:string;title:string;details:unknown;actorId:string;createdAt:string;acknowledgedAt?:string;acknowledgedBy?:string};
export type Page<T>={items:T[];nextCursor?:string;limit:number;source:string;completeness:'observed-only'|'bounded-fetch'};
