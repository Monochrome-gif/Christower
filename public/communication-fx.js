'use strict';

/* =========================================
   CHRISTOWER CONNECT
   Motion layer (visual only)

   - Sign-in page: scroll-driven 3D scene, parallax,
     tilt cards, reveal-on-scroll
   - Dashboard: sliding nav pill, list intro,
     message depth effect, scroll-to-latest button
   - Click ripples everywhere

   This file never touches the API, sockets or
   login logic. It only reads the DOM and sets
   styles, so communication.js works unchanged.
========================================= */

(() => {

  const $  = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const clamp  = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp   = (a, b, t) => a + (b - a) * t;
  const smooth = t => t * t * (3 - 2 * t);

  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reduce      = reduceQuery.matches;
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  if (reduce) document.documentElement.classList.add('reduce-motion');


  /* =========================================
     LANDING PAGE
  ========================================= */

  const loginScreen = $('#loginScreen');

  const landingVisible = () => !!loginScreen && !loginScreen.hidden;

  const nav         = $('#landNav');
  const progressBar = $('#scrollProgress');
  const story       = $('#story');
  const device      = $('#device');
  const shadow      = $('#stageShadow');
  const glow        = $('#stageGlow');
  const sheen       = $('#dvSheen');
  const scene       = $('#scene3d');
  const hint        = $('#stageHint');
  const heroCopy    = $('.hero-copy');
  const spotlight   = $('#spotlight');

  const caps  = $$('.cap');
  const dots  = $$('#stageSteps i');
  const floats = $$('.fl').map(el => ({
    el,
    x: Number(el.dataset.x) || 0,
    y: Number(el.dataset.y) || 0,
    z: Number(el.dataset.z) || 0
  }));
  const tiltScroll = $$('[data-tilt-scroll]');

  /* ---------- camera poses (one per scroll position) ---------- */

  const POSES = [
    { t: 0,    rx: 64, ry: 0,   rz: -26, y: 150, s: 0.74, e: 0   },  // lying flat, small
    { t: 0.16, rx: 24, ry: -26, rz: -3,  y: 30,  s: 0.92, e: 0   },  // rises up
    { t: 0.36, rx: 10, ry: -14, rz: 0,   y: 0,   s: 1,    e: 1   },  // layers lift out
    { t: 0.58, rx: 8,  ry: 20,  rz: 0,   y: 0,   s: 1.04, e: 1   },  // swings round
    { t: 0.78, rx: 12, ry: 30,  rz: 0,   y: -8,  s: 1,    e: 0.55 }, // layers settle
    { t: 0.92, rx: 0,  ry: 0,   rz: 0,   y: 0,   s: 1.1,  e: 0   },  // face on
    { t: 1,    rx: 0,  ry: 0,   rz: 0,   y: 0,   s: 1.1,  e: 0   }
  ];

  const STATIC_POSE = { rx: 8, ry: -14, rz: 0, y: 0, s: 1, e: 0.85 };

  function poseAt(p) {
    for (let i = 0; i < POSES.length - 1; i++) {
      const a = POSES[i];
      const b = POSES[i + 1];

      if (p <= b.t) {
        const k = smooth(clamp((p - a.t) / (b.t - a.t)));

        return {
          rx: lerp(a.rx, b.rx, k),
          ry: lerp(a.ry, b.ry, k),
          rz: lerp(a.rz, b.rz, k),
          y:  lerp(a.y,  b.y,  k),
          s:  lerp(a.s,  b.s,  k),
          e:  lerp(a.e,  b.e,  k)
        };
      }
    }

    return POSES[POSES.length - 1];
  }

  /* caption windows: [fade-in start, fully in, start fading out, gone] */
  const CAP_WINDOWS = [
    [-1,   -0.5,  0.28, 0.36],
    [0.36, 0.44,  0.62, 0.70],
    [0.70, 0.78,  0.93, 1.01]
  ];

  /* ---------- animation state ---------- */

  let storyTarget = 0;
  let storyNow    = 0;
  let enterAmount = 0;      // 0..1 while the stage scrolls into view
  let pointerX = 0, pointerY = 0;
  let smoothX  = 0, smoothY  = 0;
  let frameId  = 0;

  function kick() {
    if (!frameId) frameId = requestAnimationFrame(frame);
  }

  function measure() {
    if (!landingVisible()) return;

    const y = window.scrollY || window.pageYOffset || 0;
    const max = document.documentElement.scrollHeight - window.innerHeight;

    if (progressBar) {
      progressBar.style.setProperty('--sp', max > 0 ? clamp(y / max).toFixed(4) : 0);
    }

    if (nav) nav.classList.toggle('scrolled', y > 30);

    if (story) {
      const rect  = story.getBoundingClientRect();
      const total = story.offsetHeight - window.innerHeight;

      storyTarget = total > 0 ? clamp(-rect.top / total) : 0;
      enterAmount = clamp(1 - rect.top / window.innerHeight);
    }

    kick();
  }

  /* ---------- the 3D device ---------- */

  function renderStory(p) {
    if (!device || !story) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const wide = vw >= 1000 && !reduce;

    const base = wide
      ? clamp((vw * 0.50) / 760, 0.5, 1.08)
      : clamp((vw * 0.92) / 760, 0.4, 0.95);

    const ox = wide ? vw * 0.2 : 0;
    const oy = (wide || reduce) ? 0 : -vh * 0.13;

    const pose = reduce ? STATIC_POSE : poseAt(p);

    /* pointer adds a little life once the device is up */
    const live = reduce || !finePointer ? 0 : smooth(clamp((p - 0.1) / 0.15));

    const rx = pose.rx - smoothY * 3.5 * live;
    const ry = pose.ry + smoothX * 5 * live;

    const scale = base * pose.s;
    const e = pose.e;

    device.style.transform =
      `translate3d(${ox.toFixed(1)}px, ${(oy + pose.y * base).toFixed(1)}px, 0) ` +
      `scale(${scale.toFixed(4)}) ` +
      `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) rotateZ(${pose.rz.toFixed(2)}deg)`;

    /* floating layers: lift out, drift apart, turn a little towards the viewer */
    const floatScale = clamp(0.75 / base, 1, 1.7);

    floats.forEach(f => {
      f.el.style.transform =
        `translate3d(${(f.x * e).toFixed(1)}px, ${(f.y * e).toFixed(1)}px, ${(f.z * e).toFixed(1)}px) ` +
        `rotateX(${(-rx * 0.45 * e).toFixed(2)}deg) rotateY(${(-ry * 0.45 * e).toFixed(2)}deg) ` +
        `scale(${floatScale.toFixed(3)})`;

      f.el.style.opacity = clamp(e * 1.6 - 0.25).toFixed(3);
    });

    /* light sweeping across the glass */
    if (sheen) sheen.style.setProperty('--sheen', `${(-ry * 2.2).toFixed(1)}%`);

    /* fade in while the stage scrolls into view, fade out at the end */
    const fadeIn  = reduce ? 1 : smooth(clamp(enterAmount * 1.4));
    const fadeOut = reduce ? 0 : smooth(clamp((p - 0.95) / 0.05));

    if (scene) scene.style.opacity = (fadeIn * (1 - fadeOut * 0.85)).toFixed(3);

    /* soft shadow on the "floor" */
    if (shadow) {
      const sy = oy + pose.y * base + 235 * scale * Math.cos(rx * Math.PI / 180) * 0.95 + 40 * scale + 16;

      shadow.style.transform =
        `translate3d(${ox.toFixed(1)}px, ${sy.toFixed(1)}px, 0) scale(${(scale * (0.9 + 0.15 * e)).toFixed(3)}, ${(0.8 + 0.2 * e).toFixed(3)})`;

      shadow.style.opacity = ((0.62 - 0.26 * e) * fadeIn * (1 - fadeOut)).toFixed(3);
    }

    /* warm glow behind it */
    if (glow) {
      glow.style.setProperty('--glow', (0.22 + 0.5 * e).toFixed(3));
      glow.style.setProperty('--gx', `${ox.toFixed(0)}px`);
      glow.style.setProperty('--gs', (0.75 + 0.5 * e).toFixed(3));
    }

    /* captions */
    if (!reduce) {
      let best = 0;
      let bestValue = -1;

      caps.forEach((cap, i) => {
        const w = CAP_WINDOWS[i] || CAP_WINDOWS[0];

        const appear = smooth(clamp((p - w[0]) / (w[1] - w[0])));
        const vanish = smooth(clamp((p - w[2]) / (w[3] - w[2])));

        const amount = appear * (1 - vanish) * (i === 0 ? fadeIn : 1);

        const lift = (1 - appear) * 46 - vanish * 46;
        const tilt = (1 - appear) * -18 + vanish * 18;

        cap.style.opacity = amount.toFixed(3);
        cap.style.transform = `perspective(800px) translate3d(0, ${lift.toFixed(1)}px, 0) rotateX(${tilt.toFixed(1)}deg)`;
        cap.style.pointerEvents = amount > 0.5 ? 'auto' : 'none';

        if (amount > bestValue) {
          bestValue = amount;
          best = i;
        }
      });

      dots.forEach((dot, i) => dot.classList.toggle('on', i === best));
    }

    if (hint) hint.style.opacity = reduce ? 0 : (1 - clamp(p / 0.05)).toFixed(3);
  }

  /* ---------- cards that tilt with their position on screen ---------- */

  function renderTiltScroll() {
    if (reduce) return;

    const vh = window.innerHeight;

    tiltScroll.forEach(el => {
      const rect = el.getBoundingClientRect();

      if (rect.bottom < -200 || rect.top > vh + 200) return;

      const d = clamp(((rect.top + rect.height / 2) - vh / 2) / (vh / 2), -1.2, 1.2);
      const a = Math.abs(d);

      const rx = clamp(d * 16, -20, 20);
      const tz = -a * 90;
      const op = clamp(1.3 - a * 0.9, 0.15, 1);

      el.style.transform = `perspective(1100px) rotateX(${rx.toFixed(2)}deg) translateZ(${tz.toFixed(1)}px)`;
      el.style.opacity = op.toFixed(3);
    });
  }

  /* ---------- main frame ---------- */

  function frame() {
    frameId = 0;

    if (!landingVisible()) return;

    storyNow = reduce ? storyTarget : lerp(storyNow, storyTarget, 0.14);
    if (Math.abs(storyTarget - storyNow) < 0.0004) storyNow = storyTarget;

    smoothX = lerp(smoothX, pointerX, 0.08);
    smoothY = lerp(smoothY, pointerY, 0.08);

    renderStory(storyNow);
    renderTiltScroll();

    /* gentle parallax on the hero text (side-by-side layout only) */
    if (heroCopy && !reduce) {
      const y = window.scrollY || 0;

      if (window.innerWidth >= 1000) {
        heroCopy.style.transform = `translate3d(0, ${(y * 0.14).toFixed(1)}px, 0)`;
        heroCopy.style.opacity = (1 - clamp(y / (window.innerHeight * 0.9)) * 0.7).toFixed(3);
      } else {
        heroCopy.style.transform = '';
        heroCopy.style.opacity = '';
      }
    }

    const moving =
      storyNow !== storyTarget ||
      Math.abs(smoothX - pointerX) > 0.001 ||
      Math.abs(smoothY - pointerY) > 0.001;

    if (moving) kick();
  }

  window.addEventListener('scroll', measure, { passive: true });

  window.addEventListener('resize', () => {
    measure();
    movePill();
    updateDepth();
  });

  if (finePointer) {
    window.addEventListener('pointermove', event => {
      if (event.pointerType !== 'mouse' || !landingVisible()) return;

      pointerX = event.clientX / window.innerWidth * 2 - 1;
      pointerY = event.clientY / window.innerHeight * 2 - 1;

      if (spotlight) {
        spotlight.style.setProperty('--sx', `${event.clientX}px`);
        spotlight.style.setProperty('--sy', `${event.clientY}px`);
      }

      kick();
    }, { passive: true });
  }

  /* ---------- tilt + glare on cards ---------- */

  function enableTilt(card, maxX, maxY, skipWhenTyping) {
    if (!card || !finePointer || reduce) return;

    card.addEventListener('pointermove', event => {
      if (event.pointerType !== 'mouse') return;

      if (skipWhenTyping && card.contains(document.activeElement) &&
          /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
        card.style.setProperty('--rx', '0deg');
        card.style.setProperty('--ry', '0deg');
        return;
      }

      const rect = card.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;

      card.style.setProperty('--ry', `${((x - 0.5) * maxY).toFixed(2)}deg`);
      card.style.setProperty('--rx', `${((0.5 - y) * maxX).toFixed(2)}deg`);
      card.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
      card.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
    });

    card.addEventListener('pointerleave', () => {
      card.style.setProperty('--rx', '0deg');
      card.style.setProperty('--ry', '0deg');
    });
  }

  enableTilt($('#loginCard'), 8, 10, true);
  $$('.f-card').forEach(card => enableTilt(card, 10, 12, false));

  /* ---------- reveal on scroll ---------- */

  const revealItems = $$('.reveal');

  if ('IntersectionObserver' in window && !reduce) {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });

    revealItems.forEach(item => observer.observe(item));
  } else {
    revealItems.forEach(item => item.classList.add('in'));
  }

  /* ---------- sign-in shortcuts ---------- */

  function goToSignIn() {
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });

    setTimeout(() => {
      $('#loginEmail')?.focus({ preventScroll: true });
    }, reduce ? 0 : 750);
  }

  $('#navSignIn')?.addEventListener('click', goToSignIn);
  $('#ctaSignIn')?.addEventListener('click', goToSignIn);

  /* ---------- show / hide password ---------- */

  $('#togglePassword')?.addEventListener('click', event => {
    const input  = $('#loginPassword');
    const button = event.currentTarget;

    if (!input) return;

    const show = input.type === 'password';

    input.type = show ? 'text' : 'password';
    button.textContent = show ? 'Hide' : 'Show';
    button.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });


  /* =========================================
     CLICK RIPPLE (all buttons)
  ========================================= */

  const RIPPLE_TARGETS = [
    '.nav', '.channels button', '.send', '.plus', '.filter',
    '.login-button', '.directory-message', '.nav-signin',
    '.cta-btn', '.directory-search button'
  ].join(',');

  document.addEventListener('pointerdown', event => {
    if (reduce) return;

    const button = event.target.closest(RIPPLE_TARGETS);

    if (!button || button.disabled) return;

    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);

    const wave = document.createElement('span');

    wave.className = 'ripple-wave';
    wave.style.width  = `${size}px`;
    wave.style.height = `${size}px`;
    wave.style.left   = `${event.clientX - rect.left - size / 2}px`;
    wave.style.top    = `${event.clientY - rect.top - size / 2}px`;

    button.appendChild(wave);

    wave.addEventListener('animationend', () => wave.remove(), { once: true });
  });


  /* =========================================
     DASHBOARD
  ========================================= */

  let dashboardReady = false;
  let introTimer = 0;
  let introPlayed = false;
  let depthQueued = false;

  /* ---------- sliding highlight behind the active nav item ---------- */

  function movePill(first) {
    const sideNav = $('#sideNav');
    const pill    = $('#navPill');
    const active  = sideNav ? $('.nav.active', sideNav) : null;

    if (!sideNav || !pill || !active || !active.offsetHeight) return;

    if (first) pill.style.transition = 'none';

    pill.style.height = `${active.offsetHeight}px`;
    pill.style.transform = `translateY(${active.offsetTop}px)`;

    sideNav.classList.add('has-pill');

    if (first) {
      void pill.offsetWidth;
      pill.style.transition = '';
    }
  }

  /* ---------- staggered entrance for the inbox ---------- */

  function playListIntro() {
    const list = $('#chatList');

    if (!list || reduce) return;

    list.classList.remove('animate-in');
    void list.offsetWidth;
    list.classList.add('animate-in');

    clearTimeout(introTimer);
    introTimer = setTimeout(() => list.classList.remove('animate-in'), 1300);
  }

  /* ---------- messages tilt back as they scroll away ---------- */

  function updateDepth() {
    depthQueued = false;

    if (reduce) return;

    const box = $('#messages');

    if (!box) return;

    const boxRect = box.getBoundingClientRect();

    if (!boxRect.height) return;

    const mid  = boxRect.top + boxRect.height / 2;
    const half = boxRect.height / 2;

    /* read everything first, then write (avoids layout thrashing) */
    const rows = $$('.message', box).map(row => ({ row, rect: row.getBoundingClientRect() }));

    rows.forEach(({ row, rect }) => {
      if (rect.bottom < boxRect.top - 120 || rect.top > boxRect.bottom + 120) return;

      const c = clamp(((rect.top + rect.height / 2) - mid) / half, -1.2, 1.2);
      const a = Math.abs(c);

      const rx = clamp(-c * 16, -18, 18);
      const tz = -Math.max(0, a - 0.35) * 70;
      const op = 1 - clamp((a - 0.7) / 0.5) * 0.6;

      row.style.setProperty('--rx', `${rx.toFixed(2)}deg`);
      row.style.setProperty('--tz', `${tz.toFixed(1)}px`);
      row.style.setProperty('--op', op.toFixed(3));
    });
  }

  function queueDepth() {
    if (depthQueued) return;

    depthQueued = true;
    requestAnimationFrame(updateDepth);
  }

  /* ---------- "jump to latest" button ---------- */

  function setupScrollToBottom() {
    const box  = $('#messages');
    const conv = $('.conversation');

    if (!box || !conv || $('.to-bottom', conv)) return;

    const button = document.createElement('button');

    button.type = 'button';
    button.className = 'to-bottom';
    button.setAttribute('aria-label', 'Scroll to the latest message');
    button.textContent = '↓';

    conv.appendChild(button);

    const refresh = () => {
      const away = box.scrollHeight - box.scrollTop - box.clientHeight;
      button.classList.toggle('show', away > 240);
    };

    button.addEventListener('click', () => {
      box.scrollTo({ top: box.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
    });

    box.addEventListener('scroll', () => {
      refresh();
      queueDepth();
    }, { passive: true });

    new MutationObserver(() => {
      refresh();
      queueDepth();
    }).observe(box, { childList: true });
  }

  /* ---------- start everything once the person is signed in ---------- */

  function initDashboard() {
    window.scrollTo(0, 0);

    if (dashboardReady) {
      movePill();
      return;
    }

    dashboardReady = true;

    movePill(true);

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => movePill());
    }

    $('#sideNav')?.addEventListener('click', event => {
      if (event.target.closest('.nav')) requestAnimationFrame(() => movePill());
    });

    $$('[data-filter], [data-view]').forEach(button => {
      button.addEventListener('click', () => requestAnimationFrame(playListIntro));
    });

    /* first time conversations appear, play the staggered intro */
    const list = $('#chatList');

    if (list) {
      new MutationObserver(() => {
        if (!introPlayed && $('.chat-item', list)) {
          introPlayed = true;
          playListIntro();
        }
      }).observe(list, { childList: true });
    }

    setupScrollToBottom();
    queueDepth();
  }

  window.addEventListener('christower:authenticated', () => {
    /* wait one frame so the dashboard is laid out before measuring it */
    requestAnimationFrame(initDashboard);
  });

  /* if the session expires, return to a clean landing page */
  window.addEventListener('christower:session-expired', () => {
    setTimeout(() => {
      window.scrollTo(0, 0);
      storyNow = 0;
      measure();
    }, 60);
  });


  /* =========================================
     START
  ========================================= */

  measure();

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(measure);
  }

  window.addEventListener('load', measure);

})();