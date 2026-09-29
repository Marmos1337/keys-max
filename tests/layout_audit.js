/** Shared browser geometry assertions. Deliberate scrolling strips are excluded. */
() => {
 const problems=[];
 const shown=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
 const rect=e=>e.getBoundingClientRect();
 const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>2&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>2;
 const add=(issue,e,extra={})=>problems.push({issue,element:e?.className||e?.tagName,text:e?.textContent?.trim().slice(0,80),...extra});
 const modal=document.querySelector('.modal');const root=modal||document.querySelector('main')||document.body;
 if(document.documentElement.scrollWidth>innerWidth+1)add('page-overflow',document.documentElement,{width:document.documentElement.scrollWidth,viewport:innerWidth});
 if(!modal){
   const bar=document.querySelector('.topbar');
   if(bar){const items=[...bar.children].filter(shown),br=rect(bar);for(const e of items){const r=rect(e);if(r.left<br.left-1||r.right>br.right+1||r.top<br.top-1||r.bottom>br.bottom+1)add('header-outside',e);}for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++)if(overlap(rect(items[i]),rect(items[j])))add('header-overlap',items[i],{other:items[j].className});
    if(innerWidth<=760){const logo=bar.querySelector('.wordmark'),bell=bar.querySelector('.notifications-button'),back=bar.querySelector('.topbar-back,.topbar-spacer');if(logo&&bell&&back){const center=e=>(rect(e).top+rect(e).bottom)/2;if(Math.abs(center(logo)-center(bell))>2||Math.abs(center(logo)-center(back))>2)add('header-unaligned',bar);}}
   }
 }
 root.querySelectorAll('input:not([type=hidden]):not([type=file]):not([type=checkbox]),textarea,select,.btn,[data-fit-number],.guide-prompt,.unit-card').forEach(e=>{
  if(!shown(e)||e.closest('.segmented'))return;const r=rect(e);
  if(r.left<-1||r.right>innerWidth+1)add('element-horizontal-overflow',e,{name:e.name,left:r.left,right:r.right});
  if(e.matches('[data-fit-number]')&&e.clientWidth>0&&e.scrollWidth>e.clientWidth+1)add('number-overflow',e,{inner:e.clientWidth,content:e.scrollWidth});
 });
 root.querySelectorAll('select').forEach(e=>{if(shown(e)&&getComputedStyle(e).appearance==='none'&&getComputedStyle(e).backgroundImage==='none')add('select-missing-caret',e);});
 root.querySelectorAll('.form-grid').forEach(group=>{
  const fields=[...group.querySelectorAll(':scope>.field')].filter(shown),inputs=fields.map(f=>f.querySelector('input,select,textarea')).filter(Boolean);
  for(let i=0;i<inputs.length;i++)for(let j=i+1;j<inputs.length;j++){const a=rect(inputs[i]),b=rect(inputs[j]);if(Math.abs(a.left-b.left)>5&&Math.abs(a.top-b.top)<160){if(Math.abs(a.bottom-b.bottom)>1||Math.abs(a.height-b.height)>1)add('paired-inputs-unaligned',group,{names:[inputs[i].name,inputs[j].name],ys:[a.top,b.top],heights:[a.height,b.height]});}}
 });
 root.querySelectorAll('.action-row,.heading-actions').forEach(group=>{
   const items=[...group.children].filter(shown);
   for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){const a=rect(items[i]),b=rect(items[j]);if(overlap(a,b))add('action-buttons-overlap',group);if(Math.abs(a.top-b.top)<2&&(Math.abs(a.height-b.height)>1||Math.abs(a.width-b.width)>1))add('paired-buttons-unequal',group,{sizes:[[a.width,a.height],[b.width,b.height]]});}
 });
 root.querySelectorAll('.form-stack').forEach(group=>{
   const nodes=[...group.children].filter(shown);for(let i=1;i<nodes.length;i++)if(overlap(rect(nodes[i-1]),rect(nodes[i])))add('form-block-overlap',nodes[i]);
 });
 const detail=root.querySelector('.detail-body'),actions=root.querySelector('.detail-actions');if(detail&&actions&&overlap(rect(detail),rect(actions)))add('actions-cover-detail',actions);
 root.querySelectorAll('.records-list').forEach(group=>{const nodes=[...group.children].filter(shown);for(let i=1;i<nodes.length;i++)if(rect(nodes[i]).top-rect(nodes[i-1]).bottom<8)add('list-no-spacing',group);});
 root.querySelectorAll('img:not(.record-thumbnail)').forEach(e=>{if(shown(e)&&e.complete&&!e.naturalWidth)add('image-failed',e);});
 return problems;
}
