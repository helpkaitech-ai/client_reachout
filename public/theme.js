(()=>{
 const media=window.matchMedia?.('(prefers-color-scheme: dark)');
 let preference='system';try{preference=localStorage.getItem('relay-theme')||'system';}catch{}
 const apply=()=>{document.documentElement.dataset.theme=preference==='dark'||preference==='system'&&media?.matches?'dark':'light';window.dispatchEvent(new Event('relay-theme'));};
 window.relayTheme={get preference(){return preference;},set(value){preference=['light','dark','system'].includes(value)?value:'system';try{localStorage.setItem('relay-theme',preference);}catch{}apply();}};
 media?.addEventListener('change',()=>{if(preference==='system')apply();});
 window.addEventListener('storage',e=>{if(e.key==='relay-theme'){preference=e.newValue||'system';apply();}});
 apply();
})();
