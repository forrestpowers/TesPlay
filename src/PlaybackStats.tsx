import { useEffect, useRef, useState } from 'react';
import type { PlayerSnapshot } from '@canvas-stream-player/contracts';

export type FrameRates = { source: number | null; shown: number; dropped: number; skipped: number };
type Counters = { at: number; rendered: number; dropped: number; skipped: number };

/** Frame rates per second between two diagnostics readings. */
export function frameRates(previous: Counters, current: Counters): FrameRates | null {
  const seconds = (current.at - previous.at) / 1000;
  if (seconds <= 0) return null;
  const shown = Math.max(0, current.rendered - previous.rendered) / seconds;
  const dropped = Math.max(0, current.dropped - previous.dropped) / seconds;
  const skipped = Math.max(0, current.skipped - previous.skipped) / seconds;
  const total = shown + dropped + skipped;
  return { source: total > 0 ? total : null, shown, dropped, skipped };
}

type HardwareDecode = 'yes' | 'no' | 'unknown';
async function hardwareDecode(codec: string, width: number, height: number): Promise<HardwareDecode> {
  if (typeof VideoDecoder === 'undefined' || !VideoDecoder.isConfigSupported) return 'unknown';
  try {
    const result = await VideoDecoder.isConfigSupported({ codec, codedWidth: width, codedHeight: height, hardwareAcceleration: 'prefer-hardware' });
    return result.supported ? 'yes' : 'no';
  } catch { return 'unknown'; }
}

const fixed = (value: number | null | undefined, digits = 0) => value == null || !Number.isFinite(value) ? '–' : value.toFixed(digits);

/** Live playback numbers for judging smoothness on a specific screen, such as a car browser. */
export default function PlaybackStats({ getSnapshot }: { getSnapshot: () => PlayerSnapshot | null }) {
  const [snapshot, setSnapshot] = useState<PlayerSnapshot | null>(null);
  const [rates, setRates] = useState<FrameRates | null>(null);
  const [hardware, setHardware] = useState<HardwareDecode>('unknown');
  const previous = useRef<Counters | null>(null);
  useEffect(() => {
    const read = () => {
      const current = getSnapshot();
      setSnapshot(current);
      if (!current) { previous.current = null; return; }
      const d = current.diagnostics;
      const counters = { at: performance.now(), rendered: d.renderedFrames, dropped: d.droppedFrames, skipped: d.skippedFrames ?? 0 };
      // A new engine generation restarts its counters.
      if (previous.current && counters.rendered >= previous.current.rendered) setRates(frameRates(previous.current, counters));
      previous.current = counters;
    };
    read();
    const timer = window.setInterval(read, 1000);
    return () => window.clearInterval(timer);
  }, [getSnapshot]);
  const d = snapshot?.diagnostics;
  const codec = d?.videoCodec, width = d?.codedWidth, height = d?.codedHeight;
  useEffect(() => {
    let current = true;
    if (codec && width && height) void hardwareDecode(codec, width, height).then(value => { if (current) setHardware(value); });
    else setHardware('unknown');
    return () => { current = false; };
  }, [codec, width, height]);
  const behindLive = snapshot?.isLive && snapshot.seekableEndSeconds != null ? snapshot.seekableEndSeconds - snapshot.positionSeconds : null;
  const rows: [string, string][] = [
    ['Video', d?.codedWidth ? `${d.codedWidth}×${d.codedHeight} ${d.videoCodec ?? ''}` : '–'],
    ['Source', `${fixed(rates?.source)} fps`],
    ['Shown', `${fixed(rates?.shown)} fps · ${d?.frameRateMode === 'half' ? 'half rate' : 'full rate'}`],
    ['Dropped late', `${fixed(rates?.dropped)}/s · ${d?.droppedFrames ?? 0} total`],
    ['Skipped (30 fps)', `${fixed(rates?.skipped)}/s · ${d?.skippedFrames ?? 0} total`],
    ['Hardware decode', hardware],
    ['Video queue', `${d?.videoQueueDepth ?? 0} frames`],
    ['Audio buffer', `${fixed(d?.audioQueueSeconds, 1)} s · ${d?.audioCodec ?? '–'}`],
    ['A/V drift', `${fixed(d?.measuredAvDriftMs)} ms`],
    ...(behindLive != null ? [['Behind live', `${fixed(behindLive, 1)} s`] as [string, string]] : []),
    ['Stalls · recoveries', `${d?.stallCount ?? 0} · ${d?.hardRecoveryCount ?? 0}`],
    ['Stream', `${d?.streamKind ?? '–'} · ${snapshot?.phase ?? '–'}`],
    ['Screen', `${window.screen.width}×${window.screen.height} · window ${window.innerWidth}×${window.innerHeight} @${fixed(window.devicePixelRatio, 2)}x`],
  ];
  return <div className="playback-stats" aria-label="Playback stats" role="status" aria-live="off">
    {rows.map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}
  </div>;
}
