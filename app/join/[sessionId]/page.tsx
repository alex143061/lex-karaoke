import KaraokeApp from '../../components/karaoke-app';

export default async function JoinPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return <KaraokeApp mode="guest" sessionId={sessionId} />;
}