import {z} from 'zod';
import {ChannelType} from 'discord.js';
import {Snowflake} from './types.js';
import {Define,type OperationDefinition} from './registry.js';
import {AuditRoles,EvaluatePermissions} from './permissions.js';
import {DiscordError} from './discord.js';
import type {ControlPlane} from './control.js';

const ThreadTypes=new Set<number>([ChannelType.AnnouncementThread,ChannelType.PublicThread,ChannelType.PrivateThread]);
async function Source(Control:ControlPlane,GuildId:string,ChannelId:string) {
  const Channel=await Control.Discord.RequireGuildChannel(GuildId,ChannelId);
  let Parent;
  if(ThreadTypes.has(Channel.type)&&Channel.parent_id) {
    try {Parent=await Control.Discord.RequireGuildChannel(GuildId,Channel.parent_id);}
    catch(Cause) {
      if(!(Cause instanceof DiscordError&&[403,404].includes(Cause.Status))) throw Cause;
    }
  }
  return {Channel,Parent};
}
export const PermissionOperations:OperationDefinition[]=[
  Define('ExplainMemberPermissions','permissions','read','Explain deterministic guild or channel permissions for one member.',
    z.object({guildId:Snowflake,userId:Snowflake,channelId:Snowflake.optional()}),async(C,A)=>{
      const Snapshot=await C.Discord.Snapshot(A.guildId);
      const Member=await C.Discord.RequireGuildMember(A.guildId,A.userId);
      const Channel=A.channelId?await Source(C,A.guildId,A.channelId):undefined;
      return EvaluatePermissions({guild:Snapshot.guild,roles:Snapshot.roles,member:Member,channel:Channel?.Channel,
        source:Channel?.Parent,botHighestRolePosition:Snapshot.capabilities.highestRolePosition});
    },'permissions.inspect'),
  Define('AuditChannelPermissions','permissions','read','Audit bounded role-only channel permissions.',
    z.object({guildId:Snowflake,channelId:Snowflake,actions:z.array(z.enum(['view','send','manage'])).max(3).optional()}),async(C,A)=>{
      const Snapshot=await C.Discord.Snapshot(A.guildId);
      const {Channel,Parent}=await Source(C,A.guildId,A.channelId);
      return AuditRoles(Snapshot.guild,Snapshot.roles,Channel,Parent,Snapshot.capabilities.highestRolePosition,A.actions);
    },'permissions.inspect')
];
