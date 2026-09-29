import {ChannelFlagsBitField,ChannelType} from 'discord.js';
import {ChannelSettings,type ChannelSettingsValue} from './types.js';
import type {DiscordChannel} from './discord.js';

export {ChannelSettings};
const TextLike=new Set<number>([ChannelType.GuildText,ChannelType.GuildAnnouncement,ChannelType.GuildForum,ChannelType.GuildMedia]);
const VoiceLike=new Set<number>([ChannelType.GuildVoice,ChannelType.GuildStageVoice]);
const ForumLike=new Set<number>([ChannelType.GuildForum,ChannelType.GuildMedia]);
export function ChannelSettingsBody(Type:number,Settings:ChannelSettingsValue,Current?:DiscordChannel):Record<string,unknown> {
  const Body:Record<string,unknown>={};
  if(Settings.name!==undefined) Body.name=Settings.name;
  if(Settings.topic!==undefined) {
    if(!TextLike.has(Type)) throw new Error('Topic is unsupported for this channel type');
    if(!ForumLike.has(Type)&&Settings.topic!==null&&Settings.topic.length>1024) throw new Error('Topic exceeds the channel limit');
    Body.topic=Settings.topic;
  }
  if(Settings.nsfw!==undefined) {
    if(Type===ChannelType.GuildCategory) throw new Error('NSFW is unsupported for categories');
    Body.nsfw=Settings.nsfw;
  }
  if(Settings.rateLimitPerUser!==undefined) {
    if(![ChannelType.GuildText,...VoiceLike,...ForumLike].includes(Type)) throw new Error('Slowmode is unsupported for this channel type');
    Body.rate_limit_per_user=Settings.rateLimitPerUser;
  }
  if(Settings.bitrate!==undefined||Settings.userLimit!==undefined||Settings.rtcRegion!==undefined||Settings.videoQualityMode!==undefined) {
    if(!VoiceLike.has(Type)) throw new Error('Voice settings require a voice or stage channel');
    if(Settings.bitrate!==undefined) {
      if(Type===ChannelType.GuildStageVoice&&Settings.bitrate>64000) throw new Error('Stage bitrate exceeds 64000');
      Body.bitrate=Settings.bitrate;
    }
    if(Settings.userLimit!==undefined) {
      if(Type===ChannelType.GuildVoice&&Settings.userLimit>99) throw new Error('Voice user limit exceeds 99');
      Body.user_limit=Settings.userLimit;
    }
    if(Settings.rtcRegion!==undefined) Body.rtc_region=Settings.rtcRegion;
    if(Settings.videoQualityMode!==undefined) Body.video_quality_mode=Settings.videoQualityMode;
  }
  if(Settings.defaultAutoArchiveDuration!==undefined) {
    if(!TextLike.has(Type)) throw new Error('Thread defaults require a text-like channel');
    Body.default_auto_archive_duration=Settings.defaultAutoArchiveDuration;
  }
  if(Settings.defaultThreadRateLimitPerUser!==undefined) {
    if(!TextLike.has(Type)) throw new Error('Thread defaults require a text-like channel');
    Body.default_thread_rate_limit_per_user=Settings.defaultThreadRateLimitPerUser;
  }
  if(Settings.forum!==undefined) {
    if(!ForumLike.has(Type)) throw new Error('Forum settings require a forum or media channel');
    const Forum=Settings.forum;
    if(Forum.defaultForumLayout!==undefined&&Type!==ChannelType.GuildForum) throw new Error('Forum layout requires a forum channel');
    if(Forum.availableTags!==undefined) {
      const Existing=Current?.available_tags??[];
      if(Existing.some(Tag=>!Forum.availableTags?.some(Wanted=>Wanted.id===Tag.id)))
        throw new Error('Existing forum tags require exact IDs; tag deletion is not supported here');
      const Ids=Forum.availableTags.map(Tag=>Tag.id).filter(Boolean);
      if(new Set(Ids).size!==Ids.length) throw new Error('Duplicate forum tag IDs');
      Body.available_tags=Forum.availableTags.map(Tag=>({...(Tag.id?{id:Tag.id}:{}),name:Tag.name,
        moderated:Tag.moderated??false,emoji_id:Tag.emoji?.id??null,emoji_name:Tag.emoji?.name??null}));
    }
    if(Forum.defaultReactionEmoji!==undefined) Body.default_reaction_emoji=Forum.defaultReactionEmoji?
      {emoji_id:Forum.defaultReactionEmoji.id??null,emoji_name:Forum.defaultReactionEmoji.name??null}:null;
    if(Forum.defaultSortOrder!==undefined) Body.default_sort_order=Forum.defaultSortOrder;
    if(Forum.defaultForumLayout!==undefined) Body.default_forum_layout=Forum.defaultForumLayout;
    if(Forum.requireTag!==undefined) Body.flags=Forum.requireTag?
      (Current?.flags??0)|ChannelFlagsBitField.Flags.RequireTag:
      (Current?.flags??0)&~ChannelFlagsBitField.Flags.RequireTag;
  }
  return Body;
}
export function ChannelRecord(GuildId:string,Value:DiscordChannel) {
  return {guildId:GuildId,channelId:Value.id,type:Value.type,name:Value.name,parentId:Value.parent_id??null,
    position:Value.position,topic:Value.topic??null,nsfw:Value.nsfw??false,
    rateLimitPerUser:Value.rate_limit_per_user,bitrate:Value.bitrate,userLimit:Value.user_limit,
    rtcRegion:Value.rtc_region??null,videoQualityMode:Value.video_quality_mode,
    defaultAutoArchiveDuration:Value.default_auto_archive_duration,
    defaultThreadRateLimitPerUser:Value.default_thread_rate_limit_per_user,
    forum:ForumLike.has(Value.type)?{availableTags:(Value.available_tags??[]).map(Tag=>({id:Tag.id,name:Tag.name,
      moderated:Tag.moderated??false,emoji:Tag.emoji_id?{id:Tag.emoji_id}:Tag.emoji_name?{name:Tag.emoji_name}:undefined})),
      defaultReactionEmoji:Value.default_reaction_emoji,
      defaultSortOrder:Value.default_sort_order,defaultForumLayout:Value.default_forum_layout,
      requireTag:((Value.flags??0)&ChannelFlagsBitField.Flags.RequireTag)!==0}:undefined,
    permissionOverwrites:Value.permission_overwrites??[]};
}
