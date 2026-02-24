import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      colors: {
        canvas: '#060608',
        panel: '#0e0f12',
        'panel-2': '#141519',
        edge: '#1c1e24',
        'edge-2': '#262830',
      },
    },
  },
  plugins: [],
};

export default config;
