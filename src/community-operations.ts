import {z} from 'zod';
import {Snowflake} from './types.js';
import {Define,type OperationDefinition} from './registry.js';
import type {ControlPlane} from './control.js';
import type {ActorIdentity} from './assistant-types.js';
import type {DiscordMember,DiscordMessage} from './discord.js';

const Guild=z.object({guildId:Snowflake});
const User=Guild.extend({userId:Snowflake});
const Channel=Guild.extend({channelId:Snowflake});
const Message=Channel.extend({messageId:Snowflake});
const InviteCode=z.string().regex(/^[A-Za-z0-9-]{2,64}$/);
const Invite=Guild.extend({code:InviteCode});
type InviteValue={code:string;guild?:{id:string};channel?:{id:string};max_age?:number;max_uses?:number;uses?:number;temporary?:boolean;created_at?:string};
type BanValue={reason?:string|null;user:{id:string;username?:string}};
const Reason=(Actor:ActorIdentity,Id:string,Name:string)=>`DiscordControl action=${Id} actor=${Actor.id} ${Name}`;
const MemberRecord=(GuildId:string,Value:DiscordMember)=>({guildId:GuildId,userId:Value.user.id,username:Value.user.username,
  bot:Value.user.bot??false,nick:Value.nick??null,roleIds:Value.roles});
const BanRecord=(GuildId:string,Value:BanValue)=>({guildId:GuildId,userId:Value.user.id,username:Value.user.username,reason:Value.reason??null});
const InviteRecord=(GuildId:string,Value:InviteValue)=>({guildId:GuildId,channelId:Value.channel?.id,code:Value.code,
  url:`https://discord.gg/${Value.code}`,maxAge:Value.max_age,maxUses:Value.max_uses,uses:Value.uses,
  temporary:Value.temporary,createdAt:Value.created_at});
function ExactInvite(GuildId:string,Value:InviteValue):void {
  if(Value.guild?.id!==GuildId) throw new Error('Invite does not belong to the exact requested guild');
}
async function GuildRead(Control:ControlPlane,GuildId:string):Promise<void> {Control.Discord.RequireGuild(GuildId);}

export const CommunityOperations:OperationDefinition[]=[
  Define('GetMember','members','read','Fetch one exact guild member.',User,async(C,A)=>{
    await GuildRead(C,A.guildId);
    const Item=await C.Discord.Get<DiscordMember>(`/guilds/${A.guildId}/members/${A.userId}`);
    return {member:MemberRecord(A.guildId,Item),completeness:'exact-fetch'};
  },'members.inspect'),
  Define('SearchMembers','members','read','Search a bounded page by username or nickname prefix.',Guild.extend({query:z.string().min(1).max(100),limit:z.number().int().min(1).max(100).default(25)}),async(C,A)=>{
    await GuildRead(C,A.guildId);
    const Items=await C.Discord.Get<DiscordMember[]>(`/guilds/${A.guildId}/members/search?query=${encodeURIComponent(A.query)}&limit=${A.limit}`);
    return {guildId:A.guildId,items:Items.map(Item=>MemberRecord(A.guildId,Item)),completeness:'bounded-fetch'};
  },'members.inspect'),
  Define('GetBan','moderation','read','Fetch one exact guild ban.',User,async(C,A)=>{
    await GuildRead(C,A.guildId);
    const Item=await C.Discord.Get<BanValue>(`/guilds/${A.guildId}/bans/${A.userId}`);
    return {ban:BanRecord(A.guildId,Item),completeness:'exact-fetch'};
  },'moderation.ban'),
  Define('GetBans','moderation','read','Read one bounded page of guild bans.',Guild.extend({limit:z.number().int().min(1).max(100).default(100),after:Snowflake.optional()}),async(C,A)=>{
    await GuildRead(C,A.guildId);
    const Query=`?limit=${A.limit}${A.after?`&after=${A.after}`:''}`;
    const Items=await C.Discord.Get<BanValue[]>(`/guilds/${A.guildId}/bans${Query}`);
    return {guildId:A.guildId,items:Items.map(Item=>BanRecord(A.guildId,Item)),
      nextCursor:Items.length===A.limit?Items.at(-1)?.user.id:undefined,completeness:'bounded-fetch'};
  },'moderation.ban'),
  Define('UnbanMember','moderation','destructive','Remove one exact guild ban.',User,(C,A,Actor)=>
    C.RunDirect(A.guildId,Actor.id,'unban-member',A.userId,async()=>{
      await GuildRead(C,A.guildId);
      const Snapshot=await C.Discord.Snapshot(A.guildId);
      if(!Snapshot.capabilities.permissions.some(Name=>Name==='Administrator'||Name==='BanMembers'))
        throw new Error('Bot lacks BAN_MEMBERS');
      await C.Discord.Get<BanValue>(`/guilds/${A.guildId}/bans/${A.userId}`);
    },async Id=>{
      await C.Discord.Delete(`/guilds/${A.guildId}/bans/${A.userId}`,Reason(Actor,Id,'unban-member'));
      return {guildId:A.guildId,userId:A.userId,unbanned:true};
    }), 'moderation.ban'),
  Define('CreateInvite','invites','write','Create one channel invite with bounded settings.',Channel.extend({
    maxAge:z.number().int().min(0).max(604800).default(86400),maxUses:z.number().int().min(0).max(100).default(0),
    temporary:z.boolean().default(false),unique:z.boolean().default(false)
  }),(C,A,Actor)=>C.RunDirect(A.guildId,Actor.id,'create-invite',A.channelId,async()=>{
    await C.Discord.RequireGuildChannel(A.guildId,A.channelId);
  },async Id=>{
    const Item=await C.Discord.Post<InviteValue>(`/channels/${A.channelId}/invites`,
      {max_age:A.maxAge,max_uses:A.maxUses,temporary:A.temporary,unique:A.unique},Reason(Actor,Id,'create-invite'));
    return InviteRecord(A.guildId,Item);
  }), 'invites.manage'),
  Define('GetInvite','invites','read','Fetch one exact invite belonging to the guild.',Invite,async(C,A)=>{
    await GuildRead(C,A.guildId);
    const Item=await C.Discord.Get<InviteValue>(`/invites/${A.code}`);
    ExactInvite(A.guildId,Item);
    return {invite:InviteRecord(A.guildId,Item),completeness:'exact-fetch'};
  },'invites.manage'),
  Define('GetChannelInvites','invites','read','Read channel invites with an explicit output cap.',Channel.extend({limit:z.number().int().min(1).max(100).default(100)}),async(C,A)=>{
    await C.Discord.RequireGuildChannel(A.guildId,A.channelId);
    const Items=await C.Discord.Get<InviteValue[]>(`/channels/${A.channelId}/invites`);
    for(const Item of Items) {
      if(Item.guild&&Item.guild.id!==A.guildId) throw new Error('Invite does not belong to the exact requested guild');
      if(Item.channel&&Item.channel.id!==A.channelId) throw new Error('Invite does not belong to the exact requested channel');
    }
    return {guildId:A.guildId,channelId:A.channelId,items:Items.slice(0,A.limit).map(Item=>InviteRecord(A.guildId,Item)),
      completeness:Items.length>A.limit?'truncated':'exact-fetch',total:Items.length};
  },'invites.manage'),
  Define('DeleteInvite','invites','destructive','Delete one invite after verifying its guild.',Invite,(C,A,Actor)=>
    C.RunDirect(A.guildId,Actor.id,'delete-invite',A.code,async()=>{
      await GuildRead(C,A.guildId);
      const Item=await C.Discord.Get<InviteValue>(`/invites/${A.code}`);
      ExactInvite(A.guildId,Item);
    },async Id=>{
      await C.Discord.Delete(`/invites/${A.code}`,Reason(Actor,Id,'delete-invite'));
      return {guildId:A.guildId,code:A.code,deleted:true};
    }), 'invites.manage'),
  Define('EndPoll','polls','destructive','End one exact bot-owned poll.',Message,(C,A,Actor)=>
    C.RunDirect(A.guildId,Actor.id,'end-poll',A.messageId,async()=>{
      await C.Discord.RequireGuildChannel(A.guildId,A.channelId);
      const Original=await C.Discord.Get<DiscordMessage>(`/channels/${A.channelId}/messages/${A.messageId}`);
      if(Original.author.id!==C.Discord.GetBotUserId()) throw new Error('Poll message is not authored by this bot');
    },async Id=>{
      const Item=await C.Discord.Post<DiscordMessage>(`/channels/${A.channelId}/polls/${A.messageId}/expire`,{},Reason(Actor,Id,'end-poll'));
      return {guildId:A.guildId,channelId:A.channelId,messageId:Item.id,ended:true};
    }), 'messages.manage'),
  Define('GetPollVoters','polls','read','Read one bounded page of voters for an answer.',Message.extend({
    answerId:z.number().int().min(1).max(10),limit:z.number().int().min(1).max(100).default(25),after:Snowflake.optional()
  }),async(C,A)=>{
    await C.Discord.RequireGuildChannel(A.guildId,A.channelId);
    const Query=`?limit=${A.limit}${A.after?`&after=${A.after}`:''}`;
    const Result=await C.Discord.Get<{users:{id:string;username:string}[]}>(
      `/channels/${A.channelId}/polls/${A.messageId}/answers/${A.answerId}${Query}`);
    return {guildId:A.guildId,channelId:A.channelId,messageId:A.messageId,answerId:A.answerId,
      users:Result.users.map(Item=>({id:Item.id,username:Item.username})),
      nextCursor:Result.users.length===A.limit?Result.users.at(-1)?.id:undefined,completeness:'bounded-fetch'};
  },'messages.read')
];
