import {z} from 'zod';
import {ChannelType,PermissionFlagsBits} from 'discord.js';
import {Snowflake} from './types.js';
import {Define,type OperationDefinition} from './registry.js';
import type {ControlPlane} from './control.js';
import type {ActorIdentity} from './assistant-types.js';
import type {DiscordMember,Snapshot} from './discord.js';

const Member=z.object({guildId:Snowflake,userId:Snowflake});
const Reason=(Actor:ActorIdentity,Id:string,Name:string)=>`DiscordControl action=${Id} actor=${Actor.id} ${Name}`;
function Has(SnapshotValue:Snapshot,Name:string) {
  return SnapshotValue.capabilities.permissions.includes('Administrator')||SnapshotValue.capabilities.permissions.includes(Name);
}
async function Check(Control:ControlPlane,GuildId:string,UserId:string,Permission:string,Hierarchy:boolean):Promise<DiscordMember> {
  const SnapshotValue=await Control.Discord.Snapshot(GuildId);
  if(!Has(SnapshotValue,Permission)) throw new Error(`Bot lacks ${Permission}`);
  const Target=await Control.Discord.RequireGuildMember(GuildId,UserId);
  if(Hierarchy) {
    if(UserId===SnapshotValue.guild.owner_id) throw new Error('Guild owner cannot be moderated');
    const Highest=Math.max(0,...SnapshotValue.roles.filter(Role=>Target.roles.includes(Role.id)).map(Role=>Role.position));
    if(Highest>=SnapshotValue.capabilities.highestRolePosition) throw new Error('Target member is at or above the bot role hierarchy');
  }
  if(Permission==='ModerateMembers') {
    const Bits=SnapshotValue.roles.filter(Role=>Role.id===GuildId||Target.roles.includes(Role.id))
      .reduce((Mask,Role)=>Mask|BigInt(Role.permissions),0n);
    if((Bits&PermissionFlagsBits.Administrator)!==0n) throw new Error('Administrator cannot be timed out');
  }
  return Target;
}
function Modify(Control:ControlPlane,Actor:ActorIdentity,Name:string,Args:{guildId:string;userId:string},
  Permission:string,Hierarchy:boolean,Body:Record<string,unknown>,Result:Record<string,unknown>,
  Additional?:()=>Promise<void>) {
  return Control.RunDirect(Args.guildId,Actor.id,Name,Args.userId,async()=>{
    await Check(Control,Args.guildId,Args.userId,Permission,Hierarchy);
    await Additional?.();
  },async Id=>{
    await Control.Discord.Patch<DiscordMember>(`/guilds/${Args.guildId}/members/${Args.userId}`,Body,Reason(Actor,Id,Name));
    return {guildId:Args.guildId,userId:Args.userId,...Result};
  });
}
export const MemberOperations:OperationDefinition[]=[
  Define('SetMemberNickname','members','write','Set or reset one member nickname.',Member.extend({nickname:z.string().max(32).nullable()}),
    (C,A,Actor)=>Modify(C,Actor,'set-member-nickname',A,'ManageNicknames',true,{nick:A.nickname},{nickname:A.nickname}),'members.modify'),
  Define('SetMemberTimeout','moderation','destructive','Time out one exact member until a validated timestamp.',
    Member.extend({until:z.string().datetime({offset:true})}),(C,A,Actor)=>{
      const Until=new Date(A.until).getTime();
      if(Until<=Date.now()||Until>Date.now()+28*86400000) throw new Error('Timeout must be in the future and within 28 days');
      return Modify(C,Actor,'set-member-timeout',A,'ModerateMembers',true,
        {communication_disabled_until:A.until},{until:A.until});
    },'members.timeout'),
  Define('ClearMemberTimeout','moderation','destructive','Clear one exact member timeout.',Member,
    (C,A,Actor)=>Modify(C,Actor,'clear-member-timeout',A,'ModerateMembers',true,
      {communication_disabled_until:null},{until:null}),'members.timeout'),
  Define('MoveMember','members','write','Move one member to an exact voice or stage channel.',Member.extend({channelId:Snowflake}),
    (C,A,Actor)=>Modify(C,Actor,'move-member',A,'MoveMembers',false,{channel_id:A.channelId},{channelId:A.channelId},async()=>{
      const Channel=await C.Discord.RequireGuildChannel(A.guildId,A.channelId);
      if(![ChannelType.GuildVoice,ChannelType.GuildStageVoice].includes(Channel.type)) throw new Error('Target is not a voice-capable channel');
    }),'members.voice'),
  Define('DisconnectMember','members','destructive','Disconnect one exact member from voice.',Member,
    (C,A,Actor)=>Modify(C,Actor,'disconnect-member',A,'MoveMembers',false,{channel_id:null},{channelId:null}),'members.voice'),
  Define('SetMemberMute','members','write','Set one member server mute state.',Member.extend({muted:z.boolean()}),
    (C,A,Actor)=>Modify(C,Actor,'set-member-mute',A,'MuteMembers',false,{mute:A.muted},{muted:A.muted}),'members.voice'),
  Define('SetMemberDeaf','members','write','Set one member server deaf state.',Member.extend({deafened:z.boolean()}),
    (C,A,Actor)=>Modify(C,Actor,'set-member-deaf',A,'DeafenMembers',false,{deaf:A.deafened},{deafened:A.deafened}),'members.voice')
];
