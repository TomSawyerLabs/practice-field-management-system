import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';

import type { StationName } from '../../../src/types';

/** How often a still is asked for when the live stream isn't offered. */
const STILL_MS = 4_000;
/** How soon a failed live stream on the main display or the feed is tried again. */
const RETRY_MS = 5_000;

/**
 * A robot camera, relayed by pFMS (src/cameraRelay.ts) so it shows on the
 * https site too. Live when the robot's radio has no bandwidth limit;
 * otherwise pFMS offers a still every few seconds, and the reason shows with
 * it. `large` is for the main display: the picture fills its box, and a
 * stream that fails is tried again every few seconds. `quiet` (the livestream
 * feed) shows the picture and nothing else: no reasons, no errors.
 */
export function CameraPicture({
  station,
  ip,
  port,
  large = false,
  quiet = false,
}: {
  station: StationName;
  ip: string;
  port: number;
  large?: boolean;
  quiet?: boolean;
}) {
  /** Bumped to ask for the live stream again after it failed. */
  const [attempt, setAttempt] = useState(0);
  const params = new URLSearchParams({ station, ip, port: String(port) });
  const src = `/api/camera?${params}`;
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

  // On a screen nobody is standing at, a stream that ended (the robot
  // rebooted, a Wi-Fi blip) comes back by itself
  const retries = large || quiet;
  useEffect(() => {
    if (!retries || stillsWhy !== null || problem === null) return;
    const t = setTimeout(() => {
      setProblem(null);
      setAttempt(n => n + 1);
    }, RETRY_MS);
    return () => clearTimeout(t);
  }, [retries, stillsWhy, problem]);

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

  // A new URL per attempt, so the <img> really asks again
  const liveSrc = attempt ? `${src}&attempt=${attempt}` : src;
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

  if (quiet) {
    if (stillsWhy !== null) return still ? picture(still) : null;
    return problem ? null : picture(liveSrc, { onError: () => void onError() });
  }
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
  return picture(liveSrc, { onError: () => void onError() });
}
