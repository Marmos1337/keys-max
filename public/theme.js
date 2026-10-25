const media=window.matchMedia('(prefers-color-scheme: dark)');
let preference=localStorage.getItem('keys.theme')||'auto';
// In Telegram "auto" follows the messenger theme (colorScheme), elsewhere the device setting.
let hostScheme=()=>null,onPainted=()=>{};
export function useHostTheme(scheme,paint){hostScheme=scheme;onPainted=paint;applyTheme();}
export function applyTheme(value=preference){
  preference=['auto','light','dark'].includes(value)?value:'auto';
  const host=hostScheme();
  const dark=preference==='dark'||(preference==='auto'&&(host?host==='dark':media.matches));
  document.documentElement.dataset.theme=dark?'dark':'light';
  document.documentElement.style.colorScheme=dark?'dark':'light';
  const colour=getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if(colour)document.querySelector('meta[name="theme-color"]')?.setAttribute('content',colour);
  document.querySelectorAll('[data-themed-logo]').forEach(img=>{img.src=dark?'/art/keys-logo-white.png':'/art/keys-logo-black.png';});
  onPainted(colour);
}
export function setTheme(value){preference=value;localStorage.setItem('keys.theme',value);applyTheme();}
media.addEventListener('change',()=>applyTheme());
applyTheme();
