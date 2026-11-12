/* ============================================================================
 * 循环 BGM · 8-bit 风格（两个游戏共用）
 * ----------------------------------------------------------------------------
 * 为什么不用音频文件：
 *   本站是纯静态 Pages，塞一个 1MB 的 mp3 进来，教室电脑第一次打开要等好几秒，
 *   而且手机端 Chrome 对 <audio> 自动播放的限制比 WebAudio 还严。
 *   这里全部用振荡器现场合成 —— 文件只有几 KB，循环无缝（节拍本身就对齐），
 *   也不需要任何外部依赖。
 *
 * 曲子是原创的，只是借用「芯片音乐」的编制：
 *   旋律（方波）+ 琶音（三角波）+ 贝斯（锯齿波过低通）+ 底鼓 / 军鼓 / 踩镲。
 *   8 小节一个循环，和声走 Am–F–C–G（打砖块）/ Dm–B♭–F–C（吃豆人）。
 *
 * 播放时机：浏览器要求必须由用户手势触发，所以第一次点屏幕（或点开始按钮）
 *   才会出声；之后一直循环，切到后台自动挂起，切回来接着放。
 * ========================================================================= */
window.CLS_BGM = (function () {
  'use strict';

  var AC = window.AudioContext || window.webkitAudioContext;
  var ac = null, master = null, noiseBuf = null;
  var playing = false, timer = null, step = 0, nextT = 0, cfg = null, name = '';

  var muted = false;
  try { muted = localStorage.getItem('cls_bgm_muted') === '1'; } catch (e) {}

  function hz(n) { return 440 * Math.pow(2, (n - 69) / 12); }

  function ensure() {
    if (ac) return true;
    if (!AC) return false;
    try {
      ac = new AC();
      master = ac.createGain();
      master.gain.value = muted ? 0 : 0.5;
      master.connect(ac.destination);

      var len = Math.floor(ac.sampleRate * 0.4);
      noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      return true;
    } catch (e) { ac = null; return false; }
  }

  /* ---------- 音色 ---------- */

  function tone(t, midi, dur, type, vol, lp) {
    var o = ac.createOscillator(), g = ac.createGain(), out = o;
    o.type = type || 'square';
    o.frequency.setValueAtTime(hz(midi), t);
    if (lp) {
      var f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lp;
      o.connect(f); out = f;
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    out.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.03);
  }

  function kick(t) {
    var o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
    g.gain.setValueAtTime(0.42, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.17);
  }

  function noiseHit(t, dur, hp, vol) {
    var s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noiseBuf;
    f.type = 'highpass'; f.frequency.value = hp;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t); s.stop(t + dur + 0.02);
  }

  /* ---------- 谱子 ----------
     每首歌 8 小节 × 16 个十六分音符 = 128 步。
     chords：每小节 4 个音（根 / 三 / 五 / 八度），琶音和贝斯都从这里取；
     melody：每小节的 [起拍, MIDI, 时值(步)] 列表，时值单位是十六分音符。 */

  var SONGS = {
    /* 下落砖块：A 小调，138 BPM，推进感强一点 */
    breakout: {
      bpm: 138,
      chords: [
        [69, 72, 76, 81], [69, 72, 76, 81],   /* Am */
        [65, 69, 72, 77], [65, 69, 72, 77],   /* F  */
        [72, 76, 79, 84], [72, 76, 79, 84],   /* C  */
        [67, 71, 74, 79], [67, 71, 74, 79]    /* G  */
      ],
      bass: [45, 45, 41, 41, 48, 48, 43, 43],
      melody: [
        [[0, 76, 2], [3, 81, 2], [5, 79, 3], [9, 76, 2], [11, 74, 2], [13, 72, 3]],
        [[0, 69, 6], [8, 76, 2], [10, 79, 2], [12, 81, 4]],
        [[0, 72, 2], [2, 77, 3], [6, 76, 2], [8, 72, 3], [12, 69, 4]],
        [[0, 65, 4], [4, 69, 4], [8, 72, 8]],
        [[0, 76, 2], [3, 79, 2], [5, 84, 3], [9, 79, 2], [11, 76, 2], [13, 74, 3]],
        [[0, 72, 6], [8, 76, 4], [12, 79, 4]],
        [[0, 74, 2], [3, 79, 2], [5, 71, 3], [9, 74, 2], [11, 71, 2], [13, 67, 3]],
        [[0, 67, 8], [8, 69, 2], [10, 71, 2], [12, 74, 4]]
      ]
    },

    /* 迷宫吃豆：D 小调，124 BPM，跳跃一点 */
    pacman: {
      bpm: 124,
      chords: [
        [62, 65, 69, 74], [62, 65, 69, 74],   /* Dm  */
        [58, 62, 65, 70], [58, 62, 65, 70],   /* B♭  */
        [65, 69, 72, 77], [65, 69, 72, 77],   /* F   */
        [60, 64, 67, 72], [60, 64, 67, 72]    /* C   */
      ],
      bass: [38, 38, 46, 46, 41, 41, 48, 48],
      melody: [
        [[0, 74, 2], [2, 77, 2], [4, 81, 3], [9, 77, 2], [11, 76, 2], [13, 74, 3]],
        [[0, 69, 4], [4, 74, 4], [8, 77, 4], [12, 81, 4]],
        [[0, 70, 2], [2, 74, 2], [4, 77, 3], [9, 74, 2], [11, 72, 2], [13, 70, 3]],
        [[0, 65, 8], [8, 74, 4], [12, 72, 4]],
        [[0, 72, 2], [2, 77, 2], [4, 81, 3], [9, 79, 2], [11, 77, 2], [13, 72, 3]],
        [[0, 69, 6], [8, 72, 2], [10, 77, 2], [12, 81, 4]],
        [[0, 79, 2], [2, 76, 2], [4, 72, 3], [9, 74, 2], [11, 76, 2], [13, 79, 3]],
        [[0, 76, 8], [8, 79, 8]]
      ]
    }
  };

  var ARP = [0, 1, 2, 3, 2, 1, 2, 3];   /* 八分音符的琶音音序 */

  /* ---------- 调度：提前 0.18 秒把音符排进音频线程 ---------- */
  function schedule(t, s) {
    var bar = Math.floor(s / 16) % 8, k = s % 16;
    var ch = cfg.chords[bar];
    var spb = 60 / cfg.bpm / 4;

    /* 底鼓：1、3 拍；军鼓：2、4 拍；踩镲：每个八分 */
    if (k === 0 || k === 8) kick(t);
    if (k === 4 || k === 12) noiseHit(t, 0.10, 1400, 0.16);
    if (k % 2 === 0) noiseHit(t, 0.03, 7200, 0.05);

    /* 贝斯：每小节的 1 / 3 拍，加一个 4 拍半的过门音 */
    if (k === 0) tone(t, cfg.bass[bar], spb * 5, 'sawtooth', 0.20, 420);
    if (k === 8) tone(t, cfg.bass[bar] + (k === 8 ? 7 : 0), spb * 3, 'sawtooth', 0.16, 420);

    /* 琶音：八分音符，音量轻，做和声底色 */
    if (k % 2 === 0) {
      var ai = ARP[(k / 2) % 8];
      tone(t, ch[ai], spb * 1.7, 'triangle', 0.075, 3000);
    }

    /* 旋律 */
    var mel = cfg.melody[bar];
    for (var i = 0; i < mel.length; i++) {
      if (mel[i][0] !== k) continue;
      var d = mel[i][2] * spb * 0.92;
      tone(t, mel[i][1], d, 'square', 0.10, 2600);
      /* 高八度轻轻跟一层，芯片音乐那种「亮」的感觉 */
      tone(t, mel[i][1] + 12, d * 0.8, 'square', 0.028, 4200);
    }
  }

  function tick() {
    if (!playing || !ac) return;
    var stepDur = 60 / cfg.bpm / 4;
    /* 标签页切走时 currentTime 会停，这里顺手恢复，避免回来堆一大串音符 */
    if (ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }
    while (nextT < ac.currentTime + 0.18) {
      schedule(nextT, step);
      step = (step + 1) % 128;
      nextT += stepDur;
    }
  }

  function start(which) {
    if (!SONGS[which]) return false;
    name = which;
    if (!ensure()) return false;
    if (playing) return true;
    cfg = SONGS[which];
    playing = true;
    step = 0;
    nextT = ac.currentTime + 0.08;
    try { if (ac.state === 'suspended') ac.resume(); } catch (e) {}
    tick();
    timer = setInterval(tick, 25);
    return true;
  }

  function stop() {
    playing = false;
    if (timer) { clearInterval(timer); timer = null; }
  }

  function setMuted(v) {
    muted = !!v;
    try { localStorage.setItem('cls_bgm_muted', muted ? '1' : '0'); } catch (e) {}
    if (master) {
      try { master.gain.value = muted ? 0 : 0.5; } catch (e) {}
    }
  }

  /* 切到后台挂起，回来接着放 —— 不挂起的话手机会一直占着音频通道 */
  document.addEventListener('visibilitychange', function () {
    if (!ac) return;
    try {
      if (document.hidden) ac.suspend();
      else if (playing && !muted) ac.resume();
    } catch (e) {}
  });

  return {
    start: start,
    stop: stop,
    muted: function () { return muted; },
    toggle: function () { setMuted(!muted); return muted; },
    /* 自检用：部署前脚本靠它确认「点了开始真的出声了」 */
    status: function () {
      return { song: name, playing: playing, state: ac ? ac.state : 'none', muted: muted };
    },
    /* 绑定一个按钮：点一下静音 / 取消静音，图标跟着变。
       第二个参数是这个页面自己的曲子 —— 否则在吃豆人里先点静音再点开，
       会放进打砖块那首。 */
    bind: function (btn, fallback) {
      if (!btn) return;
      function paint() {
        btn.textContent = muted ? '🔇' : '🎵';
        btn.setAttribute('aria-label', muted ? '打开背景音乐' : '关闭背景音乐');
        btn.classList.toggle('off', muted);
      }
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        setMuted(!muted);
        paint();
        if (!muted) start(name || fallback || 'breakout');
      });
      paint();
    }
  };
})();
