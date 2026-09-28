import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Plan } from './types.js';

export class Store {
  readonly Db: Database.Database;
  constructor(Path: string) {
    mkdirSync(dirname(Path), {recursive: true});
    this.Db = new Database(Path);
    this.Db.pragma('journal_mode = WAL');
    this.Db.exec(`CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS plans_guild_status ON plans(guild_id,status);
      CREATE TABLE IF NOT EXISTS mappings (guild_id TEXT NOT NULL, kind TEXT NOT NULL, semantic_key TEXT NOT NULL, resource_id TEXT NOT NULL,
      PRIMARY KEY(guild_id,kind,semantic_key), UNIQUE(guild_id,kind,resource_id));
      CREATE TABLE IF NOT EXISTS direct_actions (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, actor TEXT NOT NULL,
      kind TEXT NOT NULL, target_id TEXT NOT NULL, state TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL);`);
  }
  GetPlan(Id: string): Plan | undefined {
    const Row = this.Db.prepare('SELECT body FROM plans WHERE id=?').get(Id) as {body: string} | undefined;
    return Row ? JSON.parse(Row.body) as Plan : undefined;
  }
  SavePlan(PlanValue: Plan): void {
    PlanValue.updatedAt = new Date().toISOString();
    this.Db.prepare(`INSERT INTO plans(id,guild_id,status,body) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body`).run(PlanValue.id, PlanValue.guildId, PlanValue.status, JSON.stringify(PlanValue));
  }
  GetMapping(GuildId: string, Kind: string, Key: string): string | undefined {
    return (this.Db.prepare('SELECT resource_id FROM mappings WHERE guild_id=? AND kind=? AND semantic_key=?')
      .get(GuildId, Kind, Key) as {resource_id: string} | undefined)?.resource_id;
  }
  SetMapping(GuildId: string, Kind: string, Key: string, Id: string): void {
    this.Db.prepare(`INSERT INTO mappings VALUES(?,?,?,?) ON CONFLICT(guild_id,kind,semantic_key)
      DO UPDATE SET resource_id=excluded.resource_id`).run(GuildId, Kind, Key, Id);
  }
  DeleteMappingById(GuildId: string, Kind: string, Id: string): void {
    this.Db.prepare('DELETE FROM mappings WHERE guild_id=? AND kind=? AND resource_id=?').run(GuildId, Kind, Id);
  }
  GetMappings(GuildId: string, Kind: string): Record<string,string> {
    const Rows = this.Db.prepare('SELECT semantic_key,resource_id FROM mappings WHERE guild_id=? AND kind=? ORDER BY semantic_key').all(GuildId, Kind) as {semantic_key:string,resource_id:string}[];
    return Object.fromEntries(Rows.map(Row => [Row.semantic_key, Row.resource_id]));
  }
  HasActivePlan(GuildId: string, ExceptId?: string): boolean {
    const Row = this.Db.prepare("SELECT id FROM plans WHERE guild_id=? AND status IN ('running','uncertain') AND id != ? LIMIT 1")
      .get(GuildId, ExceptId ?? '') as {id:string} | undefined;
    return Boolean(Row);
  }
  RecordAction(Id:string,GuildId:string,Actor:string,Kind:string,TargetId:string,State:string,ErrorMessage?:string):void {
    this.Db.prepare(`INSERT INTO direct_actions VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,error=excluded.error,updated_at=excluded.updated_at`)
      .run(Id,GuildId,Actor,Kind,TargetId,State,ErrorMessage??null,new Date().toISOString());
  }
  HasUncertainAction(GuildId:string):boolean {
    return Boolean(this.Db.prepare("SELECT id FROM direct_actions WHERE guild_id=? AND state IN ('running','uncertain') LIMIT 1").get(GuildId));
  }
  GetAction(Id:string):{id:string;guild_id:string;actor:string;kind:string;target_id:string;state:string;error:string|null}|undefined {
    return this.Db.prepare('SELECT * FROM direct_actions WHERE id=?').get(Id) as ReturnType<Store['GetAction']>;
  }
  ListUncertainActions(GuildId:string) {
    return this.Db.prepare("SELECT id,guild_id,actor,kind,target_id,state,error,updated_at FROM direct_actions WHERE guild_id=? AND state IN ('running','uncertain') ORDER BY updated_at")
      .all(GuildId);
  }
  ResolveAction(Id:string,Actor:string):void {
    const Action=this.GetAction(Id);
    if (!Action||Action.actor!==Actor||!['running','uncertain'].includes(Action.state)) throw new Error('No uncertain action for this actor');
    this.RecordAction(Id,Action.guild_id,Actor,Action.kind,Action.target_id,'resolved');
  }
  Close(): void { this.Db.close(); }
}
