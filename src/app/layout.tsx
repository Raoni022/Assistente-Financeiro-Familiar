import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'Assistente Financeiro',
  description: 'Assistência financeira da família.',
};

export const viewport: Viewport = {
  themeColor: '#0E0F13',
  // Mobile é a plataforma principal: a viewport precisa considerar a safe area
  // do iPhone, senão o FAB do chat fica embaixo do indicador de home.
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={GeistSans.variable}>
      <body>{children}</body>
    </html>
  );
}
