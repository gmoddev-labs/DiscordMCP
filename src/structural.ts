import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { createHash } from 'node:crypto';
import type { Channel, Role, GuildDesired } from './types.js';
import type { DiscordChannel, DiscordRole } from './discord.js';
import {ChannelSettingsBody} from './channel-settings.js';

export const ChannelTypes:Record<Channel['type'],number> = {
  category:ChannelType.GuildCategory,text:ChannelType.GuildText,voice:ChannelType.GuildVoice,
  forum:ChannelType.GuildForum,announcement:ChannelType.GuildAnnouncement,
  stage:ChannelType.GuildStageVoice,media:ChannelType.GuildMedia
};
export function Hash(Value:unknown):string {return createHash('sha256').update(JSON.stringify(Value)).digest('hex');}
export function Bits(Names:string[]):string {
  let Result=0n;
  for (const Name of Names) {
    const Key=Name.toLowerCase().split('_').map((Part,Index)=>Index?Part[0]?.toUpperCase()+Part.slice(1):Part).join('');
    const Actual=Key[0]?.toUpperCase()+Key.slice(1);
    const Bit=(PermissionFlagsBits as Record<string,bigint>)[Actual];
    if (Bit===undefined) throw new Error(`Unknown permission ${Name}`);
    Result|=Bit;
  }
  return Result.toString();
}
export function CanonicalOverwrites(Items:DiscordChannel['permission_overwrites'] = []) {
  return (Items??[]).map(Item=>({id:Item.id,type:Item.type,allow:String(BigInt(Item.allow)),deny:String(BigInt(Item.deny))}))
    .sort((A,B)=>A.id.localeCompare(B.id)||A.type-B.type);
}
export function RoleState(Item:DiscordRole,Spec?:Role) {
  return {name:Item.name,permissions:String(BigInt(Item.permissions)),hoist:Item.hoist??false,
    mentionable:Item.mentionable??false,color:Item.color??0,
    ...(Spec?.unicodeEmoji!==undefined?{unicode_emoji:Item.unicode_emoji??null}:{})};
}
export function DesiredRole(Spec:Role) {
  return {name:Spec.name,permissions:Bits(Spec.permissions),hoist:Spec.hoist??false,
    mentionable:Spec.mentionable??false,color:Spec.color??0,
    ...(Spec.unicodeEmoji!==undefined?{unicode_emoji:Spec.unicodeEmoji}:{})};
}
function ForumTagState(Item:DiscordChannel,Spec:Channel) {
  const Wanted=Spec.forum?.availableTags;
  return Wanted?.map(Tag=>{
    const Actual=Tag.id?Item.available_tags?.find(Entry=>Entry.id===Tag.id):
      Item.available_tags?.find(Entry=>Entry.name===Tag.name);
    return {id:Tag.id,name:Actual?.name??null,moderated:Actual?.moderated??false,
      emoji_id:Actual?.emoji_id??null,emoji_name:Actual?.emoji_name??null};
  });
}
function WantedTagState(Spec:Channel) {
  return Spec.forum?.availableTags?.map(Tag=>({id:Tag.id,name:Tag.name,moderated:Tag.moderated??false,
    emoji_id:Tag.emoji?.id??null,emoji_name:Tag.emoji?.name??null}));
}
export function ChannelState(Item:DiscordChannel,Spec?:Channel) {
  const Forum=Spec?.forum;
  return {name:Item.name,type:Item.type,parent_id:Item.parent_id??null,
    topic:Item.topic??null,nsfw:Item.nsfw??false,
    permission_overwrites:CanonicalOverwrites(Item.permission_overwrites),
    ...(Spec?.position!==undefined?{position:Item.position??0}:{}),
    ...(Spec?.rateLimitPerUser!==undefined?{rate_limit_per_user:Item.rate_limit_per_user??0}:{}),
    ...(Spec?.bitrate!==undefined?{bitrate:Item.bitrate??null}:{}),
    ...(Spec?.userLimit!==undefined?{user_limit:Item.user_limit??0}:{}),
    ...(Spec?.rtcRegion!==undefined?{rtc_region:Item.rtc_region??null}:{}),
    ...(Spec?.videoQualityMode!==undefined?{video_quality_mode:Item.video_quality_mode??null}:{}),
    ...(Spec?.defaultAutoArchiveDuration!==undefined?{default_auto_archive_duration:Item.default_auto_archive_duration??null}:{}),
    ...(Spec?.defaultThreadRateLimitPerUser!==undefined?{default_thread_rate_limit_per_user:Item.default_thread_rate_limit_per_user??0}:{}),
    ...(Forum?.availableTags!==undefined?{available_tags:ForumTagState(Item,Spec!)}:{}),
    ...(Forum?.defaultReactionEmoji!==undefined?{default_reaction_emoji:Item.default_reaction_emoji?
      {emoji_id:Item.default_reaction_emoji.emoji_id??null,emoji_name:Item.default_reaction_emoji.emoji_name??null}:null}:{}),
    ...(Forum?.defaultSortOrder!==undefined?{default_sort_order:Item.default_sort_order??null}:{}),
    ...(Forum?.defaultForumLayout!==undefined?{default_forum_layout:Item.default_forum_layout??0}:{}),
    ...(Forum?.requireTag!==undefined?{require_tag:((Item.flags??0)&16)!==0}:{})};
}
export function DesiredChannel(Spec:Channel,GuildId:string,RoleIds:Record<string,string>,ChannelIds:Record<string,string>,Current?:DiscordChannel) {
  const Parent=Spec.parent?ChannelIds[Spec.parent]:undefined;
  if (Spec.parent&&!Parent) throw new Error(`Category ${Spec.parent} is not mapped`);
  const Overwrites=Spec.overwrites.map(Entry=>{
    const Id=Entry.target==='@everyone'?GuildId:RoleIds[Entry.target];
    if (!Id) throw new Error(`Role ${Entry.target} is not mapped`);
    return {id:Id,type:0,allow:Bits(Entry.allow),deny:Bits(Entry.deny)};
  });
  const Settings=ChannelSettingsBody(ChannelTypes[Spec.type],Spec,Current);
  return {name:Spec.name,type:ChannelTypes[Spec.type],parent_id:Parent??null,
    topic:Spec.topic??null,nsfw:Spec.nsfw??false,
    permission_overwrites:CanonicalOverwrites(Overwrites),
    ...(Spec.position!==undefined?{position:Spec.position}:{}),
    ...(Spec.rateLimitPerUser!==undefined?{rate_limit_per_user:Spec.rateLimitPerUser}:{}),
    ...(Spec.bitrate!==undefined?{bitrate:Spec.bitrate}:{}),
    ...(Spec.userLimit!==undefined?{user_limit:Spec.userLimit}:{}),
    ...(Spec.rtcRegion!==undefined?{rtc_region:Spec.rtcRegion}:{}),
    ...(Spec.videoQualityMode!==undefined?{video_quality_mode:Spec.videoQualityMode}:{}),
    ...(Spec.defaultAutoArchiveDuration!==undefined?{default_auto_archive_duration:Spec.defaultAutoArchiveDuration}:{}),
    ...(Spec.defaultThreadRateLimitPerUser!==undefined?{default_thread_rate_limit_per_user:Spec.defaultThreadRateLimitPerUser}:{}),
    ...(Spec.forum?.availableTags!==undefined?{available_tags:WantedTagState(Spec)}:{}),
    ...(Spec.forum?.defaultReactionEmoji!==undefined?{default_reaction_emoji:Settings.default_reaction_emoji}:{}),
    ...(Spec.forum?.defaultSortOrder!==undefined?{default_sort_order:Spec.forum.defaultSortOrder}:{}),
    ...(Spec.forum?.defaultForumLayout!==undefined?{default_forum_layout:Spec.forum.defaultForumLayout}:{}),
    ...(Spec.forum?.requireTag!==undefined?{require_tag:Spec.forum.requireTag}:{})};
}
export function GuildState(Item:{name:string;description?:string|null;afk_channel_id?:string|null;afk_timeout?:number;
  system_channel_id?:string|null;system_channel_flags?:number;verification_level?:number;default_message_notifications?:number;
  explicit_content_filter?:number;preferred_locale?:string;rules_channel_id?:string|null;public_updates_channel_id?:string|null;
  safety_alerts_channel_id?:string|null},Spec:GuildDesired) {
  const State:Record<string,unknown>={};
  if(Spec.name!==undefined) State.name=Item.name;
  if(Spec.description!==undefined) State.description=Item.description??null;
  if(Spec.afkChannel!==undefined) State.afk_channel_id=Item.afk_channel_id??null;
  if(Spec.afkTimeout!==undefined) State.afk_timeout=Item.afk_timeout;
  if(Spec.systemChannel!==undefined) State.system_channel_id=Item.system_channel_id??null;
  if(Spec.systemChannelFlags!==undefined) State.system_channel_flags=Item.system_channel_flags;
  if(Spec.verificationLevel!==undefined) State.verification_level=Item.verification_level;
  if(Spec.defaultMessageNotifications!==undefined) State.default_message_notifications=Item.default_message_notifications;
  if(Spec.explicitContentFilter!==undefined) State.explicit_content_filter=Item.explicit_content_filter;
  if(Spec.preferredLocale!==undefined) State.preferred_locale=Item.preferred_locale;
  if(Spec.rulesChannel!==undefined) State.rules_channel_id=Item.rules_channel_id??null;
  if(Spec.publicUpdatesChannel!==undefined) State.public_updates_channel_id=Item.public_updates_channel_id??null;
  if(Spec.safetyAlertsChannel!==undefined) State.safety_alerts_channel_id=Item.safety_alerts_channel_id??null;
  return State;
}
export function DesiredGuild(Spec:GuildDesired,ChannelIds:Record<string,string>) {
  const Body:Record<string,unknown>={};
  for(const [Key,Field] of Object.entries({name:'name',description:'description',afkTimeout:'afk_timeout',
    systemChannelFlags:'system_channel_flags',verificationLevel:'verification_level',
    defaultMessageNotifications:'default_message_notifications',explicitContentFilter:'explicit_content_filter',
    preferredLocale:'preferred_locale'})) {
    const Value=Spec[Key as keyof GuildDesired];if(Value!==undefined) Body[Field]=Value;
  }
  for(const [Key,Field] of Object.entries({afkChannel:'afk_channel_id',systemChannel:'system_channel_id',
    rulesChannel:'rules_channel_id',publicUpdatesChannel:'public_updates_channel_id',safetyAlertsChannel:'safety_alerts_channel_id'})) {
    const Value=Spec[Key as keyof GuildDesired];
    if(Value===undefined) continue;
    if(Value===null) Body[Field]=null;
    else {
      const Id=ChannelIds[Value as string];if(!Id) throw new Error(`Guild channel key ${Value} is not mapped`);
      Body[Field]=Id;
    }
  }
  return Body;
}
export function Structural(Item:DiscordRole|DiscordChannel|undefined,Kind:'role'|'channel'):string {
  if (!Item) return Hash(null);
  if(Kind==='role') {
    const Role=Item as DiscordRole;
    return Hash({...RoleState(Role),unicode_emoji:Role.unicode_emoji??null});
  }
  const Channel=Item as DiscordChannel;
  return Hash({...ChannelState(Channel),position:Channel.position??0,rate_limit_per_user:Channel.rate_limit_per_user??0,
    bitrate:Channel.bitrate??null,user_limit:Channel.user_limit??0,rtc_region:Channel.rtc_region??null,
    video_quality_mode:Channel.video_quality_mode??null,default_auto_archive_duration:Channel.default_auto_archive_duration??null,
    default_thread_rate_limit_per_user:Channel.default_thread_rate_limit_per_user??0,
    available_tags:Channel.available_tags??[],default_reaction_emoji:Channel.default_reaction_emoji??null,
    default_sort_order:Channel.default_sort_order??null,default_forum_layout:Channel.default_forum_layout??0,flags:Channel.flags??0});
}
export function SetHash(Ids:string[]):string {return Hash([...Ids].sort());}
