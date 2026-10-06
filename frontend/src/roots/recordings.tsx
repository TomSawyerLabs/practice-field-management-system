import { createRoot } from 'react-dom/client';
import { AdminAuthGate } from '../components/AdminAuthGate';
import { RecordingsPage } from '../components/RecordingsPage';
import { WrapAll } from './wrap';

createRoot(document.getElementById('root')!).render(
  <WrapAll showReconfigOverlay={false}>
    <AdminAuthGate>
      <RecordingsPage />
    </AdminAuthGate>
  </WrapAll>,
);
