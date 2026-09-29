// Shared client projections only. Every permission is checked again by the server.
export const tenantIds = l => l?.tenant_ids || (l?.tenant_id ? [l.tenant_id] : []);
export const isTenant = (l, id) => tenantIds(l).includes(id);
export const claimsFor = p => p.claims || (p.claim ? [p.claim] : []);
export const freeAmount = p => Math.max(0, p.amount - p.confirmed - claimsFor(p).reduce((n,c) => n+c.amount,0));
export const unitTitle = l => l?.unit_title || 'Квартира целиком';
export function metersFor(d,l,{archived=false}={}) {
  if(!l)return [];
  return (d.meters||[]).filter(m => (m.lease_id===l.id || (m.scope==='apartment'&&m.apartment_id===l.apartment_id)) && (archived || m.active));
}
export function pendingMeters(d,l) {
  const period=d.business_date.slice(0,7);
  return metersFor(d,l).filter(m=>!(d.meter_history||[]).some(v=>v.meter_id===m.id&&v.period===period));
}
export function displayedRule(rule,month) {
  const revisions=(rule.revisions||[]).filter(x=>x.from_month<=month).sort((a,b)=>a.from_month.localeCompare(b.from_month));
  return {...rule,...revisions.at(-1)};
}
export function monthLabel(v) {
  if(!v)return '—';
  return new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(v+'-01T12:00:00Z')).replace(' г.','');
}
export function editableMonth(d,rule) {
  if(rule.next_editable_month)return rule.next_editable_month;
  let ym=d.business_date.slice(0,7);
  for(let i=0;i<120;i++) {
    if(!d.records.some(r=>r.kind==='charge'&&r.lease_id===rule.lease_id&&r.payload.period===ym&&(r.payload.rule_id===rule.id || (rule.legacy&&r.dedupe===`charge:${rule.lease_id}:${ym}`))))return ym;
    const [y,m]=ym.split('-').map(Number),dt=new Date(Date.UTC(y,m,1));ym=dt.toISOString().slice(0,7);
  }
  return ym;
}
export function plannedNext(d,l) {
  if(!l||l.status==='ended')return null;
  const current=d.business_date;const list=[];
  for(const base of (d.recurring_rules||[]).filter(r=>r.lease_id===l.id&&r.state==='active')) {
    let ym=base.start_month>current.slice(0,7)?base.start_month:current.slice(0,7);
    for(let i=0;i<3;i++) {
      if(ym>l.end.slice(0,7)||base.end_month&&ym>base.end_month)break;
      const r=displayedRule(base,ym),[y,m]=ym.split('-').map(Number),last=new Date(Date.UTC(y,m,0)).getUTCDate();
      let due=ym+'-'+String(Math.min(r.due_day,last)).padStart(2,'0');if(due<l.start)due=l.start;
      const exists=d.records.some(x=>x.kind==='charge'&&x.payload.rule_id===base.id&&x.payload.period===ym);
      if(!exists&&due>=current&&due<=l.end){list.push({title:r.title,amount:r.amount,due,advance_days:r.advance_days});break;}
      ym=new Date(Date.UTC(y,m,1)).toISOString().slice(0,7);
    }
  }
  return list.sort((a,b)=>a.due.localeCompare(b.due))[0]||null;
}

export function dueForMonth(month,day) { const [y,m]=month.split('-').map(Number); return month+'-'+String(Math.min(Number(day),new Date(Date.UTC(y,m,0)).getUTCDate())).padStart(2,'0'); }
