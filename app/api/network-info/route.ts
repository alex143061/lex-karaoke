import { NextResponse } from 'next/server';
import { networkInterfaces } from 'node:os';
import { privateAddress } from '../../../lib/security';

export async function GET() {
  const interfaces = networkInterfaces();
  const addresses: string[] = [];
  const privateIps: string[] = [];

  for (const ifaces of Object.values(interfaces)) {
    if (!ifaces) continue;
    for (const addr of ifaces) {
      if (addr.family === 'IPv4' && !addr.internal) {
        addresses.push(addr.address);
        if (privateAddress(addr.address)) privateIps.push(addr.address);
      }
    }
  }

  return NextResponse.json({
    port: process.env.PORT || 3000,
    lanHost: process.env.LAN_HOST || '(auto-detected)',
    privateIps,
    allAddresses: addresses,
    primaryUrl: privateIps[0]
      ? `http://${privateIps[0]}:${process.env.PORT || 3000}`
      : `http://127.0.0.1:${process.env.PORT || 3000}`,
  });
}
