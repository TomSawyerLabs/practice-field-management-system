import { createRoot } from 'react-dom/client';
import { ControlPage } from '../components/ControlPage';
import { WrapAll } from './wrap';
import { clearTeamNumberCookie } from '../utils/cookies';

// Extract the SSID from the URL path: /<ssid>
// The SSID is either a bare team number (e.g. "1234") or team-suffix (e.g. "1234-beta").
const raw = decodeURIComponent(window.location.pathname.slice(1));

// Parse team number from the SSID prefix (digits before the first hyphen)
const teamNumber = parseInt(raw.split('-', 2)[0], 10);

if (!raw) {
  // Nothing in URL — redirect to home
  window.location.href = '/';
} else if (isNaN(teamNumber) || teamNumber <= 0) {
  // Can't parse a team number — clear the cookie to prevent redirect loops and go home
  clearTeamNumberCookie();
  window.location.href = '/';
} else {
  // Installable as an app named for the team, and a service worker so the
  // queue's "you're next up" pushes reach the device with the tab closed.
  const manifest = document.createElement('link');
  manifest.rel = 'manifest';
  manifest.href = `/api/manifest?team=${teamNumber}`;
  document.head.appendChild(manifest);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('Service worker registration failed:', err));
  }

  createRoot(document.getElementById('root')!).render(
    <WrapAll>
      <ControlPage teamNumber={teamNumber} selectedSsid={raw} />
    </WrapAll>,
  );
}
