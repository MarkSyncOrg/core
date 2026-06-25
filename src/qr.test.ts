import { describe, expect, it } from 'vitest';
import { renderSyncIdQrSvg } from './qr';

const SYNC_ID = '52758cb942814faa9ab255208025ae65';

describe('renderSyncIdQrSvg', () => {
  it('renders an SVG for a sync ID', async () => {
    const svg = await renderSyncIdQrSvg(SYNC_ID);
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox');
    // A QR matrix renders as a filled path.
    expect(svg).toContain('<path');
  });

  it('produces different output for different sync IDs', async () => {
    const a = await renderSyncIdQrSvg(SYNC_ID);
    const b = await renderSyncIdQrSvg('00000000000000000000000000000000');
    expect(a).not.toEqual(b);
  });

  it('rejects an empty sync ID', async () => {
    await expect(renderSyncIdQrSvg('  ')).rejects.toThrow();
  });
});
