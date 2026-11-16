import { createRoot } from 'react-dom/client';
import { StaffPage } from '../components/StaffPage';
import { WrapAll } from './wrap';

createRoot(document.getElementById('root')!).render(
  <WrapAll>
    <StaffPage />
  </WrapAll>,
);
