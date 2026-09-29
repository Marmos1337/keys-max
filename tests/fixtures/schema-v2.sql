
  CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
  INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
  CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,max_id TEXT UNIQUE,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'tenant' CHECK(role IN ('tenant','owner')),settings TEXT NOT NULL DEFAULT '{}',demo INTEGER NOT NULL DEFAULT 0,bot_enabled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires INTEGER NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS apartments(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,address TEXT NOT NULL,rooms INTEGER NOT NULL,area REAL NOT NULL,photo TEXT NOT NULL DEFAULT 'living',created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS leases(id TEXT PRIMARY KEY,apartment_id TEXT NOT NULL REFERENCES apartments(id),tenant_id TEXT REFERENCES users(id),start TEXT NOT NULL,end TEXT NOT NULL,rent INTEGER NOT NULL CHECK(rent>0),deposit INTEGER NOT NULL DEFAULT 0,terms TEXT NOT NULL DEFAULT '',due_day INTEGER NOT NULL DEFAULT 5,meter_day INTEGER NOT NULL DEFAULT 25,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','ending','ended')),created_at TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS lease_active ON leases(apartment_id) WHERE status IN ('active','ending');
  CREATE INDEX IF NOT EXISTS lease_tenant ON leases(tenant_id);
  CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY,lease_id TEXT NOT NULL REFERENCES leases(id),expires INTEGER NOT NULL,used_by TEXT REFERENCES users(id));
  CREATE TABLE IF NOT EXISTS meters(id TEXT PRIMARY KEY,lease_id TEXT NOT NULL REFERENCES leases(id),label TEXT NOT NULL,unit TEXT NOT NULL,baseline INTEGER NOT NULL DEFAULT 0 CHECK(baseline>=0));
  CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,apartment_id TEXT NOT NULL REFERENCES apartments(id),lease_id TEXT NOT NULL REFERENCES leases(id),kind TEXT NOT NULL,status TEXT NOT NULL,title TEXT NOT NULL,payload TEXT NOT NULL,visibility TEXT NOT NULL DEFAULT 'shared' CHECK(visibility IN ('shared','owner')),version INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,dedupe TEXT UNIQUE);
  CREATE INDEX IF NOT EXISTS record_scope ON records(lease_id,kind,created_at);
  CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,record_id TEXT NOT NULL REFERENCES records(id),user_id TEXT NOT NULL REFERENCES users(id),text TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,apartment_id TEXT NOT NULL REFERENCES apartments(id),lease_id TEXT NOT NULL REFERENCES leases(id),record_id TEXT REFERENCES records(id),user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,storage_key TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,apartment_id TEXT NOT NULL REFERENCES apartments(id),lease_id TEXT NOT NULL REFERENCES leases(id),user_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,record_id TEXT REFERENCES records(id),visibility TEXT NOT NULL DEFAULT 'shared',created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,text TEXT NOT NULL,record_id TEXT REFERENCES records(id),is_read INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,dedupe TEXT UNIQUE,category TEXT NOT NULL DEFAULT 'events');
  CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,error TEXT,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS webhook_inbox(id TEXT PRIMARY KEY,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,error TEXT,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS idempotency(user_id TEXT NOT NULL REFERENCES users(id),key TEXT NOT NULL,request_hash TEXT NOT NULL,response TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,key));
  

                CREATE TABLE apartment_covers (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL REFERENCES users(id),
                    apartment_id TEXT REFERENCES apartments(id),
                    name TEXT NOT NULL, mime TEXT NOT NULL,
                    size INTEGER NOT NULL, storage_key TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX cover_owner ON apartment_covers(owner_id);
                ALTER TABLE apartments ADD COLUMN cover_id TEXT REFERENCES apartment_covers(id);
                ALTER TABLE apartments ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
                UPDATE schema_version SET version=2;
            