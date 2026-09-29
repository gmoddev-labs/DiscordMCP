import {ChannelType,PermissionFlagsBits} from 'discord.js';
import type {DiscordChannel,DiscordGuild,DiscordMember,DiscordRole} from './discord.js';

type Overwrite={id:string;type:number;allow:string;deny:string};
export type PermissionEvidence={guild:DiscordGuild;roles:DiscordRole[];member:DiscordMember;channel?:DiscordChannel;source?:DiscordChannel;botHighestRolePosition:number};
const Flags=PermissionFlagsBits as Record<string,bigint>;
export const KnownPermissionMask=Object.values(Flags).reduce((Mask,Flag)=>Mask|BigInt(Flag),0n);
const ThreadTypes=new Set<number>([ChannelType.AnnouncementThread,ChannelType.PublicThread,ChannelType.PrivateThread]);
const Has=(Bits:bigint,Name:string)=>(Bits&Flags[Name]!)===Flags[Name]!;
function Apply(Bits:bigint,OverwriteValue:Overwrite|undefined):bigint {
  return OverwriteValue?(Bits&~BigInt(OverwriteValue.deny))|BigInt(OverwriteValue.allow):Bits;
}
export function PermissionNames(Bits:bigint):string[] {
  return Object.entries(Flags).filter(([,Flag])=>(Bits&BigInt(Flag))===BigInt(Flag)).map(([Name])=>Name).sort();
}
export function EvaluatePermissions(Evidence:PermissionEvidence) {
  const {guild,roles,member,channel,source}=Evidence;
  const GuildOwner=member.user.id===guild.owner_id;
  const RoleIds=new Set(member.roles);
  let Base=BigInt(roles.find(Role=>Role.id===guild.id)?.permissions??'0');
  for(const Role of roles) if(RoleIds.has(Role.id)) Base|=BigInt(Role.permissions);
  const Administrator=GuildOwner||Has(Base,'Administrator');
  const Warnings:string[]=[];
  const IsThread=Boolean(channel&&ThreadTypes.has(channel.type));
  const PermissionSource=IsThread?source:channel;
  if(IsThread&&!source) Warnings.push('Thread parent was not available; channel permissions are incomplete');
  if(channel?.type===ChannelType.PrivateThread) Warnings.push('Private-thread membership was not evaluated');
  let Effective=Administrator?KnownPermissionMask|Base:Base;
  const Overwrites=PermissionSource?.permission_overwrites??[];
  if(!Administrator&&PermissionSource) {
    Effective=Apply(Effective,Overwrites.find(Item=>Item.type===0&&Item.id===guild.id));
    let Deny=0n,Allow=0n;
    for(const Item of Overwrites) if(Item.type===0&&RoleIds.has(Item.id)) {Deny|=BigInt(Item.deny);Allow|=BigInt(Item.allow);}
    Effective=(Effective&~Deny)|Allow;
    Effective=Apply(Effective,Overwrites.find(Item=>Item.type===1&&Item.id===member.user.id));
  }
  if(IsThread) Effective&=~Flags.SendMessages!;
  const MemberHighestRolePosition=Math.max(0,...roles.filter(Role=>RoleIds.has(Role.id)).map(Role=>Role.position));
  const BotCanManageMember=!GuildOwner&&MemberHighestRolePosition<Evidence.botHighestRolePosition;
  const Allowed=PermissionNames(Effective);
  const Denied=PermissionNames(KnownPermissionMask&~Effective);
  if((Effective&~KnownPermissionMask)!==0n) Warnings.push('Unknown permission bits are present and retained in effectivePermissions');
  return {guildId:guild.id,userId:member.user.id,channelId:channel?.id,permissionSourceChannelId:PermissionSource?.id,
    administrator:Administrator,guildOwner:GuildOwner,roleIds:[...RoleIds],rolePermissions:Base.toString(),
    channelOverwrites:PermissionSource?Overwrites:undefined,effectivePermissions:Effective.toString(),
    allowedPermissions:Allowed,deniedPermissions:Denied,unknownPermissionBits:(Effective&~KnownPermissionMask).toString(),
    hierarchy:{memberHighestRolePosition:MemberHighestRolePosition,botHighestRolePosition:Evidence.botHighestRolePosition,botCanManageMember:BotCanManageMember},
    warnings:Warnings,confidence:Warnings.length?'partial':'complete'};
}
export function AuditRoles(Guild:DiscordGuild,Roles:DiscordRole[],Channel:DiscordChannel,Source:DiscordChannel|undefined,
  BotHighestRolePosition:number,Actions:('view'|'send'|'manage')[]=['view','send','manage'],Limit=250) {
  const Warnings=['Role-only analysis excludes multi-role combinations and member-specific overwrites'];
  if(Channel.type===ChannelType.PrivateThread) Warnings.push('Private-thread membership may change actual access');
  if(ThreadTypes.has(Channel.type)&&!Source) Warnings.push('Thread parent was not available');
  if(Roles.length>Limit) Warnings.push(`Only the first ${Limit} roles are shown`);
  const Items=Roles.slice(0,Limit).map(Role=>{
    const Member:DiscordMember={user:{id:`role:${Role.id}`,username:Role.name},roles:Role.id===Guild.id?[]:[Role.id]};
    const Result=EvaluatePermissions({guild:Guild,roles:Roles,member:Member,channel:Channel,source:Source,botHighestRolePosition:BotHighestRolePosition});
    const Bits=BigInt(Result.effectivePermissions);
    const Unknown=Channel.type===ChannelType.PrivateThread||(ThreadTypes.has(Channel.type)&&!Source);
    const View=Has(Bits,'ViewChannel');
    const Values={view:Unknown?null:View,
      send:Unknown?null:View&&Has(Bits,ThreadTypes.has(Channel.type)?'SendMessagesInThreads':'SendMessages'),
      manage:Unknown?null:View&&(Has(Bits,'ManageChannels')||Has(Bits,'ManageThreads'))};
    return {roleId:Role.id,name:Role.name,position:Role.position,managed:Role.managed,
      administrator:Result.administrator,actions:Object.fromEntries(Actions.map(Action=>[Action,Values[Action]])),
      effectivePermissions:Result.effectivePermissions};
  });
  return {guildId:Guild.id,channelId:Channel.id,permissionSourceChannelId:ThreadTypes.has(Channel.type)?Source?.id:Channel.id,
    roles:Items,summary:{totalRoles:Roles.length,returnedRoles:Items.length},warnings:Warnings,
    confidence:Warnings.some(Item=>Item.includes('not available')||Item.includes('first')||Item.includes('membership'))?'partial':'role-only'};
}
