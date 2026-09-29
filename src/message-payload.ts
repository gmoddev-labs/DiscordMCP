import {z} from 'zod';
import {Snowflake} from './types.js';

const Url=z.url().refine(Value=>Value.startsWith('https://')||Value.startsWith('http://'),'HTTP URL required');
const Emoji=z.strictObject({id:Snowflake.optional(),name:z.string().min(1).max(64).optional()})
  .refine(Value=>Boolean(Value.id)!==Boolean(Value.name),'Exactly one emoji id or name is required');
export const Embed=z.strictObject({title:z.string().max(256).optional(),description:z.string().max(4096).optional(),
  url:Url.optional(),timestamp:z.string().datetime({offset:true}).optional(),color:z.number().int().min(0).max(0xffffff).optional(),
  footer:z.strictObject({text:z.string().min(1).max(2048),iconUrl:Url.optional()}).optional(),
  image:z.strictObject({url:Url}).optional(),thumbnail:z.strictObject({url:Url}).optional(),
  author:z.strictObject({name:z.string().min(1).max(256),url:Url.optional(),iconUrl:Url.optional()}).optional(),
  fields:z.array(z.strictObject({name:z.string().min(1).max(256),value:z.string().min(1).max(1024),inline:z.boolean().optional()})).max(25).optional()});
const Embeds=z.array(Embed).max(10).superRefine((Items,Context)=>{
  const Size=Items.reduce((Total,Item)=>Total+(Item.title?.length??0)+(Item.description?.length??0)+
    (Item.footer?.text.length??0)+(Item.author?.name.length??0)+
    (Item.fields??[]).reduce((Sum,Field)=>Sum+Field.name.length+Field.value.length,0),0);
  if(Size>6000) Context.addIssue({code:'custom',message:'Combined embed text exceeds 6000 characters'});
});
export const PollCreate=z.strictObject({question:z.string().min(1).max(300),answers:z.array(z.strictObject({
  text:z.string().min(1).max(55),emoji:Emoji.optional()
})).min(2).max(10),durationHours:z.number().int().min(1).max(768),allowMultiselect:z.boolean().default(false)});
const AllowedMentions=z.strictObject({users:z.array(Snowflake).max(100).optional(),roles:z.array(Snowflake).max(100).optional(),
  everyone:z.boolean().optional(),repliedUser:z.boolean().optional()});
const LinkButton=z.strictObject({label:z.string().min(1).max(80),url:Url});
const Components=z.array(z.array(LinkButton).min(1).max(5)).max(5);
const Shared=z.strictObject({content:z.string().min(1).max(2000).optional(),embeds:Embeds.optional(),
  allowedMentions:AllowedMentions.optional(),components:Components.optional()});
export const SendContent=Shared.extend({replyTo:z.strictObject({messageId:Snowflake,failIfNotExists:z.boolean().default(true)}).optional(),
  poll:PollCreate.optional(),stickerIds:z.array(Snowflake).max(3).optional()}).refine(Value=>
    Boolean(Value.content||Value.embeds?.length||Value.components?.length||Value.stickerIds?.length||Value.poll),
    'A message body is required');
export const EditContent=Shared.refine(Value=>
  Value.content!==undefined||Value.embeds!==undefined||Value.components!==undefined,
  'An editable message field is required');
export type SendContentValue=z.infer<typeof SendContent>;
export type EditContentValue=z.infer<typeof EditContent>;
function EmbedBody(Value:z.infer<typeof Embed>) {
  return {title:Value.title,description:Value.description,url:Value.url,timestamp:Value.timestamp,color:Value.color,
    footer:Value.footer?{text:Value.footer.text,icon_url:Value.footer.iconUrl}:undefined,
    image:Value.image,thumbnail:Value.thumbnail,
    author:Value.author?{name:Value.author.name,url:Value.author.url,icon_url:Value.author.iconUrl}:undefined,
    fields:Value.fields};
}
export function MessageBody(Value:SendContentValue|EditContentValue):Record<string,unknown> {
  const Mentions=Value.allowedMentions;
  const Body:Record<string,unknown>={allowed_mentions:{parse:Mentions?.everyone?['everyone']:[],
    ...(Mentions?.users?{users:Mentions.users}:{}),...(Mentions?.roles?{roles:Mentions.roles}:{}),
    ...(Mentions?.repliedUser!==undefined?{replied_user:Mentions.repliedUser}:{})}};
  if(Value.content!==undefined) Body.content=Value.content;
  if(Value.embeds!==undefined) Body.embeds=Value.embeds.map(EmbedBody);
  if(Value.components!==undefined) Body.components=Value.components.map(Row=>({type:1,components:Row.map(Button=>({
    type:2,style:5,label:Button.label,url:Button.url}))}));
  if('replyTo' in Value&&Value.replyTo) Body.message_reference={message_id:Value.replyTo.messageId,fail_if_not_exists:Value.replyTo.failIfNotExists};
  if('stickerIds' in Value&&Value.stickerIds!==undefined) Body.sticker_ids=Value.stickerIds;
  if('poll' in Value&&Value.poll) Body.poll={question:{text:Value.poll.question},
    answers:Value.poll.answers.map(Answer=>({poll_media:{text:Answer.text,
      ...(Answer.emoji?{emoji:Answer.emoji}:{})}})),duration:Value.poll.durationHours,
    allow_multiselect:Value.poll.allowMultiselect};
  return Body;
}
