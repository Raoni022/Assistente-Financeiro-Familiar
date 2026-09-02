import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  // Chaves e cliente service role vivem apenas em src/server/**. Nada aqui deve
  // expor variável de ambiente para o bundle do cliente: só NEXT_PUBLIC_* vaza,
  // e as únicas permitidas estão documentadas em .env.example.
  experimental: {
    serverActions: { bodySizeLimit: '1mb' },
  },
};

export default nextConfig;
