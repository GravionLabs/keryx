import { describe, expect, it } from 'vitest';
import { configPath, dbPath, stateDir } from './paths.js';

describe('paths', () => {
  it('falls back to ~/.config and ~/.local/state', () => {
    const env = { HOME: '/home/u' };
    expect(configPath(env)).toBe('/home/u/.config/keryx/config.json');
    expect(stateDir(env)).toBe('/home/u/.local/state/keryx');
    expect(dbPath(env)).toBe('/home/u/.local/state/keryx/keryx.db');
  });

  it('uses XDG_CONFIG_HOME and XDG_STATE_HOME when absolute', () => {
    const env = { HOME: '/home/u', XDG_CONFIG_HOME: '/cfg', XDG_STATE_HOME: '/state' };
    expect(configPath(env)).toBe('/cfg/keryx/config.json');
    expect(dbPath(env)).toBe('/state/keryx/keryx.db');
  });

  it('ignores a relative XDG value, as the specification requires', () => {
    const env = { HOME: '/home/u', XDG_STATE_HOME: 'relative' };
    expect(stateDir(env)).toBe('/home/u/.local/state/keryx');
  });
});
