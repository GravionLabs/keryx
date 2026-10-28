import { describe, expect, it } from 'vitest';
import { KeryxPlugin } from './index.js';

describe('KeryxPlugin', () => {
  it('resolves to a hooks object', async () => {
    expect(await KeryxPlugin()).toEqual({});
  });
});
