import type { Metadata, Viewport } from 'next';
import '../src/styles/globals.css';
import '../src/components/bencho/tokens.css';

export const metadata: Metadata = {
  title: 'Dispatch',
  description: 'Recovery desk for delivery promises at risk'
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
