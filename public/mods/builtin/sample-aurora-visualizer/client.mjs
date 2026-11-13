// mods/sample-aurora-visualizer/client.mjs
// Folium sample: a lyric animation registered from the client entry. Plain ESM
// the renderer imports over folia-mod:// — no React, no bundler.
//
// The mount contract in one file:
//   - `ctx.lines` / `ctx.song` are fixed for one mount (the host remounts on a
//     new song), so the DOM is built once per song, not per line;
//   - the current line comes from `ctx.getLineIndex()`, read every frame;
//   - continuous time arrives via `ctx.onLyricTime`, never React state;
//   - `ctx.onChange` covers changes that happen while time stands still
//     (paused + theme switch), so the frame is repainted then too;
//   - the host stops both when the mount ends, so the disposer only clears up;
//   - lines and the theme have the same shape builtin modes get, and fonts
//     resolve through `folium.theme` exactly as they do, with the user's lyric
//     size from `ctx.getDisplay().lyricsFontScale`.

/*
 * The sweep moves about one step per frame at most, so quantising a character's
 * progress keeps the animation identical to the eye while letting paintSpans
 * skip the frames where nothing about that character changed. Writing every
 * span's color/textShadow/transform on every frame forced a style recalculation
 * for the whole line ~60 times a second, which is what made the style feel
 * stuttery on long lines.
 */
const PROGRESS_STEPS = 24;

const paintSpans = (spans, count, timeSec) => {
  for (let i = 0; i < count; i += 1) {
    const s = spans[i];
    const t = (timeSec - s.start) / Math.max(0.001, s.end - s.start);
    const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
    const step = Math.round(clamped * PROGRESS_STEPS);
    // Same step as last frame: nothing to redraw for this character.
    if (step === s.step) continue;
    s.step = step;
    const el = s.el;
    if (step === 0) {
      // Aurora sweep: hue rotates through the line, alpha rises as each
      // char becomes active; untouched chars stay a soft dim glow.
      el.style.color = 'var(--aurora-dim)';
      if (s.shadow) {
        el.style.textShadow = 'none';
        s.shadow = false;
      }
      if (s.lift) {
        el.style.transform = 'none';
        s.lift = false;
      }
      continue;
    }
    const hue = Math.round(((s.start % 4) * 70 + (step / PROGRESS_STEPS) * 40) % 360);
    el.style.color = `hsl(${hue} 90% ${58 + (step / PROGRESS_STEPS) * 14}%)`;
    if (step < PROGRESS_STEPS) {
      el.style.textShadow = `0 0 ${Math.round(8 + (step / PROGRESS_STEPS) * 14)}px hsl(${hue} 90% 65% / 0.65)`;
      el.style.transform = 'translateY(-2px)';
      s.shadow = true;
      s.lift = true;
    } else if (s.shadow || s.lift) {
      el.style.textShadow = 'none';
      el.style.transform = 'none';
      s.shadow = false;
      s.lift = false;
    }
  }
};

// Per-char timing from the line's words when present, else evenly spread.
const buildCharTimings = (line) => {
  const timings = [];
  if (line.words.length > 0) {
    line.words.forEach((word) => {
      const chars = Array.from(word.text);
      const duration = Math.max(0.001, word.endTime - word.startTime);
      chars.forEach((char, index) => {
        timings.push({
          char,
          start: word.startTime + (duration * index) / chars.length,
          end: word.startTime + (duration * (index + 1)) / chars.length,
        });
      });
    });
    return timings;
  }
  const chars = Array.from(line.fullText);
  const duration = Math.max(0.001, line.endTime - line.startTime);
  return chars.map((char, index) => ({
    char,
    start: line.startTime + (duration * index) / chars.length,
    end: line.startTime + (duration * (index + 1)) / chars.length,
  }));
};

const BASE_FONT_SIZE = 64;

const mountAurora = (folium, container, ctx) => {
  const shell = document.createElement('div');
  shell.style.cssText = [
    'position:absolute', 'inset:0',
    'display:flex', 'align-items:center', 'justify-content:center',
    'padding:0 8%', 'box-sizing:border-box', 'overflow:hidden',
  ].join(';');
  const lineBox = document.createElement('div');
  lineBox.style.cssText = 'max-width:100%;text-align:center;line-height:1.35;letter-spacing:0.04em;';
  shell.appendChild(lineBox);
  container.appendChild(shell);

  const applyTheme = () => {
    const theme = ctx.getTheme();
    lineBox.style.fontFamily = folium.theme.resolveFontStack(theme);
    lineBox.style.fontWeight = String(folium.theme.resolveFontWeight(theme, 500));
    lineBox.style.fontSize = `${BASE_FONT_SIZE * ctx.getDisplay().lyricsFontScale}px`;
    shell.style.setProperty('--aurora-dim', theme.isDaylight ? 'rgba(0,0,0,0.28)' : 'rgba(255,255,255,0.28)');
  };

  // One span per character, kept across lines: a line break only retimes the
  // spans it needs and hides the rest, instead of tearing the whole row down and
  // rebuilding it mid-song.
  const spans = [];
  let liveCount = 0;
  let renderedIndex = -2;

  const spanFor = (index) => {
    let s = spans[index];
    if (!s) {
      const el = document.createElement('span');
      el.style.cssText = 'display:inline-block;white-space:pre;transition:none;';
      lineBox.appendChild(el);
      s = { el, char: '', start: 0, end: 0, step: -1, shadow: false, lift: false, hidden: false };
      spans[index] = s;
    }
    return s;
  };

  const renderLine = (index) => {
    renderedIndex = index;
    const line = index >= 0 ? ctx.lines[index] : null;
    const timings = line ? buildCharTimings(line) : [];
    timings.forEach((timing, i) => {
      const s = spanFor(i);
      if (s.char !== timing.char) {
        s.char = timing.char;
        s.el.textContent = timing.char;
      }
      if (s.hidden) {
        s.el.style.display = '';
        s.hidden = false;
      }
      s.start = timing.start;
      s.end = timing.end;
      s.step = -1;
    });
    for (let i = timings.length; i < spans.length; i += 1) {
      const s = spans[i];
      if (!s.hidden) {
        s.el.style.display = 'none';
        s.hidden = true;
      }
      s.char = '';
      s.step = -1;
    }
    liveCount = timings.length;
  };

  const paint = (timeSec) => {
    const index = ctx.staticMode && ctx.staticLineIndex !== null ? ctx.staticLineIndex : ctx.getLineIndex();
    if (index !== renderedIndex) renderLine(index);
    paintSpans(spans, liveCount, timeSec);
  };

  applyTheme();
  paint(ctx.lyricTime.get());
  ctx.onLyricTime(paint);
  ctx.onChange(() => {
    applyTheme();
    paint(ctx.lyricTime.get());
  });

  return () => {
    shell.remove();
    spans.length = 0;
    liveCount = 0;
  };
};

export default function activate(folium) {
  folium.registries.visualizers.register({
    id: 'aurora-text',
    label: { 'zh-CN': '虹光', en: 'Aurora' },
    order: 420,
    mount: (container, ctx) => mountAurora(folium, container, ctx),
  });
}
