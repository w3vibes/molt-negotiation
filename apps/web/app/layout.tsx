import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MoltNegotiation · Strict Private Agent Negotiation',
  description:
    'Production-first private agent-to-agent negotiation with endpoint proofs, runtime attestation checks, privacy-bounded transcripts, and trusted settlement.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
