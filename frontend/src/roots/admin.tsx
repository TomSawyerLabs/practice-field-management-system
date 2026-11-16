import { createRoot } from 'react-dom/client';
import { AdminPage } from '../components/AdminPage';
import { AdminAuthGate } from '../components/AdminAuthGate';
import { WrapAll } from './wrap';

createRoot(document.getElementById('root')!).render(
  <WrapAll>
    <AdminAuthGate>
      <AdminPage />
    </AdminAuthGate>
  </WrapAll>,
);
