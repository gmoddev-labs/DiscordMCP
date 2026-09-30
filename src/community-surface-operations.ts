import {z} from 'zod';
import {Snowflake} from './types.js';
import {Hash} from './structural.js';
import {OperationalError} from './authorization.js';
import {Define,type OperationDefinition} from './registry.js';
import type {ControlPlane} from './control.js';
import type {ActorIdentity} from './assistant-types.js';
import type {DiscordGuild,Snapshot} from './discord.js';

const Guild=z.strictObject({guildId:Snowflake});
const HashSchema=z.string().regex(/^[a-f0-9]{64}$/);
const WelcomeChannel=z.strictObject({channelId:Snowflake,description:z.string().min(1).max(100),
  emojiId:Snowflake.nullable().optional(),emojiName:z.string().max(100).nullable().optional()});
const WelcomeChange=Guild.extend({expectedStateHash:HashSchema,enabled:z.boolean().optional(),
  description:z.string().max(140).nullable().optional(),welcomeChannels:z.array(WelcomeChannel).max(5).optional()});
const WidgetChange=Guild.extend({enabled:z.boolean().optional(),channelId:Snowflake.nullable().optional()});
const IncidentChange=Guild.extend({disableInvitesUntil:z.string().datetime({offset:true}).nullable().optional(),
  disableDmsUntil:z.string().datetime({offset:true}).nullable().optional()});
type Welcome={description:string|null;welcome_channels:{channel_id:string;description:string;emoji_id:string|null;emoji_name:string|null}[]};
type Widget={enabled:boolean;channel_id:string|null};
type Incident={invites_disabled_until:string|null;dms_disabled_until:string|null};
const Reason=(Actor:ActorIdentity,Id:string,Name:string)=>`DiscordControl action=${Id} actor=${Actor.id} ${Name}`;
function RequirePermission(SnapshotValue:Snapshot):void {
  if(!SnapshotValue.capabilities.permissions.includes('Administrator')&&!SnapshotValue.capabilities.permissions.includes('ManageGuild'))
    throw new Error('Bot lacks ManageGuild');
}
function RequireCommunity(SnapshotValue:Snapshot):void {
  if(!SnapshotValue.guild.features?.includes('COMMUNITY'))
    throw new OperationalError('COMMUNITY_REQUIRED','Guild Community feature must be enabled manually',SnapshotValue.guildId);
}
function NormalizeWelcome(GuildValue:DiscordGuild,Value:Welcome) {
  return {enabled:GuildValue.features?.includes('WELCOME_SCREEN_ENABLED')??false,description:Value.description??null,
    welcomeChannels:(Value.welcome_channels??[]).map(Item=>({channelId:Item.channel_id,description:Item.description,
      emojiId:Item.emoji_id??null,emojiName:Item.emoji_name??null}))};
}
async function FetchWelcome(Control:ControlPlane,GuildId:string) {
  const [GuildValue,Value]=await Promise.all([Control.Discord.Get<DiscordGuild>(`/guilds/${GuildId}`),
    Control.Discord.Get<Welcome>(`/guilds/${GuildId}/welcome-screen`)]);
  if(GuildValue.id!==GuildId) throw new Error('Welcome screen guild mismatch');
  return NormalizeWelcome(GuildValue,Value);
}
function NormalizeWidget(Value:Widget) {return {enabled:Value.enabled,channelId:Value.channel_id??null};}
function CheckUntil(Value:string|null|undefined,Name:string):void {
  if(Value===undefined||Value===null) return;
  const Delta=Date.parse(Value)-Date.now();
  if(!Number.isFinite(Delta)||Delta<=0||Delta>86400000) throw new Error(`${Name} must be in the future within 24 hours`);
}
function SameTime(Expected:string|null,Actual:string|null):boolean {
  return Expected===null?Actual===null:Actual!==null&&Date.parse(Expected)===Date.parse(Actual);
}
export const CommunitySurfaceOperations:OperationDefinition[]=[
  Define('GetWelcomeScreen','community','read','Read the welcome screen and a stable state hash.',Guild,async(C,A)=>{
    C.Discord.RequireGuild(A.guildId);
    const Value=await FetchWelcome(C,A.guildId);
    return {guildId:A.guildId,welcomeScreen:Value,stateHash:Hash(Value),completeness:'exact-fetch'};
  },'community.read'),
  Define('ModifyWelcomeScreen','community','write','Modify welcome content with an exact state hash; channels replace the full list.',WelcomeChange,async(C,A,Actor)=>{
    if(A.enabled===undefined&&A.description===undefined&&A.welcomeChannels===undefined) throw new Error('At least one welcome-screen change is required');
    let Desired:ReturnType<typeof NormalizeWelcome>;
    return C.RunDirect(A.guildId,Actor.id,'modify-welcome-screen',A.guildId,async()=>{
      const SnapshotValue=await C.Discord.Snapshot(A.guildId);RequireCommunity(SnapshotValue);RequirePermission(SnapshotValue);
      const Current=await FetchWelcome(C,A.guildId);
      if(Hash(Current)!==A.expectedStateHash) throw new OperationalError('STATE_STALE','Welcome screen changed; read it again',A.guildId);
      if(A.welcomeChannels) {
        if(new Set(A.welcomeChannels.map((Item:typeof A.welcomeChannels[number])=>Item.channelId)).size!==A.welcomeChannels.length)
          throw new Error('Duplicate welcome-screen channel ID');
        for(const Item of A.welcomeChannels) await C.Discord.RequireGuildChannel(A.guildId,Item.channelId);
      }
      Desired={enabled:A.enabled??Current.enabled,description:A.description===undefined?Current.description:A.description,
        welcomeChannels:A.welcomeChannels?.map((Item:typeof A.welcomeChannels[number])=>({channelId:Item.channelId,description:Item.description,
          emojiId:Item.emojiId??null,emojiName:Item.emojiName??null}))??Current.welcomeChannels};
    },async Id=>{
      await C.Discord.Patch<Welcome>(`/guilds/${A.guildId}/welcome-screen`,{
        enabled:Desired.enabled,description:Desired.description,welcome_channels:Desired.welcomeChannels.map(Item=>({
          channel_id:Item.channelId,description:Item.description,emoji_id:Item.emojiId,emoji_name:Item.emojiName}))},
      Reason(Actor,Id,'modify-welcome-screen'));
      const Actual=await FetchWelcome(C,A.guildId);
      if(Hash(Actual)!==Hash(Desired)) throw new Error('Welcome-screen result verification failed');
      return {guildId:A.guildId,welcomeScreen:Actual,stateHash:Hash(Actual),verified:true};
    });
  },'community.write'),
  Define('GetGuildWidgetSettings','community','read','Read guild widget settings.',Guild,async(C,A)=>{
    C.Discord.RequireGuild(A.guildId);
    return {guildId:A.guildId,widget:NormalizeWidget(await C.Discord.Get<Widget>(`/guilds/${A.guildId}/widget`)),completeness:'exact-fetch'};
  },'community.read'),
  Define('ModifyGuildWidget','community','write','Modify enabled state or exact widget channel.',WidgetChange,async(C,A,Actor)=>{
    if(A.enabled===undefined&&A.channelId===undefined) throw new Error('At least one widget change is required');
    return C.RunDirect(A.guildId,Actor.id,'modify-guild-widget',A.guildId,async()=>{
      const SnapshotValue=await C.Discord.Snapshot(A.guildId);RequirePermission(SnapshotValue);
      if(A.channelId) await C.Discord.RequireGuildChannel(A.guildId,A.channelId);
    },async Id=>{
      await C.Discord.Patch<Widget>(`/guilds/${A.guildId}/widget`,{
        ...(A.enabled!==undefined?{enabled:A.enabled}:{}),...(A.channelId!==undefined?{channel_id:A.channelId}:{})},
      Reason(Actor,Id,'modify-guild-widget'));
      const Actual=NormalizeWidget(await C.Discord.Get<Widget>(`/guilds/${A.guildId}/widget`));
      if(A.enabled!==undefined&&Actual.enabled!==A.enabled||A.channelId!==undefined&&Actual.channelId!==A.channelId)
        throw new Error('Widget result verification failed');
      return {guildId:A.guildId,widget:Actual,verified:true};
    });
  },'community.write'),
  Define('ModifyGuildIncidentActions','community','destructive','Disable invites or DMs for at most 24 hours; null restores them.',IncidentChange,async(C,A,Actor)=>{
    if(A.disableInvitesUntil===undefined&&A.disableDmsUntil===undefined) throw new Error('At least one incident action is required');
    CheckUntil(A.disableInvitesUntil,'disableInvitesUntil');CheckUntil(A.disableDmsUntil,'disableDmsUntil');
    return C.RunDirect(A.guildId,Actor.id,'modify-guild-incident-actions',A.guildId,async()=>{
      const SnapshotValue=await C.Discord.Snapshot(A.guildId);RequirePermission(SnapshotValue);
      CheckUntil(A.disableInvitesUntil,'disableInvitesUntil');CheckUntil(A.disableDmsUntil,'disableDmsUntil');
    },async Id=>{
      const Result=await C.Discord.Put<Incident>(`/guilds/${A.guildId}/incident-actions`,{
        ...(A.disableInvitesUntil!==undefined?{invites_disabled_until:A.disableInvitesUntil}:{}),
        ...(A.disableDmsUntil!==undefined?{dms_disabled_until:A.disableDmsUntil}:{})},
      Reason(Actor,Id,'modify-guild-incident-actions'));
      if(A.disableInvitesUntil!==undefined&&!SameTime(A.disableInvitesUntil,Result.invites_disabled_until)||
        A.disableDmsUntil!==undefined&&!SameTime(A.disableDmsUntil,Result.dms_disabled_until))
        throw new Error('Incident-action response verification failed');
      return {guildId:A.guildId,incidentActions:{disableInvitesUntil:Result.invites_disabled_until,
        disableDmsUntil:Result.dms_disabled_until},verified:true};
    });
  },'community.incidents')
];
