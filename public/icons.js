const paths={
 trash:'<path d="M3 6h18M9 6V4h6v2M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',

 home:'<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
 building:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h.01M15 7h.01M9 11h.01M15 11h.01M9 15h.01M15 15h.01M10 21v-3h4v3"/>',
 tool:'<path d="M14.5 6.3a5 5 0 0 0-6.2 6.2L3 17.8A2.3 2.3 0 0 0 6.2 21l5.3-5.3a5 5 0 0 0 6.2-6.2l-3 3-3-3Z"/>',
 wallet:'<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18m-6 4h6v4h-6Z"/><path d="M6 5V3h12"/>',
 folder:'<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 9h18"/>',
 user:'<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2Z"/>',
 bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
 arrow:'<path d="m9 5 7 7-7 7"/>',back:'<path d="m14 5-7 7 7 7M7 12h14"/>',plus:'<path d="M12 5v14M5 12h14"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',
 check:'<path d="m5 12 4 4L19 6"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18m-14 4h2m4 0h2m-8 3h2"/>',
 meter:'<path d="M4.9 19a9 9 0 1 1 14.2 0Z"/><path d="m12 13 4-5M7 8l1 1m4-3v1m-7 6h1m12 0h1"/><circle cx="12" cy="13" r="1"/>',
 bag:'<path d="M5 7h14l1 14H4Z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/>',file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
 drop:'<path d="M12 3s-7 8-7 12a7 7 0 0 0 14 0c0-4-7-12-7-12Z"/><path d="M8 15a4 4 0 0 0 4 4"/>',lightning:'<path d="m13 2-9 12h7l-1 8L21 9h-8Z"/>',moon:'<path d="M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z"/>',
 shield:'<path d="m12 3 8 3v6c0 6-8 9-8 9s-8-3-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',search:'<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
 pin:'<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>',
 camera:'<path d="M3 7h4l2-3h6l2 3h4v14H3Z"/><circle cx="12" cy="13" r="4"/>',logout:'<path d="M9 3H3v18h6m4-5 5-4-5-4M8 12h13"/>',settings:'<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
 chat:'<path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 1 1 17-5Z"/><path d="M8 10h8m-8 4h5"/>',history:'<path d="M3 10a9 9 0 1 1 2 9M3 3v7h7M12 7v5l4 2"/>',copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
 link:'<path d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>',edit:'<path d="m16 3 5 5-12 12-6 1 1-6ZM14 5l5 5"/>',coins:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 10c0 4 16 4 16 0M4 15c0 4 16 4 16 0"/>',
 spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',send:'<path d="m22 2-7 20-4-9-9-4ZM22 2 11 13"/>',more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',chart:'<path d="M3 3v18h18M7 16v-4m5 4V7m5 9V4"/>',max:'<path d="M20 11c0 5-3.5 9-8 9-2 0-3.5-.5-5-1.5L3 20l1-5A9 9 0 1 1 20 11Z"/>',invite:'<circle cx="9" cy="8" r="3.2"/><path d="M3.8 18v-1a5.2 5.2 0 0 1 10.4 0v1"/><path d="M17 8v6M14 11h6"/>',menu:'<path d="M4 6h16M4 12h12M4 18h16"/>'
};
export function icon(name,size=22){return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.file}</svg>`;}
