import { createRoot } from 'react-dom/client';
import { AdminAuthGate } from '../components/AdminAuthGate';
import { TimelapsePage } from '../components/timelapse/TimelapsePage';
import { WrapAll } from './wrap';

createRoot(document.getElementById('root')!).render(
  <WrapAll showReconfigOverlay={false}>
    <AdminAuthGate>
      <TimelapsePage />
    </AdminAuthGate>
  </WrapAll>,
);
