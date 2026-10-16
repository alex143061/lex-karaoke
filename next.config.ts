import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Only matters for `npm run dev`: lets phones on the LAN load dev assets/HMR.
  // (`npm start` uses a production build and does not need this.)
  allowedDevOrigins: ['192.168.*.*', '10.*.*.*', '172.16.*.*', '172.17.*.*', '172.18.*.*', '172.19.*.*', '172.2*.*.*', '172.30.*.*', '172.31.*.*', '*.local'],
};

export default nextConfig;
