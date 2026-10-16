import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'lex-karaoke | Local Karaoke',
  description: 'A shared karaoke queue for your room, powered by your local network.',
  icons: [
    { rel: 'icon', type: 'image/svg+xml', url: '/favicon.svg' },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}