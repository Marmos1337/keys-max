/** Additive migration. No production data, documents or payment entries are deleted. */
export function migrateV3(db) {
  db.tx(() => {
    db.exec(`
      CREATE TABLE rental_units (
        id TEXT PRIMARY KEY, apartment_id TEXT NOT NULL REFERENCES apartments(id),
        kind TEXT NOT NULL CHECK(kind IN ('whole','room')), title TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX unit_whole ON rental_units(apartment_id) WHERE kind='whole';
      INSERT INTO rental_units(id,apartment_id,kind,title,created_at)
        SELECT 'whole_'||id,id,'whole','Квартира целиком',created_at FROM apartments;
      ALTER TABLE leases ADD COLUMN unit_id TEXT REFERENCES rental_units(id);
      ALTER TABLE leases ADD COLUMN meters_enabled INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE leases ADD COLUMN rent_effective_month TEXT;
      UPDATE leases SET unit_id='whole_'||apartment_id;
      CREATE TABLE lease_members (
        lease_id TEXT NOT NULL REFERENCES leases(id), user_id TEXT NOT NULL REFERENCES users(id),
        joined_at TEXT NOT NULL, PRIMARY KEY(lease_id,user_id)
      );
      INSERT INTO lease_members SELECT id,tenant_id,created_at FROM leases WHERE tenant_id IS NOT NULL;
      CREATE INDEX member_user ON lease_members(user_id);
      DROP INDEX IF EXISTS lease_active;
      CREATE UNIQUE INDEX lease_unit_active ON leases(unit_id) WHERE status IN ('active','ending');
      CREATE TRIGGER lease_unit_insert BEFORE INSERT ON leases BEGIN
        SELECT CASE WHEN NEW.unit_id IS NULL OR NOT EXISTS(SELECT 1 FROM rental_units WHERE id=NEW.unit_id AND apartment_id=NEW.apartment_id)
          THEN RAISE(ABORT,'invalid rental unit') END;
        SELECT CASE WHEN NEW.status IN ('active','ending') AND EXISTS(
          SELECT 1 FROM leases l JOIN rental_units u ON u.id=l.unit_id JOIN rental_units n ON n.id=NEW.unit_id
          WHERE l.apartment_id=NEW.apartment_id AND l.status IN ('active','ending') AND (u.kind='whole' OR n.kind='whole'))
          THEN RAISE(ABORT,'whole apartment and room leases overlap') END;
      END;
      CREATE TRIGGER lease_unit_update BEFORE UPDATE OF unit_id,apartment_id,status ON leases BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM rental_units WHERE id=NEW.unit_id AND apartment_id=NEW.apartment_id)
          THEN RAISE(ABORT,'invalid rental unit') END;
        SELECT CASE WHEN NEW.status IN ('active','ending') AND EXISTS(
          SELECT 1 FROM leases l JOIN rental_units u ON u.id=l.unit_id JOIN rental_units n ON n.id=NEW.unit_id
          WHERE l.id!=NEW.id AND l.apartment_id=NEW.apartment_id AND l.status IN ('active','ending') AND (u.kind='whole' OR n.kind='whole'))
          THEN RAISE(ABORT,'whole apartment and room leases overlap') END;
      END;
      CREATE TRIGGER lease_primary_member AFTER UPDATE OF tenant_id ON leases WHEN NEW.tenant_id IS NOT NULL BEGIN
        INSERT OR IGNORE INTO lease_members VALUES(NEW.id,NEW.tenant_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      ALTER TABLE meters ADD COLUMN apartment_id TEXT REFERENCES apartments(id);
      ALTER TABLE meters ADD COLUMN scope TEXT NOT NULL DEFAULT 'lease' CHECK(scope IN ('lease','apartment'));
      ALTER TABLE meters ADD COLUMN kind TEXT NOT NULL DEFAULT 'other';
      ALTER TABLE meters ADD COLUMN group_id TEXT;
      ALTER TABLE meters ADD COLUMN tariff TEXT NOT NULL DEFAULT '';
      ALTER TABLE meters ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE meters ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
      UPDATE meters SET apartment_id=(SELECT apartment_id FROM leases WHERE id=meters.lease_id),
        kind=CASE WHEN label LIKE 'Холодная%' THEN 'cold_water' WHEN label LIKE 'Горячая%' THEN 'hot_water'
        WHEN label LIKE 'Электро%' THEN 'electricity' ELSE 'other' END;
      CREATE TABLE meter_values (
        meter_id TEXT NOT NULL REFERENCES meters(id), period TEXT NOT NULL,
        value INTEGER NOT NULL CHECK(value>=0), previous INTEGER NOT NULL CHECK(previous>=0),
        record_id TEXT NOT NULL REFERENCES records(id), created_at TEXT NOT NULL,
        PRIMARY KEY(meter_id,period)
      );
      CREATE TABLE recurring_rules (
        id TEXT PRIMARY KEY, lease_id TEXT NOT NULL REFERENCES leases(id),
        title TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0), due_day INTEGER NOT NULL CHECK(due_day BETWEEN 1 AND 31),
        advance_days INTEGER NOT NULL DEFAULT 14 CHECK(advance_days BETWEEN 1 AND 60),
        start_month TEXT NOT NULL, end_month TEXT, state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','deleted')),
        is_rent INTEGER NOT NULL DEFAULT 0, legacy INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX one_rent_rule ON recurring_rules(lease_id) WHERE is_rent=1 AND state!='deleted';
      CREATE TABLE recurring_revisions (
        rule_id TEXT NOT NULL REFERENCES recurring_rules(id), from_month TEXT NOT NULL,
        title TEXT NOT NULL, amount INTEGER NOT NULL, due_day INTEGER NOT NULL, advance_days INTEGER NOT NULL,
        PRIMARY KEY(rule_id,from_month)
      );
    `);
    for (const r of db.all("SELECT * FROM records WHERE kind='reading' ORDER BY created_at")) {
      const p = JSON.parse(r.payload);
      for (const v of p.values || []) if (db.get('SELECT 1 FROM meters WHERE id=?', v.meter_id)) {
        db.run('INSERT OR IGNORE INTO meter_values VALUES(?,?,?,?,?,?)',v.meter_id,p.period,v.value,v.previous??0,r.id,r.created_at);
      }
    }
    for(const r of db.all("SELECT * FROM records WHERE kind='charge'")) {
      const p=JSON.parse(r.payload);
      p.claims=(p.claims||(p.claim?[p.claim]:[])).map((c,i)=>({...c,id:c.id||'legacy_'+r.id+'_'+i}));
      p.claim=p.claims[0]||null;
      if(!p.rule_id&&r.dedupe===`charge:${r.lease_id}:${p.period}`)p.rule_id='rent_'+r.lease_id;
      db.run('UPDATE records SET payload=? WHERE id=?',JSON.stringify(p),r.id);
    }
    // Existing leases keep the already implemented automatic rent, but no retroactive bills are invented.
    const parts = new Intl.DateTimeFormat('en-CA',{timeZone:process.env.TZ||'Europe/Moscow',year:'numeric',month:'2-digit'}).formatToParts(new Date());
    const month = parts.find(p=>p.type==='year').value+'-'+parts.find(p=>p.type==='month').value;
    for (const l of db.all("SELECT * FROM leases WHERE status!='ended'")) {
      db.run(`INSERT INTO recurring_rules(id,lease_id,title,amount,due_day,start_month,end_month,is_rent,legacy,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, 'rent_'+l.id,l.id,'Аренда',l.rent,l.due_day,l.start.slice(0,7)>month?l.start.slice(0,7):month,l.end.slice(0,7),1,1,l.created_at);
    }
    db.run('UPDATE schema_version SET version=3');
  });
}
