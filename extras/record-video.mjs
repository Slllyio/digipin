/**
 * DigiPin Urban Intelligence — Cinematic Video Recorder v2
 *
 * Production-quality recording with:
 *   - Locked 1920×1080 resolution (Windows DPI-safe)
 *   - Smart waits (waitForSelector/waitForFunction, no blind timeouts)
 *   - Skip loading states — show only working features
 *   - Extended observation time per feature
 *   - Graceful per-scene error recovery
 *
 * Run: node record-video.mjs
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

const BASE_URL = 'http://localhost:5500';
const VIDEO_DIR = join(process.cwd(), 'video-output');
const VIEWPORT = { width: 1920, height: 1080 };

// ════════════════════════════════════════════════════════════
// NARRATION TIMING TRACKER
// ════════════════════════════════════════════════════════════
let recordingStartMs = 0;
const narrationLog = [];

// Timing constants (ms) — generous for cinematic pacing
const T = {
  SCENE_CARD: 3500,       // How long scene title card shows
  OBSERVE: 3000,          // Time to observe a working feature
  OBSERVE_LONG: 5000,     // Extended observation for complex features
  BADGE: 3000,            // Feature badge display
  ANNOTATION: 3500,       // Annotation display
  ACTION_GAP: 600,        // Between sequential actions
  MAP_FLY: 2500,          // Map fly animation settle
  MAP_PAN: 1500,          // Map pan settle
  SCROLL_STEP: 600,       // Between scroll increments
  TRANSITION: 1200,       // Between scenes
  INTRO: 6000,            // Intro overlay duration
  OUTRO: 6000,            // Outro overlay duration
};

if (!existsSync(VIDEO_DIR)) mkdirSync(VIDEO_DIR, { recursive: true });

// ════════════════════════════════════════════════════════════
// UTILITY HELPERS
// ════════════════════════════════════════════════════════════

/** Wait for an element to exist and be visible, with timeout fallback */
async function waitForReady(page, selector, timeoutMs = 8000) {
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    console.warn(`  [skip] Element not ready: ${selector}`);
    return false;
  }
}

/** Wait for a condition function to be true in browser context */
async function waitForCondition(page, fn, timeoutMs = 15000) {
  try {
    await page.waitForFunction(fn, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** Smart pause — shorter than fixed timeout but enough for video pacing */
function pause(page, ms) {
  return page.waitForTimeout(ms);
}

/** Force map to re-render tiles and resize to viewport */
async function ensureMapReady(page) {
  await page.evaluate(() => {
    const mapEl = document.getElementById('map');
    if (mapEl) {
      mapEl.style.width = '100vw';
      mapEl.style.height = '100vh';
    }
    if (typeof MapModule !== 'undefined') {
      const map = MapModule.getMap();
      if (map) {
        map.resize();
        map.panBy([1, 0], { duration: 0 });
        setTimeout(() => map.panBy([-1, 0], { duration: 0 }), 50);
      }
    }
  });
  // Wait for tiles to actually render
  await waitForCondition(page, () => {
    if (typeof MapModule === 'undefined') return false;
    const map = MapModule.getMap();
    return map && map.isStyleLoaded() && map.areTilesLoaded();
  }, 12000);
}

// ════════════════════════════════════════════════════════════
// CINEMATIC OVERLAY SYSTEM
// ════════════════════════════════════════════════════════════

async function injectOverlaySystem(page) {
  await page.addStyleTag({ content: `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700;900&display=swap');

    #video-overlay {
      position: fixed; top: 0; left: 0; width: 1920px; height: 1080px;
      z-index: 99999; pointer-events: none; font-family: 'Inter', system-ui, sans-serif;
    }

    /* Scene title card */
    .scene-card {
      position: absolute; bottom: 110px; left: 50%; transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.88); border: 1px solid rgba(0,229,255,0.35);
      border-radius: 16px; padding: 22px 44px; text-align: center;
      opacity: 0; transition: opacity 0.8s ease;
      backdrop-filter: blur(24px); min-width: 420px;
      box-shadow: 0 0 50px rgba(124,77,255,0.2), 0 0 100px rgba(0,229,255,0.08);
    }
    .scene-card.visible { opacity: 1; }
    .scene-card .scene-num {
      font-size: 11px; letter-spacing: 5px; text-transform: uppercase;
      color: #00e5ff; margin-bottom: 8px; font-weight: 600;
    }
    .scene-card .scene-title {
      font-size: 30px; font-weight: 700; color: #fff;
      background: linear-gradient(135deg, #fff, #00e5ff);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .scene-card .scene-subtitle {
      font-size: 14px; color: #aaa; margin-top: 8px; font-weight: 300;
    }

    /* Feature badge */
    .feature-badge {
      position: absolute; opacity: 0; transition: all 0.6s ease;
      background: rgba(0,0,0,0.92); border: 1px solid rgba(0,229,255,0.4);
      border-radius: 12px; padding: 14px 22px; backdrop-filter: blur(16px);
      box-shadow: 0 0 30px rgba(0,229,255,0.15);
    }
    .feature-badge.visible { opacity: 1; }
    .feature-badge .badge-value {
      font-size: 34px; font-weight: 900; color: #00e5ff; line-height: 1;
    }
    .feature-badge .badge-label {
      font-size: 12px; color: #888; text-transform: uppercase;
      letter-spacing: 2px; margin-top: 4px;
    }

    /* Cursor spotlight */
    .cursor-spot {
      position: absolute; width: 48px; height: 48px;
      border: 3px solid rgba(0,229,255,0.8); border-radius: 50%;
      pointer-events: none; opacity: 0; transition: all 0.3s ease;
      box-shadow: 0 0 20px rgba(0,229,255,0.4), inset 0 0 10px rgba(0,229,255,0.1);
      transform: translate(-50%, -50%);
    }
    .cursor-spot.visible { opacity: 1; }
    .cursor-spot.clicking {
      transform: translate(-50%, -50%) scale(0.7);
      border-color: #7c4dff;
      box-shadow: 0 0 30px rgba(124,77,255,0.6);
    }

    /* Full-screen intro/outro */
    .full-overlay {
      position: fixed; top: 0; left: 0; width: 1920px; height: 1080px;
      z-index: 999999; display: flex; align-items: center; justify-content: center;
      flex-direction: column; opacity: 0; transition: opacity 1.2s ease;
      background: radial-gradient(ellipse at center, #0d0d2b 0%, #000 70%);
      pointer-events: none;
    }
    .full-overlay.visible { opacity: 1; pointer-events: auto; }
    .full-overlay .main-title {
      font-size: 68px; font-weight: 900; letter-spacing: -2px;
      background: linear-gradient(135deg, #00e5ff, #7c4dff, #00e5ff);
      background-size: 200% 200%;
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      animation: gradientShift 3s ease infinite;
    }
    .full-overlay .sub-title {
      font-size: 24px; color: #888; margin-top: 14px; font-weight: 300;
      letter-spacing: 8px; text-transform: uppercase;
    }
    .full-overlay .stats-row {
      display: flex; gap: 48px; margin-top: 48px;
    }
    .full-overlay .stat-item { text-align: center; }
    .full-overlay .stat-value {
      font-size: 40px; font-weight: 900; color: #00e5ff;
    }
    .full-overlay .stat-label {
      font-size: 11px; color: #666; text-transform: uppercase;
      letter-spacing: 3px; margin-top: 6px;
    }
    @keyframes gradientShift {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }

    /* Annotation label */
    .annotation {
      position: absolute; opacity: 0; transition: all 0.5s ease;
      color: #00e5ff; font-size: 14px; font-weight: 600;
      background: rgba(0,0,0,0.88); padding: 10px 16px; border-radius: 8px;
      border: 1px solid rgba(0,229,255,0.35); white-space: nowrap;
      backdrop-filter: blur(12px);
    }
    .annotation.visible { opacity: 1; }
    .annotation::before {
      content: ''; position: absolute; left: -8px; top: 50%;
      transform: translateY(-50%);
      border: 6px solid transparent; border-right-color: rgba(0,229,255,0.35);
    }

    /* Subtitle / narration bar */
    .subtitle-bar {
      position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%);
      width: 75%; max-width: 1200px; min-height: 52px;
      background: rgba(0, 0, 0, 0.88); border: 1px solid rgba(0,229,255,0.2);
      border-radius: 12px; padding: 14px 28px;
      backdrop-filter: blur(20px);
      box-shadow: 0 4px 30px rgba(0,0,0,0.5), 0 0 40px rgba(124,77,255,0.08);
      display: flex; align-items: center; gap: 14px;
      opacity: 0; transition: opacity 0.6s ease;
      pointer-events: none; z-index: 100000;
    }
    .subtitle-bar.visible { opacity: 1; }
    .subtitle-icon {
      width: 28px; height: 28px; flex-shrink: 0;
      border-radius: 50%; background: linear-gradient(135deg, #7c4dff, #00e5ff);
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; color: #fff; font-weight: 700;
    }
    .subtitle-text {
      font-size: 17px; line-height: 1.5; color: #e8e8e8;
      font-weight: 400; letter-spacing: 0.3px;
    }
    .subtitle-text .highlight {
      color: #00e5ff; font-weight: 600;
    }

    /* Progress bar */
    .video-progress {
      position: absolute; bottom: 0; left: 0; width: 100%; height: 4px;
      background: rgba(255,255,255,0.08);
    }
    .video-progress-fill {
      height: 100%; background: linear-gradient(90deg, #7c4dff, #00e5ff);
      transition: width 0.8s ease; width: 0%;
    }
  `});

  await page.evaluate(() => {
    const overlay = document.createElement('div');
    overlay.id = 'video-overlay';

    const card = document.createElement('div');
    card.className = 'scene-card'; card.id = 'scene-card';
    const sceneNum = document.createElement('div');
    sceneNum.className = 'scene-num'; sceneNum.id = 'scene-num';
    const sceneTitle = document.createElement('div');
    sceneTitle.className = 'scene-title'; sceneTitle.id = 'scene-title';
    const sceneSub = document.createElement('div');
    sceneSub.className = 'scene-subtitle'; sceneSub.id = 'scene-subtitle';
    card.appendChild(sceneNum);
    card.appendChild(sceneTitle);
    card.appendChild(sceneSub);

    const cursor = document.createElement('div');
    cursor.className = 'cursor-spot'; cursor.id = 'cursor-spot';

    const progress = document.createElement('div');
    progress.className = 'video-progress';
    const progressFill = document.createElement('div');
    progressFill.className = 'video-progress-fill'; progressFill.id = 'video-progress-fill';
    progress.appendChild(progressFill);

    const subtitleBar = document.createElement('div');
    subtitleBar.className = 'subtitle-bar'; subtitleBar.id = 'subtitle-bar';
    const subtitleIcon = document.createElement('div');
    subtitleIcon.className = 'subtitle-icon'; subtitleIcon.textContent = '▶';
    const subtitleText = document.createElement('div');
    subtitleText.className = 'subtitle-text'; subtitleText.id = 'subtitle-text';
    subtitleBar.appendChild(subtitleIcon);
    subtitleBar.appendChild(subtitleText);

    overlay.appendChild(card);
    overlay.appendChild(cursor);
    overlay.appendChild(subtitleBar);
    overlay.appendChild(progress);
    document.body.appendChild(overlay);
  });
}

// ════════════════════════════════════════════════════════════
// OVERLAY HELPERS
// ════════════════════════════════════════════════════════════

async function showSceneCard(page, num, title, subtitle) {
  await page.evaluate(({ num, title, subtitle }) => {
    document.getElementById('scene-num').textContent = num;
    document.getElementById('scene-title').textContent = title;
    document.getElementById('scene-subtitle').textContent = subtitle;
    document.getElementById('scene-card').classList.add('visible');
  }, { num, title, subtitle });
  await pause(page, T.SCENE_CARD);
  await page.evaluate(() => document.getElementById('scene-card').classList.remove('visible'));
  await pause(page, 500);
}

async function animatedClick(page, selector) {
  const el = await page.$(selector);
  if (!el) { console.warn('  [skip] Not found:', selector); return false; }
  const box = await el.boundingBox();
  if (!box) return false;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  // Move cursor spotlight to element
  await page.evaluate(({ x, y }) => {
    const c = document.getElementById('cursor-spot');
    c.style.left = x + 'px'; c.style.top = y + 'px';
    c.classList.add('visible');
  }, { x, y });
  await pause(page, 350);

  // Click with animation
  await page.evaluate(() => document.getElementById('cursor-spot').classList.add('clicking'));
  try {
    await page.click(selector, { force: true, timeout: 5000 });
  } catch {
    try { await page.locator(selector).first().click({ force: true, timeout: 3000 }); }
    catch { console.warn('  [skip] Click failed:', selector); }
  }
  await pause(page, 200);
  await page.evaluate(() => {
    const c = document.getElementById('cursor-spot');
    c.classList.remove('clicking');
    setTimeout(() => c.classList.remove('visible'), 300);
  });
  await pause(page, 400);
  return true;
}

async function showBadge(page, value, label, x, y, dur = T.BADGE) {
  await page.evaluate(({ value, label, x, y, dur }) => {
    const overlay = document.getElementById('video-overlay');
    const badge = document.createElement('div');
    badge.className = 'feature-badge';
    badge.style.left = x + 'px'; badge.style.top = y + 'px';
    const v = document.createElement('div');
    v.className = 'badge-value'; v.textContent = value;
    const l = document.createElement('div');
    l.className = 'badge-label'; l.textContent = label;
    badge.appendChild(v); badge.appendChild(l);
    overlay.appendChild(badge);
    requestAnimationFrame(() => badge.classList.add('visible'));
    setTimeout(() => {
      badge.classList.remove('visible');
      setTimeout(() => badge.remove(), 600);
    }, dur);
  }, { value, label, x, y, dur });
}

async function showAnnotation(page, text, x, y, dur = T.ANNOTATION) {
  await page.evaluate(({ text, x, y, dur }) => {
    const overlay = document.getElementById('video-overlay');
    const ann = document.createElement('div');
    ann.className = 'annotation';
    ann.style.left = x + 'px'; ann.style.top = y + 'px';
    ann.textContent = text;
    overlay.appendChild(ann);
    requestAnimationFrame(() => ann.classList.add('visible'));
    setTimeout(() => {
      ann.classList.remove('visible');
      setTimeout(() => ann.remove(), 600);
    }, dur);
  }, { text, x, y, dur });
}

async function showFullOverlay(page, type = 'intro') {
  await page.evaluate((type) => {
    const overlay = document.createElement('div');
    overlay.className = 'full-overlay'; overlay.id = 'full-overlay';
    const title = document.createElement('div');
    title.className = 'main-title'; title.textContent = 'DigiPin';
    overlay.appendChild(title);
    const sub = document.createElement('div');
    sub.className = 'sub-title';
    sub.textContent = type === 'intro' ? 'Urban Intelligence' : 'Thank You For Watching';
    overlay.appendChild(sub);
    if (type === 'intro') {
      const row = document.createElement('div'); row.className = 'stats-row';
      [{ v: '160+', l: 'Features' }, { v: '30+', l: 'Scores' },
       { v: '52', l: 'Queries' }, { v: '12', l: 'Cities' }].forEach(s => {
        const item = document.createElement('div'); item.className = 'stat-item';
        const sv = document.createElement('div'); sv.className = 'stat-value'; sv.textContent = s.v;
        const sl = document.createElement('div'); sl.className = 'stat-label'; sl.textContent = s.l;
        item.appendChild(sv); item.appendChild(sl); row.appendChild(item);
      });
      overlay.appendChild(row);
    }
    if (type === 'outro') {
      const row = document.createElement('div'); row.className = 'stats-row';
      row.style.marginTop = '32px';
      [{ v: 'OSM', l: 'OpenStreetMap' }, { v: 'Overture', l: 'Maps Foundation' },
       { v: 'ISRO', l: 'Bhuvan LULC' }, { v: 'Google', l: 'Open Buildings' }].forEach(s => {
        const item = document.createElement('div'); item.className = 'stat-item';
        const sv = document.createElement('div'); sv.className = 'stat-value'; sv.textContent = s.v;
        sv.style.fontSize = '24px';
        const sl = document.createElement('div'); sl.className = 'stat-label'; sl.textContent = s.l;
        item.appendChild(sv); item.appendChild(sl); row.appendChild(item);
      });
      overlay.appendChild(row);
    }
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));
  }, type);
}

async function hideFullOverlay(page) {
  await page.evaluate(() => {
    const o = document.getElementById('full-overlay');
    if (o) { o.classList.remove('visible'); setTimeout(() => o.remove(), 1200); }
  });
}

async function setProgress(page, pct) {
  await page.evaluate((pct) => {
    const el = document.getElementById('video-progress-fill');
    if (el) el.style.width = pct + '%';
  }, pct);
}

/** Show narration subtitle at bottom of screen and log timing */
async function showSubtitle(page, text, durationMs = 0) {
  const elapsedMs = Date.now() - recordingStartMs;
  // Estimate TTS duration: ~2.5 words/sec + 0.8s buffer
  const wordCount = text.split(/\s+/).length;
  const estimatedAudioMs = Math.ceil((wordCount / 2.5) * 1000) + 800;
  narrationLog.push({ time_ms: elapsedMs, text, estimated_duration_ms: estimatedAudioMs });

  await page.evaluate((text) => {
    const bar = document.getElementById('subtitle-bar');
    const el = document.getElementById('subtitle-text');
    if (bar && el) {
      el.textContent = text;
      bar.classList.add('visible');
    }
  }, text);

  // Auto-pause for narration duration (whichever is longer: explicit or estimated)
  const effectivePause = Math.max(durationMs, estimatedAudioMs);
  if (effectivePause > 0) {
    await pause(page, effectivePause);
  }
}

/** Hide the narration subtitle */
async function hideSubtitle(page) {
  await page.evaluate(() => {
    const bar = document.getElementById('subtitle-bar');
    if (bar) bar.classList.remove('visible');
  });
}

/** Close ALL floating dialogs, dropdowns, and panels */
async function closeAllDialogs(page) {
  await page.evaluate(() => {
    // Floating dialogs (detail-panel, scores-dialog, building-intel, disha-panel)
    document.querySelectorAll('.floating-dialog.open').forEach(d => d.classList.remove('open'));
    // Results panel
    const rp = document.getElementById('results-panel');
    if (rp) rp.classList.remove('open');
    // Compare panel
    const cp = document.getElementById('compare-panel');
    if (cp) cp.classList.remove('open');
    // Bookmarks panel
    const bp = document.getElementById('bookmarks-panel');
    if (bp) bp.classList.remove('open');
    // Heatmap dropdown
    const hd = document.getElementById('heatmap-dropdown');
    if (hd) hd.classList.remove('open');
    // Layers dropdown
    const ld = document.getElementById('dt-layers-dropdown');
    if (ld) ld.classList.remove('open');
  });
  await pause(page, 400);
}

async function smoothMapDrag(page, startX, startY, endX, endY, steps = 40) {
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // Ease-in-out for cinematic feel
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.mouse.move(
      startX + (endX - startX) * ease,
      startY + (endY - startY) * ease
    );
    await pause(page, 18);
  }
  await page.mouse.up();
}

async function typeWithEffect(page, selector, text, delayMs = 70) {
  try {
    await page.click(selector, { force: true, timeout: 3000 });
  } catch {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) { el.focus(); el.value = ''; }
    }, selector);
  }
  await pause(page, 200);
  for (const char of text) {
    await page.type(selector, char, { delay: 0 });
    await pause(page, delayMs);
  }
}

/** Wait for detail panel to have actual data content (not loading spinner) */
async function waitForPanelData(page, timeoutMs = 12000) {
  return waitForCondition(page, () => {
    const panel = document.getElementById('detail-panel');
    if (!panel || !panel.classList.contains('open')) return false;
    // Check if action buttons exist (they're rendered after data loads)
    return !!document.getElementById('btn-pin-compare');
  }, timeoutMs);
}

// ════════════════════════════════════════════════════════════
// MAIN RECORDING — 16 SCENES
// ════════════════════════════════════════════════════════════

async function main() {
  console.log('\n  ╔════════════════════════════════════════╗');
  console.log('  ║  DigiPin Video Recorder v2             ║');
  console.log('  ║  Resolution: 1920×1080 (locked)        ║');
  console.log('  ║  Smart waits · Skip loading · Observe  ║');
  console.log('  ╚════════════════════════════════════════╝\n');

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--force-device-scale-factor=1',        // Lock DPI to 1x
      '--high-dpi-support=1',
      '--disable-gpu-rasterization',           // Prevent GPU scaling artifacts
    ],
  });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,                      // Force 1:1 pixel mapping
    recordVideo: {
      dir: VIDEO_DIR,
      size: VIEWPORT,                          // Exact output size
    },
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();
  recordingStartMs = Date.now(); // Start tracking narration timing

  // Enforce viewport size throughout (Windows can resize)
  await page.setViewportSize(VIEWPORT);

  // ═══════════════════════════════════════
  // SCENE 0: INTRO
  // ═══════════════════════════════════════
  console.log('  [0/16] Intro — loading dashboard...');
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'networkidle' });

  // Wait for map style + tiles to fully render
  console.log('  Waiting for map tiles...');
  await waitForCondition(page, () => {
    if (typeof MapModule === 'undefined') return false;
    const map = MapModule.getMap();
    return map && map.isStyleLoaded();
  }, 20000);

  await ensureMapReady(page);
  await pause(page, 3000); // Extra time for all tiles to render

  // Re-enforce viewport after page load
  await page.setViewportSize(VIEWPORT);
  await injectOverlaySystem(page);

  // Show cinematic intro
  await showFullOverlay(page, 'intro');
  await pause(page, T.INTRO);
  await hideFullOverlay(page);
  await pause(page, T.TRANSITION);
  await showSubtitle(page, 'Welcome to DigiPin — India\'s first hyper-local urban intelligence platform, built on open data.');
  await pause(page, 4000);
  await hideSubtitle(page);
  await setProgress(page, 2);
  console.log('  ✓ Intro complete');

  // ═══════════════════════════════════════
  // SCENE 1: PLATFORM OVERVIEW
  // ═══════════════════════════════════════
  try {
    console.log('  [1/16] Platform Overview...');
    await showSceneCard(page, 'SCENE 01', 'Platform Overview', 'India\'s first hyper-local urban analytics platform');

    // Ensure map is visible
    await ensureMapReady(page);
    await showSubtitle(page, 'The map is divided into DigiPin grid cells. Each cell captures 160+ features about its urban environment.');
    await pause(page, T.MAP_PAN);

    // Slow cinematic pan to showcase grid cells
    await smoothMapDrag(page, 960, 540, 720, 400, 50);
    await pause(page, T.OBSERVE);
    await showBadge(page, '160+', 'Features Per Cell', 100, 150);
    await showAnnotation(page, 'Each grid cell = unique urban fingerprint', 180, 210, 3500);
    await showSubtitle(page, 'Every cell is a unique urban fingerprint — buildings, roads, green cover, amenities, walkability, and more.');
    await pause(page, T.OBSERVE);

    // Pan back
    await smoothMapDrag(page, 720, 400, 960, 540, 50);
    await hideSubtitle(page);
    await pause(page, T.MAP_PAN);
    await setProgress(page, 7);
    console.log('  ✓ Scene 1 done');
  } catch (e) { console.error('  ✗ Scene 1:', e.message); }

  // ═══════════════════════════════════════
  // SCENE 2: CITY SELECTOR
  // ═══════════════════════════════════════
  try {
    console.log('  [2/16] City Selector...');
    await showSceneCard(page, 'SCENE 02', 'City Selector', '12 major Indian cities with full data coverage');

    // Click and select Bengaluru
    await showSubtitle(page, 'Switch between 12 major Indian cities instantly. Each city has pre-loaded data coverage.');
    await animatedClick(page, '#city-select');
    await pause(page, T.ACTION_GAP);
    await page.selectOption('#city-select', 'bengaluru');

    // Wait for map to finish flying
    await pause(page, T.MAP_FLY);
    await waitForCondition(page, () => {
      const map = MapModule.getMap();
      return map && !map.isMoving();
    }, 5000);
    await ensureMapReady(page);
    await pause(page, T.OBSERVE);

    await showBadge(page, '12', 'Cities Covered', 100, 150);
    await showAnnotation(page, 'Bengaluru — map flies to city center', 200, 210, 3000);
    await showSubtitle(page, 'Flying to Bengaluru — the map smoothly transitions with full grid cell coverage.');
    await pause(page, T.OBSERVE);

    // Switch back to Indore for remaining demo
    await showSubtitle(page, 'Returning to Indore for the rest of the demo.');
    await page.selectOption('#city-select', 'indore');
    await pause(page, T.MAP_FLY);
    await waitForCondition(page, () => {
      const map = MapModule.getMap();
      return map && !map.isMoving();
    }, 5000);
    await ensureMapReady(page);
    await pause(page, T.MAP_PAN);
    await setProgress(page, 12);
    console.log('  ✓ Scene 2 done');
  } catch (e) { console.error('  ✗ Scene 2:', e.message); }

  // ═══════════════════════════════════════
  // SCENE 3: SEARCH (Place Name + DigiPin)
  // ═══════════════════════════════════════
  try {
    console.log('  [3/16] Smart Search...');
    await showSceneCard(page, 'SCENE 03', 'Smart Search', 'Search by place name or DigiPin code');

    // Search by place name
    await showSubtitle(page, 'Search by place name — type any landmark and the map flies to it using Nominatim geocoding.');
    await typeWithEffect(page, '#search-input', 'Rajwada, Indore', 55);
    await pause(page, 400);
    await animatedClick(page, '#search-btn');

    // Wait for map to fly to result
    await pause(page, T.MAP_FLY);
    await waitForCondition(page, () => {
      const map = MapModule.getMap();
      return map && !map.isMoving();
    }, 6000);
    await showAnnotation(page, 'Geocoded via Nominatim → flies to location', 450, 60, 3500);
    await pause(page, T.OBSERVE);

    // Clear and search by DigiPin code
    await showSubtitle(page, 'You can also search by DigiPin code — a 10-character code that maps to a specific grid cell.');
    await page.fill('#search-input', '');
    await pause(page, 300);
    await typeWithEffect(page, '#search-input', '3MC88PJL2J', 80);
    await pause(page, 400);
    await animatedClick(page, '#search-btn');

    await pause(page, T.MAP_FLY);
    await waitForCondition(page, () => {
      const map = MapModule.getMap();
      return map && !map.isMoving();
    }, 6000);
    await showAnnotation(page, 'DigiPin 3MC-88P-JL2J → exact cell lookup', 450, 60, 3500);
    await pause(page, T.OBSERVE);
    await hideSubtitle(page);
    await setProgress(page, 18);
    console.log('  ✓ Scene 3 done');
  } catch (e) { console.error('  ✗ Scene 3:', e.message); }

  // ═══════════════════════════════════════
  // SCENE 4: GRID CELL & DETAIL PANEL
  // ═══════════════════════════════════════
  try {
    console.log('  [4/16] Grid Cell Intelligence...');
    await showSceneCard(page, 'SCENE 04', 'Cell Intelligence Profile', '30+ scores & 160+ features per cell');

    // Ensure map settled, then click center to select a grid cell
    await ensureMapReady(page);
    await pause(page, 1000);

    // Show cursor, then click map center
    await page.evaluate(() => {
      const c = document.getElementById('cursor-spot');
      c.style.left = '960px'; c.style.top = '540px';
      c.classList.add('visible');
    });
    await pause(page, 500);
    await page.mouse.click(960, 540);
    await page.evaluate(() => document.getElementById('cursor-spot').classList.remove('visible'));

    // Wait for detail panel to fully load with data (skip loading spinner)
    console.log('    Waiting for panel data...');
    const panelLoaded = await waitForPanelData(page, 15000);

    if (panelLoaded) {
      await showSubtitle(page, 'Click any cell to reveal its intelligence profile — 30+ scores covering livability, safety, connectivity, and more.');
      await showAnnotation(page, 'Full intelligence profile loaded', 30, 180, 3000);
      await pause(page, T.OBSERVE);

      // Scroll through scores slowly so viewer can read them
      for (let i = 0; i < 6; i++) {
        await page.evaluate(() => {
          const body = document.querySelector('#detail-panel .dialog-body');
          if (body) body.scrollBy({ top: 180, behavior: 'smooth' });
        });
        await pause(page, T.SCROLL_STEP);
      }
      await pause(page, T.OBSERVE);

      // Show a badge for score count
      await showSubtitle(page, 'Scrolling through the scores — each dimension rated 0-100 using open data from OSM, Overture, and ISRO.');
      await showBadge(page, '30+', 'Intelligence Scores', 1400, 200);
      await pause(page, T.OBSERVE);

      // Scroll back to top
      await page.evaluate(() => {
        const body = document.querySelector('#detail-panel .dialog-body');
        if (body) body.scrollTo({ top: 0, behavior: 'smooth' });
      });
      await pause(page, 1000);
    }
    await hideSubtitle(page);
    await setProgress(page, 26);
    console.log('  ✓ Scene 4 done');
  } catch (e) { console.error('  ✗ Scene 4:', e.message); }

  // ═══════════════════════════════════════
  // SCENE 5: SCORES RADAR CHART
  // ═══════════════════════════════════════
  try {
    console.log('  [5/16] Scores Radar Chart...');
    await showSceneCard(page, 'SCENE 05', 'Intelligence Radar Chart', 'Visual fingerprint of location quality');

    await showSubtitle(page, 'The radar chart visualizes all quality dimensions at a glance — a visual fingerprint of location quality.');
    const scoresReady = await waitForReady(page, '#open-scores-btn', 5000);
    if (scoresReady) {
      await animatedClick(page, '#open-scores-btn');

      // Wait for scores dialog to actually open and render
      await waitForReady(page, '#scores-dialog.open', 5000);
      await pause(page, T.OBSERVE_LONG);

      await showAnnotation(page, 'Radar chart shows all quality dimensions', 800, 160, 4000);
      await pause(page, T.OBSERVE_LONG);

      // Close scores dialog
      await page.evaluate(() => {
        const d = document.getElementById('scores-dialog');
        if (d) d.classList.remove('open');
      });
      await pause(page, T.ACTION_GAP);
    }
    await hideSubtitle(page);
    await setProgress(page, 33);
    console.log('  ✓ Scene 5 done');
  } catch (e) { console.error('  ✗ Scene 5:', e.message); }

  // ═══════════════════════════════════════
  // SCENE 6: BUILDING INTELLIGENCE
  // ═══════════════════════════════════════
  try {
    console.log('  [6/16] Building Intelligence...');
    await showSceneCard(page, 'SCENE 06', 'Building Intelligence', 'LCZ classification & structural metrics');

    await showSubtitle(page, 'Building Intelligence shows structural metrics — count, height, coverage, and Local Climate Zone classification.');
    const biReady = await waitForReady(page, '#open-building-intel-btn', 5000);
    if (biReady) {
      await animatedClick(page, '#open-building-intel-btn');

      // Wait for dialog to open and content to render
      await waitForReady(page, '#building-intel-dialog.open', 5000);
      await pause(page, T.OBSERVE);

      await showAnnotation(page, 'Local Climate Zone + building count, height, coverage', 700, 160, 4000);
      await pause(page, T.OBSERVE_LONG);

      await showBadge(page, 'LCZ', 'Climate Zone Class', 1400, 300);
      await pause(page, T.OBSERVE);

      // Close
      await page.evaluate(() => {
        const d = document.getElementById('building-intel-dialog');
        if (d) d.classList.remove('open');
      });
      await pause(page, T.ACTION_GAP);
    }
    await hideSubtitle(page);
    await setProgress(page, 39);
    console.log('  ✓ Scene 6 done');
  } catch (e) { console.error('  ✗ Scene 6:', e.message); }

  // ═══════════════════════════════════════
  // SCENE 7: 3D BUILDINGS & ROADS
  // ═══════════════════════════════════════
  try {
    console.log('  [7/16] 3D Buildings & Roads...');
    await closeAllDialogs(page);
    await showSceneCard(page, 'SCENE 07', '3D Buildings & Roads', '528K Overture footprints + color-coded road network');

    await ensureMapReady(page);
    await showSubtitle(page, '528K building footprints from Overture Maps — now rendering as a 3D layer on the map.');

    // Enable Buildings layer
    await animatedClick(page, '#btn-buildings');
    // Wait for building tiles to load
    await pause(page, 2000);
    await waitForCondition(page, () => {
      const map = MapModule.getMap();
      return map && map.areTilesLoaded();
    }, 10000);
    await pause(page, T.OBSERVE);
    await showBadge(page, '528K', 'Building Footprints', 100, 150);
    await pause(page, T.OBSERVE);

    // Enable 3D mode — tilt map
    await animatedClick(page, '#btn-3d');
    await pause(page, 2000);
    await waitForCondition(page, () => {
      const map = MapModule.getMap();
      return map && !map.isMoving();
    }, 5000);
    await pause(page, T.OBSERVE);

    // Cinematic rotation — right-click drag
    await page.mouse.move(960, 540);
    await page.mouse.down({ button: 'right' });
    for (let i = 0; i < 80; i++) {
      const ease = i < 40 ? (i / 40) * 2.5 : 2.5;
      await page.mouse.move(960 + i * ease, 540);
      await pause(page, 25);
    }
    await page.mouse.up({ button: 'right' });
    await pause(page, T.OBSERVE);

    await showSubtitle(page, 'Buildings extruded by actual height and color-coded by type. Rotating the view for a cinematic perspective.');
    await showAnnotation(page, 'Buildings extruded by actual height — color by type', 600, 200, 4000);
    await pause(page, T.OBSERVE_LONG);

    // Show Roads overlay (color mode)
    await showSubtitle(page, 'Adding the road network — color-coded by classification: motorway, primary, secondary, residential.');
    await animatedClick(page, '#btn-roads');
    await pause(page, 2000);
    await waitForCondition(page, () => {
      const map = MapModule.getMap();
      return map && map.areTilesLoaded();
    }, 8000);
    await pause(page, T.OBSERVE);
    await showAnnotation(page, 'Roads color-coded: motorway, primary, secondary, residential', 600, 500, 4000);
    await pause(page, T.OBSERVE_LONG);

    // Reset: turn off 3D, roads, buildings
    await hideSubtitle(page);
    await animatedClick(page, '#btn-3d');
    await pause(page, 2000);
    await animatedClick(page, '#btn-roads');
    await pause(page, 800);
    await animatedClick(page, '#btn-roads');
    await pause(page, 800);
    await animatedClick(page, '#btn-buildings');
    await pause(page, 800);
    await animatedClick(page, '#btn-buildings');
    await pause(page, T.ACTION_GAP);

    await setProgress(page, 48);
    console.log('  ✓ Scene 7 done');
  } catch (e) { console.error('  ✗ Scene 7:', e.message); }

  // ═══════════════════════════════════════
  // SCENE 8: DATA OVERLAYS (LCZ, LULC, Wards)
  // ═══════════════════════════════════════
  try {
    console.log('  [8/16] Data Overlays...');
    await closeAllDialogs(page);
    await showSceneCard(page, 'SCENE 08', 'Geospatial Overlays', 'LCZ · LULC · Ward Boundaries');

    await ensureMapReady(page);

    // LCZ
    await showSubtitle(page, 'Local Climate Zones — 17 classes that classify urban morphology: compact highrise, open lowrise, dense trees, water.');
    await animatedClick(page, '#btn-lcz');
    await pause(page, 2000);
    await waitForCondition(page, () => {
      const map = MapModule.getMap();
      return map && map.areTilesLoaded();
    }, 8000);
    await showAnnotation(page, '17 Local Climate Zone classes at 100m resolution', 500, 100, 4000);
    await pause(page, T.OBSERVE_LONG);
    await animatedClick(page, '#btn-lcz');
    await pause(page, 1000);

    // LULC
    await showSubtitle(page, 'ISRO Bhuvan Land Use Land Cover — 54 land types from India\'s own satellite program at 1:50K scale.');
    await animatedClick(page, '#btn-lulc');
    await pause(page, 2000);
    await waitForCondition(page, () => {
      const map = MapModule.getMap();
      return map && map.areTilesLoaded();
    }, 8000);
    await showAnnotation(page, 'ISRO Bhuvan Land Use — 54 classes at 1:50K scale', 500, 100, 4000);
    await pause(page, T.OBSERVE_LONG);
    await animatedClick(page, '#btn-lulc');
    await pause(page, 1000);

    // Wards
    await showSubtitle(page, 'Ward boundaries from OpenStreetMap — showing administrative divisions for governance and planning.');
    await animatedClick(page, '#btn-wards');
    await pause(page, 2000);
    await waitForCondition(page, () => {
      const map = MapModule.getMap();
      return map && map.areTilesLoaded();
    }, 10000);
    await showAnnotation(page, 'Administrative ward boundaries from OpenStreetMap', 500, 100, 4000);
    await pause(page, T.OBSERVE_LONG);
    await animatedClick(page, '#btn-wards');
    await hideSubtitle(page);
    await pause(page, 1000);

    await setProgress(page, 56);
    console.log('  ✓ Scene 8 done');
  } catch (e) { console.error('  ✗ Scene 8:', e.message); }

  // ═══════════════════════════════════════
  // SCENE 9: LAYERS PANEL (Overture Maps)
  // ═══════════════════════════════════════
  try {
    console.log('  [9/16] Layers Panel...');
    await closeAllDialogs(page);
    await showSceneCard(page, 'SCENE 09', 'Digital Twin Layers', 'Overture Maps: water, land use, places & POI');

    await showSubtitle(page, 'Digital Twin layers from Overture Maps Foundation — water bodies, land use, places of interest.');
    await animatedClick(page, '#btn-dt-layers');
    await waitForReady(page, '#dt-layers-dropdown.open', 3000);
    await pause(page, T.OBSERVE);
    await showAnnotation(page, 'All layers organized in collapsible groups', 1100, 180, 3500);
    await pause(page, T.OBSERVE);

    // Try toggling a water layer
    const waterToggled = await page.evaluate(() => {
      const item = document.querySelector('[data-layer-key="overture_water"]');
      if (item) { item.click(); return true; }
      // Fallback: click first toggle in the panel
      const firstToggle = document.querySelector('#dt-layers-dropdown .dt-layer-toggle');
      if (firstToggle) { firstToggle.click(); return true; }
      return false;
    });
    if (waterToggled) {
      await pause(page, 3000);
      await waitForCondition(page, () => {
        const map = MapModule.getMap();
        return map && map.areTilesLoaded();
      }, 8000);
      await showAnnotation(page, 'Water bodies rendered from Overture Maps', 500, 300, 3500);
      await pause(page, T.OBSERVE_LONG);

      // Toggle off
      await page.evaluate(() => {
        const item = document.querySelector('[data-layer-key="overture_water"]');
        if (item) item.click();
        else {
          const firstToggle = document.querySelector('#dt-layers-dropdown .dt-layer-toggle');
          if (firstToggle) firstToggle.click();
        }
      });
      await pause(page, 1000);
    }

    // Close layers panel
    await hideSubtitle(page);
    await animatedClick(page, '#btn-dt-layers');
    await pause(page, T.ACTION_GAP);
    await setProgress(page, 62);
    console.log('  ✓ Scene 9 done');
  } catch (e) { console.error('  ✗ Scene 9:', e.message); }

  // ═══════════════════════════════════════
  // SCENE 10: HEATMAP ANALYSIS
  // ═══════════════════════════════════════
  try {
    console.log('  [10/16] Heatmap Analysis...');
    await closeAllDialogs(page);
    await showSceneCard(page, 'SCENE 10', '3D Heatmap Analysis', 'Spatial distribution of 10 urban quality metrics');

    await showSubtitle(page, '3D Heatmap — visualize the spatial distribution of any quality metric across the city.');
    await animatedClick(page, '#btn-heatmap');
    await waitForReady(page, '#heatmap-dropdown.open', 3000);
    await pause(page, T.ACTION_GAP);

    // Select first metric (Livability)
    const metricClicked = await page.evaluate(() => {
      const items = document.querySelectorAll('#heatmap-dropdown .dropdown-item');
      if (items.length > 0) { items[0].click(); return items[0].textContent; }
      return null;
    });

    if (metricClicked) {
      console.log(`    Running heatmap: ${metricClicked}`);
      await showSubtitle(page, `Computing ${metricClicked} across 36 sample points. Each column height represents the score at that location.`);
      await showAnnotation(page, `Computing ${metricClicked} across 36 sample points...`, 400, 100, 5000);

      // Wait for heatmap to complete (it samples 36 points)
      await waitForCondition(page, () => {
        return typeof HeatmapOverlay !== 'undefined' && HeatmapOverlay.getActive() != null;
      }, 40000);
      await pause(page, 3000); // Let 3D columns render

      await showBadge(page, '10', 'Heatmap Metrics', 100, 150);

      // Go 3D to see columns
      await animatedClick(page, '#btn-3d');
      await pause(page, 2500);
      await waitForCondition(page, () => {
        const map = MapModule.getMap();
        return map && !map.isMoving();
      }, 5000);
      await showSubtitle(page, 'Tilting into 3D view — taller columns indicate higher scores. Instantly spot the best and worst zones.');
      await showAnnotation(page, 'Taller columns = higher scores — spot the best zones', 500, 200, 4000);
      await pause(page, T.OBSERVE_LONG);

      // Reset 3D
      await animatedClick(page, '#btn-3d');
      await pause(page, 2000);

      // Clear heatmap
      await page.evaluate(() => {
        if (typeof HeatmapOverlay !== 'undefined') HeatmapOverlay.clear();
        const dd = document.getElementById('heatmap-dropdown');
        if (dd) dd.classList.remove('open');
      });
      await pause(page, 1000);
    }
    await hideSubtitle(page);
    await setProgress(page, 68);
    console.log('  ✓ Scene 10 done');
  } catch (e) { console.error('  ✗ Scene 10:', e.message); }

  // ═══════════════════════════════════════
  // SCENE 11: URBAN QUERIES ENGINE
  // ═══════════════════════════════════════
  try {
    console.log('  [11/16] Urban Queries...');
    await closeAllDialogs(page);
    await showSceneCard(page, 'SCENE 11', 'Urban Query Engine', '52 analytical queries across 7 sectors');

    // Expand sidebar if collapsed
    const isCollapsed = await page.evaluate(() => {
      const sb = document.getElementById('sidebar');
      return sb && sb.classList.contains('collapsed');
    });
    if (isCollapsed) {
      await animatedClick(page, '#sidebar-toggle');
      await pause(page, T.ACTION_GAP);
    }

    await showSubtitle(page, '52 pre-built analytical queries across 7 sectors — Commercial, Residential, Infrastructure, Green, Safety, and more.');
    await showBadge(page, '52', 'Urban Queries', 50, 150);
    await showAnnotation(page, '7 sectors: Commercial, Residential, Infrastructure...', 50, 220, 4000);
    await pause(page, T.OBSERVE_LONG);

    // Scroll through query list to show variety
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        const ql = document.getElementById('query-list');
        if (ql) ql.scrollBy({ top: 200, behavior: 'smooth' });
      });
      await pause(page, 800);
    }
    await pause(page, T.OBSERVE);

    // Scroll back and click first query
    await page.evaluate(() => {
      const ql = document.getElementById('query-list');
      if (ql) ql.scrollTo({ top: 0, behavior: 'smooth' });
    });
    await pause(page, 800);

    // Expand first sector if needed, then click first query card
    const queryExists = await page.$('.query-card');
    if (queryExists) {
      // Expand first sector group
      await page.evaluate(() => {
        const firstSector = document.querySelector('.sector-queries');
        if (firstSector && !firstSector.classList.contains('open')) {
          const header = firstSector.previousElementSibling;
          if (header) header.click();
        }
      });
      await pause(page, 500);

      await showSubtitle(page, 'Running a query — the engine samples 25 points, scores each with 160+ features, and ranks the top locations.');
      await animatedClick(page, '.query-card');
      await showAnnotation(page, 'Analyzing 25 sample points with 160+ features each...', 350, 100, 6000);

      // Wait for query to complete — watch progress bar
      console.log('    Running query...');
      await waitForCondition(page, () => {
        const rp = document.getElementById('results-panel');
        return rp && rp.classList.contains('open');
      }, 45000);
      await pause(page, T.OBSERVE_LONG);

      await showAnnotation(page, 'Top locations ranked by weighted scoring', 800, 500, 4000);
      await pause(page, T.OBSERVE_LONG);

      // Close results
      await page.evaluate(() => {
        const rp = document.getElementById('results-panel');
        if (rp) rp.classList.remove('open');
        if (typeof MapModule !== 'undefined' && MapModule.clearHeatmap) MapModule.clearHeatmap();
      });
      await pause(page, T.ACTION_GAP);
    }
    await hideSubtitle(page);
    await setProgress(page, 78);
    console.log('  ✓ Scene 11 done');
  } catch (e) { console.error('  ✗ Scene 11:', e.message); }

  // ═══════════════════════════════════════
  // SCENE 12: COMPARE & PIN
  // ═══════════════════════════════════════
  try {
    console.log('  [12/16] Compare & Pin...');
    await closeAllDialogs(page);
    await ensureMapReady(page);
    await showSceneCard(page, 'SCENE 12', 'Compare Locations', 'Pin up to 3 cells for side-by-side analysis');

    // Pin cell #1
    await showSubtitle(page, 'Pin up to 3 locations for side-by-side comparison. Selecting the first cell now.');
    await page.mouse.click(700, 450);
    await waitForPanelData(page, 12000);
    await pause(page, T.OBSERVE);
    await page.evaluate(() => document.getElementById('btn-pin-compare')?.click());
    await pause(page, 1000);
    await showAnnotation(page, 'Cell #1 pinned for comparison', 30, 600, 2500);
    await pause(page, T.OBSERVE);

    // Close panel, pin cell #2
    await closeAllDialogs(page);
    await pause(page, 500);
    await page.mouse.click(1150, 400);
    await waitForPanelData(page, 12000);
    await pause(page, T.OBSERVE);
    await page.evaluate(() => document.getElementById('btn-pin-compare')?.click());
    await pause(page, 1000);
    await showAnnotation(page, 'Cell #2 pinned — badge updates', 30, 600, 2500);
    await pause(page, T.OBSERVE);

    // Open compare panel
    await closeAllDialogs(page);
    await animatedClick(page, '#btn-compare');
    await pause(page, T.OBSERVE);

    await showSubtitle(page, 'Compare panel shows radar charts and detailed scores side by side — instant location comparison.');
    await showAnnotation(page, 'Side-by-side radar chart + detailed score comparison', 1100, 180, 4000);
    await pause(page, T.OBSERVE_LONG);

    // Scroll compare content
    await page.evaluate(() => {
      const cc = document.querySelector('#compare-content');
      if (cc) cc.scrollBy({ top: 200, behavior: 'smooth' });
    });
    await pause(page, T.OBSERVE);

    // Close
    await page.evaluate(() => {
      const cp = document.getElementById('compare-panel');
      if (cp) cp.classList.remove('open');
    });
    await pause(page, T.ACTION_GAP);
    await hideSubtitle(page);
    await setProgress(page, 84);
    console.log('  ✓ Scene 12 done');
  } catch (e) { console.error('  ✗ Scene 12:', e.message); }

  // ═══════════════════════════════════════
  // SCENE 13: WALKABILITY ISOCHRONE
  // ═══════════════════════════════════════
  try {
    console.log('  [13/16] Walkability Isochrone...');
    await closeAllDialogs(page);
    await showSceneCard(page, 'SCENE 13', 'Walkability Radius', '5/10/15 minute isochrones via OpenRouteService');

    // Click a cell to get the detail panel
    await page.mouse.click(960, 540);
    await waitForPanelData(page, 12000);
    await pause(page, 1000);

    await showSubtitle(page, 'Walkability isochrone — powered by OpenRouteService. See how far you can walk in 5, 10, and 15 minutes.');
    const isoReady = await waitForReady(page, '#btn-isochrone', 5000);
    if (isoReady) {
      await animatedClick(page, '#btn-isochrone');

      // Wait for isochrone to render on map
      await waitForCondition(page, () => {
        const map = MapModule.getMap();
        return map && (map.getSource('isochrone-source') || map.areTilesLoaded());
      }, 12000);
      await pause(page, T.OBSERVE);

      await showSubtitle(page, 'Green = 5 min walk, Yellow = 10 min, Red = 15 min. Essential for urban planning and real estate analysis.');
      await showAnnotation(page, 'Green=5min · Yellow=10min · Red=15min walk', 500, 200, 4500);
      await showBadge(page, '3', 'Walking Zones', 100, 150);
      await pause(page, T.OBSERVE_LONG);
    }
    await hideSubtitle(page);
    await setProgress(page, 89);
    console.log('  ✓ Scene 13 done');
  } catch (e) { console.error('  ✗ Scene 13:', e.message); }

  // ═══════════════════════════════════════
  // SCENE 14: BOOKMARKS & REPORTS
  // ═══════════════════════════════════════
  try {
    console.log('  [14/16] Bookmarks & Reports...');

    // Ensure we have a cell selected with panel open for bookmark button
    await closeAllDialogs(page);
    await page.mouse.click(960, 540);
    await waitForPanelData(page, 12000);
    await pause(page, 1000);

    await showSceneCard(page, 'SCENE 14', 'Bookmarks & Reports', 'Save locations · Generate PDF intelligence reports');

    // Bookmark the current cell
    await showSubtitle(page, 'Bookmark any location to save it for later. All bookmarks persist in your browser.');
    const bmReady = await waitForReady(page, '#btn-bookmark-cell', 5000);
    if (bmReady) {
      await animatedClick(page, '#btn-bookmark-cell');
      await pause(page, 1500);
      await showAnnotation(page, 'Location saved with timestamp & note', 30, 600, 3000);
      await pause(page, T.OBSERVE);
    }

    // Open bookmarks panel (toolbar button — always visible)
    await animatedClick(page, '#btn-bookmarks');
    await pause(page, T.OBSERVE);
    await showAnnotation(page, 'All bookmarks persist in browser — revisit anytime', 1100, 280, 3500);
    await pause(page, T.OBSERVE);

    // Close bookmarks
    await page.evaluate(() => {
      const bp = document.getElementById('bookmarks-panel');
      if (bp) bp.classList.remove('open');
    });
    await pause(page, T.ACTION_GAP);

    // Report button — visually highlight it but DON'T click (it opens a new tab
    // via window.open which breaks Playwright recording)
    const reportBtn = await page.$('#btn-report');
    if (reportBtn) {
      const rBox = await reportBtn.boundingBox();
      if (rBox) {
        // Show cursor spotlight on the report button
        await page.evaluate(({ x, y }) => {
          const c = document.getElementById('cursor-spot');
          c.style.left = x + 'px'; c.style.top = y + 'px';
          c.classList.add('visible');
        }, { x: rBox.x + rBox.width / 2, y: rBox.y + rBox.height / 2 });
        await pause(page, 800);
        await showSubtitle(page, 'Generate Report creates a print-ready PDF with all intelligence scores for any location.');
        await showAnnotation(page, 'Generate Report → print-ready PDF with all scores',
          rBox.x + rBox.width + 20, rBox.y, 3500);
        await pause(page, T.OBSERVE);
        await page.evaluate(() => document.getElementById('cursor-spot').classList.remove('visible'));
      }
    }

    await hideSubtitle(page);
    await setProgress(page, 93);
    console.log('  ✓ Scene 14 done');
  } catch (e) { console.error('  ✗ Scene 14:', e.message); }

  // ═══════════════════════════════════════
  // SCENE 15: DISHA AI ASSISTANT
  // ═══════════════════════════════════════
  try {
    console.log('  [15/16] DISHA AI Assistant...');
    // Need a cell selected so the DISHA button is available in detail panel
    await closeAllDialogs(page);
    await page.mouse.click(900, 500);
    await waitForPanelData(page, 12000);
    await pause(page, 1000);

    await showSceneCard(page, 'SCENE 15', 'DISHA AI Assistant', 'Local LLM with full location context');

    await showSubtitle(page, 'DISHA — the AI assistant. Ask natural questions about any location, powered by a local LLM with full data context.');
    const dishaReady = await waitForReady(page, '#ask-disha-btn', 5000);
    if (dishaReady) {
      await animatedClick(page, '#ask-disha-btn');

      // Close detail panel AFTER clicking DISHA so it doesn't overlap
      await page.evaluate(() => {
        const dp = document.getElementById('detail-panel');
        if (dp) dp.classList.remove('open');
      });

      await waitForReady(page, '#disha-panel.open', 3000);
      await pause(page, T.OBSERVE);

      await showAnnotation(page, 'Powered by Qwen2.5 via Ollama — all data in context', 700, 160, 4000);
      await pause(page, T.OBSERVE);

      // Try typing a question
      const inputEnabled = await page.evaluate(() => {
        const input = document.getElementById('disha-input');
        return input && !input.disabled;
      });

      if (inputEnabled) {
        await showSubtitle(page, 'Asking: "Is this area good for a restaurant?" — DISHA analyzes all 160+ features to give a contextual answer.');
        await typeWithEffect(page, '#disha-input', 'Is this area good for a restaurant?', 45);
        await pause(page, 1000);
        await animatedClick(page, '#disha-send');
        // Wait for response to start streaming
        await pause(page, T.OBSERVE_LONG * 2);
      } else {
        await showAnnotation(page, 'Requires Ollama running locally for AI responses', 700, 340, 3500);
        await pause(page, T.OBSERVE);
      }
    } else {
      // Fallback: open DISHA panel directly via JS
      await page.evaluate(() => {
        const dp = document.getElementById('disha-panel');
        if (dp) dp.classList.add('open');
      });
      await pause(page, T.OBSERVE);
      await showAnnotation(page, 'DISHA AI — ask natural questions about any location', 700, 200, 4000);
      await pause(page, T.OBSERVE);
    }
    await hideSubtitle(page);
    await setProgress(page, 97);
    console.log('  ✓ Scene 15 done');
  } catch (e) { console.error('  ✗ Scene 15:', e.message); }

  // ═══════════════════════════════════════
  // SCENE 16: CLOSING
  // ═══════════════════════════════════════
  try {
    console.log('  [16/16] Closing...');
    await closeAllDialogs(page);
    await ensureMapReady(page);

    // Panoramic zoom out
    await showSubtitle(page, 'DigiPin — built entirely on open data: OpenStreetMap, Overture Maps, ISRO Bhuvan, Google Open Buildings.');
    await page.evaluate(() => {
      const map = MapModule.getMap();
      map.easeTo({ zoom: 12, pitch: 0, bearing: 0, duration: 3500 });
    });
    await pause(page, 4000);

    // Gentle pan
    await smoothMapDrag(page, 960, 540, 860, 480, 60);
    await pause(page, T.OBSERVE);
    await hideSubtitle(page);

    // Show outro with data sources
    await showFullOverlay(page, 'outro');
    await pause(page, T.OUTRO);
    await setProgress(page, 100);
    await pause(page, 2000);
    console.log('  ✓ Scene 16 done');
  } catch (e) { console.error('  ✗ Scene 16:', e.message); }

  // ═══════════════════════════════════════
  // FINALIZE
  // ═══════════════════════════════════════

  // Write narration timing log for audio merge
  const logPath = join(VIDEO_DIR, 'narration-log.json');
  writeFileSync(logPath, JSON.stringify(narrationLog, null, 2));
  console.log(`\n  ✓ Narration log: ${logPath} (${narrationLog.length} entries)`);

  console.log('\n  Closing browser and finalizing video...');
  const videoPath = await page.video()?.path();
  await page.close();
  await context.close();
  await browser.close();

  // Rename to final output
  if (videoPath && existsSync(videoPath)) {
    const finalPath = join(VIDEO_DIR, 'DigiPin-Walkthrough-Final.webm');
    const { renameSync } = await import('fs');
    try {
      if (existsSync(finalPath)) unlinkSync(finalPath);
      renameSync(videoPath, finalPath);
      console.log(`\n  ✓ Video saved: ${finalPath}`);
    } catch {
      console.log(`\n  ✓ Video saved: ${videoPath}`);
    }
  } else {
    console.log(`\n  ✓ Video saved to: ${VIDEO_DIR}`);
  }

  console.log('  Recording complete!\n');
}

main().catch(err => {
  console.error('\n  ✗ Recording failed:', err);
  process.exit(1);
});
