import { createRoot } from 'react-dom/client';
import { RecordingsPage } from '../components/RecordingsPage';
import { WrapAll } from './wrap';

// Open to anyone: no AdminAuthGate. Admin-only controls on the page show
// when the browser's stored admin token checks out (useIsAdmin).
createRoot(document.getElementById('root')!).render(
  <WrapAll showReconfigOverlay={false}>
    <RecordingsPage />
  </WrapAll>,
);
