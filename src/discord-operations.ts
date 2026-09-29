import {z} from 'zod';
import {ChannelType} from 'discord.js';
import {Snowflake} from './types.js';
import {Define,type OperationDefinition} from './registry.js';
import type {ControlPlane} from './control.js';
import type {ActorIdentity} from './assistant-types.js';
import type {DiscordMessage} from './discord.js';
import {SendContent,EditContent,MessageBody} from './message-payload.js';

const GuildChannel=z.object({guildId:Snowflake,channelId:Snowflake});
const Message=GuildChannel.extend({messageId:Snowflake});
const Thread=z.object({guildId:Snowflake,threadId:Snowflake});
const ThreadUser=Thread.extend({userId:Snowflake});
const Timestamp=z.string().datetime({offset:true});
const Emoji=z.string().min(1).max(64).refine(Value=>{
  if (/^[A-Za-z0-9_]{2,32}:\d{17,20}$/.test(Value)) return true;
  return !/[\u0000-\u001f\u007f/%:]/.test(Value)&&/[^\x00-\x7f]/.test(Value);
},'Emoji must be Unicode or name:id for a custom emoji');
const EmojiMessage=Message.extend({emoji:Emoji});
const Reason=(Actor:ActorIdentity,Id:string,Name:string)=>`DiscordControl action=${Id} actor=${Actor.id} ${Name}`;
const SendSchema=GuildChannel.safeExtend(SendContent.shape).refine(Value=>
  Boolean(Value.content||Value.embeds?.length||Value.components?.length||Value.stickerIds?.length||Value.poll),
  'A message body is required');
const EditSchema=Message.safeExtend(EditContent.shape).refine(Value=>
  Value.content!==undefined||Value.embeds!==undefined||Value.components!==undefined,
  'An editable message field is required');
async function CheckMessagePayload(Control:ControlPlane,Args:{guildId:string;channelId:string;
  allowedMentions?:{roles?:string[]};replyTo?:{messageId:string}}) {
  await Control.Discord.RequireGuildChannel(Args.guildId,Args.channelId);
  if(Args.allowedMentions?.roles?.length) {
    const Roles=await Control.Discord.Get<{id:string}[]>(`/guilds/${Args.guildId}/roles`);
    const Ids=new Set(Roles.map(Role=>Role.id));
    if(Args.allowedMentions.roles.some(Id=>!Ids.has(Id))) throw new Error('Mention role does not belong to the exact guild');
  }
  if(Args.replyTo) {
    const Referenced=await Control.Discord.Get<DiscordMessage>(`/channels/${Args.channelId}/messages/${Args.replyTo.messageId}`);
    if(Referenced.channel_id!==Args.channelId) throw new Error('Reply target does not belong to the exact channel');
  }
}

async function ChannelMutation<T>(Control:ControlPlane,Actor:ActorIdentity,Name:string,
  Args:{guildId:string;channelId:string},TargetId:string,
  Work:(Id:string)=>Promise<T>,Check?:(Channel:{type:number})=>void):Promise<T> {
  return Control.RunDirect(Args.guildId,Actor.id,Name,TargetId,async()=>{
    const Channel=await Control.Discord.RequireGuildChannel(Args.guildId,Args.channelId);
    Check?.(Channel);
  },Work);
}
async function ThreadMutation<T>(Control:ControlPlane,Actor:ActorIdentity,Name:string,
  Args:{guildId:string;threadId:string},TargetId:string,Work:(Id:string)=>Promise<T>):Promise<T> {
  return ChannelMutation(Control,Actor,Name,{guildId:Args.guildId,channelId:Args.threadId},TargetId,Work,
    Channel=>{if(![ChannelType.AnnouncementThread,ChannelType.PublicThread,ChannelType.PrivateThread].includes(Channel.type))
      throw new Error('Exact channel is not a thread');});
}
async function ChannelRead(Control:ControlPlane,Args:{guildId:string;channelId:string}):Promise<void> {
  await Control.Discord.RequireGuildChannel(Args.guildId,Args.channelId);
}
async function ThreadRead(Control:ControlPlane,GuildId:string,ThreadId:string):Promise<void> {
  const Channel=await Control.Discord.RequireGuildChannel(GuildId,ThreadId);
  if(![ChannelType.AnnouncementThread,ChannelType.PublicThread,ChannelType.PrivateThread].includes(Channel.type))
    throw new Error('Exact channel is not a thread');
}
function Project(Control:ControlPlane,GuildId:string,Value:DiscordMessage) {
  return Control.Discord.ProjectMessage(GuildId,Value);
}
function YoungSnowflake(Id:string):boolean {
  const Created=Number((BigInt(Id)>>22n)+1420070400000n);
  return Created<=Date.now()&&Date.now()-Created<14*86400000;
}
export const DiscordOperations:OperationDefinition[]=[
  Define('SendMessage','messages','write','Send a bounded message with controlled mentions.',SendSchema,(C,A,Actor)=>
    C.RunDirect(A.guildId,Actor.id,'send-message',A.channelId,async()=>CheckMessagePayload(C,A),async Id=>{
      const Result=await C.Discord.Post<DiscordMessage>(`/channels/${A.channelId}/messages`,MessageBody(A),Reason(Actor,Id,'send-message'));
      return {guildId:A.guildId,channelId:A.channelId,messageId:Result.id,createdAt:Result.timestamp};
    }), 'messages.write'),
  Define('EditMessage','messages','write','Edit one exact bot message with bounded rich fields.',EditSchema,(C,A,Actor)=>
    C.RunDirect(A.guildId,Actor.id,'edit-message',A.messageId,async()=>{
      await CheckMessagePayload(C,A);
      const Original=await C.Discord.Get<DiscordMessage>(`/channels/${A.channelId}/messages/${A.messageId}`);
      if(Original.author.id!==C.Discord.GetBotUserId()) throw new Error('Message is not authored by this bot');
    },async Id=>{
      const Result=await C.Discord.Patch<DiscordMessage>(`/channels/${A.channelId}/messages/${A.messageId}`,
        MessageBody(A),Reason(Actor,Id,'edit-message'));
      return {guildId:A.guildId,channelId:A.channelId,messageId:Result.id,editedAt:Result.edited_timestamp};
    }), 'messages.write'),
  Define('DeleteMessage','messages','destructive','Delete one exact message.',Message,(C,A,Actor)=>
    ChannelMutation(C,Actor,'delete-message',A,A.messageId,async Id=>{
      await C.Discord.Delete(`/channels/${A.channelId}/messages/${A.messageId}`,Reason(Actor,Id,'delete-message'));
      return {guildId:A.guildId,channelId:A.channelId,messageId:A.messageId,deleted:true};
    }), 'messages.manage'),
  Define('BulkDeleteMessages','messages','destructive','Delete 2-100 recent exact messages.',GuildChannel.extend({messageIds:z.array(Snowflake).min(2).max(100)}),(C,A,Actor)=>{
    if(new Set(A.messageIds).size!==A.messageIds.length||!A.messageIds.every(YoungSnowflake))
      throw new Error('Bulk deletion needs unique message IDs newer than 14 days');
    return ChannelMutation(C,Actor,'bulk-delete-messages',A,A.channelId,async Id=>{
      await C.Discord.Post<void>(`/channels/${A.channelId}/messages/bulk-delete`,{messages:A.messageIds},Reason(Actor,Id,'bulk-delete-messages'));
      return {guildId:A.guildId,channelId:A.channelId,messageIds:A.messageIds,deleted:true};
    });
  },'messages.manage'),
  Define('GetPinnedMessages','messages','read','Read one bounded page of channel pins.',GuildChannel.extend({limit:z.number().int().min(1).max(50).default(50),before:Timestamp.optional()}),async(C,A)=>{
    await ChannelRead(C,A);
    const Query=`?limit=${A.limit}${A.before?`&before=${encodeURIComponent(A.before)}`:''}`;
    const Result=await C.Discord.Get<{items:{message:DiscordMessage;pinned_at:string}[];has_more:boolean}>(`/channels/${A.channelId}/messages/pins${Query}`);
    return {guildId:A.guildId,channelId:A.channelId,items:Result.items.map(Item=>({pinnedAt:Item.pinned_at,message:Project(C,A.guildId,Item.message)})),
      hasMore:Result.has_more,nextCursor:Result.has_more?Result.items.at(-1)?.pinned_at:undefined,completeness:'bounded-fetch'};
  },'messages.read'),
  Define('PinMessage','messages','write','Pin one exact message.',Message,(C,A,Actor)=>
    ChannelMutation(C,Actor,'pin-message',A,A.messageId,async Id=>{
      await C.Discord.RequestPut(`/channels/${A.channelId}/messages/pins/${A.messageId}`,Reason(Actor,Id,'pin-message'));
      return {guildId:A.guildId,channelId:A.channelId,messageId:A.messageId,pinned:true};
    }), 'messages.manage'),
  Define('UnpinMessage','messages','write','Unpin one exact message.',Message,(C,A,Actor)=>
    ChannelMutation(C,Actor,'unpin-message',A,A.messageId,async Id=>{
      await C.Discord.Delete(`/channels/${A.channelId}/messages/pins/${A.messageId}`,Reason(Actor,Id,'unpin-message'));
      return {guildId:A.guildId,channelId:A.channelId,messageId:A.messageId,pinned:false};
    }), 'messages.manage'),
  Define('CrosspostMessage','messages','write','Publish one announcement message.',Message,(C,A,Actor)=>
    ChannelMutation(C,Actor,'crosspost-message',A,A.messageId,async Id=>{
      const Result=await C.Discord.Post<DiscordMessage>(`/channels/${A.channelId}/messages/${A.messageId}/crosspost`,{},Reason(Actor,Id,'crosspost-message'));
      return {guildId:A.guildId,channelId:A.channelId,messageId:Result.id,crossposted:true};
    },Channel=>{if(Channel.type!==ChannelType.GuildAnnouncement) throw new Error('Channel is not an announcement channel');}), 'messages.write'),
  Define('CreateMessageThread','threads','write','Create a thread from one exact message.',Message.extend({name:z.string().min(1).max(100),autoArchiveDuration:z.union([z.literal(60),z.literal(1440),z.literal(4320),z.literal(10080)]).optional()}),(C,A,Actor)=>
    ChannelMutation(C,Actor,'create-message-thread',A,A.messageId,async Id=>{
      const Result=await C.Discord.Post<{id:string;name:string}>(`/channels/${A.channelId}/messages/${A.messageId}/threads`,
        {name:A.name,...(A.autoArchiveDuration?{auto_archive_duration:A.autoArchiveDuration}:{})},Reason(Actor,Id,'create-message-thread'));
      return {guildId:A.guildId,parentChannelId:A.channelId,messageId:A.messageId,threadId:Result.id,name:Result.name};
    },Channel=>{if(![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(Channel.type)) throw new Error('Channel cannot start a message thread');}), 'threads.manage'),
  Define('AddReaction','reactions','write','React to one exact message.',EmojiMessage,(C,A,Actor)=>
    ChannelMutation(C,Actor,'add-reaction',A,A.messageId,async Id=>{
      await C.Discord.RequestPut(`/channels/${A.channelId}/messages/${A.messageId}/reactions/${encodeURIComponent(A.emoji)}/@me`,Reason(Actor,Id,'add-reaction'));
      return {guildId:A.guildId,channelId:A.channelId,messageId:A.messageId,emoji:A.emoji,added:true};
    }), 'reactions.write'),
  Define('RemoveOwnReaction','reactions','write','Remove the bot reaction.',EmojiMessage,(C,A,Actor)=>
    ChannelMutation(C,Actor,'remove-own-reaction',A,A.messageId,async Id=>{
      await C.Discord.Delete(`/channels/${A.channelId}/messages/${A.messageId}/reactions/${encodeURIComponent(A.emoji)}/@me`,Reason(Actor,Id,'remove-own-reaction'));
      return {guildId:A.guildId,channelId:A.channelId,messageId:A.messageId,emoji:A.emoji,removed:true};
    }), 'reactions.write'),
  Define('RemoveUserReaction','reactions','destructive','Remove one user reaction.',EmojiMessage.extend({userId:Snowflake}),(C,A,Actor)=>
    ChannelMutation(C,Actor,'remove-user-reaction',A,A.messageId,async Id=>{
      await C.Discord.Delete(`/channels/${A.channelId}/messages/${A.messageId}/reactions/${encodeURIComponent(A.emoji)}/${A.userId}`,Reason(Actor,Id,'remove-user-reaction'));
      return {guildId:A.guildId,channelId:A.channelId,messageId:A.messageId,userId:A.userId,emoji:A.emoji,removed:true};
    }), 'messages.manage'),
  Define('ClearReactions','reactions','destructive','Clear all reactions from one message.',Message,(C,A,Actor)=>
    ChannelMutation(C,Actor,'clear-reactions',A,A.messageId,async Id=>{
      await C.Discord.Delete(`/channels/${A.channelId}/messages/${A.messageId}/reactions`,Reason(Actor,Id,'clear-reactions'));
      return {guildId:A.guildId,channelId:A.channelId,messageId:A.messageId,cleared:true};
    }), 'messages.manage'),
  Define('GetReactions','reactions','read','Read one bounded reaction-user page.',EmojiMessage.extend({limit:z.number().int().min(1).max(100).default(25),after:Snowflake.optional()}),async(C,A)=>{
    await ChannelRead(C,A);
    const Query=`?limit=${A.limit}${A.after?`&after=${A.after}`:''}`;
    const Users=await C.Discord.Get<{id:string;username:string}[]>(`/channels/${A.channelId}/messages/${A.messageId}/reactions/${encodeURIComponent(A.emoji)}${Query}`);
    return {guildId:A.guildId,channelId:A.channelId,messageId:A.messageId,emoji:A.emoji,users:Users.map(User=>({id:User.id,username:User.username})),
      nextCursor:Users.length===A.limit?Users.at(-1)?.id:undefined,completeness:'bounded-fetch'};
  },'messages.read'),
  Define('JoinThread','threads','write','Join one exact guild thread.',Thread,(C,A,Actor)=>
    ThreadMutation(C,Actor,'join-thread',A,A.threadId,async Id=>{await C.Discord.RequestPut(`/channels/${A.threadId}/thread-members/@me`,Reason(Actor,Id,'join-thread'));return {guildId:A.guildId,threadId:A.threadId,joined:true};}), 'threads.manage'),
  Define('LeaveThread','threads','write','Leave one exact guild thread.',Thread,(C,A,Actor)=>
    ThreadMutation(C,Actor,'leave-thread',A,A.threadId,async Id=>{await C.Discord.Delete(`/channels/${A.threadId}/thread-members/@me`,Reason(Actor,Id,'leave-thread'));return {guildId:A.guildId,threadId:A.threadId,left:true};}), 'threads.manage'),
  Define('AddThreadMember','threads','write','Add one user to a guild thread.',ThreadUser,(C,A,Actor)=>
    ThreadMutation(C,Actor,'add-thread-member',A,A.userId,async Id=>{await C.Discord.RequestPut(`/channels/${A.threadId}/thread-members/${A.userId}`,Reason(Actor,Id,'add-thread-member'));return {guildId:A.guildId,threadId:A.threadId,userId:A.userId,added:true};}), 'threads.manage'),
  Define('RemoveThreadMember','threads','destructive','Remove one user from a guild thread.',ThreadUser,(C,A,Actor)=>
    ThreadMutation(C,Actor,'remove-thread-member',A,A.userId,async Id=>{await C.Discord.Delete(`/channels/${A.threadId}/thread-members/${A.userId}`,Reason(Actor,Id,'remove-thread-member'));return {guildId:A.guildId,threadId:A.threadId,userId:A.userId,removed:true};}), 'threads.manage'),
  Define('GetThreadMember','threads','read','Read one exact thread membership.',ThreadUser,async(C,A)=>{
    await ThreadRead(C,A.guildId,A.threadId);
    const Item=await C.Discord.Get<{id?:string;user_id:string;join_timestamp:string;flags:number}>(`/channels/${A.threadId}/thread-members/${A.userId}`);
    return {guildId:A.guildId,threadId:A.threadId,userId:Item.user_id,joinedAt:Item.join_timestamp,flags:Item.flags};
  },'members.inspect'),
  Define('GetThreadMembers','threads','read','Read one bounded thread-member page.',Thread.extend({limit:z.number().int().min(1).max(100).default(100),after:Snowflake.optional()}),async(C,A)=>{
    await ThreadRead(C,A.guildId,A.threadId);
    const Query=`?limit=${A.limit}${A.after?`&after=${A.after}`:''}`;
    const Items=await C.Discord.Get<{user_id:string;join_timestamp:string;flags:number}[]>(`/channels/${A.threadId}/thread-members${Query}`);
    return {guildId:A.guildId,threadId:A.threadId,items:Items.map(Item=>({userId:Item.user_id,joinedAt:Item.join_timestamp,flags:Item.flags})),
      nextCursor:Items.length===A.limit?Items.at(-1)?.user_id:undefined,completeness:'bounded-fetch'};
  },'members.inspect')
];
