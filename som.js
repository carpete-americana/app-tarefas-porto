// Som do CLOCK IIIIIT: sintetizado com Web Audio (sem ficheiros) ou, se o admin carregou um áudio, esse áudio.
// Partilhado pela app e pelo admin. Tocar tem de partir de um toque do utilizador (regra dos telemóveis).
(function (raiz) {
  const nota = (m) => 440 * Math.pow(2, (m - 69) / 12); // número MIDI → Hz

  function sino(ctx, dest, t, freq, dur, ganho) { // fundamental + parciais inarmónicos = timbre de sino
    [[1, 1], [2.76, 0.45], [5.4, 0.2]].forEach(([m, g]) => {
      const o = ctx.createOscillator(), v = ctx.createGain();
      o.type = 'sine'; o.frequency.value = freq * m;
      v.gain.setValueAtTime(0, t); v.gain.linearRampToValueAtTime(ganho * g, t + 0.005); v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(v); v.connect(dest); o.start(t); o.stop(t + dur + 0.05);
    });
  }
  function acorde(ctx, dest, t, notas, dur, ganho) {
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(5000, t); f.frequency.exponentialRampToValueAtTime(600, t + dur);
    const v = ctx.createGain(); v.gain.setValueAtTime(0, t); v.gain.linearRampToValueAtTime(ganho, t + 0.01); v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    f.connect(v); v.connect(dest);
    notas.forEach((m) => { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = nota(m); o.detune.value = (Math.random() - 0.5) * 12; o.connect(f); o.start(t); o.stop(t + dur + 0.05); });
  }
  function pancada(ctx, dest, t, ganho) {
    const o = ctx.createOscillator(), v = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(170, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.28);
    v.gain.setValueAtTime(ganho, t); v.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o.connect(v); v.connect(dest); o.start(t); o.stop(t + 0.5);
  }
  function brilho(ctx, dest, t, dur, ganho) { // purpurina: ruído agudo que desvanece
    const n = Math.floor(ctx.sampleRate * dur), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const s = ctx.createBufferSource(); s.buffer = b;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 6500;
    const v = ctx.createGain(); v.gain.setValueAtTime(ganho, t); v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(v); v.connect(dest); s.start(t);
  }
  function deslizar(ctx, dest, t, dur, ganho) { // o «IIIIIT» esticado
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), v = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(260, t); o.frequency.exponentialRampToValueAtTime(1050, t + dur);
    f.type = 'lowpass'; f.frequency.value = 2400; f.Q.value = 4;
    v.gain.setValueAtTime(0, t); v.gain.linearRampToValueAtTime(ganho, t + 0.05); v.gain.setValueAtTime(ganho, t + dur - 0.05); v.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(f); f.connect(v); v.connect(dest); o.start(t); o.stop(t + dur + 0.05);
  }

  // nivel 1 = dia completo, 2 = tudo, 3 = semana. Devolve a duração aproximada em segundos.
  function sintetizar(ctx, nivel, vol) {
    const mestre = ctx.createGain(); mestre.gain.value = Math.max(0, Math.min(1, vol)) * 0.55;
    const comp = ctx.createDynamicsCompressor(); mestre.connect(comp); comp.connect(ctx.destination);
    const t0 = ctx.currentTime + 0.02;
    [76, 80, 83, 88].forEach((m, i) => sino(ctx, mestre, t0 + i * 0.085, nota(m), 0.9, 0.5)); // arpejo de Mi maior a subir
    deslizar(ctx, mestre, t0 + 0.3, 0.6, 0.2);
    pancada(ctx, mestre, t0 + 0.9, 0.9);
    acorde(ctx, mestre, t0 + 0.9, [64, 68, 71, 76], 0.85, 0.2);
    brilho(ctx, mestre, t0 + 0.9, 0.75, 0.22);
    if (nivel >= 2) [83, 88, 92, 95].forEach((m, i) => sino(ctx, mestre, t0 + 1.15 + i * 0.07, nota(m), 0.9, 0.35));
    if (nivel >= 3) { pancada(ctx, mestre, t0 + 1.75, 0.8); acorde(ctx, mestre, t0 + 1.75, [68, 71, 76, 80], 1, 0.2); brilho(ctx, mestre, t0 + 1.75, 0.9, 0.25); [88, 92, 95, 100].forEach((m, i) => sino(ctx, mestre, t0 + 1.9 + i * 0.06, nota(m), 1, 0.3)); }
    return nivel >= 3 ? 2.9 : nivel >= 2 ? 2.2 : 1.8;
  }

  const Som = {
    ctx: null, buf: null, bufUrl: '',
    contexto(retomar) { // «retomar» só quando o toque do utilizador o permite (evita avisos do browser)
      try {
        this.ctx = this.ctx || new (raiz.AudioContext || raiz.webkitAudioContext)();
        if (retomar && this.ctx.state === 'suspended') this.ctx.resume();
        return this.ctx;
      } catch (e) { return null; }
    },
    async precarregar(url) { // descodifica o áudio do admin com antecedência (o toque só pode tocar o que já está pronto)
      if (!url || this.bufUrl === url) return;
      try {
        const a = this.contexto(false); if (!a) return;
        const r = await fetch(url); if (!r.ok) return;
        const ab = await r.arrayBuffer();
        this.buf = await new Promise((res, rej) => { const p = a.decodeAudioData(ab, res, rej); if (p && p.catch) p.catch(rej); });
        this.bufUrl = url;
      } catch (e) { this.buf = null; this.bufUrl = ''; }
    },
    tocar(nivel, vol, url) {
      const a = this.contexto(true); if (!a) return false;
      const v = Math.max(0, Math.min(1, vol));
      if (url && this.buf && this.bufUrl === url) {
        const s = a.createBufferSource(), g = a.createGain(); s.buffer = this.buf; g.gain.value = v;
        s.connect(g); g.connect(a.destination); s.start(); return true;
      }
      sintetizar(a, nivel, v); return true;
    },
    sintetizar,
  };
  raiz.SomTP = Som;
  if (typeof module !== 'undefined' && module.exports) module.exports = Som;
})(typeof window !== 'undefined' ? window : globalThis);
