import {ChannelType,PermissionFlagsBits} from 'discord.js';
import {z} from 'zod';
import {Snowflake} from './types.js';
import {Hash} from './structural.js';
import {EvaluatePermissions} from './permissions.js';
import {OperationalError} from './authorization.js';
import {Define,type OperationDefinition} from './registry.js';
import type {ControlPlane} from './control.js';
import type {ActorIdentity} from './assistant-types.js';
import type {Snapshot} from './discord.js';

const Guild=z.strictObject({guildId:Snowflake});
const HashSchema=z.string().regex(/^[a-f0-9]{64}$/);
const OptionChange=z.strictObject({id:Snowflake.optional(),title:z.string().min(1).max(100).optional(),
  description:z.string().max(100).nullable().optional(),channelIds:z.array(Snowflake).max(50).optional(),
  roleIds:z.array(Snowflake).max(50).optional(),emojiId:Snowflake.nullable().optional(),
  emojiName:z.string().max(100).nullable().optional(),emojiAnimated:z.boolean().optional()});
const PromptChange=z.strictObject({id:Snowflake.optional(),title:z.string().min(1).max(100).optional(),
  type:z.union([z.literal(0),z.literal(1)]).optional(),singleSelect:z.boolean().optional(),
  required:z.boolean().optional(),inOnboarding:z.boolean().optional(),
  optionChanges:z.strictObject({upsert:z.array(OptionChange).max(50).optional(),removeIds:z.array(Snowflake).max(50).optional()}).optional()});
const Changes=z.strictObject({upsert:z.array(PromptChange).max(50).optional(),removeIds:z.array(Snowflake).max(50).optional()});
const Modify=Guild.extend({expectedStateHash:HashSchema,enabled:z.boolean().optional(),mode:z.union([z.literal(0),z.literal(1)]).optional(),
  defaultChannelIds:z.array(Snowflake).max(100).optional(),promptChanges:Changes.optional()});
type Option={id?:string;title:string;description:string|null;channel_ids:string[];role_ids:string[];
  emoji_id:string|null;emoji_name:string|null;emoji_animated:boolean};
type Prompt={id?:string;title:string;type:number;single_select:boolean;required:boolean;in_onboarding:boolean;options:Option[]};
type Onboarding={guild_id:string;enabled:boolean;mode:number;default_channel_ids:string[];prompts:Prompt[]};
const Path=(GuildId:string)=>`/guilds/${GuildId}/onboarding`;
const Reason=(Actor:ActorIdentity,Id:string)=>`DiscordControl action=${Id} actor=${Actor.id} modify-onboarding`;
function RequirePermission(SnapshotValue:Snapshot,Name:string):void {
  if(!SnapshotValue.capabilities.permissions.includes('Administrator')&&!SnapshotValue.capabilities.permissions.includes(Name))
    throw new Error(`Bot lacks ${Name}`);
}
function RequireCommunity(SnapshotValue:Snapshot):void {
  if(!SnapshotValue.guild.features?.includes('COMMUNITY'))
    throw new OperationalError('COMMUNITY_REQUIRED','Guild Community feature must be enabled manually',SnapshotValue.guildId);
}
function Unique(Ids:string[],Label:string):void {
  if(new Set(Ids).size!==Ids.length) throw new Error(`Duplicate ${Label} IDs`);
}
function NormalizeOption(Value:Option):Option {
  const Emoji=(Value as Option&{emoji?:{id?:string|null;name?:string|null;animated?:boolean}}).emoji;
  return {id:Value.id,title:Value.title,description:Value.description??null,
    channel_ids:Value.channel_ids??[],role_ids:Value.role_ids??[],emoji_id:Value.emoji_id??Emoji?.id??null,
    emoji_name:Value.emoji_name??Emoji?.name??null,emoji_animated:Value.emoji_animated??Emoji?.animated??false};
}
function Normalize(Value:Onboarding):Onboarding {
  return {guild_id:Value.guild_id,enabled:Value.enabled??false,mode:Value.mode??0,
    default_channel_ids:Value.default_channel_ids??[],prompts:(Value.prompts??[]).map(Item=>({id:Item.id,title:Item.title,
      type:Item.type,single_select:Item.single_select,required:Item.required,in_onboarding:Item.in_onboarding,
      options:(Item.options??[]).map(NormalizeOption)}))};
}
async function Fetch(Control:ControlPlane,GuildId:string):Promise<Onboarding> {
  const Value=await Control.Discord.Get<Onboarding>(Path(GuildId));
  if(Value.guild_id!==GuildId) throw new Error('Onboarding response guild mismatch');
  return Normalize(Value);
}
type PromptInput=z.infer<typeof PromptChange>;
type OptionInput=z.infer<typeof OptionChange>;
function UpdateOption(Current:Option|undefined,Change:OptionInput):Option {
  if(!Current&&!Change.title) throw new Error('New onboarding option requires a title');
  return {id:Current?.id,title:Change.title??Current!.title,description:Change.description===undefined?Current?.description??null:Change.description,
    channel_ids:Change.channelIds??Current?.channel_ids??[],role_ids:Change.roleIds??Current?.role_ids??[],
    emoji_id:Change.emojiId===undefined?Current?.emoji_id??null:Change.emojiId,
    emoji_name:Change.emojiName===undefined?Current?.emoji_name??null:Change.emojiName,
    emoji_animated:Change.emojiAnimated??Current?.emoji_animated??false};
}
function UpdatePrompt(Current:Prompt|undefined,Change:PromptInput):Prompt {
  if(!Current&&(Change.title===undefined||Change.type===undefined)) throw new Error('New onboarding prompt requires title and type');
  const Options=[...(Current?.options??[])];
  const Removed=Change.optionChanges?.removeIds??[];Unique(Removed,'removed option');
  for(const Id of Removed) {
    const Index=Options.findIndex(Item=>Item.id===Id);
    if(Index<0) throw new Error(`Onboarding option ${Id} is absent`);
    Options.splice(Index,1);
  }
  for(const Item of Change.optionChanges?.upsert??[]) {
    if(Item.id&&Removed.includes(Item.id)) throw new Error('Cannot upsert and remove the same onboarding option');
    const Index=Item.id?Options.findIndex(Value=>Value.id===Item.id):-1;
    if(Item.id&&Index<0) throw new Error(`Onboarding option ${Item.id} is absent`);
    const Updated=UpdateOption(Index<0?undefined:Options[Index],Item);
    if(Index<0) Options.push(Updated);else Options[Index]=Updated;
  }
  return {id:Current?.id,title:Change.title??Current!.title,type:Change.type??Current!.type,
    single_select:Change.singleSelect??Current?.single_select??false,
    required:Change.required??Current?.required??false,in_onboarding:Change.inOnboarding??Current?.in_onboarding??true,options:Options};
}
function ApplyChanges(Current:Onboarding,Args:z.infer<typeof Modify>):Onboarding {
  const Prompts=structuredClone(Current.prompts);
  const Removed=Args.promptChanges?.removeIds??[];Unique(Removed,'removed prompt');
  for(const Id of Removed) {
    const Index=Prompts.findIndex(Item=>Item.id===Id);
    if(Index<0) throw new Error(`Onboarding prompt ${Id} is absent`);
    Prompts.splice(Index,1);
  }
  for(const Item of Args.promptChanges?.upsert??[]) {
    if(Item.id&&Removed.includes(Item.id)) throw new Error('Cannot upsert and remove the same onboarding prompt');
    const Index=Item.id?Prompts.findIndex(Value=>Value.id===Item.id):-1;
    if(Item.id&&Index<0) throw new Error(`Onboarding prompt ${Item.id} is absent`);
    const Updated=UpdatePrompt(Index<0?undefined:Prompts[Index],Item);
    if(Index<0) Prompts.push(Updated);else Prompts[Index]=Updated;
  }
  const DefaultIds=Args.defaultChannelIds??Current.default_channel_ids;
  Unique(DefaultIds,'default channel');
  return {guild_id:Current.guild_id,enabled:Args.enabled??Current.enabled,mode:Args.mode??Current.mode,
    default_channel_ids:DefaultIds,prompts:Prompts};
}
function Writable(SnapshotValue:Snapshot,ChannelId:string):boolean {
  const Channel=SnapshotValue.channels.find(Item=>Item.id===ChannelId);
  if(!Channel||![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(Channel.type)) return false;
  const Result=EvaluatePermissions({guild:SnapshotValue.guild,roles:SnapshotValue.roles,
    member:{user:{id:'onboarding-everyone',username:'@everyone'},roles:[]},channel:Channel,
    botHighestRolePosition:SnapshotValue.capabilities.highestRolePosition});
  const Bits=BigInt(Result.effectivePermissions);
  return (Bits&PermissionFlagsBits.ViewChannel)!==0n&&(Bits&PermissionFlagsBits.SendMessages)!==0n;
}
async function Validate(Control:ControlPlane,GuildId:string,SnapshotValue:Snapshot,Value:Onboarding):Promise<void> {
  if(Value.prompts.length>50) throw new Error('Too many onboarding prompts');
  const ChannelIds=new Set(Value.default_channel_ids);
  for(const Prompt of Value.prompts) {
    if(Prompt.options.length>50) throw new Error('Too many onboarding options');
    for(const Option of Prompt.options) {
      Unique(Option.channel_ids,'onboarding option channel');Unique(Option.role_ids,'onboarding option role');
      for(const Id of Option.channel_ids) ChannelIds.add(Id);
      for(const Id of Option.role_ids) {
        const Role=SnapshotValue.roles.find(Item=>Item.id===Id);
        if(!Role||Role.id===GuildId||Role.managed||Role.position>=SnapshotValue.capabilities.highestRolePosition)
          throw new Error(`Onboarding role ${Id} cannot be assigned by the bot`);
      }
    }
  }
  for(const Id of ChannelIds) await Control.Discord.RequireGuildChannel(GuildId,Id);
  if(Value.enabled) {
    const Eligible=Value.mode===1?new Set([...Value.default_channel_ids,...Value.prompts.flatMap(Item=>Item.options.flatMap(Option=>Option.channel_ids))]):new Set(Value.default_channel_ids);
    if(Eligible.size<7) throw new Error('Enabled onboarding requires at least 7 eligible channels');
    if([...Eligible].filter(Id=>Writable(SnapshotValue,Id)).length<5)
      throw new Error('Enabled onboarding requires 5 channels writable by @everyone');
  }
}
function Body(Value:Onboarding) {
  return {enabled:Value.enabled,mode:Value.mode,default_channel_ids:Value.default_channel_ids,
    prompts:Value.prompts.map(Prompt=>({...(Prompt.id?{id:Prompt.id}:{}),title:Prompt.title,type:Prompt.type,
      single_select:Prompt.single_select,required:Prompt.required,in_onboarding:Prompt.in_onboarding,
      options:Prompt.options.map(Option=>({...(Option.id?{id:Option.id}:{}),title:Option.title,
        description:Option.description,channel_ids:Option.channel_ids,role_ids:Option.role_ids,
        emoji_id:Option.emoji_id,emoji_name:Option.emoji_name,emoji_animated:Option.emoji_animated}))}))};
}
function Matches(Expected:Onboarding,Observed:Onboarding):boolean {
  if(Expected.guild_id!==Observed.guild_id||Expected.enabled!==Observed.enabled||Expected.mode!==Observed.mode||
    Hash(Expected.default_channel_ids)!==Hash(Observed.default_channel_ids)||Expected.prompts.length!==Observed.prompts.length) return false;
  return Expected.prompts.every((Prompt,Index)=>{
    const Actual=Observed.prompts[Index];
    if(!Actual||(Prompt.id&&Prompt.id!==Actual.id)||Prompt.title!==Actual.title||Prompt.type!==Actual.type||
      Prompt.single_select!==Actual.single_select||Prompt.required!==Actual.required||
      Prompt.in_onboarding!==Actual.in_onboarding||Prompt.options.length!==Actual.options.length) return false;
    return Prompt.options.every((Option,OptionIndex)=>{
      const ActualOption=Actual.options[OptionIndex];
      return Boolean(ActualOption&&(!Option.id||Option.id===ActualOption.id)&&Option.title===ActualOption.title&&
        Option.description===ActualOption.description&&Hash(Option.channel_ids)===Hash(ActualOption.channel_ids)&&
        Hash(Option.role_ids)===Hash(ActualOption.role_ids)&&Option.emoji_id===ActualOption.emoji_id&&
        Option.emoji_name===ActualOption.emoji_name&&Option.emoji_animated===ActualOption.emoji_animated);
    });
  });
}
export const CommunityConfigOperations:OperationDefinition[]=[
  Define('GetOnboarding','community','read','Read onboarding with exact IDs and a stable state hash.',Guild,async(C,A)=>{
    C.Discord.RequireGuild(A.guildId);
    const Value=await Fetch(C,A.guildId);return {guildId:A.guildId,onboarding:Value,stateHash:Hash(Value),completeness:'exact-fetch'};
  },'community.read'),
  Define('ModifyOnboarding','community','write','Patch onboarding prompts and options by exact ID with a state hash.',Modify,async(C,A,Actor)=>{
    if(!Object.entries(A).some(([Key,Value])=>!['guildId','expectedStateHash'].includes(Key)&&Value!==undefined))
      throw new Error('At least one onboarding change is required');
    let Desired:Onboarding;
    return C.RunDirect(A.guildId,Actor.id,'modify-onboarding',A.guildId,async()=>{
      const SnapshotValue=await C.Discord.Snapshot(A.guildId);RequireCommunity(SnapshotValue);
      RequirePermission(SnapshotValue,'ManageGuild');RequirePermission(SnapshotValue,'ManageRoles');
      const Current=await Fetch(C,A.guildId);
      if(Hash(Current)!==A.expectedStateHash) throw new OperationalError('STATE_STALE','Onboarding state changed; read it again',A.guildId);
      Desired=ApplyChanges(Current,A);await Validate(C,A.guildId,SnapshotValue,Desired);
    },async Id=>{
      await C.Discord.RequestPut(Path(A.guildId),Reason(Actor,Id),Body(Desired));
      const Actual=await Fetch(C,A.guildId);
      if(!Matches(Desired,Actual)) throw new Error('Onboarding result verification failed');
      return {guildId:A.guildId,onboarding:Actual,stateHash:Hash(Actual),verified:true};
    });
  },'community.write')
];
