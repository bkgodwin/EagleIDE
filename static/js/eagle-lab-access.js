/* Small eager entitlement check; the lab workspace remains lazy loaded. */
(function () {
  'use strict';
  let identity = '', scope = '', generation = 0, pending = null, lastCheck = 0;
  let access = {available:false, class_ids:[], role:'guest'};
  function paint() {
    const button = document.getElementById('eagleLabViewBtn');
    if (button) button.hidden = !access.available;
  }
  async function refresh(config, force = false) {
    const ctx = window.EagleIDE?.getContext?.() || {};
    const token = ctx.ADMIN_TOKEN || ctx.TEACHER_TOKEN || ctx.USER_TOKEN || '';
    config = config || ctx.currentConfig;
    const nextScope=JSON.stringify([token,!!config?.eagle_lab_enabled,!!ctx.currentTeacher?.is_coteacher,(ctx.studentClasses||[]).map(item=>item.id)]);
    if (token !== identity || nextScope !== scope) {
      scope=nextScope;
      identity = token; generation++; pending = null; lastCheck = 0;
      access = {available:false, class_ids:[], role:'guest'}; paint();
    }
    if (!token || (!ctx.ADMIN_TOKEN && !config?.eagle_lab_enabled)) {
      access = {available:!!ctx.ADMIN_TOKEN, class_ids:[], role:ctx.ADMIN_TOKEN?'admin':'guest'};
      paint(); return access;
    }
    if (pending) return pending;
    if (!force && Date.now() - lastCheck < 15000) { paint(); return access; }
    const version = generation;
    const headers = ctx.ADMIN_TOKEN ? {'X-Admin-Token':token} : ctx.TEACHER_TOKEN&&!ctx.currentTeacher?.is_coteacher ? {'X-Teacher-Token':token} : {'X-User-Token':token};
    const request = (async () => {
      try {
        const response = await fetch('/api/eagle-lab/access', {headers, cache:'no-store', signal:AbortSignal.timeout(8000)});
        const result = await response.json();
        if (generation !== version) return access;
        if (!response.ok || !result.ok) throw Error('Access unavailable');
        access = result.data; lastCheck = Date.now(); paint();
        window.dispatchEvent(new CustomEvent('eagle-lab-access-updated', {detail:access}));
      } catch {
        if (generation === version) { access = {available:false,class_ids:[],role:'guest'}; paint(); }
      } finally { if (generation === version) pending = null; }
      return access;
    })();
    pending = request; return request;
  }
  window.EagleLabAccess = {refresh, get:() => access};
  window.addEventListener('eagle-context-updated', () => refresh());
  window.addEventListener('focus', () => refresh());
  refresh();
})();
