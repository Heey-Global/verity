import QRCode from 'qrcode';
import { stdin } from 'node:process';

let uri = process.argv[2]?.trim();
if (uri === undefined && !stdin.isTTY) {
  stdin.setEncoding('utf8');
  const chunks: string[] = [];
  for await (const chunk of stdin as AsyncIterable<string>) chunks.push(chunk);
  uri = chunks.join('').trim();
}
if (!uri?.startsWith('verity://pair?payload=')) {
  console.error('usage: pairing-qr <verity pairing URI>');
  process.exitCode = 64;
} else {
  // A terminal cannot draw fractional QR cells. Low error correction reduces
  // the matrix while the standard four-cell quiet zone preserves scanability.
  process.stdout.write(
    await QRCode.toString(uri, {
      type: 'terminal',
      small: true,
      margin: 4,
      errorCorrectionLevel: 'L',
    }),
  );
}
