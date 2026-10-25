// Detaches the Telegram ids used by the run and issues a fresh link code for the MAX user.
const [repo,dir]=process.argv.slice(2);
const {openDatabase}=await import(repo+'/server/db.mjs');const {createAccountLink}=await import(repo+'/server/links.mjs');
const db=openDatabase(dir);db.run("UPDATE users SET tg_id=NULL,tg_bot_enabled=0 WHERE id='max-ilya'");db.run("UPDATE users SET tg_id=NULL WHERE tg_id IN ('777002','777003')");
console.log(db.tx(()=>createAccountLink(db,db.get("SELECT * FROM users WHERE id='max-ilya'"))).display);db.close();
