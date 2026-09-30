import {z} from 'zod';
import {Snowflake} from './types.js';
import {Define,type OperationDefinition} from './registry.js';
import type {ControlPlane} from './control.js';
import type {ActorIdentity} from './assistant-types.js';
import type {Snapshot} from './discord.js';

const Guild=z.strictObject({guildId:Snowflake});
const Rule=Guild.extend({ruleId:Snowflake});
const Words=z.array(z.string().min(1).max(60)).max(100);
const Patterns=z.array(z.string().min(1).max(260)).max(10);
const Trigger=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('keyword'),keywordFilter:Words.min(1),regexPatterns:Patterns.optional(),allowList:Words.optional()}),
  z.strictObject({kind:z.literal('spam')}),
  z.strictObject({kind:z.literal('keywordPreset'),presets:z.array(z.union([z.literal(1),z.literal(2),z.literal(3)])).min(1).max(3),allowList:z.array(z.string().min(1).max(60)).max(1000).optional()}),
  z.strictObject({kind:z.literal('mentionSpam'),mentionTotalLimit:z.number().int().min(1).max(50),mentionRaidProtectionEnabled:z.boolean().optional()}),
  z.strictObject({kind:z.literal('memberProfile'),keywordFilter:Words.min(1),regexPatterns:Patterns.optional(),allowList:Words.optional()})
]);
const Action=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('blockMessage'),customMessage:z.string().max(150).optional()}),
  z.strictObject({kind:z.literal('sendAlert'),channelId:Snowflake}),
  z.strictObject({kind:z.literal('timeout'),durationSeconds:z.number().int().min(1).max(2419200)}),
  z.strictObject({kind:z.literal('blockMemberInteraction')})
]);
const Settings=z.strictObject({name:z.string().min(1).max(100),trigger:Trigger,actions:z.array(Action).min(1).max(4),
  enabled:z.boolean().optional(),exemptRoleIds:z.array(Snowflake).max(20).optional(),exemptChannelIds:z.array(Snowflake).max(50).optional()});
const Changes=z.strictObject({name:z.string().min(1).max(100).optional(),trigger:Trigger.optional(),actions:z.array(Action).min(1).max(4).optional(),
  enabled:z.boolean().optional(),exemptRoleIds:z.array(Snowflake).max(20).optional(),exemptChannelIds:z.array(Snowflake).max(50).optional()});
type TriggerInput=z.infer<typeof Trigger>;
type ActionInput=z.infer<typeof Action>;
type SettingsInput=z.infer<typeof Settings>;
type ChangesInput=z.infer<typeof Changes>;
type RuleValue={id:string;guild_id:string;name:string;creator_id?:string;event_type:number;trigger_type:number;
  trigger_metadata?:Record<string,unknown>;actions:{type:number;metadata?:Record<string,unknown>}[];enabled:boolean;
  exempt_roles?:string[];exempt_channels?:string[]};
const TriggerTypes={keyword:1,spam:3,keywordPreset:4,mentionSpam:5,memberProfile:6} as const;
const Counts:Record<number,number>={1:6,3:1,4:1,5:1,6:1};
const Path=(GuildId:string)=>`/guilds/${GuildId}/auto-moderation/rules`;
const Reason=(Actor:ActorIdentity,Id:string,Name:string)=>`DiscordControl action=${Id} actor=${Actor.id} ${Name}`;
function RequirePermission(SnapshotValue:Snapshot,Name:string):void {
  if(!SnapshotValue.capabilities.permissions.includes('Administrator')&&!SnapshotValue.capabilities.permissions.includes(Name))
    throw new Error(`Bot lacks ${Name}`);
}
function TriggerBody(Value:TriggerInput):{trigger_type:number;event_type:number;trigger_metadata:Record<string,unknown>} {
  const Metadata:Record<string,unknown>={};
  if(Value.kind==='keyword'||Value.kind==='memberProfile') {
    Metadata.keyword_filter=Value.keywordFilter;
    if(Value.regexPatterns) Metadata.regex_patterns=Value.regexPatterns;
    if(Value.allowList) Metadata.allow_list=Value.allowList;
  } else if(Value.kind==='keywordPreset') {
    Metadata.presets=Value.presets;
    if(Value.allowList) Metadata.allow_list=Value.allowList;
  } else if(Value.kind==='mentionSpam') {
    Metadata.mention_total_limit=Value.mentionTotalLimit;
    if(Value.mentionRaidProtectionEnabled!==undefined) Metadata.mention_raid_protection_enabled=Value.mentionRaidProtectionEnabled;
  }
  return {trigger_type:TriggerTypes[Value.kind],event_type:Value.kind==='memberProfile'?2:1,trigger_metadata:Metadata};
}
function ActionsBody(Values:ActionInput[]) {
  return Values.map(Value=>Value.kind==='blockMessage'?{type:1,metadata:Value.customMessage!==undefined?{custom_message:Value.customMessage}:{}}:
    Value.kind==='sendAlert'?{type:2,metadata:{channel_id:Value.channelId}}:
    Value.kind==='timeout'?{type:3,metadata:{duration_seconds:Value.durationSeconds}}:{type:4,metadata:{}});
}
function Record(Value:RuleValue) {
  return {id:Value.id,guildId:Value.guild_id,name:Value.name,creatorId:Value.creator_id,eventType:Value.event_type,
    triggerType:Value.trigger_type,triggerMetadata:Value.trigger_metadata??{},actions:Value.actions??[],
    enabled:Value.enabled,exemptRoleIds:Value.exempt_roles??[],exemptChannelIds:Value.exempt_channels??[]};
}
async function FetchRule(Control:ControlPlane,GuildId:string,RuleId:string):Promise<RuleValue> {
  const Value=await Control.Discord.Get<RuleValue>(`${Path(GuildId)}/${RuleId}`);
  if(Value.guild_id!==GuildId||Value.id!==RuleId) throw new Error('AutoMod rule does not belong to the exact guild');
  return Value;
}
async function CheckReferences(Control:ControlPlane,GuildId:string,SnapshotValue:Snapshot,Input:ChangesInput):Promise<void> {
  if(Input.exemptRoleIds) {
    if(new Set(Input.exemptRoleIds).size!==Input.exemptRoleIds.length) throw new Error('Duplicate exempt role ID');
    for(const Id of Input.exemptRoleIds) if(!SnapshotValue.roles.some(Item=>Item.id===Id)) throw new Error(`Exempt role ${Id} is absent from guild`);
  }
  if(Input.exemptChannelIds) {
    if(new Set(Input.exemptChannelIds).size!==Input.exemptChannelIds.length) throw new Error('Duplicate exempt channel ID');
    for(const Id of Input.exemptChannelIds) await Control.Discord.RequireGuildChannel(GuildId,Id);
  }
  for(const Item of Input.actions??[]) if(Item.kind==='sendAlert') await Control.Discord.RequireGuildChannel(GuildId,Item.channelId);
}
function CheckActions(TriggerType:number,Actions:ActionInput[],SnapshotValue:Snapshot):void {
  if(Actions.filter(Item=>Item.kind==='timeout').length) {
    if(TriggerType!==1&&TriggerType!==5) throw new Error('Timeout is supported only for keyword or mention-spam rules');
    RequirePermission(SnapshotValue,'ModerateMembers');
  }
  if(Actions.some(Item=>Item.kind==='blockMemberInteraction')&&TriggerType!==6)
    throw new Error('Block member interaction requires a member-profile rule');
  if(TriggerType===6&&Actions.some(Item=>Item.kind!=='blockMemberInteraction'))
    throw new Error('Member-profile rules require block member interaction');
}
function Body(Input:ChangesInput):Record<string,unknown> {
  const Value:Record<string,unknown>={};
  if(Input.name!==undefined) Value.name=Input.name;
  if(Input.enabled!==undefined) Value.enabled=Input.enabled;
  if(Input.trigger!==undefined) Object.assign(Value,TriggerBody(Input.trigger));
  if(Input.actions!==undefined) Value.actions=ActionsBody(Input.actions);
  if(Input.exemptRoleIds!==undefined) Value.exempt_roles=Input.exemptRoleIds;
  if(Input.exemptChannelIds!==undefined) Value.exempt_channels=Input.exemptChannelIds;
  return Value;
}
export const AutoModOperations:OperationDefinition[]=[
  Define('ListAutoModRules','automod','read','List bounded AutoMod rules in one exact guild.',Guild.extend({limit:z.number().int().min(1).max(100).default(100)}),async(C,A)=>{
    C.Discord.RequireGuild(A.guildId);
    const Items=await C.Discord.Get<RuleValue[]>(Path(A.guildId));
    if(Items.some(Item=>Item.guild_id!==A.guildId)) throw new Error('AutoMod response contains a foreign guild');
    return {guildId:A.guildId,items:Items.slice(0,A.limit).map(Record),total:Items.length,
      completeness:Items.length>A.limit?'truncated':'exact-fetch'};
  },'automod.read'),
  Define('GetAutoModRule','automod','read','Read one exact AutoMod rule.',Rule,async(C,A)=>{
    C.Discord.RequireGuild(A.guildId);return {rule:Record(await FetchRule(C,A.guildId,A.ruleId)),completeness:'exact-fetch'};
  },'automod.read'),
  Define('CreateAutoModRule','automod','write','Create one typed AutoMod rule with local bounds.',Guild.extend(Settings.shape),async(C,A,Actor)=>{
    const {guildId:_GuildId,...Raw}=A;
    const Input=Settings.parse(Raw) as SettingsInput;
    return C.RunDirect(A.guildId,Actor.id,'create-automod-rule',A.guildId,async()=>{
      const SnapshotValue=await C.Discord.Snapshot(A.guildId);RequirePermission(SnapshotValue,'ManageGuild');
      await CheckReferences(C,A.guildId,SnapshotValue,Input);
      const TriggerType=TriggerTypes[Input.trigger.kind];CheckActions(TriggerType,Input.actions,SnapshotValue);
      const Items=await C.Discord.Get<RuleValue[]>(Path(A.guildId));
      if(Items.some(Item=>Item.guild_id!==A.guildId)) throw new Error('AutoMod response contains a foreign guild');
      if(Items.filter(Item=>Item.trigger_type===TriggerType).length>=Counts[TriggerType]!) throw new Error('AutoMod trigger-type rule limit reached');
    },async Id=>{
      const Value=await C.Discord.Post<RuleValue>(Path(A.guildId),Body({...Input,enabled:Input.enabled??false}),Reason(Actor,Id,'create-automod-rule'));
      if(Value.guild_id!==A.guildId) throw new Error('Created AutoMod rule guild mismatch');
      return {rule:Record(Value)};
    });
  },'automod.write'),
  Define('ModifyAutoModRule','automod','write','Modify one exact AutoMod rule without changing its trigger kind.',Rule.extend({changes:Changes}),async(C,A,Actor)=>{
    const ChangesValue=Changes.parse(A.changes) as ChangesInput;
    if(!Object.values(ChangesValue).some(Value=>Value!==undefined)) throw new Error('At least one change is required');
    return C.RunDirect(A.guildId,Actor.id,'modify-automod-rule',A.ruleId,async()=>{
      const SnapshotValue=await C.Discord.Snapshot(A.guildId);RequirePermission(SnapshotValue,'ManageGuild');
      const Current=await FetchRule(C,A.guildId,A.ruleId);
      if(ChangesValue.trigger&&TriggerTypes[ChangesValue.trigger.kind]!==Current.trigger_type)
        throw new Error('AutoMod trigger kind cannot change');
      await CheckReferences(C,A.guildId,SnapshotValue,ChangesValue);
      if(ChangesValue.actions) CheckActions(Current.trigger_type,ChangesValue.actions,SnapshotValue);
      if(!ChangesValue.actions&&Current.actions.some(Item=>Item.type===3)) RequirePermission(SnapshotValue,'ModerateMembers');
    },async Id=>{
      const Value=await C.Discord.Patch<RuleValue>(`${Path(A.guildId)}/${A.ruleId}`,Body(ChangesValue),Reason(Actor,Id,'modify-automod-rule'));
      if(Value.guild_id!==A.guildId||Value.id!==A.ruleId) throw new Error('Modified AutoMod rule mismatch');
      return {rule:Record(Value)};
    });
  },'automod.write'),
  Define('DeleteAutoModRule','automod','destructive','Delete one exact AutoMod rule.',Rule,async(C,A,Actor)=>
    C.RunDirect(A.guildId,Actor.id,'delete-automod-rule',A.ruleId,async()=>{
      const SnapshotValue=await C.Discord.Snapshot(A.guildId);RequirePermission(SnapshotValue,'ManageGuild');
      await FetchRule(C,A.guildId,A.ruleId);
    },async Id=>{await C.Discord.Delete(`${Path(A.guildId)}/${A.ruleId}`,Reason(Actor,Id,'delete-automod-rule'));
      return {guildId:A.guildId,ruleId:A.ruleId,deleted:true};}),'automod.write')
];
