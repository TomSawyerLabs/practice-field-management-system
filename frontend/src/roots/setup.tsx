import { createRoot } from 'react-dom/client';
import { SetupPage } from '../components/SetupPage';
import { WrapAll } from './wrap';

// Deliberately not behind AdminAuthGate: on a fresh install nobody has set a
// passphrase yet, and setup is how you get there. Same trust-on-first-use as
// the admin passphrase itself.
createRoot(document.getElementById('root')!).render(
  <WrapAll>
    <SetupPage />
  </WrapAll>,
);
