import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChannelType} from 'discord.js';
import {ControlPlane} from '../src/control.js';
import {ChannelSpec,GuildSpec,RoleSpec} from '../src/types.js';
import {Store} from '../src/store.js';
import {DiscordAdapter,type DiscordChannel,type DiscordGuild,type DiscordMember,type DiscordMessage,type Snapshot} from '../src/discord.js';
import {Dispatch,InvokeTool,Operations,SearchTools} from '../src/interface.js';

const GuildId='123456789012345678',BotId='123456789012345679',UserId='123456789012345680';
const TextId='123456789012345681',VoiceId='123456789012345682',ForumId='123456789012345683';
const ThreadId='123456789012345684',MessageId='123456789012345685',TagId='123456789012345686';
const ForeignId='123456789012345687',RoleId='123456789012345688';
const Owner={id:'local-mcp:foundation3',kind:'local-mcp' as const};
test('blueprint specs reject unsupported fields instead of discarding them',()=>{
  assert.equal(ChannelSpec.safeParse({key:'text',name:'text',type:'text',unknownSetting:true}).success,false);
  assert.equal(GuildSpec.safeParse({icon:'unbounded-image'}).success,false);
  assert.equal(RoleSpec.safeParse({key:'role',name:'role',permissions:[],icon:'unbounded-image'}).success,false);
});
function Fixture() {
  const Directory=mkdtempSync(join(tmpdir(),'discord-f3-'));
  const Storage=new Store(join(Directory,'control.db'));
  const Guild:DiscordGuild={id:GuildId,name:'Guild',owner_id:'123456789012345699',features:['COMMUNITY']};
  const Channels:DiscordChannel[]=[
    {id:TextId,guild_id:GuildId,name:'text',type:ChannelType.GuildText},
    {id:VoiceId,guild_id:GuildId,name:'voice',type:ChannelType.GuildVoice},
    {id:ForumId,guild_id:GuildId,name:'forum',type:ChannelType.GuildForum,
      available_tags:[{id:TagId,name:'News',moderated:false}]},
    {id:ThreadId,guild_id:GuildId,name:'thread',type:ChannelType.PublicThread,parent_id:TextId,
      thread_metadata:{archived:false,locked:false}},
    {id:ForeignId,guild_id:'123456789012345698',name:'foreign',type:ChannelType.GuildText}
  ];
  const Member:DiscordMember={user:{id:UserId,username:'user'},roles:[]};
  const Requests:{method:string;path:string;body?:unknown}[]=[];
  let Failure:unknown;
  const Adapter={
    RequireGuild:(Id:string)=>{if(Id!==GuildId) throw new Error('Wrong guild');},
    RequireGuildChannel:async(Id:string,ChannelId:string)=>{
      const Item=Channels.find(Value=>Value.id===ChannelId);
      if(Id!==GuildId||!Item||Item.guild_id!==Id) throw new Error('Channel does not belong to the exact requested guild');
      return structuredClone(Item);
    },
    RequireGuildMember:async(Id:string,MemberId:string)=>{
      if(Id!==GuildId||MemberId!==UserId) throw new Error('Member not found');
      return structuredClone(Member);
    },
    GetBotUserId:()=>BotId,
    Snapshot:async()=>({guildId:GuildId,guild:structuredClone(Guild),roles:[
      {id:GuildId,name:'@everyone',permissions:'0',position:0,managed:false},
      {id:RoleId,name:'role',permissions:'0',position:1,managed:false}
    ],channels:structuredClone(Channels.filter(Item=>Item.guild_id===GuildId)),
      capabilities:{permissions:['Administrator','ManageNicknames','ModerateMembers','MoveMembers','MuteMembers','DeafenMembers'],
        highestRolePosition:10,memberList:false},completeness:{channels:'complete',threads:'none',members:'omitted',messages:'omitted'},
      omissions:[],capturedAt:new Date().toISOString()}) as Snapshot,
    Get:async(Path:string)=>{
      Requests.push({method:'GET',path:Path});
      if(Path===`/guilds/${GuildId}`) return structuredClone(Guild);
      if(Path===`/guilds/${GuildId}/roles`) return [{id:GuildId},{id:RoleId}];
      if(Path===`/guilds/${GuildId}/invites`) return [{code:'invite',guild:{id:GuildId},channel:{id:TextId}}];
      if(Path===`/channels/${TextId}/messages/${MessageId}`) return {id:MessageId,channel_id:TextId,author:{id:BotId}};
      throw new Error(`Unexpected GET ${Path}`);
    },
    Post:async(Path:string,Body:unknown)=>{
      Requests.push({method:'POST',path:Path,body:Body});if(Failure) throw Failure;
      if(Path===`/channels/${TextId}/threads`) return {id:ThreadId,name:'new-thread',type:ChannelType.PublicThread};
      if(Path===`/channels/${ForumId}/threads`) return {id:ThreadId,name:'post',message:{id:MessageId}};
      return {id:MessageId,channel_id:TextId,timestamp:new Date().toISOString(),author:{id:BotId},content:''};
    },
    Patch:async(Path:string,Body:Record<string,unknown>)=>{
      Requests.push({method:'PATCH',path:Path,body:Body});if(Failure) throw Failure;
      if(Path===`/guilds/${GuildId}`) {Object.assign(Guild,Body);return structuredClone(Guild);}
      if(Path===`/guilds/${GuildId}/members/${UserId}`) {Object.assign(Member,Body);return structuredClone(Member);}
      if(Path===`/guilds/${GuildId}/channels`) return undefined;
      const Id=Path.split('/').at(-1);
      const Item=Channels.find(Value=>Value.id===Id);if(Item) {Object.assign(Item,Body);return structuredClone(Item);}
      return {id:MessageId,edited_timestamp:new Date().toISOString()};
    },
    Delete:async(Path:string)=>{Requests.push({method:'DELETE',path:Path});if(Failure) throw Failure;}
  };
  return {Control:new ControlPlane(Adapter as unknown as DiscordAdapter,Storage),Storage,Guild,Channels,Member,Requests,
    SetFailure:(Value:unknown)=>{Failure=Value;},Close:()=>{Storage.Close();rmSync(Directory,{recursive:true,force:true});}};
}
test('guild and channel operations normalize and reject incompatible or foreign resources',async()=>{
  const F=Fixture();
  try {
    const Read=await Dispatch(F.Control,'GetGuild',{guildId:GuildId},Owner) as {guild:{name:string}};
    assert.equal(Read.guild.name,'Guild');
    await assert.rejects(Dispatch(F.Control,'ModifyGuildSettings',{guildId:GuildId,icon:'raw-image'},Owner));
    await assert.rejects(Dispatch(F.Control,'ModifyGuildSettings',{guildId:GuildId,afkChannelId:TextId},Owner),/AFK channel/);
    await Dispatch(F.Control,'ModifyGuildSettings',{guildId:GuildId,afkChannelId:VoiceId},Owner);
    assert.equal(F.Requests.at(-1)?.path,`/guilds/${GuildId}`);
    const Channel=await Dispatch(F.Control,'GetChannel',{guildId:GuildId,channelId:ForumId},Owner) as {channel:{forum:{availableTags:{id:string}[]}}};
    assert.equal(Channel.channel.forum.availableTags[0]?.id,TagId);
    await assert.rejects(Dispatch(F.Control,'ModifyChannel',{guildId:GuildId,channelId:TextId,bitrate:64000},Owner),/Voice settings/);
    await assert.rejects(Dispatch(F.Control,'ModifyChannel',{guildId:GuildId,channelId:TextId,forum:{requireTag:true}},Owner),/Forum settings/);
    await assert.rejects(Dispatch(F.Control,'SetChannelPositions',{guildId:GuildId,positions:[{channelId:TextId,parentId:ForeignId}]},Owner),/exact requested guild/);
    const Invites=await Dispatch(F.Control,'GetGuildInvites',{guildId:GuildId,limit:10},Owner) as {items:unknown[]};
    assert.equal(Invites.items.length,1);
  } finally {F.Close();}
});
test('member actions preflight permissions, hierarchy, and voice channel type',async()=>{
  const F=Fixture();
  try {
    await Dispatch(F.Control,'SetMemberNickname',{guildId:GuildId,userId:UserId,nickname:'New'},Owner);
    assert.deepEqual(F.Requests.at(-1)?.body,{nick:'New'});
    await Dispatch(F.Control,'SetMemberNickname',{guildId:GuildId,userId:UserId,nickname:null},Owner);
    await Dispatch(F.Control,'SetMemberTimeout',{guildId:GuildId,userId:UserId,until:new Date(Date.now()+3600000).toISOString()},Owner);
    await Dispatch(F.Control,'ClearMemberTimeout',{guildId:GuildId,userId:UserId},Owner);
    assert.deepEqual(F.Requests.at(-1)?.body,{communication_disabled_until:null});
    await assert.rejects(Dispatch(F.Control,'MoveMember',{guildId:GuildId,userId:UserId,channelId:TextId},Owner),/voice-capable/);
    await Dispatch(F.Control,'MoveMember',{guildId:GuildId,userId:UserId,channelId:VoiceId},Owner);
    await Dispatch(F.Control,'SetMemberMute',{guildId:GuildId,userId:UserId,muted:true},Owner);
    await Dispatch(F.Control,'SetMemberDeaf',{guildId:GuildId,userId:UserId,deafened:true},Owner);
    await Dispatch(F.Control,'DisconnectMember',{guildId:GuildId,userId:UserId},Owner);
    F.Guild.owner_id=UserId;
    await assert.rejects(Dispatch(F.Control,'SetMemberTimeout',{guildId:GuildId,userId:UserId,
      until:new Date(Date.now()+3600000).toISOString()},Owner),/owner/);
  } finally {F.Close();}
});
test('rich messages compile bounded mentions, replies, poll creation, and poll projection',async()=>{
  const F=Fixture();
  try {
    await Dispatch(F.Control,'SendMessage',{guildId:GuildId,channelId:TextId,content:'hello'},Owner);
    assert.deepEqual((F.Requests.at(-1)?.body as {allowed_mentions:unknown}).allowed_mentions,{parse:[]});
    await Dispatch(F.Control,'SendMessage',{guildId:GuildId,channelId:TextId,content:'<@&role>',
      allowedMentions:{roles:[RoleId],everyone:true},replyTo:{messageId:MessageId},
      poll:{question:'Choose',answers:[{text:'A'},{text:'B'}],durationHours:24}},Owner);
    const Body=F.Requests.at(-1)?.body as {allowed_mentions:{parse:string[];roles:string[]};message_reference:{message_id:string};poll:{duration:number}};
    assert.deepEqual(Body.allowed_mentions.parse,['everyone']);
    assert.deepEqual(Body.allowed_mentions.roles,[RoleId]);
    assert.equal(Body.message_reference.message_id,MessageId);
    assert.equal(Body.poll.duration,24);
    await assert.rejects(Dispatch(F.Control,'SendMessage',{guildId:GuildId,channelId:TextId,content:'hello',
      allowedMentions:{roles:[ForeignId]}},Owner),/Mention role/);
    await assert.rejects(Dispatch(F.Control,'SendMessage',{guildId:GuildId,channelId:TextId,
      poll:{question:'Q',answers:[{text:'Only one'}],durationHours:1}},Owner));
    const PollMessage={id:MessageId,channel_id:TextId,
      author:{id:BotId},content:'',timestamp:new Date().toISOString(),type:0,
      poll:{question:{text:'Choose'},answers:[{answer_id:7,poll_media:{text:'A'}}],allow_multiselect:false}} as DiscordMessage;
    const Project=DiscordAdapter.prototype.ProjectMessage.call(F.Control.Discord,GuildId,PollMessage);
    assert.equal(Project.poll?.answers[0]?.id,7);
  } finally {F.Close();}
});
test('thread and forum operations validate type, tags, and destructive intent',async()=>{
  const F=Fixture();
  try {
    await Dispatch(F.Control,'CreateThread',{guildId:GuildId,channelId:TextId,name:'new-thread',type:'private',invitable:false},Owner);
    assert.equal((F.Requests.at(-1)?.body as {type:number}).type,ChannelType.PrivateThread);
    await assert.rejects(Dispatch(F.Control,'CreateThread',{guildId:GuildId,channelId:ForumId,name:'wrong'},Owner),/text channel/);
    await Dispatch(F.Control,'ModifyThread',{guildId:GuildId,threadId:ThreadId,archived:true,locked:true},Owner);
    assert.equal((F.Requests.at(-1)?.body as {archived:boolean}).archived,true);
    await assert.rejects(Dispatch(F.Control,'DeleteThread',{guildId:GuildId,threadId:TextId},Owner),/not a thread/);
    await Dispatch(F.Control,'CreateForumPost',{guildId:GuildId,forumChannelId:ForumId,name:'post',content:'hello',appliedTagIds:[TagId]},Owner);
    assert.equal((F.Requests.at(-1)?.body as {applied_tags:string[]}).applied_tags[0],TagId);
    await assert.rejects(Dispatch(F.Control,'CreateForumPost',{guildId:GuildId,forumChannelId:ForumId,name:'bad',
      content:'hello',appliedTagIds:[ForeignId]},Owner),/applied tag/);
    await Dispatch(F.Control,'DeleteThread',{guildId:GuildId,threadId:ThreadId},Owner);
    assert.equal(F.Requests.at(-1)?.path,`/channels/${ThreadId}`);
    assert.ok(Operations.has('ExplainMemberPermissions'));
    assert.equal(SearchTools({query:'CreateForumPost'}).total,1);
  } finally {F.Close();}
});

test('new member mutations preserve uncertain outcomes and block further writes',async()=>{
  const F=Fixture();
  try {
    F.SetFailure(new Error('network lost'));
    await assert.rejects(Dispatch(F.Control,'SetMemberMute',{guildId:GuildId,userId:UserId,muted:true},Owner),/state=uncertain/);
    const Pending=F.Control.GetUncertainActions(GuildId);
    assert.equal(Pending.length,1);
    assert.equal(Pending[0]?.kind,'set-member-mute');
    await assert.rejects(Dispatch(F.Control,'SetMemberDeaf',{guildId:GuildId,userId:UserId,deafened:true},Owner),/uncertain mutation/);
    assert.equal(F.Requests.filter(Item=>Item.method==='PATCH').length,1);
  } finally {F.Close();}
});

test('rich payload rejects oversized embeds and preserves exact mention opt-in',async()=>{
  const F=Fixture();
  try {
    await assert.rejects(Dispatch(F.Control,'SendMessage',{guildId:GuildId,channelId:TextId,
      embeds:[{description:'x'.repeat(4000)},{description:'y'.repeat(3000)}]},Owner));
    await Dispatch(F.Control,'SendMessage',{guildId:GuildId,channelId:TextId,
      embeds:[{title:'News',description:'Update'}],components:[[{label:'Read more',url:'https://example.com'}]],
      allowedMentions:{users:[UserId]}},Owner);
    const Body=F.Requests.at(-1)?.body as {allowed_mentions:{parse:string[];users:string[]};components:{components:{style:number}[]}[]};
    assert.deepEqual(Body.allowed_mentions,{parse:[],users:[UserId]});
    assert.equal(Body.components[0]?.components[0]?.style,5);
  } finally {F.Close();}
});

test('channel mutations preserve forum tag IDs and accept voice settings',async()=>{
  const F=Fixture();
  try {
    await assert.rejects(Dispatch(F.Control,'ModifyChannel',{guildId:GuildId,channelId:ForumId,
      forum:{availableTags:[{name:'New'}]}},Owner),/exact IDs/);
    await Dispatch(F.Control,'ModifyChannel',{guildId:GuildId,channelId:ForumId,
      forum:{availableTags:[{id:TagId,name:'News',moderated:true}]}},Owner);
    const ForumBody=F.Requests.at(-1)?.body as {available_tags:{id:string;moderated:boolean}[]};
    assert.deepEqual(ForumBody.available_tags,[{id:TagId,name:'News',moderated:true,emoji_id:null,emoji_name:null}]);
    await Dispatch(F.Control,'ModifyChannel',{guildId:GuildId,channelId:VoiceId,bitrate:64000,userLimit:10},Owner);
    assert.equal((F.Requests.at(-1)?.body as {bitrate:number}).bitrate,64000);
    await Dispatch(F.Control,'SetChannelPositions',{guildId:GuildId,positions:[{channelId:TextId,position:1}]},Owner);
    assert.equal(F.Requests.at(-1)?.path,`/guilds/${GuildId}/channels`);
  } finally {F.Close();}
});

test('new operations obey progressive risk routing and the direct handler',async()=>{
  const F=Fixture();
  try {
    await assert.rejects(InvokeTool(F.Control,'read',{tool:'SetMemberMute',args:{guildId:GuildId,userId:UserId,muted:true}},Owner),
      /matching risk dispatcher/);
    assert.equal(F.Requests.length,0);
    const Result=await InvokeTool(F.Control,'write',{tool:'SetMemberMute',
      args:{guildId:GuildId,userId:UserId,muted:true}},Owner) as {muted:boolean};
    assert.equal(Result.muted,true);
    assert.equal(F.Requests.at(-1)?.path,`/guilds/${GuildId}/members/${UserId}`);
  } finally {F.Close();}
});
