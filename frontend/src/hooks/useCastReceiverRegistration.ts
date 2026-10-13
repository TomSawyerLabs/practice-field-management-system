import { useEffect, useRef } from 'react';
import type { CastReceiverRegister } from '../../../src/types';
import { sendCastReceiverRegister, useWsConnected } from './useBackend';

/** On a Cast TV, register with the server whenever the socket (re)connects —
 *  the server tracks receivers per connection, so a reconnected socket must
 *  re-register. The settings are what the admin page's display list shows. */
export function useCastReceiverRegistration(display: Omit<CastReceiverRegister, 'type' | 'name'>) {
  const wsUp = useWsConnected();
  const displayRef = useRef(display);
  displayRef.current = display;
  useEffect(() => {
    if (!window.__isCastReceiver || !wsUp) return;
    // Small delay so the register lands after the state replay settles
    const timer = setTimeout(() => {
      const name = localStorage.getItem('scoreboard-device-name') || document.title || 'Cast Display';
      sendCastReceiverRegister({ name, ...displayRef.current });
    }, 1000);
    return () => clearTimeout(timer);
  }, [wsUp]);
}
