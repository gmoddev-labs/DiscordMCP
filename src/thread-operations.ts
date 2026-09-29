import {z} from 'zod';
import {ChannelType} from 'discord.js';
import {Snowflake,ArchiveDuration} from './types.js';
import {Embed,SendContent,MessageBody} from './message-payload.js';
import {Define,type OperationDefinition} from './registry.js';
import type {ControlPlane} from './control.js';
import type {ActorIdentity} from './assistant-types.js';
import type {DiscordChannel,DiscordMessage} from './discord.js';

const Guild=z.strictObject({guildId:Snowflake});
const Parent=Guild.extend({channelId:Snowflake});
const Thread=Guild.extend({threadId:Snowflake});
const ThreadTypes=new Set<number>([ChannelType.AnnouncementThread,ChannelType.PublicThread,ChannelType.PrivateThread]);
const Reason=(Actor:ActorIdentity,Id:string,Name:string)=>`DiscordControl action=${Id} actor=${Actor.id} ${Name}`;
async function RequireThread(Control:ControlPlane,GuildId:string,ThreadId:string):Promise<DiscordChannel> {
  const Item=await Control.Discord.RequireGuildChannel(GuildId,ThreadId);
  if(!ThreadTypes.has(Item.type)) throw new Error('Exact channel is not a thread');
  return Item;
}
const ForumPost=Guild.extend({forumChannelId:Snowflake,name:z.string().min(1).max(100),
  content:z.string().min(1).max(2000).optional(),embeds:z.array(Embed).max(10).optional(),
  appliedTagIds:z.array(Snowflake).max(5).default([]),autoArchiveDuration:ArchiveDuration.optional(),
  rateLimitPerUser:z.number().int().min(0).max(21600).optional()}).refine(Value=>Boolean(Value.content||Value.embeds?.length),
    'A forum post needs content or an embed');
export const ThreadOperations:OperationDefinition[]=[
  Define('CreateThread','threads','write','Create a standalone public or private text thread.',Parent.extend({
    name:z.string().min(1).max(100),type:z.enum(['public','private']).default('public'),
    autoArchiveDuration:ArchiveDuration.optional(),rateLimitPerUser:z.number().int().min(0).max(21600).optional(),
    invitable:z.boolean().optional()
  }),(C,A,Actor)=>C.RunDirect(A.guildId,Actor.id,'create-thread',A.channelId,async()=>{
    const Channel=await C.Discord.RequireGuildChannel(A.guildId,A.channelId);
    if(Channel.type!==ChannelType.GuildText) throw new Error('Standalone threads require a text channel');
    if(A.type!=='private'&&A.invitable!==undefined) throw new Error('Invitable applies only to private threads');
  },async Id=>{
    const Body={name:A.name,type:A.type==='private'?ChannelType.PrivateThread:ChannelType.PublicThread,
      ...(A.autoArchiveDuration?{auto_archive_duration:A.autoArchiveDuration}:{}),
      ...(A.rateLimitPerUser!==undefined?{rate_limit_per_user:A.rateLimitPerUser}:{}),
      ...(A.invitable!==undefined?{invitable:A.invitable}:{})};
    const Item=await C.Discord.Post<DiscordChannel>(`/channels/${A.channelId}/threads`,Body,Reason(Actor,Id,'create-thread'));
    return {guildId:A.guildId,parentChannelId:A.channelId,threadId:Item.id,name:Item.name,type:Item.type};
  }), 'threads.manage'),
  Define('ModifyThread','threads','write','Rename, archive, lock, or configure one exact thread.',Thread.extend({
    name:z.string().min(1).max(100).optional(),archived:z.boolean().optional(),locked:z.boolean().optional(),
    autoArchiveDuration:ArchiveDuration.optional(),rateLimitPerUser:z.number().int().min(0).max(21600).optional(),
    invitable:z.boolean().optional()
  }),(C,A,Actor)=>{
    if(!Object.entries(A).some(([Key,Value])=>!['guildId','threadId'].includes(Key)&&Value!==undefined))
      throw new Error('At least one thread setting is required');
    return C.RunDirect(A.guildId,Actor.id,'modify-thread',A.threadId,async()=>{
      const Current=await RequireThread(C,A.guildId,A.threadId);
      if(A.invitable!==undefined&&Current.type!==ChannelType.PrivateThread)
        throw new Error('Invitable applies only to private threads');
    },async Id=>{
      const Body={...(A.name!==undefined?{name:A.name}:{}),...(A.archived!==undefined?{archived:A.archived}:{}),
        ...(A.locked!==undefined?{locked:A.locked}:{}),
        ...(A.autoArchiveDuration!==undefined?{auto_archive_duration:A.autoArchiveDuration}:{}),
        ...(A.rateLimitPerUser!==undefined?{rate_limit_per_user:A.rateLimitPerUser}:{}),
        ...(A.invitable!==undefined?{invitable:A.invitable}:{})};
      const Item=await C.Discord.Patch<DiscordChannel>(`/channels/${A.threadId}`,Body,Reason(Actor,Id,'modify-thread'));
      return {guildId:A.guildId,threadId:A.threadId,name:Item.name,
        archived:Item.thread_metadata?.archived,locked:Item.thread_metadata?.locked};
    });
  },'threads.manage'),
  Define('DeleteThread','threads','destructive','Delete one exact thread after type validation.',Thread,(C,A,Actor)=>
    C.RunDirect(A.guildId,Actor.id,'delete-thread',A.threadId,async()=>{
      await RequireThread(C,A.guildId,A.threadId);
    },async Id=>{
      await C.Discord.Delete(`/channels/${A.threadId}`,Reason(Actor,Id,'delete-thread'));
      return {guildId:A.guildId,threadId:A.threadId,deleted:true};
    }), 'threads.manage'),
  Define('CreateForumPost','threads','write','Create a post in one exact forum or media channel.',ForumPost,
    (C,A,Actor)=>C.RunDirect(A.guildId,Actor.id,'create-forum-post',A.forumChannelId,async()=>{
      const Channel=await C.Discord.RequireGuildChannel(A.guildId,A.forumChannelId);
      if(![ChannelType.GuildForum,ChannelType.GuildMedia].includes(Channel.type))
        throw new Error('Forum post requires a forum or media channel');
      const Tags=new Set((Channel.available_tags??[]).map(Tag=>Tag.id));
      if(new Set(A.appliedTagIds).size!==A.appliedTagIds.length||A.appliedTagIds.some((Tag:string)=>!Tags.has(Tag)))
        throw new Error('Every applied tag must be a distinct tag on the exact forum channel');
      SendContent.parse({content:A.content,embeds:A.embeds});
    },async Id=>{
      const Content=SendContent.parse({content:A.content,embeds:A.embeds});
      const Body={name:A.name,message:MessageBody(Content),applied_tags:A.appliedTagIds,
        ...(A.autoArchiveDuration?{auto_archive_duration:A.autoArchiveDuration}:{}),
        ...(A.rateLimitPerUser!==undefined?{rate_limit_per_user:A.rateLimitPerUser}:{})};
      const Item=await C.Discord.Post<DiscordChannel&{message:DiscordMessage}>(
        `/channels/${A.forumChannelId}/threads`,Body,Reason(Actor,Id,'create-forum-post'));
      return {guildId:A.guildId,forumChannelId:A.forumChannelId,threadId:Item.id,messageId:Item.message.id,
        name:Item.name,appliedTagIds:A.appliedTagIds};
    }), 'threads.manage')
];
