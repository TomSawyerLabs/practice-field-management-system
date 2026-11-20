import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';

import type { StationName } from '../../../src/types';

/** How often a still is asked for when the live stream isn't offered. */
const STILL_MS = 4_000;

/**
 * A robot camera, relayed by pFMS (src/cameraRelay.ts) so it shows on the
 * https site too. Live when the robot's radio has no bandwidth limit;
 * otherwise pFMS offers a still every few seconds, and the reason shows with
 * it. `large` is for the main display: the picture fills its box.
 */
export function CameraPicture({
  station,
  ip,
  port,
  large = false,
}: {
  station: StationName;
  ip: string;
  port: number;
  large?: boolean;
}) {
  const src = `/api/camera?${new URLSearchParams({ station, ip, port: String(port) })}`;
  const [problem, setProblem] = useState<string | null>(null);
  /** Set once pFMS says only stills are offered: why. */
  const [stillsWhy, setStillsWhy] = useState<string | null>(null);
  const [still, setStill] = useState<string | null>(null);

  const onError = async () => {
    // An <img> can't say why; a refusal is a short JSON reply, so ask again for the reason
    const controller = new AbortController();
    try {
      const res = await fetch(src, { signal: controller.signal, cache: 'no-store' });
      if (res.ok) return setProblem('The stream ended.');
      const body = (await res.json()) as { error?: string; still?: boolean };
      if (body.still) setStillsWhy(body.error ?? 'Live video is off for this robot.');
      else setProblem(body.error ?? `HTTP ${res.status}`);
    } catch {
      setProblem("Couldn't reach pFMS for the stream.");
    } finally {
      controller.abort();
    }
  };

  useEffect(() => {
    if (stillsWhy === null) return;
    let url: string | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const next = async () => {
      if (!document.hidden) {
        try {
          const res = await fetch(`${src}&still=1`, { cache: 'no-store' });
          if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`);
          const fresh = URL.createObjectURL(await res.blob());
          if (stopped) URL.revokeObjectURL(fresh);
          else {
            if (url) URL.revokeObjectURL(url);
            url = fresh;
            setStill(fresh);
            setProblem(null);
          }
        } catch (err) {
          if (!stopped) setProblem(err instanceof Error ? err.message : String(err));
        }
      }
      if (!stopped) timer = setTimeout(() => void next(), STILL_MS);
    };
    void next();
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
  }, [src, stillsWhy]);

  const picture = (imgSrc: string, extra: object = {}) => (
    <Box
      component="img"
      src={imgSrc}
      alt={`Camera ${port} on ${ip}`}
      {...extra}
      sx={
        large
          ? { display: 'block', width: '100%', height: '100%', objectFit: 'contain', bgcolor: 'black' }
          : { display: 'block', width: '100%', borderRadius: 1, bgcolor: 'black' }
      }
    />
  );

  const note = large ? { variant: 'h6' as const, sx: { p: 2 } } : { variant: 'body2' as const, sx: { pr: 4, mt: 0.5 } };
  if (stillsWhy !== null) {
    return (
      <>
        {still && picture(still)}
        <Typography variant={note.variant} color="text.secondary" sx={note.sx}>
          Camera {port}: a still every {STILL_MS / 1000} s. {stillsWhy}
          {problem && ` Last try: ${problem}`}
        </Typography>
      </>
    );
  }
  if (problem) {
    return (
      <Typography variant={note.variant} color="text.secondary" sx={note.sx}>
        Camera {port}: {problem}
      </Typography>
    );
  }
  return picture(src, { onError: () => void onError() });
}
