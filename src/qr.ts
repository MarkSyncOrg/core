import QRCode from 'qrcode';

// Renders a sync ID as a QR code so it can be transferred to another device by scanning
// (the device still needs the service URL and password, exactly as when typing the ID).
// The payload is the bare sync ID, matching what other xBrowserSync clients encode/scan.

/**
 * Returns an SVG string for the given sync ID's QR code. Always black-on-white for
 * reliable scanning regardless of the popup theme; error-correction level M balances
 * density and resilience. Throws if `syncId` is empty.
 */
export async function renderSyncIdQrSvg(syncId: string): Promise<string> {
  const id = syncId.trim();
  if (!id) {
    throw new Error('Cannot render a QR code for an empty sync ID');
  }
  return QRCode.toString(id, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
}
