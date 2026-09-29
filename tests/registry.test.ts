import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ControlPlane} from '../src/control.js';
import {Store} from '../src/store.js';
import {DiscordError,type DiscordAdapter} from '../src/discord.js';
import {BuildMcpServer,Dispatch,InvokeTool,Operations,SearchTools} from '../src/interface.js';

const GuildId='123456789012345678';
const ChannelId='123456789012345679';
const MessageId='123456789012345680';
const UserId='123456789012345681';
const Owner={id:'local-mcp:test',kind:'local-mcp' as const,displayName:'test'};
function Fixture() {
  const Directory=mkdtempSync(join(tmpdir(),'discord-registry-'));
  const Storage=new Store(join(Directory,'control.db'));
  const Requests:{Method:string;Path:string;Body?:unknown}[]=[];
  let Failure:unknown;
  let ChannelGuild=GuildId;
  const Adapter={
    RequireGuild:(Id:string)=>{if(Id!==GuildId) throw new Error('Bot is not in the exact requested guild');},
    GetBotUserId:()=>UserId,
    Snapshot:async()=>({capabilities:{permissions:['Administrator']}}),
    RequireGuildChannel:async(_Guild:string,Id:string)=>{
      if(_Guild!==ChannelGuild) throw new Error('Channel does not belong to the exact requested guild');
      return {id:Id,guild_id:ChannelGuild,type:Id===ChannelId?0:11,name:'test'};
    },
    ProjectMessage:(_Guild:string,Value:{id:string;channel_id:string;content:string;timestamp:string})=>({id:Value.id,guildId:_Guild,channelId:Value.channel_id,content:Value.content,createdAt:Value.timestamp}),
    Post:async(Path:string,Body:unknown)=>{Requests.push({Method:'POST',Path,Body});if(Failure) throw Failure;
      if(Path.endsWith('/invites')) return {code:'alpha123',guild:{id:GuildId},channel:{id:ChannelId}};
      return {id:MessageId,channel_id:ChannelId,timestamp:new Date().toISOString(),content:''};},
    Patch:async(Path:string,Body:unknown)=>{Requests.push({Method:'PATCH',Path,Body});if(Failure) throw Failure;
      return {id:MessageId,edited_timestamp:new Date().toISOString()};},
    Delete:async(Path:string)=>{Requests.push({Method:'DELETE',Path});if(Failure) throw Failure;},
    RequestPut:async(Path:string)=>{Requests.push({Method:'PUT',Path});if(Failure) throw Failure;},
    Get:async(Path:string)=>{Requests.push({Method:'GET',Path});
      if(Path===`/channels/${ChannelId}/messages/${MessageId}`) return {id:MessageId,author:{id:UserId},channel_id:ChannelId};
      if(Path.startsWith('/invites/')) return {code:'alpha123',guild:{id:GuildId},channel:{id:ChannelId}};
      if(Path.endsWith('/invites')) return [{code:'alpha123',guild:{id:GuildId},channel:{id:ChannelId}}];
      if(Path.includes('/members/search')) return [{user:{id:UserId,username:'tester'},roles:[]}];
      if(Path.includes('/bans/')) return {user:{id:UserId,username:'tester'},reason:null};
      if(Path.includes('/bans?')) return [{user:{id:UserId,username:'tester'},reason:null}];
      if(Path.includes('/polls/')) return {users:[{id:UserId,username:'tester'}]};
      if(Path.includes('/reactions/')) return [{id:UserId,username:'tester'}];
      if(Path.includes('/thread-members')) return [{user_id:UserId,join_timestamp:new Date().toISOString(),flags:0}];
      return {items:[],has_more:false};}
  };
  const Control=new ControlPlane(Adapter as unknown as DiscordAdapter,Storage);
  return {Control,Storage,Requests,SetFailure:(Value:unknown)=>{Failure=Value;},SetChannelGuild:(Value:string)=>{ChannelGuild=Value;},
    Close:()=>{Storage.Close();rmSync(Directory,{recursive:true,force:true});}};
}

test('registry is complete and progressive search is exact, bounded, and categorized',()=>{
  assert.equal(Operations.size,new Set(Operations.keys()).size);
  for(const [Name,Item] of Operations) {
    assert.equal(Name,Item.Name);assert.ok(Item.Schema);assert.ok(Item.Handler);
    assert.ok(['read','write','destructive'].includes(Item.Risk));
  }
  const Exact=SearchTools({query:'SendMessage'});
  assert.equal(Exact.total,1);
  assert.ok((Exact.items[0] as {inputSchema?:unknown}).inputSchema);
  const Browsed=SearchTools({category:'messages',limit:2});
  assert.equal(Browsed.items.length,2);
  assert.ok(Browsed.total>2);
});

test('full and progressive MCP modes expose the expected public tools',()=>{
  const Previous=process.env.CONTROL_MCP_SURFACE;
  try {
    process.env.CONTROL_MCP_SURFACE='full';
    const Full=BuildMcpServer({} as ControlPlane,Owner) as unknown as {_registeredTools:Record<string,unknown>};
    assert.equal(Object.keys(Full._registeredTools).length,Operations.size+4);
    process.env.CONTROL_MCP_SURFACE='progressive';
    const Progressive=BuildMcpServer({} as ControlPlane,Owner) as unknown as {_registeredTools:Record<string,unknown>};
    assert.deepEqual(Object.keys(Progressive._registeredTools).sort(),
      ['PlanServer','PlanResourceMutation','ApplyPlan','VerifyServer','SearchTools','ReadTool','WriteTool','DestructiveTool'].sort());
  } finally {
    if(Previous===undefined) delete process.env.CONTROL_MCP_SURFACE;
    else process.env.CONTROL_MCP_SURFACE=Previous;
  }
});

test('progressive risk, schema, and authorization checks precede Discord execution',async()=>{
  const F=Fixture();
  try {
    const Args={guildId:GuildId,channelId:ChannelId,content:'Hello'};
    await assert.rejects(InvokeTool(F.Control,'read',{tool:'SendMessage',args:Args},Owner),/matching risk/);
    await assert.rejects(InvokeTool(F.Control,'write',{tool:'NoSuchTool',args:Args},Owner),/Unknown operation/);
    await assert.rejects(InvokeTool(F.Control,'write',{tool:'SendMessage',args:{...Args,content:''}},Owner));
    await assert.rejects(InvokeTool(F.Control,'write',{tool:'SendMessage',args:Args},{id:'discord-user:x',kind:'discord-user',externalId:UserId}),/configured operator/);
    assert.equal(F.Requests.length,0);
    const Result=await InvokeTool(F.Control,'write',{tool:'SendMessage',args:Args},Owner) as {messageId:string};
    assert.equal(Result.messageId,MessageId);
    assert.deepEqual(F.Requests[0]?.Body,{content:'Hello',allowed_mentions:{parse:[]}});
  } finally {F.Close();}
});

test('channel mismatch blocks mutation; ambiguous send holds the guild without replay',async()=>{
  const F=Fixture();
  try {
    F.SetChannelGuild(UserId);
    await assert.rejects(Dispatch(F.Control,'SendMessage',{guildId:GuildId,channelId:ChannelId,content:'Hi'},Owner),/exact requested guild/);
    assert.equal(F.Requests.length,0);
    F.SetChannelGuild(GuildId);
    F.SetFailure(new Error('network lost after send'));
    await assert.rejects(Dispatch(F.Control,'SendMessage',{guildId:GuildId,channelId:ChannelId,content:'Hi'},Owner),/state=uncertain/);
    assert.equal(F.Storage.ListUncertainActions(GuildId).length,1);
    await assert.rejects(Dispatch(F.Control,'SendMessage',{guildId:GuildId,channelId:ChannelId,content:'Again'},Owner),/active or uncertain/);
    assert.equal(F.Requests.filter(Item=>Item.Method==='POST').length,1);
  } finally {F.Close();}
});

test('deterministic rejection records failure and reaction route encodes emoji',async()=>{
  const F=Fixture();
  try {
    F.SetFailure(new DiscordError(403,'50013','Missing permissions'));
    await assert.rejects(Dispatch(F.Control,'DeleteMessage',{guildId:GuildId,channelId:ChannelId,messageId:MessageId},Owner),/state=failed/);
    assert.equal(F.Storage.ListUncertainActions(GuildId).length,0);
    F.SetFailure(undefined);
    await Dispatch(F.Control,'AddReaction',{guildId:GuildId,channelId:ChannelId,messageId:MessageId,emoji:'👍'},Owner);
    assert.ok(F.Requests.at(-1)?.Path.includes('%F0%9F%91%8D'));
  } finally {F.Close();}
});

test('thread member reads and bulk deletion validate bounds',async()=>{
  const F=Fixture();
  try {
    const Page=await Dispatch(F.Control,'GetThreadMembers',{guildId:GuildId,threadId:UserId,limit:5},Owner) as {items:unknown[];completeness:string};
    assert.equal(Page.items.length,1);assert.equal(Page.completeness,'bounded-fetch');
    await assert.rejects(Dispatch(F.Control,'BulkDeleteMessages',{guildId:GuildId,channelId:ChannelId,messageIds:[MessageId,MessageId]},Owner));
    const Recent=((BigInt(Date.now()-1420070400000)<<22n)+1n).toString();
    await Dispatch(F.Control,'BulkDeleteMessages',{guildId:GuildId,channelId:ChannelId,messageIds:[Recent,(BigInt(Recent)+1n).toString()]},Owner);
    assert.ok(F.Requests.at(-1)?.Path.endsWith('/messages/bulk-delete'));
  } finally {F.Close();}
});

test('community reads stay exact and bounded; invite deletion verifies guild',async()=>{
  const F=Fixture();
  try {
    const Members=await Dispatch(F.Control,'SearchMembers',{guildId:GuildId,query:'test',limit:5},Owner) as {items:unknown[]};
    assert.equal(Members.items.length,1);
    assert.ok(F.Requests.at(-1)?.Path.includes('query=test&limit=5'));
    const Bans=await Dispatch(F.Control,'GetBans',{guildId:GuildId,limit:5},Owner) as {items:unknown[]};
    assert.equal(Bans.items.length,1);
    const Invite=await Dispatch(F.Control,'GetInvite',{guildId:GuildId,code:'alpha123'},Owner) as {invite:{code:string}};
    assert.equal(Invite.invite.code,'alpha123');
    await assert.rejects(Dispatch(F.Control,'GetInvite',{guildId:UserId,code:'alpha123'},Owner));
    await Dispatch(F.Control,'DeleteInvite',{guildId:GuildId,code:'alpha123'},Owner);
    assert.equal(F.Requests.at(-1)?.Path,'/invites/alpha123');
  } finally {F.Close();}
});

test('poll voters paginate and bot-owned edit uses exact message preflight',async()=>{
  const F=Fixture();
  try {
    const Voters=await Dispatch(F.Control,'GetPollVoters',{guildId:GuildId,channelId:ChannelId,messageId:MessageId,answerId:2,limit:5},Owner) as {users:unknown[]};
    assert.equal(Voters.users.length,1);
    await Dispatch(F.Control,'EditMessage',{guildId:GuildId,channelId:ChannelId,messageId:MessageId,content:'Updated'},Owner);
    assert.equal(F.Requests.at(-1)?.Method,'PATCH');
    assert.equal(F.Requests.at(-1)?.Path,`/channels/${ChannelId}/messages/${MessageId}`);
  } finally {F.Close();}
});

test('invite, unban, and poll mutations use exact routes and return identifiers',async()=>{
  const F=Fixture();
  try {
    const Invite=await Dispatch(F.Control,'CreateInvite',{guildId:GuildId,channelId:ChannelId,maxUses:1},Owner) as {code:string;channelId:string};
    assert.equal(Invite.code,'alpha123');assert.equal(Invite.channelId,ChannelId);
    assert.equal(F.Requests.at(-1)?.Path,`/channels/${ChannelId}/invites`);
    const Ban=await Dispatch(F.Control,'UnbanMember',{guildId:GuildId,userId:UserId},Owner) as {unbanned:boolean};
    assert.equal(Ban.unbanned,true);
    assert.equal(F.Requests.at(-1)?.Path,`/guilds/${GuildId}/bans/${UserId}`);
    const Poll=await Dispatch(F.Control,'EndPoll',{guildId:GuildId,channelId:ChannelId,messageId:MessageId},Owner) as {ended:boolean};
    assert.equal(Poll.ended,true);
    assert.equal(F.Requests.at(-1)?.Path,`/channels/${ChannelId}/polls/${MessageId}/expire`);
  } finally {F.Close();}
});
