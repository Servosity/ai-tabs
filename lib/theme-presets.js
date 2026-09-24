// Theme presets and default settings for ai-tabs appearance customization

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function hexToRgb(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  return [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)];
}

function rgbToHex(r, g, b) {
  return '#' + [r,g,b].map(c => clamp(Math.round(c),0,255).toString(16).padStart(2,'0')).join('');
}

function darkenHex(hex, amount) {
  const [r,g,b] = hexToRgb(hex);
  const f = 1 - amount;
  return rgbToHex(r*f, g*f, b*f);
}

function lightenHex(hex, amount) {
  const [r,g,b] = hexToRgb(hex);
  return rgbToHex(r+(255-r)*amount, g+(255-g)*amount, b+(255-b)*amount);
}

// Auto-generate UI colors from terminal palette
function deriveUiColors(terminal) {
  const bg = terminal.background;
  const fg = terminal.foreground;
  const accent = terminal.brightBlue || terminal.blue || '#7c5cbf';
  return {
    accent,
    accentHover: lightenHex(accent, 0.3),
    tabBarBg: darkenHex(bg, 0.3),
    headerBg: lightenHex(bg, 0.08),
    cardHoverBg: lightenHex(bg, 0.15),
    borderColor: lightenHex(bg, 0.2),
    mutedText: lightenHex(bg, 0.35),
    inputBg: lightenHex(bg, 0.1),
    deepBg: darkenHex(bg, 0.3),
    starColor: terminal.yellow || '#e8a838',
    success: terminal.green || '#50c878',
    danger: terminal.red || '#e05555',
    catAccent: terminal.cyan || '#56b6c2',
  };
}

const THEME_PRESETS = {
  'default-purple': {
    name: 'Default Purple',
    terminal: {
      background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#9d7ee0',
      selectionBackground: 'rgba(124, 92, 191, 0.3)',
      black: '#1a1a2e', red: '#e05555', green: '#50c878', yellow: '#e8a838',
      blue: '#7c5cbf', magenta: '#c678dd', cyan: '#56b6c2', white: '#e0e0e0',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379',
      brightYellow: '#e5c07b', brightBlue: '#9d7ee0', brightMagenta: '#c678dd',
      brightCyan: '#56b6c2', brightWhite: '#ffffff',
    },
    ui: {
      accent: '#9d7ee0', accentHover: '#c5a5ff',
      tabBarBg: '#0f0f1e', headerBg: '#16213e', cardHoverBg: '#1f2f52',
      borderColor: '#2a3a5c', mutedText: '#5c6370',
      inputBg: '#1a2745', deepBg: '#0f0f1e',
      starColor: '#e8a838', success: '#50c878', danger: '#e05555', catAccent: '#56b6c2',
    },
  },
  'dracula': {
    name: 'Dracula',
    terminal: {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#bd93f9',
      selectionBackground: 'rgba(68, 71, 90, 0.5)',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
      brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
      brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
    ui: {
      accent: '#bd93f9', accentHover: '#d6acff',
      tabBarBg: '#1e1f29', headerBg: '#2d2f3d', cardHoverBg: '#343647',
      borderColor: '#44475a', mutedText: '#6272a4',
      inputBg: '#2d2f3d', deepBg: '#1e1f29',
      starColor: '#f1fa8c', success: '#50fa7b', danger: '#ff5555', catAccent: '#8be9fd',
    },
  },
  'solarized-dark': {
    name: 'Solarized Dark',
    terminal: {
      background: '#002b36', foreground: '#839496', cursor: '#268bd2',
      selectionBackground: 'rgba(38, 139, 210, 0.25)',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#859900',
      brightYellow: '#b58900', brightBlue: '#268bd2', brightMagenta: '#6c71c4',
      brightCyan: '#2aa198', brightWhite: '#fdf6e3',
    },
    ui: {
      accent: '#268bd2', accentHover: '#4da3e0',
      tabBarBg: '#001e27', headerBg: '#073642', cardHoverBg: '#0a4050',
      borderColor: '#0d4f5c', mutedText: '#586e75',
      inputBg: '#073642', deepBg: '#001e27',
      starColor: '#b58900', success: '#859900', danger: '#dc322f', catAccent: '#2aa198',
    },
  },
  'one-dark': {
    name: 'One Dark',
    terminal: {
      background: '#282c34', foreground: '#abb2bf', cursor: '#528bff',
      selectionBackground: 'rgba(82, 139, 255, 0.25)',
      black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
      blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379',
      brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd',
      brightCyan: '#56b6c2', brightWhite: '#ffffff',
    },
    ui: {
      accent: '#61afef', accentHover: '#8ac5f4',
      tabBarBg: '#1e2127', headerBg: '#2c313a', cardHoverBg: '#333842',
      borderColor: '#3e4452', mutedText: '#5c6370',
      inputBg: '#2c313a', deepBg: '#1e2127',
      starColor: '#e5c07b', success: '#98c379', danger: '#e06c75', catAccent: '#56b6c2',
    },
  },
  'nord': {
    name: 'Nord',
    terminal: {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#88c0d0',
      selectionBackground: 'rgba(136, 192, 208, 0.25)',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
      blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
    ui: {
      accent: '#88c0d0', accentHover: '#a3d1de',
      tabBarBg: '#242933', headerBg: '#3b4252', cardHoverBg: '#434c5e',
      borderColor: '#4c566a', mutedText: '#616e88',
      inputBg: '#3b4252', deepBg: '#242933',
      starColor: '#ebcb8b', success: '#a3be8c', danger: '#bf616a', catAccent: '#8fbcbb',
    },
  },
  'monokai': {
    name: 'Monokai',
    terminal: {
      background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0',
      selectionBackground: 'rgba(73, 72, 62, 0.5)',
      black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75',
      blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
      brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e',
      brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff',
      brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
    },
    ui: {
      accent: '#a6e22e', accentHover: '#b8ee56',
      tabBarBg: '#1e1f1b', headerBg: '#2d2e28', cardHoverBg: '#3e3d32',
      borderColor: '#49483e', mutedText: '#75715e',
      inputBg: '#2d2e28', deepBg: '#1e1f1b',
      starColor: '#f4bf75', success: '#a6e22e', danger: '#f92672', catAccent: '#66d9ef',
    },
  },
  'tokyo-night': {
    name: 'Tokyo Night',
    terminal: {
      background: '#1a1b26', foreground: '#a9b1d6', cursor: '#c0caf5',
      selectionBackground: 'rgba(40, 52, 94, 0.5)',
      black: '#1a1b26', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
      blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a',
      brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff', brightWhite: '#c0caf5',
    },
    ui: {
      accent: '#7aa2f7', accentHover: '#9bb8f9',
      tabBarBg: '#13141d', headerBg: '#1f2335', cardHoverBg: '#292e42',
      borderColor: '#3b4261', mutedText: '#565f89',
      inputBg: '#1f2335', deepBg: '#13141d',
      starColor: '#e0af68', success: '#9ece6a', danger: '#f7768e', catAccent: '#7dcfff',
    },
  },
  'gruvbox-dark': {
    name: 'Gruvbox Dark',
    terminal: {
      background: '#282828', foreground: '#ebdbb2', cursor: '#fe8019',
      selectionBackground: 'rgba(214, 93, 14, 0.25)',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
      blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26',
      brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b',
      brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
    ui: {
      accent: '#fe8019', accentHover: '#fea04e',
      tabBarBg: '#1d2021', headerBg: '#3c3836', cardHoverBg: '#504945',
      borderColor: '#504945', mutedText: '#928374',
      inputBg: '#3c3836', deepBg: '#1d2021',
      starColor: '#fabd2f', success: '#b8bb26', danger: '#fb4934', catAccent: '#8ec07c',
    },
  },
};

const DEFAULT_SETTINGS = {
  theme: 'default-purple',
  remoteHostname: '',
  // Opt-in: pulling origin/master and running npm install at every launch
  // trusts whoever can push to master.
  autoUpdate: false,
  defaultAgent: 'claude',
  agentPermissions: {
    claude: 'manual',
    codex: 'ask',
    gemini: 'default',
  },
  // Defaults for agent launchOptions (lib/agents.js); projects can override
  // per option in data/projects.json.
  agentLaunchOptions: {
    claude: { nativeScrollback: false },
  },
  font: {
    family: "'CaskaydiaCove Nerd Font', 'Cascadia Code', 'Consolas', monospace",
    size: 14,
    weight: 'normal',
    ligatures: false,
  },
  cursor: {
    style: 'bar',
    blink: true,
  },
  terminal: {
    lineHeight: 1.0,
    padding: 4,
    scrollback: 10000,
  },
  behavior: {
    copyOnSelect: false,
    rightClick: 'smart',
    bell: 'off',
  },
  statusline: {
    enabled: true,
    // Inject Claude Code's statusLine hook (via --settings) on launch so the
    // bar gets session cost, exact context window, and the transcript path.
    autoHook: true,
  },
  notifications: {
    // OS-native toast when a background tab needs attention (lib/desktop-notify.js).
    desktop: true,
  },
};

function deepMerge(defaults, overrides) {
  const result = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (overrides && key in overrides) {
      if (defaults[key] && typeof defaults[key] === 'object' && !Array.isArray(defaults[key])
          && overrides[key] && typeof overrides[key] === 'object' && !Array.isArray(overrides[key])) {
        result[key] = deepMerge(defaults[key], overrides[key]);
      } else {
        result[key] = overrides[key];
      }
    }
  }
  return result;
}

module.exports = { THEME_PRESETS, DEFAULT_SETTINGS, deriveUiColors, darkenHex, lightenHex, deepMerge };
