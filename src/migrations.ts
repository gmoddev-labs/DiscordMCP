import type Database from 'better-sqlite3';

const Migrations=[
  `CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS plans_guild_status ON plans(guild_id,status);
   CREATE TABLE IF NOT EXISTS mappings (guild_id TEXT NOT NULL, kind TEXT NOT NULL, semantic_key TEXT NOT NULL, resource_id TEXT NOT NULL,
     PRIMARY KEY(guild_id,kind,semantic_key), UNIQUE(guild_id,kind,resource_id));
   CREATE TABLE IF NOT EXISTS direct_actions (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, actor TEXT NOT NULL,
     kind TEXT NOT NULL, target_id TEXT NOT NULL, state TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL);`,
  `CREATE TABLE actors (id TEXT PRIMARY KEY, body TEXT NOT NULL);
   CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, guild_id TEXT NOT NULL,
     type TEXT NOT NULL, observed_at TEXT NOT NULL, body TEXT NOT NULL);
   CREATE INDEX events_guild_sequence ON events(guild_id,sequence DESC);
   CREATE INDEX events_guild_time ON events(guild_id,observed_at);
   CREATE TABLE notifications (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
     guild_id TEXT NOT NULL, severity TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL,
     details TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL, acknowledged_at TEXT,
     acknowledged_by TEXT);
   CREATE INDEX notifications_guild_sequence ON notifications(guild_id,sequence DESC);
   ALTER TABLE direct_actions ADD COLUMN actor_identity TEXT;`
];

export function ApplyMigrations(Db:Database.Database):void {
  const Version=Db.pragma('user_version',{simple:true}) as number;
  if (Version>Migrations.length) throw new Error(`Database schema ${Version} is newer than this application`);
  for (let Index=Version;Index<Migrations.length;Index++) {
    Db.transaction(()=>{
      Db.exec(Migrations[Index]!);
      Db.pragma(`user_version = ${Index+1}`);
    })();
  }
}
