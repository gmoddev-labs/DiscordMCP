import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DiscordError,type DiscordAdapter,type Snapshot} from '../src/discord.js';
import {ControlPlane} from '../src/control.js';
import {Store} from '../src/store.js';
import {Dispatch} from '../src/interface.js';

const GuildId='123456789012345678',RuleId='123456789012345679',ChannelId='123456789012345680';
const ForeignId='123456789012345681',RoleId='123456789012345682';
const PromptId='123456789012345683',OptionId='123456789012345684';
const Actor={id:'local-mcp:foundation4a',kind:'local-mcp' as const};
function Fixture() {
  const Directory=mkdtempSync(join(tmpdir(),'discord-f4a-'));
  const StoreValue=new Store(join(Directory,'control.db'));
  const Requests:{method:string;path:string;body?:any}[]=[];
  const Permissions=['ManageGuild','ModerateMembers'];
  const Rules:any[]=[];
  const Guild={id:GuildId,features:['COMMUNITY']};
  const Onboarding:any={guild_id:GuildId,enabled:false,mode:0,default_channel_ids:[ChannelId],prompts:[
    {id:PromptId,title:'Projects',type:0,single_select:false,required:false,in_onboarding:true,options:[
      {id:OptionId,title:'Engine',description:'Existing',channel_ids:[ChannelId],role_ids:[RoleId],emoji_id:null,emoji_name:null,emoji_animated:false}
    ]}
  ]};
  const Welcome:any={description:'Welcome',welcome_channels:[{channel_id:ChannelId,description:'Start here',emoji_id:null,emoji_name:null}]};
  const Widget:any={enabled:false,channel_id:null};
  let Failure:unknown;
  const Adapter={
    RequireGuild:(Id:string)=>{if(Id!==GuildId) throw new Error('Wrong guild');},
    RequireGuildChannel:async(Id:string,Channel:string)=>{
      if(Id!==GuildId||Channel!==ChannelId) throw new Error('Channel does not belong to the exact requested guild');
      return {id:ChannelId,guild_id:GuildId,type:0};
    },
    Snapshot:async()=>({guildId:GuildId,guild:structuredClone(Guild),
      roles:[{id:GuildId,name:'@everyone',permissions:'0',position:0,managed:false},{id:RoleId,name:'role',permissions:'0',position:1,managed:false}],
      channels:[{id:ChannelId,guild_id:GuildId,name:'text',type:0}],capabilities:{permissions:Permissions,highestRolePosition:10,memberList:false},
      completeness:{channels:'complete',threads:'none',members:'omitted',messages:'omitted'},omissions:[],capturedAt:new Date().toISOString()}) as Snapshot,
    Get:async(Path:string)=>{
      Requests.push({method:'GET',path:Path});
      if(Path===`/guilds/${GuildId}/auto-moderation/rules`) return structuredClone(Rules);
      if(Path===`/guilds/${GuildId}/onboarding`) return structuredClone(Onboarding);
      if(Path===`/guilds/${GuildId}`) return structuredClone(Guild);
      if(Path===`/guilds/${GuildId}/welcome-screen`) return structuredClone(Welcome);
      if(Path===`/guilds/${GuildId}/widget`) return structuredClone(Widget);
      if(Path.endsWith(`/${RuleId}`)) return structuredClone(Rules.find(Item=>Item.id===RuleId));
      throw new Error(`Unexpected GET ${Path}`);
    },
    Post:async(Path:string,Body:any)=>{
      Requests.push({method:'POST',path:Path,body:Body});if(Failure) throw Failure;
      const Value={id:RuleId,guild_id:GuildId,name:Body.name,trigger_type:Body.trigger_type,event_type:Body.event_type,
        trigger_metadata:Body.trigger_metadata,actions:Body.actions,enabled:Body.enabled,
        exempt_roles:Body.exempt_roles??[],exempt_channels:Body.exempt_channels??[]};
      Rules.push(Value);return structuredClone(Value);
    },
    Patch:async(Path:string,Body:any)=>{
      Requests.push({method:'PATCH',path:Path,body:Body});if(Failure) throw Failure;
      if(Path===`/guilds/${GuildId}/welcome-screen`) {
        Object.assign(Welcome,Body);
        Guild.features=Body.enabled?['COMMUNITY','WELCOME_SCREEN_ENABLED']:['COMMUNITY'];
        return structuredClone(Welcome);
      }
      if(Path===`/guilds/${GuildId}/widget`) {Object.assign(Widget,Body);return structuredClone(Widget);}
      Object.assign(Rules[0],Body);return structuredClone(Rules[0]);
    },
    Delete:async(Path:string)=>{Requests.push({method:'DELETE',path:Path});if(Failure) throw Failure;Rules.splice(0,1);}
    ,RequestPut:async(Path:string,_Reason:string,Body:any)=>{
      Requests.push({method:'PUT',path:Path,body:Body});if(Failure) throw Failure;
      if(Path===`/guilds/${GuildId}/onboarding`) Object.assign(Onboarding,Body);
    },
    Put:async(Path:string,Body:any)=>{Requests.push({method:'PUT',path:Path,body:Body});if(Failure) throw Failure;
      return {invites_disabled_until:Body.invites_disabled_until??null,dms_disabled_until:Body.dms_disabled_until??null};}
  };
  return {Control:new ControlPlane(Adapter as unknown as DiscordAdapter,StoreValue),Rules,Permissions,Requests,Guild,Onboarding,Welcome,Widget,
    SetFailure:(Value:unknown)=>{Failure=Value;},Close:()=>{StoreValue.Close();rmSync(Directory,{recursive:true,force:true});}};
}
test('AutoMod typed creation, exact references, limits, and direct-action uncertainty',async()=>{
  const F=Fixture();
  try {
    const Base={guildId:GuildId,name:'filter',trigger:{kind:'keyword',keywordFilter:['spam']},actions:[{kind:'blockMessage'}]};
    await assert.rejects(Dispatch(F.Control,'CreateAutoModRule',{...Base,exemptChannelIds:[ForeignId]},Actor),/exact requested guild/);
    await assert.rejects(Dispatch(F.Control,'CreateAutoModRule',{...Base,trigger:{kind:'spam'},actions:[{kind:'timeout',durationSeconds:60}]},Actor),/Timeout/);
    await assert.rejects(Dispatch(F.Control,'CreateAutoModRule',{...Base,actions:[{kind:'sendAlert',channelId:ForeignId}]},Actor),/exact requested guild/);
    const Created=await Dispatch(F.Control,'CreateAutoModRule',Base,Actor) as {rule:{id:string;enabled:boolean}};
    assert.equal(Created.rule.id,RuleId);assert.equal(Created.rule.enabled,false);
    assert.equal(F.Requests.find(Item=>Item.method==='POST')?.body.trigger_type,1);
    await assert.rejects(Dispatch(F.Control,'ModifyAutoModRule',{guildId:GuildId,ruleId:RuleId,changes:{trigger:{kind:'spam'}}},Actor),/trigger kind/);
    await Dispatch(F.Control,'ModifyAutoModRule',{guildId:GuildId,ruleId:RuleId,changes:{enabled:true}},Actor);
    assert.equal((await Dispatch(F.Control,'GetAutoModRule',{guildId:GuildId,ruleId:RuleId},Actor) as any).rule.enabled,true);
    F.SetFailure(new DiscordError(0,'NETWORK','disconnected'));
    await assert.rejects(Dispatch(F.Control,'DeleteAutoModRule',{guildId:GuildId,ruleId:RuleId},Actor),/state=uncertain/);
    await assert.rejects(Dispatch(F.Control,'ModifyAutoModRule',{guildId:GuildId,ruleId:RuleId,changes:{enabled:false}},Actor),/uncertain mutation/);
  } finally {F.Close();}
});
test('onboarding hash prevents stale writes; prompt and option patch preserves omitted state',async()=>{
  const F=Fixture();
  try {
    F.Permissions.push('ManageRoles');
    const Initial=await Dispatch(F.Control,'GetOnboarding',{guildId:GuildId},Actor) as any;
    await assert.rejects(Dispatch(F.Control,'ModifyOnboarding',{guildId:GuildId,expectedStateHash:'0'.repeat(64),enabled:true},Actor),/state changed/);
    await assert.rejects(Dispatch(F.Control,'ModifyOnboarding',{guildId:GuildId,expectedStateHash:Initial.stateHash,
      defaultChannelIds:[ForeignId]},Actor),/exact requested guild/);
    const Updated=await Dispatch(F.Control,'ModifyOnboarding',{guildId:GuildId,expectedStateHash:Initial.stateHash,
      promptChanges:{upsert:[{id:PromptId,title:'Projects and tools'}]}},Actor) as any;
    assert.equal(Updated.verified,true);
    assert.equal(Updated.onboarding.prompts[0].options[0].id,OptionId);
    assert.equal(Updated.onboarding.prompts[0].options[0].description,'Existing');
    await Dispatch(F.Control,'ModifyOnboarding',{guildId:GuildId,expectedStateHash:Updated.stateHash,
      promptChanges:{upsert:[{id:PromptId,optionChanges:{removeIds:[OptionId]}}]}},Actor);
    assert.equal(F.Onboarding.prompts[0].options.length,0);
  } finally {F.Close();}
});
test('onboarding requires Community, roles permission, and enabling constraints',async()=>{
  const F=Fixture();
  try {
    const Initial=await Dispatch(F.Control,'GetOnboarding',{guildId:GuildId},Actor) as any;
    F.Guild.features=[];
    await assert.rejects(Dispatch(F.Control,'ModifyOnboarding',{guildId:GuildId,expectedStateHash:Initial.stateHash,enabled:true},Actor),
      (Error:any)=>Error.code==='COMMUNITY_REQUIRED');
    F.Guild.features=['COMMUNITY'];
    await assert.rejects(Dispatch(F.Control,'ModifyOnboarding',{guildId:GuildId,expectedStateHash:Initial.stateHash,enabled:true},Actor),/ManageRoles/);
    F.Permissions.push('ManageRoles');
    await assert.rejects(Dispatch(F.Control,'ModifyOnboarding',{guildId:GuildId,expectedStateHash:Initial.stateHash,enabled:true},Actor),/7 eligible/);
    assert.equal(F.Requests.filter(Item=>Item.method==='PUT').length,0);
  } finally {F.Close();}
});
test('welcome screen hash, explicit channel replacement, and exact channel checks',async()=>{
  const F=Fixture();
  try {
    const Initial=await Dispatch(F.Control,'GetWelcomeScreen',{guildId:GuildId},Actor) as any;
    await assert.rejects(Dispatch(F.Control,'ModifyWelcomeScreen',{guildId:GuildId,expectedStateHash:'0'.repeat(64),
      description:'New welcome'},Actor),/changed/);
    await assert.rejects(Dispatch(F.Control,'ModifyWelcomeScreen',{guildId:GuildId,expectedStateHash:Initial.stateHash,
      channels:[{channelId:ForeignId,description:'Foreign'}]},Actor),/exact requested guild/);
    const Result=await Dispatch(F.Control,'ModifyWelcomeScreen',{guildId:GuildId,expectedStateHash:Initial.stateHash,
      description:'New welcome'},Actor) as any;
    assert.equal(Result.verified,true);
    assert.equal(Result.welcomeScreen.channels[0].channelId,ChannelId);
    const Replaced=await Dispatch(F.Control,'ModifyWelcomeScreen',{guildId:GuildId,expectedStateHash:Result.stateHash,
      channels:[]},Actor) as any;
    assert.equal(Replaced.welcomeScreen.channels.length,0);
  } finally {F.Close();}
});
test('widget and incident actions validate exact channel and 24-hour bounds',async()=>{
  const F=Fixture();
  try {
    await assert.rejects(Dispatch(F.Control,'ModifyGuildWidget',{guildId:GuildId,channelId:ForeignId},Actor),/exact requested guild/);
    const Widget=await Dispatch(F.Control,'ModifyGuildWidget',{guildId:GuildId,enabled:true,channelId:ChannelId},Actor) as any;
    assert.equal(Widget.widget.channelId,ChannelId);
    const TooFar=new Date(Date.now()+25*3600000).toISOString();
    await assert.rejects(Dispatch(F.Control,'ModifyGuildIncidentActions',{guildId:GuildId,disableInvitesUntil:TooFar},Actor),/24 hours/);
    const Until=new Date(Date.now()+3600000).toISOString();
    const Incident=await Dispatch(F.Control,'ModifyGuildIncidentActions',{guildId:GuildId,disableInvitesUntil:Until,
      disableDmsUntil:null},Actor) as any;
    assert.equal(Incident.verified,true);
    assert.equal(F.Requests.at(-1)?.body.dms_disabled_until,null);
  } finally {F.Close();}
});
test('AutoMod timeout needs ModerateMembers and trigger count limits apply before POST',async()=>{
  const F=Fixture();
  try {
    F.Permissions.splice(F.Permissions.indexOf('ModerateMembers'),1);
    await assert.rejects(Dispatch(F.Control,'CreateAutoModRule',{guildId:GuildId,name:'timeout',
      trigger:{kind:'keyword',keywordFilter:['spam']},actions:[{kind:'timeout',durationSeconds:60}]},Actor),/ModerateMembers/);
    F.Rules.push({id:RuleId,guild_id:GuildId,name:'spam',trigger_type:3,event_type:1,actions:[{type:1}],enabled:false});
    await assert.rejects(Dispatch(F.Control,'CreateAutoModRule',{guildId:GuildId,name:'spam',trigger:{kind:'spam'},
      actions:[{kind:'blockMessage'}]},Actor),/limit reached/);
    assert.equal(F.Requests.filter(Item=>Item.method==='POST').length,0);
  } finally {F.Close();}
});
