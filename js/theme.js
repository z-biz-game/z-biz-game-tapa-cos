// Single source of truth for colour, spacing, radius, shadow and motion. The stylesheet reads these
// as custom properties (applyThemeVars) and the canvas reads the same objects, so a token change
// cannot land on one side only — which is how "one clue colour" turns into forty.
//
// The numbers are the organisation's, not a taste call: spacing 20/16/12, radius 20/12/8/6, the
// smallest pressable thing 44×44, digits in SF Mono, springs at response .35 / damping .7, and
// exactly three layers of translucent black for shadow — 0.1, 0.2, 0.3. Anything that needs a
// fourth is a border or a fill wearing the wrong costume.

export const Palette = {
  bgTop: '#070A14',
  bgBottom: '#121829',
  surface: '#0F1424',
  surfaceLift: '#18203A',
  line: '#222D4C',
  lineHeavy: '#3A4A72',
  ink: '#F2F5FB',
  inkDim: 'rgba(242,245,251,0.62)',
  inkFaint: 'rgba(242,245,251,0.34)',

  // The player's own hand. The cell a hint just named, the ring being dragged and the win banner
  // all borrow it, so "this is what you are doing right now" reads as one idea.
  accent: '#FFC85C',
  accentEdge: '#FFE3A6',
  accentSoft: 'rgba(255,200,92,0.14)',

  // A black cell's colour carries the live judgement: cool while every clue around it can still be
  // satisfied, red when it breaks one, green when the whole board adds up. These three are the only
  // colours a filled cell can wear — a fourth would be a second opinion nobody asked for.
  info: '#7BB8FF',
  pencilStrong: '#8FA6CC',
  pencil: 'rgba(242,245,251,0.30)',

  success: '#3DDC91',
  error: '#FF5C7A',
  warn: '#FFB05C',
  focus: 'rgba(123,184,255,0.16)',
  hint: '#7BB8FF',

  // `0 0 0` and "no clue here" have to be tellable apart at a glance, so the all-zero clue gets its
  // own ink rather than sharing the white-cell background with an empty square.
  zeroClue: '#6FD3C5',
};

// Three layers of black, nothing else. Each is (offset, blur, alpha) and the alpha ladder is fixed:
// contact shadow 0.1, card 0.2, lifted 0.3.
export const Shadow = {
  soft: '0 1px 2px rgba(0,0,0,0.1)',
  card: '0 2px 6px rgba(0,0,0,0.2), 0 1px 2px rgba(0,0,0,0.1)',
  lift: '0 8px 22px rgba(0,0,0,0.3), 0 3px 8px rgba(0,0,0,0.2), 0 1px 2px rgba(0,0,0,0.1)',
  // The same three alphas, for the canvas where a CSS box-shadow does not reach.
  canvas: ['rgba(0,0,0,0.1)', 'rgba(0,0,0,0.2)', 'rgba(0,0,0,0.3)'],
};

export const Space = { page: 20, card: 16, inner: 12, gutter: 10 };
export const Radius = { card: 20, button: 12, chip: 8, cell: 6 };
export const Touch = { min: 44 };

export const Font = {
  title: "700 24px/1.25 -apple-system, 'SF Pro Display', system-ui, sans-serif",
  // Digits are monospaced and tabular: a clue's three numbers must not shuffle when one of them
  // changes width, and the timer/cell-count readouts share the stack.
  mono: "'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', system-ui, sans-serif",
};

// Durations obey the 150–350 ms discipline; anything longer blocks the next move. The spring curve
// is cubic-bezier(0.34, 1.56, 0.64, 1) — a .35/.7 spring, which overshoots once and settles.
export const Motion = {
  tap: 150,
  base: 220,
  pop: 260,
  ring: 300,
  win: 900,
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
};

export const Cell = { min: 26, max: 64, clueScale: 0.34, ringScale: 0.1 };

export function applyThemeVars() {
  const root = document.documentElement.style;
  const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  for (const [k, v] of Object.entries(Palette)) {
    if (Array.isArray(v)) continue;
    root.setProperty('--' + kebab(k), v);
  }
  for (const [k, v] of Object.entries(Shadow)) {
    if (Array.isArray(v)) continue;
    root.setProperty('--shadow-' + kebab(k), v);
  }
  for (const [k, v] of Object.entries(Space)) root.setProperty('--space-' + k, v + 'px');
  for (const [k, v] of Object.entries(Radius)) root.setProperty('--radius-' + k, v + 'px');
  for (const [k, v] of Object.entries(Touch)) root.setProperty('--touch-' + k, v + 'px');
  for (const [k, v] of Object.entries(Motion)) {
    if (typeof v === 'number') root.setProperty('--dur-' + kebab(k), v + 'ms');
    else root.setProperty('--ease-' + kebab(k), v);
  }
  root.setProperty('--font-mono', Font.mono);
  root.setProperty('--font-sans', Font.sans);
}

// The system preference is the floor, and the in-game toggle can only add to it — a player who asks
// for less motion should not be overruled by an OS set to "no preference".
let motionReduced = false;

export function setReduceMotion(v) {
  motionReduced = !!v;
}

export const systemPrefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const prefersReducedMotion = () => motionReduced || systemPrefersReducedMotion();
