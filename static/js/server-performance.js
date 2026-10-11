/* Live graphs exist only while the performance menu is open. */
(() => {
  let token, timer, previous, histories = [], busy = false, generation = 0;
  const container = () => document.getElementById('cpuCoreGraphs');
  function visible() {
    return !!token?.() && document.getElementById('serverHealthModal')?.style.display === 'flex' && !document.hidden;
  }
  async function sample() {
    if (!visible() || busy) return;
    busy = true;
    const current = generation;
    try {
      const response = await fetch('/api/admin/cpu-sample', {headers:{'X-Admin-Token':token()}, signal:AbortSignal.timeout(5000)});
      const data = await response.json();
      if (current !== generation || !visible() || !data.ok) return;
      if (!data.cores.length) { container().textContent = 'Per-core CPU counters are unavailable on this host.'; return; }
      if (histories.length !== data.cores.length) {
        histories = data.cores.map(() => []);
        container().replaceChildren(...histories.map((_, i) => {
          const card = document.createElement('div'); card.className = 'cpu-core-card';
          const label = document.createElement('span'); label.textContent = `Core ${i + 1}: sampling…`;
          const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 80;
          canvas.setAttribute('role','img'); canvas.setAttribute('aria-label',`Core ${i + 1} running CPU usage, 0 to 100 percent`);
          card.append(label, canvas); return card;
        }));
      }
      data.cores.forEach((counter, i) => {
        if (!previous?.[i]) return;
        const total = counter.total - previous[i].total;
        const idle = counter.idle - previous[i].idle;
        const usage = total > 0 ? Math.max(0, Math.min(100, (total-idle)*100/total)) : 0;
        histories[i].push(usage); if (histories[i].length > 60) histories[i].shift();
        const card = container().children[i], canvas = card.querySelector('canvas');
        card.querySelector('span').textContent = `Core ${i+1}: ${usage.toFixed(1)}%`;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0,0,300,80); ctx.strokeStyle = '#8899aa55'; ctx.lineWidth = 1;
        [0,40,79].forEach(y => {ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(300,y);ctx.stroke();});
        ctx.beginPath(); ctx.strokeStyle = '#58a8df'; ctx.lineWidth = 2;
        histories[i].forEach((value, x) => {const px = x*300/59, py = 79-value*0.78; if (!x) ctx.moveTo(px,py); else ctx.lineTo(px,py);}); ctx.stroke();
      });
      previous = data.cores;
    } catch { if (current === generation && visible()) { container().textContent = 'CPU sample unavailable. Retrying…'; histories = []; previous = null; } }
    finally { busy = false; }
  }
  function stop() { generation++; clearInterval(timer); timer=null; previous=null; histories=[]; container()?.replaceChildren(); }
  function start() { stop(); sample(); timer=setInterval(sample,2000); }
  window.ServerPerformance = {configure(getToken) {
    token=getToken;
    new MutationObserver(() => { if (!visible()) stop(); else if (!timer) start(); }).observe(document.getElementById('serverHealthModal'), {attributes:true, attributeFilter:['style']});
    document.addEventListener('visibilitychange', () => {if (visible()) start(); else stop();});
  }, start, stop};
})();
