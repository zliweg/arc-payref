import { useEffect, useRef, useState } from 'react';
import type { SignedRequest } from './protocol';
import { requestLink } from './protocol';

export function PaymentQr({ request }: { request: SignedRequest }) {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const link = requestLink(request, location.origin);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setReady(false); setError('');
    void import('qrcode').then(async ({ default: QRCode }) => {
      if (!active || !canvas.current) return;
      await QRCode.toCanvas(canvas.current, link, { errorCorrectionLevel: 'M', margin: 4, scale: 5, color: { dark: '#163c30', light: '#ffffff' } });
      // Keep the export bitmap intact while letting responsive CSS preserve its square ratio.
      if (canvas.current) { canvas.current.style.width = ''; canvas.current.style.height = ''; }
      if (active) setReady(true);
    }).catch(() => { if (active) setError('A QR code could not be generated. Long signed requests can exceed QR capacity; use Copy link to share the complete request.'); });
    return () => { active = false; };
  }, [open, link]);
  function downloadQr() {
    if (!ready || !canvas.current) return;
    canvas.current.toBlob(blob => {
      if (!blob) { setError('The QR image could not be exported. The payment link remains available.'); return; }
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'payref-payment-link.png'; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  return <details className="payment-qr" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Payment link QR code</summary>
    <p>Opens this exact signed request in a browser. Anyone with the link or QR can read the request.</p>
    {local && <p className="inline-warning">This is a local address. A different device cannot reach this website using this QR code.</p>}
    {open && <><canvas ref={canvas} role="img" aria-label="QR code for the signed payment request" hidden={!ready}/>{!ready && !error && <p role="status">Generating QR locally…</p>}{error && <p role="alert" className="field-error">{error}</p>}{ready && <button className="secondary" onClick={downloadQr}>Download QR image</button>}</>}
  </details>;
}
