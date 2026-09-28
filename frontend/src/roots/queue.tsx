import { createRoot } from 'react-dom/client';
import { QueuePage } from '../components/QueuePage';
import { AdminAuthGate } from '../components/AdminAuthGate';
import { WrapAll } from './wrap';

// The queue manager keeps working through a radio reconfigure (that is what
// "Set up next match" causes), so no backdrop.
createRoot(document.getElementById('root')!).render(
  <WrapAll showReconfigOverlay={false}>
    <AdminAuthGate>
      <QueuePage />
    </AdminAuthGate>
  </WrapAll>,
);
