// Local scenario fixture for the Telegram run: owner (Telegram), MAX tenant with a link code.
const repo=process.argv[2], dir=process.argv[3];
const {openDatabase}=await import(repo+'/server/db.mjs');
const D=await import(repo+'/server/domain.mjs');
const {ensureTelegramUser}=await import(repo+'/server/auth.mjs');
const {createAccountLink}=await import(repo+'/server/links.mjs');
const {makeConfig}=await import(repo+'/server/config.mjs');
const db=openDatabase(dir), config=makeConfig({APP_MODE:'test',DATA_DIR:dir});
const owner=ensureTelegramUser(db,{id:'777001',name:'Анна Морозова',allowsWrite:true});
db.run("UPDATE users SET role='owner' WHERE id=?",owner.id);
const o=db.get('SELECT * FROM users WHERE id=?',owner.id);
db.tx(()=>D.createApartment(db,o,{title:'Квартира на Лесной',address:'Москва, ул. Лесная, 12, кв. 45',rooms:2,area:54,start:'2026-09-01',end:'2027-08-31',rent:6500000,deposit:6500000,terms:'Оплата до 5 числа',due_day:5,meter_day:25}));
const maxUser=db.get('SELECT * FROM users WHERE max_id=?','5550001')||(db.run("INSERT INTO users(id,max_id,name,role,created_at) VALUES('max-ilya','5550001','Илья Соколов (MAX)','owner',?)",new Date().toISOString()),db.get("SELECT * FROM users WHERE id='max-ilya'"));
db.tx(()=>D.createApartment(db,maxUser,{title:'Студия у парка',address:'Москва, Парковая, 3',rooms:1,area:31,start:'2026-09-01',end:'2027-08-31',rent:4200000,deposit:0,terms:'',due_day:10,meter_day:25}));
const link=db.tx(()=>createAccountLink(db,maxUser));
console.log(JSON.stringify({link:link.display}));
db.close();
